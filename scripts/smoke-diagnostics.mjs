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

// Identity keys stay in memory for this sampler run; only ordinals leave it.
const identities = new Map();
const count = value => Number.isInteger(value) ? Math.min(999, Math.max(0, value)) : 0;
const redisReason = value => ['ContainerCreating', 'PodInitializing', 'CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'CreateContainerError', 'RunContainerError', 'OOMKilled', 'Error', 'Completed', 'Evicted'].includes(value) ? value : 'other';
const eventReason = value => ['FailedScheduling', 'Scheduled', 'Pulling', 'Pulled', 'Failed', 'BackOff', 'Created', 'Started', 'Killing', 'Unhealthy', 'FailedMount', 'FailedCreatePodSandBox', 'Evicted', 'Preempted', 'NodeNotReady'].includes(value) ? value : 'other';
const age = (value, now) => {
  const elapsed = now - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'unknown';
  if (elapsed < 60000) return 'under_1m';
  if (elapsed < 300000) return '1_to_5m';
  if (elapsed < 900000) return '5_to_15m';
  return 'over_15m';
};
const container = status => ({
  ready: status?.ready === true, restarts: count(status?.restartCount),
  waiting: redisReason(status?.state?.waiting?.reason),
  lastTermination: redisReason(status?.lastState?.terminated?.reason)
});

export function sanitizeRedisSnapshot({pods, deployments, endpoints, events}, now = Date.now(), keys = identities) {
  const selected = (Array.isArray(pods?.items) ? pods.items : [])
    .filter(pod => pod?.metadata?.namespace === 'argocd' && /^argocd-redis-[a-zA-Z0-9-]+$/.test(pod.metadata.name || ''))
    .sort((a, b) => String(a.metadata.name).localeCompare(String(b.metadata.name))).slice(0, 4)
    .map(pod => {
      const key = pod.metadata.uid || pod.metadata.name;
      if (!keys.has(key) && keys.size < 12) keys.set(key, keys.size + 1);
      return {pod, ordinal: keys.get(key) || 0};
    });
  const deployment = (Array.isArray(deployments?.items) ? deployments.items : []).find(item => item?.metadata?.name === 'argocd-redis');
  const endpoint = (Array.isArray(endpoints?.items) ? endpoints.items : []).find(item => item?.metadata?.name === 'argocd-redis');
  const relevant = (Array.isArray(events?.items) ? events.items : [])
    .filter(item => selected.some(({pod}) => item?.involvedObject?.uid
      ? item.involvedObject.uid === pod.metadata.uid : item?.involvedObject?.name === pod.metadata.name))
    .map(item => ({item, time: Date.parse(item.eventTime || item.lastTimestamp || item.metadata?.creationTimestamp)}))
    .filter(({time}) => Number.isFinite(time) && time <= now)
    .sort((a, b) => a.time - b.time).slice(-8);
  const endpointReady = (Array.isArray(endpoint?.subsets) ? endpoint.subsets : [])
    .reduce((total, subset) => total + (Array.isArray(subset.addresses) ? subset.addresses.length : 0), 0);
  return {
    deployment: {desired: count(deployment?.spec?.replicas), ready: count(deployment?.status?.readyReplicas), available: count(deployment?.status?.availableReplicas)},
    endpointReady: Math.min(999, endpointReady),
    pods: selected.map(({pod, ordinal}) => ({
      ordinal, age: age(pod.metadata.creationTimestamp, now), assigned: Boolean(pod.spec?.nodeName),
      phase: safeState(pod.status?.phase),
      init: (Array.isArray(pod.status?.initContainerStatuses) ? pod.status.initContainerStatuses : []).slice(0, 2).map(container),
      main: (Array.isArray(pod.status?.containerStatuses) ? pod.status.containerStatuses : []).slice(0, 2).map(container)
    })),
    events: relevant.map(({item, time}) => ({
      ordinal: selected.find(({pod}) => item.involvedObject?.uid
        ? item.involvedObject.uid === pod.metadata.uid : item.involvedObject?.name === pod.metadata.name)?.ordinal || 0,
      reason: eventReason(item.reason), type: ['Normal', 'Warning'].includes(item.type) ? item.type : 'other',
      count: count(item.count), age: age(new Date(time).toISOString(), now)
    }))
  };
}

export async function collectRedis(write = console.log, run = runKubectl, {phase = 'periodic', timeoutMs = 4500, keys = identities} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const results = await Promise.race([
      Promise.all(['pods', 'deployments', 'endpoints', 'events'].map(kind =>
        Promise.resolve().then(() => run('argocd', kind, controller.signal)).catch(() => null))),
      new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(null), {once: true}))
    ]);
    if (results === null || results.some(result => !Array.isArray(result?.items))) emit(write, phase, 'redis_unavailable');
    else {
      const [pods, deployments, endpoints, events] = results;
      emit(write, phase, 'redis_snapshot', sanitizeRedisSnapshot({pods, deployments, endpoints, events}, Date.now(), keys));
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function sampleRedis(write = console.log, run = runKubectl, {intervalMs = 15000, maxSamples = 120} = {}) {
  let pending = false;
  let periodicSamples = 0;
  let stopped = false;
  let finishing = false;
  let failureRequested = false;
  let finalRequested = false;
  const queued = [];
  const sample = async phase => {
    if (stopped || (phase === 'periodic' && (finishing || periodicSamples >= maxSamples - 1))) return;
    if (phase === 'periodic') periodicSamples++;
    if (pending) { if (phase !== 'periodic') queued.push(phase); return; }
    pending = true;
    try { await collectRedis(write, run, {phase}); } catch { emit(write, phase, 'redis_unavailable'); }
    finally {
      pending = false;
      if (!stopped && queued.length) void sample(queued.shift());
    }
  };
  const onFailure = () => {
    if (!failureRequested && !finishing) { failureRequested = true; void sample('failure'); }
  };
  const onFinal = () => {
    if (finalRequested) return;
    finalRequested = true;
    finishing = true;
    clearInterval(timer);
    void sample('post_smoke');
  };
  process.on('SIGUSR1', onFailure);
  await sample('baseline');
  const timer = setInterval(() => { void sample('periodic'); }, intervalMs);
  process.on('SIGUSR2', onFinal);
  return () => {
    stopped = true;
    clearInterval(timer);
    process.off('SIGUSR1', onFailure);
    process.off('SIGUSR2', onFinal);
  };
}

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
  if (process.argv.includes('--redis-sample')) await sampleRedis();
  else if (process.argv.includes('--redis-once')) await collectRedis();
  else await collectKubernetes();
}
