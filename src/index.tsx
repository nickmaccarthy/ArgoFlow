import React from 'react';

import {argoResourceHref} from './argo-resource-link.ts';
import {ApplicationWorkflowsView, WORKFLOW_EXTENSION_STYLES} from './application-workflows-view';
import {ApplicationEventsView} from './application-events-view';
import {eventBusResourceState} from './event-bus-resource';
import {EventResourceView, eventViewState, type EventResourceKind, type EventViewState} from './event-resource-view';
import {eventSourceResourceState} from './event-source-resource';
import type {ResourceExtensionProps} from './host';
import {sensorResourceState} from './sensor-resource';
import {cronWorkflowManifest, cronWorkflowResourceState} from './cron-workflow-resource';
import {CronWorkflowView} from './cron-workflow-view';
import {workflowManifest, workflowPhaseColor, workflowResourceState, workflowSummary} from './workflow-resource';
import {workflowTemplateManifest, workflowTemplateResourceState} from './workflow-template-resource';
import {WorkflowTemplateView} from './workflow-template-view';
import {WorkflowWorkspace} from './workflow-workspace';
import {emitExtensionTelemetry, telemetryNow} from './telemetry';

function SummaryItem({label, value}: {label: string; value?: React.ReactNode}) {
  return React.createElement(
    'div',
    {className: 'wf-summary-item'},
    React.createElement('div', {className: 'wf-summary-label'}, label),
    React.createElement('div', {className: 'wf-summary-value', title: typeof value === 'string' ? value : undefined}, value || '—')
  );
}

const styles = WORKFLOW_EXTENSION_STYLES;

class ResourceErrorBoundary extends React.Component<{children: React.ReactNode; title: string}, {failed: boolean}> {
  state = {failed: false};

  static getDerivedStateFromError() { return {failed: true}; }

  componentDidCatch() {
    const feature = this.props.title === 'Workflow'
      ? 'resource-workflow'
      : this.props.title === 'WorkflowTemplate'
        ? 'resource-template'
        : this.props.title === 'CronWorkflow'
          ? 'resource-cron'
          : this.props.title === 'EventSource'
            ? 'resource-event-source'
            : this.props.title === 'Sensor'
              ? 'resource-sensor'
              : this.props.title === 'EventBus'
                ? 'resource-event-bus'
                : undefined;
    if (feature) emitExtensionTelemetry('render.failed', {feature, state: 'error'});
  }

  render() {
    const message = this.props.title === 'Workflow'
      ? 'Workflow view could not be rendered.'
      : this.props.title === 'WorkflowTemplate'
        ? 'WorkflowTemplate view could not be rendered.'
        : this.props.title === 'CronWorkflow'
          ? 'CronWorkflow view could not be rendered.'
          : this.props.title === 'EventSource'
            ? 'EventSource view could not be rendered.'
            : this.props.title === 'Sensor'
              ? 'Sensor view could not be rendered.'
              : 'EventBus view could not be rendered.';
    if (this.state.failed) return React.createElement(
      'div', {role: 'alert'},
      React.createElement('p', null, message),
      React.createElement('button', {type: 'button', onClick: () => this.setState({failed: false})}, 'Try again')
    );
    return this.props.children;
  }
}

type ResourceNoticeState = ReturnType<typeof workflowResourceState> | EventViewState;

function ResourceNotice({state, subject = 'Workflow'}: {state: ResourceNoticeState; subject?: string}) {
  const messages: Partial<Record<ResourceNoticeState, string>> = {
    loading: `Loading ${subject.toLowerCase()} data…`,
    authentication: `Sign in to view this ${subject.toLowerCase()}.`,
    permission: `You do not have permission to view this ${subject.toLowerCase()}.`,
    missing: `${subject} was not found or is unavailable.`,
    malformed: `${subject} data could not be read because the controller response is malformed.`,
    unsupported: `This resource is not a supported Argo ${subject} schema.`,
    stale: `${subject} data may be stale while the controller catches up.`,
    partial: `Some ${subject.toLowerCase()} evidence is unavailable; shown details may be incomplete.`,
    truncated: `Only a bounded subset of ${subject.toLowerCase()} data is shown.`,
    empty: `No ${subject.toLowerCase()} evidence is available in this successful response.`,
    error: `${subject} data could not be loaded.`
  };
  const message = messages[state];
  return message ? React.createElement('p', {role: state === 'loading' || state === 'stale' || state === 'partial' || state === 'truncated' || state === 'empty' ? 'status' : 'alert'}, message) : null;
}

