import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {route, startNetworkDiagnostics, startHeartbeat, collectKubernetes, collectRedis, sanitizeRedisSnapshot, sampleRedis, viewSwitchCheck} from '../scripts/smoke-diagnostics.mjs';

const parsed = lines => lines.map(line => JSON.parse(line.slice('[smoke-diag] '.length)));

test('5xx and failed requests emit only allowlisted templates and failure codes', () => {
  const page = new EventEmitter();
  const lines = [];
  const stop = startNetworkDiagnostics(page, () => 'fixture_row_wait', line => lines.push(line));
  const req = {url: () => 'https://localhost:8090/api/v1/applications/private-name/resource?token=secret#fragment', method: () => 'GET', failure: () => ({errorText: 'net::ERR_TIMED_OUT'})};
  page.emit('request', req);
  page.emit('response', {status: () => 504, request: () => req});
  page.emit('requestfailed', req);
  const alien = {url: () => 'https://other.example/private?token=secret', method: () => 'CUSTOM secret', failure: () => ({errorText: 'private error secret'})};
  page.emit('requestfailed', alien);
  for (let index = 0; index < 200; index++) page.emit('requestfailed', req);
  assert.equal(lines.length, 100);
  stop();
  page.emit('requestfailed', req);
  const events = parsed(lines.slice(0, 3));
  assert.equal(events.length, 3);
  assert.deepEqual(events.map(event => event.event), ['http_5xx', 'request_failed', 'request_failed']);
  assert.equal(events[0].status, 504);
  assert.equal(events[0].route, '/api/v1/applications/:application/resource');
  assert.equal(events[1].failure, 'timeout');
  assert.deepEqual([events[2].route, events[2].method, events[2].failure], ['other', 'other', 'other']);
  assert.equal(typeof events[0].durationMs, 'number');
  assert(!/secret|private-name|other.example|fragment/.test(lines.join('')));
  assert.equal(route('https://localhost:8090/applications/private?x=y'), '/applications/:application');
  assert.equal(lines.length, 100);
});

test('independent heartbeat separates protocol from renderer stall and stops without another tick', async () => {
  const lines = [];
  let tick;
  let cancelled = false;
  const stop = startHeartbeat({send: command => command === 'Browser.getVersion' ? Promise.resolve({}) : new Promise(() => {})}, () => 'fixture_row_wait', line => lines.push(line), {
    timeoutMs: 10, schedule: callback => { tick = callback; return 1; }, cancel: () => { cancelled = true; }
  });
  await tick();
  assert.deepEqual([parsed(lines)[0].protocol, parsed(lines)[0].renderer], ['ok', 'timeout']);
  stop();
  await tick();
  assert(cancelled);
  assert.equal(lines.length, 1);
});

test('protocol stall does not masquerade as a renderer evaluation timeout', async () => {
  const lines = [];
  let tick;
  let rendererCalls = 0;
  const stop = startHeartbeat({send: command => {
    if (command === 'Runtime.evaluate') rendererCalls++;
    return new Promise(() => {});
  }}, () => 'events_view', line => lines.push(line), {timeoutMs: 5, schedule: callback => { tick = callback; return 1; }, cancel: () => {}});
  await tick();
  assert.deepEqual([parsed(lines)[0].protocol, parsed(lines)[0].renderer], ['timeout', 'not_probed']);
  assert.equal(rendererCalls, 0);
  stop();
});

test('collector caps pod/event output and redacts arbitrary fields', async () => {
  const lines = [];
  let calls = 0;
  const run = async (_namespace, kind) => {
    calls++;
    if (kind === 'pods') return {items: Array.from({length: 20}, (_, index) => ({metadata: {name: `argocd-server-${index}`}, status: {phase: 'secret', containerStatuses: [{restartCount: 100000, ready: true, state: {waiting: {reason: 'token secret'}}}]}}))};
    return {items: Array.from({length: 20}, () => ({involvedObject: {name: 'argocd-server-0'}, reason: 'token secret', message: 'password secret', type: 'Warning'}))};
  };
  await collectKubernetes(line => lines.push(line), run);
  assert.equal(calls, 10);
  assert(lines.length <= 18);
  assert(!/secret|password|argocd-server-0/.test(lines.join('')));
  assert(parsed(lines).some(event => event.event === 'pod' && event.containers[0].restarts === 999));
});

