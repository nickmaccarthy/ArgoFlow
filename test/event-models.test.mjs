import assert from 'node:assert/strict';
import test from 'node:test';

import {eventBusResourceState, eventBusSummary} from '../src/event-bus-resource.ts';
import {correlateEventChain, dependencyCorrelation, firstBlockedHop, workflowCorrelation, workflowHealth} from '../src/event-correlation.ts';
import {eventHealth, safeEventText, safeExpression} from '../src/event-resource.ts';
import {eventSourceEvents, eventSourceManifest, eventSourceResourceState, eventSourceSummary} from '../src/event-source-resource.ts';
import {sensorResourceState, sensorSummary, sensorTriggers} from '../src/sensor-resource.ts';

const ready = [{type: 'Deployed', status: 'True', message: 'Connected'}];
const source = {
  apiVersion: 'argoproj.io/v1alpha1', kind: 'EventSource', metadata: {name: 'webhook', namespace: 'events'},
  spec: {eventBusName: 'default', service: {ports: [{port: 9999}]}, webhook: {release: {endpoint: '/release/hidden?token=hidden', port: '12000', method: 'post', headers: {authorization: 'secret'}}}},
  status: {conditions: ready}
};
const sensor = {
  apiVersion: 'argoproj.io/v1alpha1', kind: 'Sensor', metadata: {name: 'release-sensor', namespace: 'events'},
  spec: {
    eventBusName: 'default',
    dependencies: [
      {name: 'release', eventSourceName: 'webhook', eventName: 'release', filters: {data: [{path: 'body.token', value: ['hidden']}]}},
      {name: 'approval', eventSourceName: 'webhook', eventName: 'release'}
    ],
    dependencyGroups: {all: ['release', 'approval']},
    triggers: [
      {template: {name: 'deploy', conditions: "release && body.token == 'hidden'", k8s: {source: {resource: {apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {generateName: 'release-'}}}}}},
      {template: {name: 'notify', k8s: {source: {resource: {apiVersion: 'argoproj.io/v1alpha1', kind: 'ConfigMap', metadata: {name: 'notice'}}}}}}
    ]
  },
  status: {conditions: ready, triggers: [{name: 'deploy', status: 'Succeeded'}]}
};

test('normalizes only safe EventSource, Sensor, and EventBus details', () => {
  assert.deepEqual(eventSourceEvents(source), [{type: 'webhook', name: 'release', endpoint: 'Configured', port: 12000, method: 'POST'}]);
  assert.equal(eventSourceSummary(source).eventBusName, 'default');
  assert.deepEqual(sensorSummary(sensor).dependencies, [
    {name: 'release', eventSourceName: 'webhook', eventName: 'release', filters: ['data (1)']},
    {name: 'approval', eventSourceName: 'webhook', eventName: 'release', filters: []}
  ]);
  assert.equal(sensorSummary(sensor).dependencyExpression, 'release && approval');
  assert.equal(sensorSummary({...sensor, spec: {...sensor.spec, dependencyGroups: undefined}}).dependencyExpression, 'release && approval');
  assert.equal(sensorSummary(sensor).eventBusName, 'default');
  assert.equal(sensorSummary({...sensor, spec: {...sensor.spec, dependencyGroups: [{name: 'all', dependencies: ['release', 'approval']}]}}).dependencyExpression, 'release && approval');
  assert.equal(sensorSummary(sensor).triggers[0].conditionExpression, "release && body.token == '[REDACTED]'");
  assert.deepEqual(sensorTriggers(sensor).map(trigger => [trigger.name, trigger.type, trigger.targetApiVersion, trigger.targetKind, trigger.targetGenerateName]), [
    ['deploy', 'k8s', 'argoproj.io/v1alpha1', 'Workflow', 'release-'],
    ['notify', 'k8s', 'argoproj.io/v1alpha1', 'ConfigMap', undefined]
  ]);
  assert.equal(eventBusSummary({metadata: {name: 'default'}, spec: {jetstream: {version: 'latest', token: 'nope'}}}).implementation, 'jetstream');
  assert.equal(safeEventText('Authorization: Bearer abc token=xyz payload: hidden'), 'Authorization=[REDACTED] token=[REDACTED] payload=[REDACTED]');
  assert.equal(safeExpression("release && body == 'private-value'"), "release && body == '[REDACTED]'");
});

