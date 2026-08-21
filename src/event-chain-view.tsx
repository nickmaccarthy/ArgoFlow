import React from 'react';

import {argoResourceHref} from './argo-resource-link.ts';
import {buildEventChainGraph, EVENT_CHAIN_CARD_LIMIT, EVENT_CHAIN_LIST_LIMIT, filterEventChainGraph, layoutEventChainGraph, type EventChainNode, type EventChainNodeKind} from './event-chain-graph.ts';
import {loadEventChainData, type EventChainData, type EventChainKind} from './event-chain-loader.ts';
import {eventBusManifest} from './event-bus-resource.ts';
import {eventSourceManifest} from './event-source-resource.ts';
import type {EventHealth} from './event-resource.ts';
import {GraphIconButton} from './graph-controls.tsx';
import type {ApplicationState, ApplicationTree, ResourceState} from './host.ts';
import {sensorManifest} from './sensor-resource.ts';
import {emitExtensionTelemetry, telemetryNow} from './telemetry.ts';
import {WORKFLOW_ARROW_MARKER, WORKFLOW_ARROW_PATH, workflowEdgePath} from './workflow-graph.ts';

const EVENT_STATE_COLOR = {Ready: '#18BE94', Active: '#0DADEA', Blocked: '#F5A623', Failed: '#E96D76', Unknown: '#6D7F8B'} as const;

interface ViewBox { x: number; y: number; width: number; height: number; }

export const EVENT_CHAIN_STYLES = `
#workflow-extension .event-chain { margin: 1.5rem 0; min-width: 0; }
#workflow-extension .event-chain h3 { margin: 0 0 .45rem; }
#workflow-extension .event-chain-status { background: rgba(109,127,139,.08); border-inline-start: 3px solid var(--wf-muted); margin: .65rem 0; padding: .65rem .8rem; }
#workflow-extension .event-chain-status p { margin: .2rem 0 0; }
#workflow-extension .event-chain-toolbar { align-items: end; background: var(--wf-panel); border: 1px solid var(--wf-border); border-radius: 4px 4px 0 0; display: flex; flex-wrap: wrap; gap: .65rem; padding: .65rem .75rem; }
#workflow-extension .event-chain-toolbar .wf-field { flex: 1 1 10rem; }
#workflow-extension .event-chain-toolbar .wf-field:first-child { flex-basis: 15rem; }
#workflow-extension .event-chain-actions { align-items: center; display: flex; gap: .35rem; margin-inline-start: auto; }
#workflow-extension .event-chain-frame { min-width: 0; position: relative; }
#workflow-extension .event-chain-graph-wrap { background: var(--wf-panel); border: 1px solid var(--wf-border); border-radius: 0 0 5px 5px; min-height: 30rem; overflow: hidden; }
#workflow-extension .event-chain-graph { display: block; height: 34rem; touch-action: none; width: 100%; }
#workflow-extension .event-chain-graph [role="button"] { cursor: pointer; }
#workflow-extension .event-chain-graph [role="button"]:focus { outline: none; }
#workflow-extension .event-chain-graph [role="button"]:focus rect { stroke: #0b74de; stroke-width: 4; }
#workflow-extension .event-chain-card { fill: var(--wf-panel); opacity: 1; }
#workflow-extension .event-chain-card-state { font-size: 11px; font-weight: 700; }
#workflow-extension .event-chain-detail { background: var(--wf-panel); border: 1px solid var(--wf-border); border-radius: 4px; box-shadow: 0 4px 16px rgba(20,40,55,.2); max-width: 24rem; padding: .75rem .85rem; position: absolute; right: .75rem; top: .75rem; z-index: 2; }
#workflow-extension .event-chain-detail-head { align-items: flex-start; display: flex; gap: .65rem; }
#workflow-extension .event-chain-detail-head strong { overflow-wrap: anywhere; }
#workflow-extension .event-chain-detail-head button { cursor: pointer; margin-inline-start: auto; min-height: 1.7rem; min-width: 1.7rem; padding: 0 .35rem; }
#workflow-extension .event-chain-detail p { margin: .45rem 0; overflow-wrap: anywhere; }
#workflow-extension .event-chain-detail a { display: inline-block; margin-top: .2rem; }
#workflow-extension .event-chain-list { background: var(--wf-panel); border: 1px solid var(--wf-border); border-radius: 0 0 4px 4px; padding: .65rem .8rem; }
#workflow-extension .event-chain-unresolved { margin-top: .8rem; padding: .35rem .15rem .6rem; }
#workflow-extension .event-chain-unresolved summary { cursor: pointer; font-weight: 600; }
#workflow-extension .event-chain-unresolved p { color: var(--wf-muted); margin: .4rem 0; }
#workflow-extension .event-chain-unresolved ul { margin: .4rem 0; padding-inline-start: 1.35rem; }
#workflow-extension .event-chain-state { color: var(--wf-muted); font-size: .9rem; }
@media (max-width: 640px) { #workflow-extension .event-chain-graph { height: 28rem; } #workflow-extension .event-chain-detail { left: .75rem; max-width: none; right: .75rem; } }
`;

