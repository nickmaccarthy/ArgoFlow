import type {ResourceMetadata} from './host';
import type {WorkflowManifest} from './workflow-resource.ts';
import {eventSourceEvents, eventSourceSummary, type EventSourceManifest} from './event-source-resource.ts';
import {sensorDependencies, sensorSummary, sensorTriggers, type SensorManifest, type SensorTriggerSummary} from './sensor-resource.ts';
import type {EventHealth} from './event-resource.ts';

export type CorrelationConfidence = 'verified' | 'unresolved';
export type CorrelationEvidence =
  | 'dependencySpec'
  | 'triggerResourceName'
  | 'triggerGeneratedName'
  | 'ownerReference'
  | 'controllerTrackingMetadata';

export interface Correlation {
  confidence: CorrelationConfidence;
  reason: string;
  evidence?: CorrelationEvidence;
}

export interface DependencyCorrelation extends Correlation {
  sensor?: string;
  dependency: string;
  eventSourceName?: string;
  eventName?: string;
}

export interface WorkflowCorrelation extends Correlation {
  sensor?: string;
  trigger: string;
  workflow?: string;
  health?: EventHealth;
}

export interface BlockedHop {
  kind: 'EventSource' | 'Dependency' | 'Sensor' | 'Trigger' | 'Workflow';
  name?: string;
  state: Extract<EventHealth, 'Blocked' | 'Failed' | 'Unknown'>;
  reason: string;
}

export interface EventChain {
  dependencies: DependencyCorrelation[];
  workflows: WorkflowCorrelation[];
  firstBlockedHop?: BlockedHop;
}

/** A Sensor dependency is verified only by the exact two-field EventSource reference. */
export function dependencyCorrelation(sensor: SensorManifest | undefined, dependencyName: string, source?: EventSourceManifest): DependencyCorrelation {
  const dependency = sensorDependencies(sensor).find(item => item.name === dependencyName);
  const sourceName = source?.metadata?.name;
  const sourceEvents = eventSourceEvents(source);
  if (!dependency?.eventSourceName || !dependency.eventName) {
    return {confidence: 'unresolved', dependency: dependencyName, reason: 'Dependency lacks an exact eventSourceName and eventName'};
  }
  if (sensor?.kind !== 'Sensor' || !sensor.apiVersion?.startsWith('argoproj.io/')) {
    return {confidence: 'unresolved', dependency: dependencyName, reason: 'Sensor identity is not an Argo Events Sensor'};
  }
  if (!sourceName || sourceName !== dependency.eventSourceName) {
    return {
      confidence: 'unresolved', dependency: dependencyName, eventSourceName: dependency.eventSourceName, eventName: dependency.eventName,
      reason: `EventSource ${dependency.eventSourceName} is not available for exact matching`
    };
  }
  if (source.kind !== 'EventSource' || !source.apiVersion?.startsWith('argoproj.io/')) {
    return {confidence: 'unresolved', dependency: dependencyName, eventSourceName: dependency.eventSourceName, eventName: dependency.eventName, reason: 'EventSource identity is not an Argo Events EventSource'};
  }
  if (!source.metadata?.namespace || !sensor?.metadata?.namespace || source.metadata.namespace !== sensor.metadata.namespace) {
    return {
      confidence: 'unresolved', dependency: dependencyName, eventSourceName: dependency.eventSourceName, eventName: dependency.eventName,
      reason: `EventSource ${sourceName} is in a different namespace`
    };
  }
  if (!sourceEvents.some(event => event.name === dependency.eventName)) {
    return {
      confidence: 'unresolved', dependency: dependencyName, eventSourceName: dependency.eventSourceName, eventName: dependency.eventName,
      reason: `EventSource ${sourceName} does not define event ${dependency.eventName}`
    };
  }
  return {
    confidence: 'verified', evidence: 'dependencySpec', dependency: dependencyName,
    eventSourceName: sourceName, eventName: dependency.eventName,
    reason: `Sensor dependency directly references ${sourceName}/${dependency.eventName}`
  };
}

/**
 * Workflow names, namespaces, and timestamps are intentionally not fallback evidence.
 * The only accepted paths are a direct trigger identifier or controller-owned metadata.
 */
