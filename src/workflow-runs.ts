import {workflowManifest, workflowSummary, type WorkflowManifest} from './workflow-resource.ts';

export const RUN_PAGE_SIZE = 25;
export const RUN_FETCH_CONCURRENCY = 6;
const CURSOR_PREFIX = 'workflow-runs:';

export type RunSource = 'Live' | 'Archive';
export type CorrelationConfidence = 'verified' | 'inferred' | 'unresolved';
export type RunPageState = 'ready' | 'empty' | 'partial' | 'stale' | 'permission' | 'error' | 'unavailable';

export interface QueryError {
  status?: number;
  message?: string;
}

export interface ApplicationContext {
  metadata?: {name?: string; namespace?: string; uid?: string; labels?: Record<string, string>; annotations?: Record<string, string>};
  spec?: {project?: string; destination?: {namespace?: string}};
  name?: string;
  namespace?: string;
  project?: string;
  uid?: string;
}

/** The shallow fields Argo CD supplies in Application tree.nodes. */
export interface WorkflowIdentity {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  group?: string;
  version?: string;
  kind?: string;
  creationTimestamp?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface WorkflowTree {
  nodes?: Array<Partial<WorkflowIdentity> & {apiVersion?: string}>;
  error?: QueryError | string;
}

export interface Correlation {
  confidence: CorrelationConfidence;
  evidence: string[];
  reason: string;
  excluded?: boolean;
}

export interface WorkflowRunRow {
  source: RunSource;
  identity: WorkflowIdentity;
  manifest?: WorkflowManifest;
  name: string;
  namespace?: string;
  phase: ReturnType<typeof workflowSummary>['phase'];
  rawPhase?: string;
  progress?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  duration?: string;
  templateReference?: string;
  message?: string;
  correlation: Correlation;
  error?: {status?: number; message: string};
  stale?: boolean;
}

export interface ExcludedRun {
  identity: WorkflowIdentity;
  source: RunSource;
  reason: string;
  correlation: Correlation;
}

export interface ArchiveCapability {
  state: 'available' | 'unavailable' | 'unknown';
  reason?: string;
}

export interface RunPage {
  rows: WorkflowRunRow[];
  excluded: ExcludedRun[];
  pageSize: number;
  source: RunSource;
  cursor?: string;
  previousCursor?: string;
  nextCursor?: string;
  state: RunPageState;
  capability: {live: 'available' | 'unavailable'; archive: ArchiveCapability};
  permissionDenied?: number;
  staleCount?: number;
}

export interface IdentityPage {
  items: WorkflowIdentity[];
  pageSize: number;
  cursor?: string;
  previousCursor?: string;
  nextCursor?: string;
}

export interface FetchResult {
  identity: WorkflowIdentity;
  manifest?: WorkflowManifest;
  error?: {status?: number; message: string};
}

export interface ArchivePageProvider {
  fetchPage: (request: {cursor?: string; pageSize: number}) => Promise<RunPage>;
  capability?: ArchiveCapability;
}

export interface RunPageOptions {
  application: ApplicationContext;
  tree?: WorkflowTree | Array<Partial<WorkflowIdentity> & {apiVersion?: string}>;
  cursor?: string;
  pageSize?: number;
  source?: RunSource;
  baseUrl?: string;
  fetcher?: typeof fetch;
  includeUnresolved?: boolean;
  archive?: ArchivePageProvider;
  signal?: AbortSignal;
}

function queryError(value: QueryError | string | undefined): QueryError | undefined {
  if (!value) return undefined;
  return typeof value === 'string' ? {message: value} : value;
}

function isPermissionError(error?: QueryError): boolean {
  return error?.status === 401 || error?.status === 403 || /forbidden|unauthori[sz]ed|permission denied/i.test(error?.message || '');
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function applicationName(application: ApplicationContext): string | undefined {
  return text(application.metadata?.name) || text(application.name);
}

function applicationNamespace(application: ApplicationContext): string | undefined {
  return text(application.metadata?.namespace) || text(application.namespace);
}

function applicationProject(application: ApplicationContext): string | undefined {
  return text(application.spec?.project) || text(application.project);
}

function applicationDestinationNamespace(application: ApplicationContext): string | undefined {
  return text(application.spec?.destination?.namespace);
}

function identityDate(identity: WorkflowIdentity): number {
  for (const value of [identity.creationTimestamp, identity.createdAt, identity.startedAt, identity.finishedAt]) {
    if (value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function identityKey(identity: WorkflowIdentity): string {
  return [identity.namespace || '', identity.name, identity.uid || ''].join('\u0000');
}

function compareIdentity(left: WorkflowIdentity, right: WorkflowIdentity): number {
  const dateOrder = identityDate(right) - identityDate(left);
  return dateOrder || identityKey(left).localeCompare(identityKey(right));
}

function asIdentity(node: Partial<WorkflowIdentity> & {apiVersion?: string}): WorkflowIdentity | undefined {
  const name = text(node.name);
  if (!name) return undefined;
  const apiVersion = text(node.apiVersion);
  const [group, version] = apiVersion?.includes('/') ? apiVersion.split('/', 2) : [text(node.group) || 'argoproj.io', text(node.version) || apiVersion];
  return {
    ...node,
    name,
    namespace: text(node.namespace),
    uid: text(node.uid),
    kind: text(node.kind) || 'Workflow',
    group: group || 'argoproj.io',
    version: version || 'v1alpha1',
    creationTimestamp: text(node.creationTimestamp) || text(node.createdAt)
  };
}

function cursorAt(items: WorkflowIdentity[], position: number): string {
  const anchor = position > 0 ? items[position - 1] : undefined;
  return `${CURSOR_PREFIX}${encodeURIComponent(JSON.stringify({
    position,
    date: anchor ? identityDate(anchor) : 0,
    key: anchor ? identityKey(anchor) : ''
  }))}`;
}

function decodeCursor(cursor?: string): {date: number; key: string; position?: number} | undefined {
  if (!cursor || !cursor.startsWith(CURSOR_PREFIX)) return undefined;
  try {
    const result = JSON.parse(decodeURIComponent(cursor.slice(CURSOR_PREFIX.length))) as {date?: number; key?: string; position?: number};
    return typeof result.date === 'number' && typeof result.key === 'string'
      ? {date: result.date, key: result.key, position: typeof result.position === 'number' ? result.position : undefined}
      : undefined;
  } catch {
    return undefined;
  }
}

function cursorPosition(items: WorkflowIdentity[], cursor?: string): number {
  const decoded = decodeCursor(cursor);
  if (!decoded) return 0;
  if (decoded.position === 0) return 0;
  const index = items.findIndex(item => identityDate(item) === decoded.date && identityKey(item) === decoded.key);
  if (index >= 0) return index + 1;
  return typeof decoded.position === 'number' ? Math.max(0, Math.min(items.length, decoded.position)) : 0;
}

export function workflowTreeIdentities(tree: WorkflowTree | WorkflowTree['nodes'] = []): WorkflowIdentity[] {
  const nodes = Array.isArray(tree) ? tree : tree.nodes || [];
  return nodes
    .filter(node => (text(node.kind) || 'Workflow') === 'Workflow' && (text(node.group) || node.apiVersion?.split('/')[0] || 'argoproj.io') === 'argoproj.io')
    .map(asIdentity)
    .filter((node): node is WorkflowIdentity => Boolean(node))
    .sort(compareIdentity);
}

export function pageWorkflowIdentities(
  tree: WorkflowTree | WorkflowTree['nodes'] = [],
  options: {cursor?: string; pageSize?: number} = {}
): IdentityPage {
  const items = workflowTreeIdentities(tree);
  const pageSize = Math.min(RUN_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize || RUN_PAGE_SIZE)));
  const start = cursorPosition(items, options.cursor);
  const page = items.slice(start, start + pageSize);
  return {
    items: page,
    pageSize,
    cursor: options.cursor,
    previousCursor: start > 0 ? cursorAt(items, Math.max(0, start - pageSize)) : undefined,
    nextCursor: start + page.length < items.length && page.length ? cursorAt(items, start + page.length) : undefined
  };
}

export function buildWorkflowResourceUrl(
  application: ApplicationContext,
  identity: Pick<WorkflowIdentity, 'name' | 'namespace' | 'group' | 'version' | 'kind'>,
  baseUrl = ''
): string {
  const appName = applicationName(application);
  if (!appName) throw new Error('Application name is required for GetResource');
  const path = `/api/v1/applications/${encodeURIComponent(appName)}/resource`;
  const url = new URL(path, baseUrl || 'http://same-origin.invalid');
  const query = [
    ['appNamespace', applicationNamespace(application)],
    ['project', applicationProject(application)],
    ['namespace', identity.namespace],
    ['resourceName', identity.name],
    ['version', identity.version || 'v1alpha1'],
    ['group', identity.group || 'argoproj.io'],
    ['kind', identity.kind || 'Workflow']
  ] as const;
  for (const [key, value] of query) if (value) url.searchParams.set(key, value);
  return baseUrl ? url.toString() : `${url.pathname}${url.search}`;
}

export async function fetchWorkflowManifests(
  application: ApplicationContext,
  identities: WorkflowIdentity[],
  fetcher: typeof fetch = globalThis.fetch,
  baseUrl = '',
  concurrency = RUN_FETCH_CONCURRENCY,
  signal?: AbortSignal
): Promise<FetchResult[]> {
  const results: FetchResult[] = new Array(identities.length);
  let next = 0;
  const workers = Math.min(Math.max(1, Math.floor(concurrency)), RUN_FETCH_CONCURRENCY, identities.length);
  await Promise.all(Array.from({length: workers}, async () => {
    while (next < identities.length) {
      const index = next++;
      const identity = identities[index];
      try {
        const response = await fetcher(buildWorkflowResourceUrl(application, identity, baseUrl), {credentials: 'same-origin', signal});
        if (!response.ok) throw Object.assign(new Error(`GetResource failed (${response.status})`), {status: response.status});
        const body = await response.json() as {manifest?: unknown; resource?: unknown} | unknown;
        const value = body && typeof body === 'object' && ('manifest' in body || 'resource' in body)
          ? ('manifest' in body ? body.manifest : body.resource)
          : body;
        const manifest = workflowManifest({manifest: typeof value === 'string' ? value : value} as never);
        if (!manifest) throw new Error('GetResource returned an invalid Workflow manifest');
        results[index] = {identity, manifest};
      } catch (error) {
        if (signal?.aborted) throw error;
        const status = typeof error === 'object' && error && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
        results[index] = {identity, error: {status, message: error instanceof Error ? error.message : 'GetResource failed'}};
      }
    }
  }));
  return results;
}

function trackingValue(manifest: WorkflowManifest): string | undefined {
  const metadata = manifest.metadata;
  return metadata?.annotations?.['argocd.argoproj.io/tracking-id'] || metadata?.labels?.['argocd.argoproj.io/instance'];
}

export function correlateWorkflow(
  workflow: WorkflowManifest | undefined,
  application: ApplicationContext,
  identity?: WorkflowIdentity
): Correlation {
  const appName = applicationName(application);
  const workflowName = text(workflow?.metadata?.name) || identity?.name;
  const workflowNamespace = text(workflow?.metadata?.namespace) || identity?.namespace;
  const evidence: string[] = [];
  const metadata = workflow?.metadata;
  const tracking = workflow ? trackingValue(workflow) : undefined;
  const appUid = text(application.metadata?.uid) || text(application.uid);

  if (identity && identity.kind === 'Workflow' && identity.name === workflowName && identity.namespace === workflowNamespace) {
    evidence.push('exact Workflow identity is present in the selected Application tree');
    return {confidence: 'verified', evidence, reason: evidence[0]};
  }
  if (tracking && appName && (tracking === appName || tracking.startsWith(`${appName}:`))) {
    evidence.push('Argo CD tracking metadata names the selected Application');
    return {confidence: 'verified', evidence, reason: evidence[0]};
  }
  if (appUid && (metadata?.ownerReferences || []).some(owner => owner.uid === appUid)) {
    evidence.push('Workflow ownerReference points to the selected Application');
    return {confidence: 'verified', evidence, reason: evidence[0]};
  }
  const sameNamespace = Boolean(workflowNamespace && workflowNamespace === applicationDestinationNamespace(application));
  const templateSignal = Boolean(workflow?.spec?.workflowTemplateRef?.name || identity?.labels?.['workflows.argoproj.io/workflow-template']);
  if (sameNamespace && templateSignal) {
    evidence.push('namespace matches the Application');
    evidence.push('Workflow template metadata provides a second weak signal');
    return {confidence: 'inferred', evidence, reason: 'Multiple weak signals agree; Application ownership is not directly proven'};
  }
  return {
    confidence: 'unresolved',
    evidence: sameNamespace ? ['namespace matches the Application'] : [],
    reason: sameNamespace ? 'Namespace alone does not establish Application ownership' : 'No authorized Application-correlation evidence was supplied'
  };
}

export function archiveUnavailable(reason = 'Archive capability was not supplied by the host'): ArchiveCapability {
  return {state: 'unavailable', reason};
}

function rowFromResult(result: FetchResult, source: RunSource, correlation: Correlation, stale = false): WorkflowRunRow {
  const summary = workflowSummary(result.manifest);
  return {
    source,
    identity: result.identity,
    manifest: result.manifest,
    name: summary.name || result.identity.name,
    namespace: summary.namespace || result.identity.namespace,
    phase: summary.phase,
    rawPhase: summary.rawPhase,
    progress: summary.progress,
    createdAt: summary.createdAt || result.identity.creationTimestamp,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    duration: summary.duration,
    templateReference: summary.templateReference,
    message: summary.message,
    correlation,
    error: result.error,
    stale: stale || undefined
  };
}

export async function loadWorkflowRunPage(options: RunPageOptions): Promise<RunPage> {
  const source = options.source || 'Live';
  const pageSize = Math.min(RUN_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize || RUN_PAGE_SIZE)));
  const archiveCapability = options.archive?.capability || (options.archive ? {state: 'unknown' as const, reason: 'Archive provider did not declare capability'} : archiveUnavailable());
  if (source === 'Archive') {
    if (!options.archive) {
      return {rows: [], excluded: [], pageSize, source, cursor: options.cursor, state: 'unavailable', capability: {live: 'available', archive: archiveCapability}};
    }
    return options.archive.fetchPage({cursor: options.cursor, pageSize});
  }

  const treeError = !Array.isArray(options.tree) ? queryError(options.tree?.error) : undefined;
  if (treeError) {
    return {
      rows: [],
      excluded: [],
      pageSize,
      source,
      cursor: options.cursor,
      state: isPermissionError(treeError) ? 'permission' : 'error',
      capability: {live: 'available', archive: archiveCapability},
      permissionDenied: isPermissionError(treeError) ? 1 : undefined
    };
  }

  const identityPage = pageWorkflowIdentities(options.tree || [], {cursor: options.cursor, pageSize});
  const fetched = await fetchWorkflowManifests(
    options.application,
    identityPage.items,
    options.fetcher || globalThis.fetch,
    options.baseUrl,
    RUN_FETCH_CONCURRENCY,
    options.signal
  );
  const rows: WorkflowRunRow[] = [];
  const excluded: ExcludedRun[] = [];
  let staleCount = 0;
  for (const result of fetched) {
    if (result.error) continue;
    const correlation = correlateWorkflow(result.manifest, options.application, result.identity);
    if (correlation.confidence === 'unresolved' && !options.includeUnresolved) {
      const excludedCorrelation = {...correlation, excluded: true};
      excluded.push({identity: result.identity, source, reason: correlation.reason, correlation: excludedCorrelation});
    } else {
      const stale = Boolean(
        result.identity.resourceVersion &&
        result.manifest?.metadata?.resourceVersion &&
        result.identity.resourceVersion !== result.manifest.metadata.resourceVersion
      );
      if (stale) staleCount += 1;
      rows.push(rowFromResult(result, source, correlation, stale));
    }
  }
  const failed = fetched.filter(result => result.error).length;
  const permissionDenied = fetched.filter(result => isPermissionError(result.error)).length;
  const state: RunPageState = !rows.length && permissionDenied === fetched.length && fetched.length > 0
    ? 'permission'
    : !rows.length && failed
      ? 'error'
      : !rows.length && excluded.length
        ? 'partial'
        : !rows.length
          ? 'empty'
          : failed || excluded.length
            ? 'partial'
            : staleCount
              ? 'stale'
              : 'ready';
  return {
    rows,
    excluded,
    pageSize,
    source,
    cursor: options.cursor,
    previousCursor: identityPage.previousCursor,
    nextCursor: identityPage.nextCursor,
    state,
    capability: {live: 'available', archive: archiveCapability},
    permissionDenied: permissionDenied || undefined,
    staleCount: staleCount || undefined
  };
}

export const getWorkflowRunPage = loadWorkflowRunPage;
export const classifyWorkflowCorrelation = correlateWorkflow;
