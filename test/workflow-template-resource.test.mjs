import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  workflowTemplateManifest,
  workflowTemplateGraph,
  isWorkflowTemplateRun,
  workflowTemplateResourceState,
  workflowTemplateSummary
} from '../src/workflow-template-resource.ts';

const template = {
  apiVersion: 'argoproj.io/v1alpha1',
  kind: 'WorkflowTemplate',
  metadata: {name: 'build', namespace: 'argo'},
  spec: {
    entrypoint: 'pipeline',
    arguments: {parameters: [{name: 'image'}]},
    templates: [{
      name: 'pipeline',
      inputs: {parameters: [{name: 'image'}, {name: 'revision'}]},
      dag: {tasks: [{name: 'compile', template: 'compile'}, {name: 'test', templateRef: {name: 'shared', template: 'test'}}]}
    }]
  }
};

test('summarizes an entrypoint template without run data', () => {
  assert.equal(workflowTemplateManifest({manifest: JSON.stringify(template)})?.metadata?.name, 'build');
  assert.deepEqual(workflowTemplateSummary(template), {
    name: 'build',
    namespace: 'argo',
    entrypoint: 'pipeline',
    type: 'DAG',
    parameters: ['image', 'revision'],
    structure: [
      {name: 'compile', reference: 'compile'},
      {name: 'test', reference: 'shared/test'}
    ]
  });
});

test('builds a static entrypoint graph with task dependencies and definition details', () => {
  const graph = workflowTemplateGraph({
    ...template,
    spec: {
      ...template.spec,
      templates: [
        {...template.spec.templates[0], dag: {tasks: [
          {name: 'compile', template: 'compile', arguments: {parameters: [{name: 'revision'}]}},
          {name: 'test', template: 'test', dependencies: ['compile']}
        ]}},
        {name: 'compile', container: {image: 'golang:1.24'}},
        {name: 'test', script: {image: 'alpine:3', source: 'exit 0'}}
      ]
    }
  });

  assert.deepEqual(graph.nodes.map(node => ({id: node.id, type: node.type, dependencies: node.dependencies, image: node.image})), [
    {id: 'entrypoint:pipeline', type: 'DAG', dependencies: [], image: undefined},
    {id: 'compile', type: 'container', dependencies: ['entrypoint:pipeline'], image: 'golang:1.24'},
    {id: 'test', type: 'script', dependencies: ['compile'], image: 'alpine:3'}
  ]);
});

test('recognizes steps, container, and resilient resource states', () => {
  assert.equal(workflowTemplateSummary({spec: {entrypoint: 'steps', templates: [{name: 'steps', steps: [[]]}]}}).type, 'steps');
  assert.equal(workflowTemplateSummary({spec: {entrypoint: 'container', templates: [{name: 'container', container: {image: 'busybox'}}]}}).type, 'container');
  assert.equal(workflowTemplateResourceState(), 'loading');
  assert.equal(workflowTemplateResourceState({manifest: '{broken'}), 'missing');
  assert.equal(workflowTemplateResourceState({error: {status: 403}}), 'permission');
  assert.equal(workflowTemplateResourceState({metadata: {name: 'other'}, kind: 'Workflow'}), 'unsupported');
  assert.equal(workflowTemplateResourceState({metadata: {name: 'stale', generation: 2}, status: {observedGeneration: 1}}), 'stale');
});

test('accepts only a direct, namespaced WorkflowTemplate reference', () => {
  assert.equal(isWorkflowTemplateRun({metadata: {namespace: 'argo'}, spec: {workflowTemplateRef: {name: 'build'}}}, template), true);
  assert.equal(isWorkflowTemplateRun({metadata: {namespace: 'other'}, spec: {workflowTemplateRef: {name: 'build'}}}, template), false);
  assert.equal(isWorkflowTemplateRun({metadata: {namespace: 'argo'}, spec: {workflowTemplateRef: {name: 'build', clusterScope: true}}}, template), false);
  assert.equal(isWorkflowTemplateRun({metadata: {namespace: 'argo'}, spec: {workflowTemplateRef: {name: 'other'}}}, template), false);
});

test('renders an accessible read-only template definition graph', async () => {
  const [entry, view] = await Promise.all([
    readFile(new URL('../src/index.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workflow-template-view.tsx', import.meta.url), 'utf8')
  ]);

  assert.match(entry, /registerResourceExtension\(WorkflowTemplateTab, 'argoproj\.io', 'WorkflowTemplate', 'WORKFLOW TEMPLATE'\)/);
  assert.match(entry, /WorkflowTemplate view could not be rendered/);
  assert.match(view, /'aria-label': 'WorkflowTemplate definition graph'/);
  assert.match(view, /'aria-label': 'Selected template node details'/);
  assert.match(view, /Static definition only/);
  assert.match(view, /ResourceRelatedRuns/);
  assert.match(view, /React\.useCallback/);
  assert.match(view, /Direct WorkflowTemplate reference/);
  assert.match(view, /workflowTemplateGraph/);
});
