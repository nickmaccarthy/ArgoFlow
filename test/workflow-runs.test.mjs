import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RUN_FETCH_CONCURRENCY,
  RUN_PAGE_SIZE,
  archiveUnavailable,
  buildWorkflowResourceUrl,
  correlateWorkflow,
  fetchWorkflowManifests,
  loadWorkflowRunPage,
  pageWorkflowIdentities,
  workflowTreeIdentities
} from '../src/workflow-runs.ts';

const application = {metadata: {name: 'payments', namespace: 'argocd'}, spec: {project: 'platform', destination: {namespace: 'payments'}}};

function identity(index, timestamp = `2026-08-20T00:${String(index).padStart(2, '0')}:00Z`) {
  return {group: 'argoproj.io', version: 'v1alpha1', kind: 'Workflow', name: `run-${index}`, namespace: 'payments', creationTimestamp: timestamp};
}

test('discovers Workflow identities present only in orphaned Application tree nodes', () => {
  const identities = workflowTreeIdentities({
    nodes: [],
    orphanedNodes: [identity(1)]
  });

  assert.deepEqual(identities.map(item => item.name), ['run-1']);
});

test('deduplicates a Workflow identity present in managed and orphaned tree nodes', () => {
  const duplicate = {...identity(2), uid: 'workflow-uid-2'};
  const identities = workflowTreeIdentities({
    nodes: [duplicate],
    orphanedNodes: [{...duplicate}, {...identity(5), uid: 'workflow-uid-5'}]
  });

  assert.deepEqual(identities.map(item => [item.namespace, item.name, item.uid]), [
    ['payments', 'run-5', 'workflow-uid-5'],
    ['payments', 'run-2', 'workflow-uid-2']
  ]);
});

test('keeps managed tree node and bare-array Workflow discovery unchanged', () => {
  const managedNodes = [
    identity(3),
    {group: '', version: 'v1', kind: 'Service', name: 'payments', namespace: 'payments'}
  ];

  assert.deepEqual(workflowTreeIdentities({nodes: managedNodes}).map(item => item.name), ['run-3']);
  assert.deepEqual(workflowTreeIdentities(managedNodes).map(item => item.name), ['run-3']);
});

test('pages Workflow tree identities newest first with stable next and previous cursors', () => {
  const tree = {nodes: Array.from({length: 51}, (_, index) => identity(index))};
  const first = pageWorkflowIdentities(tree);
  assert.equal(first.items.length, RUN_PAGE_SIZE);
  assert.equal(first.items[0].name, 'run-50');
  assert.ok(first.nextCursor);

  const second = pageWorkflowIdentities(tree, {cursor: first.nextCursor});
  assert.equal(second.items.length, RUN_PAGE_SIZE);
  assert.equal(second.items[0].name, 'run-25');
  assert.ok(second.previousCursor);
  assert.deepEqual(pageWorkflowIdentities(tree, {cursor: second.previousCursor}).items.map(item => item.name), first.items.map(item => item.name));
  const third = pageWorkflowIdentities(tree, {cursor: second.nextCursor});
  assert.equal(third.items[0].name, 'run-0');
  assert.deepEqual(pageWorkflowIdentities(tree, {cursor: third.previousCursor}).items.map(item => item.name), second.items.map(item => item.name));

  tree.nodes.push(identity(99, '2026-08-21T00:00:00Z'));
  assert.equal(pageWorkflowIdentities(tree, {cursor: first.nextCursor}).items[0].name, 'run-25');
});

test('builds same-origin GetResource URLs with Application namespace and project', () => {
  const url = buildWorkflowResourceUrl(application, identity(1), 'https://argocd.example');
  assert.equal(url, 'https://argocd.example/api/v1/applications/payments/resource?appNamespace=argocd&project=platform&namespace=payments&resourceName=run-1&version=v1alpha1&group=argoproj.io&kind=Workflow');
  assert.equal(buildWorkflowResourceUrl(application, identity(1)).startsWith('/api/v1/applications/'), true);
});

test('fetches only the selected identities and never exceeds six concurrent requests', async () => {
  const selected = Array.from({length: RUN_PAGE_SIZE}, (_, index) => identity(index));
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const fetched = await fetchWorkflowManifests(application, selected, async () => {
    calls += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active -= 1;
    return new Response(JSON.stringify({apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {name: 'loaded', namespace: 'payments'}, status: {phase: 'Succeeded'}}), {status: 200});
  });
  assert.equal(calls, RUN_PAGE_SIZE);
  assert.ok(maximum <= RUN_FETCH_CONCURRENCY);
  assert.equal(fetched.length, RUN_PAGE_SIZE);
  assert.equal(fetched.every(item => item.manifest?.kind === 'Workflow'), true);
});

