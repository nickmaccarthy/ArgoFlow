import React from 'react';

import {WORKFLOW_PHASES, type WorkflowManifest, type WorkflowPhase} from './workflow-resource';
import {WorkflowDagView} from './workflow-dag-view';
import {filterWorkflowNodes, normalizeWorkflowNodes, orderWorkflowNodesForDisplay} from './workflow-nodes';
import {WorkflowNodeDetails, WorkflowNodeFilters, WorkflowNodeGrid, WorkflowNodeList} from './workflow-nodes-view';
import {emitExtensionTelemetry} from './telemetry';

export const DAG_NODE_LIMIT = 250;

export function WorkflowWorkspace({workflow, podHref}: {workflow: WorkflowManifest; podHref?: (node: import('./workflow-nodes').WorkflowNode) => string | undefined}) {
  const nodes = React.useMemo(() => orderWorkflowNodesForDisplay(normalizeWorkflowNodes(workflow)), [workflow]);
  const largeWorkflow = nodes.length > DAG_NODE_LIMIT;
  const [view, setView] = React.useState<'dag' | 'list' | 'grid'>(() => largeWorkflow ? 'list' : 'dag');
  const [query, setQuery] = React.useState('');
  const [phases, setPhases] = React.useState<WorkflowPhase[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | undefined>(() => nodes.find(node => node.phase === 'Running' && node.type !== 'DAG')?.id);
  const filtered = React.useMemo(() => filterWorkflowNodes(nodes, query, phases), [nodes, query, phases]);
  const selected = nodes.find(node => node.id === selectedId);

  React.useEffect(() => {
    if (largeWorkflow) setView('list');
  }, [largeWorkflow]);

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
            onClick={() => setView('dag')}
          >DAG</button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
          <button type="button" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>Grid</button>
        </div>
      </div>
      <div className="wf-node-toolbar">
        <WorkflowNodeFilters
          query={query}
          selectedPhases={phases}
          phases={[...WORKFLOW_PHASES, 'Unknown']}
          setQuery={setQuery}
          setPhases={setPhases}
        />
      </div>
      {largeWorkflow ? <p id="large-workflow-notice" role="status">DAG is disabled above {DAG_NODE_LIMIT} nodes; use List for details or Grid for the full status overview.</p> : null}
      {view === 'dag' && !largeWorkflow ? (
        <WorkflowDagView nodes={filtered} selectedId={selectedId} onSelect={setSelectedId} />
      ) : view === 'grid' ? (
        <WorkflowNodeGrid nodes={filtered} selectedId={selectedId} onSelect={setSelectedId} onFilterPhases={setPhases} />
      ) : (
        <WorkflowNodeList nodes={filtered} onSelect={setSelectedId} />
      )}
      {selected ? <WorkflowNodeDetails node={selected} onSelect={setSelectedId} podHref={podHref} /> : null}
    </section>
  );
}
