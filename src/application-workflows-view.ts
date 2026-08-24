import React from 'react';

import {argoResourceHref} from './argo-resource-link.ts';
import type {ApplicationViewExtensionProps} from './host';
import {
  loadWorkflowRunPage,
  type ArchivePageProvider,
  type RunPage,
  type RunSource,
  type WorkflowRunRow
} from './workflow-runs.ts';
import {WORKFLOW_PHASES, workflowPhaseColor, type WorkflowPhase} from './workflow-resource.ts';
import {emitExtensionTelemetry, telemetryNow} from './telemetry.ts';
import {useHashState} from './url-state.ts';

export interface RunFilters {
  phase: '' | WorkflowPhase;
  query: string;
  namespace: string;
  lifecycle: 'all' | 'active' | 'completed';
  from: string;
  to: string;
}

export const DEFAULT_RUN_FILTERS: RunFilters = {
  phase: '', query: '', namespace: '', lifecycle: 'all', from: '', to: ''
};

export const RUN_AUTO_REFRESH_INTERVAL_MS = 15000;

/**
 * True when polling should tick: tab visible, no error on the current page,
 * a healthy page state, and at least one active run on the bounded page.
 * Errored, permission-limited, and unavailable pages generate zero traffic
 * (issue #4); a retained prior page must not keep polling after a failure.
 */
export function shouldAutoRefreshRunPage(rows: readonly WorkflowRunRow[], hidden?: boolean, error?: string, state?: RunPage['state']): boolean {
  if (hidden === true || error) return false;
  if (state === 'permission' || state === 'error' || state === 'unavailable') return false;
  return rows.some(isActiveWorkflowRun);
}

export function workflowApplicationKey(application?: ApplicationViewExtensionProps['application']): string {
  return application?.metadata?.uid || `${application?.metadata?.namespace || ''}/${application?.metadata?.name || ''}`;
}

export function cursorForApplication(state: {applicationKey: string; cursor?: string}, applicationKey: string): string | undefined {
  return state.applicationKey === applicationKey ? state.cursor : undefined;
}

export interface ApplicationWorkflowsViewProps extends ApplicationViewExtensionProps {
  archive?: ArchivePageProvider;
  baseUrl?: string;
  fetcher?: typeof fetch;
}

