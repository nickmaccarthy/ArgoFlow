import React from 'react';

import {WORKFLOW_PHASES, workflowPhaseColor, type WorkflowPhase} from './workflow-resource';
import {WORKFLOW_NODE_PAGE_SIZE, workflowNodePage} from './workflow-list';
import type {WorkflowNode} from './workflow-nodes';

const WORKFLOW_GRID_COLORS: Record<WorkflowPhase, string> = {
  Pending: '#E6A700', Running: '#0DADEA', Succeeded: '#18BE94', Failed: '#E96D76',
  Error: '#B56BD4', Skipped: '#8B9AA5', Omitted: '#A48AD4', Unknown: '#52616B'
};

export function Phase({node}: {node: WorkflowNode}) {
  return React.createElement('span', {className: 'workflow-phase', 'data-phase': node.phase, style: {color: workflowPhaseColor(node.phase)}}, node.rawPhase || node.phase);
}

function MetadataNames({label, names}: {label: string; names: string[]}) {
  return names.length
    ? React.createElement('p', {className: 'wf-node-detail-wide'}, React.createElement('strong', null, label), names.join(', '))
    : null;
}

function RelatedNodes({label, ids, onSelect}: {label: string; ids: string[]; onSelect(id: string): void}) {
  return ids.length
    ? React.createElement('div', {className: 'wf-node-detail-wide wf-node-related'},
      React.createElement('strong', null, label),
      ids.map(id => React.createElement('button', {
        key: id,
        className: 'wf-node-related-button',
        type: 'button',
        'aria-label': `View ${label} node ${id}`,
        onClick: () => onSelect(id)
      }, id))
    )
    : null;
}

export function WorkflowNodeDetails({node, onSelect, podHref}: {
  node: WorkflowNode;
  onSelect(id: string): void;
  podHref?: (node: WorkflowNode) => string | undefined;
}) {
  const href = node.podName ? podHref?.(node) : undefined;
  const suspended = node.type === 'Suspend' && node.phase === 'Running';
  return React.createElement(
    'aside',
    {'aria-label': 'Selected node details', className: 'wf-node-details'},
    React.createElement('h4', null, node.displayName),
    React.createElement('div', {className: 'wf-node-detail-grid'},
    React.createElement('p', null, React.createElement('strong', null, 'ID'), node.id),
    React.createElement('p', null, React.createElement('strong', null, 'Name'), node.name),
    React.createElement('p', null, React.createElement('strong', null, 'Type'), node.type),
    React.createElement('p', null, React.createElement('strong', null, 'Phase'), React.createElement(Phase, {node})),
    node.message ? React.createElement('div', {className: 'wf-node-detail-wide wf-node-message'}, React.createElement('strong', null, 'Message'), React.createElement('pre', null, React.createElement('code', null, node.message))) : null,
    React.createElement('p', null, React.createElement('strong', null, 'Duration'), node.duration || '—'),
    node.startedAt ? React.createElement('p', null, React.createElement('strong', null, 'Started'), node.startedAt) : null,
    node.finishedAt ? React.createElement('p', null, React.createElement('strong', null, 'Finished'), node.finishedAt) : null,
    node.template ? React.createElement('p', null, React.createElement('strong', null, 'Template'), node.template) : null,
    node.podName ? React.createElement('p', null, React.createElement('strong', null, 'Pod'), React.createElement(href ? 'a' : 'span', href ? {className: 'wf-node-pod-link', href} : {className: 'wf-node-pod-link', 'aria-label': 'Pod link unavailable'}, node.podName)) : null,
    suspended ? React.createElement('p', {className: 'wf-node-detail-wide wf-node-suspended', role: 'status'}, 'Suspended: waiting for resume. No Pod or logs are available.') : null,
    node.retryParentId ? React.createElement(RelatedNodes, {label: 'Retry parent', ids: [node.retryParentId], onSelect}) : null,
    React.createElement(RelatedNodes, {label: 'Retry children', ids: node.retryChildren, onSelect}),
    node.boundaryId ? React.createElement('p', null, React.createElement('strong', null, 'Boundary'), node.boundaryId) : null,
    React.createElement(RelatedNodes, {label: 'Children', ids: node.children, onSelect}),
    React.createElement(RelatedNodes, {label: 'Outbound nodes', ids: node.outboundNodes, onSelect}),
    React.createElement(MetadataNames, {label: 'Input parameters', names: node.inputs.parameters}),
    React.createElement(MetadataNames, {label: 'Input artifacts', names: node.inputs.artifacts}),
    React.createElement(MetadataNames, {label: 'Output parameters', names: node.outputs.parameters}),
    React.createElement(MetadataNames, {label: 'Output artifacts', names: node.outputs.artifacts})
    )
  );
}

