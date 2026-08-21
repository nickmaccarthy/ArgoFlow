import type {ResourceState} from './host';
import {
  eventHealth,
  eventManifest,
  eventResourceState,
  isRecord,
  type EventCondition,
  type EventHealthEvidence,
  type EventResourceState
} from './event-resource.ts';

export interface EventSourceManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: {name?: string; namespace?: string; generation?: number; uid?: string};
  spec?: {eventBusName?: string; template?: unknown; [type: string]: unknown};
  status?: {observedGeneration?: number; conditions?: EventCondition[]; phase?: string; status?: string};
}

export interface EventSourceEvent {
  type: string;
  name: string;
  endpoint?: 'Configured';
  port?: number;
  method?: string;
}

export interface EventSourceSummary {
  name?: string;
  namespace?: string;
  eventBusName?: string;
  events: EventSourceEvent[];
  health: EventHealthEvidence;
}

export function eventSourceManifest(resource?: ResourceState): EventSourceManifest | undefined {
  return eventManifest(resource) as EventSourceManifest | undefined;
}

export function eventSourceResourceState(resource?: ResourceState): EventResourceState {
  return eventResourceState(resource, 'EventSource');
}

export function eventSourceSummary(source?: EventSourceManifest): EventSourceSummary {
  return {
    name: source?.metadata?.name,
    namespace: source?.metadata?.namespace,
    eventBusName: source?.spec?.eventBusName,
    events: eventSourceEvents(source),
    health: eventHealth(source?.status?.conditions, source?.status?.phase ?? source?.status?.status)
  };
}

/** Only recognized routing fields are surfaced; every other source setting stays private. */
export function eventSourceEvents(source?: EventSourceManifest): EventSourceEvent[] {
  const spec = source?.spec;
  if (!spec) return [];
  return Object.entries(spec)
    .filter(([type, value]) => (EVENT_SOURCE_TYPES as readonly string[]).includes(type) && isRecord(value))
    .flatMap(([type, definitions]) => isRecord(definitions)
      ? Object.entries(definitions).flatMap(([name, config]) => isRecord(config) ? [safeSourceEvent(type, name, config)] : [])
      : [])
    .sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
}

function safeSourceEvent(type: string, name: string, config: Record<string, unknown>): EventSourceEvent {
  const endpoint = typeof config.endpoint === 'string' && config.endpoint.trim() ? 'Configured' : undefined;
  const candidatePort = typeof config.port === 'number' ? config.port : typeof config.port === 'string' && /^\d+$/.test(config.port) ? Number(config.port) : undefined;
  const port = typeof candidatePort === 'number' && Number.isInteger(candidatePort) && candidatePort > 0 && candidatePort <= 65535 ? candidatePort : undefined;
  const method = typeof config.method === 'string' && /^[A-Z]+$/i.test(config.method) ? config.method.toUpperCase() : undefined;
  return {type, name, endpoint, port, method};
}

/** Argo Events v1.9.11 EventSourceSpec source fields. Infrastructure fields such as service stay excluded. */
export const EVENT_SOURCE_TYPES = [
  'amqp', 'asana', 'awsSqs', 'azureEventsHub', 'azureQueueStorage', 'bitbucket', 'calendar', 'emqx', 'file', 'generic',
  'github', 'gitlab', 'hdfs', 'http', 'kafka', 'mqtt', 'nats', 'nsq', 'pubSub', 'pulsar', 'redis', 'replicaSet',
  'resource', 'slack', 'sns', 'sqs', 'stripe', 'webhook', 'websocket'
] as const;