export const WORKFLOW_EXTENSION_STYLES = `
#workflow-extension { --wf-border: rgba(109,127,139,.35); --wf-panel: #fff; --wf-muted: #6d7f8b; color: inherit; line-height: 1.45; }
body[style*="background: rgb(16, 15, 15)"] #workflow-extension { color: #fff; color-scheme: dark; }
body[style*="background: rgb(16, 15, 15)"] #workflow-extension { --wf-panel: #1b2733; --wf-muted: #a8b3bd; }
body[style*="background: rgb(16, 15, 15)"] #workflow-extension .wf-resource-link, body[style*="background: rgb(16, 15, 15)"] #workflow-extension .wf-node-pod-link { color: #6ccff2; }
#workflow-extension *, #workflow-extension *::before, #workflow-extension *::after { box-sizing: border-box; }
#workflow-extension button, #workflow-extension input, #workflow-extension select { color: inherit; font: inherit; }
#workflow-extension button, #workflow-extension select, #workflow-extension input { border: 1px solid var(--wf-border); border-radius: 4px; background: var(--wf-panel); min-height: 2.25rem; }
#workflow-extension button:focus-visible, #workflow-extension input:focus-visible, #workflow-extension select:focus-visible, #workflow-extension [role="button"]:focus-visible { outline: 3px solid #0b74de; outline-offset: 2px; }
#workflow-extension .workflow-phase { border: 1px solid currentColor; border-radius: 1rem; display: inline-block; padding: .1rem .5rem; }
#workflow-extension .workflow-message { border-inline-start: 3px solid currentColor; padding-inline-start: .5rem; }
#workflow-extension h3 { font-size: 1.65rem; font-weight: 400; line-height: 1.2; }
#workflow-extension h4 { font-size: 1.2rem; font-weight: 500; line-height: 1.25; }
#workflow-extension .wf-view-header { align-items: flex-start; display: flex; gap: 1rem; justify-content: space-between; margin-bottom: 1rem; }
#workflow-extension .wf-view-header h3 { margin: 0; }
#workflow-extension .wf-view-header p { color: var(--wf-muted); margin: .25rem 0 0; }
#workflow-extension .wf-refresh { cursor: pointer; padding: .35rem .8rem; }
#workflow-extension .wf-stats { display: grid; gap: .75rem; grid-template-columns: repeat(4, minmax(7rem, 1fr)); margin-bottom: 1rem; }
#workflow-extension .wf-stat { background: var(--wf-panel); border: 1px solid var(--wf-border); border-top: 3px solid var(--wf-accent, #6d7f8b); border-radius: 4px; padding: .7rem .8rem; }
#workflow-extension .wf-stat strong { display: block; font-size: 1.35rem; line-height: 1.2; }
#workflow-extension .wf-stat span { color: var(--wf-muted); font-size: .78rem; text-transform: uppercase; }
#workflow-extension .wf-toolbar { align-items: end; background: var(--wf-panel); border: 1px solid var(--wf-border); border-radius: 4px; display: grid; gap: .75rem; grid-template-columns: minmax(14rem, 2fr) repeat(3, minmax(9rem, 1fr)); padding: .8rem; }
#workflow-extension .wf-field { display: grid; gap: .25rem; min-width: 0; }
#workflow-extension .wf-field > span, #workflow-extension .wf-more summary { color: var(--wf-muted); font-size: .78rem; font-weight: 600; }
#workflow-extension .wf-field input, #workflow-extension .wf-field select { min-width: 0; padding: .35rem .5rem; width: 100%; }
#workflow-extension .wf-more { background: var(--wf-panel); border: 1px solid var(--wf-border); border-top: 0; padding: .5rem .8rem; }
#workflow-extension .wf-more summary { cursor: pointer; width: max-content; }
#workflow-extension .wf-more-fields { display: grid; gap: .75rem; grid-template-columns: repeat(3, minmax(10rem, 1fr)); margin-top: .6rem; max-width: 44rem; }
#workflow-extension .wf-result-note { color: var(--wf-muted); font-size: .85rem; margin: .65rem 0; }
#workflow-extension .wf-table-wrap { background: var(--wf-panel); border: 1px solid var(--wf-border); border-radius: 4px; overflow-x: auto; }
#workflow-extension .wf-runs-table { border-collapse: collapse; min-width: 46rem; table-layout: fixed; width: 100%; }
#workflow-extension .wf-runs-table caption { height: 1px; overflow: hidden; position: absolute; width: 1px; clip: rect(0 0 0 0); }
#workflow-extension .wf-runs-table th { color: var(--wf-muted); font-size: .75rem; font-weight: 600; letter-spacing: .02em; padding: .65rem .75rem; text-align: left; text-transform: uppercase; }
#workflow-extension .wf-runs-table td { border-top: 1px solid var(--wf-border); height: 3.5rem; padding: .55rem .75rem; vertical-align: middle; }
#workflow-extension .wf-runs-table tbody tr:hover { background: rgba(13,173,234,.06); }
#workflow-extension .wf-runs-table th:nth-child(1) { width: 8rem; }
#workflow-extension .wf-runs-table th:nth-child(2) { width: 25%; }
#workflow-extension .wf-runs-table th:nth-child(3) { width: 24%; }
#workflow-extension .wf-runs-table th:nth-child(4) { width: 9rem; }
#workflow-extension .wf-runs-table th:nth-child(5) { width: 7rem; }
#workflow-extension .wf-runs-table th:nth-child(6) { width: 6rem; }
#workflow-extension .wf-run-link { color: #0b74de; display: block; font-weight: 600; overflow: hidden; text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
#workflow-extension .wf-run-link:hover { text-decoration: underline; }
#workflow-extension .wf-meta { color: var(--wf-muted); display: block; font-size: .75rem; margin-top: .15rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#workflow-extension .wf-source { border: 1px solid var(--wf-border); border-radius: 1rem; display: inline-block; font-size: .75rem; padding: .1rem .45rem; }
#workflow-extension .wf-pagination { align-items: center; display: flex; gap: .5rem; justify-content: flex-end; margin-top: .75rem; }
#workflow-extension .wf-pagination button { padding: .35rem .75rem; }
#workflow-extension .wf-resource-title { align-items: center; display: flex; flex-wrap: wrap; gap: .65rem; }
#workflow-extension .wf-summary { background: var(--wf-panel); border: 1px solid var(--wf-border); border-radius: 4px; display: grid; gap: 0; grid-template-columns: repeat(4, minmax(8rem, 1fr)); margin-bottom: 1.25rem; }
#workflow-extension .wf-summary-item { border-inline-end: 1px solid var(--wf-border); min-width: 0; padding: .7rem .8rem; }
#workflow-extension .wf-summary-item:nth-child(4n) { border-inline-end: 0; }
#workflow-extension .wf-summary-item:nth-child(n+5) { border-top: 1px solid var(--wf-border); }
#workflow-extension .wf-summary-label { color: var(--wf-muted); font-size: .72rem; font-weight: 600; margin-bottom: .18rem; text-transform: uppercase; }
#workflow-extension .wf-summary-value { font-weight: 500; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#workflow-extension .wf-resource-link, #workflow-extension .wf-node-pod-link { color: #087ca7; font-weight: 600; text-decoration: none; }
#workflow-extension .wf-resource-link:hover, #workflow-extension .wf-node-pod-link:hover { text-decoration: underline; }
#workflow-extension .wf-workspace { border-top: 1px solid var(--wf-border); padding-top: 1rem; }
#workflow-extension .wf-workspace-header { align-items: center; display: flex; gap: 1rem; justify-content: space-between; margin-bottom: .75rem; }
#workflow-extension .wf-workspace-header h4 { margin: 0; }
#workflow-extension .wf-segmented { display: inline-flex; }
#workflow-extension .wf-segmented button { border-radius: 0; cursor: pointer; min-width: 4.5rem; padding: .3rem .75rem; }
#workflow-extension .wf-segmented button:first-child { border-radius: 4px 0 0 4px; }
#workflow-extension .wf-segmented button:last-child { border-radius: 0 4px 4px 0; margin-inline-start: -1px; }
#workflow-extension .wf-segmented button[aria-pressed="true"] { background: #0dadea; border-color: #0dadea; color: #fff; }
#workflow-extension .wf-segmented button:disabled { background: rgba(109,127,139,.1); border-color: var(--wf-border); color: var(--wf-muted); cursor: not-allowed; opacity: .45; }
#workflow-extension .wf-node-toolbar { align-items: end; background: var(--wf-panel); border: 1px solid var(--wf-border); border-radius: 4px; display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: .75rem; padding: .7rem .8rem; }
#workflow-extension .wf-node-filters { align-items: end; display: flex; gap: .75rem; width: 100%; }
#workflow-extension .wf-node-filters .wf-field:first-child { flex: 1 1 18rem; }
#workflow-extension .wf-node-filters .wf-field:nth-child(2) { flex: 0 1 12rem; }
#workflow-extension .wf-active-filters { align-items: center; display: flex; flex-basis: 100%; flex-wrap: wrap; gap: .35rem; }
#workflow-extension .wf-active-filters button { align-items: center; background: rgba(13,173,234,.08); border-color: rgba(13,173,234,.35); border-radius: 1rem; cursor: pointer; display: inline-flex; gap: .35rem; min-height: 1.8rem; padding: .12rem .55rem; }
#workflow-extension .wf-active-filters button:hover { background: rgba(13,173,234,.16); }
#workflow-extension .wf-active-filters button span { font-size: 1rem; line-height: 1; }
#workflow-extension .wf-active-filters .wf-clear-filters { background: transparent; border-color: transparent; color: #087ca7; }
#workflow-extension .wf-dag-shell { background: var(--wf-panel); border: 1px solid var(--wf-border); border-radius: 4px; overflow: hidden; }
#workflow-extension .wf-dag-controls { align-items: center; border-bottom: 1px solid var(--wf-border); display: flex; gap: .4rem; justify-content: flex-end; padding: .45rem .6rem; }
#workflow-extension .wf-dag-controls button { cursor: pointer; min-height: 1.85rem; padding: .15rem .55rem; }
#workflow-extension .wf-icon-button { align-items: center; display: inline-flex; justify-content: center; min-width: 2rem; padding: .25rem; }
#workflow-extension .wf-icon-button svg { fill: none; height: 1rem; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.5; width: 1rem; }
#workflow-extension .wf-dag-canvas { display: block; height: 28rem; touch-action: none; width: 100%; }
#workflow-extension .wf-dag-canvas, #workflow-extension .wf-template-graph { background-color: var(--wf-panel); background-image: linear-gradient(rgba(109,127,139,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(109,127,139,.08) 1px, transparent 1px); background-size: 20px 20px; }
#workflow-extension .wf-dag-edge, #workflow-extension .wf-template-edge { color: var(--wf-muted); stroke-width: 1.25; }
#workflow-extension .wf-dag-card { filter: drop-shadow(0 1px 1px rgba(20,40,55,.12)); }
#workflow-extension .wf-dag-label, #workflow-extension .wf-template-label { font-weight: 600; }
#workflow-extension .wf-node-details { background: var(--wf-panel); border: 1px solid var(--wf-border); border-radius: 4px; margin-top: .75rem; padding: .8rem; }
#workflow-extension .wf-node-details h4 { margin: 0 0 .75rem; }
#workflow-extension .wf-node-detail-grid { display: grid; gap: .65rem 1rem; grid-template-columns: repeat(4, minmax(8rem, 1fr)); }
#workflow-extension .wf-node-detail-grid p { margin: 0; min-width: 0; overflow-wrap: anywhere; }
#workflow-extension .wf-node-detail-grid strong { color: var(--wf-muted); display: block; font-size: .72rem; margin-bottom: .18rem; text-transform: uppercase; }
#workflow-extension .wf-node-detail-wide { grid-column: 1 / -1; }
#workflow-extension .wf-node-message pre { background: #17212b; border-radius: 4px; color: #e6edf3; margin: .3rem 0 0; max-height: 12rem; overflow: auto; padding: .75rem; white-space: pre-wrap; }
#workflow-extension .wf-node-related { display: flex; flex-wrap: wrap; gap: .35rem; }
#workflow-extension .wf-node-related > strong { flex-basis: 100%; }
#workflow-extension .wf-node-related-button, #workflow-extension .wf-node-table-button { background: transparent; border: 0; color: #087ca7; cursor: pointer; min-height: auto; padding: .15rem .2rem; text-align: left; }
#workflow-extension .wf-node-related-button:hover, #workflow-extension .wf-node-table-button:hover { text-decoration: underline; }
#workflow-extension .wf-node-suspended, #workflow-extension .wf-template-definition-notice { background: rgba(13,173,234,.08); border-inline-start: 3px solid #0dadea; padding: .6rem .75rem; }
#workflow-extension .wf-node-table { background: var(--wf-panel); border: 1px solid var(--wf-border); border-radius: 4px; overflow: hidden; }
#workflow-extension .wf-node-table-header { background: rgba(109,127,139,.08); color: var(--wf-muted); font-size: .75rem; letter-spacing: .02em; text-transform: uppercase; }
#workflow-extension .wf-node-table-row { border-color: var(--wf-border) !important; }
#workflow-extension .wf-node-table-row:hover { background: rgba(13,173,234,.06); }
#workflow-extension .wf-node-table-cell { padding: .55rem .75rem !important; }
#workflow-extension .wf-node-list-bar, #workflow-extension .wf-node-pagination { align-items: center; display: flex; gap: .65rem; justify-content: space-between; }
#workflow-extension .wf-node-list-bar { margin: .5rem 0; }
#workflow-extension .wf-node-list-bar p { color: var(--wf-muted); margin: 0; }
#workflow-extension .wf-node-page-size { align-items: center; display: flex; gap: .4rem; }
#workflow-extension .wf-node-page-size span { color: var(--wf-muted); font-size: .78rem; font-weight: 600; }
#workflow-extension .wf-node-page-size select { min-height: 2rem; padding: .2rem 1.8rem .2rem .45rem; }
#workflow-extension .wf-node-pagination { justify-content: flex-end; margin-top: .65rem; }
#workflow-extension .wf-node-pagination button { cursor: pointer; padding: .25rem .65rem; }
#workflow-extension .wf-node-pagination span { color: var(--wf-muted); font-size: .82rem; min-width: 6.5rem; text-align: center; }
#workflow-extension .wf-status-grid-shell { background: var(--wf-panel); border: 1px solid var(--wf-border); border-radius: 4px; overflow: visible; }
#workflow-extension .wf-status-grid-header { align-items: center; border-bottom: 1px solid var(--wf-border); display: flex; flex-wrap: wrap; gap: .55rem 1rem; justify-content: space-between; padding: .55rem .7rem; }
#workflow-extension .wf-status-grid-header p { color: var(--wf-muted); margin: 0; }
#workflow-extension .wf-status-legend { display: flex; flex-wrap: wrap; gap: .35rem .7rem; }
#workflow-extension .wf-status-legend button { align-items: center; background: transparent; border-color: transparent; display: inline-flex; font-size: .75rem; gap: .3rem; min-height: 1.7rem; padding: .12rem .28rem; }
#workflow-extension .wf-status-legend button:hover, #workflow-extension .wf-status-legend button[aria-pressed="true"] { background: rgba(13,173,234,.08); border-color: var(--wf-border); }
#workflow-extension .wf-status-legend button[aria-pressed="true"] { box-shadow: inset 0 -2px #0dadea; }
#workflow-extension .wf-status-legend i { border: 1px solid rgba(0,0,0,.12); border-radius: 2px; height: .7rem; width: .7rem; }
#workflow-extension .wf-status-focus-actions { align-items: center; background: rgba(13,173,234,.08); border-bottom: 1px solid var(--wf-border); display: flex; flex-wrap: wrap; gap: .45rem; padding: .45rem .7rem; }
#workflow-extension .wf-status-focus-actions span { font-size: .82rem; font-weight: 600; margin-inline-end: auto; }
#workflow-extension .wf-status-focus-actions button { cursor: pointer; min-height: 1.8rem; padding: .15rem .55rem; }
#workflow-extension .wf-status-grid { display: grid; gap: 3px; grid-auto-rows: var(--wf-grid-cell); grid-template-columns: repeat(auto-fill, var(--wf-grid-cell)); padding: .7rem; }
#workflow-extension .wf-status-cell { border: 1px solid rgba(0,0,0,.18); border-radius: 2px; box-shadow: inset 0 1px rgba(255,255,255,.28); cursor: pointer; height: var(--wf-grid-cell); min-height: var(--wf-grid-cell); padding: 0; position: relative; width: var(--wf-grid-cell); }
#workflow-extension .wf-status-cell:hover { filter: brightness(.88); transform: scale(1.08); }
#workflow-extension .wf-status-cell[aria-pressed="true"] { outline: 3px solid #17212b; outline-offset: 1px; }
#workflow-extension .wf-status-cell[data-dimmed="true"] { filter: grayscale(.6); opacity: .12; }
#workflow-extension .wf-status-cell[data-dimmed="true"]:hover, #workflow-extension .wf-status-cell[data-dimmed="true"]:focus-visible { opacity: 1; }
#workflow-extension .wf-status-cell::after { background: #17212b; border-radius: 3px; color: #fff; content: attr(data-tooltip); font-size: .75rem; font-weight: 500; left: 50%; opacity: 0; padding: .32rem .48rem; pointer-events: none; position: absolute; top: calc(100% + 6px); transform: translateX(-50%); transition: opacity .1s; white-space: nowrap; z-index: 20; }
#workflow-extension .wf-status-cell:hover::after, #workflow-extension .wf-status-cell:focus-visible::after { opacity: 1; }
#workflow-extension .wf-template-definition { border-top: 1px solid var(--wf-border); margin-bottom: 1.25rem; padding-top: 1rem; }
#workflow-extension .wf-template-graph-shell { background: var(--wf-panel); border: 1px solid var(--wf-border); border-radius: 4px; overflow: hidden; }
#workflow-extension .wf-template-graph-note { border-bottom: 1px solid var(--wf-border); color: var(--wf-muted); font-size: .8rem; margin: 0; padding: .55rem .75rem; }
#workflow-extension .wf-template-graph { display: block; height: 24rem; width: 100%; }
#workflow-extension .wf-template-card { stroke: #0dadea; filter: drop-shadow(0 1px 1px rgba(20,40,55,.12)); }
#workflow-extension .wf-template-type { fill: var(--wf-muted); font-size: 12px; }
#workflow-extension .wf-template-label { fill: currentColor; font-size: 14px; }
#workflow-extension .wf-related-runs-header { align-items: center; display: flex; gap: 1rem; justify-content: space-between; margin: 1.25rem 0 .6rem; }
#workflow-extension .wf-related-runs-header h4, #workflow-extension .wf-related-runs-header p { margin: 0; }
#workflow-extension .wf-related-runs-header p { color: var(--wf-muted); font-size: .8rem; }
#workflow-extension .wf-related-runs-header button { cursor: pointer; padding: .3rem .7rem; }
#workflow-extension .wf-related-runs-table { background: var(--wf-panel); border: 1px solid var(--wf-border); border-collapse: collapse; width: 100%; }
#workflow-extension .wf-related-runs-table caption { color: var(--wf-muted); font-size: .8rem; padding: .5rem .65rem; text-align: left; }
#workflow-extension .wf-related-runs-table th { color: var(--wf-muted); font-size: .75rem; text-transform: uppercase; }
#workflow-extension .wf-related-runs-table th, #workflow-extension .wf-related-runs-table td { border-top: 1px solid var(--wf-border); padding: .6rem .7rem !important; text-align: left; }
@media (max-width: 800px) {
  #workflow-extension .wf-stats { grid-template-columns: repeat(2, 1fr); }
  #workflow-extension .wf-toolbar { grid-template-columns: 1fr 1fr; }
  #workflow-extension .wf-more-fields { grid-template-columns: 1fr; }
  #workflow-extension .wf-summary, #workflow-extension .wf-node-detail-grid { grid-template-columns: repeat(2, minmax(8rem, 1fr)); }
  #workflow-extension .wf-summary-item:nth-child(4n) { border-inline-end: 1px solid var(--wf-border); }
  #workflow-extension .wf-summary-item:nth-child(2n) { border-inline-end: 0; }
  #workflow-extension .wf-summary-item:nth-child(n+3) { border-top: 1px solid var(--wf-border); }
  #workflow-extension .wf-node-filters { align-items: stretch; flex-direction: column; }
  #workflow-extension .wf-status-grid-header { align-items: flex-start; flex-direction: column; }
  #workflow-extension .wf-template-graph { height: 20rem; }
}
`;

