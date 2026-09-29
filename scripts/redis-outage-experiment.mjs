import {execFile} from 'node:child_process';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import https from 'node:https';
import {pathToFileURL} from 'node:url';

const NAMESPACE = 'argocd';
const APP = 'argoflow-e2e';
const REDIS = 'argocd-redis';
const ROUTES = Object.freeze([
  ['/api/v1/applications/:application/resource', `/api/v1/applications/${APP}/resource?namespace=argoflow-e2e&resourceName=argoflow-hello-e2e&version=v1alpha1&group=argoproj.io&kind=Workflow`],
  ['/api/v1/applications/:application/tree', `/api/v1/applications/${APP}/tree`],
  ['/healthz', '/healthz?full=true']
]);
const SOURCES = ['service', 'server_pod'];
const PHASES = ['baseline', 'outage', 'recovery'];
const clamp = (value, max) => Math.min(max, Math.max(0, Math.round(Number.isFinite(value) ? value : max)));
const bounded = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('deadline')), ms);
  Promise.resolve().then(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const allowedStatus = code => Number.isInteger(code) && code >= 100 && code <= 599 ? `${Math.floor(code / 100)}xx` : 'invalid';

export function safeRecord(write, {phase, source = 'cluster', route = 'redis', status = 'unavailable', durationMs = 0, ready = 0, endpoints = 0} = {}) {
  if (!PHASES.includes(phase)) throw new Error('invalid phase');
  write(JSON.stringify({phase, source: [...SOURCES, 'cluster'].includes(source) ? source : 'cluster',
    route: [...ROUTES.map(([template]) => template), 'redis'].includes(route) ? route : 'redis',
    status: /^(?:[1-5]xx|timeout|network_error|ready|unready|unavailable)$/.test(status) ? status : 'unavailable',
    durationMs: clamp(durationMs, 8000), ready: clamp(ready, 1), endpoints: clamp(endpoints, 9)}));
}

export async function redisState(kube) {
  const [deployment, endpoint] = await Promise.all([
    bounded(() => kube(['-n', NAMESPACE, 'get', 'deployment', REDIS, '-o', 'json']), 8500),
    bounded(() => kube(['-n', NAMESPACE, 'get', 'endpoints', REDIS, '-o', 'json']), 8500)
  ]);
  if (deployment?.metadata?.name !== REDIS || endpoint?.metadata?.name !== REDIS ||
      !Number.isInteger(deployment.spec?.replicas) || !Number.isInteger(deployment.status?.readyReplicas ?? 0) ||
      (endpoint.subsets !== undefined && !Array.isArray(endpoint.subsets))) throw new Error('incomplete redis state');
  return {desired: deployment.spec.replicas, ready: deployment.status.readyReplicas ?? 0,
    endpoints: (endpoint.subsets ?? []).reduce((sum, subset) => sum + (subset.addresses?.length ?? 0), 0)};
}

export async function waitRedis(kube, phase, ready, write, {sleep = pause, attempts = 18} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const start = Date.now();
    const state = await redisState(kube);
    safeRecord(write, {phase, status: state.ready === ready && (ready === 0 ? state.endpoints === 0 : state.endpoints > 0) ? 'ready' : 'unready',
      durationMs: Date.now() - start, ready: state.ready, endpoints: state.endpoints});
    if (state.desired === ready && state.ready === ready && (ready === 0 ? state.endpoints === 0 : state.endpoints > 0)) return state;
    if (attempt < attempts - 1) await bounded(() => sleep(2000), 2500);
  }
  throw new Error('redis state did not converge');
}

