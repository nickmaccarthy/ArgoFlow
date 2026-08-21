import assert from 'node:assert/strict';
import test from 'node:test';

import {layoutWorkflowGraph, WORKFLOW_ARROW_MARKER, WORKFLOW_ARROW_PATH, workflowEdgePath} from '../src/workflow-graph.ts';
import {normalizeWorkflowNodes} from '../src/workflow-nodes.ts';

test('lays dependency children below parents', () => {
  const nodes = normalizeWorkflowNodes({status: {nodes: {
    root: {type: 'DAG', children: ['prepare']},
    prepare: {type: 'Pod', children: ['build']},
    build: {type: 'Pod'}
  }}});
  const layout = layoutWorkflowGraph(nodes);
  const positions = new Map(layout.positions.map(position => [position.id, position]));
  assert.ok(positions.get('root').y < positions.get('prepare').y);
  assert.ok(positions.get('prepare').y < positions.get('build').y);
  assert.deepEqual(layout.edges, [{from: 'root', to: 'prepare'}, {from: 'prepare', to: 'build'}]);
});

test('ignores missing references and still positions cycles', () => {
  const nodes = normalizeWorkflowNodes({status: {nodes: {
    a: {children: ['b', 'missing']},
    b: {children: ['a']}
  }}});
  const layout = layoutWorkflowGraph(nodes);
  assert.equal(layout.positions.length, 2);
  assert.equal(layout.edges.length, 2);
  assert.ok(layout.width > 0);
  assert.ok(layout.height > 0);
});

test('preserves edges when status keys differ from node IDs', () => {
  const nodes = normalizeWorkflowNodes({status: {nodes: {
    'root-key': {id: 'root-id', children: ['child-key']},
    'child-key': {id: 'child-id'}
  }}});
  assert.deepEqual(layoutWorkflowGraph(nodes).edges, [{from: 'root-id', to: 'child-id'}]);
});

test('routes edges as padded curves whose final tangent follows the branch', () => {
  assert.equal(
    workflowEdgePath({id: 'from', x: 0, y: 10}, {id: 'to', x: 220, y: 120}),
    'M 90 82 C 90 91, 246.8 99, 278.2 106.21 L 286 108'
  );
  assert.equal(
    workflowEdgePath({id: 'from', x: 220, y: 10}, {id: 'to', x: 0, y: 120}),
    'M 310 82 C 310 91, 153.2 99, 121.8 106.21 L 114 108'
  );
  assert.equal(
    workflowEdgePath({id: 'from', x: 0, y: 10}, {id: 'to', x: 0, y: 120}),
    'M 90 82 C 90 91, 90 99, 90 100 L 90 108'
  );
  const upwardEdge = workflowEdgePath({id: 'from', x: 0, y: 10}, {id: 'to', x: 220, y: 10});
  assert.doesNotMatch(upwardEdge, /NaN|Infinity/);
  assert.match(upwardEdge, / L 286 -2$/);
});

test('keeps arrowhead geometry fixed and aligned with edge color', () => {
  assert.deepEqual(WORKFLOW_ARROW_MARKER, {
    markerHeight: 8,
    markerUnits: 'userSpaceOnUse',
    markerWidth: 8,
    orient: 'auto',
    overflow: 'visible',
    refX: 8,
    refY: 4,
    viewBox: '0 0 8 8'
  });
  assert.equal(WORKFLOW_ARROW_PATH, 'M 0 0 L 8 4 L 0 8 Z');
});
