import type {ResourceMetadata, ResourceState} from './host';
import {workflowTemplateSummary, type WorkflowTemplateManifest, type WorkflowTemplateSummary} from './workflow-template-resource.ts';
import type {WorkflowManifest} from './workflow-resource.ts';

export interface CronWorkflowTemplateRef {
  name?: string;
  clusterScope?: boolean;
}

export interface CronWorkflowWorkflowSpec {
  entrypoint?: string;
  arguments?: {parameters?: Array<{name?: string}>};
  templates?: Array<{
    name?: string;
    inputs?: {parameters?: Array<{name?: string}>};
    dag?: {tasks?: Array<{name?: string; template?: string; templateRef?: {name?: string; template?: string}}>};
    steps?: Array<Array<{name?: string; template?: string; templateRef?: {name?: string; template?: string}}>>;
    container?: unknown;
  }>;
  workflowTemplateRef?: CronWorkflowTemplateRef;
}

export interface CronWorkflowManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: ResourceMetadata;
  spec?: {
    schedule?: string;
    timezone?: string;
    suspend?: boolean;
    concurrencyPolicy?: string;
    startingDeadlineSeconds?: number;
    successfulJobsHistoryLimit?: number;
    failedJobsHistoryLimit?: number;
    workflowSpec?: CronWorkflowWorkflowSpec;
    workflowTemplateRef?: CronWorkflowTemplateRef;
  };
  status?: {
    lastScheduledTime?: string;
    active?: Array<{name?: string; namespace?: string; uid?: string}>;
    observedGeneration?: number;
  };
}

export const CRON_WORKFLOW_DEFAULTS = {
  timezone: 'Controller timezone',
  suspend: false,
  concurrencyPolicy: 'Allow',
  successfulJobsHistoryLimit: 3,
  failedJobsHistoryLimit: 1
} as const;

export type CronWorkflowResourceState = 'loading' | 'missing' | 'unsupported' | 'stale' | 'permission' | 'ready';
export type CronWorkflowTemplateSource = 'embedded' | 'WorkflowTemplate' | 'ClusterWorkflowTemplate' | 'none';

export interface CronWorkflowTemplateContext extends Omit<WorkflowTemplateSummary, 'name' | 'namespace'> {
  source: CronWorkflowTemplateSource;
  reference?: string;
  name?: string;
  namespace?: string;
}

export interface CronWorkflowSummary {
  name?: string;
  namespace?: string;
  schedule?: string;
  timezone: string;
  suspend: boolean;
  concurrencyPolicy: string;
  startingDeadlineSeconds?: number;
  successfulJobsHistoryLimit: number;
  failedJobsHistoryLimit: number;
  lastScheduledTime?: string;
  template: CronWorkflowTemplateContext;
}

export interface CronWorkflowActiveReference {
  name: string;
  namespace?: string;
  uid?: string;
  verifiedBy: 'statusReference';
}

export function cronWorkflowManifest(resource?: ResourceState): CronWorkflowManifest | undefined {
  if (!resource) return undefined;
  if (resource.metadata) return resource as CronWorkflowManifest;

  if (typeof resource.manifest === 'string') {
    try {
      return JSON.parse(resource.manifest) as CronWorkflowManifest;
    } catch {
      return undefined;
    }
  }

  return resource.manifest && typeof resource.manifest === 'object'
    ? (resource.manifest as CronWorkflowManifest)
    : undefined;
}

export function cronWorkflowResourceState(resource?: ResourceState): CronWorkflowResourceState {
  if (!resource) return 'loading';
  const error = typeof resource.error === 'string' ? resource.error : resource.error?.message;
  const status = typeof resource.error === 'string' ? undefined : resource.error?.status;
  if (status === 401 || status === 403 || /forbidden|unauthori[sz]ed|permission denied/i.test(error || '')) return 'permission';

  const cronWorkflow = cronWorkflowManifest(resource);
  if (!cronWorkflow?.metadata?.name) return 'missing';
  if ((cronWorkflow.kind && cronWorkflow.kind !== 'CronWorkflow') || (cronWorkflow.apiVersion && !cronWorkflow.apiVersion.startsWith('argoproj.io/'))) return 'unsupported';
  if (
    typeof cronWorkflow.metadata.generation === 'number' &&
    typeof cronWorkflow.status?.observedGeneration === 'number' &&
    cronWorkflow.status.observedGeneration < cronWorkflow.metadata.generation
  ) return 'stale';
  return 'ready';
}

