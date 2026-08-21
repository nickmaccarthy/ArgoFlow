import React from 'react';

import {argoResourceHref} from './argo-resource-link.ts';
import {WORKFLOW_EXTENSION_STYLES} from './application-workflows-view.ts';
import {eventBusSummary} from './event-bus-resource.ts';
import {EventChainGraphView, EVENT_CHAIN_STYLES} from './event-chain-view.tsx';
import {loadApplicationEventData, type EventChainData} from './event-chain-loader.ts';
import {EVENT_RESOURCE_STYLES} from './event-resource-view.tsx';
import type {EventHealth} from './event-resource.ts';
import {eventSourceSummary} from './event-source-resource.ts';
import type {ApplicationViewExtensionProps} from './host.ts';
import {sensorSummary} from './sensor-resource.ts';
import {emitExtensionTelemetry, telemetryNow} from './telemetry.ts';

type EventKind = 'EventBus' | 'EventSource' | 'Sensor';
interface EventRow { kind: EventKind; name: string; namespace?: string; state: EventHealth; reason: string; }

const APPLICATION_EVENT_STYLES = `
#workflow-extension .event-inventory { margin-top: 1.25rem; }
#workflow-extension .event-inventory h4 { margin: 0 0 .55rem; }
#workflow-extension .event-inventory-toolbar { align-items: end; display: flex; gap: .7rem; margin-bottom: .7rem; }
#workflow-extension .event-inventory-toolbar .wf-field:first-child { flex: 1 1 18rem; }
#workflow-extension .event-inventory-toolbar .wf-field { flex: 0 1 12rem; }
#workflow-extension .event-inventory .wf-event-health { white-space: nowrap; }
@media (max-width: 640px) { #workflow-extension .event-inventory-toolbar { align-items: stretch; flex-direction: column; } #workflow-extension .event-inventory-toolbar .wf-field { width: 100%; } }
`;

export interface ApplicationEventsViewProps extends ApplicationViewExtensionProps { baseUrl?: string; fetcher?: typeof fetch; }

export function applicationEventRows(data?: EventChainData): EventRow[] {
  if (!data) return [];
  return [
    ...data.buses.map(bus => { const summary = eventBusSummary(bus); return {kind: 'EventBus' as const, name: summary.name || 'Unnamed EventBus', namespace: summary.namespace, state: summary.health.state, reason: summary.health.reason}; }),
    ...data.sources.map(source => { const summary = eventSourceSummary(source); return {kind: 'EventSource' as const, name: summary.name || 'Unnamed EventSource', namespace: summary.namespace, state: summary.health.state, reason: summary.health.reason}; }),
    ...data.sensors.map(sensor => { const summary = sensorSummary(sensor); return {kind: 'Sensor' as const, name: summary.name || 'Unnamed Sensor', namespace: summary.namespace, state: summary.health.state, reason: summary.health.reason}; })
  ].sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
}

function EventStats({rows}: {rows: EventRow[]}) {
  const needsAttention = rows.filter(row => row.state === 'Blocked' || row.state === 'Failed' || row.state === 'Unknown').length;
  const values: Array<[string, number, string]> = [
    ['EventSources', rows.filter(row => row.kind === 'EventSource').length, '#0dadea'],
    ['Sensors', rows.filter(row => row.kind === 'Sensor').length, '#18be94'],
    ['EventBuses', rows.filter(row => row.kind === 'EventBus').length, '#7d5bbe'],
    ['Needs attention', needsAttention, needsAttention ? '#f5a623' : '#18be94']
  ];
  return <div className="wf-stats" aria-label="Event resource summary">{values.map(([label, value, color]) => <div className="wf-stat" key={label} style={{'--wf-accent': color} as React.CSSProperties}><strong>{value}</strong><span>{label}</span></div>)}</div>;
}