function eventResourceFeature(kind: EventResourceKind) {
  return kind === 'EventSource' ? 'resource-event-source' : kind === 'Sensor' ? 'resource-sensor' : 'resource-event-bus';
}

function EventResourceTab({application, resource, tree, kind}: ResourceExtensionProps & {kind: EventResourceKind}) {
  const resourceState = kind === 'EventSource'
    ? eventSourceResourceState(resource)
    : kind === 'Sensor'
      ? sensorResourceState(resource)
      : eventBusResourceState(resource);
  const state = eventViewState(resource, resourceState);
  const mountedAt = React.useRef(telemetryNow());

  React.useEffect(() => {
    emitExtensionTelemetry('event-resource.loaded', {
      feature: eventResourceFeature(kind),
      state,
      durationMs: Math.max(0, telemetryNow() - mountedAt.current)
    });
  }, [kind, state]);

  if (state !== 'ready' && state !== 'stale') return React.createElement(
    'section',
    {id: 'workflow-extension', 'aria-label': `${kind} extension`, style: {padding: '1rem'}},
    React.createElement('style', null, styles),
    React.createElement('h3', null, kind),
    React.createElement(ResourceNotice, {state, subject: kind})
  );

  return React.createElement(
    'section',
    {id: 'workflow-extension', 'aria-label': `${kind} extension`, style: {padding: '1rem'}},
    React.createElement('style', null, styles),
    state === 'stale' ? React.createElement(ResourceNotice, {state, subject: kind}) : null,
    React.createElement(ResourceErrorBoundary, {
      title: kind,
      key: `${kind}-${resource?.metadata?.name || ''}-${resource?.metadata?.generation || ''}`,
      children: React.createElement(EventResourceView, {application, resource, tree, kind})
    })
  );
}

function EventSourceTab(props: ResourceExtensionProps) {
  return React.createElement(EventResourceTab, {...props, kind: 'EventSource'});
}

function SensorTab(props: ResourceExtensionProps) {
  return React.createElement(EventResourceTab, {...props, kind: 'Sensor'});
}

function EventBusTab(props: ResourceExtensionProps) {
  return React.createElement(EventResourceTab, {...props, kind: 'EventBus'});
}

function WorkflowTab({resource, tree}: ResourceExtensionProps) {
  const workflow = workflowManifest(resource);
  const state = workflowResourceState(resource);
  const summary = workflowSummary(workflow);

  if (state !== 'ready' && state !== 'stale') {
    return React.createElement(
      'section',
      {id: 'workflow-extension', 'aria-label': 'Workflow extension', style: {padding: '1rem'}},
      React.createElement('style', null, styles),
      React.createElement('h3', null, 'Workflow'),
      React.createElement(ResourceNotice, {state})
    );
  }

  return React.createElement(
    'section',
    {id: 'workflow-extension', 'aria-label': 'Workflow extension', style: {padding: '1rem'}},
    React.createElement('style', null, styles),
    React.createElement('div', {className: 'wf-view-header'},
      React.createElement('div', {className: 'wf-resource-title'},
        React.createElement('h3', null, summary.name || 'Workflow'),
        React.createElement('span', {className: 'workflow-phase', 'data-phase': summary.phase, style: {color: workflowPhaseColor(summary.phase)}}, summary.rawPhase || summary.phase)
      )
    ),
    React.createElement(
      'div',
      {className: 'wf-summary'},
      React.createElement(SummaryItem, {label: 'Progress', value: summary.progress}),
      React.createElement(SummaryItem, {label: 'Duration', value: summary.duration}),
      React.createElement(SummaryItem, {label: 'Started', value: summary.startedAt}),
      React.createElement(SummaryItem, {label: 'Finished', value: summary.finishedAt}),
      React.createElement(SummaryItem, {label: 'Namespace', value: summary.namespace}),
      React.createElement(SummaryItem, {
        label: 'Template',
        value: workflow?.spec?.workflowTemplateRef?.name
          ? React.createElement('a', {
            className: 'wf-resource-link',
            href: argoResourceHref({
              group: 'argoproj.io',
              kind: workflow.spec.workflowTemplateRef.clusterScope ? 'ClusterWorkflowTemplate' : 'WorkflowTemplate',
              namespace: workflow.spec.workflowTemplateRef.clusterScope ? '' : summary.namespace,
              name: workflow.spec.workflowTemplateRef.name
            }, 'extension-0'),
            title: summary.templateReference
          }, workflow.spec.workflowTemplateRef.name)
          : undefined
      }),
      React.createElement(SummaryItem, {label: 'Created', value: summary.createdAt}),
      React.createElement(SummaryItem, {label: 'Nodes', value: Object.keys(workflow?.status?.nodes || {}).length.toString()})
    ),
    state === 'stale' ? React.createElement(ResourceNotice, {state}) : null,
    summary.message ? React.createElement('p', {className: 'workflow-message', role: 'status'}, summary.message) : null,
    React.createElement(ResourceErrorBoundary, {
      title: 'Workflow',
      key: `${summary.name || ''}-${summary.createdAt || ''}`,
      children: React.createElement(WorkflowWorkspace, {
        workflow: workflow!,
        podHref: node => {
          if (!node.podName) return undefined;
          const suffix = node.id.startsWith(`${summary.name}-`) ? node.id.slice(summary.name!.length) : '';
          const treePod = tree?.nodes?.find(item =>
            item.kind === 'Pod' &&
            item.namespace === summary.namespace &&
            (item.name === node.podName || Boolean(suffix && item.name?.endsWith(suffix)))
          );
          return argoResourceHref({kind: 'Pod', namespace: summary.namespace, name: treePod?.name || node.podName}, 'logs');
        }
      })
    })
  );
}

