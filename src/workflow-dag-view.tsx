import React from 'react';

import {GraphIconButton} from './graph-controls';
import {workflowPhaseColor} from './workflow-resource';
import {layoutWorkflowGraph, WORKFLOW_ARROW_MARKER, WORKFLOW_ARROW_PATH, workflowEdgePath} from './workflow-graph';
import type {WorkflowNode} from './workflow-nodes';

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DAG_RENDER_CHUNK = 50;

function useProgressiveCount(total: number): number {
  const [count, setCount] = React.useState(() => Math.min(DAG_RENDER_CHUNK, total));
  React.useEffect(() => {
    setCount(Math.min(DAG_RENDER_CHUNK, total));
    if (total <= DAG_RENDER_CHUNK) return undefined;
    let frame = 0;
    const renderNext = () => setCount(current => {
      const next = Math.min(total, current + DAG_RENDER_CHUNK);
      if (next < total) frame = requestAnimationFrame(renderNext);
      return next;
    });
    frame = requestAnimationFrame(renderNext);
    return () => cancelAnimationFrame(frame);
  }, [total]);
  return count;
}

export function WorkflowDagView({nodes, selectedId, onSelect}: {
  nodes: WorkflowNode[];
  selectedId?: string;
  onSelect(id: string): void;
}) {
  const layout = React.useMemo(() => layoutWorkflowGraph(nodes), [nodes]);
  const fit = React.useMemo<ViewBox>(() => ({x: 0, y: 0, width: layout.width, height: layout.height}), [layout]);
  const [viewBox, setViewBox] = React.useState(fit);
  const [focusedId, setFocusedId] = React.useState<string>();
  const drag = React.useRef<{x: number; y: number; viewBox: ViewBox}>();
  const positions = new Map(layout.positions.map(position => [position.id, position]));
  const renderedCount = useProgressiveCount(nodes.length);
  const renderedNodes = nodes.slice(0, renderedCount);
  const renderedIds = new Set(renderedNodes.map(node => node.id));

  React.useEffect(() => setViewBox(fit), [fit]);

  function zoom(factor: number) {
    setViewBox(box => {
      const width = box.width * factor;
      const height = box.height * factor;
      return {x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height};
    });
  }

  if (!nodes.length) return <p role="status">No nodes match the current filters.</p>;

  return (
    <div className="wf-dag-shell">
      <div className="wf-dag-controls" aria-label="DAG controls">
        <GraphIconButton action="zoom-in" onClick={() => zoom(0.8)} />
        <GraphIconButton action="zoom-out" onClick={() => zoom(1.25)} />
        <GraphIconButton action="fit" onClick={() => setViewBox(fit)} />
      </div>
      {renderedCount < nodes.length ? <p role="status">Rendering DAG {renderedCount} of {nodes.length} nodes…</p> : null}
      <svg
        aria-label="Workflow DAG"
        role="group"
        className="wf-dag-canvas"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        onPointerDown={event => {
          if (event.target === event.currentTarget) {
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {x: event.clientX, y: event.clientY, viewBox};
          }
        }}
        onPointerMove={event => {
          if (!drag.current) return;
          const scaleX = viewBox.width / event.currentTarget.clientWidth;
          const scaleY = viewBox.height / event.currentTarget.clientHeight;
          setViewBox({...viewBox, x: drag.current.viewBox.x - (event.clientX - drag.current.x) * scaleX, y: drag.current.viewBox.y - (event.clientY - drag.current.y) * scaleY});
        }}
        onPointerUp={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = undefined;
        }}
        onPointerLeave={() => (drag.current = undefined)}
      >
        <defs>
          <marker id="workflow-arrow" {...WORKFLOW_ARROW_MARKER}>
            <path d={WORKFLOW_ARROW_PATH} fill="var(--wf-muted)" />
          </marker>
        </defs>
        {layout.edges.filter(edge => renderedIds.has(edge.from) && renderedIds.has(edge.to)).map(edge => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          return from && to ? (
            <path className="wf-dag-edge" d={workflowEdgePath(from, to)} fill="none" key={`${edge.from}-${edge.to}`} stroke="currentColor" markerEnd="url(#workflow-arrow)" />
          ) : null;
        })}
        {renderedNodes.map(node => {
          const position = positions.get(node.id);
          if (!position) return null;
          return (
            <g
              key={node.id}
              aria-label={`${node.displayName}: ${node.rawPhase || node.phase}`}
              role="button"
              tabIndex={0}
              aria-pressed={selectedId === node.id}
              transform={`translate(${position.x} ${position.y})`}
              onClick={() => onSelect(node.id)}
              onFocus={() => setFocusedId(node.id)}
              onBlur={() => setFocusedId(undefined)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(node.id);
                }
              }}
            >
              <rect
                width="180"
                height="60"
                rx="5"
                className="wf-dag-card"
                fill="var(--wf-panel)"
                stroke={workflowPhaseColor(node.phase)}
                strokeWidth={selectedId === node.id || focusedId === node.id ? 4 : 2}
                strokeDasharray={focusedId === node.id ? '6 3' : undefined}
              />
              <text className="wf-dag-label" x="10" y="24" fill="currentColor" fontSize="14" fontWeight="600">{node.displayName.slice(0, 24)}</text>
              <text className="wf-dag-phase-label" x="10" y="45" fill={workflowPhaseColor(node.phase)} fontSize="12">{node.rawPhase || node.phase}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