export async function probePhase(phase, {kube, http, ports, token, write}) {
  const state = await redisState(kube);
  safeRecord(write, {phase, status: state.ready > 0 && state.endpoints > 0 ? 'ready' : 'unready', ready: state.ready, endpoints: state.endpoints});
  if (phase === 'baseline' || phase === 'recovery') {
    if (state.desired !== 1 || state.ready !== 1 || state.endpoints < 1) throw new Error('redis not ready');
  } else if (state.desired !== 0 || state.ready !== 0 || state.endpoints !== 0) throw new Error('outage not established');
  const rows = [];
  for (const source of SOURCES) {
    if (!Number.isInteger(ports[source]) || ports[source] < 1 || ports[source] > 65535) throw new Error('forward unavailable');
    for (const [route, path] of ROUTES) {
      const start = Date.now();
      let status;
      try {
        const code = await bounded(() => http(`https://127.0.0.1:${ports[source]}${path}`, route === '/healthz' ? null : token), 4500);
        status = allowedStatus(code);
        if (status === 'invalid') throw new Error('invalid response');
      } catch (error) {
        if (error?.name === 'AbortError' || error?.message === 'deadline') status = 'timeout';
        else throw new Error('incomplete HTTP probe');
      }
      safeRecord(write, {phase, source, route, status, durationMs: Date.now() - start});
      rows.push({route, status});
    }
  }
  if (phase !== 'outage' && rows.some(row => row.status !== '2xx')) throw new Error('healthy-phase probe failed');
  if (phase === 'outage' && rows.filter(row => row.route === '/healthz').some(row => row.status !== '2xx')) throw new Error('health control failed');
  return rows;
}

export async function experiment({kube, http, ports, token, write = console.log, sleep = pause, attempts = 18}) {
  let injectionAttempted = false;
  let error;
  try {
    await waitRedis(kube, 'baseline', 1, write, {sleep, attempts});
    await probePhase('baseline', {kube, http, ports, token, write});
    injectionAttempted = true;
    await bounded(() => kube(['-n', NAMESPACE, 'scale', `deployment/${REDIS}`, '--replicas=0']), 8500);
    await waitRedis(kube, 'outage', 0, write, {sleep, attempts});
    await probePhase('outage', {kube, http, ports, token, write});
  } catch (cause) { error = cause; }
  if (injectionAttempted) {
    try {
      await bounded(() => kube(['-n', NAMESPACE, 'scale', `deployment/${REDIS}`, '--replicas=1']), 8500);
      await waitRedis(kube, 'recovery', 1, write, {sleep, attempts});
      await probePhase('recovery', {kube, http, ports, token, write});
    } catch (cause) { error = new Error('restore or recovery failed', {cause: error ? new AggregateError([error, cause]) : cause}); }
  }
  if (error) throw error;
}

function command(binary, args, {input} = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, {timeout: 8000, maxBuffer: 256 * 1024}, (error, stdout) => error ? reject(new Error('command failed')) : resolve(stdout));
    if (input) child.stdin.end(input);
  });
}
const kube = async args => {
  const output = await command('kubectl', args);
  if (args.at(-1) === 'json') {
    try { return JSON.parse(output); } catch { throw new Error('invalid kubectl JSON'); }
  }
  return output.trim();
};

async function forward(target, remotePort) {
  const child = spawn('kubectl', ['-n', NAMESPACE, 'port-forward', '--address', '127.0.0.1', target, `:${remotePort}`], {stdio: ['ignore', 'pipe', 'pipe']});
  child.stderr.resume(); // Never print kubectl stderr: it may include resource identifiers.
  try {
    const port = await bounded(() => new Promise((resolve, reject) => {
      let text = '';
      child.stdout.on('data', chunk => {
        text = (text + chunk.toString()).slice(-512);
        const match = text.match(new RegExp(`Forwarding from 127\\.0\\.0\\.1:(\\d+) -> ${remotePort}`));
        if (match) resolve(Number(match[1]));
      });
      child.on('error', () => reject(new Error('forward start failed')));
      child.on('exit', () => reject(new Error('forward exited')));
    }), 8000);
    return {port, stop: () => child.kill()};
  } catch { child.kill(); throw new Error('forward unavailable'); }
}