function runTime(row: WorkflowRunRow): number | undefined {
  const value = row.startedAt || row.createdAt;
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : undefined;
}

export function isActiveWorkflowRun(row: WorkflowRunRow): boolean {
  return !row.finishedAt && !['Succeeded', 'Failed', 'Error', 'Skipped', 'Omitted'].includes(row.phase);
}

export function workflowRunSourceText(source: RunSource): string {
  return source === 'Live' ? 'Live Kubernetes resource' : 'Archived record';
}

/** Filters only the current bounded page; it never requests additional run history. */
export function filterWorkflowRunRows(rows: WorkflowRunRow[], filters: RunFilters): WorkflowRunRow[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const namespace = filters.namespace.trim().toLocaleLowerCase();
  const from = filters.from ? Date.parse(`${filters.from}T00:00:00`) : undefined;
  const to = filters.to ? Date.parse(`${filters.to}T23:59:59.999`) : undefined;
  return rows.filter(row => {
    const searchable = `${row.name} ${row.templateReference || ''}`.toLocaleLowerCase();
    const active = isActiveWorkflowRun(row);
    const time = runTime(row);
    return (!filters.phase || row.phase === filters.phase)
      && (!query || searchable.includes(query))
      && (!namespace || (row.namespace || '').toLocaleLowerCase().includes(namespace))
      && (filters.lifecycle === 'all' || (filters.lifecycle === 'active' ? active : !active))
      && (!from || (time !== undefined && time >= from))
      && (!to || (time !== undefined && time <= to));
  });
}