test('keeps partial, malformed, and permission-limited resources distinct', () => {
  assert.equal(eventSourceResourceState(), 'loading');
  assert.equal(eventSourceResourceState({manifest: '{broken'}), 'missing');
  assert.equal(eventSourceResourceState({error: {status: 403}}), 'permission');
  assert.equal(sensorResourceState({metadata: {name: 'wrong'}, kind: 'EventSource'}), 'unsupported');
  assert.equal(eventBusResourceState({metadata: {name: 'old', generation: 2}, status: {observedGeneration: 1}}), 'stale');
  assert.deepEqual(eventSourceEvents({spec: {webhook: {bad: 'not-a-config'}, token: 'secret'}}), []);
  assert.equal(eventSourceManifest({metadata: {name: 'outer'}, manifest: JSON.stringify({metadata: {name: 'inner'}})})?.metadata?.name, 'inner');
  assert.equal(eventSourceManifest({metadata: {name: 'outer'}, manifest: '{broken'}), undefined);
  assert.equal(eventSourceResourceState({metadata: {name: 'outer'}, manifest: '{broken'}), 'missing');
});

test('uses explicit controller evidence for every health state', () => {
  assert.equal(eventHealth([{type: 'Ready', status: 'True'}]).state, 'Ready');
  assert.equal(eventHealth([{type: 'Processing', status: 'True'}]).state, 'Active');
  assert.equal(eventHealth([{type: 'Dependencies', status: 'False', message: 'waiting'}]).state, 'Blocked');
  assert.equal(eventHealth([{type: 'Error', status: 'False', message: 'bad token'}]).state, 'Failed');
  assert.equal(eventHealth([{type: 'Error', status: 'True'}]).state, 'Failed');
  assert.equal(eventHealth().state, 'Unknown');
});

test('redacts condition evidence and excludes non-event configuration fields', () => {
  const condition = {type: 'Error', status: 'True', message: 'authorization=super-secret', reason: 'token=also-secret'};
  const evidence = eventHealth([condition]);
  assert.deepEqual(evidence.condition, {
    type: 'Error', status: 'True', message: 'authorization=[REDACTED]', reason: 'token=[REDACTED]', lastTransitionTime: undefined
  });
  assert.notEqual(evidence.condition, condition);
  assert.equal(safeEventText('{"clientSecret":"top-secret","nested":{"apiKey":"also-secret"},"safe":"ok"}'), '{"clientSecret":"[REDACTED]","nested":{"apiKey":"[REDACTED]"},"safe":"ok"}');
  assert.doesNotMatch(eventHealth([{type: 'Error', status: 'True', message: '{"clientSecret":"top-secret"}'}]).reason, /top-secret/);
  assert.deepEqual(eventSourceEvents({spec: {
    service: {ports: [{port: 5555}]},
    arbitrarySecretCarrier: {event: {endpoint: '/leak-me'}},
    webhook: {real: {endpoint: '/private/route', port: '65536'}, numeric: {endpoint: '/also-private', port: '8080'}}
  }}), [
    {type: 'webhook', name: 'numeric', endpoint: 'Configured', port: 8080, method: undefined},
    {type: 'webhook', name: 'real', endpoint: 'Configured', port: undefined, method: undefined}
  ]);
});

test('uses only known trigger implementation keys and redacts template conditions', () => {
  const guarded = structuredClone(sensor);
  guarded.spec.triggers[0].template.conditionsReset = true;
  const trigger = sensorTriggers(guarded)[0];
  assert.equal(trigger.type, 'k8s');
  assert.equal(trigger.conditionExpression, "release && body.token == '[REDACTED]'");
});

test('verifies exact dependency references, including fan-in, but never similar names', () => {
  assert.equal(dependencyCorrelation(sensor, 'release', source).confidence, 'verified');
  assert.equal(dependencyCorrelation(sensor, 'approval', source).confidence, 'verified');
  assert.deepEqual(dependencyCorrelation(sensor, 'release', {...source, metadata: {name: 'webhook-copy'}}), {
    confidence: 'unresolved', dependency: 'release', eventSourceName: 'webhook', eventName: 'release',
    reason: 'EventSource webhook is not available for exact matching'
  });
  assert.match(dependencyCorrelation(sensor, 'release').reason, /not available/);
  assert.match(dependencyCorrelation(sensor, 'release', {...source, metadata: {...source.metadata, namespace: 'other'}}).reason, /different namespace/);
});