async function localRequest(url, {token, body} = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {method: body ? 'POST' : 'GET', rejectUnauthorized: false,
      headers: body ? {'content-type': 'application/json'} : token ? {Authorization: `Bearer ${token}`} : {}}, res => {
      if (body) {
        let data = '';
        res.on('data', chunk => { data += chunk; if (data.length > 8192) req.destroy(new Error('response too large')); });
        res.on('end', () => resolve({status: res.statusCode, body: data}));
      } else { res.resume(); res.on('end', () => resolve({status: res.statusCode})); }
    });
    req.setTimeout(4000, () => req.destroy(new Error('deadline')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const http = async (url, token) => (await localRequest(url, {token})).status;

export async function verifyDisposableCluster({env = process.env, get = kube, kind = args => command('kind', args)} = {}) {
    // Never operate against an ambient or shared kubeconfig. The workflow owns this path.
    if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
        !env.RUNNER_TEMP || env.KUBECONFIG !== `${env.RUNNER_TEMP}/redis-experiment-kubeconfig` ||
        env.ARGOCD_VERSION !== 'v3.4.7') throw new Error('unsafe runner');
    const context = await get(['config', 'current-context']);
    const clusters = (await kind(['get', 'clusters'])).trim().split(/\s+/);
    const config = await get(['config', 'view', '--minify', '-o', 'json']);
    if (context !== 'kind-argoflow-redis-experiment' || clusters.length !== 1 || clusters[0] !== 'argoflow-redis-experiment' ||
        !/^https:\/\/127\.0\.0\.1:\d+$/.test(config.clusters?.[0]?.cluster?.server ?? '')) throw new Error('unsafe cluster');
}

async function main() {
  const forwards = [];
  try {
    await verifyDisposableCluster();
    const manifest = await readFile('test/e2e/argocd-application.yaml', 'utf8');
    if (!process.env.FIXTURE_SHA?.match(/^[a-f0-9]{40}$/) || !/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\.git$/.test(process.env.FIXTURE_REPO ?? '')) throw new Error('invalid fixture ref');
    const fixture = manifest.replace('__REVISION__', process.env.FIXTURE_SHA).replace('__REPO_URL__', process.env.FIXTURE_REPO);
    await command('kubectl', ['apply', '-f', '-'], {input: fixture});
    for (let i = 0; i < 66; i++) {
      const app = await kube(['-n', NAMESPACE, 'get', 'application', APP, '-o', 'json']);
      const workflow = await kube(['-n', 'argoflow-e2e', 'get', 'workflow', 'argoflow-hello-e2e', '-o', 'json']).catch(() => null);
      if (app?.status?.sync?.status === 'Synced' && workflow?.status?.phase === 'Succeeded') break;
      if (i === 65 || ['Error', 'Failed'].includes(workflow?.status?.phase)) throw new Error('fixture did not converge');
      await pause(10000);
    }
    const podList = await kube(['-n', NAMESPACE, 'get', 'pods', '-l', 'app.kubernetes.io/name=argocd-server', '-o', 'json']);
    if (podList?.items?.length !== 1 || !podList.items[0].metadata?.name || !podList.items[0].status?.containerStatuses?.every(c => c.ready)) throw new Error('server pod unavailable');
    const service = await forward('svc/argocd-server', 443); forwards.push(service);
    const serverPod = await forward(`pod/${podList.items[0].metadata.name}`, 8080); forwards.push(serverPod);
    const encoded = await kube(['-n', NAMESPACE, 'get', 'secret', 'argocd-initial-admin-secret', '-o', 'json']);
    const password = Buffer.from(encoded?.data?.password ?? '', 'base64').toString('utf8');
    if (!password) throw new Error('authentication unavailable');
    const auth = await bounded(() => localRequest(`https://127.0.0.1:${service.port}/api/v1/session`, {
      body: {username: 'admin', password}
    }), 4500);
    if (auth.status !== 200) throw new Error('authentication failed');
    let token;
    try { token = JSON.parse(auth.body)?.token; } catch { throw new Error('authentication failed'); }
    if (typeof token !== 'string' || !token) throw new Error('authentication failed');
    await experiment({kube, http, ports: {service: service.port, server_pod: serverPod.port}, token});
  } finally { for (const item of forwards) item.stop(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2] === '--verify' ? verifyDisposableCluster : process.argv[2] === '--cleanup' ? async () => {
    await verifyDisposableCluster();
    await kube(['-n', NAMESPACE, 'scale', `deployment/${REDIS}`, '--replicas=1']);
    await waitRedis(kube, 'recovery', 1, console.log);
  } : main;
  action().catch(() => { console.error('redis experiment failed (setup, probe, injection or restoration)'); process.exitCode = 1; });
}
