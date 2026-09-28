import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {runResourceProbe, startResourceFailureProbe} from '../scripts/resource-api-probe.mjs';
import {fixtureRowCheck} from '../scripts/smoke-diagnostics.mjs';

const parse = lines => lines.map(line => JSON.parse(line.slice('[smoke-diag] '.length)));
const page = (cookie = 'top-secret') => Object.assign(new EventEmitter(), {cookies: async () => cookie ? [{name: 'argocd.token', value: cookie}] : []});
const fixtureUrl = 'https://127.0.0.1:8090/api/v1/applications/argoflow-e2e/resource?namespace=argoflow-e2e&resourceName=argoflow-hello-e2e&version=v1alpha1&group=argoproj.io&kind=Workflow';
const response = (status, url = fixtureUrl) => ({status: () => status, url: () => url, request: () => ({method: () => 'GET'})});
const defaults = {phase: () => 'fixture_row_wait', collect: async () => {}, selectPod: async () => 'argocd-server-123', forward: async () => () => {}};

test('one round on repeated fixture failures; ignore unrelated requests and overlapping failures', async () => {
  const lines = [];
  const browser = page();
  let requests = 0;
  const stop = startResourceFailureProbe(browser, defaults.phase, {...defaults, write: line => lines.push(line), request: async () => { requests++; return {status: 200}; }});
  browser.emit('response', response(504, 'https://127.0.0.1:8090/api/v1/applications/other/resource?namespace=argoflow-e2e&resourceName=argoflow-hello-e2e&group=argoproj.io&kind=Workflow'));
  browser.emit('response', response(504));
  browser.emit('response', response(500));
  browser.emit('response', response(504));
  await new Promise(resolve => setTimeout(resolve, 20));
  stop();
  assert.equal(requests, 6);
  assert.deepEqual(parse(lines).filter(e => e.source === 'browser').map(e => e.category), ['deadline_exceeded_candidate', 'unknown_candidate']);
  assert.equal(parse(lines).filter(e => e.event === 'resource_probe').length, 6);
  assert(!/secret|argoflow-e2e|localhost|127\.0\.0\.1/.test(lines.join('')));
  assert(parse(lines).every(e => Object.keys(e).join(',') === 'timestamp,phase,event,route,method,status,durationMs,source,category'));
});

test('only the exact fixture identity can trigger a round, rejecting version, duplicates and extra selectors', async () => {
  const lines = [];
  const browser = page();
  let calls = 0;
  const stop = startResourceFailureProbe(browser, defaults.phase, {...defaults, write: line => lines.push(line), request: async () => { calls++; return {status: 200}; }});
  const alien = [fixtureUrl.replace('v1alpha1', 'v2'), `${fixtureUrl}&namespace=other`, `${fixtureUrl}&version=v2`, `${fixtureUrl}&resourceName=other`, `${fixtureUrl}&token=secret`, fixtureUrl.replace('https:', 'http:'), fixtureUrl.replace('kind=Workflow', 'kind=Workflow#secret')];
  for (const url of alien) { browser.emit('response', response(500, url)); browser.emit('response', response(504, url)); }
  assert.equal(lines.length, 0);
  browser.emit('response', response(500));
  assert.equal(lines.length, 1);
  browser.emit('response', response(504));
  await new Promise(resolve => setTimeout(resolve, 20));
  stop();
  assert.equal(calls, 6);
  assert(!/secret|argoflow-e2e|127\.0\.0\.1/.test(lines.join('')));
});

test('failure-time Redis/server/controller readiness and capped restarts use only the fixed event schema', async () => {
  const lines = [];
  const collect = async write => {
    for (const [component, phase, ready, restarts] of [
      ['argocd-server', 'Running', true, 100000], ['argocd-redis', 'Pending', false, 2],
      ['argocd-application-controller', 'Running', true, 0]
    ]) write(`[smoke-diag] ${JSON.stringify({event: 'pod', component, podPhase: phase, containers: [{ready, restarts, reason: 'secret'}], message: 'token secret'})}`);
    write('[smoke-diag] {"event":"pod_event","component":"argocd-server","message":"token secret"}');
  };
  await runResourceProbe({...defaults, collect, page: page(), write: line => lines.push(line), request: async () => ({status: 200})});
  const events = parse(lines);
  assert.equal(events.length, 9);
  assert.deepEqual(events.filter(e => e.event.startsWith('pod_')).map(e => [e.event, e.status, e.category]), [
    ['pod_server', 999, 'ready'], ['pod_redis', 2, 'not_ready'], ['pod_controller', 0, 'ready']
  ]);
  assert(events.every(e => Object.keys(e).join(',') === 'timestamp,phase,event,route,method,status,durationMs,source,category'));
  assert(events.every(e => ['/healthz', '/api/v1/applications/:application/resource', '/api/v1/applications/:application/resource-tree'].includes(e.route)));
  assert(!/secret|argocd-server|argoflow-e2e|127\.0\.0\.1/.test(lines.join('')));
});

test('auth absent or rejected is explicit, never passed as healthy API', async () => {
  const lines = [];
  let calls = 0;
  await runResourceProbe({...defaults, page: page(null), write: line => lines.push(line), request: async () => { calls++; return {status: 200}; }});
  assert.equal(calls, 0);
  assert.deepEqual(parse(lines).map(e => e.status), ['unavailable', 'unavailable']);
  lines.length = 0;
  await runResourceProbe({...defaults, page: page(), write: line => lines.push(line), request: async () => ({status: 401})});
  assert(parse(lines).filter(e => e.event === 'resource_probe').every(e => e.category === 'auth'));
});

test('stalled endpoint is aborted and direct pod remains independently measured', async () => {
  const lines = [];
  await runResourceProbe({...defaults, page: page(), endpointMs: 12, write: line => lines.push(line), request: (url, {signal}) => url.includes('8090') ? new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('private secret')), {once: true})) : Promise.resolve({status: 504})});
  const events = parse(lines);
  assert.equal(events.filter(e => e.source === 'service_forward' && e.status === 'timeout').length, 3);
  assert.equal(events.filter(e => e.source === 'pod_direct' && e.category === 'deadline_exceeded_candidate').length, 3);
  assert(!lines.join('').includes('private secret'));
});

test('direct auth/forward unavailable cannot be mistaken for success; injected 500 remains unknown candidate', async () => {
  const lines = [];
  await runResourceProbe({...defaults, page: page(), forward: async () => null, write: line => lines.push(line), request: async () => ({status: 500})});
  assert.equal(parse(lines).find(e => e.source === 'service_forward').category, 'unknown_candidate');
  assert.equal(parse(lines).find(e => e.source === 'pod_direct').status, 'unavailable');
});

test('fixture row remains red under injected resource 5xx even if diagnostic probes return 200', async () => {
  const browser = page();
  const lines = [];
  const stop = startResourceFailureProbe(browser, defaults.phase, {...defaults, write: line => lines.push(line), request: async () => ({status: 200})});
  browser.emit('response', response(500));
  browser.emit('response', response(504));
  await assert.rejects(fixtureRowCheck(async () => { throw new Error('fixture row missing'); }, 10), /fixture row missing/);
  await new Promise(resolve => setTimeout(resolve, 20));
  stop();
  assert(parse(lines).some(e => e.event === 'resource_probe' && e.status === 200));
});