export function WorkflowNodeList({nodes, onSelect}: {nodes: WorkflowNode[]; onSelect(id: string): void}) {
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState<number | 'all'>(WORKFLOW_NODE_PAGE_SIZE);
  const effectivePageSize = pageSize === 'all' ? Math.max(1, nodes.length) : pageSize;
  const visible = workflowNodePage(nodes, page, effectivePageSize);
  const start = visible.current * effectivePageSize;

  React.useEffect(() => setPage(0), [nodes, pageSize]);

  if (!nodes.length) return React.createElement('p', {role: 'status'}, 'No nodes match the current filters.');

  return React.createElement(
    React.Fragment,
    null,
    React.createElement('div', {className: 'wf-node-list-bar'},
      React.createElement('p', {role: 'status'}, `Showing ${start + 1}–${start + visible.nodes.length} of ${nodes.length} nodes.`),
      React.createElement('label', {className: 'wf-node-page-size'},
        React.createElement('span', null, 'Rows'),
        React.createElement('select', {
          'aria-label': 'Nodes per page', value: String(pageSize),
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setPageSize(event.currentTarget.value === 'all' ? 'all' : Number(event.currentTarget.value))
        },
        [10, 20, 50, 100].map(value => React.createElement('option', {key: value, value}, value)),
        React.createElement('option', {value: 'all'}, 'All'))
      )
    ),
    React.createElement(
      'div',
      {className: 'wf-node-table', role: 'table', 'aria-label': 'Workflow nodes', 'aria-rowcount': nodes.length + 1, style: {width: '100%'}},
      React.createElement(
        'div',
        {className: 'wf-node-table-header', role: 'row', 'aria-rowindex': 1, style: {display: 'grid', fontWeight: 600, gridTemplateColumns: 'minmax(12rem,2fr) 7rem 8rem 7rem 5rem minmax(12rem,2fr)'}},
        ['Name', 'Type', 'Phase', 'Duration', 'Attempts', 'Message'].map(label =>
          React.createElement('div', {className: 'wf-node-table-cell', key: label, role: 'columnheader', style: {padding: '.35rem', textAlign: 'left'}}, label)
        )
      ),
      React.createElement(
        'div',
        {
          'aria-label': 'Workflow node rows'
        },
        visible.nodes.map((node, index) => React.createElement(
            'div',
            {
              className: 'wf-node-table-row',
              key: node.id,
              role: 'row',
              'aria-rowindex': start + index + 2,
              style: {
                alignItems: 'center',
                borderTop: '1px solid currentColor',
                display: 'grid',
                gridTemplateColumns: 'minmax(12rem,2fr) 7rem 8rem 7rem 5rem minmax(12rem,2fr)',
                minHeight: '48px',
                overflow: 'hidden'
              }
            },
            React.createElement('div', {className: 'wf-node-table-cell', role: 'cell', style: {padding: '.35rem'}}, React.createElement('button', {className: 'wf-node-table-button', type: 'button', 'aria-label': `View details for ${node.displayName}`, onClick: () => onSelect(node.id)}, node.displayName)),
            React.createElement('div', {className: 'wf-node-table-cell', role: 'cell', style: {padding: '.35rem'}}, node.type),
            React.createElement('div', {className: 'wf-node-table-cell', role: 'cell', style: {padding: '.35rem'}}, React.createElement(Phase, {node})),
            React.createElement('div', {className: 'wf-node-table-cell', role: 'cell', style: {padding: '.35rem'}}, node.duration || '—'),
            React.createElement('div', {className: 'wf-node-table-cell', role: 'cell', style: {padding: '.35rem'}}, String(node.attempts)),
            React.createElement('div', {className: 'wf-node-table-cell', role: 'cell', title: node.message, style: {overflow: 'hidden', padding: '.35rem', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}, node.message || '—')
          ))
      )
    ),
    React.createElement('div', {className: 'wf-node-pagination', 'aria-label': 'Workflow node pages'},
      React.createElement('button', {type: 'button', disabled: visible.current === 0, onClick: () => setPage(visible.current - 1)}, 'Previous'),
      React.createElement('span', null, `Page ${visible.current + 1} of ${visible.pages}`),
      React.createElement('button', {type: 'button', disabled: visible.current + 1 >= visible.pages, onClick: () => setPage(visible.current + 1)}, 'Next')
    )
  );
}

export function WorkflowNodeGrid({nodes, selectedId, onSelect, onFilterPhases}: {
  nodes: WorkflowNode[];
  selectedId?: string;
  onSelect(id: string): void;
  onFilterPhases(phases: WorkflowPhase[]): void;
}) {
  const [spotlightPhases, setSpotlightPhases] = React.useState<WorkflowPhase[]>([]);
  if (!nodes.length) return React.createElement('p', {role: 'status'}, 'No nodes match the current filters.');
  const phases = [...WORKFLOW_PHASES, 'Unknown'] as WorkflowPhase[];
  const counts = new Map(phases.map(phase => [phase, nodes.filter(node => node.phase === phase).length]));
  const spotlightCount = nodes.filter(node => spotlightPhases.includes(node.phase)).length;
  return React.createElement(
    'section',
    {'aria-label': 'Workflow node status grid', className: 'wf-status-grid-shell'},
    React.createElement('div', {className: 'wf-status-grid-header'},
      React.createElement('p', {role: 'status'}, `${nodes.length} nodes · dependencies first; start time breaks ties`),
      React.createElement('div', {className: 'wf-status-legend', 'aria-label': 'Node status counts'},
        phases.filter(phase => counts.get(phase)).map(phase => React.createElement('button', {
          key: phase,
          type: 'button',
          'aria-label': `Highlight ${phase} nodes`,
          'aria-pressed': spotlightPhases.includes(phase),
          onClick: () => setSpotlightPhases(current => current.includes(phase) ? current.filter(value => value !== phase) : [...current, phase])
        },
          React.createElement('i', {'aria-hidden': true, style: {background: WORKFLOW_GRID_COLORS[phase]}}),
          `${phase} ${counts.get(phase)}${spotlightPhases.includes(phase) ? ' ×' : ''}`
        ))
      )
    ),
    spotlightPhases.length ? React.createElement('div', {className: 'wf-status-focus-actions'},
      React.createElement('span', {'aria-live': 'polite'}, `Highlighting ${spotlightCount} nodes · ${spotlightPhases.join(' + ')}`),
      React.createElement('button', {type: 'button', onClick: () => { onFilterPhases(spotlightPhases); setSpotlightPhases([]); }}, 'Show only selected'),
      React.createElement('button', {type: 'button', onClick: () => setSpotlightPhases([])}, 'Clear spotlight')
    ) : null,
    React.createElement('div', {className: 'wf-status-grid', style: {'--wf-grid-cell': nodes.length > 2000 ? '16px' : nodes.length > 500 ? '22px' : '30px'} as React.CSSProperties},
      nodes.map((node, index) => React.createElement('button', {
        key: node.id,
        type: 'button',
        className: 'wf-status-cell',
        'aria-label': `${node.displayName}: ${node.rawPhase || node.phase}`,
        'aria-pressed': selectedId === node.id,
        'data-dimmed': spotlightPhases.length && !spotlightPhases.includes(node.phase) ? 'true' : undefined,
        'data-tooltip': `${index + 1}. ${node.displayName} · ${node.type} · ${node.rawPhase || node.phase}`,
        title: `${index + 1} of ${nodes.length} · ${node.name} · ${node.type} · ${node.rawPhase || node.phase}`,
        style: {background: WORKFLOW_GRID_COLORS[node.phase]},
        onClick: () => onSelect(node.id)
      }))
    )
  );
}

export interface NodeFilterProps {
  query: string;
  selectedPhases: WorkflowPhase[];
  phases: readonly string[];
  setQuery(value: string): void;
  setPhases(value: WorkflowPhase[]): void;
}

export function WorkflowNodeFilters({query, selectedPhases, phases, setQuery, setPhases}: NodeFilterProps) {
  return React.createElement(
    'div',
    {className: 'wf-node-filters'},
    React.createElement('label', {className: 'wf-field'}, React.createElement('span', null, 'Search nodes'), React.createElement('input', {
      type: 'search',
      value: query,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.currentTarget.value)
    })),
    React.createElement(
      'label',
      {className: 'wf-field'},
      React.createElement('span', null, 'Status'),
      React.createElement(
        'select',
        {
          'aria-label': 'Add status filter',
          value: '',
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
            const value = event.currentTarget.value as WorkflowPhase;
            if (value && !selectedPhases.includes(value)) setPhases([...selectedPhases, value]);
          }
        },
        React.createElement('option', {value: ''}, selectedPhases.length ? 'Add status…' : 'All statuses'),
        phases.filter(value => !selectedPhases.includes(value as WorkflowPhase)).map(value => React.createElement('option', {key: value, value}, value))
      )
    ),
    selectedPhases.length ? React.createElement('div', {className: 'wf-active-filters', 'aria-label': 'Active status filters'},
      selectedPhases.map(value => React.createElement('button', {
        key: value,
        type: 'button',
        'aria-label': `Remove ${value} filter`,
        onClick: () => setPhases(selectedPhases.filter(phase => phase !== value))
      }, value, React.createElement('span', {'aria-hidden': true}, '×'))),
      selectedPhases.length > 1 ? React.createElement('button', {type: 'button', className: 'wf-clear-filters', onClick: () => setPhases([])}, 'Clear filters') : null
    ) : null
  );
}
