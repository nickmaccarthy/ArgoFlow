import {execFile} from 'node:child_process';
import {performance} from 'node:perf_hooks';

const emit = (write, phase, event, fields = {}) => write(`[smoke-diag] ${JSON.stringify({timestamp: new Date().toISOString(), phase, event, ...fields})}`);
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const failures = new Map([
  ['net::ERR_CONNECTION_RESET', 'connection_reset'],
  ['net::ERR_CONNECTION_REFUSED', 'connection_refused'],
  ['net::ERR_CONNECTION_CLOSED', 'connection_closed'],
  ['net::ERR_TIMED_OUT', 'timeout'],
  ['net::ERR_ABORTED', 'aborted'],
  ['net::ERR_EMPTY_RESPONSE', 'empty_response'],
  ['net::ERR_FAILED', 'failed']
]);

export async function viewSwitchCheck(run, {strict, warn, screenshot}) {
  try {
    await run();
  } catch (error) {
    if (strict) throw error;
    warn();
    try { await screenshot(); } catch { /* Best-effort evidence. */ }
  }
}

export async function fixtureRowCheck(wait, timeoutMs) {
  await wait(timeoutMs);
}

export function route(url) {
  try {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !['http:', 'https:'].includes(parsed.protocol) || parsed.port !== '8090') return 'other';
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'applications') {
      if (segments.length === 3) return '/api/v1/applications';
      if (segments.length >= 4 && segments.length <= 6 && /^[a-zA-Z0-9._~-]+$/.test(segments[3])) {
        const suffix = segments.slice(4);
        if (!suffix.length) return '/api/v1/applications/:application';
        if (suffix.length === 1 && ['resource', 'tree', 'managed-resources', 'events', 'sync', 'refresh'].includes(suffix[0])) return `/api/v1/applications/:application/${suffix[0]}`;
      }
      return 'other';
    }
    if (segments.length === 0) return '/';
    if (segments.length === 1 && segments[0] === 'login') return '/login';
    if (segments.length === 2 && segments[0] === 'applications') return '/applications/:application';
  } catch { /* Unknown URLs have no emitted path. */ }
  return 'other';
}

export function startNetworkDiagnostics(page, getPhase, write = console.log) {
  const started = new WeakMap();
  let count = 0;
  const report = (event, fields) => {
    if (count++ < 100) emit(write, getPhase(), event, fields);
  };
  const request = req => started.set(req, performance.now());
  const detail = req => {
    const template = route(req.url());
    const method = req.method();
    const fields = {method: methods.has(method) ? method : 'other', route: template};
    if (started.has(req)) fields.durationMs = Math.min(600000, Math.round(performance.now() - started.get(req)));
    return fields;
  };
  const response = res => {
    if (res.status() >= 500 && res.status() <= 599) report('http_5xx', {...detail(res.request()), status: res.status()});
  };
  const failed = req => report('request_failed', {...detail(req), failure: failures.get(req.failure()?.errorText) || 'other'});
  page.on('request', request);
  page.on('response', response);
  page.on('requestfailed', failed);
  return () => {
    page.off('request', request);
    page.off('response', response);
    page.off('requestfailed', failed);
  };
}

export function startHeartbeat(session, getPhase, write = console.log, {intervalMs = 5000, timeoutMs = 2000, schedule = setInterval, cancel = clearInterval} = {}) {
  let active = true;
  let pending = false;
  const deadline = promise => new Promise(resolve => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    Promise.resolve().then(promise).then(() => { clearTimeout(timer); resolve('ok'); }, () => { clearTimeout(timer); resolve('error'); });
  });
  const tick = async () => {
    if (!active || pending) return;
    pending = true;
    try {
      const protocol = await deadline(() => session.send('Browser.getVersion'));
      if (!active) return;
      const renderer = protocol === 'ok' ? await deadline(() => session.send('Runtime.evaluate', {expression: '1', returnByValue: true})) : 'not_probed';
      if (active) emit(write, getPhase(), 'heartbeat', {protocol, renderer});
    } finally {
      pending = false;
    }
  };
  const timer = schedule(tick, intervalMs);
  return () => { active = false; cancel(timer); };
}

const components = [
  ['argocd', 'argocd-server'],
  ['argocd', 'argocd-application-controller'],
  ['argocd', 'argocd-redis'],
  ['argocd', 'argocd-repo-server'],
  ['argo', 'workflow-controller']
];
const safeState = value => ['Running', 'Pending', 'Failed', 'Succeeded', 'Unknown'].includes(value) ? value : 'other';
const safeReason = value => ['BackOff', 'CrashLoopBackOff', 'OOMKilled', 'Error', 'Evicted', 'FailedScheduling', 'Unhealthy', 'Killing', 'FailedMount', 'FailedCreatePodSandBox', 'Pulled', 'Created', 'Started'].includes(value) ? value : 'other';
const runKubectl = (namespace, kind, signal) => new Promise(resolve => {
  execFile('kubectl', ['-n', namespace, 'get', kind, '-o', 'json'], {timeout: 4000, maxBuffer: 512 * 1024, signal}, (error, stdout) => {
    if (error) return resolve(null);
    try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
  });
});

export async function collectKubernetes(write = console.log, run = runKubectl, signal) {
  for (const [namespace, component] of components) {
    if (signal?.aborted) return;
    const pods = await run(namespace, 'pods', signal);
    if (signal?.aborted) return;
    if (!Array.isArray(pods?.items)) {
      emit(write, 'failure', 'kubernetes_unavailable', {component});
      continue;
    }
    const matches = pods.items.filter(pod => pod.metadata?.name === component || pod.metadata?.name?.startsWith(`${component}-`)).slice(0, 3);
    for (const pod of matches) {
      emit(write, 'failure', 'pod', {
        component, podPhase: safeState(pod.status?.phase),
        containers: (pod.status?.containerStatuses || []).slice(0, 3).map(container => ({
          restarts: Math.min(999, Math.max(0, Number.isInteger(container.restartCount) ? container.restartCount : 0)),
          ready: container.ready === true,
          reason: safeReason(container.state?.waiting?.reason || container.state?.terminated?.reason)
        }))
      });
    }
    const events = await run(namespace, 'events', signal);
    if (signal?.aborted) return;
    if (!Array.isArray(events?.items)) continue;
    for (const event of events.items.filter(item => matches.some(pod => item.involvedObject?.name === pod.metadata?.name)).slice(-5)) {
      emit(write, 'failure', 'pod_event', {component, reason: safeReason(event.reason), type: event.type === 'Warning' ? 'Warning' : 'other'});
    }
  }
}

if (process.argv[1]?.endsWith('/smoke-diagnostics.mjs')) {
  await collectKubernetes();
}
