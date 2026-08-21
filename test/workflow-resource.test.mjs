import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORKFLOW_PHASES,
  workflowManifest,
  workflowPhase,
  workflowPhaseColor,
  workflowResourceState,
  workflowSummary
} from '../src/workflow-resource.ts';

test('reads both Argo CD manifest shapes', () => {
  assert.equal(workflowManifest({metadata: {name: 'object'}})?.metadata?.name, 'object');
  assert.equal(
    workflowManifest({manifest: JSON.stringify({metadata: {name: 'string'}})})?.metadata?.name,
    'string'
  );
  assert.equal(workflowManifest({manifest: '{broken'}), undefined);
});

test('distinguishes loading, invalid, permission-limited, stale, and unsupported resources', () => {
  assert.equal(workflowResourceState(), 'loading');
  assert.equal(workflowResourceState({manifest: '{broken'}), 'missing');
  assert.equal(workflowResourceState({error: {status: 403}}), 'permission');
  assert.equal(workflowResourceState({metadata: {name: 'other'}, kind: 'ConfigMap'}), 'unsupported');
  assert.equal(workflowResourceState({metadata: {name: 'stale', generation: 2}, status: {observedGeneration: 1}}), 'stale');
  assert.equal(workflowResourceState({metadata: {name: 'ready'}}), 'ready');
});

test('normalizes complete Workflow summary', () => {
  const summary = workflowSummary(
    {
      metadata: {
        name: 'demo',
        namespace: 'argo',
        creationTimestamp: '2026-08-20T12:00:00Z'
      },
      spec: {workflowTemplateRef: {name: 'build'}},
      status: {
        phase: 'Failed',
        progress: '2/3',
        startedAt: '2026-08-20T12:00:00Z',
        finishedAt: '2026-08-20T12:01:05Z',
        message: 'step failed'
      }
    },
    Date.parse('2026-08-20T13:00:00Z')
  );

  assert.deepEqual(summary, {
    name: 'demo',
    namespace: 'argo',
    phase: 'Failed',
    rawPhase: 'Failed',
    progress: '2/3',
    createdAt: '2026-08-20T12:00:00Z',
    startedAt: '2026-08-20T12:00:00Z',
    finishedAt: '2026-08-20T12:01:05Z',
    duration: '1m 5s',
    templateReference: 'WorkflowTemplate/build',
    message: 'step failed'
  });
});

test('handles active, partial, and unknown Workflow state', () => {
  for (const phase of WORKFLOW_PHASES) assert.equal(workflowPhase(phase), phase);
  assert.equal(workflowPhase('WaitingForPlugin'), 'Unknown');
  assert.equal(
    workflowSummary(
      {status: {phase: 'Running', startedAt: '2026-08-20T12:00:00Z'}},
      Date.parse('2026-08-20T13:02:00Z')
    ).duration,
    '1h 2m'
  );
  assert.equal(workflowSummary({status: {conditions: [{message: 'latest'}]}}).message, 'latest');
});

test('gives every phase a visible status color', () => {
  for (const phase of [...WORKFLOW_PHASES, 'Unknown']) assert.match(workflowPhaseColor(phase), /^#[0-9A-F]{6}$/);
  assert.notEqual(workflowPhaseColor('Running'), workflowPhaseColor('Failed'));
});