function templateSummary(template: CronWorkflowWorkflowSpec, metadata?: CronWorkflowManifest['metadata']): WorkflowTemplateSummary {
  return workflowTemplateSummary({metadata, spec: template} as WorkflowTemplateManifest);
}

export function cronWorkflowTemplateContext(cronWorkflow?: CronWorkflowManifest): CronWorkflowTemplateContext {
  const spec = cronWorkflow?.spec;
  const workflowSpec = spec?.workflowSpec;
  const reference = workflowSpec?.workflowTemplateRef ?? spec?.workflowTemplateRef;
  if (reference?.name) {
    return {
      source: reference.clusterScope ? 'ClusterWorkflowTemplate' : 'WorkflowTemplate',
      reference: `${reference.clusterScope ? 'ClusterWorkflowTemplate' : 'WorkflowTemplate'}/${reference.name}`,
      type: 'unknown',
      parameters: [],
      structure: []
    };
  }
  if (workflowSpec) {
    const summary = templateSummary(workflowSpec, cronWorkflow?.metadata);
    return {...summary, source: 'embedded'};
  }
  return {source: 'none', type: 'unknown', parameters: [], structure: []};
}

export function cronWorkflowSummary(cronWorkflow?: CronWorkflowManifest): CronWorkflowSummary {
  const spec = cronWorkflow?.spec;
  return {
    name: cronWorkflow?.metadata?.name,
    namespace: cronWorkflow?.metadata?.namespace,
    schedule: spec?.schedule,
    timezone: spec?.timezone ?? CRON_WORKFLOW_DEFAULTS.timezone,
    suspend: spec?.suspend ?? CRON_WORKFLOW_DEFAULTS.suspend,
    concurrencyPolicy: spec?.concurrencyPolicy ?? CRON_WORKFLOW_DEFAULTS.concurrencyPolicy,
    startingDeadlineSeconds: spec?.startingDeadlineSeconds,
    successfulJobsHistoryLimit: spec?.successfulJobsHistoryLimit ?? CRON_WORKFLOW_DEFAULTS.successfulJobsHistoryLimit,
    failedJobsHistoryLimit: spec?.failedJobsHistoryLimit ?? CRON_WORKFLOW_DEFAULTS.failedJobsHistoryLimit,
    lastScheduledTime: cronWorkflow?.status?.lastScheduledTime,
    template: cronWorkflowTemplateContext(cronWorkflow)
  };
}

export function cronWorkflowActiveReferences(cronWorkflow?: CronWorkflowManifest): CronWorkflowActiveReference[] {
  return (cronWorkflow?.status?.active ?? []).flatMap(reference => reference.name
    ? [{...reference, name: reference.name, verifiedBy: 'statusReference' as const}]
    : []);
}

export type CronWorkflowRunRelation = 'status.active' | 'ownerReference' | 'controllerLabel';

/**
 * Argo labels Workflows started by a CronWorkflow with this controller-owned
 * tracking label. The status and owner-reference branches also cover older
 * controller output without that label.
 */
const CRON_WORKFLOW_LABEL = 'workflows.argoproj.io/cron-workflow';

export function cronWorkflowRunRelation(
  workflow: WorkflowManifest | undefined,
  cronWorkflow: CronWorkflowManifest | undefined
): CronWorkflowRunRelation | undefined {
  const cron = cronWorkflow?.metadata;
  const metadata = workflow?.metadata;
  if (!cron?.name || !metadata?.name || metadata.namespace !== cron.namespace) return undefined;

  const active = cronWorkflow?.status?.active?.some(reference =>
    reference.name === metadata.name &&
    (!reference.namespace || reference.namespace === metadata.namespace) &&
    (!reference.uid || !metadata.uid || reference.uid === metadata.uid)
  );
  if (active) return 'status.active';

  const owned = metadata.ownerReferences?.some(reference =>
    reference.kind === 'CronWorkflow' &&
    reference.name === cron.name &&
    (!reference.uid || !cron.uid || reference.uid === cron.uid)
  );
  if (owned) return 'ownerReference';

  if (metadata.labels?.[CRON_WORKFLOW_LABEL] === cron.name || metadata.annotations?.[CRON_WORKFLOW_LABEL] === cron.name) return 'controllerLabel';
  return undefined;
}