function EventInventory({rows}: {rows: EventRow[]}) {
  const [query, setQuery] = React.useState('');
  const [kind, setKind] = React.useState<'' | EventKind>('');
  const [state, setState] = React.useState<'' | EventHealth>('');
  const filtered = rows.filter(row => (!query.trim() || `${row.kind} ${row.name} ${row.namespace || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && (!kind || row.kind === kind) && (!state || row.state === state));
  return <section className="event-inventory" aria-label="Event resource inventory"><h4>Event resources</h4>
    <div className="event-inventory-toolbar">
      <label className="wf-field"><span>Search</span><input type="search" value={query} placeholder="Name, namespace, or type" onChange={event => setQuery(event.currentTarget.value)} /></label>
      <label className="wf-field"><span>Resource type</span><select value={kind} onChange={event => setKind(event.currentTarget.value as '' | EventKind)}><option value="">All types</option><option>EventBus</option><option>EventSource</option><option>Sensor</option></select></label>
      <label className="wf-field"><span>Status</span><select value={state} onChange={event => setState(event.currentTarget.value as '' | EventHealth)}><option value="">All statuses</option><option>Ready</option><option>Active</option><option>Blocked</option><option>Failed</option><option>Unknown</option></select></label>
    </div>
    {filtered.length ? <div className="wf-table-wrap"><table className="wf-event-table"><caption>{filtered.length} Event resources in the loaded Application view</caption><thead><tr>{['Type', 'Resource', 'Namespace', 'Status', 'Evidence'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{filtered.map(row => <tr key={`${row.kind}/${row.namespace || ''}/${row.name}`}><td>{row.kind}</td><td><a className="wf-resource-link" href={argoResourceHref({group: 'argoproj.io', kind: row.kind, namespace: row.namespace, name: row.name}, 'extension-0')}>{row.name}</a></td><td>{row.namespace || '—'}</td><td><span className="wf-event-health" data-state={row.state} title={row.reason}>{row.state}</span></td><td>{row.reason}</td></tr>)}</tbody></table></div> : <p role="status">No Event resources match the current filters.</p>}
  </section>;
}

export function ApplicationEventsView({application, tree, baseUrl, fetcher}: ApplicationEventsViewProps) {
  const [data, setData] = React.useState<EventChainData>();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [refreshToken, setRefreshToken] = React.useState(0);
  const appKey = application?.metadata?.uid || `${application?.metadata?.namespace || ''}/${application?.metadata?.name || ''}`;
  const previousAppKey = React.useRef(appKey);
  React.useEffect(() => {
    if (!application?.metadata?.name) { setData(undefined); setError(undefined); return undefined; }
    if (previousAppKey.current !== appKey) { previousAppKey.current = appKey; setData(undefined); }
    const controller = new AbortController(); const beganAt = telemetryNow(); setLoading(true); setError(undefined);
    loadApplicationEventData({application, tree, baseUrl, fetcher, signal: controller.signal}).then(result => {
      if (controller.signal.aborted) return; setData(result);
      emitExtensionTelemetry('event-chain.loaded', {feature: 'application-events', state: result.state, durationMs: Math.max(0, telemetryNow() - beganAt), readCount: result.identities.length, errorCount: result.errors.length});
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Event resources could not be loaded.'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [application, appKey, baseUrl, fetcher, refreshToken, tree]);
  const rows = React.useMemo(() => applicationEventRows(data), [data]);
  return <section id="workflow-extension" aria-label="Application events" style={{padding: '1rem'}}><style>{WORKFLOW_EXTENSION_STYLES + EVENT_RESOURCE_STYLES + EVENT_CHAIN_STYLES + APPLICATION_EVENT_STYLES}</style>
    <div className="wf-view-header"><div><h3>Events</h3><p>{application?.metadata?.name || 'Selected Application'} · Event infrastructure, routing, and verified Workflow chains</p></div><button className="wf-refresh" type="button" onClick={() => setRefreshToken(value => value + 1)}>Refresh</button></div>
    {!application?.metadata?.name ? <p role="alert">Events are unavailable until the host supplies an Application.</p> : null}
    {data ? <><EventStats rows={rows} />{loading ? <p className="wf-result-note" role="status">Refreshing Event evidence in place…</p> : null}{error ? <p role="alert">Refresh failed; showing the last loaded evidence.</p> : null}<EventInventory rows={rows} /><EventChainGraphView data={data} heading="Verified event chains" /></> : loading ? <p role="status">Loading bounded Event resources…</p> : error ? <p role="alert">Events could not be loaded: {error}</p> : null}
  </section>;
}
