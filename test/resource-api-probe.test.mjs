import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {runResourceProbe, startResourceFailureProbe} from '../scripts/resource-api-probe.mjs';
import {fixtureRowCheck} from '../scripts/smoke-diagnostics.mjs';

const parse = lines => lines.map(line => JSON.parse(line.slice('[smoke-diag] '.length)));
const page = (cookie = 'top-secret') => Object.assign(new EventEmitter(), {cookies: async () => cookie ? [{name: 'argocd.token', value: cookie}] : []});
const response = (status, url = 'https://127.0.0.1:8090/api/v1/applications/argoflow-e2e/resource?namespace=argoflow-e2e&resourceName=argoflow-hello-e2e&group=argoproj.io&kind=Workflow') => ({status: () => status, url: () => url, request: () => ({method: () => 'GET'})});
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

test('auth absent or rejected is explicit, never passed as healthy API', async () => {
  const lines = [];
  let calls = 0;
  await runResourceProbe({...defaults, page: page(null), write: line => lines.push(line), request: async () => { calls++; return {status: 200}; }});
  assert.equal(calls, 0);
  assert.deepEqual(parse(lines).map(e => e.status), ['unavailable', 'unavailable']);
  lines.length = 0;
  await runResourceProbe({...defaults, page: page(), write: line => lines.push(line), request: async () => ({status: 401})});
  assert(parse(lines).every(e => e.category === 'auth'));
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
