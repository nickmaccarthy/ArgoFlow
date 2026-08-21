import type {ResourceState} from './host';
import {workflowManifest, type WorkflowManifest} from './workflow-resource.ts';

export interface WorkflowTemplateManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    generation?: number;
  };
  spec?: {
    entrypoint?: string;
    arguments?: {parameters?: Array<{name?: string}>};
    templates?: WorkflowTemplate[];
  };
  status?: {observedGeneration?: number};
}

export interface WorkflowTemplate {
  name?: string;
  inputs?: {parameters?: Array<{name?: string; default?: unknown}>};
  dag?: {tasks?: TemplateReference[]};
  steps?: TemplateReference[][];
  container?: {image?: string; command?: string[]; args?: string[]};
  script?: {image?: string; source?: string};
  suspend?: unknown;
  resource?: unknown;
}

export interface TemplateReference {
  name?: string;
  template?: string;
  templateRef?: {name?: string; template?: string};
  dependencies?: string[];
  depends?: string;
  arguments?: {parameters?: Array<{name?: string; value?: unknown}>};
}

export type WorkflowTemplateResourceState = 'loading' | 'missing' | 'unsupported' | 'stale' | 'permission' | 'ready';
export type WorkflowTemplateType = 'DAG' | 'steps' | 'container' | 'unknown';

export interface WorkflowTemplateSummary {
  name?: string;
  namespace?: string;
  entrypoint?: string;
  type: WorkflowTemplateType;
  parameters: string[];
  structure: Array<{name?: string; reference?: string}>;
}

export interface WorkflowTemplateGraphNode {
  id: string;
  label: string;
  reference?: string;
  type: WorkflowTemplateType | 'script' | 'suspend' | 'resource' | 'external';
  dependencies: string[];
  parameters: string[];
  image?: string;
}

export interface WorkflowTemplateGraph {
  entrypoint?: string;
  nodes: WorkflowTemplateGraphNode[];
}

export function workflowTemplateManifest(resource?: ResourceState): WorkflowTemplateManifest | undefined {
  return workflowManifest(resource) as WorkflowTemplateManifest | undefined;
}

export function workflowTemplateResourceState(resource?: ResourceState): WorkflowTemplateResourceState {
  if (!resource) return 'loading';
  const error = typeof resource.error === 'string' ? resource.error : resource.error?.message;
  const status = typeof resource.error === 'string' ? undefined : resource.error?.status;
  if (status === 401 || status === 403 || /forbidden|unauthori[sz]ed|permission denied/i.test(error || '')) return 'permission';

  const template = workflowTemplateManifest(resource);
  if (!template?.metadata?.name) return 'missing';
  if ((template.kind && template.kind !== 'WorkflowTemplate') || (template.apiVersion && !template.apiVersion.startsWith('argoproj.io/'))) return 'unsupported';
  if (
    typeof template.metadata.generation === 'number' &&
    typeof template.status?.observedGeneration === 'number' &&
    template.status.observedGeneration < template.metadata.generation
  ) return 'stale';
  return 'ready';
}

export function workflowTemplateSummary(template?: WorkflowTemplateManifest): WorkflowTemplateSummary {
  const entrypoint = template?.spec?.entrypoint;
  const entry = template?.spec?.templates?.find(item => item.name === entrypoint);
  const structure = entry?.dag?.tasks ?? entry?.steps?.flat() ?? [];
  const parameters = [
    ...(template?.spec?.arguments?.parameters ?? []),
    ...(entry?.inputs?.parameters ?? [])
  ].map(parameter => parameter.name).filter((name): name is string => Boolean(name));

  return {
    name: template?.metadata?.name,
    namespace: template?.metadata?.namespace,
    entrypoint,
    type: entry?.dag ? 'DAG' : entry?.steps ? 'steps' : entry?.container ? 'container' : 'unknown',
    parameters: [...new Set(parameters)],
    structure: structure.map(item => ({
      name: item.name,
      reference: item.templateRef?.name
        ? `${item.templateRef.name}/${item.templateRef.template || item.template || ''}`.replace(/\/$/, '')
        : item.template
    }))
  };
}

