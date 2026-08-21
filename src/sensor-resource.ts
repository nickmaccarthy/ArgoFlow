import type {ResourceState} from './host';
import {
  eventHealth,
  eventManifest,
  eventResourceState,
  isRecord,
  safeEventText,
  safeExpression,
  type EventCondition,
  type EventHealthEvidence,
  type EventResourceState
} from './event-resource.ts';

export interface SensorDependency {
  name?: string;
  eventSourceName?: string;
  eventName?: string;
  filters?: Record<string, unknown>;
}

export interface SensorTrigger {
  template?: {
    name?: string;
    conditions?: string;
    k8s?: {source?: {resource?: TriggerResource}};
    argoWorkflow?: {source?: {resource?: TriggerResource}};
    [kind: string]: unknown;
  };
  policy?: unknown;
}

export interface TriggerResource {
  apiVersion?: string;
  kind?: string;
  metadata?: {name?: string; generateName?: string; namespace?: string};
}

export interface SensorManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: {name?: string; namespace?: string; generation?: number; uid?: string};
  spec?: {eventBusName?: string; dependencies?: SensorDependency[]; triggers?: SensorTrigger[]; dependencyGroups?: unknown};
  status?: {
    observedGeneration?: number;
    conditions?: EventCondition[];
    phase?: string;
    status?: string;
    triggers?: Array<{name?: string; status?: string; phase?: string; message?: string; conditions?: EventCondition[]}>;
  };
}

export interface SensorDependencySummary {
  name: string;
  eventSourceName?: string;
  eventName?: string;
  filters: string[];
}

export interface SensorTriggerSummary {
  name: string;
  type: string;
  targetKind?: string;
  targetApiVersion?: string;
  targetName?: string;
  targetGenerateName?: string;
  conditionExpression?: string;
  hasPolicy: boolean;
  health: EventHealthEvidence;
}

export interface SensorSummary {
  name?: string;
  namespace?: string;
  eventBusName?: string;
  dependencies: SensorDependencySummary[];
  dependencyExpression?: string;
  triggers: SensorTriggerSummary[];
  health: EventHealthEvidence;
}

export function sensorManifest(resource?: ResourceState): SensorManifest | undefined {
  return eventManifest(resource) as SensorManifest | undefined;
}

export function sensorResourceState(resource?: ResourceState): EventResourceState {
  return eventResourceState(resource, 'Sensor');
}

export function sensorSummary(sensor?: SensorManifest): SensorSummary {
  return {
    name: sensor?.metadata?.name,
    namespace: sensor?.metadata?.namespace,
    eventBusName: sensor?.spec?.eventBusName,
    dependencies: sensorDependencies(sensor),
    dependencyExpression: sensorDependencyExpression(sensor),
    triggers: sensorTriggers(sensor),
    health: eventHealth(sensor?.status?.conditions, sensor?.status?.phase ?? sensor?.status?.status)
  };
}

export function sensorDependencies(sensor?: SensorManifest): SensorDependencySummary[] {
  return (sensor?.spec?.dependencies ?? []).flatMap((dependency, index) => dependency && typeof dependency === 'object'
    ? [{
      name: dependency.name || `dependency-${index + 1}`,
      eventSourceName: dependency.eventSourceName,
      eventName: dependency.eventName,
      filters: Object.entries(dependency.filters ?? {})
        .filter(([, value]) => Array.isArray(value) || isRecord(value))
        .map(([type, value]) => `${type} (${Array.isArray(value) ? value.length : 1})`)
        .sort()
    }]
    : []);
}

/** A group is an AND of exact dependency names; multiple groups are alternatives. */
export function sensorDependencyExpression(sensor?: SensorManifest): string | undefined {
  const groups = sensor?.spec?.dependencyGroups;
  const grouped = Array.isArray(groups)
    ? groups.flatMap(group => isRecord(group) && Array.isArray(group.dependencies)
      ? [group.dependencies.filter((name): name is string => typeof name === 'string').join(' && ')]
      : [])
    : isRecord(groups)
      ? Object.values(groups).flatMap(value => Array.isArray(value)
        ? [value.filter((name): name is string => typeof name === 'string').join(' && ')]
        : [])
      : [];
  return safeExpression((grouped.length ? grouped : sensorDependencies(sensor).map(dependency => dependency.name)).filter(Boolean).join(grouped.length ? ' || ' : ' && '));
}

export function sensorTriggers(sensor?: SensorManifest): SensorTriggerSummary[] {
  const statuses = new Map((sensor?.status?.triggers ?? []).flatMap(status => status.name ? [[status.name, status] as const] : []));
  return (sensor?.spec?.triggers ?? []).flatMap((trigger, index) => {
    const template = trigger?.template;
    if (!template || !isRecord(template)) return [];
    const name = typeof template.name === 'string' ? template.name : `trigger-${index + 1}`;
    const type = TRIGGER_TEMPLATE_TYPES.find(candidate => isRecord(template[candidate]));
    const implementation = type && isRecord(template[type]) ? template[type] as Record<string, unknown> : undefined;
    const source = implementation && isRecord(implementation.source) && isRecord(implementation.source.resource)
      ? implementation.source.resource as TriggerResource
      : undefined;
    const status = statuses.get(name);
    const health = eventHealth(status?.conditions, status?.phase ?? status?.status);
    const message = safeEventText(status?.message);
    return [{
      name,
      type: type || 'unknown',
      targetKind: source?.kind,
      targetApiVersion: source?.apiVersion,
      targetName: source?.metadata?.name,
      targetGenerateName: source?.metadata?.generateName,
      conditionExpression: safeExpression(template.conditions),
      hasPolicy: trigger.policy !== undefined,
      health: message && health.state !== 'Ready' ? {...health, reason: `${health.reason}: ${message}`} : health
    }];
  });
}

/** Argo Events v1.9.11 trigger implementations; control fields such as conditionsReset are not targets. */
export const TRIGGER_TEMPLATE_TYPES = [
  'argoWorkflow', 'awsLambda', 'azureEventHubs', 'custom', 'http', 'k8s', 'kafka', 'log', 'nack', 'openWhisk',
  'pulsar', 'slack', 'sns', 'sqs'
] as const;
