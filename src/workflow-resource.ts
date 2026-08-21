import type {ResourceMetadata, ResourceState} from './host';

export const WORKFLOW_PHASES = [
  'Pending',
  'Running',
  'Succeeded',
  'Failed',
  'Error',
  'Skipped',
  'Omitted'
] as const;

export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number] | 'Unknown';

export interface WorkflowManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: ResourceMetadata & {creationTimestamp?: string};
  spec?: {
    workflowTemplateRef?: {name?: string; clusterScope?: boolean};
  };
  status?: {
    phase?: string;
    progress?: string;
    startedAt?: string;
    finishedAt?: string;
    message?: string;
    conditions?: Array<{message?: string}>;
    observedGeneration?: number;
    nodes?: Record<string, WorkflowNodeStatus | null | undefined>;
  };
}

export interface WorkflowNodeStatus {
  id?: string;
  name?: string;
  displayName?: string;
  type?: string;
  phase?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  templateName?: string;
  templateRef?: {name?: string; template?: string};
  boundaryID?: string;
  children?: string[];
  outboundNodes?: string[];
  hostNodeName?: string;
  inputs?: WorkflowIo;
  outputs?: WorkflowIo;
}

export interface WorkflowIo {
  parameters?: Array<{name?: string}>;
  artifacts?: Array<{name?: string}>;
}

export interface WorkflowSummary {
  name?: string;
  namespace?: string;
  phase: WorkflowPhase;
  rawPhase?: string;
  progress?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  duration?: string;
  templateReference?: string;
  message?: string;
}

export type WorkflowResourceState = 'loading' | 'missing' | 'unsupported' | 'stale' | 'permission' | 'ready';

export function workflowManifest(resource?: ResourceState): WorkflowManifest | undefined {
  if (!resource) return undefined;
  if (resource.metadata) return resource;

  if (typeof resource.manifest === 'string') {
    try {
      return JSON.parse(resource.manifest) as WorkflowManifest;
    } catch {
      return undefined;
    }
  }

  return resource.manifest && typeof resource.manifest === 'object'
    ? (resource.manifest as WorkflowManifest)
    : undefined;
}

export function workflowResourceState(resource?: ResourceState): WorkflowResourceState {
  if (!resource) return 'loading';
  const error = typeof resource.error === 'string' ? resource.error : resource.error?.message;
  const status = typeof resource.error === 'string' ? undefined : resource.error?.status;
  if (status === 401 || status === 403 || /forbidden|unauthori[sz]ed|permission denied/i.test(error || '')) return 'permission';

  const workflow = workflowManifest(resource);
  if (!workflow?.metadata?.name) return 'missing';
  if ((workflow.kind && workflow.kind !== 'Workflow') || (workflow.apiVersion && !workflow.apiVersion.startsWith('argoproj.io/'))) return 'unsupported';
  if (
    typeof workflow.metadata.generation === 'number' &&
    typeof workflow.status?.observedGeneration === 'number' &&
    workflow.status.observedGeneration < workflow.metadata.generation
  ) return 'stale';
  return 'ready';
}

export function workflowPhase(value?: string): WorkflowPhase {
  return WORKFLOW_PHASES.includes(value as (typeof WORKFLOW_PHASES)[number])
    ? (value as WorkflowPhase)
    : 'Unknown';
}

export function workflowPhaseColor(phase: WorkflowPhase): string {
  if (phase === 'Running') return '#0DADEA';
  if (phase === 'Succeeded') return '#18BE94';
  if (phase === 'Failed' || phase === 'Error') return '#E96D76';
  return '#6D7F8B';
}

export function workflowSummary(workflow?: WorkflowManifest, now = Date.now()): WorkflowSummary {
  const status = workflow?.status;
  const rawPhase = status?.phase;
  const template = workflow?.spec?.workflowTemplateRef;

  return {
    name: workflow?.metadata?.name,
    namespace: workflow?.metadata?.namespace,
    phase: workflowPhase(rawPhase),
    rawPhase,
    progress: status?.progress,
    createdAt: workflow?.metadata?.creationTimestamp,
    startedAt: status?.startedAt,
    finishedAt: status?.finishedAt,
    duration: formatDuration(status?.startedAt, status?.finishedAt, now),
    templateReference: template?.name
      ? `${template.clusterScope ? 'ClusterWorkflowTemplate' : 'WorkflowTemplate'}/${template.name}`
      : undefined,
    message: status?.message ?? [...(status?.conditions ?? [])].reverse().find(condition => condition.message)?.message
  };
}

export function formatDuration(start?: string, finish?: string, now = Date.now()): string | undefined {
  if (!start) return undefined;
  const startMs = Date.parse(start);
  const finishMs = finish ? Date.parse(finish) : now;
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs < startMs) return undefined;

  const seconds = Math.floor((finishMs - startMs) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
