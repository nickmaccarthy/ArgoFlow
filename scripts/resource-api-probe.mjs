// Failure-only, fixture-scoped comparison. No URLs, credentials, bodies or kubectl output are logged.
import {spawn, execFile} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import https from 'node:https';
import {collectKubernetes} from './smoke-diagnostics.mjs';

const ROUTE = '/api/v1/applications/:application/resource';
const TREE = '/api/v1/applications/:application/resource-tree';
const HEALTH = '/healthz';
const QUERY = 'appNamespace=argocd&project=default&namespace=argoflow-e2e&resourceName=argoflow-hello-e2e&version=v1alpha1&group=argoproj.io&kind=Workflow';
const identity = new URLSearchParams(QUERY);
const RESOURCE_PATH = `/api/v1/applications/argoflow-e2e/resource?${QUERY}`;
const CONTROLS = [[HEALTH, '/healthz?full=true'], [TREE, '/api/v1/applications/argoflow-e2e/resource-tree']];
const categories = status => status === 504 ? 'deadline_exceeded_candidate' : status === 500 ? 'unknown_candidate' : status === 401 || status === 403 ? 'auth' : status === 'timeout' ? 'transport_timeout' : status === 'unavailable' ? 'unavailable' : 'unknown';
const diagnostic = (write, phase, event, route, source, status, durationMs, category) => write(`[smoke-diag] ${JSON.stringify({timestamp: new Date().toISOString(), phase, event, route, method: 'GET', status, durationMs: Math.min(8000, Math.max(0, Math.round(durationMs))), source, category: category || categories(status)})}`);
const fixtureRequest = raw => {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '8090' ||
        url.pathname !== '/api/v1/applications/argoflow-e2e/resource' || url.hash) return false;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== new Set(keys).size) return false;
    // The client omits empty optional Application context fields; all resource selectors are mandatory.
    return keys.every(key => identity.has(key) && url.searchParams.get(key) === identity.get(key)) &&
      [...identity.keys()].every(key => ['appNamespace', 'project'].includes(key) || url.searchParams.has(key));
  } catch { return false; }
};

function localRequest(url, {headers, signal}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {headers, rejectUnauthorized: false, signal}, res => {
      res.resume();
      resolve({status: res.statusCode});
    });
    req.on('error', reject);
  });
}