export function workflowCorrelation(
  sensor: SensorManifest | undefined,
  triggerName: string,
  workflow?: WorkflowManifest
): WorkflowCorrelation {
  const trigger = sensorTriggers(sensor).find(item => item.name === triggerName);
  const sensorName = sensor?.metadata?.name;
  const metadata = workflow?.metadata;
  const base = {sensor: sensorName, trigger: triggerName, workflow: metadata?.name, health: workflowHealth(workflow)};
  if (!trigger || !sensorName) return {...base, confidence: 'unresolved', reason: 'Sensor or trigger is not available'};
  if (sensor.kind !== 'Sensor' || !sensor.apiVersion?.startsWith('argoproj.io/')) return {...base, confidence: 'unresolved', reason: 'Sensor identity is not an Argo Events Sensor'};
  if (trigger.targetKind !== 'Workflow' || !trigger.targetApiVersion?.startsWith('argoproj.io/')) {
    return {...base, confidence: 'unresolved', reason: `Trigger target ${trigger.targetApiVersion || 'unknown'}/${trigger.targetKind || 'unknown'} is not an Argo Workflow`};
  }
  if (!metadata?.name) return {...base, confidence: 'unresolved', reason: 'No observed Workflow is available'};
  if (workflow?.kind !== 'Workflow' || workflow.apiVersion !== trigger.targetApiVersion) return {...base, confidence: 'unresolved', reason: 'Observed resource identity is not the exact trigger Workflow API target'};
  if (!sameTargetNamespace(sensor, trigger, workflow)) return {...base, confidence: 'unresolved', reason: 'Workflow namespace does not match the trigger target'};
  if (trigger.targetName === metadata.name) {
    return {...base, confidence: 'verified', evidence: 'triggerResourceName', reason: 'Workflow name exactly matches the trigger resource name'};
  }
  if (trigger.targetGenerateName && metadata.name.startsWith(trigger.targetGenerateName)) {
    return {...base, confidence: 'verified', evidence: 'triggerGeneratedName', reason: 'Workflow name matches the trigger generated-name prefix'};
  }
  if (metadata.ownerReferences?.some(reference => reference.kind === 'Sensor' && reference.name === sensorName && (!reference.uid || !sensor.metadata?.uid || reference.uid === sensor.metadata.uid))) {
    return workflowTriggerCount(sensor) === 1
      ? {...base, confidence: 'verified', evidence: 'ownerReference', reason: 'Workflow has an exact Sensor owner reference'}
      : {...base, confidence: 'unresolved', reason: 'Sensor owner reference does not identify one of multiple Workflow triggers'};
  }
  const tracking = trackingEvidence(metadata, sensorName, triggerName);
  if (tracking === 'trigger' || (tracking === 'sensor' && workflowTriggerCount(sensor) === 1)) {
    return {...base, confidence: 'verified', evidence: 'controllerTrackingMetadata', reason: `Workflow has exact controller tracking metadata for the ${tracking}`};
  }
  return {...base, confidence: 'unresolved', reason: 'No direct trigger identifier or controller tracking metadata links this Workflow'};
}

export function correlateEventChain(
  sources: readonly EventSourceManifest[],
  sensors: readonly SensorManifest[],
  workflows: readonly WorkflowManifest[]
): EventChain {
  const dependencies = sensors.flatMap(sensor => sensorDependencies(sensor).map(dependency =>
    dependencyCorrelation(sensor, dependency.name, sources.find(source => source.metadata?.name === dependency.eventSourceName && source.metadata?.namespace === sensor.metadata?.namespace))
  ));
  const workflowRelations = sensors.flatMap(sensor => sensorTriggers(sensor)
    .filter(trigger => trigger.targetKind === 'Workflow' && trigger.targetApiVersion?.startsWith('argoproj.io/'))
    .flatMap(trigger => {
      const matches = workflows.map(workflow => workflowCorrelation(sensor, trigger.name, workflow)).filter(relation => relation.confidence === 'verified');
      return matches.length ? matches : [workflowCorrelation(sensor, trigger.name)];
    }));
  return {dependencies, workflows: workflowRelations, firstBlockedHop: firstBlockedHop(sources, sensors, workflowRelations)};
}

