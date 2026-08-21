import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {buildEventChainGraph, EVENT_CHAIN_CARD_LIMIT, EVENT_CHAIN_LIST_LIMIT, filterEventChainGraph, layoutEventChainGraph} from '../src/event-chain-graph.ts';
import {
  applicationEventIdentityPlan,
  buildEventResourceUrl,
  EVENT_CHAIN_FETCH_CONCURRENCY,
  EVENT_CHAIN_MAX_READS,
  eventChainIdentities,
  eventChainIdentityPlan,
  fetchEventChainManifests,
  loadApplicationEventData,
  loadEventChainData
} from '../src/event-chain-loader.ts';

const application = {metadata: {name: 'events-demo', namespace: 'argocd'}, spec: {project: 'platform'}};
const source = {
  apiVersion: 'argoproj.io/v1alpha1', kind: 'EventSource', metadata: {name: 'webhook', namespace: 'events'},
  spec: {webhook: {release: {endpoint: '/release'}}}, status: {conditions: [{type: 'Deployed', status: 'True'}]}
};
const sensor = {
  apiVersion: 'argoproj.io/v1alpha1', kind: 'Sensor', metadata: {name: 'release-sensor', namespace: 'events'},
  spec: {
    dependencies: [{name: 'release', eventSourceName: 'webhook', eventName: 'release'}],
    triggers: [{template: {name: 'deploy', k8s: {source: {resource: {apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {generateName: 'release-'}}}}}}]
  },
  status: {conditions: [{type: 'Deployed', status: 'True'}], triggers: [{name: 'deploy', status: 'Succeeded'}]}
};
const workflow = {
  apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {name: 'release-123', namespace: 'events'},
  status: {phase: 'Running', nodes: {'pod': {id: 'pod', type: 'Pod', phase: 'Running'}}}
};

function node(kind, name, namespace = 'events') {
  return {apiVersion: 'argoproj.io/v1alpha1', kind, name, namespace};
}

test('uses only explicit Application-tree identities and keeps reads bounded', () => {
  const tree = {nodes: [node('EventSource', 'webhook'), ...Array.from({length: 30}, (_, index) => node('Sensor', `sensor-${String(index).padStart(2, '0')}`)), node('Workflow', 'run') ]};
  const identities = eventChainIdentities(tree, {metadata: {name: 'webhook', namespace: 'events'}}, 'EventSource');
  assert.equal(identities.length, EVENT_CHAIN_MAX_READS);
  assert.deepEqual(identities[0], {group: 'argoproj.io', version: 'v1alpha1', kind: 'Sensor', name: 'sensor-00', namespace: 'events', resourceVersion: undefined, labels: undefined, annotations: undefined});
  assert.equal(identities.every(item => item.kind === 'Sensor'), true);
  assert.equal(identities.some(item => item.name === 'webhook'), false);
  assert.equal(identities.some(item => item.name === 'run'), false);
  assert.equal(eventChainIdentities({nodes: [node('Sensor', 'other', 'other')]}, {metadata: {name: 'release-sensor', namespace: 'events'}}, 'Sensor').length, 0);
});

test('does not broaden related reads when the selected namespace is unavailable', () => {
  const plan = eventChainIdentityPlan(
    {nodes: [{apiVersion: 'argoproj.io/v1alpha1', kind: 'Sensor', name: 'other', namespace: 'other'}]},
    {manifest: {apiVersion: 'argoproj.io/v1alpha1', kind: 'EventSource', metadata: {name: 'source'}}},
    'EventSource'
  );
  assert.deepEqual(plan, {identities: [], truncatedCount: 0});
});

