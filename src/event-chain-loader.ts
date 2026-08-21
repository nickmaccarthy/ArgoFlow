import type {ApplicationState, ApplicationTree, ApplicationTreeNode, ResourceState} from './host';
import {eventBusManifest, type EventBusManifest} from './event-bus-resource.ts';
import {eventManifest, type EventManifest} from './event-resource.ts';
import {eventSourceManifest, type EventSourceManifest} from './event-source-resource.ts';
import {sensorManifest, type SensorManifest} from './sensor-resource.ts';
import {workflowManifest, type WorkflowManifest} from './workflow-resource.ts';

export const EVENT_CHAIN_MAX_READS = 25;
export const EVENT_CHAIN_FETCH_CONCURRENCY = 6;

export type EventChainKind = 'EventSource' | 'Sensor' | 'EventBus';
export type EventChainResourceKind = EventChainKind | 'Workflow';
export type EventChainFetchState = 'ready' | 'authentication' | 'permission' | 'missing' | 'malformed' | 'empty' | 'stale' | 'error';
export type EventChainLoadState = EventChainFetchState | 'partial' | 'truncated';

export interface EventChainIdentity {
  group: 'argoproj.io';
  version: string;
  kind: EventChainResourceKind;
  name: string;
  namespace?: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface EventChainFetchResult {
  identity: EventChainIdentity;
  state: EventChainFetchState;
  manifest?: EventManifest | WorkflowManifest;
  error?: {status?: number; message: string};
}

export interface EventChainData {
  sources: EventSourceManifest[];
  sensors: SensorManifest[];
  buses: EventBusManifest[];
  workflows: WorkflowManifest[];
  errors: EventChainFetchResult[];
  identities: EventChainIdentity[];
  state: EventChainLoadState;
  truncatedCount: number;
  staleCount: number;
  authenticationRequired?: number;
  permissionDenied?: number;
  missingCount?: number;
  malformedCount?: number;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function applicationName(application?: ApplicationState): string | undefined {
  return text(application?.metadata?.name);
}

function applicationNamespace(application?: ApplicationState): string | undefined {
  return text(application?.metadata?.namespace);
}

function applicationProject(application?: ApplicationState): string | undefined {
  return text(application?.spec?.project);
}

function identityFromTree(node: ApplicationTreeNode): EventChainIdentity | undefined {
  const kind = text(node.kind) as EventChainResourceKind | undefined;
  const name = text(node.name);
  const apiVersion = text(node.apiVersion);
  const group = apiVersion?.split('/', 2)[0] || text(node.group);
  const version = apiVersion?.split('/', 2)[1] || text(node.version) || 'v1alpha1';
  if (!name || !kind || group !== 'argoproj.io' || !['EventSource', 'Sensor', 'EventBus', 'Workflow'].includes(kind)) return undefined;
  return {
    group: 'argoproj.io', version, kind, name, namespace: text(node.namespace), resourceVersion: text(node.resourceVersion),
    labels: node.labels, annotations: node.annotations
  };
}

function identityKey(identity: Pick<EventChainIdentity, 'kind' | 'name' | 'namespace'>): string {
  return ['argoproj.io', identity.kind, identity.namespace || '', identity.name].join('\u0000');
}

/**
 * Chooses only concrete Application-tree identities. The resource API receives no
 * kind- or namespace-wide query, and the read budget is fixed before fetching.
 */
export function eventChainIdentities(
  tree: ApplicationTree | undefined,
  resource: ResourceState | undefined,
  kind: EventChainKind
): EventChainIdentity[] {
  return eventChainIdentityPlan(tree, resource, kind).identities;
}

export function eventChainIdentityPlan(tree: ApplicationTree | undefined, resource: ResourceState | undefined, kind: EventChainKind): {identities: EventChainIdentity[]; truncatedCount: number} {
  const selectedManifest = eventManifest(resource);
  const selectedNamespace = selectedManifest?.metadata?.namespace ?? resource?.metadata?.namespace;
  const selectedName = selectedManifest?.metadata?.name ?? resource?.metadata?.name;
  if (!selectedNamespace) return {identities: [], truncatedCount: 0};
  const priorities: Record<EventChainKind, EventChainResourceKind[]> = {
    EventSource: ['Sensor', 'Workflow'],
    Sensor: ['EventSource', 'Workflow'],
    EventBus: ['EventSource', 'Sensor', 'Workflow']
  };
  const selectedKey = selectedName ? identityKey({kind, name: selectedName, namespace: selectedNamespace}) : undefined;
  const candidates = (tree?.nodes ?? [])
    .map(identityFromTree)
    .filter((identity): identity is EventChainIdentity => Boolean(identity))
    .filter(identity => !selectedNamespace || identity.namespace === selectedNamespace)
    .filter(identity => identityKey(identity) !== selectedKey)
    .filter(identity => priorities[kind].includes(identity.kind))
    .sort((left, right) => priorities[kind].indexOf(left.kind) - priorities[kind].indexOf(right.kind) || identityKey(left).localeCompare(identityKey(right)));
  return {identities: candidates.slice(0, EVENT_CHAIN_MAX_READS), truncatedCount: Math.max(0, candidates.length - EVENT_CHAIN_MAX_READS)};
}

/** Bounded, exact resource identities for the Application-level Events view. */
export function applicationEventIdentityPlan(tree: ApplicationTree | undefined): {identities: EventChainIdentity[]; truncatedCount: number} {
  const priority: EventChainResourceKind[] = ['EventBus', 'EventSource', 'Sensor', 'Workflow'];
  const candidates = (tree?.nodes ?? [])
    .map(identityFromTree)
    .filter((identity): identity is EventChainIdentity => Boolean(identity))
    .sort((left, right) => priority.indexOf(left.kind) - priority.indexOf(right.kind) || identityKey(left).localeCompare(identityKey(right)));
  return {identities: candidates.slice(0, EVENT_CHAIN_MAX_READS), truncatedCount: Math.max(0, candidates.length - EVENT_CHAIN_MAX_READS)};
}

export function buildEventResourceUrl(application: ApplicationState | undefined, identity: EventChainIdentity, baseUrl = ''): string {
  const appName = applicationName(application);
  if (!appName) throw new Error('Application name is required for GetResource');
  const url = new URL(`/api/v1/applications/${encodeURIComponent(appName)}/resource`, baseUrl || 'http://same-origin.invalid');
  const query = {
    appNamespace: applicationNamespace(application),
    project: applicationProject(application),
    namespace: identity.namespace,
    resourceName: identity.name,
    version: identity.version,
    group: identity.group,
    kind: identity.kind
  };
  for (const [key, value] of Object.entries(query)) if (value) url.searchParams.set(key, value);
  return baseUrl ? url.toString() : `${url.pathname}${url.search}`;
}

export async function fetchEventChainManifests(
  application: ApplicationState | undefined,
  identities: readonly EventChainIdentity[],
  fetcher: typeof fetch = globalThis.fetch,
  baseUrl = '',
  concurrency = EVENT_CHAIN_FETCH_CONCURRENCY,
  signal?: AbortSignal
): Promise<EventChainFetchResult[]> {
  const bounded = identities.slice(0, EVENT_CHAIN_MAX_READS);
  const results: EventChainFetchResult[] = new Array(bounded.length);
  let next = 0;
  const workers = Math.min(Math.max(1, Math.floor(concurrency)), EVENT_CHAIN_FETCH_CONCURRENCY, bounded.length);
  await Promise.all(Array.from({length: workers}, async () => {
    while (next < bounded.length) {
      const index = next++;
      const identity = bounded[index];
      try {
        const response = await fetcher(buildEventResourceUrl(application, identity, baseUrl), {credentials: 'same-origin', signal});
        if (!response.ok) {
          const state: EventChainFetchState = response.status === 401 ? 'authentication' : response.status === 403 ? 'permission' : response.status === 404 ? 'missing' : 'error';
          results[index] = {identity, state, error: {status: response.status, message: `GetResource failed (${response.status})`}};
          continue;
        }
        const bodyText = await response.text();
        if (!bodyText.trim()) {
          results[index] = {identity, state: 'empty', error: {message: 'GetResource returned an empty response'}};
          continue;
        }
        let body: {manifest?: unknown; resource?: unknown} | unknown;
        try {
          body = JSON.parse(bodyText) as {manifest?: unknown; resource?: unknown} | unknown;
        } catch {
          results[index] = {identity, state: 'malformed', error: {message: 'GetResource returned malformed JSON'}};
          continue;
        }
        const value = body && typeof body === 'object' && ('manifest' in body || 'resource' in body)
          ? ('manifest' in body ? body.manifest : body.resource)
          : body;
        const manifest = identity.kind === 'Workflow'
          ? workflowManifest({manifest: value} as ResourceState)
          : eventManifest({manifest: value} as ResourceState);
        if (!validManifest(manifest, identity)) {
          results[index] = {identity, state: 'malformed', error: {message: `GetResource returned an invalid ${identity.kind} manifest`}};
          continue;
        }
        const stale = Boolean(identity.resourceVersion && manifest.metadata?.resourceVersion && identity.resourceVersion !== manifest.metadata.resourceVersion);
        results[index] = {identity, state: stale ? 'stale' : 'ready', manifest};
      } catch (error) {
        if (signal?.aborted) throw error;
        const status = typeof error === 'object' && error && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
        results[index] = {identity, state: 'error', error: {status, message: error instanceof Error ? error.message : 'GetResource failed'}};
      }
    }
  }));
  return results;
}

function validManifest(manifest: EventManifest | WorkflowManifest | undefined, identity: EventChainIdentity): manifest is EventManifest | WorkflowManifest {
  return Boolean(
    manifest &&
    manifest.apiVersion === `${identity.group}/${identity.version}` &&
    manifest.kind === identity.kind &&
    manifest.metadata?.name === identity.name &&
    manifest.metadata?.namespace === identity.namespace
  );
}

function selectedManifest(resource: ResourceState | undefined, kind: EventChainKind): EventManifest | undefined {
  if (kind === 'EventSource') return eventSourceManifest(resource);
  if (kind === 'Sensor') return sensorManifest(resource);
  return eventBusManifest(resource);
}

function appendUnique<T extends {metadata?: {name?: string; namespace?: string}}>(items: T[], value: T | undefined): void {
  if (!value?.metadata?.name || items.some(item => item.metadata?.name === value.metadata?.name && item.metadata?.namespace === value.metadata?.namespace)) return;
  items.push(value);
}

function treeFailure(tree?: ApplicationTree): {state: Extract<EventChainFetchState, 'authentication' | 'permission' | 'error'>; error: {status?: number; message: string}} | undefined {
  const value = tree?.error;
  if (!value) return undefined;
  const status = typeof value === 'string' ? undefined : value.status;
  const message = typeof value === 'string' ? value : value.message || 'Application tree could not be read';
  return {state: status === 401 ? 'authentication' : status === 403 ? 'permission' : 'error', error: {status, message}};
}

function dataState(
  results: readonly EventChainFetchResult[],
  hasData: boolean,
  truncatedCount: number
): EventChainLoadState {
  const failed = results.filter(result => result.state !== 'ready' && result.state !== 'stale');
  if (!hasData && failed.length) {
    const states = new Set(failed.map(result => result.state));
    if (states.size === 1) return failed[0].state;
  }
  if (failed.length) return 'partial';
  if (results.some(result => result.state === 'stale')) return 'stale';
  if (truncatedCount) return 'truncated';
  return hasData ? 'ready' : 'empty';
}

export async function loadEventChainData(options: {
  application?: ApplicationState;
  tree?: ApplicationTree;
  resource?: ResourceState;
  kind: EventChainKind;
  fetcher?: typeof fetch;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<EventChainData> {
  const selected = selectedManifest(options.resource, options.kind);
  const empty = (state: EventChainLoadState, errors: EventChainFetchResult[] = [], truncatedCount = 0): EventChainData => {
    const sources: EventSourceManifest[] = [];
    const sensors: SensorManifest[] = [];
    const buses: EventBusManifest[] = [];
    if (options.kind === 'EventSource') appendUnique(sources, selected as EventSourceManifest | undefined);
    if (options.kind === 'Sensor') appendUnique(sensors, selected as SensorManifest | undefined);
    if (options.kind === 'EventBus') appendUnique(buses, selected as EventBusManifest | undefined);
    return summarizeData({sources, sensors, buses, workflows: [], errors, identities: [], state, truncatedCount});
  };
  const treeError = treeFailure(options.tree);
  if (treeError) {
    const identity: EventChainIdentity = {group: 'argoproj.io', version: 'v1alpha1', kind: options.kind, name: selected?.metadata?.name || 'selected-resource', namespace: selected?.metadata?.namespace};
    return empty(treeError.state, [{identity, state: treeError.state, error: treeError.error}]);
  }
  const plan = eventChainIdentityPlan(options.tree, options.resource, options.kind);
  const identities = plan.identities;
  const fetched = await fetchEventChainManifests(
    options.application, identities, options.fetcher || globalThis.fetch, options.baseUrl, EVENT_CHAIN_FETCH_CONCURRENCY, options.signal
  );
  const sources: EventSourceManifest[] = [];
  const sensors: SensorManifest[] = [];
  const buses: EventBusManifest[] = [];
  const workflows: WorkflowManifest[] = [];
  if (options.kind === 'EventSource') appendUnique(sources, selected as EventSourceManifest | undefined);
  if (options.kind === 'Sensor') appendUnique(sensors, selected as SensorManifest | undefined);
  if (options.kind === 'EventBus') appendUnique(buses, selected as EventBusManifest | undefined);

  for (const result of fetched) {
    if (!result.manifest) continue;
    if (result.identity.kind === 'EventSource') appendUnique(sources, result.manifest as EventSourceManifest);
    if (result.identity.kind === 'Sensor') appendUnique(sensors, result.manifest as SensorManifest);
    if (result.identity.kind === 'EventBus') appendUnique(buses, result.manifest as EventBusManifest);
    if (result.identity.kind === 'Workflow') appendUnique(workflows, result.manifest as WorkflowManifest);
  }
  return summarizeData({sources, sensors, buses, workflows, errors: fetched.filter(result => result.error), identities, state: dataState(fetched, Boolean(sources.length || sensors.length || buses.length || workflows.length), plan.truncatedCount), truncatedCount: plan.truncatedCount, fetched});
}

export async function loadApplicationEventData(options: {
  application?: ApplicationState;
  tree?: ApplicationTree;
  fetcher?: typeof fetch;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<EventChainData> {
  const treeError = treeFailure(options.tree);
  if (treeError) {
    const identity: EventChainIdentity = {group: 'argoproj.io', version: 'v1alpha1', kind: 'EventSource', name: 'application-events'};
    const result: EventChainFetchResult = {identity, state: treeError.state, error: treeError.error};
    return summarizeData({sources: [], sensors: [], buses: [], workflows: [], errors: [result], identities: [], state: treeError.state, truncatedCount: 0});
  }
  const plan = applicationEventIdentityPlan(options.tree);
  const fetched = await fetchEventChainManifests(options.application, plan.identities, options.fetcher || globalThis.fetch, options.baseUrl, EVENT_CHAIN_FETCH_CONCURRENCY, options.signal);
  const sources: EventSourceManifest[] = [];
  const sensors: SensorManifest[] = [];
  const buses: EventBusManifest[] = [];
  const workflows: WorkflowManifest[] = [];
  for (const result of fetched) {
    if (!result.manifest) continue;
    if (result.identity.kind === 'EventSource') appendUnique(sources, result.manifest as EventSourceManifest);
    if (result.identity.kind === 'Sensor') appendUnique(sensors, result.manifest as SensorManifest);
    if (result.identity.kind === 'EventBus') appendUnique(buses, result.manifest as EventBusManifest);
    if (result.identity.kind === 'Workflow') appendUnique(workflows, result.manifest as WorkflowManifest);
  }
  return summarizeData({
    sources, sensors, buses, workflows, identities: plan.identities,
    errors: fetched.filter(result => result.error),
    state: dataState(fetched, Boolean(sources.length || sensors.length || buses.length || workflows.length), plan.truncatedCount),
    truncatedCount: plan.truncatedCount, fetched
  });
}

function summarizeData(input: {
  sources: EventSourceManifest[];
  sensors: SensorManifest[];
  buses: EventBusManifest[];
  workflows: WorkflowManifest[];
  errors: EventChainFetchResult[];
  identities: EventChainIdentity[];
  state: EventChainLoadState;
  truncatedCount: number;
  fetched?: EventChainFetchResult[];
}): EventChainData {
  const results = input.fetched ?? input.errors;
  const count = (state: EventChainFetchState) => results.filter(result => result.state === state).length || undefined;
  return {
    sources: input.sources,
    sensors: input.sensors,
    buses: input.buses,
    workflows: input.workflows,
    errors: input.errors,
    identities: input.identities,
    state: input.state,
    truncatedCount: input.truncatedCount,
    staleCount: results.filter(result => result.state === 'stale').length,
    authenticationRequired: count('authentication'),
    permissionDenied: count('permission'),
    missingCount: count('missing'),
    malformedCount: count('malformed')
  };
}
