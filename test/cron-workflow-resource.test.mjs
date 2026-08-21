import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  cronWorkflowActiveReferences,
  cronWorkflowManifest,
  cronWorkflowRunRelation,
  cronWorkflowResourceState,
  cronWorkflowSummary
} from '../src/cron-workflow-resource.ts';

const cronWorkflow = {
  apiVersion: 'argoproj.io/v1alpha1',
  kind: 'CronWorkflow',
  metadata: {name: 'nightly', namespace: 'argo'},
  spec: {
    schedule: '0 2 * * *',
    timezone: 'America/New_York',
    suspend: true,
    concurrencyPolicy: 'Forbid',
    startingDeadlineSeconds: 120,
    successfulJobsHistoryLimit: 5,
    failedJobsHistoryLimit: 2,
    workflowSpec: {
      entrypoint: 'pipeline',
      arguments: {parameters: [{name: 'revision'}]},
      templates: [{name: 'pipeline', dag: {tasks: [{name: 'build', template: 'build'}]}}]
    }
  },
  status: {
    lastScheduledTime: '2026-08-20T02:00:00Z',
    active: [{name: 'nightly-123', namespace: 'argo'}]
  }
};

test('normalizes schedule, template context, and complete CronWorkflow fields', () => {
  assert.equal(cronWorkflowManifest({manifest: JSON.stringify(cronWorkflow)})?.metadata?.name, 'nightly');
  assert.deepEqual(cronWorkflowSummary(cronWorkflow), {
    name: 'nightly',
    namespace: 'argo',
    schedule: '0 2 * * *',
    timezone: 'America/New_York',
    suspend: true,
    concurrencyPolicy: 'Forbid',
    startingDeadlineSeconds: 120,
    successfulJobsHistoryLimit: 5,
    failedJobsHistoryLimit: 2,
    lastScheduledTime: '2026-08-20T02:00:00Z',
    template: {
      source: 'embedded',
      name: 'nightly',
      namespace: 'argo',
      entrypoint: 'pipeline',
      type: 'DAG',
      parameters: ['revision'],
      structure: [{name: 'build', reference: 'build'}]
    }
  });
});

test('uses controller-safe defaults and resilient resource states', () => {
  const summary = cronWorkflowSummary({metadata: {name: 'defaults'}});
  assert.equal(summary.timezone, 'Controller timezone');
  assert.equal(summary.suspend, false);
  assert.equal(summary.concurrencyPolicy, 'Allow');
  assert.equal(summary.startingDeadlineSeconds, undefined);
  assert.equal(summary.successfulJobsHistoryLimit, 3);
  assert.equal(summary.failedJobsHistoryLimit, 1);
  assert.equal(cronWorkflowResourceState(), 'loading');
  assert.equal(cronWorkflowResourceState({manifest: '{broken'}), 'missing');
  assert.equal(cronWorkflowResourceState({error: {status: 403}}), 'permission');
  assert.equal(cronWorkflowResourceState({metadata: {name: 'other'}, kind: 'Workflow'}), 'unsupported');
  assert.equal(cronWorkflowResourceState({metadata: {name: 'stale', generation: 2}, status: {observedGeneration: 1}}), 'stale');
  assert.equal(cronWorkflowResourceState({metadata: {name: 'ready'}}), 'ready');
});

test('only exposes exact active references as verified children context', () => {
  assert.deepEqual(cronWorkflowActiveReferences(cronWorkflow), [{
    name: 'nightly-123',
    namespace: 'argo',
    verifiedBy: 'statusReference'
  }]);
  assert.deepEqual(cronWorkflowActiveReferences({metadata: {name: 'empty'}}), []);
});

test('recognizes only direct CronWorkflow child evidence', () => {
  const parent = {...cronWorkflow, metadata: {...cronWorkflow.metadata, uid: 'cron-uid'}};
  assert.equal(cronWorkflowRunRelation({metadata: {name: 'nightly-123', namespace: 'argo'}}, parent), 'status.active');
  assert.equal(cronWorkflowRunRelation({metadata: {name: 'owned', namespace: 'argo', ownerReferences: [{kind: 'CronWorkflow', name: 'nightly', uid: 'cron-uid'}]}}, parent), 'ownerReference');
  assert.equal(cronWorkflowRunRelation({metadata: {name: 'tracked', namespace: 'argo', labels: {'workflows.argoproj.io/cron-workflow': 'nightly'}}}, parent), 'controllerLabel');
  assert.equal(cronWorkflowRunRelation({metadata: {name: 'same-namespace', namespace: 'argo'}}, parent), undefined);
  assert.equal(cronWorkflowRunRelation({metadata: {name: 'tracked', namespace: 'other', labels: {'workflows.argoproj.io/cron-workflow': 'nightly'}}}, parent), undefined);
});

test('registers a read-only CronWorkflow tab and truthful child state', async () => {
  const [entry, view] = await Promise.all([
    readFile(new URL('../src/index.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/cron-workflow-view.tsx', import.meta.url), 'utf8')
  ]);
  assert.match(entry, /registerResourceExtension\(CronWorkflowTab, 'argoproj\.io', 'CronWorkflow', 'CRON WORKFLOW'\)/);
  assert.match(entry, /CronWorkflow view could not be rendered/);
  assert.match(view, /ResourceRelatedRuns/);
  assert.match(view, /React\.useCallback/);
  assert.match(view, /cronWorkflowRunRelation/);
  assert.match(view, /Active Workflow references/);
  assert.doesNotMatch(view, /<button|React\.createElement\('button'/);
});