test('builds a bounded Application Events plan and preserves verified context when filtering', async () => {
  const plan = applicationEventIdentityPlan({nodes: [node('Workflow', 'release-123'), node('Sensor', 'release-sensor'), node('EventSource', 'webhook'), node('EventBus', 'default')]});
  assert.deepEqual(plan.identities.map(item => item.kind), ['EventBus', 'EventSource', 'Sensor', 'Workflow']);
  const data = await loadApplicationEventData({application, tree: {nodes: plan.identities}, fetcher: async url => {
    const params = new URL(url, 'https://argocd.example').searchParams;
    const kind = params.get('kind');
    const value = kind === 'EventSource' ? source : kind === 'Sensor' ? sensor : kind === 'Workflow' ? workflow : {apiVersion: 'argoproj.io/v1alpha1', kind: 'EventBus', metadata: {name: 'default', namespace: 'events'}};
    return new Response(JSON.stringify(value));
  }});
  assert.equal(data.sources.length, 1);
  assert.equal(data.sensors.length, 1);
  assert.equal(data.buses.length, 1);
  const graph = buildEventChainGraph(data.sources, data.sensors, data.workflows);
  const workflowOnly = filterEventChainGraph(graph, {kind: 'Workflow'});
  assert.equal(workflowOnly.nodes.some(item => item.kind === 'Workflow'), true);
  assert.equal(workflowOnly.nodes.some(item => item.kind === 'EventSource'), true);
  assert.equal(workflowOnly.nodes.some(item => item.kind === 'Pod'), false);
  const fanOut = graph.nodes.find(item => item.kind === 'Sensor' && item.name === 'release-sensor');
  const branch = filterEventChainGraph(graph, {branch: fanOut.id});
  assert.equal(branch.nodes.some(item => item.kind === 'EventSource'), true);
  assert.equal(branch.nodes.some(item => item.kind === 'Trigger'), true);
  assert.equal(branch.nodes.some(item => item.kind === 'Workflow'), true);
});

test('builds same-origin keyed GetResource URLs and never lists a namespace', () => {
  const url = buildEventResourceUrl(application, {group: 'argoproj.io', version: 'v1alpha1', kind: 'Sensor', name: 'release-sensor', namespace: 'events'}, 'https://argocd.example');
  assert.equal(url, 'https://argocd.example/api/v1/applications/events-demo/resource?appNamespace=argocd&project=platform&namespace=events&resourceName=release-sensor&version=v1alpha1&group=argoproj.io&kind=Sensor');
  assert.doesNotMatch(url, /\/api\/v1\/namespaces|limit=|labelSelector=/);
});

test('fetches at most 25 exact manifests with six workers and aborts superseded work', async () => {
  const identities = Array.from({length: EVENT_CHAIN_MAX_READS}, (_, index) => ({group: 'argoproj.io', version: 'v1alpha1', kind: 'Sensor', name: `sensor-${index}`, namespace: 'events'}));
  let active = 0;
  let maximum = 0;
  const result = await fetchEventChainManifests(application, identities, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active -= 1;
    return new Response(JSON.stringify({apiVersion: 'argoproj.io/v1alpha1', kind: 'Sensor', metadata: {name: 'loaded', namespace: 'events'}}));
  });
  assert.equal(result.length, EVENT_CHAIN_MAX_READS);
  assert.ok(maximum <= EVENT_CHAIN_FETCH_CONCURRENCY);

  const controller = new AbortController();
  const pending = fetchEventChainManifests(application, identities, (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true})), '', EVENT_CHAIN_FETCH_CONCURRENCY, controller.signal);
  controller.abort();
  await assert.rejects(pending, /abort/i);
});

test('keeps selected data and parses exact fetched Event resources', async () => {
  const data = await loadEventChainData({
    application,
    tree: {nodes: [node('EventSource', 'webhook'), node('Sensor', 'release-sensor'), node('Workflow', 'release-123')]},
    resource: source,
    kind: 'EventSource',
    fetcher: async url => {
      const kind = new URL(url, 'https://argocd.example').searchParams.get('kind');
      return new Response(JSON.stringify(kind === 'Sensor' ? sensor : kind === 'Workflow' ? workflow : source));
    }
  });
  assert.equal(data.sources.length, 1);
  assert.equal(data.sensors[0].metadata.name, 'release-sensor');
  assert.equal(data.workflows[0].metadata.name, 'release-123');
  assert.equal(data.errors.length, 0);
});

test('does not refetch the selected resource and reports tree authorization failures without requests', async () => {
  let calls = 0;
  const selectedOnly = await loadEventChainData({
    application,
    tree: {nodes: [node('EventSource', 'webhook')]},
    resource: source,
    kind: 'EventSource',
    fetcher: async () => { calls += 1; throw new Error('must not fetch selected resource'); }
  });
  assert.equal(calls, 0);
  assert.equal(selectedOnly.state, 'ready');

  const denied = await loadEventChainData({application, tree: {error: {status: 403, message: 'forbidden'}}, resource: source, kind: 'EventSource', fetcher: async () => { calls += 1; throw new Error('must not fetch tree error'); }});
  assert.equal(denied.state, 'permission');
  assert.equal(denied.permissionDenied, 1);
  assert.equal(calls, 0);

  const unauthenticated = await loadEventChainData({application, tree: {error: {status: 401, message: 'unauthorized'}}, resource: source, kind: 'EventSource', fetcher: async () => { calls += 1; throw new Error('must not fetch tree error'); }});
  assert.equal(unauthenticated.state, 'authentication');
  assert.equal(unauthenticated.authenticationRequired, 1);
});

