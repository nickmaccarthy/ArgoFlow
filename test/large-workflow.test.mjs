import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {filterWorkflowNodes, normalizeWorkflowNodes} from '../src/workflow-nodes.ts';
import {
  WORKFLOW_NODE_PAGE_SIZE,
  workflowNodePage
} from '../src/workflow-list.ts';

const [workspace, list] = await Promise.all([
  readFile(new URL('../src/workflow-workspace.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/workflow-nodes-view.tsx', import.meta.url), 'utf8')
]);

function largeWorkflow(count = 1000) {
  const phases = ['Running', 'Succeeded', 'Failed', 'Error', 'Skipped', 'Omitted', 'Unknown'];
  return {status: {nodes: Object.fromEntries(Array.from({length: count}, (_, index) => [
    `node-${index}`,
    {id: `node-${index}`, displayName: `step-${index}`, type: 'Pod', phase: phases[index % phases.length], children: index + 1 < count ? [`node-${index + 1}`] : []}
  ]))}};
}

test('normalizes deterministic 250/1,000/5,000-node fixtures with exact list pages', () => {
  const fixture = largeWorkflow();
  const nodes = normalizeWorkflowNodes(fixture);
  const filtered = filterWorkflowNodes(nodes, 'step-99');
  const page = workflowNodePage(nodes, 9);

  assert.equal(nodes.length, 1000);
  assert.equal(filtered.length, 11);
  assert.equal(WORKFLOW_NODE_PAGE_SIZE, 20);
  assert.equal(page.nodes.length, 20);
  assert.equal(page.nodes[0].id, 'node-180');
  assert.ok(JSON.stringify(fixture).length < 250000);

  const manyNodes = normalizeWorkflowNodes(largeWorkflow(5000));
  for (const size of [10, 20, 50, 100]) assert.equal(workflowNodePage(manyNodes, 0, size).nodes.length, size);
  assert.equal(workflowNodePage(manyNodes, 0, manyNodes.length).nodes.length, manyNodes.length);
  assert.equal(workflowNodePage(manyNodes, 999, 100).current, 49);
});

test('keeps large workflows out of the DAG and offers exact pages plus a dense grid', () => {
  assert.match(workspace, /DAG_NODE_LIMIT = 250/);
  assert.match(workspace, /aria-describedby=\{largeWorkflow \? 'large-workflow-notice'/);
  assert.match(workspace, /orderWorkflowNodesForDisplay/);
  assert.match(workspace, /view === 'dag' && !largeWorkflow/);
  assert.match(workspace, /view === 'grid'/);
  assert.match(list, /visible\.nodes\.map/);
  assert.match(list, /workflowNodePage/);
  assert.match(list, /\[10, 20, 50, 100\]/);
  assert.match(list, /value: 'all'/);
  assert.match(list, /Workflow node status grid/);
  assert.match(list, /wf-status-cell/);
  assert.match(list, /Highlighting.*nodes/);
  assert.match(list, /Show only selected/);
  assert.match(list, /Clear spotlight/);
  assert.match(list, /Clear filters/);
  assert.match(list, /setSpotlightPhases\(\[\]\)/);
  assert.match(list, /Remove \$\{value\} filter/);
  assert.match(list, /selectedPhases\.filter/);
  assert.match(list, /data-tooltip/);
  assert.match(list, /Pending: '#E6A700'.*Unknown: '#52616B'/s);
});
