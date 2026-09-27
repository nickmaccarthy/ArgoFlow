import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {route, startNetworkDiagnostics, startHeartbeat, collectKubernetes, viewSwitchCheck} from '../scripts/smoke-diagnostics.mjs';

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
  assert.equal(calls, 8);
  assert(lines.length <= 17);
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