test('classifies keyed resource response failures and validates every returned identity field', async () => {
  const identities = ['auth', 'permission', 'missing', 'malformed', 'empty', 'wrong-group', 'wrong-version', 'wrong-kind', 'wrong-name', 'wrong-namespace'].map(name => ({group: 'argoproj.io', version: 'v1alpha1', kind: 'Sensor', name, namespace: 'events'}));
  const results = await fetchEventChainManifests(application, identities, async url => {
    const name = new URL(url, 'https://argocd.example').searchParams.get('resourceName');
    if (name === 'auth') return new Response('no', {status: 401});
    if (name === 'permission') return new Response('no', {status: 403});
    if (name === 'missing') return new Response('no', {status: 404});
    if (name === 'malformed') return new Response('{not json');
    if (name === 'empty') return new Response('');
    const manifest = {apiVersion: 'argoproj.io/v1alpha1', kind: 'Sensor', metadata: {name, namespace: 'events'}};
    if (name === 'wrong-group') manifest.apiVersion = 'other.io/v1alpha1';
    if (name === 'wrong-version') manifest.apiVersion = 'argoproj.io/v9';
    if (name === 'wrong-kind') manifest.kind = 'EventSource';
    if (name === 'wrong-name') manifest.metadata.name = 'not-requested';
    if (name === 'wrong-namespace') manifest.metadata.namespace = 'other';
    return new Response(JSON.stringify(manifest));
  });
  assert.deepEqual(results.map(result => result.state), ['authentication', 'permission', 'missing', 'malformed', 'empty', 'malformed', 'malformed', 'malformed', 'malformed', 'malformed']);
});

test('tracks stale manifests and truncation separately from partial reads', async () => {
  const stale = await loadEventChainData({
    application,
    tree: {nodes: [{...node('Sensor', 'release-sensor'), resourceVersion: 'tree-v2'}]},
    resource: source,
    kind: 'EventSource',
    fetcher: async () => new Response(JSON.stringify({...sensor, metadata: {...sensor.metadata, resourceVersion: 'live-v1'}}))
  });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.staleCount, 1);

  const tree = {nodes: [node('EventSource', 'webhook'), ...Array.from({length: 31}, (_, index) => node('Sensor', `sensor-${index}`))]};
  const plan = eventChainIdentityPlan(tree, source, 'EventSource');
  assert.equal(plan.identities.length, EVENT_CHAIN_MAX_READS);
  assert.equal(plan.truncatedCount, 6);
  const truncated = await loadEventChainData({
    application, tree, resource: source, kind: 'EventSource',
    fetcher: async url => {
      const name = new URL(url, 'https://argocd.example').searchParams.get('resourceName');
      return new Response(JSON.stringify({apiVersion: 'argoproj.io/v1alpha1', kind: 'Sensor', metadata: {name, namespace: 'events'}}));
    }
  });
  assert.equal(truncated.state, 'truncated');
  assert.equal(truncated.truncatedCount, 6);
});