function display(value?: string): string {
  return value || '—';
}

export function formatRunAge(value?: string, now = Date.now()): string {
  if (!value) return '—';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '—';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function workflowRunHref(row: Pick<WorkflowRunRow, 'identity' | 'name' | 'namespace'>, pathname?: string): string {
  return argoResourceHref({
    group: row.identity.group || 'argoproj.io',
    kind: row.identity.kind || 'Workflow',
    namespace: row.namespace || row.identity.namespace,
    name: row.name
  }, 'extension-0', pathname);
}

function templateName(reference?: string): string {
  return reference?.split('/').pop() || '—';
}

function PageNotice({page, loading, refreshing, error}: {page?: RunPage; loading: boolean; refreshing?: boolean; error?: string}) {
  if (loading && refreshing) return React.createElement('p', {className: 'wf-result-note', role: 'status', 'aria-live': 'polite'}, 'Refreshing this page of Workflow runs in place…');
  if (loading) return React.createElement('p', {role: 'status', 'aria-live': 'polite'}, 'Loading one bounded page of Workflow runs…');
  if (error) return React.createElement('p', {role: 'alert'}, `Workflow runs could not be loaded: ${error}`);
  if (!page) return null;
  if (page.state === 'unavailable') return React.createElement(
    'p', {role: 'status'},
    page.source === 'Archive'
      ? `Archived runs are unavailable: ${page.capability.archive.reason || 'the host did not supply an archive source'}.`
      : 'Live Workflow runs are unavailable.'
  );
  if (page.state === 'permission') return React.createElement('p', {role: 'alert'}, 'You do not have permission to view these Workflow runs.');
  if (page.state === 'error') return React.createElement('p', {role: 'alert'}, 'Workflow run details could not be loaded for this page.');
  if (page.state === 'empty') return React.createElement('p', {role: 'status'}, `No ${page.source === 'Live' ? 'live Workflow resources' : 'archived Workflow records'} are available on this page.`);
  if (page.state === 'stale') return React.createElement('p', {role: 'status'}, 'These Workflow runs may be stale: the Application tree changed while live resources were loading.');
  if (page.state === 'partial') return React.createElement(
    'p', {role: 'status'},
    page.permissionDenied
      ? `Some Workflow runs on this page could not be loaded or verified; ${page.permissionDenied} require additional permission.`
      : 'Some Workflow runs on this page could not be loaded or verified.'
  );
  return null;
}

function RunFiltersForm({filters, setFilters, source, changeSource}: {
  filters: RunFilters;
  setFilters(filters: RunFilters): void;
  source: RunSource;
  changeSource(event: React.ChangeEvent<HTMLSelectElement>): void;
}) {
  const update = (key: keyof RunFilters) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = event.currentTarget.value;
    setFilters({...filters, [key]: value});
  };
  return React.createElement(
    React.Fragment,
    null,
    React.createElement('div', {className: 'wf-toolbar', 'aria-label': 'Workflow run filters'},
      React.createElement('label', {className: 'wf-field'}, React.createElement('span', null, 'Search'), React.createElement('input', {type: 'search', value: filters.query, onChange: update('query'), placeholder: 'Run or template', 'aria-label': 'Filter by name or template'})),
      React.createElement('label', {className: 'wf-field'}, React.createElement('span', null, 'Status'), React.createElement('select', {value: filters.phase, onChange: update('phase'), 'aria-label': 'Filter by status'},
        React.createElement('option', {value: ''}, 'All statuses'),
        [...WORKFLOW_PHASES, 'Unknown'].map(phase => React.createElement('option', {key: phase, value: phase}, phase))
      )),
      React.createElement('label', {className: 'wf-field'}, React.createElement('span', null, 'Run state'), React.createElement('select', {value: filters.lifecycle, onChange: update('lifecycle'), 'aria-label': 'Filter active or completed runs'},
        React.createElement('option', {value: 'all'}, 'Active and completed'),
        React.createElement('option', {value: 'active'}, 'Active'),
        React.createElement('option', {value: 'completed'}, 'Completed')
      )),
      React.createElement('label', {className: 'wf-field'}, React.createElement('span', null, 'Source'), React.createElement('select', {value: source, onChange: changeSource, 'aria-label': 'Workflow run source'},
        React.createElement('option', {value: 'Live'}, 'Live resources'),
        React.createElement('option', {value: 'Archive'}, 'Archive')
      ))
    ),
    React.createElement('details', {className: 'wf-more'},
      React.createElement('summary', null, 'More filters'),
      React.createElement('div', {className: 'wf-more-fields'},
        React.createElement('label', {className: 'wf-field'}, React.createElement('span', null, 'Namespace'), React.createElement('input', {type: 'search', value: filters.namespace, onChange: update('namespace'), 'aria-label': 'Filter by namespace'})),
        React.createElement('label', {className: 'wf-field'}, React.createElement('span', null, 'From'), React.createElement('input', {type: 'date', value: filters.from, onChange: update('from'), 'aria-label': 'Runs from date'})),
        React.createElement('label', {className: 'wf-field'}, React.createElement('span', null, 'To'), React.createElement('input', {type: 'date', value: filters.to, onChange: update('to'), 'aria-label': 'Runs to date'}))
      )
    )
  );
}

