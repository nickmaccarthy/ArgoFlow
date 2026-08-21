import {layoutWorkflowGraph, type WorkflowGraphLayout} from './workflow-graph.ts';
import type {WorkflowNode} from './workflow-nodes.ts';
import {correlateEventChain, dependencyCorrelation, type EventChain} from './event-correlation.ts';
import {eventSourceSummary, type EventSourceManifest} from './event-source-resource.ts';
import {sensorDependencies, sensorSummary, sensorTriggers, type SensorManifest} from './sensor-resource.ts';
import {workflowPodName} from './workflow-nodes.ts';
import type {WorkflowManifest} from './workflow-resource.ts';
import {safeEventText, type EventHealth} from './event-resource.ts';

export const EVENT_CHAIN_CARD_LIMIT = 100;
export const EVENT_CHAIN_LIST_LIMIT = 40;

export type EventChainNodeKind = 'EventSource' | 'Dependency' | 'Sensor' | 'Trigger' | 'Workflow' | 'Pod';

export interface EventChainNode {
  id: string;
  kind: EventChainNodeKind;
  name: string;
  namespace?: string;
  state: EventHealth;
  reason?: string;
}

export interface EventChainEdge {
  from: string;
  to: string;
  label?: string;
  confidence: 'verified';
}

export interface EventChainGraph {
  nodes: EventChainNode[];
  edges: EventChainEdge[];
  unresolved: Array<{label: string; reason: string}>;
  chain: EventChain;
  totalNodeCount: number;
  truncated: boolean;
}

export interface EventChainSelection {
  kind: 'EventSource' | 'Sensor' | 'EventBus';
  name?: string;
  namespace?: string;
}

export interface EventChainFilters {
  branch?: string;
  kind?: '' | EventChainNodeKind;
  state?: '' | EventHealth;
  query?: string;
}

/** Keeps verified upstream context while narrowing a graph to a branch or matching cards. */
export function filterEventChainGraph(graph: EventChainGraph, filters: EventChainFilters): EventChainGraph {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const branchIds = new Set(graph.nodes.map(node => node.id));
  if (filters.branch) {
    branchIds.clear();
    collect(filters.branch, incoming, branchIds);
    const descendants = new Set<string>();
    collect(filters.branch, outgoing, descendants);
    for (const id of descendants) branchIds.add(id);
  }
  const query = filters.query?.trim().toLocaleLowerCase();
  if (!query && !filters.kind && !filters.state) return subsetGraph(graph, branchIds);
  const visible = new Set<string>();
  for (const node of graph.nodes) {
    if (!branchIds.has(node.id)) continue;
    const matches = (!query || `${node.kind} ${node.name}`.toLocaleLowerCase().includes(query))
      && (!filters.kind || node.kind === filters.kind)
      && (!filters.state || node.state === filters.state);
    if (matches) collect(node.id, incoming, visible, branchIds);
  }
  return subsetGraph(graph, visible);
}

function collect(id: string, links: Map<string, string[]>, found: Set<string>, allowed?: Set<string>): void {
  if (found.has(id) || (allowed && !allowed.has(id))) return;
  found.add(id);
  for (const next of links.get(id) ?? []) collect(next, links, found, allowed);
}

function subsetGraph(graph: EventChainGraph, ids: Set<string>): EventChainGraph {
  return {...graph, nodes: graph.nodes.filter(node => ids.has(node.id)), edges: graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to))};
}