const podName = () => new Promise(resolve => execFile('kubectl', ['-n', 'argocd', 'get', 'pods', '-o', 'json'], {timeout: 3000, maxBuffer: 512 * 1024}, (error, stdout) => {
  if (error) return resolve(null);
  try {
    const pods = JSON.parse(stdout).items;
    resolve(pods.find(p => /^argocd-server-[a-z0-9-]+$/.test(p.metadata?.name) && p.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True'))?.metadata.name || null);
  } catch { resolve(null); }
}));

// Adapt the historical post-smoke collector into fixed-schema failure-time events.
// Its sanitized records stay in memory and are never passed to the probe writer.
async function podSnapshot(collect, emit, signal) {
  const names = new Map([
    ['argocd-server', 'pod_server'],
    ['argocd-redis', 'pod_redis'],
    ['argocd-application-controller', 'pod_controller']
  ]);
  const states = new Map([...names].map(([component]) => [component, {seen: false, unavailable: false, ready: true, restarts: 0}]));
  try {
    await collect(line => {
      try {
        const record = JSON.parse(line.slice('[smoke-diag] '.length));
        const state = states.get(record.component);
        if (!state) return;
        if (record.event === 'kubernetes_unavailable') state.unavailable = true;
        if (record.event !== 'pod') return;
        state.seen = true;
        state.ready &&= record.podPhase === 'Running' && Array.isArray(record.containers) && record.containers.length > 0 && record.containers.every(container => container.ready === true);
        state.restarts = Math.min(999, state.restarts + (record.containers || []).reduce((sum, container) => sum + (Number.isInteger(container.restarts) ? container.restarts : 0), 0));
      } catch { /* No raw collector output or parsing errors leave this function. */ }
    }, undefined, signal);
  } catch { /* Snapshot is diagnostic-only. */ }
  if (signal?.aborted) return;
  for (const [component, event] of names) {
    const state = states.get(component);
    emit(event, HEALTH, 'pod_direct', state.seen ? state.restarts : 'unavailable', 0,
      state.unavailable ? 'unavailable' : !state.seen ? 'unknown' : state.ready ? 'ready' : 'not_ready');
  }
}

// Injected in unit tests; production uses an ephemeral local port-forward only.
export async function runResourceProbe({page, phase, write = console.log, request = localRequest, selectPod = podName, forward = startPodForward, collect = collectKubernetes, signal, endpointMs = 4000}) {
  const base = 'https://127.0.0.1:8090';
  let cookies;
  try { cookies = (await page.cookies(base)).filter(c => c.name === 'argocd.token' && typeof c.value === 'string'); } catch { cookies = []; }
  // An unauthenticated request cannot distinguish API failure from auth rejection.
  const cookie = cookies.length === 1 ? `${cookies[0].name}=${cookies[0].value}` : null;
  const emit = (event, route, source, status, duration, category) => diagnostic(write, phase(), event, route, source, status, duration, category);
  const probe = async (origin, source, route, path) => {
    const start = performance.now();
    if (!cookie || signal?.aborted) { emit('resource_probe', route, source, 'unavailable', 0); return; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(abort, Math.min(8000, endpointMs));
    try {
      const response = await request(`${origin}${path}`, {headers: {Cookie: cookie}, signal: controller.signal});

      emit('resource_probe', route, source, Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 'unavailable', performance.now() - start);
    } catch {
      emit('resource_probe', route, source, controller.signal.aborted && !signal?.aborted ? 'timeout' : 'unavailable', performance.now() - start);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
  if (!cookie || signal?.aborted) { emit('resource_probe', ROUTE, 'service_forward', 'unavailable', 0); emit('resource_probe', ROUTE, 'pod_direct', 'unavailable', 0); return; }
  const snapshot = podSnapshot(collect, emit, signal);
  await probe(base, 'service_forward', ROUTE, RESOURCE_PATH);
  for (const [route, path] of CONTROLS) await probe(base, 'service_forward', route, path);
  let stop;
  try {
    const pod = await selectPod();
    if (!pod || signal?.aborted) { emit('resource_probe', ROUTE, 'pod_direct', 'unavailable', 0); return; }
    stop = await forward(pod, signal);
    if (!stop || signal?.aborted) { emit('resource_probe', ROUTE, 'pod_direct', 'unavailable', 0); return; }
    const direct = 'https://127.0.0.1:8091';
    await probe(direct, 'pod_direct', ROUTE, RESOURCE_PATH);
    for (const [route, path] of CONTROLS) await probe(direct, 'pod_direct', route, path);
  } catch { emit('resource_probe', ROUTE, 'pod_direct', 'unavailable', 0); }
  finally { stop?.(); await snapshot; }
}

function startPodForward(pod, signal) {
  return new Promise(resolve => {
    const child = spawn('kubectl', ['-n', 'argocd', 'port-forward', `pod/${pod}`, '8091:8080'], {stdio: ['ignore', 'pipe', 'ignore']});
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const stop = () => child.kill('SIGTERM');
    const timer = setTimeout(() => { stop(); finish(null); }, 3000);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdout.on('data', data => { if (data.toString().includes('Forwarding from')) finish(stop); });
    signal?.addEventListener('abort', stop, {once: true});
  });
}

export function startResourceFailureProbe(page, getPhase, options = {}) {
  let failures = 0;
  let started = false;
  const startedAt = new WeakMap();
  const controller = new AbortController();
  const request = req => { if (req.method() === 'GET' && fixtureRequest(req.url())) startedAt.set(req, performance.now()); };
  const response = res => {
    try {
      if (started || !['fixture_row_wait', 'workflows_mount'].includes(getPhase()) || res.status() < 500 || res.status() > 599 || res.request().method() !== 'GET' || !fixtureRequest(res.url())) return;
      const req = res.request();
      diagnostic(options.write || console.log, getPhase(), 'resource_5xx', ROUTE, 'browser', res.status(), startedAt.has(req) ? performance.now() - startedAt.get(req) : 0);
      if (++failures < 2) return;
      started = true;
      void runResourceProbe({page, phase: getPhase, signal: controller.signal, ...options}).catch(() => {});
    } catch { /* Diagnostics must never break smoke. */ }
  };
  page.on('request', request);
  page.on('response', response);
  return () => { page.off('request', request); page.off('response', response); controller.abort(); };
}
