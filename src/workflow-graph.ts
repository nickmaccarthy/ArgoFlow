import type {WorkflowNode} from './workflow-nodes';

export interface GraphPosition {
  id: string;
  x: number;
  y: number;
}

export interface WorkflowGraphLayout {
  positions: GraphPosition[];
  edges: Array<{from: string; to: string}>;
  width: number;
  height: number;
}

const CARD_WIDTH = 180;
const CARD_HEIGHT = 60;
const EDGE_CLEARANCE = 12;
const ARROW_LENGTH = 8;
const JOIN_SPREAD = 24;

export const WORKFLOW_ARROW_MARKER = {
  markerHeight: 8,
  markerUnits: 'userSpaceOnUse' as const,
  markerWidth: 8,
  orient: 'auto' as const,
  overflow: 'visible',
  refX: 8,
  refY: 4,
  viewBox: '0 0 8 8'
};
export const WORKFLOW_ARROW_PATH = 'M 0 0 L 8 4 L 0 8 Z';

/** Curved departure with a target-aware final tangent keeps marker and edge visually continuous. */
export function workflowEdgePath(from: GraphPosition, to: GraphPosition): string {
  const startX = from.x + CARD_WIDTH / 2;
  const startY = from.y + CARD_HEIGHT + EDGE_CLEARANCE;
  const targetCenterX = to.x + CARD_WIDTH / 2;
  const endX = targetCenterX + Math.min(JOIN_SPREAD, Math.max(-JOIN_SPREAD, (startX - targetCenterX) / 8));
  const endY = to.y - EDGE_CLEARANCE;
  const direction = endY >= startY ? 1 : -1;
  const bend = Math.min(24, Math.max(8, Math.round(Math.abs(endY - startY) / 3)));
  const approachX = endX + Math.min(40, Math.max(-40, (startX - endX) / 5));
  const approachY = endY - direction * bend;
  const approachLength = Math.hypot(endX - approachX, endY - approachY);
  const tailX = endX - (endX - approachX) / approachLength * ARROW_LENGTH;
  const tailY = endY - (endY - approachY) / approachLength * ARROW_LENGTH;
  const rounded = (value: number) => Math.round(value * 100) / 100;
  return `M ${startX} ${startY} C ${startX} ${startY + direction * bend}, ${rounded(approachX)} ${approachY}, ${rounded(tailX)} ${rounded(tailY)} L ${rounded(endX)} ${endY}`;
}

export function layoutWorkflowGraph(nodes: WorkflowNode[]): WorkflowGraphLayout {
  const ids = new Set(nodes.map(node => node.id));
  const edges = nodes.flatMap(node =>
    [...new Set([...node.children, ...node.outboundNodes])]
      .filter(child => ids.has(child))
      .map(child => ({from: node.id, to: child}))
  );
  const incoming = new Map(nodes.map(node => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  for (const edge of edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);

  const depths = new Map<string, number>();
  const queue = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  for (const id of queue) depths.set(id, 0);

  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    const depth = depths.get(id) ?? 0;
    for (const child of outgoing.get(id) ?? []) {
      depths.set(child, Math.max(depths.get(child) ?? 0, depth + 1));
      incoming.set(child, (incoming.get(child) ?? 1) - 1);
      if (incoming.get(child) === 0) queue.push(child);
    }
  }

  for (const node of nodes) if (!depths.has(node.id)) depths.set(node.id, 0);
  const levels = new Map<number, string[]>();
  for (const node of nodes) {
    const depth = depths.get(node.id) ?? 0;
    levels.set(depth, [...(levels.get(depth) ?? []), node.id]);
  }

  const maxAcross = Math.max(1, ...[...levels.values()].map(level => level.length));
  const maxDepth = Math.max(0, ...levels.keys());
  const width = Math.max(220, maxAcross * 220);
  const height = Math.max(100, (maxDepth + 1) * 110);
  const positions = [...levels.entries()].flatMap(([depth, level]) =>
    level.map((id, index) => ({
      id,
      x: (width - level.length * 200) / 2 + index * 200 + 10,
      y: depth * 110 + 10
    }))
  );

  return {positions, edges, width, height};
}