export function buildEventChainGraph(
  sources: readonly EventSourceManifest[],
  sensors: readonly SensorManifest[],
  workflows: readonly WorkflowManifest[],
  selection?: EventChainSelection
): EventChainGraph {
  ({sources, sensors} = scopedResources(sources, sensors, selection));
  const chain = correlateEventChain(sources, sensors, workflows);
  if (!chain.firstBlockedHop && selection?.kind === 'Sensor') {
    const outside = sensors.flatMap(sensorTriggers).find(trigger => trigger.targetKind !== 'Workflow' || !trigger.targetApiVersion?.startsWith('argoproj.io/'));
    if (outside) chain.firstBlockedHop = {kind: 'Trigger', name: outside.name, state: 'Unknown', reason: `Trigger target ${outside.targetApiVersion || 'unknown'}/${outside.targetKind || 'unknown'} is not an Argo Workflow`};
  }
  const nodes: EventChainNode[] = [];
  const edges: EventChainEdge[] = [];
  const unresolved: EventChainGraph['unresolved'] = [];
  const sourceIds = new Map<string, string>();
  const sensorIds = new Map<string, string>();
  const triggerIds = new Map<string, string>();

  let totalNodeCount = 0;
  let truncated = false;
  const addNode = (node: EventChainNode): boolean => {
    totalNodeCount += 1;
    if (nodes.length >= EVENT_CHAIN_CARD_LIMIT) {
      truncated = true;
      return false;
    }
    nodes.push(node);
    return true;
  };
  const sourceKey = (namespace: string | undefined, name: string | undefined) => `${namespace || ''}:${name || ''}`;
  const relatedSourceNames = new Set(sensors.flatMap(sensor => sensorDependencies(sensor).flatMap(dependency => dependency.eventSourceName ? [sourceKey(sensor.metadata?.namespace, dependency.eventSourceName)] : [])));
  const shownSources = relatedSourceNames.size ? sources.filter(source => relatedSourceNames.has(sourceKey(source.metadata?.namespace, source.metadata?.name))) : sources;
  for (const source of shownSources) {
    const summary = eventSourceSummary(source);
    if (!summary.name) continue;
    const id = `source:${summary.namespace || ''}:${summary.name}`;
    if (addNode({id, kind: 'EventSource', name: summary.name, namespace: summary.namespace, state: summary.health.state, reason: summary.health.reason})) sourceIds.set(sourceKey(summary.namespace, summary.name), id);
  }
  for (const sensor of sensors) {
    const summary = sensorSummary(sensor);
    if (!summary.name) continue;
    const sensorId = `sensor:${summary.namespace || ''}:${summary.name}`;
    if (!addNode({id: sensorId, kind: 'Sensor', name: summary.name, namespace: summary.namespace, state: summary.health.state, reason: summary.health.reason})) continue;
    sensorIds.set(sourceKey(summary.namespace, summary.name), sensorId);
    for (const dependency of sensorDependencies(sensor)) {
      const id = `dependency:${summary.namespace || ''}:${summary.name}:${dependency.name}`;
      if (!addNode({id, kind: 'Dependency', name: dependency.name, namespace: summary.namespace, state: 'Unknown'})) break;
      const relation = dependencyCorrelation(sensor, dependency.name, sources.find(source => source.metadata?.name === dependency.eventSourceName && source.metadata?.namespace === summary.namespace));
      if (relation?.confidence === 'verified') {
        const sourceId = sourceIds.get(sourceKey(summary.namespace, relation.eventSourceName));
        if (sourceId) edges.push({from: sourceId, to: id, label: relation.eventName, confidence: 'verified'});
        edges.push({from: id, to: sensorId, confidence: 'verified'});
      } else if (relation) {
        unresolved.push({label: `Dependency ${dependency.name}`, reason: relation.reason});
      }
    }
    for (const trigger of sensorTriggers(sensor)) {
      const id = `trigger:${summary.namespace || ''}:${summary.name}:${trigger.name}`;
      const workflowTarget = trigger.targetKind === 'Workflow' && trigger.targetApiVersion?.startsWith('argoproj.io/');
      const reason = workflowTarget ? trigger.health.reason : `Target ${trigger.targetApiVersion || 'unknown'}/${trigger.targetKind || 'unknown'} is outside the Argo Workflow chain`;
      if (!addNode({id, kind: 'Trigger', name: trigger.name, namespace: summary.namespace, state: workflowTarget ? trigger.health.state : 'Unknown', reason})) break;
      triggerIds.set(`${summary.namespace || ''}:${summary.name}:${trigger.name}`, id);
      edges.push({from: sensorId, to: id, confidence: 'verified'});
    }
  }
  for (const relation of chain.workflows) {
    if (relation.confidence !== 'verified' || !relation.workflow || !relation.sensor) {
      if (relation.confidence === 'unresolved') unresolved.push({label: `Trigger ${relation.trigger}`, reason: relation.reason});
      continue;
    }
    const workflow = workflows.find(item => item.metadata?.name === relation.workflow && sensors.some(sensor => sensor.metadata?.name === relation.sensor && sensor.metadata?.namespace === item.metadata?.namespace));
    if (!workflow?.metadata?.name) continue;
    const workflowId = `workflow:${workflow.metadata.namespace || ''}:${workflow.metadata.name}`;
    if (!nodes.some(node => node.id === workflowId)) {
      if (!addNode({id: workflowId, kind: 'Workflow', name: workflow.metadata.name, namespace: workflow.metadata.namespace, state: relation.health || 'Unknown', reason: relation.reason})) continue;
    }
    const triggerId = triggerIds.get(`${workflow.metadata.namespace || ''}:${relation.sensor}:${relation.trigger}`);
    if (triggerId) edges.push({from: triggerId, to: workflowId, confidence: 'verified'});
    appendWorkflowPods(nodes, edges, workflowId, workflow, () => nodes.length < EVENT_CHAIN_CARD_LIMIT, () => { totalNodeCount += 1; truncated = true; });
  }
  if (truncated) nodes.push({id: 'chain:truncated', kind: 'Dependency', name: 'Additional related resources', state: 'Unknown', reason: 'Graph rendering is capped at 100 cards; use the bounded list fallback.'});
  return {nodes, edges, unresolved, chain, totalNodeCount: Math.max(totalNodeCount, nodes.length), truncated};
}