function templateType(template?: WorkflowTemplate): WorkflowTemplateGraphNode['type'] {
  if (template?.dag) return 'DAG';
  if (template?.steps) return 'steps';
  if (template?.container) return 'container';
  if (template?.script) return 'script';
  if (template?.suspend !== undefined) return 'suspend';
  if (template?.resource) return 'resource';
  return 'unknown';
}

function taskDependencies(task: TemplateReference, names: Set<string>): string[] {
  const explicit = task.dependencies ?? [];
  const expression = task.depends?.match(/[A-Za-z0-9_-]+/g)?.filter(token => names.has(token)) ?? [];
  return [...new Set([...explicit, ...expression])];
}

/** Builds a static definition graph. It never presents template nodes as live execution state. */
export function workflowTemplateGraph(template?: WorkflowTemplateManifest): WorkflowTemplateGraph {
  const entrypoint = template?.spec?.entrypoint;
  const templates = template?.spec?.templates ?? [];
  const entry = templates.find(item => item.name === entrypoint);
  if (!entrypoint || !entry) return {entrypoint, nodes: []};

  const rootId = `entrypoint:${entrypoint}`;
  const root: WorkflowTemplateGraphNode = {
    id: rootId,
    label: entrypoint,
    reference: entrypoint,
    type: templateType(entry),
    dependencies: [],
    parameters: entry.inputs?.parameters?.flatMap(parameter => parameter.name ? [parameter.name] : []) ?? [],
    image: entry.container?.image ?? entry.script?.image
  };
  const tasks = entry.dag?.tasks ?? entry.steps?.flat() ?? [];
  if (!tasks.length) return {entrypoint, nodes: [root]};

  const names = new Set(tasks.flatMap(task => task.name ? [task.name] : []));
  const seen = new Map<string, number>();
  const ids = tasks.map((task, index) => {
    const base = task.name || `step-${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}:${count + 1}` : base;
  });
  const firstId = new Map<string, string>();
  tasks.forEach((task, index) => { if (task.name && !firstId.has(task.name)) firstId.set(task.name, ids[index]); });

  let stepOffset = 0;
  let previousStepIds = [rootId];
  const stepDependencies = new Map<number, string[]>();
  for (const group of entry.steps ?? []) {
    const currentIds = ids.slice(stepOffset, stepOffset + group.length);
    group.forEach((_, index) => stepDependencies.set(stepOffset + index, previousStepIds));
    previousStepIds = currentIds;
    stepOffset += group.length;
  }

  const nodes = tasks.map((task, index): WorkflowTemplateGraphNode => {
    const local = task.template ? templates.find(item => item.name === task.template) : undefined;
    const dependencies = entry.dag
      ? taskDependencies(task, names).map(name => firstId.get(name)).filter((id): id is string => Boolean(id))
      : stepDependencies.get(index) ?? [rootId];
    const reference = task.templateRef?.name
      ? `${task.templateRef.name}/${task.templateRef.template || task.template || ''}`.replace(/\/$/, '')
      : task.template;
    return {
      id: ids[index],
      label: task.name || ids[index],
      reference,
      type: task.templateRef?.name ? 'external' : templateType(local),
      dependencies: dependencies.length ? dependencies : [rootId],
      parameters: task.arguments?.parameters?.flatMap(parameter => parameter.name ? [parameter.name] : []) ?? [],
      image: local?.container?.image ?? local?.script?.image
    };
  });
  return {entrypoint, nodes: [root, ...nodes]};
}

/** A namespaced WorkflowTemplate can only be referenced by a Workflow in its own namespace. */
export function isWorkflowTemplateRun(workflow: WorkflowManifest | undefined, template: WorkflowTemplateManifest | undefined): boolean {
  return Boolean(
    workflow?.spec?.workflowTemplateRef?.name &&
    workflow.spec.workflowTemplateRef.clusterScope !== true &&
    workflow.spec.workflowTemplateRef.name === template?.metadata?.name &&
    workflow.metadata?.namespace === template?.metadata?.namespace
  );
}