interface EventChainViewProps { application?: ApplicationState; tree?: ApplicationTree; resource?: ResourceState; kind: EventChainKind; }

function nodeHref(node: EventChainNode): string | undefined {
  if (node.kind === 'Dependency' || node.kind === 'Trigger') return undefined;
  return argoResourceHref({group: node.kind === 'Pod' ? undefined : 'argoproj.io', kind: node.kind, namespace: node.namespace, name: node.name}, node.kind === 'Workflow' ? 'extension-0' : undefined);
}

function nodeLabel(node: EventChainNode): string { return `${node.kind}: ${node.name} — ${node.state}`; }

export function ChainLoadNotice({data}: {data: EventChainData}) {
  const messages: Partial<Record<EventChainData['state'], string>> = {
    authentication: 'Authentication is required to read related Event resources.', permission: 'You do not have permission to read related Event resources.',
    missing: 'One or more related Event resources were not found.', malformed: 'One or more related Event resources returned malformed data.',
    stale: 'Related Event resources may be stale while the Application tree catches up.', partial: 'Some related Event resources could not be read; the chain is partial.',
    truncated: `Only the first bounded related resources are shown; ${data.truncatedCount} more were not read.`, empty: 'No Event resources were found in this Application.',
    error: 'Related Event resources could not be loaded.'
  };
  const message = messages[data.state];
  return message ? <p className="event-chain-state" role={['stale', 'partial', 'truncated', 'empty'].includes(data.state) ? 'status' : 'alert'}>{message}</p> : null;
}

function ChainStatus({blocked}: {blocked: ReturnType<typeof buildEventChainGraph>['chain']['firstBlockedHop']}) {
  if (!blocked) return <div className="event-chain-status" role="status"><strong>Verified through available evidence</strong><p>Every displayed connection is supported by resource configuration or controller status.</p></div>;
  const guidance = blocked.state === 'Unknown'
    ? 'Argo did not expose enough controller evidence to verify the next step. The connection is not counted as healthy; inspect the Sensor status or trigger logs.'
    : 'Resolve this hop before expecting later resources to run.';
  return <div className="event-chain-status" role="status"><strong>Chain status: {blocked.state}</strong><p>{blocked.kind} {blocked.name || ''}: {blocked.reason} {guidance}</p></div>;
}