function RunsTable({rows}: {rows: WorkflowRunRow[]}) {
  return React.createElement(
    'div',
    {className: 'wf-table-wrap'},
    React.createElement('table', {className: 'wf-runs-table'},
    React.createElement('caption', null, 'Workflow runs in the current page'),
    React.createElement('thead', null, React.createElement('tr', null,
      ['Status', 'Workflow', 'Template', 'Started', 'Duration', 'Source'].map(header => React.createElement('th', {key: header, scope: 'col'}, header))
    )),
    React.createElement('tbody', null, rows.map(row => React.createElement('tr', {key: `${row.source}/${row.namespace || ''}/${row.name}/${row.createdAt || ''}`},
      React.createElement('td', null, React.createElement('span', {className: 'workflow-phase', style: {color: workflowPhaseColor(row.phase)}}, row.rawPhase || row.phase)),
      React.createElement('td', null,
        React.createElement('a', {className: 'wf-run-link', href: workflowRunHref(row), title: row.name}, row.name),
        React.createElement('span', {className: 'wf-meta', title: row.correlation.reason}, `${row.namespace || 'No namespace'} · ${row.correlation.confidence === 'verified' ? 'Verified' : row.correlation.confidence === 'inferred' ? 'Inferred' : 'Unverified'}`)
      ),
      React.createElement('td', null, React.createElement('span', {title: display(row.templateReference)}, templateName(row.templateReference)), row.progress ? React.createElement('span', {className: 'wf-meta'}, row.progress) : null),
      React.createElement('td', {title: row.startedAt || row.createdAt}, formatRunAge(row.startedAt || row.createdAt)),
      React.createElement('td', null, display(row.duration)),
      React.createElement('td', null, React.createElement('span', {className: 'wf-source'}, row.source))
    )))
    )
  );
}

