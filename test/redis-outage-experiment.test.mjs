import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {test} from 'node:test';
import {experiment, forward, probePhase, redisState, safeRecord, verifyDisposableCluster} from '../scripts/redis-outage-experiment.mjs';

const fixture = () => {
  let replicas = 1;
  let ready = 1;
  const calls = [];
  const kube = async args => {
    calls.push(args.join(' '));
    if (args.includes('scale')) {
      replicas = Number(args.at(-1).split('=')[1]);
      ready = replicas;
      return '';
    }
    if (args.includes('deployment')) return {metadata: {name: 'argocd-redis'}, spec: {replicas}, status: {readyReplicas: ready}};
    if (args.includes('endpoints')) return {metadata: {name: 'argocd-redis'}, subsets: ready ? [{addresses: [{}]}] : undefined};
    throw new Error('unexpected kubectl command');
  };
  return {kube, calls, get replicas() { return replicas; }};
};
const ports = {service: 1001, server_pod: 1002};
const run = (overrides = {}) => {
  const f = fixture();
  const lines = [];
  return {f, lines, options: {kube: f.kube, http: async () => 200, ports, token: 'PRIVATE_TOKEN',
    write: line => lines.push(line), sleep: async () => {}, attempts: 2, ...overrides}};
};

test('kubectl announcements start both forwards; wrong port and silent process fail within deadline', async () => {
  const children = [];
  const fake = (announcement, target, remotePort) => (binary, args, options) => {
    assert.equal(binary, 'kubectl');
    assert.deepEqual(args, ['-n', 'argocd', 'port-forward', '--address', '127.0.0.1', target, `:${remotePort}`]);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.stdout.destroy(); child.stderr.destroy(); child.killed = true; };
    children.push(child);
    if (announcement) queueMicrotask(() => {
      child.stderr.write('SECRET_POD_NAME');
      child.stdout.write(announcement);
    });
    return child;
  };
  const service = await forward('svc/argocd-server', 443, {
    spawnForward: fake('Forwarding from 127.0.0.1:38123 -> 443\n', 'svc/argocd-server', 443), timeoutMs: 50
  });
  const pod = await forward('pod/server', 8080, {
    spawnForward: fake('Forwarding from 127.0.0.1:39124 -> 8080\n', 'pod/server', 8080), timeoutMs: 50
  });
  assert.equal(service.port, 38123);
  assert.equal(pod.port, 39124);
  service.stop(); pod.stop();
  await assert.rejects(forward('svc/argocd-server', 443, {
    spawnForward: fake('Forwarding from 127.0.0.1:38123 -> 8080\n', 'svc/argocd-server', 443), timeoutMs: 20
  }), /^Error: forward unavailable$/);
  await assert.rejects(forward('pod/server', 8080, {
    spawnForward: fake(null, 'pod/server', 8080), timeoutMs: 20
  }), /^Error: forward unavailable$/);
  assert.ok(children.every(child => child.killed));
});

test('baseline, isolated outage, restoration and both forward routes; output is a strict schema', async () => {
  const {f, lines, options} = run({http: async url => f.replicas === 0 && !url.includes('/healthz') ? 504 : 200});
  await experiment(options);
  assert.equal(f.replicas, 1);
  assert.deepEqual(f.calls.filter(call => call.includes('scale')).map(call => call.split('--replicas=')[1]), ['0', '1']);
  const rows = lines.map(JSON.parse);
  for (const phase of ['baseline', 'outage', 'recovery']) {
    for (const source of ['service', 'server_pod']) {
      assert.equal(rows.filter(row => row.phase === phase && row.source === source).length, 3);
    }
  }
  assert.equal(rows.filter(row => row.phase === 'outage' && row.status === '5xx').length, 4);
  for (const row of rows) assert.deepEqual(Object.keys(row), ['phase', 'source', 'route', 'status', 'durationMs', 'ready', 'endpoints']);
  assert.ok(!lines.join('').includes('PRIVATE_TOKEN'));
  assert.ok(!lines.join('').includes('argoflow-hello-e2e'));
  assert.ok(!lines.join('').includes('?'));
});