function scopedResources(
  sources: readonly EventSourceManifest[],
  sensors: readonly SensorManifest[],
  selection?: EventChainSelection
): {sources: readonly EventSourceManifest[]; sensors: readonly SensorManifest[]} {
  if (!selection?.name || !selection.namespace) return {sources, sensors};
  const same = (item: {metadata?: {name?: string; namespace?: string}}) => item.metadata?.name === selection.name && item.metadata?.namespace === selection.namespace;
  if (selection.kind === 'EventSource') {
    return {
      sources: sources.filter(same),
      sensors: sensors.filter(sensor => sensor.metadata?.namespace === selection.namespace && sensorDependencies(sensor).some(dependency => dependency.eventSourceName === selection.name))
    };
  }
  if (selection.kind === 'Sensor') {
    const selectedSensors = sensors.filter(same);
    const names = new Set(selectedSensors.flatMap(sensor => sensorDependencies(sensor).map(dependency => dependency.eventSourceName)));
    return {sources: sources.filter(source => source.metadata?.namespace === selection.namespace && names.has(source.metadata?.name)), sensors: selectedSensors};
  }
  return {
    sources: sources.filter(source => source.metadata?.namespace === selection.namespace && eventSourceSummary(source).eventBusName === selection.name),
    sensors: sensors.filter(sensor => sensor.metadata?.namespace === selection.namespace && sensorSummary(sensor).eventBusName === selection.name)
  };
}


export function layoutEventChainGraph(graph: EventChainGraph): WorkflowGraphLayout {
  const visible = graph.nodes.slice(0, EVENT_CHAIN_CARD_LIMIT);
  const visibleIds = new Set(visible.map(node => node.id));
  const byId = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!visibleIds.has(edge.from) || !visibleIds.has(edge.to)) continue;
    byId.set(edge.from, [...(byId.get(edge.from) ?? []), edge.to]);
  }
  const workflowNodes = visible.map(node => ({id: node.id, children: byId.get(node.id) ?? [], outboundNodes: []}) as unknown as WorkflowNode);
  return layoutWorkflowGraph(workflowNodes);
}

function appendWorkflowPods(
  nodes: EventChainNode[],
  edges: EventChainEdge[],
  workflowId: string,
  workflow: WorkflowManifest,
  canAdd: () => boolean,
  truncate: () => void
): void {
  for (const [id, pod] of Object.entries(workflow.status?.nodes ?? {})) {
    if (!pod || pod.type !== 'Pod') continue;
    if (!canAdd()) { truncate(); return; }
    const podName = workflowPodName(workflow, pod, pod.id || id);
    if (!podName) continue;
    const podId = `pod:${workflow.metadata?.namespace || ''}:${podName}`;
    if (nodes.some(node => node.id === podId)) continue;
    const state: EventHealth = pod.phase === 'Succeeded' ? 'Ready' : pod.phase === 'Running' || pod.phase === 'Pending' ? 'Active' : pod.phase === 'Failed' || pod.phase === 'Error' ? 'Failed' : 'Unknown';
    nodes.push({id: podId, kind: 'Pod', name: podName, namespace: workflow.metadata?.namespace, state, reason: safeEventText(pod.message)});
    edges.push({from: workflowId, to: podId, confidence: 'verified'});
  }
}