function WorkflowTemplateTab({application, resource, tree}: ResourceExtensionProps) {
  const template = workflowTemplateManifest(resource);
  const state = workflowTemplateResourceState(resource);

  if (state !== 'ready' && state !== 'stale') {
    return React.createElement(
      'section',
      {id: 'workflow-extension', 'aria-label': 'WorkflowTemplate extension', style: {padding: '1rem'}},
      React.createElement('style', null, styles),
      React.createElement('h3', null, 'WorkflowTemplate'),
      React.createElement(ResourceNotice, {state, subject: 'Workflow template'})
    );
  }

  return React.createElement(
    'section',
    {id: 'workflow-extension', 'aria-label': 'WorkflowTemplate extension', style: {padding: '1rem'}},
    React.createElement('style', null, styles),
    state === 'stale' ? React.createElement(ResourceNotice, {state, subject: 'Workflow template'}) : null,
    React.createElement(ResourceErrorBoundary, {title: 'WorkflowTemplate', key: `${template?.metadata?.name || ''}-${template?.metadata?.generation || ''}`, children: React.createElement(WorkflowTemplateView, {template: template!, application, tree})})
  );
}

function CronWorkflowTab({application, resource, tree}: ResourceExtensionProps) {
  const cronWorkflow = cronWorkflowManifest(resource);
  const state = cronWorkflowResourceState(resource);

  if (state !== 'ready' && state !== 'stale') {
    return React.createElement(
      'section',
      {id: 'workflow-extension', 'aria-label': 'CronWorkflow extension', style: {padding: '1rem'}},
      React.createElement('style', null, styles),
      React.createElement('h3', null, 'CronWorkflow'),
      React.createElement(ResourceNotice, {state, subject: 'CronWorkflow'})
    );
  }

  return React.createElement(
    'section',
    {id: 'workflow-extension', 'aria-label': 'CronWorkflow extension', style: {padding: '1rem'}},
    React.createElement('style', null, styles),
    state === 'stale' ? React.createElement(ResourceNotice, {state, subject: 'CronWorkflow'}) : null,
    React.createElement(ResourceErrorBoundary, {
      title: 'CronWorkflow',
      key: `${cronWorkflow?.metadata?.name || ''}-${cronWorkflow?.status?.lastScheduledTime || ''}`,
      children: React.createElement(CronWorkflowView, {cronWorkflow: cronWorkflow!, application, tree})
    })
  );
}

window.extensionsAPI.registerResourceExtension(WorkflowTab, 'argoproj.io', 'Workflow', 'WORKFLOW');
window.extensionsAPI.registerResourceExtension(WorkflowTemplateTab, 'argoproj.io', 'WorkflowTemplate', 'WORKFLOW TEMPLATE');
window.extensionsAPI.registerResourceExtension(CronWorkflowTab, 'argoproj.io', 'CronWorkflow', 'CRON WORKFLOW');
window.extensionsAPI.registerResourceExtension(EventSourceTab, 'argoproj.io', 'EventSource', 'EVENT SOURCE');
window.extensionsAPI.registerResourceExtension(SensorTab, 'argoproj.io', 'Sensor', 'SENSOR');
window.extensionsAPI.registerResourceExtension(EventBusTab, 'argoproj.io', 'EventBus', 'EVENT BUS');
window.extensionsAPI.registerAppViewExtension(ApplicationWorkflowsView, 'Workflows', 'fa-project-diagram');
window.extensionsAPI.registerAppViewExtension(ApplicationEventsView, 'Events', 'fa-bolt');
emitExtensionTelemetry('extension.loaded');