test('only links Workflows using direct trigger or controller metadata evidence', () => {
  const generated = {apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {name: 'release-k82pd', namespace: 'events'}, status: {phase: 'Running'}};
  assert.equal(workflowCorrelation(sensor, 'deploy', generated).evidence, 'triggerGeneratedName');
  assert.equal(workflowHealth(generated), 'Active');
  assert.equal(workflowCorrelation(sensor, 'deploy', {metadata: {name: 'release-lookalike', namespace: 'other'}}).confidence, 'unresolved');
  assert.equal(workflowCorrelation(sensor, 'deploy', {metadata: {name: 'unrelated', namespace: 'events'}}).confidence, 'unresolved');

  const named = structuredClone(sensor);
  named.spec.triggers[0].template.k8s.source.resource.metadata = {name: 'exact-workflow'};
  assert.equal(workflowCorrelation(named, 'deploy', {apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {name: 'exact-workflow', namespace: 'events'}}).evidence, 'triggerResourceName');

  const nonArgo = structuredClone(sensor);
  nonArgo.spec.triggers[0].template.k8s.source.resource.apiVersion = 'v1';
  assert.equal(workflowCorrelation(nonArgo, 'deploy', generated).confidence, 'unresolved');

  const tracked = structuredClone(sensor);
  tracked.spec.triggers = [tracked.spec.triggers[0]];
  assert.equal(workflowCorrelation(tracked, 'deploy', {apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {name: 'arbitrary', namespace: 'events', labels: {'events.argoproj.io/sensor': 'release-sensor'}}}).evidence, 'controllerTrackingMetadata');
  assert.equal(workflowCorrelation(sensor, 'deploy', {apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {
    name: 'observed-controller-output', namespace: 'events',
    annotations: {'events.argoproj.io/sensor': 'release-sensor', 'events.argoproj.io/trigger': 'deploy'}
  }}).evidence, 'controllerTrackingMetadata');
});

test('reports trigger error, Workflow absence/running/failure, and fan-out without inventing failures', () => {
  const triggerError = structuredClone(sensor);
  triggerError.status.triggers = [{name: 'deploy', status: 'Failed', message: 'token=do-not-show'}];
  const noWorkflow = correlateEventChain([source], [triggerError], []);
  assert.deepEqual(noWorkflow.firstBlockedHop, {
    kind: 'Trigger', name: 'deploy', state: 'Failed', reason: 'Controller reports Failed: token=[REDACTED]'
  });

  const running = correlateEventChain([source], [sensor], [{apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {name: 'release-live', namespace: 'events'}, status: {phase: 'Running'}}]);
  assert.equal(running.workflows[0].health, 'Active');
  assert.equal(running.firstBlockedHop, undefined);

  const failed = correlateEventChain([source], [sensor], [{apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {name: 'release-live', namespace: 'events'}, status: {phase: 'Failed'}}]);
  assert.deepEqual(failed.firstBlockedHop, {kind: 'Workflow', name: 'release-live', state: 'Failed', reason: 'Workflow is Failed'});

  const fanOut = structuredClone(sensor);
  fanOut.spec.triggers.push({template: {name: 'deploy-two', k8s: {source: {resource: {apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {generateName: 'other-'}}}}}});
  const chain = correlateEventChain([source], [fanOut], [{apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {name: 'release-one', namespace: 'events'}}, {apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {name: 'other-one', namespace: 'events'}}]);
  assert.equal(chain.workflows.filter(edge => edge.confidence === 'verified').length, 2);
});

test('returns the first upstream unknown and ignores unrelated sources', () => {
  const triggerError = structuredClone(sensor);
  triggerError.status.triggers = [{name: 'deploy', status: 'Failed'}];
  const unknownSource = {...source, status: {conditions: []}};
  assert.deepEqual(correlateEventChain([unknownSource], [triggerError], []).firstBlockedHop, {
    kind: 'EventSource', name: 'webhook', state: 'Unknown', reason: 'No controller condition evidence'
  });
  const unrelatedFailure = {...source, metadata: {name: 'unrelated', namespace: 'events'}, status: {conditions: [{type: 'Error', status: 'True'}]}};
  assert.equal(firstBlockedHop([unrelatedFailure, source], [sensor], []), undefined);
  const wrongNamespaceFailure = {...source, metadata: {...source.metadata, namespace: 'other'}, status: {conditions: [{type: 'Error', status: 'True'}]}};
  assert.equal(firstBlockedHop([wrongNamespaceFailure, source], [sensor], []), undefined);
  const unrelatedSensor = {...sensor, metadata: {name: 'other-sensor', namespace: 'events'}, spec: {...sensor.spec, dependencies: [{name: 'other', eventSourceName: 'other-source', eventName: 'event'}]}, status: {conditions: [{type: 'Error', status: 'True'}]}};
  assert.equal(firstBlockedHop([source], [unrelatedSensor, sensor], []), undefined);
});

test('does not call downstream absence failed when the source condition is false or missing', () => {
  const unavailable = {...source, status: {conditions: [{type: 'Deployed', status: 'False', message: 'connection refused'}]}};
  assert.deepEqual(firstBlockedHop([unavailable], [sensor], []), {
    kind: 'EventSource', name: 'webhook', state: 'Blocked', reason: 'Deployed: connection refused'
  });
  assert.deepEqual(firstBlockedHop([], [sensor], []), {
    kind: 'Dependency', name: 'release', state: 'Unknown', reason: 'EventSource webhook is not available for exact matching'
  });
});
