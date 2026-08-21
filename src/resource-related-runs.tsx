import React from 'react';

import {argoResourceHref} from './argo-resource-link.ts';
import type {ApplicationState, ApplicationTree} from './host';
import {loadWorkflowRunPage, type RunPageState, type WorkflowRunRow} from './workflow-runs.ts';

export interface ResourceRelatedRunsProps {
  application?: ApplicationState;
  tree?: ApplicationTree;
  heading: string;
  emptyText: string;
  relation: (row: WorkflowRunRow) => string | undefined;
}

function RelatedRunsTable({rows}: {rows: Array<WorkflowRunRow & {relation: string}>}) {
  return React.createElement(
    'table',
    {className: 'wf-related-runs-table'},
    React.createElement('caption', {style: {textAlign: 'left'}}, 'Verified Workflow runs in the loaded Application page'),
    React.createElement('thead', null, React.createElement('tr', null,
      ['Workflow', 'Phase', 'Started', 'Relationship'].map(label => React.createElement('th', {key: label, scope: 'col', style: {padding: '.35rem', textAlign: 'left'}}, label))
    )),
    React.createElement('tbody', null, rows.map(row => React.createElement('tr', {key: `${row.namespace || ''}/${row.name}/${row.createdAt || ''}`},
      React.createElement('td', null, React.createElement('a', {className: 'wf-resource-link', href: argoResourceHref({group: 'argoproj.io', kind: 'Workflow', namespace: row.namespace, name: row.name}, 'extension-0')}, row.name)),
      React.createElement('td', {style: {padding: '.35rem'}}, row.rawPhase || row.phase),
      React.createElement('td', {style: {padding: '.35rem'}}, row.startedAt || row.createdAt || '—'),
      React.createElement('td', {style: {padding: '.35rem'}}, row.relation)
    )))
  );
}

function pageNotice(state: RunPageState | undefined, loading: boolean, unavailable: boolean, emptyText: string): React.ReactNode {
  if (loading) return React.createElement('p', {role: 'status', 'aria-live': 'polite'}, 'Loading one bounded Application page of Workflow runs…');
  if (unavailable || state === 'unavailable') return React.createElement('p', {role: 'status'}, 'Related Workflow runs are unavailable until the host supplies an Application and resource tree.');
  if (state === 'permission') return React.createElement('p', {role: 'alert'}, 'You do not have permission to view these related Workflow runs.');
  if (state === 'error') return React.createElement('p', {role: 'alert'}, 'Related Workflow run details could not be loaded for this page.');
  if (state === 'partial') return React.createElement('p', {role: 'status'}, 'Some related Workflow runs could not be loaded or verified; this page may be incomplete.');
  if (state === 'stale') return React.createElement('p', {role: 'status'}, 'These related Workflow runs may be stale: the Application tree changed while live resources were loading.');
  if (state === 'empty') return React.createElement('p', {role: 'status'}, emptyText);
  return null;
}

/** Loads only the existing bounded, Application-authorized live-run page. */
export function ResourceRelatedRuns({application, tree, heading, emptyText, relation}: ResourceRelatedRunsProps) {
  const [state, setState] = React.useState<RunPageState>();
  const [rows, setRows] = React.useState<Array<WorkflowRunRow & {relation: string}>>([]);
  const [loading, setLoading] = React.useState(false);
  const [refreshToken, setRefreshToken] = React.useState(0);
  const unavailable = !application?.metadata?.name || !tree;

  React.useEffect(() => {
    if (unavailable) {
      setState('unavailable');
      setRows([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setState(undefined);
    setRows([]);
    void loadWorkflowRunPage({application, tree})
      .then(page => {
        if (cancelled) return;
        const related = page.rows.flatMap(row => {
          const evidence = relation(row);
          return evidence ? [{...row, relation: evidence}] : [];
        });
        setRows(related);
        setState(page.state === 'ready' && !related.length ? 'empty' : page.state);
      })
      .catch(() => { if (!cancelled) setState('error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [application, refreshToken, relation, tree, unavailable]);

  return React.createElement(
    'section',
    {'aria-label': heading},
    React.createElement('div', {className: 'wf-related-runs-header'},
      React.createElement('div', null, React.createElement('h4', null, heading), React.createElement('p', null, 'Live Application resources · one bounded page')),
      React.createElement('button', {type: 'button', disabled: loading || unavailable, onClick: () => setRefreshToken(value => value + 1)}, loading ? 'Refreshing…' : 'Refresh')
    ),
    pageNotice(state, loading, unavailable, emptyText),
    rows.length > 0 && !loading && ['ready', 'partial', 'stale'].includes(state || '')
      ? React.createElement(RelatedRunsTable, {rows})
      : null
  );
}