export function EventChainGraphView({data, resource, kind, heading = 'Verified event chain'}: {data: EventChainData; resource?: ResourceState; kind?: EventChainKind; heading?: string}) {
  const selectedManifest = kind === 'EventSource' ? eventSourceManifest(resource) : kind === 'Sensor' ? sensorManifest(resource) : kind === 'EventBus' ? eventBusManifest(resource) : undefined;
  const selection = React.useMemo(() => kind ? ({kind, name: selectedManifest?.metadata?.name, namespace: selectedManifest?.metadata?.namespace}) : undefined, [kind, selectedManifest?.metadata?.name, selectedManifest?.metadata?.namespace]);
  const graph = React.useMemo(() => buildEventChainGraph(data.sources, data.sensors, data.workflows, selection), [data, selection]);
  const [selectedId, setSelectedId] = React.useState<string>();
  const [query, setQuery] = React.useState('');
  const [branch, setBranch] = React.useState('');
  const [nodeKind, setNodeKind] = React.useState<'' | EventChainNodeKind>('');
  const [state, setState] = React.useState<'' | EventHealth>('');
  const filteredGraph = React.useMemo(() => filterEventChainGraph(graph, {query, branch, kind: nodeKind, state}), [graph, query, branch, nodeKind, state]);
  const selected = filteredGraph.nodes.find(node => node.id === selectedId);
  const layout = React.useMemo(() => layoutEventChainGraph(filteredGraph), [filteredGraph]);
  const fit = React.useMemo<ViewBox>(() => ({x: 0, y: 0, width: Math.max(layout.width, 240), height: Math.max(layout.height, 180)}), [layout]);
  const [viewBox, setViewBox] = React.useState(fit);
  const layoutKey = filteredGraph.nodes.map(node => node.id).join('\u0000');
  const previousLayoutKey = React.useRef(layoutKey);
  const drag = React.useRef<{x: number; y: number; viewBox: ViewBox}>();
  React.useEffect(() => { if (previousLayoutKey.current !== layoutKey) { previousLayoutKey.current = layoutKey; setViewBox(fit); } }, [fit, layoutKey]);
  React.useEffect(() => { if (selectedId && !graph.nodes.some(node => node.id === selectedId)) setSelectedId(undefined); }, [graph, selectedId]);
  const positions = new Map(layout.positions.map(position => [position.id, position]));
  const visibleNodes = filteredGraph.nodes.slice(0, EVENT_CHAIN_CARD_LIMIT);
  const visibleIds = new Set(visibleNodes.map(node => node.id));
  const visibleEdges = filteredGraph.edges.filter(edge => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  const sensorBranches = graph.nodes.filter(node => node.kind === 'Sensor');
  const zoom = (factor: number) => setViewBox(box => { const width = box.width * factor; const height = box.height * factor; return {x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height}; });
  const keyboardSelect = (event: React.KeyboardEvent<SVGGElement>, id: string) => { if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); setSelectedId(id); };

  return <section className="event-chain" aria-label={heading}>
    <h3>{heading}</h3><ChainStatus blocked={graph.chain.firstBlockedHop} /><ChainLoadNotice data={data} />
    {data.errors.length ? <p role="status">{data.errors.length} exact resource read{data.errors.length === 1 ? '' : 's'} could not be completed.</p> : null}
    <div className="event-chain-toolbar" aria-label="Event chain filters">
      <label className="wf-field"><span>Search</span><input type="search" value={query} placeholder="Name or resource type" onChange={event => setQuery(event.currentTarget.value)} /></label>
      <label className="wf-field"><span>Sensor branch</span><select value={branch} onChange={event => setBranch(event.currentTarget.value)}><option value="">All branches</option>{sensorBranches.map(sensor => <option value={sensor.id} key={sensor.id}>{sensor.name}</option>)}</select></label>
      <label className="wf-field"><span>Resource type</span><select value={nodeKind} onChange={event => setNodeKind(event.currentTarget.value as '' | EventChainNodeKind)}><option value="">All types</option>{['EventSource', 'Dependency', 'Sensor', 'Trigger', 'Workflow', 'Pod'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="wf-field"><span>Status</span><select value={state} onChange={event => setState(event.currentTarget.value as '' | EventHealth)}><option value="">All statuses</option>{Object.keys(EVENT_STATE_COLOR).map(value => <option key={value}>{value}</option>)}</select></label>
      <div className="event-chain-actions" aria-label="Graph controls"><GraphIconButton action="zoom-in" onClick={() => zoom(.8)} /><GraphIconButton action="zoom-out" onClick={() => zoom(1.25)} /><GraphIconButton action="fit" onClick={() => setViewBox(fit)} /></div>
    </div>
    {filteredGraph.nodes.length > EVENT_CHAIN_CARD_LIMIT ? <ChainList nodes={filteredGraph.nodes} selectedId={selectedId} select={setSelectedId} /> : <div className="event-chain-frame">
      <div className="event-chain-graph-wrap"><svg className="event-chain-graph" viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`} role="group" aria-label="Verified event chain graph"
        onPointerDown={event => { if (event.target === event.currentTarget) { event.currentTarget.setPointerCapture(event.pointerId); drag.current = {x: event.clientX, y: event.clientY, viewBox}; } }}
        onPointerMove={event => { if (!drag.current) return; const scaleX = viewBox.width / event.currentTarget.clientWidth; const scaleY = viewBox.height / event.currentTarget.clientHeight; setViewBox({...viewBox, x: drag.current.viewBox.x - (event.clientX - drag.current.x) * scaleX, y: drag.current.viewBox.y - (event.clientY - drag.current.y) * scaleY}); }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); drag.current = undefined; }} onPointerLeave={() => { drag.current = undefined; }}>
        <defs><marker id="event-chain-arrow" {...WORKFLOW_ARROW_MARKER}><path d={WORKFLOW_ARROW_PATH} fill="currentColor" /></marker></defs>
        {visibleEdges.map(edge => { const from = positions.get(edge.from); const to = positions.get(edge.to); return from && to ? <path key={`${edge.from}:${edge.to}`} d={workflowEdgePath(from, to)} fill="none" stroke="currentColor" markerEnd="url(#event-chain-arrow)" aria-label={edge.label ? `Verified edge: ${edge.label}` : 'Verified edge'} /> : null; })}
        {visibleNodes.map(node => { const position = positions.get(node.id); if (!position) return null; const selectedNode = selectedId === node.id; return <g key={node.id} transform={`translate(${position.x} ${position.y})`} role="button" tabIndex={0} aria-label={nodeLabel(node)} aria-pressed={selectedNode} onClick={() => setSelectedId(node.id)} onKeyDown={event => keyboardSelect(event, node.id)}><rect className="event-chain-card" width="180" height="60" rx="5" stroke={EVENT_STATE_COLOR[node.state]} strokeWidth={selectedNode ? 3 : 2} /><text x="10" y="19" fill="currentColor">{node.kind}</text><text x="10" y="37" fill="currentColor">{node.name.slice(0, 22)}</text><text className="event-chain-card-state" x="10" y="53" fill="currentColor">State: {node.state}</text></g>; })}
      </svg></div>{selected ? <ChainDetail node={selected} close={() => setSelectedId(undefined)} /> : null}
    </div>}
    {!filteredGraph.nodes.length ? <p role="status">No event-chain cards match the current filters.</p> : null}
    {graph.unresolved.length ? <details className="event-chain-unresolved"><summary>Connections needing evidence ({graph.unresolved.length})</summary><p>These expected links could not be proven from the loaded resource metadata. They are omitted from the graph and are not counted as healthy.</p><ul>{graph.unresolved.map(item => <li key={`${item.label}:${item.reason}`}><strong>{item.label} → next resource:</strong> {item.reason}</li>)}</ul></details> : null}
  </section>;
}

function ChainList({nodes, selectedId, select}: {nodes: EventChainNode[]; selectedId?: string; select(id: string): void}) {
  return <div className="event-chain-list" role="region" aria-label="Event chain list fallback"><p role="status">The graph has {nodes.length} cards; showing the first {EVENT_CHAIN_LIST_LIMIT} in a bounded list.</p><ol>{nodes.slice(0, EVENT_CHAIN_LIST_LIMIT).map(node => <li key={node.id}><button type="button" aria-pressed={selectedId === node.id} onClick={() => select(node.id)}>{nodeLabel(node)}</button></li>)}</ol></div>;
}

function ChainDetail({node, close}: {node: EventChainNode; close(): void}) {
  const href = nodeHref(node);
  return <aside className="event-chain-detail" role="dialog" aria-label={`${node.kind} details`} aria-live="polite"><div className="event-chain-detail-head"><strong>{nodeLabel(node)}</strong><button type="button" aria-label="Close node details" title="Close" onClick={close}>×</button></div>{node.reason ? <p>{node.reason}</p> : null}{href ? <a href={href}>Open {node.kind}</a> : null}</aside>;
}

class EventChainErrorBoundary extends React.Component<{children: React.ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  componentDidCatch() { emitExtensionTelemetry('render.failed', {feature: 'event-chain', state: 'error'}); }
  render() { return this.state.failed ? <><style>{EVENT_CHAIN_STYLES}</style><p className="event-chain-state" role="alert">Event chain could not be rendered.</p></> : this.props.children; }
}

function EventChainContent({application, tree, resource, kind}: EventChainViewProps) {
  const [data, setData] = React.useState<EventChainData>();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const resolvedResource = React.useMemo(() => { const manifest = kind === 'EventSource' ? eventSourceManifest(resource) : kind === 'Sensor' ? sensorManifest(resource) : eventBusManifest(resource); return manifest ? {...resource, ...manifest, metadata: {...resource?.metadata, ...manifest.metadata}} as ResourceState : resource; }, [kind, resource]);
  React.useEffect(() => {
    const controller = new AbortController(); const beganAt = telemetryNow(); setLoading(true); setError(undefined);
    emitExtensionTelemetry('event-chain.query', {feature: 'event-chain', state: 'loading'});
    loadEventChainData({application, tree, resource: resolvedResource, kind, signal: controller.signal}).then(result => {
      if (controller.signal.aborted) return; setData(result);
      emitExtensionTelemetry('event-chain.loaded', {feature: 'event-chain', state: result.state, durationMs: Math.max(0, telemetryNow() - beganAt), readCount: result.identities.length, errorCount: result.errors.length, nodeCount: result.sources.length + result.sensors.length + result.buses.length + result.workflows.length});
    }).catch(() => { if (controller.signal.aborted) return; setError('Related resources could not be loaded.'); emitExtensionTelemetry('event-chain.loaded', {feature: 'event-chain', state: 'error', durationMs: Math.max(0, telemetryNow() - beganAt), errorCount: 1}); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [application, tree, resolvedResource, kind]);
  if (error && !data) return <><style>{EVENT_CHAIN_STYLES}</style><p className="event-chain-state" role="alert">Event chain could not be loaded: {error}</p></>;
  if (!data) return <><style>{EVENT_CHAIN_STYLES}</style><p className="event-chain-state" role="status" aria-live="polite">Loading bounded related Event resources…</p></>;
  return <><style>{EVENT_CHAIN_STYLES}</style>{loading ? <p className="event-chain-state" role="status">Refreshing event evidence…</p> : null}{error ? <p className="event-chain-state" role="alert">Refresh failed; showing the last loaded evidence.</p> : null}<EventChainGraphView data={data} resource={resolvedResource} kind={kind} /></>;
}

/** Read-only, host-safe chain surface. Resource tabs own the surrounding summary and wiring. */
export function EventChainView(props: EventChainViewProps) { return <EventChainErrorBoundary><EventChainContent {...props} /></EventChainErrorBoundary>; }