test('assertions remain blocking under strict smoke mode', async () => {
  const failure = new Error('secret assertion');
  await assert.rejects(viewSwitchCheck(() => { throw failure; }, {strict: true, warn: () => assert.fail('warn'), screenshot: () => assert.fail('shot')}), error => error === failure);
  const {spawnSync} = await import('node:child_process');
  const result = spawnSync(process.execPath, ['scripts/e2e-smoke.mjs'], {env: {...process.env, ARGOCD_PASSWORD: 'secret', CHROME_PATH: '/nonexistent/chrome', ARGOFLOW_SMOKE_STRICT: '1'}, encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert(!result.stderr.includes('secret'));
});

test('Redis never starts: deployment and endpoint remain empty with init wait classified', () => {
  const now = Date.parse('2026-09-27T01:00:00Z');
  const pod = {metadata: {namespace: 'argocd', name: 'argocd-redis-private', uid: 'private-uid', creationTimestamp: '2026-09-27T00:59:30Z'}, spec: {}, status: {phase: 'Pending', initContainerStatuses: [{ready: false, restartCount: 0, state: {waiting: {reason: 'ImagePullBackOff'}}}]}};
  const result = sanitizeRedisSnapshot({pods: {items: [pod]}, deployments: {items: [{metadata: {name: 'argocd-redis'}, spec: {replicas: 1}, status: {}}]}, endpoints: {items: []}}, now, new Map());
  assert.deepEqual(result.deployment, {desired: 1, ready: 0, available: 0});
  assert.equal(result.endpointReady, 0);
  assert.deepEqual([result.pods[0].assigned, result.pods[0].age, result.pods[0].init[0].waiting], [false, 'under_1m', 'ImagePullBackOff']);
  assert.equal(result.pods[0].main.length, 0);
  assert(!JSON.stringify(result).includes('private'));
});

test('stable ordinal distinguishes replacement from main-container restart', () => {
  const keys = new Map();
  const pod = (uid, restarts) => ({metadata: {namespace: 'argocd', name: 'argocd-redis-pod', uid, creationTimestamp: '2026-09-27T00:00:00Z'}, status: {phase: 'Running', containerStatuses: [{ready: true, restartCount: restarts, lastState: {terminated: {reason: 'OOMKilled'}}}]}});
  const snapshot = p => sanitizeRedisSnapshot({pods: {items: [p]}}, Date.parse('2026-09-27T01:00:00Z'), keys).pods[0];
  const first = snapshot(pod('uid-one', 0));
  const restart = snapshot(pod('uid-one', 1));
  const replacement = snapshot(pod('uid-two', 0));
  assert.equal(first.ordinal, restart.ordinal);
  assert.notEqual(restart.ordinal, replacement.ordinal);
  assert.deepEqual([restart.main[0].restarts, restart.main[0].lastTermination, replacement.main[0].restarts], [1, 'OOMKilled', 0]);
});

test('events sort by timestamp, bound output and redact untrusted fields', () => {
  const now = Date.parse('2026-09-27T01:00:00Z');
  const pod = {metadata: {namespace: 'argocd', name: 'argocd-redis-needle', uid: 'uid-needle', creationTimestamp: '2026-09-27T00:50:00Z'}, status: {phase: 'hidden-value', containerStatuses: [{state: {waiting: {reason: 'private-token'}}, restartCount: 90000}]}};
  const events = Array.from({length: 30}, (_, index) => ({involvedObject: {uid: 'uid-needle'}, lastTimestamp: new Date(now - (index + 1) * 1000).toISOString(), reason: index === 0 ? 'BackOff' : 'secret-event', type: 'Warning', count: 10000, message: 'private-token'}));
  const output = sanitizeRedisSnapshot({pods: {items: [pod]}, deployments: {items: []}, endpoints: {items: []}, events: {items: events}}, now, new Map());
  assert.equal(output.events.length, 8);
  assert.equal(output.events.at(-1).reason, 'BackOff');
  assert.equal(output.events[0].reason, 'other');
  assert.equal(output.events[0].count, 999);
  assert.equal(output.pods[0].main[0].waiting, 'other');
  assert(!/private|needle|secret/.test(JSON.stringify(output)));
});

test('hung kubectl is bounded, suppressed and does not change strict red smoke', async () => {
  const lines = [];
  const start = Date.now();
  await collectRedis(line => lines.push(line), () => new Promise(() => {}), {timeoutMs: 15});
  assert(Date.now() - start < 500);
  assert.equal(parsed(lines)[0].event, 'redis_unavailable');
  const partial = [];
  await collectRedis(line => partial.push(line), async (_namespace, kind) => kind === 'events' ? null : {items: []});
  assert.equal(parsed(partial)[0].event, 'redis_unavailable');
  const {spawnSync} = await import('node:child_process');
  const result = spawnSync(process.execPath, ['scripts/e2e-smoke.mjs'], {env: {...process.env, ARGOCD_PASSWORD: 'secret', CHROME_PATH: '/nonexistent/chrome', ARGOFLOW_SMOKE_STRICT: '1', ARGOFLOW_REDIS_SAMPLER_PID_FILE: '/nonexistent/private'}, encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert(result.stderr.includes('[smoke] FAIL'));
  assert(!result.stderr.includes('private'));
});

test('workflow reserves failure signal for smoke and uses distinct bounded post-smoke signal', () => {
  const workflow = readFileSync('.github/workflows/ci-release.yml', 'utf8');
  const collector = workflow.split('      - name: Collect bounded Redis lifecycle timeline')[1].split('      - name: Collect failure-only Kubernetes diagnostics')[0];
  const smoke = readFileSync('scripts/e2e-smoke.mjs', 'utf8');
  assert.match(smoke, /process\.kill\(pid, 'SIGUSR1'\)/);
  assert.match(collector, /kill -USR2 "\$pid"/);
  assert.doesNotMatch(collector, /kill -USR1/);
  assert.match(collector, /"phase.*post_smoke/);
  assert.match(collector, /for attempt in \{1\.\.15\}/);
  assert.match(workflow, /ARGOFLOW_SMOKE_STRICT: '1'/);
  assert.match(workflow, /needs: \[check, compatibility\]/);
  const command = collector.match(/^\s*if (node -e ".*"); then$/m)?.[1];
  assert(command);
  const directory = mkdtempSync(join(tmpdir(), 'redis-marker-'));
  const path = join(directory, 'redis-lifecycle.jsonl');
  try {
    const check = () => spawnSync('bash', ['-c', command], {env: {...process.env, RUNNER_TEMP: directory}});
    writeFileSync(path, '[smoke-diag] {"phase":"periodic","event":"redis_snapshot"}\n');
    assert.equal(check().status, 1);
    writeFileSync(path, '[smoke-diag] {"phase":"post_smoke","event":"redis_unavailable"}\n', {flag: 'a'});
    assert.equal(check().status, 0);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

for (const failed of [false, true]) {
  test(`sampler ${failed ? 'red' : 'green'} smoke queues final behind a periodic read`, async () => {
    const lines = [];
    let calls = 0;
    let release;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    let markFinal;
    const finished = new Promise(resolve => { markFinal = resolve; });
    const run = async (_namespace, kind) => {
      calls++;
      if (kind === 'pods' && calls === 5) {
        await new Promise(resolve => { release = resolve; markStarted(); });
      }
      return {items: []};
    };
    const stop = await sampleRedis(line => {
      lines.push(line);
      if (JSON.parse(line.slice('[smoke-diag] '.length)).phase === 'post_smoke') markFinal();
    }, run, {intervalMs: 5, maxSamples: 2});
    try {
      await started;
      if (failed) process.emit('SIGUSR1');
      process.emit('SIGUSR2');
      process.emit('SIGUSR2'); // Duplicate cleanup must not duplicate samples.
      release();
      await finished;
      assert.deepEqual(parsed(lines).map(line => line.phase), failed
        ? ['baseline', 'periodic', 'failure', 'post_smoke']
        : ['baseline', 'periodic', 'post_smoke']);
      assert.equal(calls, failed ? 16 : 12);
      await new Promise(resolve => setTimeout(resolve, 15));
      assert.equal(calls, failed ? 16 : 12);
    } finally { stop(); }
  });
}