/** Returns the first known unhealthy or indeterminate hop without turning missing downstream data into failure. */
export function firstBlockedHop(
  sources: readonly EventSourceManifest[],
  sensors: readonly SensorManifest[],
  workflows: readonly WorkflowCorrelation[]
): BlockedHop | undefined {
  const pathSensors = sensors.filter(sensor => !sources.length || sensorDependencies(sensor).some(dependency =>
    sources.some(source => source.metadata?.name === dependency.eventSourceName && source.metadata?.namespace === sensor.metadata?.namespace)
  ));
  if (!pathSensors.length) {
    const source = sources.map(eventSourceSummary).find(summary => isBlocking(summary.health.state));
    if (source) return {kind: 'EventSource', name: source.name, state: source.health.state as 'Blocked' | 'Failed' | 'Unknown', reason: source.health.reason};
  }
  for (const sensor of pathSensors) {
    const dependencies = sensorDependencies(sensor);
    for (const dependency of dependencies) {
      const source = sources.find(item => item.metadata?.name === dependency.eventSourceName && item.metadata?.namespace === sensor.metadata?.namespace);
      const relation = dependencyCorrelation(sensor, dependency.name, source);
      if (relation.confidence === 'unresolved') return {kind: 'Dependency', name: dependency.name, state: 'Unknown', reason: relation.reason};
      const summary = eventSourceSummary(source);
      if (isBlocking(summary.health.state)) return {kind: 'EventSource', name: summary.name, state: summary.health.state, reason: summary.health.reason};
    }
    const summary = sensorSummary(sensor);
    if (isBlocking(summary.health.state)) return {kind: 'Sensor', name: summary.name, state: summary.health.state, reason: summary.health.reason};
    for (const trigger of summary.triggers.filter(item => item.targetKind === 'Workflow' && item.targetApiVersion?.startsWith('argoproj.io/'))) {
      if (isBlocking(trigger.health.state)) return {kind: 'Trigger', name: trigger.name, state: trigger.health.state, reason: trigger.health.reason};
    }
  }
  const pathSensorNames = new Set(pathSensors.map(sensor => sensor.metadata?.name));
  const unresolved = workflows.find(relation => relation.confidence === 'unresolved' && pathSensorNames.has(relation.sensor));
  if (unresolved) return {kind: 'Workflow', name: unresolved.workflow, state: 'Unknown', reason: unresolved.reason};
  const failed = workflows.find(relation => pathSensorNames.has(relation.sensor) && (relation.health === 'Failed' || relation.health === 'Blocked'));
  if (failed) return {kind: 'Workflow', name: failed.workflow, state: failed.health as 'Failed' | 'Blocked', reason: `Workflow is ${failed.health}`};
  return undefined;
}

export function workflowHealth(workflow?: WorkflowManifest): EventHealth | undefined {
  const phase = workflow?.status?.phase;
  if (!phase) return undefined;
  if (phase === 'Succeeded') return 'Ready';
  if (phase === 'Running' || phase === 'Pending') return 'Active';
  if (phase === 'Failed' || phase === 'Error') return 'Failed';
  return 'Unknown';
}

function sameTargetNamespace(sensor: SensorManifest, trigger: SensorTriggerSummary, workflow?: WorkflowManifest): boolean {
  const target = sensor?.spec?.triggers?.find(item => item.template?.name === trigger.name)?.template;
  const implementation = target?.[trigger.type];
  const resource = implementation && typeof implementation === 'object' && 'source' in implementation
    ? (implementation as {source?: {resource?: {metadata?: {namespace?: string}}}}).source?.resource
    : undefined;
  return (resource?.metadata?.namespace ?? sensor.metadata?.namespace) === workflow?.metadata?.namespace;
}

function workflowTriggerCount(sensor?: SensorManifest): number {
  return sensorTriggers(sensor).filter(trigger => trigger.targetKind === 'Workflow').length;
}

function trackingEvidence(metadata: ResourceMetadata, sensorName: string, triggerName: string): 'sensor' | 'trigger' | undefined {
  const tracked = {...metadata.labels, ...metadata.annotations};
  const sensor = ['events.argoproj.io/sensor', 'events.argoproj.io/sensor-name'].some(key => tracked[key] === sensorName);
  const trigger = ['events.argoproj.io/trigger', 'events.argoproj.io/trigger-name'].some(key => tracked[key] === triggerName);
  return trigger ? 'trigger' : sensor ? 'sensor' : undefined;
}

function isBlocking(state: EventHealth): state is Extract<EventHealth, 'Blocked' | 'Failed' | 'Unknown'> {
  return state === 'Blocked' || state === 'Failed' || state === 'Unknown';
}
