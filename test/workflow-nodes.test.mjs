import assert from 'node:assert/strict';
import test from 'node:test';

import {filterWorkflowNodes, normalizeWorkflowNodes, orderWorkflowNodesForDisplay, safeMessage, workflowPodName} from '../src/workflow-nodes.ts';

const workflow = {
  status: {
    nodes: {
      retry: {id: 'retry', name: 'demo.retry', displayName: 'retry', type: 'Retry', phase: 'Failed', children: ['try-1', 'try-2']},
      'try-1': {
        id: 'try-1',
        name: 'demo.retry(0)',
        displayName: 'build',
        type: 'Pod',
        phase: 'Failed',
        message: 'exit code 7',
        startedAt: '2026-08-20T12:00:00Z',
        finishedAt: '2026-08-20T12:00:05Z',
        templateName: 'build',
        inputs: {parameters: [{name: 'token', value: 'must-not-leak'}]},
        outputs: {artifacts: [{name: 'report', s3: {key: 'secret-location'}}]}
      },
      'try-2': {id: 'try-2', name: 'demo.retry(1)', displayName: 'build', type: 'Pod', phase: 'Error'},
      omitted: {id: 'omitted', name: 'demo.publish', displayName: 'publish', type: 'Skipped', phase: 'Omitted'}
    }
  }
};

test('normalizes nodes, retries, duration, and safe metadata', () => {
  const nodes = normalizeWorkflowNodes(workflow, Date.parse('2026-08-20T13:00:00Z'));
  const failed = nodes.find(node => node.id === 'try-1');
  assert.equal(failed.duration, '5s');
  assert.equal(failed.podName, 'try-1');
  assert.equal(failed.retryParentId, 'retry');
  assert.equal(failed.attempts, 2);
  assert.deepEqual(failed.inputs, {parameters: ['token'], artifacts: []});
  assert.deepEqual(failed.outputs, {parameters: [], artifacts: ['report']});
  assert.doesNotMatch(JSON.stringify(failed), /must-not-leak|secret-location/);
  assert.deepEqual(nodes.find(node => node.id === 'retry').retryChildren, ['try-1', 'try-2']);
});

test('resolves Argo v2 Pod names instead of linking the internal node ID', () => {
  assert.equal(workflowPodName({metadata: {name: 'demo', annotations: {'workflows.argoproj.io/pod-name-format': 'v2'}}}, {type: 'Pod', templateName: 'build'}, 'demo-123'), 'demo-build-123');
  assert.equal(workflowPodName({metadata: {name: 'demo'}}, {type: 'Pod', templateName: 'build'}, 'demo-123'), 'demo-123');
  assert.equal(workflowPodName({metadata: {name: 'demo'}}, {type: 'Suspend'}, 'demo-123'), undefined);
});

test('filters nodes by text and normalized phase', () => {
  const nodes = normalizeWorkflowNodes(workflow);
  assert.deepEqual(filterWorkflowNodes(nodes, 'exit', 'Failed').map(node => node.id), ['try-1']);
  assert.deepEqual(filterWorkflowNodes(nodes, 'publish').map(node => node.id), ['omitted']);
  assert.equal(filterWorkflowNodes(nodes, '', 'Error').length, 1);
  assert.deepEqual(filterWorkflowNodes(nodes, '', ['Failed', 'Error']).map(node => node.id), ['retry', 'try-1', 'try-2']);
});

test('orders display nodes by dependencies and uses start time for runnable ties', () => {
  const nodes = normalizeWorkflowNodes({status: {nodes: {
    root: {id: 'root', children: ['late', 'early']},
    late: {id: 'late', startedAt: '2026-08-20T12:02:00Z', outboundNodes: ['join']},
    early: {id: 'early', startedAt: '2026-08-20T12:01:00Z', outboundNodes: ['join']},
    join: {id: 'join', startedAt: '2026-08-20T12:03:00Z'}
  }}});
  assert.deepEqual(orderWorkflowNodesForDisplay(nodes).map(node => node.id), ['root', 'early', 'late', 'join']);
});

test('handles missing node fields without throwing', () => {
  assert.deepEqual(normalizeWorkflowNodes({status: {nodes: {generated: {}}}})[0], {
    id: 'generated',
    name: 'generated',
    displayName: 'generated',
    type: 'Unknown',
    phase: 'Unknown',
    rawPhase: undefined,
    message: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    duration: undefined,
    template: undefined,
    podName: undefined,
    boundaryId: undefined,
    children: [],
    outboundNodes: [],
    retryParentId: undefined,
    retryChildren: [],
    attempts: 1,
    inputs: {parameters: [], artifacts: []},
    outputs: {parameters: [], artifacts: []}
  });
  assert.equal(normalizeWorkflowNodes({status: {nodes: {empty: null}}})[0].phase, 'Unknown');
});

test('handles DAG, steps, nested, skipped, and omitted structures', () => {
  const nodes = normalizeWorkflowNodes({
    status: {
      nodes: {
        root: {id: 'root-id', type: 'DAG', phase: 'Failed', children: ['group'], outboundNodes: ['omitted']},
        group: {type: 'StepGroup', phase: 'Running', boundaryID: 'root-id', children: ['nested']},
        nested: {type: 'Steps', phase: 'Skipped', boundaryID: 'root-id'},
        omitted: {type: 'Skipped', phase: 'Omitted'}
      }
    }
  });
  assert.deepEqual(nodes.map(node => node.phase), ['Failed', 'Running', 'Skipped', 'Omitted']);
  assert.equal(nodes.find(node => node.id === 'group').boundaryId, 'root-id');
  assert.deepEqual(nodes.find(node => node.id === 'root-id').outboundNodes, ['omitted']);
});

test('resolves retry parents when status map keys and node IDs differ', () => {
  const nodes = normalizeWorkflowNodes({
    status: {
      nodes: {
        'map-parent': {id: 'retry-id', type: 'Retry', children: ['attempt-id']},
        'map-attempt': {id: 'attempt-id', type: 'Pod'}
      }
    }
  });
  assert.equal(nodes.find(node => node.id === 'attempt-id').retryParentId, 'retry-id');
  assert.equal(nodes.find(node => node.id === 'attempt-id').attempts, 1);
});

test('redacts common credentials and bounds controller messages', () => {
  assert.equal(safeMessage('token=abc password: hunter2 Bearer xyz'), 'token=[REDACTED] password=[REDACTED] Bearer [REDACTED]');
  assert.equal(safeMessage('x'.repeat(600)).length, 500);
});