test('draws verified dependency and Workflow edges, leaves unresolved relations unconnected, and bounds fallback data', () => {
  const graph = buildEventChainGraph([source], [sensor], [workflow]);
  assert.equal(graph.edges.every(edge => edge.confidence === 'verified'), true);
  assert.equal(graph.edges.some(edge => edge.label === 'release'), true);
  assert.equal(graph.nodes.some(item => item.kind === 'Pod' && item.name === 'pod'), true);
  assert.equal(graph.unresolved.length, 0);
  const layout = layoutEventChainGraph(graph);
  assert.equal(layout.positions.length, graph.nodes.length);
  assert.ok(layout.edges.length >= 4);

  const unresolved = buildEventChainGraph([{...source, spec: {webhook: {different: {endpoint: '/different'}}}}], [sensor], []);
  assert.equal(unresolved.edges.some(edge => edge.label === 'release'), false);
  assert.match(unresolved.unresolved[0].reason, /does not define event/);

  const unavailable = {...source, metadata: {name: 'unavailable', namespace: 'events'}, status: {conditions: [{type: 'Deployed', status: 'False', message: 'EventBus not found'}]}};
  const scoped = buildEventChainGraph([source, unavailable], [sensor], [workflow], {kind: 'EventSource', name: 'unavailable', namespace: 'events'});
  assert.deepEqual(scoped.nodes.map(node => `${node.kind}/${node.name}`), ['EventSource/unavailable']);
  assert.deepEqual(scoped.chain.firstBlockedHop, {kind: 'EventSource', name: 'unavailable', state: 'Blocked', reason: 'Deployed: EventBus not found'});

  const jobSensor = {...sensor, metadata: {name: 'job-sensor', namespace: 'events'}, spec: {...sensor.spec, triggers: [{template: {name: 'denied-job', k8s: {source: {resource: {apiVersion: 'batch/v1', kind: 'Job'}}}}}]}};
  const jobGraph = buildEventChainGraph([source], [jobSensor], [], {kind: 'Sensor', name: 'job-sensor', namespace: 'events'});
  assert.equal(jobGraph.nodes.some(node => node.kind === 'Trigger' && node.name === 'denied-job' && node.state === 'Unknown'), true);
  assert.deepEqual(jobGraph.chain.firstBlockedHop, {kind: 'Trigger', name: 'denied-job', state: 'Unknown', reason: 'Trigger target batch/v1/Job is not an Argo Workflow'});

  const largeSource = {...source, spec: {webhook: Object.fromEntries(Array.from({length: 100}, (_, index) => [`event-${index}`, {endpoint: '/configured'}]))}};
  const largeSensor = {...sensor, spec: {
    dependencies: Array.from({length: 100}, (_, index) => ({name: `dependency-${index}`, eventSourceName: 'webhook', eventName: `event-${index}`})),
    triggers: Array.from({length: 100}, (_, index) => ({template: {name: `trigger-${index}`, k8s: {source: {resource: {apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {generateName: `release-${index}-`}}}}}}))
  }};
  const largeWorkflow = {...workflow, status: {...workflow.status, nodes: Object.fromEntries(Array.from({length: 1000}, (_, index) => [`pod-${index}`, {id: `pod-${index}`, type: 'Pod', phase: 'Running'}]))}};
  const overLimit = buildEventChainGraph([largeSource], [largeSensor], [largeWorkflow]);
  assert.equal(overLimit.truncated, true);
  assert.equal(overLimit.nodes.length, EVENT_CHAIN_CARD_LIMIT + 1);
  assert.ok(overLimit.totalNodeCount >= EVENT_CHAIN_CARD_LIMIT);
  const podHeavy = {...workflow, status: {...workflow.status, nodes: Object.fromEntries(Array.from({length: 1000}, (_, index) => [`pod-${index}`, {id: `pod-${index}`, type: 'Pod', phase: 'Running'}]))}};
  const podGraph = buildEventChainGraph([source], [sensor], [podHeavy]);
  assert.equal(podGraph.truncated, true);
  assert.equal(podGraph.nodes.length, EVENT_CHAIN_CARD_LIMIT + 1);
  const secretPodGraph = buildEventChainGraph([source], [sensor], [{...workflow, status: {...workflow.status, nodes: {pod: {id: 'pod', type: 'Pod', phase: 'Failed', message: '{"clientSecret":"leak"}'}}}}]);
  assert.equal(secretPodGraph.nodes.find(node => node.kind === 'Pod')?.reason, '{"clientSecret":"[REDACTED]"}');
  assert.equal(EVENT_CHAIN_LIST_LIMIT, 40);
});

test('exports a React 16-compatible bounded, keyboard-selectable chain surface', async () => {
  const view = await readFile(new URL('../src/event-chain-view.tsx', import.meta.url), 'utf8');
  assert.match(view, /export function EventChainView/);
  assert.match(view, /AbortController/);
  assert.match(view, /role="button"/);
  assert.match(view, /role="group" aria-label="Verified event chain graph"/);
  assert.doesNotMatch(view, /role="img"/);
  assert.match(view, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(view, /EVENT_CHAIN_CARD_LIMIT/);
  assert.match(view, /EVENT_CHAIN_LIST_LIMIT/);
  assert.match(view, /Connections needing evidence/);
  assert.match(view, /argoResourceHref/);
  assert.match(view, /EventChainData\['state'\]/);
  assert.match(view, /Authentication is required to read related Event resources/);
  assert.match(view, /Only the first bounded related resources are shown/);
  assert.match(view, /event-chain-graph-wrap/);
  assert.match(view, /Fit graph to view|GraphIconButton/);
  assert.match(view, /State: \{node\.state\}/);
  assert.match(view, /Sensor branch/);
  assert.match(view, /role="dialog"/);
  assert.doesNotMatch(view, /setData\(undefined\)/);
  assert.match(view, /event-chain\.query/);
  assert.match(view, /event-chain\.loaded/);
  assert.match(view, /feature: 'event-chain'/);
});
