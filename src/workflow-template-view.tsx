import React from 'react';

import type {ApplicationState, ApplicationTree} from './host';
import {ResourceRelatedRuns} from './resource-related-runs';
import {layoutWorkflowGraph, WORKFLOW_ARROW_MARKER, WORKFLOW_ARROW_PATH, workflowEdgePath} from './workflow-graph';
import type {WorkflowNode} from './workflow-nodes';
import {
  isWorkflowTemplateRun,
  workflowTemplateGraph,
  workflowTemplateSummary,
  type WorkflowTemplateGraphNode,
  type WorkflowTemplateManifest
} from './workflow-template-resource';

function Field({label, value}: {label: string; value?: React.ReactNode}) {
  return React.createElement(
    'div',
    {className: 'wf-summary-item'},
    React.createElement('dt', {className: 'wf-summary-label'}, label),
    React.createElement('dd', {className: 'wf-summary-value'}, value || '—')
  );
}

function graphLayoutNodes(nodes: WorkflowTemplateGraphNode[]): WorkflowNode[] {
  return nodes.map(node => ({
    id: node.id,
    name: node.label,
    displayName: node.label,
    type: node.type,
    phase: 'Unknown',
    children: nodes.filter(child => child.dependencies.includes(node.id)).map(child => child.id),
    outboundNodes: [],
    retryChildren: [],
    attempts: 1,
    inputs: {parameters: [], artifacts: []},
    outputs: {parameters: [], artifacts: []}
  }));
}

function TemplateDefinitionGraph({nodes, selectedId, onSelect}: {
  nodes: WorkflowTemplateGraphNode[];
  selectedId?: string;
  onSelect(id: string): void;
}) {
  const layout = React.useMemo(() => layoutWorkflowGraph(graphLayoutNodes(nodes)), [nodes]);
  const positions = new Map(layout.positions.map(position => [position.id, position]));
  const height = `${Math.min(44, Math.max(24, layout.height / 16))}rem`;

  if (!nodes.length) return React.createElement('p', {role: 'status'}, 'This template has no renderable entrypoint definition.');
  return React.createElement(
    'div',
    {className: 'wf-template-graph-shell'},
    React.createElement('p', {className: 'wf-template-graph-note'}, 'Definition graph · nodes describe what a future Workflow will run.'),
    React.createElement(
      'svg',
      {
        'aria-label': 'WorkflowTemplate definition graph',
        className: 'wf-template-graph',
        role: 'group',
        style: {height},
        viewBox: `0 0 ${layout.width} ${layout.height}`
      },
      React.createElement('defs', null,
        React.createElement('marker', {id: 'workflow-template-arrow', ...WORKFLOW_ARROW_MARKER},
          React.createElement('path', {d: WORKFLOW_ARROW_PATH, fill: 'var(--wf-muted)'})
        )
      ),
      layout.edges.map(edge => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        return from && to ? React.createElement('path', {
          className: 'wf-template-edge', d: workflowEdgePath(from, to), fill: 'none', key: `${edge.from}-${edge.to}`,
          markerEnd: 'url(#workflow-template-arrow)', stroke: 'currentColor'
        }) : null;
      }),
      nodes.map(node => {
        const position = positions.get(node.id);
        if (!position) return null;
        const selected = selectedId === node.id;
        return React.createElement(
          'g',
          {
            'aria-label': `${node.label}: ${node.type} definition`, 'aria-pressed': selected, key: node.id,
            onClick: () => onSelect(node.id),
            onKeyDown: (event: React.KeyboardEvent<SVGGElement>) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id); }
            },
            role: 'button', tabIndex: 0, transform: `translate(${position.x} ${position.y})`
          },
          React.createElement('rect', {className: 'wf-template-card', fill: 'var(--wf-panel)', height: 60, rx: 5, strokeWidth: selected ? 4 : 2, width: 180}),
          React.createElement('text', {className: 'wf-template-label', x: 10, y: 24}, node.label.slice(0, 24)),
          React.createElement('text', {className: 'wf-template-type', x: 10, y: 45}, node.type)
        );
      })
    )
  );
}

function TemplateNodeDetails({node}: {node?: WorkflowTemplateGraphNode}) {
  if (!node) return null;
  return React.createElement(
    'aside',
    {'aria-label': 'Selected template node details', className: 'wf-node-details wf-template-node-details'},
    React.createElement('h4', null, node.label),
    React.createElement('div', {className: 'wf-node-detail-grid'},
      React.createElement('p', null, React.createElement('strong', null, 'Definition type'), node.type),
      React.createElement('p', null, React.createElement('strong', null, 'Template'), node.reference || '—'),
      React.createElement('p', null, React.createElement('strong', null, 'Image'), node.image || '—'),
      React.createElement('p', null, React.createElement('strong', null, 'Parameters'), node.parameters.join(', ') || '—'),
      React.createElement('p', {className: 'wf-node-detail-wide wf-template-definition-notice'}, 'Static definition only. Runtime phase, Pod, logs, and outputs appear after a Workflow is created.')
    )
  );
}

export function WorkflowTemplateView({template, application, tree}: {template: WorkflowTemplateManifest; application?: ApplicationState; tree?: ApplicationTree}) {
  const summary = workflowTemplateSummary(template);
  const graph = React.useMemo(() => workflowTemplateGraph(template), [template]);
  const [selectedId, setSelectedId] = React.useState(graph.nodes[0]?.id);
  const selected = graph.nodes.find(node => node.id === selectedId);
  const relatedRun = React.useCallback(
    row => isWorkflowTemplateRun(row.manifest, template) ? 'Direct WorkflowTemplate reference' : undefined,
    [template]
  );

  return React.createElement(
    React.Fragment,
    null,
    React.createElement('div', {className: 'wf-view-header'},
      React.createElement('div', null, React.createElement('h3', null, summary.name || 'WorkflowTemplate'), React.createElement('p', null, 'Reusable Workflow definition'))
    ),
    React.createElement('dl', {className: 'wf-summary'},
      React.createElement(Field, {label: 'Namespace', value: summary.namespace}),
      React.createElement(Field, {label: 'Template type', value: summary.type}),
      React.createElement(Field, {label: 'Entrypoint', value: summary.entrypoint}),
      React.createElement(Field, {label: 'Parameters', value: summary.parameters.join(', ') || undefined})
    ),
    React.createElement('section', {'aria-label': 'Template definition', className: 'wf-template-definition'},
      React.createElement('div', {className: 'wf-workspace-header'}, React.createElement('h4', null, 'Template definition')),
      React.createElement(TemplateDefinitionGraph, {nodes: graph.nodes, selectedId, onSelect: setSelectedId}),
      React.createElement(TemplateNodeDetails, {node: selected})
    ),
    React.createElement(ResourceRelatedRuns, {
      application, tree, heading: 'Recent related runs',
      emptyText: 'No Workflow runs in this loaded page directly reference this WorkflowTemplate.', relation: relatedRun
    })
  );
}
