import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {EXTENSION_VERSION, telemetryDetail} from '../src/telemetry.ts';

const [telemetry, workspace, runs] = await Promise.all([
  readFile(new URL('../src/telemetry.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/workflow-workspace.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/application-workflows-view.ts', import.meta.url), 'utf8')
]);

test('telemetry detail is anonymous and limited to operational fields', () => {
  const detail = telemetryDetail('workflow.ready', {
    feature: 'workflow-list', nodeCount: 5000, pageSize: 100, rowCount: 20,
    source: 'Live', state: 'ready', view: 'list', durationMs: 12
  });
  assert.deepEqual(Object.keys(detail).sort(), [
    'durationMs', 'event', 'feature', 'nodeCount', 'pageSize', 'rowCount', 'source', 'state', 'version', 'view'
  ]);
  assert.equal(detail.version, EXTENSION_VERSION);
  assert.doesNotMatch(JSON.stringify(detail), /run-|payments|secret|message|parameter|url/i);
});

test('telemetry contract does not accept or interpolate resource data', () => {
  const hostile = telemetryDetail('run-page.loaded', {
    resourceName: 'payments-secret', message: 'bearer token', url: 'https://cluster.example'
  });
  assert.deepEqual(hostile, {event: 'run-page.loaded', version: EXTENSION_VERSION});
  assert.match(telemetry, /anonymous operational facts/);
  assert.doesNotMatch(telemetry, /resource(Name|Namespace|Message|Url)/);
  assert.match(workspace, /nodeCount: nodes\.length/);
  assert.match(runs, /durationMs/);
});

test('event telemetry remains anonymous while recording bounded operational outcomes', async () => {
  const detail = telemetryDetail('event-chain.loaded', {
    feature: 'event-chain', state: 'partial', durationMs: 4, readCount: 25, errorCount: 2, nodeCount: 9,
    resourceName: 'events-secret', url: 'https://cluster.example', message: 'Bearer secret', payload: '{"token":"x"}', headers: {authorization: 'Bearer x'}, params: {namespace: 'events'}
  });
  assert.deepEqual(detail, {
    event: 'event-chain.loaded', version: EXTENSION_VERSION, feature: 'event-chain', state: 'partial', durationMs: 4, readCount: 25, errorCount: 2, nodeCount: 9
  });
  assert.match(telemetry, /event-resource\.loaded/);
  assert.match(telemetry, /event-chain\.query/);
  assert.match(telemetry, /event-chain\.loaded/);
  assert.match(telemetry, /resource-event-source/);
  assert.doesNotMatch(JSON.stringify(detail), /events-secret|cluster|bearer|token|authorization|namespace/i);
});