test('opaque kubectl fault after injection restores Redis and fails', async () => {
  const {f, options} = run();
  const kube = async args => {
    if (f.replicas === 0 && args.includes('endpoints')) throw new Error('SENSITIVE KUBE ERROR');
    return f.kube(args);
  };
  await assert.rejects(experiment({...options, kube}), /SENSITIVE KUBE ERROR/);
  assert.equal(f.replicas, 1);
});

test('HTTP failures and timed-out probes are bounded; recovery failure is red after restore', async () => {
  const {f, options, lines} = run();
  await assert.rejects(experiment({...options, http: async url => {
    if (f.replicas === 0 && url.includes('/healthz')) return new Promise(() => {});
    return 200;
  }}), /health control failed/);
  assert.equal(f.replicas, 1);
  assert.equal(lines.map(JSON.parse).filter(row => row.status === 'timeout').length, 2);
  const second = run({http: async () => { throw new Error('SECRET_HTTP_BODY'); }});
  await assert.rejects(experiment(second.options), /incomplete HTTP probe/);
  assert.equal(second.f.replicas, 1); // Baseline failed before injection.
  assert.equal(second.f.calls.some(call => call.includes('scale')), false);
});

test('restore command failure cannot pass, and injection command failure still attempts restore', async () => {
  const {f, options} = run();
  let fail = true;
  const kube = async args => {
    if (args.includes('scale') && args.includes('--replicas=0') && fail) { fail = false; await f.kube(args); throw Error('partial injection'); }
    return f.kube(args);
  };
  await assert.rejects(experiment({...options, kube}), /partial injection/);
  assert.equal(f.replicas, 1);
  const other = run();
  await assert.rejects(experiment({...other.options, kube: async args => {
    if (args.includes('--replicas=1')) throw Error('restore failure');
    return other.f.kube(args);
  }}), /restore or recovery failed/);
  assert.equal(other.f.replicas, 0);
});

test('missing endpoints, malformed kubectl, bad ports, and non-2xx baseline fail closed', async () => {
  await assert.rejects(redisState(async () => ({})), /incomplete redis state/);
  const {options} = run();
  await assert.rejects(probePhase('baseline', {...options, ports: {service: 0, server_pod: 2}}), /forward unavailable/);
  await assert.rejects(probePhase('baseline', {...options, http: async () => 500}), /healthy-phase probe failed/);
});

test('records cannot leak untrusted fields or unbounded metrics', () => {
  const lines = [];
  safeRecord(line => lines.push(line), {phase: 'outage', source: 'SECRET', route: '/secret?token=SECRET',
    status: 'SECRET', durationMs: Infinity, ready: 9999, endpoints: 9999, podName: 'SECRET'});
  assert.deepEqual(JSON.parse(lines[0]), {phase: 'outage', source: 'cluster', route: 'redis',
    status: 'unavailable', durationMs: 8000, ready: 1, endpoints: 9});
  assert.ok(!lines[0].includes('SECRET'));
});

test('cluster guard rejects ambient kubeconfig, wrong cluster and non-local API before mutation', async () => {
  const env = {GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: '/runner',
    KUBECONFIG: '/runner/redis-experiment-kubeconfig', ARGOCD_VERSION: 'v3.4.7'};
  const get = async args => args.includes('current-context') ? 'kind-argoflow-redis-experiment' :
    {clusters: [{cluster: {server: 'https://127.0.0.1:12345'}}]};
  const kind = async () => 'argoflow-redis-experiment';
  await verifyDisposableCluster({env, get, kind});
  await assert.rejects(verifyDisposableCluster({env: {...env, KUBECONFIG: '/home/shared'}, get, kind}), /unsafe runner/);
  await assert.rejects(verifyDisposableCluster({env, get, kind: async () => 'shared'}), /unsafe cluster/);
  await assert.rejects(verifyDisposableCluster({env, kind, get: async args => args.includes('current-context') ? 'kind-argoflow-redis-experiment' :
    {clusters: [{cluster: {server: 'https://shared.example:443'}}]}}), /unsafe cluster/);
});
