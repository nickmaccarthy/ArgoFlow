import {decodeNodePhases, NODE_PHASES_HASH_KEY} from './workflow-nodes.ts';
import type {HashState} from './url-state.ts';
import type {WorkflowNode} from './workflow-nodes.ts';
import type {WorkflowPhase} from './workflow-resource.ts';

/** Hash key for the deep-linked view mode. */
export const WORKSPACE_VIEW_HASH_KEY = 'run.view';

/** Hash key for the query string. */
export const WORKSPACE_QUERY_HASH_KEY = 'run.q';

/** Hash key for the selected node id. */
export const WORKSPACE_NODE_HASH_KEY = 'run.node';

/** Deep-linked workspace view mode. */
export type WorkspaceViewMode = 'dag' | 'list' | 'grid';

/** Coerces a deep-linked view id; DAG stays unavailable above the node budget. */
export function coerceWorkspaceView(value: string | undefined, largeWorkflow: boolean): WorkspaceViewMode {
  if (largeWorkflow) return value === 'grid' ? 'grid' : 'list';
  return value === 'list' || value === 'grid' ? value : 'dag';
}

/** Reconciled workspace hash state decoded from the URL hash. */
export interface WorkspaceHashState {
  view: WorkspaceViewMode;
  query: string;
  phases: WorkflowPhase[];
  selectedId?: string;
}

/**
 * Decodes the full workspace hash state through the same codecs the component uses.
 * This is the single source of truth for both the mount path and the reconciliation
 * path — a mounted view and an externally-navigated view both go through this
 * decoder, ensuring they stay in sync without fighting their own patches.
 */
export function decodeWorkspaceHash(
  hashState: HashState,
  options: {largeWorkflow: boolean; nodes: readonly WorkflowNode[]}
): WorkspaceHashState {
  const view = coerceWorkspaceView(hashState[WORKSPACE_VIEW_HASH_KEY], options.largeWorkflow);
  const query = hashState[WORKSPACE_QUERY_HASH_KEY] ?? '';
  const phases = decodeNodePhases(hashState[NODE_PHASES_HASH_KEY]);
  const linked = hashState[WORKSPACE_NODE_HASH_KEY];
  const selectedId = linked && options.nodes.some(node => node.id === linked) ? linked : undefined;
  return {view, query, phases, selectedId};
}

/** Mount-time nicety: returns the id of the first Running non-DAG node.
 * Used as the fallback for `selectedId` when the hash does not contain a valid
 * node reference — this fallback does NOT apply during reconciliation (see
 * `decodeWorkspaceHash`), which is URL-authoritative.
 */
export function defaultSelectedNodeId(nodes: readonly WorkflowNode[]): string | undefined {
  return nodes.find(node => node.phase === 'Running' && node.type !== 'DAG')?.id;
}