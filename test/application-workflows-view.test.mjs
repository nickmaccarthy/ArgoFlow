import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_RUN_FILTERS,
  RUN_AUTO_REFRESH_INTERVAL_MS,
  cursorForApplication,
  decodeRunViewHash,
  filterWorkflowRunRows,
  formatRunAge,
  isActiveWorkflowRun,
  RUN_CURSOR_HASH_KEY,
  RUN_FROM_HASH_KEY,
  RUN_LIFECYCLE_HASH_KEY,
  RUN_QUERY_HASH_KEY,
  RUN_NAMESPACE_HASH_KEY,
  RUN_PHASE_HASH_KEY,
  RUN_SOURCE_HASH_KEY,
  RUN_TO_HASH_KEY,
  shouldAutoRefreshRunPage,
  workflowApplicationKey,
  workflowRunHref,
  workflowRunSourceText
} from '../src/application-workflows-view.ts';
import {pageWorkflowIdentities} from '../src/workflow-runs.ts';
import {parseHashState, serializeHashState} from '../src/url-state.ts';

test('selects a stable, bounded first page of Workflow tree identities', () => {
  const nodes = [
    {group: 'argoproj.io', kind: 'Workflow', namespace: 'demo', name: 'older', createdAt: '2026-08-19T12:00:00Z'},
    {apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow', namespace: 'demo', name: 'newer', createdAt: '2026-08-20T12:00:00Z'},
    {group: 'argoproj.io', kind: 'CronWorkflow', name: 'schedule'},
    {group: 'apps', kind: 'Deployment', name: 'web'},
    ...Array.from({length: 25}, (_, index) => ({group: 'argoproj.io', kind: 'Workflow', name: `run-${index}`}))
  ];

  const workflows = pageWorkflowIdentities(nodes).items;

  assert.equal(workflows.length, 25);
  assert.deepEqual(workflows.slice(0, 2).map(workflow => workflow.name), ['newer', 'older']);
  assert.equal(workflows.some(workflow => workflow.name === 'schedule' || workflow.name === 'web'), false);
});

test('does not carry a page cursor across Applications', () => {
  const first = {metadata: {uid: 'app-a', namespace: 'argocd', name: 'a'}};
  const second = {metadata: {uid: 'app-b', namespace: 'argocd', name: 'b'}};
  const state = {applicationKey: workflowApplicationKey(first), cursor: 'page-two'};

  assert.equal(cursorForApplication(state, workflowApplicationKey(first)), 'page-two');
  assert.equal(cursorForApplication(state, workflowApplicationKey(second)), undefined);
});

const rows = [
  {
    source: 'Live', name: 'payment-1', namespace: 'payments', phase: 'Running', templateReference: 'WorkflowTemplate/payment', startedAt: '2026-08-20T09:00:00Z',
    correlation: {confidence: 'verified', evidence: [], reason: 'tree identity'}, identity: {name: 'payment-1'}
  },
  {
    source: 'Archive', name: 'nightly-1', namespace: 'batch', phase: 'Succeeded', templateReference: 'WorkflowTemplate/nightly', startedAt: '2026-08-18T09:00:00Z', finishedAt: '2026-08-18T09:02:00Z',
    correlation: {confidence: 'verified', evidence: [], reason: 'tree identity'}, identity: {name: 'nightly-1'}
  }
];

test('filters only the supplied bounded rows by status, name/template, namespace, lifecycle, and time', () => {
  assert.equal(filterWorkflowRunRows(rows, {...DEFAULT_RUN_FILTERS, phase: 'Running'}).length, 1);
  assert.equal(filterWorkflowRunRows(rows, {...DEFAULT_RUN_FILTERS, query: 'nightly'}).at(0)?.name, 'nightly-1');
  assert.equal(filterWorkflowRunRows(rows, {...DEFAULT_RUN_FILTERS, namespace: 'payments', lifecycle: 'active', from: '2026-08-20', to: '2026-08-20'}).at(0)?.name, 'payment-1');
  assert.equal(filterWorkflowRunRows(rows, {...DEFAULT_RUN_FILTERS, lifecycle: 'completed'}).at(0)?.name, 'nightly-1');
  assert.equal(isActiveWorkflowRun(rows[0]), true);
  assert.equal(isActiveWorkflowRun(rows[1]), false);
});

test('formats scannable ages and links runs to their Argo CD resource extension', () => {
  assert.equal(formatRunAge('2026-08-20T11:30:00Z', Date.parse('2026-08-20T12:00:00Z')), '30m ago');
  assert.equal(formatRunAge('invalid', Date.now()), '—');
  assert.equal(
    workflowRunHref(rows[0], '/applications/workflows-extension-demo'),
    '/applications/workflows-extension-demo?view=tree&resource=&node=argoproj.io%2FWorkflow%2Fpayments%2Fpayment-1%2F0&tab=extension-0'
  );
});

test('uses explicit source text and native accessible controls in the application runs view', async () => {
  assert.equal(workflowRunSourceText('Live'), 'Live Kubernetes resource');
  assert.equal(workflowRunSourceText('Archive'), 'Archived record');
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/application-workflows-view.ts', import.meta.url), 'utf8'));
  assert.match(source, /aria-label': 'Workflow run source'/);
  assert.match(source, /aria-label': 'Previous Workflow run page'/);
  assert.match(source, /aria-label': 'Next Workflow run page'/);
  assert.match(source, /Filters apply to this page/);
  assert.match(source, /\['Status', 'Workflow', 'Template', 'Started', 'Duration', 'Source'\]/);
  assert.match(source, /className: 'wf-run-link'/);
  assert.doesNotMatch(source, /\['Phase', 'Workflow', 'Template', 'Namespace', 'Started', 'Duration', 'Progress', 'Correlation'/);
  assert.match(source, /const value = event\.currentTarget\.value/);
  assert.match(source, /background: rgb\(16, 15, 15\)/);
  assert.match(source, /React\.createElement\('style', null, WORKFLOW_EXTENSION_STYLES\)/);
  assert.match(source, /loadWorkflowRunPage\(\{application, tree, archive, baseUrl, cursor, fetcher, signal: controller\.signal, source\}\)/);
});

test('auto-refresh ticks only for visible tabs holding active runs on healthy pages', () => {
  assert.equal(shouldAutoRefreshRunPage(rows), true); // rows[0] is Running
  assert.equal(shouldAutoRefreshRunPage([rows[1]]), false);
  assert.equal(shouldAutoRefreshRunPage(rows, true), false);
  assert.equal(shouldAutoRefreshRunPage([], false), false);
  // A refresh failure retains the prior page (with its active rows): polling must stop.
  assert.equal(shouldAutoRefreshRunPage(rows, false, 'boom'), false);
  // Errored, permission-limited, and unavailable pages generate zero traffic.
  assert.equal(shouldAutoRefreshRunPage(rows, false, undefined, 'error'), false);
  assert.equal(shouldAutoRefreshRunPage(rows, false, undefined, 'permission'), false);
  assert.equal(shouldAutoRefreshRunPage(rows, false, undefined, 'unavailable'), false);
  assert.equal(shouldAutoRefreshRunPage(rows, false, undefined, 'ready'), true);
  assert.equal(typeof RUN_AUTO_REFRESH_INTERVAL_MS, 'number');
  assert.ok(RUN_AUTO_REFRESH_INTERVAL_MS >= 5000);
});

test('auto-refresh stands down while a request is loading and reconciles hash navigation', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/application-workflows-view.ts', import.meta.url), 'utf8'));
  // A tick during an in-flight request bumps refreshToken, whose cleanup
  // aborts that request: responses slower than one period would never settle.
  assert.match(source, /if \(!autoRefresh \|\| loading\) return undefined;/);
  assert.match(source, /\}, \[autoRefresh, loading\]\);/);
  // The immediate-refresh bump keys off the hidden state change itself.
  assert.match(source, /if \(wasHidden && !hidden && autoRefresh\) setRefreshToken\(value => value \+ 1\)/);
  assert.doesNotMatch(source, /const onVisible = \(\) =>/);
});

test('hash state re-reads every navigation instead of trusting written hashes', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/url-state.ts', import.meta.url), 'utf8'));
  // Back/forward can return to a hash the hook wrote earlier; the handler must
  // not skip it, and its own replaceState never fires hashchange so no guard
  // is needed against self-writes.
  assert.match(source, /const next = parseHashState\(window\.location\.hash\);/);
  assert.doesNotMatch(source, /writtenRef/);
});

test('run filters and cursors round-trip through namespaced hash state', () => {
  const hash = '#argoflow:runs.source=Archive&argoflow:runs.cursor=c2&argoflow:runs.phase=Running&argoflow:runs.query=pay';
  const state = parseHashState(hash);
  assert.equal(state['runs.source'], 'Archive');
  assert.equal(state['runs.cursor'], 'c2');
  assert.equal(state['runs.phase'], 'Running');
  assert.equal(state['runs.query'], 'pay');
});

test('decodeRunViewHash empty hash returns Live source and DEFAULT_RUN_FILTERS', () => {
  const state = parseHashState('');
  const result = decodeRunViewHash(state);
  assert.equal(result.source, 'Live');
  assert.equal(result.cursor, undefined);
  assert.deepEqual(result.filters, DEFAULT_RUN_FILTERS);
});

test('decodeRunViewHash garbage phase returns empty string', () => {
  const state = parseHashState('#argoflow:runs.phase=zzz');
  const result = decodeRunViewHash(state);
  assert.equal(result.filters.phase, '');
});

test('decodeRunViewHash garbage lifecycle returns all', () => {
  const state = parseHashState('#argoflow:runs.lifecycle=zzz');
  const result = decodeRunViewHash(state);
  assert.equal(result.filters.lifecycle, 'all');
});

test('decodeRunViewHash source Live returns Live', () => {
  const state = parseHashState('#argoflow:runs.source=Live');
  const result = decodeRunViewHash(state);
  assert.equal(result.source, 'Live');
});

test('decodeRunViewHash source Nonsense returns Live', () => {
  const state = parseHashState('#argoflow:runs.source=Nonsense');
  const result = decodeRunViewHash(state);
  assert.equal(result.source, 'Live');
});

test('decodeRunViewHash valid deep link restores all fields end-to-end', () => {
  const serialized = serializeHashState('#', {
    [RUN_SOURCE_HASH_KEY]: 'Archive',
    [RUN_CURSOR_HASH_KEY]: 'c2',
    [RUN_PHASE_HASH_KEY]: 'Running',
    [RUN_QUERY_HASH_KEY]: 'pay',
    [RUN_NAMESPACE_HASH_KEY]: 'payments',
    [RUN_LIFECYCLE_HASH_KEY]: 'active',
    [RUN_FROM_HASH_KEY]: '2026-08-01',
    [RUN_TO_HASH_KEY]: '2026-08-20'
  });
  const state = parseHashState(serialized);
  const result = decodeRunViewHash(state);
  assert.equal(result.source, 'Archive');
  assert.equal(result.cursor, 'c2');
  assert.equal(result.filters.phase, 'Running');
  assert.equal(result.filters.query, 'pay');
  assert.equal(result.filters.namespace, 'payments');
  assert.equal(result.filters.lifecycle, 'active');
  assert.equal(result.filters.from, '2026-08-01');
  assert.equal(result.filters.to, '2026-08-20');
});

test('decodeRunViewHash cursor passthrough', () => {
  // present
  const state1 = parseHashState('#argoflow:runs.cursor=c2');
  assert.equal(decodeRunViewHash(state1).cursor, 'c2');

  // absent
  const state2 = parseHashState('#argoflow:runs.source=Live');
  assert.equal(decodeRunViewHash(state2).cursor, undefined);
});

test('decodeRunViewHash back/forward semantics', () => {
  // Hash A: Archive with cursor and phase
  const hashA = '#argoflow:runs.source=Archive&argoflow:runs.cursor=c1&argoflow:runs.phase=Running&argoflow:runs.query=pay';
  const stateA = parseHashState(hashA);
  const resultA = decodeRunViewHash(stateA);
  assert.equal(resultA.source, 'Archive');
  assert.equal(resultA.cursor, 'c1');
  assert.equal(resultA.filters.phase, 'Running');
  assert.equal(resultA.filters.query, 'pay');

  // Hash B: Live with no cursor/filters
  const hashB = '#argoflow:runs.source=Live';
  const stateB = parseHashState(hashB);
  const resultB = decodeRunViewHash(stateB);
  assert.equal(resultB.source, 'Live');
  assert.equal(resultB.cursor, undefined);
  assert.deepEqual(resultB.filters, DEFAULT_RUN_FILTERS);
});
