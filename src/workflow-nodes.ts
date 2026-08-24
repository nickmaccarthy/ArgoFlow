import {
  formatDuration,
  workflowPhase,
  type WorkflowIo,
  type WorkflowManifest,
  type WorkflowPhase
} from './workflow-resource.ts';

export interface SafeIoMetadata {
  parameters: string[];
  artifacts: string[];
}

export interface WorkflowNode {
  id: string;
  name: string;
  displayName: string;
  type: string;
  phase: WorkflowPhase;
  rawPhase?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  duration?: string;
  template?: string;
  podName?: string;
  boundaryId?: string;
  children: string[];
  outboundNodes: string[];
  retryParentId?: string;
  retryChildren: string[];
  attempts: number;
  inputs: SafeIoMetadata;
  outputs: SafeIoMetadata;
}

export function workflowPodName(workflow: WorkflowManifest | undefined, node: {type?: string; templateName?: string}, id: string): string | undefined {
  if (node.type !== 'Pod') return undefined;
  const workflowName = workflow?.metadata?.name;
  const v2 = workflow?.metadata?.annotations?.['workflows.argoproj.io/pod-name-format'] === 'v2';
  if (v2 && workflowName && node.templateName && id.startsWith(`${workflowName}-`)) {
    return `${workflowName}-${node.templateName}${id.slice(workflowName.length)}`;
  }
  return id;
}

export function normalizeWorkflowNodes(workflow?: WorkflowManifest, now = Date.now()): WorkflowNode[] {
  const statuses = workflow?.status?.nodes ?? {};
  const retryParents = new Map<string, string>();
  const byId = new Map<string, NonNullable<(typeof statuses)[string]>>();
  const keyToId = new Map<string, string>();

  for (const [key, rawNode] of Object.entries(statuses)) {
    const node = rawNode ?? {};
    keyToId.set(key, node.id || key);
    byId.set(key, node);
    if (node.id) byId.set(node.id, node);
  }

  for (const [key, rawNode] of Object.entries(statuses)) {
    const node = rawNode ?? {};
    const id = node.id || key;
    if (node.type === 'Retry') {
      for (const child of node.children ?? []) retryParents.set(keyToId.get(child) || child, id);
    }
  }

  return Object.entries(statuses).map(([key, rawNode]) => {
    const node = rawNode ?? {};
    const id = node.id || key;
    const retryParentId = retryParents.get(id) ?? retryParents.get(key);
    const retryChildren = node.type === 'Retry' ? (node.children ?? []).map(child => keyToId.get(child) || child) : [];
    const retryParent = retryParentId ? byId.get(retryParentId) : undefined;

    return {
      id,
      name: node.name || node.displayName || id,
      displayName: node.displayName || node.name || id,
      type: node.type || 'Unknown',
      phase: workflowPhase(node.phase),
      rawPhase: node.phase,
      message: safeMessage(node.message),
      startedAt: node.startedAt,
      finishedAt: node.finishedAt,
      duration: formatDuration(node.startedAt, node.finishedAt, now),
      template: node.templateRef?.name
        ? `${node.templateRef.name}/${node.templateRef.template || node.templateName || ''}`.replace(/\/$/, '')
        : node.templateName,
      podName: workflowPodName(workflow, node, id),
      boundaryId: node.boundaryID ? keyToId.get(node.boundaryID) || node.boundaryID : undefined,
      children: (node.children ?? []).map(child => keyToId.get(child) || child),
      outboundNodes: (node.outboundNodes ?? []).map(child => keyToId.get(child) || child),
      retryParentId,
      retryChildren,
      attempts: retryChildren.length || retryParent?.children?.length || 1,
      inputs: safeIo(node.inputs),
      outputs: safeIo(node.outputs)
    };
  });
}

/** Dependencies define sequence; controller start times order nodes that become runnable together. */
export function orderWorkflowNodesForDisplay(nodes: WorkflowNode[]): WorkflowNode[] {
  const ids = new Set(nodes.map(node => node.id));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const incoming = new Map(nodes.map(node => [node.id, 0]));
  const outgoing = new Map<string, string[]>();

  for (const node of nodes) {
    const children = [...new Set([...node.children, ...node.outboundNodes])].filter(id => id !== node.id && ids.has(id));
    outgoing.set(node.id, children);
    for (const child of children) incoming.set(child, (incoming.get(child) ?? 0) + 1);
  }

  const byStartTime = (a: string, b: string) => {
    const left = Date.parse(byId.get(a)?.startedAt || '');
    const right = Date.parse(byId.get(b)?.startedAt || '');
    if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
    if (Number.isFinite(left)) return -1;
    if (Number.isFinite(right)) return 1;
    return 0;
  };
  let ready = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id).sort(byStartTime);
  const ordered: string[] = [];
  const visited = new Set<string>();

  while (ready.length) {
    const next: string[] = [];
    for (const id of ready) {
      if (visited.has(id)) continue;
      visited.add(id);
      ordered.push(id);
      for (const child of outgoing.get(id) ?? []) {
        incoming.set(child, (incoming.get(child) ?? 1) - 1);
        if (incoming.get(child) === 0) next.push(child);
      }
    }
    ready = next.sort(byStartTime);
  }

  for (const node of nodes) if (!visited.has(node.id)) ordered.push(node.id);
  return ordered.flatMap(id => byId.get(id) ?? []);
}

export function safeMessage(message?: string): string | undefined {
  if (!message) return undefined;
  return message
    .replace(/\b(bearer)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(/\b(token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 500);
}

export function filterWorkflowNodes(nodes: WorkflowNode[], query: string, phase?: WorkflowPhase | readonly WorkflowPhase[]): WorkflowNode[] {
  const needle = query.trim().toLocaleLowerCase();
  const phases = Array.isArray(phase) ? phase : phase ? [phase] : [];
  return nodes.filter(node => {
    const matchesPhase = !phases.length || phases.includes(node.phase);
    const matchesQuery =
      !needle ||
      [node.name, node.displayName, node.type, node.template, node.message].some(value =>
        value?.toLocaleLowerCase().includes(needle)
      );
    return matchesPhase && matchesQuery;
  });
}

/** Hash key holding the comma-joined node-phase filter for deep links. */
export const NODE_PHASES_HASH_KEY = 'run.phases';

const NODE_PHASES_ALLOWED: Record<string, true> = {
  Pending: true,
  Running: true,
  Succeeded: true,
  Failed: true,
  Error: true,
  Skipped: true,
  Omitted: true,
  Unknown: true
} satisfies Record<WorkflowPhase, true>;

/** Serializes selected node-phase filters; an empty selection stays out of the hash. */
export function encodeNodePhases(phases: readonly WorkflowPhase[]): string | undefined {
  const unique = [...new Set(phases)].filter(phase => NODE_PHASES_ALLOWED[phase]);
  return unique.length ? unique.join(',') : undefined;
}

/**
 * Restores node-phase filters from the hash on a hard reload, silently
 * dropping unknown or malformed values instead of breaking the view.
 */
export function decodeNodePhases(value: string | undefined): WorkflowPhase[] {
  if (!value) return [];
  return [...new Set(value.split(',').map(phase => phase.trim()).filter(phase => NODE_PHASES_ALLOWED[phase]))] as WorkflowPhase[];
}

function safeIo(io?: WorkflowIo): SafeIoMetadata {
  return {
    parameters: io?.parameters?.flatMap(item => (item.name ? [item.name] : [])) ?? [],
    artifacts: io?.artifacts?.flatMap(item => (item.name ? [item.name] : [])) ?? []
  };
}