function RunStats({rows}: {rows: WorkflowRunRow[]}) {
  const active = rows.filter(isActiveWorkflowRun).length;
  const succeeded = rows.filter(row => row.phase === 'Succeeded').length;
  const failed = rows.filter(row => row.phase === 'Failed' || row.phase === 'Error').length;
  return React.createElement('div', {className: 'wf-stats', 'aria-label': 'Current page summary'},
    [['Runs', rows.length, '#6d7f8b'], ['Active', active, '#0dadea'], ['Succeeded', succeeded, '#18be94'], ['Failed', failed, '#e96d76']].map(([label, value, color]) =>
      React.createElement('div', {className: 'wf-stat', key: String(label), style: {'--wf-accent': color} as React.CSSProperties}, React.createElement('strong', null, String(value)), React.createElement('span', null, String(label)))
    )
  );
}

export function ApplicationWorkflowsView({application, tree, archive, baseUrl, fetcher}: ApplicationWorkflowsViewProps) {
  const [hashState, patchHash] = useHashState();
  const applicationKey = workflowApplicationKey(application);
  const [source, setSource] = React.useState<RunSource>(() => hashState['runs.source'] === 'Archive' ? 'Archive' : 'Live');
  const [cursorState, setCursorState] = React.useState<{applicationKey: string; cursor?: string}>(() => ({
    applicationKey,
    cursor: hashState['runs.cursor']
  }));
  const cursor = cursorForApplication(cursorState, applicationKey);
  const setCursor = (next?: string) => setCursorState({applicationKey, cursor: next});
  const [page, setPage] = React.useState<RunPage>();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [refreshToken, setRefreshToken] = React.useState(0);
  const [hidden, setHidden] = React.useState(false);
  const [filters, setFilters] = React.useState<RunFilters>(() => {
    const phase = (WORKFLOW_PHASES as readonly string[]).includes(hashState['runs.phase'] ?? '') ? hashState['runs.phase'] as WorkflowPhase : '';
    const lifecycle = ['active', 'completed'].includes(hashState['runs.lifecycle'] ?? '') ? hashState['runs.lifecycle'] as RunFilters['lifecycle'] : 'all';
    return {
      phase,
      query: hashState['runs.query'] ?? '',
      namespace: hashState['runs.namespace'] ?? '',
      lifecycle,
      from: hashState['runs.from'] ?? '',
      to: hashState['runs.to'] ?? ''
    };
  });
  const applicationName = application?.metadata?.name || 'Selected Application';

  // Polling pauses while the tab is hidden; returning to the tab triggers an immediate refresh.
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const syncVisibility = () => setHidden(document.hidden);
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
    return () => document.removeEventListener('visibilitychange', syncVisibility);
  }, []);

  const autoRefresh = shouldAutoRefreshRunPage(page?.rows ?? [], hidden, error, page?.state);

  React.useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => setRefreshToken(value => value + 1), RUN_AUTO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  // A hidden->visible transition fires before effects re-install their
  // listeners, so the promised immediate refresh keys off the hidden state
  // change itself rather than a visibilitychange listener owned by the
  // interval effect (whose first tick would otherwise land one period later).
  const wasHiddenRef = React.useRef(hidden);
  React.useEffect(() => {
    const wasHidden = wasHiddenRef.current;
    wasHiddenRef.current = hidden;
    if (wasHidden && !hidden && autoRefresh) setRefreshToken(value => value + 1);
  }, [hidden, autoRefresh]);

  // Distinguishes a pure refresh tick from changed inputs: only input changes clear the page.
  const requestKey = `${applicationKey}|${source}|${cursor ?? ''}`;
  const lastRequestRef = React.useRef<string>();

  React.useEffect(() => {
    if (!application?.metadata?.name) {
      setPage(undefined);
      setError(undefined);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();
    const started = telemetryNow();
    const refreshTick = lastRequestRef.current === requestKey;
    lastRequestRef.current = requestKey;
    setLoading(true);
    setError(undefined);
    if (!refreshTick) setPage(undefined);
    void loadWorkflowRunPage({application, tree, archive, baseUrl, cursor, fetcher, signal: controller.signal, source})
      .then(result => {
        if (cancelled) return;
        setPage(result);
        emitExtensionTelemetry('run-page.loaded', {
          durationMs: Math.round(telemetryNow() - started),
          feature: result.source === 'Archive' ? 'archive-runs' : 'live-runs',
          pageSize: result.pageSize,
          rowCount: result.rows.length,
          source: result.source,
          state: result.state
        });
      })
      .catch(reason => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : 'Unknown error');
        emitExtensionTelemetry('run-page.failed', {
          durationMs: Math.round(telemetryNow() - started),
          feature: source === 'Archive' ? 'archive-runs' : 'live-runs',
          source,
          state: 'error'
        });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [application, applicationKey, archive, baseUrl, cursor, fetcher, refreshToken, requestKey, source, tree]);

  const rows = React.useMemo(() => filterWorkflowRunRows(page?.rows || [], filters), [filters, page]);
  const updateFilters = (next: RunFilters) => {
    setFilters(next);
    patchHash({
      'runs.phase': next.phase || undefined,
      'runs.query': next.query || undefined,
      'runs.namespace': next.namespace || undefined,
      'runs.lifecycle': next.lifecycle === 'all' ? undefined : next.lifecycle,
      'runs.from': next.from || undefined,
      'runs.to': next.to || undefined
    });
  };
  const changeSource = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = event.currentTarget.value as RunSource;
    setSource(next);
    setCursor(undefined);
    patchHash({'runs.source': next === 'Archive' ? next : undefined, 'runs.cursor': undefined});
  };
  const changeCursor = (next?: string) => {
    setCursor(next);
    patchHash({'runs.cursor': next});
  };
  const unavailableApplication = !application?.metadata?.name;

  return React.createElement(
    'section',
    {id: 'workflow-extension', 'aria-label': 'Workflow runs', style: {padding: '1rem'}},
    React.createElement('style', null, WORKFLOW_EXTENSION_STYLES),
    React.createElement('div', {className: 'wf-view-header'},
      React.createElement('div', null, React.createElement('h3', null, 'Workflow runs'), React.createElement('p', null, `${applicationName} · recent executions managed by this Application`)),
      React.createElement('button', {className: 'wf-refresh', type: 'button', onClick: () => setRefreshToken(value => value + 1)}, 'Refresh')
    ),
    unavailableApplication
      ? React.createElement('p', {role: 'alert'}, 'Workflow runs are unavailable until the host supplies an Application.')
      : React.createElement(React.Fragment, null,
        React.createElement(RunStats, {rows: page?.rows || []}),
        React.createElement(RunFiltersForm, {filters, setFilters: updateFilters, source, changeSource}),
        React.createElement('p', {className: 'wf-result-note', role: 'status'}, `${rows.length} shown from this ${page?.pageSize || 25}-run ${source.toLocaleLowerCase()} page. Filters apply to this page.${autoRefresh ? ` Auto-refreshes every ${Math.round(RUN_AUTO_REFRESH_INTERVAL_MS / 1000)} seconds while runs are active.` : ''}`),
        React.createElement(PageNotice, {page, loading: loading && !page, refreshing: Boolean(page && loading), error}),
        page && !error && ['ready', 'partial', 'stale'].includes(page.state)
          ? React.createElement(React.Fragment, null,
            rows.length
              ? React.createElement(RunsTable, {rows})
              : loading ? null : React.createElement('p', {role: 'status'}, 'No Workflow runs on this page match the current filters.'),
            React.createElement('div', {className: 'wf-pagination', 'aria-label': 'Workflow run pagination', role: 'group'},
              React.createElement('button', {type: 'button', disabled: loading || !page.previousCursor, onClick: () => changeCursor(page.previousCursor), 'aria-label': 'Previous Workflow run page'}, 'Previous'),
              ' ',
              React.createElement('button', {type: 'button', disabled: loading || !page.nextCursor, onClick: () => changeCursor(page.nextCursor), 'aria-label': 'Next Workflow run page'}, 'Next')
            )
          )
          : null
      )
  );
}
