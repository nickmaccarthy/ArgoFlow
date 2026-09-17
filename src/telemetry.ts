declare const __ARGOFLOW_VERSION__: string;

/** Injected by webpack DefinePlugin from package.json; 'unversioned' outside builds (tests). */
export const EXTENSION_VERSION = typeof __ARGOFLOW_VERSION__ === 'string' ? __ARGOFLOW_VERSION__ : 'unversioned';
export const TELEMETRY_EVENT = 'argocd-workflows-extension:telemetry';
const TELEMETRY_EVENTS = ['extension.loaded', 'workflow.ready', 'run-page.loaded', 'run-page.failed', 'event-resource.loaded', 'event-chain.query', 'event-chain.loaded', 'render.failed'] as const;
const FEATURES = ['live-runs', 'archive-runs', 'workflow-dag', 'workflow-list', 'workflow-grid', 'resource-workflow', 'resource-template', 'resource-cron', 'resource-event-source', 'resource-sensor', 'resource-event-bus', 'event-chain', 'application-events'] as const;
const STATES = ['loading', 'ready', 'empty', 'partial', 'truncated', 'stale', 'authentication', 'permission', 'missing', 'malformed', 'unsupported', 'error', 'unavailable'] as const;

export type ExtensionTelemetryEvent = typeof TELEMETRY_EVENTS[number];

export interface ExtensionTelemetryMetrics {
  durationMs?: number;
  errorCount?: number;
  feature?: typeof FEATURES[number];
  nodeCount?: number;
  pageSize?: number;
  readCount?: number;
  rowCount?: number;
  source?: 'Live' | 'Archive';
  state?: typeof STATES[number];
  view?: 'dag' | 'list' | 'grid';
}

export function telemetryDetail(event: ExtensionTelemetryEvent, metrics: ExtensionTelemetryMetrics = {}) {
  const detail: Record<string, string | number> = {
    event: TELEMETRY_EVENTS.includes(event) ? event : 'unknown',
    version: EXTENSION_VERSION
  };
  for (const key of ['durationMs', 'errorCount', 'nodeCount', 'pageSize', 'readCount', 'rowCount'] as const) {
    const value = metrics[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) detail[key] = value;
  }
  if (metrics.feature && FEATURES.includes(metrics.feature)) detail.feature = metrics.feature;
  if (metrics.source === 'Live' || metrics.source === 'Archive') detail.source = metrics.source;
  if (metrics.state && STATES.includes(metrics.state)) detail.state = metrics.state;
  if (metrics.view === 'dag' || metrics.view === 'list' || metrics.view === 'grid') detail.view = metrics.view;
  return detail;
}

/** Emits anonymous operational facts; resource names, messages, parameters, and URLs are not accepted. */
export function emitExtensionTelemetry(event: ExtensionTelemetryEvent, metrics: ExtensionTelemetryMetrics = {}): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TELEMETRY_EVENT, {detail: telemetryDetail(event, metrics)}));
}

export function telemetryNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}
