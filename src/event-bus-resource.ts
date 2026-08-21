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

export interface EventBusManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: {name?: string; namespace?: string; generation?: number};
  spec?: Record<string, unknown>;
  status?: {observedGeneration?: number; conditions?: EventCondition[]; phase?: string; status?: string};
}

export interface EventBusSummary {
  name?: string;
  namespace?: string;
  implementation?: string;
  health: EventHealthEvidence;
}

export function eventBusManifest(resource?: ResourceState): EventBusManifest | undefined {
  return eventManifest(resource) as EventBusManifest | undefined;
}

export function eventBusResourceState(resource?: ResourceState): EventResourceState {
  return eventResourceState(resource, 'EventBus');
}

export function eventBusSummary(bus?: EventBusManifest): EventBusSummary {
  return {
    name: bus?.metadata?.name,
    namespace: bus?.metadata?.namespace,
    implementation: Object.keys(bus?.spec ?? {}).filter(key => isRecord(bus?.spec?.[key])).sort()[0],
    health: eventHealth(bus?.status?.conditions, bus?.status?.phase ?? bus?.status?.status)
  };
}