test('aborts superseded manifest workers before another page starts', async () => {
  const controller = new AbortController();
  const identities = Array.from({length: 25}, (_, index) => ({name: `run-${index}`, namespace: 'payments'}));
  let active = 0;
  let maximumActive = 0;
  const fetcher = (_url, init) => new Promise((_resolve, reject) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    init.signal.addEventListener('abort', () => {
      active -= 1;
      reject(new DOMException('Aborted', 'AbortError'));
    }, {once: true});
  });

  const first = fetchWorkflowManifests(application, identities, fetcher, '', RUN_FETCH_CONCURRENCY, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(first, /abort/i);

  await fetchWorkflowManifests(application, identities.slice(0, 2), async url => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    active -= 1;
    const name = new URL(url, 'https://argocd.example').searchParams.get('resourceName');
    return new Response(JSON.stringify({apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {name, namespace: 'payments'}}));
  });
  assert.equal(active, 0);
  assert.ok(maximumActive <= RUN_FETCH_CONCURRENCY);
});

test('correlation requires direct evidence; namespace alone remains unresolved', () => {
  const namespaceOnly = correlateWorkflow({metadata: {name: 'foreign', namespace: 'payments'}}, application);
  assert.equal(namespaceOnly.confidence, 'unresolved');
  assert.match(namespaceOnly.reason, /namespace alone/i);

  const tracked = correlateWorkflow({metadata: {name: 'run-1', namespace: 'payments', labels: {'argocd.argoproj.io/instance': 'payments'}}}, application);
  assert.equal(tracked.confidence, 'verified');

  const inferred = correlateWorkflow({metadata: {name: 'run-1', namespace: 'payments'}, spec: {workflowTemplateRef: {name: 'nightly'}}}, application);
  assert.equal(inferred.confidence, 'inferred');
});

test('live pages omit unresolved runs by default and expose archive unavailability', async () => {
  const page = await loadWorkflowRunPage({
    application,
    tree: {nodes: [identity(1)]},
    fetcher: async () => new Response(JSON.stringify({apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', metadata: {name: 'foreign', namespace: 'payments'}}), {status: 200})
  });
  assert.equal(page.rows.length, 0);
  assert.equal(page.excluded.length, 1);
  assert.match(page.excluded[0].reason, /namespace alone/i);

  const archive = await loadWorkflowRunPage({application, source: 'Archive'});
  assert.equal(archive.state, 'unavailable');
  assert.deepEqual(archive.capability.archive, archiveUnavailable());
});

test('loads an inferred Workflow discovered from orphaned Application tree nodes', async () => {
  const page = await loadWorkflowRunPage({
    application,
    tree: {
      nodes: [],
      orphanedNodes: [{
        ...identity(4),
        namespace: undefined,
        labels: {'workflows.argoproj.io/workflow-template': 'nightly'}
      }]
    },
    fetcher: async () => new Response(JSON.stringify({
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Workflow',
      metadata: {name: 'run-4', namespace: 'payments'},
      status: {phase: 'Succeeded'}
    }), {status: 200})
  });

  assert.equal(page.state, 'ready');
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].identity.name, 'run-4');
  assert.equal(page.rows[0].correlation.confidence, 'inferred');
});

test('classifies an all-page 401/403 as permission denied instead of empty or generic error', async () => {
  const page = await loadWorkflowRunPage({
    application,
    tree: {nodes: [identity(1), identity(2)]},
    fetcher: async () => new Response('forbidden', {status: 403})
  });

  assert.equal(page.state, 'permission');
  assert.equal(page.rows.length, 0);
  assert.equal(page.permissionDenied, 2);
});

test('keeps mixed permission failures partial and reports the inaccessible rows', async () => {
  const page = await loadWorkflowRunPage({
    application,
    tree: {nodes: [identity(1), identity(2)]},
    fetcher: async url => new URL(url, 'https://same-origin.invalid').searchParams.get('resourceName') === 'run-1'
      ? new Response('forbidden', {status: 403})
      : new Response(JSON.stringify({
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Workflow',
        metadata: {name: 'run-2', namespace: 'payments'},
        status: {phase: 'Succeeded'}
      }), {status: 200})
  });

  assert.equal(page.state, 'partial');
  assert.equal(page.permissionDenied, 1);
  assert.equal(page.rows.length, 1);
});

test('marks a live row stale when its shallow tree resourceVersion differs', async () => {
  const page = await loadWorkflowRunPage({
    application,
    tree: {nodes: [{...identity(1), resourceVersion: '10'}]},
    fetcher: async () => new Response(JSON.stringify({
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Workflow',
      metadata: {name: 'run-1', namespace: 'payments', resourceVersion: '9'},
      status: {phase: 'Running'}
    }), {status: 200})
  });

  assert.equal(page.state, 'stale');
  assert.equal(page.staleCount, 1);
  assert.equal(page.rows[0].stale, true);
});

test('classifies a tree-level permission error before treating the tree as empty', async () => {
  const page = await loadWorkflowRunPage({
    application,
    tree: {nodes: [], error: {status: 401, message: 'Unauthorized'}},
    fetcher: async () => { throw new Error('must not fetch without tree access'); }
  });

  assert.equal(page.state, 'permission');
  assert.equal(page.rows.length, 0);
  assert.equal(page.permissionDenied, 1);
});
