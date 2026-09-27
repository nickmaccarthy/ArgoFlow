import React from 'react';

import {WORKFLOW_PHASES, type WorkflowManifest, type WorkflowPhase} from './workflow-resource';
import {WorkflowDagView} from './workflow-dag-view';
import {encodeNodePhases, filterWorkflowNodes, NODE_PHASES_HASH_KEY, normalizeWorkflowNodes, orderWorkflowNodesForDisplay} from './workflow-nodes';
import type {WorkflowNode} from './workflow-nodes';
import {WorkflowNodeDetails, WorkflowNodeFilters, WorkflowNodeGrid, WorkflowNodeList} from './workflow-nodes-view';
import {emitExtensionTelemetry} from './telemetry';
import {useHashState} from './url-state';
import {
  decodeWorkspaceHash,
  defaultSelectedNodeId,
  WORKSPACE_NODE_HASH_KEY,
  WORKSPACE_QUERY_HASH_KEY,
  WORKSPACE_VIEW_HASH_KEY,
  type WorkspaceViewMode
} from './workflow-view-state';

export const DAG_NODE_LIMIT = 250;

export function WorkflowWorkspace({workflow, podHref}: {workflow: WorkflowManifest; podHref?: (node: WorkflowNode) => string | undefined}) {
  const [hashState, patchHash, externalRevision] = useHashState();
  const nodes = React.useMemo(() => orderWorkflowNodesForDisplay(normalizeWorkflowNodes(workflow)), [workflow]);
  const largeWorkflow = nodes.length > DAG_NODE_LIMIT;
  const defaultView: WorkspaceViewMode = largeWorkflow ? 'list' : 'dag';
  const [view, setView] = React.useState<WorkspaceViewMode>(() => decodeWorkspaceHash(hashState, {largeWorkflow, nodes}).view);
  const [query, setQueryRaw] = React.useState<string>(() => decodeWorkspaceHash(hashState, {largeWorkflow, nodes}).query);
  const [phases, setPhasesState] = React.useState<WorkflowPhase[]>(() => decodeWorkspaceHash(hashState, {largeWorkflow, nodes}).phases);
  const [selectedId, setSelectedId] = React.useState<string | undefined>(() => decodeWorkspaceHash(hashState, {largeWorkflow, nodes}).selectedId ?? defaultSelectedNodeId(nodes));
  const filtered = React.useMemo(() => filterWorkflowNodes(nodes, query, phases), [nodes, query, phases]);
  const selected = nodes.find(node => node.id === selectedId);

  const changeView = (next: WorkspaceViewMode) => {
    setView(next);
    // The default view stays out of the hash so clean URLs stay clean.
    patchHash({[WORKSPACE_VIEW_HASH_KEY]: next === defaultView ? undefined : next});
  };

  const selectNode = (id?: string) => {
    setSelectedId(id);
    patchHash({[WORKSPACE_NODE_HASH_KEY]: id});
  };
  const setQuery = (value: string) => {
    setQueryRaw(value);
    patchHash({[WORKSPACE_QUERY_HASH_KEY]: value || undefined});
  };
  // Both filter surfaces route through this wrapper so an active phase
  // selection survives a copied URL / hard reload (issue #6).
  const changePhases = (next: WorkflowPhase[]) => {
    setPhasesState(next);
    patchHash({[NODE_PHASES_HASH_KEY]: encodeNodePhases(next)});
  };

  // A workflow that grew past the DAG budget forces list view; keep the hash
  // truthful. The state initializer already coerces a deep-linked 'dag', so
  // the stale key must be detected through the hash itself, not just the state.
  React.useEffect(() => {
    if (largeWorkflow && (view === 'dag' || hashState[WORKSPACE_VIEW_HASH_KEY] === 'dag')) changeView('list');
  }, [largeWorkflow, view, hashState]);

  // External hash navigation (back/forward, manual edits, host-driven) is
  // authoritative: re-derive local state through the same codecs used on mount.
  // Keyed on externalRevision alone — own patches write through replaceState,
  // which never fires hashchange, so the view cannot fight its own writes. The
  // initial pass is skipped so the mount-time selection default survives.
  React.useEffect(() => {
    if (externalRevision === 0) return;
    const next = decodeWorkspaceHash(hashState, {largeWorkflow, nodes});
    setView(next.view);
    setQueryRaw(next.query);
    setPhasesState(next.phases);
    setSelectedId(next.selectedId);
  }, [externalRevision]);

  React.useEffect(() => emitExtensionTelemetry('workflow.ready', {
    feature: `workflow-${view}`,
    nodeCount: nodes.length,
    view
  }), [nodes.length, view]);

  if (!nodes.length) return <p role="status" aria-live="polite">No workflow nodes are available yet.</p>;

  return (
    <section className="wf-workspace" aria-label="Workflow nodes">
      <div className="wf-workspace-header">
        <h4>Workflow graph</h4>
        <div className="wf-segmented" aria-label="Node view" role="group">
          <button
            type="button"
            aria-pressed={view === 'dag'}
            aria-describedby={largeWorkflow ? 'large-workflow-notice' : undefined}
            disabled={largeWorkflow}
            title={largeWorkflow ? `DAG unavailable above ${DAG_NODE_LIMIT} nodes` : undefined}
            onClick={() => changeView('dag')}
          >DAG</button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => changeView('list')}>List</button>
          <button type="button" aria-pressed={view === 'grid'} onClick={() => changeView('grid')}>Grid</button>
        </div>
      </div>
      <div className="wf-node-toolbar">
        <WorkflowNodeFilters
          query={query}
          selectedPhases={phases}
          phases={[...WORKFLOW_PHASES, 'Unknown']}
          setQuery={setQuery}
          setPhases={changePhases}
        />
      </div>
      {largeWorkflow ? <p id="large-workflow-notice" role="status">DAG is disabled above {DAG_NODE_LIMIT} nodes; use List for details or Grid for the full status overview.</p> : null}
      {view === 'dag' && !largeWorkflow ? (
        <WorkflowDagView nodes={filtered} selectedId={selectedId} onSelect={selectNode} />
      ) : view === 'grid' ? (
        <WorkflowNodeGrid nodes={filtered} selectedId={selectedId} onSelect={selectNode} onFilterPhases={changePhases} />
      ) : (
        <WorkflowNodeList nodes={filtered} onSelect={selectNode} />
      )}
      {selected ? <WorkflowNodeDetails node={selected} onSelect={selectNode} podHref={podHref} /> : null}
    </section>
  );
}
