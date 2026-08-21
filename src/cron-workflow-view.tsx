import React from 'react';

import type {ApplicationState, ApplicationTree} from './host';
import {ResourceRelatedRuns} from './resource-related-runs';
import {
  cronWorkflowActiveReferences,
  cronWorkflowRunRelation,
  cronWorkflowSummary,
  type CronWorkflowManifest
} from './cron-workflow-resource';

function Field({label, value}: {label: string; value?: React.ReactNode}) {
  const display = value === undefined || value === null || value === '' ? '—' : value;
  return React.createElement(
    'div',
    {style: {minWidth: '9rem'}},
    React.createElement('dt', {style: {fontSize: '0.75rem', opacity: 0.7}}, label),
    React.createElement('dd', {style: {margin: 0}}, display)
  );
}

function TemplateContext({cronWorkflow}: {cronWorkflow: CronWorkflowManifest}) {
  const template = cronWorkflowSummary(cronWorkflow).template;
  return React.createElement(
    'section',
    {'aria-label': 'Workflow template context'},
    React.createElement('h4', null, 'Workflow template context'),
    React.createElement(
      'dl',
      {style: {display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem'}},
      React.createElement(Field, {label: 'Source', value: template.reference || (template.source === 'embedded' ? 'Embedded workflowSpec' : template.source)}),
      React.createElement(Field, {label: 'Template type', value: template.type}),
      React.createElement(Field, {label: 'Entrypoint', value: template.entrypoint}),
      React.createElement(Field, {label: 'Declared parameters', value: template.parameters.join(', ') || undefined})
    ),
    template.structure.length
      ? React.createElement(
        'ul',
        null,
        template.structure.map((item, index) => React.createElement(
          'li',
          {key: `${item.name || ''}-${item.reference || ''}-${index}`},
          'Template',
          item.name ? ` ${item.name}` : '',
          item.reference ? ` references Template ${item.reference}` : ''
        ))
      )
      : React.createElement('p', {role: 'status'}, template.source === 'none'
        ? 'No embedded or referenced Workflow template was supplied.'
        : 'No nested template structure is declared for this entrypoint.')
  );
}

function ActiveReferences({references}: {references: ReturnType<typeof cronWorkflowActiveReferences>}) {
  return React.createElement(
    'ul',
    null,
    references.map(reference => React.createElement(
      'li',
      {key: `${reference.namespace || ''}/${reference.name}`},
      `${reference.name}${reference.namespace ? ` (${reference.namespace})` : ''}; verified by ${reference.verifiedBy}`
    ))
  );
}

export function CronWorkflowView({cronWorkflow, application, tree}: {cronWorkflow: CronWorkflowManifest; application?: ApplicationState; tree?: ApplicationTree}) {
  const summary = cronWorkflowSummary(cronWorkflow);
  const activeReferences = cronWorkflowActiveReferences(cronWorkflow);
  const relatedRun = React.useCallback(row => cronWorkflowRunRelation(row.manifest, cronWorkflow), [cronWorkflow]);

  return React.createElement(
    React.Fragment,
    null,
    React.createElement('h3', null, summary.name || 'CronWorkflow'),
    React.createElement(
      'dl',
      {style: {display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem'}},
      React.createElement(Field, {label: 'Namespace', value: summary.namespace}),
      React.createElement(Field, {label: 'Schedule', value: summary.schedule}),
      React.createElement(Field, {label: 'Timezone', value: summary.timezone}),
      React.createElement(Field, {label: 'Suspend', value: summary.suspend ? 'Suspended' : 'Active'}),
      React.createElement(Field, {label: 'Concurrency policy', value: summary.concurrencyPolicy}),
      React.createElement(Field, {label: 'Starting deadline', value: summary.startingDeadlineSeconds === undefined ? undefined : `${summary.startingDeadlineSeconds}s`}),
      React.createElement(Field, {label: 'Successful history limit', value: summary.successfulJobsHistoryLimit}),
      React.createElement(Field, {label: 'Failed history limit', value: summary.failedJobsHistoryLimit}),
      React.createElement(Field, {label: 'Last scheduled', value: summary.lastScheduledTime})
    ),
    React.createElement(TemplateContext, {cronWorkflow}),
    activeReferences.length
      ? React.createElement('section', {'aria-label': 'Active Workflow references'}, React.createElement('h4', null, 'Active Workflow references'), React.createElement(ActiveReferences, {references: activeReferences}))
      : null,
    React.createElement(ResourceRelatedRuns, {
      application,
      tree,
      heading: 'Recent Workflow children',
      emptyText: 'No Workflow runs in this loaded page are verified children of this CronWorkflow.',
      relation: relatedRun
    })
  );
}
