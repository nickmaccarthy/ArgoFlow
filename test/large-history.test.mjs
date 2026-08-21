import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RUN_FETCH_CONCURRENCY,
  RUN_PAGE_SIZE,
  loadWorkflowRunPage,
  pageWorkflowIdentities
} from '../src/workflow-runs.ts';

const application = {
  metadata: {name: 'payments', namespace: 'argocd'},
  spec: {project: 'platform', destination: {namespace: 'payments'}}
};

function largeRunTree(count = 5000) {
  return {
    nodes: Array.from({length: count}, (_, index) => ({
      group: 'argoproj.io',
      version: 'v1alpha1',
      kind: 'Workflow',
      namespace: 'payments',
      name: `run-${index}`,
      creationTimestamp: new Date(Date.UTC(2026, 7, 20, 0, 0, index)).toISOString()
    }))
  };
}

test('keeps a 5,000-run history page bounded', async () => {
  const tree = largeRunTree();
  const firstPage = pageWorkflowIdentities(tree);
  let calls = 0;
  let active = 0;
  let maximumActive = 0;

  const page = await loadWorkflowRunPage({
    application,
    tree,
    fetcher: async url => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setImmediate(resolve));
      active -= 1;
      const name = new URL(url, 'https://argocd.example').searchParams.get('resourceName');
      return new Response(JSON.stringify({
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Workflow',
        metadata: {name, namespace: 'payments'},
        status: {phase: 'Succeeded'}
      }));
    }
  });
  const treePayloadBytes = Buffer.byteLength(JSON.stringify(tree));
  const pagePayloadBytes = Buffer.byteLength(JSON.stringify(page));

  assert.equal(firstPage.items.length, RUN_PAGE_SIZE);
  assert.deepEqual(firstPage.items.map(item => item.name), Array.from(
    {length: RUN_PAGE_SIZE},
    (_, index) => `run-${5000 - index - 1}`
  ));
  assert.equal(page.rows.length, RUN_PAGE_SIZE);
  assert.equal(calls, RUN_PAGE_SIZE);
  assert.ok(maximumActive <= RUN_FETCH_CONCURRENCY);
  assert.ok(treePayloadBytes < 1_000_000, `5,000-run tree payload was ${treePayloadBytes} bytes`);
  assert.ok(pagePayloadBytes < 25_000, `first-page payload was ${pagePayloadBytes} bytes`);
});
