import React from 'react';

import {argoResourceHref} from './argo-resource-link.ts';
import {eventBusManifest, eventBusSummary, type EventBusManifest} from './event-bus-resource.ts';
import {EventChainView} from './event-chain-view';
import {eventHealth, eventManifest, type EventCondition, type EventResourceState} from './event-resource.ts';
import {eventSourceManifest, eventSourceSummary, type EventSourceManifest} from './event-source-resource.ts';
import type {ApplicationState, ApplicationTree, ResourceState} from './host';
import {sensorManifest, sensorSummary, type SensorManifest, type SensorTriggerSummary} from './sensor-resource.ts';

export type EventResourceKind = 'EventSource' | 'Sensor' | 'EventBus';
export type EventViewState = EventResourceState | 'authentication' | 'malformed' | 'partial' | 'truncated' | 'empty' | 'error';

export const EVENT_RESOURCE_STYLES = `
#workflow-extension .wf-event-health { border: 1px solid currentColor; border-radius: 999px; display: inline-block; font-size: .78rem; font-weight: 700; padding: .16rem .5rem; }
#workflow-extension .wf-event-health[data-state="Ready"] { color: #168c70; }
#workflow-extension .wf-event-health[data-state="Active"] { color: #087ca7; }
#workflow-extension .wf-event-health[data-state="Blocked"] { color: #a86100; }
#workflow-extension .wf-event-health[data-state="Failed"] { color: #c43d4b; }
#workflow-extension .wf-event-health[data-state="Unknown"] { color: var(--wf-muted); }
#workflow-extension .wf-event-section { margin: 1.25rem 0; }
#workflow-extension .wf-event-section h4 { margin: 0 0 .5rem; }
#workflow-extension .wf-event-table { border-collapse: collapse; width: 100%; }
#workflow-extension .wf-event-table caption { color: var(--wf-muted); padding: .5rem; text-align: left; }
#workflow-extension .wf-event-table th, #workflow-extension .wf-event-table td { border-bottom: 1px solid var(--wf-border); padding: .5rem; text-align: left; vertical-align: top; }
#workflow-extension .wf-event-table th { color: var(--wf-muted); font-size: .75rem; text-transform: uppercase; }
#workflow-extension .wf-event-expression { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; overflow-wrap: anywhere; }
#workflow-extension .wf-event-activity { background: var(--wf-panel); border: 1px solid var(--wf-border); border-radius: 4px; padding: .65rem .8rem; }
#workflow-extension .wf-event-activity p { margin: 0; }
#workflow-extension .wf-event-links { display: flex; flex-wrap: wrap; gap: .45rem .8rem; margin: .5rem 0 0; }
`;

function Field({label, value}: {label: string; value?: React.ReactNode}) {
  return React.createElement(
    'div',
    {className: 'wf-summary-item'},
    React.createElement('dt', {className: 'wf-summary-label'}, label),
    React.createElement('dd', {className: 'wf-summary-value'}, value === undefined || value === '' ? '—' : value)
  );
}

function HealthBadge({state, reason}: {state: ReturnType<typeof eventHealth>['state']; reason: string}) {
  return React.createElement('span', {className: 'wf-event-health', 'data-state': state, title: reason}, state);
}

function EventBusLink({name, namespace}: {name?: string; namespace?: string}) {
  if (!name) return null;
  return React.createElement('a', {
    className: 'wf-resource-link',
    href: argoResourceHref({group: 'argoproj.io', kind: 'EventBus', namespace, name}, 'extension-0')
  }, name);
}

function exactTreeResource(tree: ApplicationTree | undefined, kind: 'EventSource' | 'Sensor', namespace: string | undefined, name: string | undefined) {
  if (!name) return undefined;
  return tree?.nodes?.find(node => {
    const group = node.apiVersion?.split('/', 2)[0] || node.group;
    return group === 'argoproj.io' && node.kind === kind && node.namespace === namespace && node.name === name;
  });
}

function EventSourceLink({tree, name, namespace}: {tree?: ApplicationTree; name?: string; namespace?: string}): React.ReactElement {
  const source = exactTreeResource(tree, 'EventSource', namespace, name);
  if (!source?.name) return React.createElement('span', null, name || '—');
  return React.createElement('a', {
    className: 'wf-resource-link',
    href: argoResourceHref({group: 'argoproj.io', kind: 'EventSource', namespace: source.namespace, name: source.name}, 'extension-0')
  }, source.name);
}

function TriggerTarget({trigger, namespace}: {trigger: SensorTriggerSummary; namespace?: string}): React.ReactElement {
  if (trigger.targetKind !== 'Workflow' || !trigger.targetApiVersion?.startsWith('argoproj.io/')) {
    return React.createElement('span', null, `${trigger.targetApiVersion || '—'}/${trigger.targetKind || '—'}`);
  }
  if (trigger.targetName) return React.createElement('a', {
    className: 'wf-resource-link',
    href: argoResourceHref({group: 'argoproj.io', kind: 'Workflow', namespace, name: trigger.targetName}, 'extension-0')
  }, trigger.targetName);
  return trigger.targetGenerateName
    ? React.createElement('code', {className: 'wf-event-expression'}, `${trigger.targetGenerateName}*`)
    : React.createElement('span', null, 'Workflow target is not named.');
}

function triggerNamespace(sensor: SensorManifest, trigger: SensorTriggerSummary): string | undefined {
  const template = sensor.spec?.triggers?.find(item => item.template?.name === trigger.name)?.template;
  const resource = template?.k8s?.source?.resource || template?.argoWorkflow?.source?.resource;
  return resource?.metadata?.namespace || sensor.metadata?.namespace;
}

function PartialEvidence({state, reason}: {state: ReturnType<typeof eventHealth>['state']; reason: string}) {
  return state === 'Unknown'
    ? React.createElement('p', {className: 'wf-result-note', role: 'status'}, `Partial controller evidence: ${reason}`)
    : null;
}

function Conditions({conditions}: {conditions?: EventCondition[]}) {
  const rows = (conditions ?? []).map(condition => eventHealth([condition]));
  if (!rows.length) return React.createElement('p', {role: 'status'}, 'No controller condition evidence is available.');
  return React.createElement(
    'div',
    {className: 'wf-table-wrap'},
    React.createElement('table', {className: 'wf-event-table'},
      React.createElement('caption', null, 'Controller conditions'),
      React.createElement('thead', null, React.createElement('tr', null,
        ['Condition', 'Status', 'Evidence', 'Changed'].map(label => React.createElement('th', {key: label, scope: 'col'}, label))
      )),
      React.createElement('tbody', null, rows.map((evidence, index) => React.createElement('tr', {key: `${evidence.condition?.type || 'condition'}-${index}`},
        React.createElement('td', null, evidence.condition?.type || 'Controller condition'),
        React.createElement('td', null, evidence.condition?.status || 'Unknown'),
        React.createElement('td', null, evidence.reason),
        React.createElement('td', null, evidence.condition?.lastTransitionTime || '—')
      )))
    )
  );
}

function EventSourceDetails({source}: {source: EventSourceManifest}) {
  const summary = eventSourceSummary(source);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement('dl', {className: 'wf-summary'},
      React.createElement(Field, {label: 'Namespace', value: summary.namespace}),
      React.createElement(Field, {label: 'EventBus', value: React.createElement(EventBusLink, {name: summary.eventBusName, namespace: summary.namespace})}),
      React.createElement(Field, {label: 'Named events', value: summary.events.length.toString()}),
      React.createElement(Field, {label: 'Controller health', value: React.createElement(HealthBadge, summary.health)}),
      React.createElement(Field, {label: 'Activity evidence', value: summary.health.state})
    ),
    React.createElement('p', {className: 'wf-result-note', role: 'status'}, summary.health.reason),
    React.createElement(PartialEvidence, summary.health),
    React.createElement('section', {'aria-label': 'EventSource activity', className: 'wf-event-section'},
      React.createElement('h4', null, 'Controller activity'),
      React.createElement('div', {className: 'wf-event-activity'}, React.createElement('p', null, `${summary.health.state}: ${summary.health.reason}`))
    ),
    React.createElement('section', {'aria-label': 'EventSource events', className: 'wf-event-section'},
      React.createElement('h4', null, 'Named events'),
      summary.events.length
        ? React.createElement('div', {className: 'wf-table-wrap'}, React.createElement('table', {className: 'wf-event-table'},
          React.createElement('caption', null, 'Safe source configuration summary'),
          React.createElement('thead', null, React.createElement('tr', null, ['Type', 'Event', 'Endpoint', 'Port', 'Method'].map(label => React.createElement('th', {key: label, scope: 'col'}, label)))),
          React.createElement('tbody', null, summary.events.map(event => React.createElement('tr', {key: `${event.type}/${event.name}`},
            React.createElement('td', null, event.type), React.createElement('td', null, event.name), React.createElement('td', null, event.endpoint || '—'), React.createElement('td', null, event.port || '—'), React.createElement('td', null, event.method || '—')
          )))
        ))
        : React.createElement('p', {role: 'status'}, 'No named EventSource events are available in this resource.'),
    ),
    React.createElement('section', {'aria-label': 'EventSource conditions', className: 'wf-event-section'}, React.createElement('h4', null, 'Conditions'), React.createElement(Conditions, {conditions: source.status?.conditions}))
  );
}

function SensorDetails({sensor, tree}: {sensor: SensorManifest; tree?: ApplicationTree}) {
  const summary = sensorSummary(sensor);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement('dl', {className: 'wf-summary'},
      React.createElement(Field, {label: 'Namespace', value: summary.namespace}),
      React.createElement(Field, {label: 'EventBus', value: React.createElement(EventBusLink, {name: summary.eventBusName, namespace: summary.namespace})}),
      React.createElement(Field, {label: 'Dependencies', value: summary.dependencies.length.toString()}),
      React.createElement(Field, {label: 'Controller health', value: React.createElement(HealthBadge, summary.health)})
    ),
    React.createElement('p', {className: 'wf-result-note', role: 'status'}, summary.health.reason),
    React.createElement(PartialEvidence, summary.health),
    React.createElement('section', {'aria-label': 'Sensor dependencies', className: 'wf-event-section'},
      React.createElement('h4', null, 'Dependencies'),
      summary.dependencyExpression ? React.createElement('p', null, 'Condition: ', React.createElement('code', {className: 'wf-event-expression'}, summary.dependencyExpression)) : null,
      summary.dependencies.length
        ? React.createElement('div', {className: 'wf-table-wrap'}, React.createElement('table', {className: 'wf-event-table'},
          React.createElement('caption', null, 'Direct EventSource dependency references'),
          React.createElement('thead', null, React.createElement('tr', null, ['Dependency', 'EventSource', 'Event', 'Filters'].map(label => React.createElement('th', {key: label, scope: 'col'}, label)))),
          React.createElement('tbody', null, summary.dependencies.map(dependency => React.createElement('tr', {key: dependency.name},
            React.createElement('td', null, dependency.name), React.createElement('td', null, React.createElement(EventSourceLink, {tree, name: dependency.eventSourceName, namespace: summary.namespace})), React.createElement('td', null, dependency.eventName || '—'), React.createElement('td', null, dependency.filters.join(', ') || 'None')
          )))
        ))
        : React.createElement('p', {role: 'status'}, 'No event dependencies are declared.'),
    ),
    React.createElement('section', {'aria-label': 'Sensor triggers', className: 'wf-event-section'},
      React.createElement('h4', null, 'Triggers'),
      summary.triggers.length
        ? React.createElement('div', {className: 'wf-table-wrap'}, React.createElement('table', {className: 'wf-event-table'},
          React.createElement('caption', null, 'Configured trigger targets and controller evidence'),
          React.createElement('thead', null, React.createElement('tr', null, ['Trigger', 'Type', 'Target', 'Policy', 'Health'].map(label => React.createElement('th', {key: label, scope: 'col'}, label)))),
          React.createElement('tbody', null, summary.triggers.map(trigger => React.createElement('tr', {key: trigger.name},
            React.createElement('td', null, trigger.name), React.createElement('td', null, trigger.type), React.createElement('td', null, React.createElement(TriggerTarget, {trigger, namespace: triggerNamespace(sensor, trigger)})), React.createElement('td', null, trigger.hasPolicy ? 'Configured' : 'None'), React.createElement('td', null, React.createElement(HealthBadge, trigger.health))
          )))
        ))
        : React.createElement('p', {role: 'status'}, 'No triggers are declared.'),
    ),
    React.createElement('section', {'aria-label': 'Sensor conditions', className: 'wf-event-section'}, React.createElement('h4', null, 'Conditions'), React.createElement(Conditions, {conditions: sensor.status?.conditions}))
  );
}

function EventBusDetails({bus}: {bus: EventBusManifest}) {
  const summary = eventBusSummary(bus);
  const implementation = summary.implementation === 'jetstream' || summary.implementation === 'nats' ? summary.implementation : summary.implementation ? 'Configured' : undefined;
  return React.createElement(
    React.Fragment,
    null,
    React.createElement('dl', {className: 'wf-summary'},
      React.createElement(Field, {label: 'Namespace', value: summary.namespace}),
      React.createElement(Field, {label: 'EventBus', value: summary.name}),
      React.createElement(Field, {label: 'Implementation', value: implementation}),
      React.createElement(Field, {label: 'Controller health', value: React.createElement(HealthBadge, summary.health)})
    ),
    React.createElement('p', {className: 'wf-result-note', role: 'status'}, summary.health.reason),
    React.createElement(PartialEvidence, summary.health),
    React.createElement('section', {'aria-label': 'EventBus conditions', className: 'wf-event-section'}, React.createElement('h4', null, 'Conditions'), React.createElement(Conditions, {conditions: bus.status?.conditions}))
  );
}

export function eventViewState(resource: ResourceState | undefined, state: EventResourceState): EventViewState {
  const status = typeof resource?.error === 'object' && resource.error ? resource.error.status : undefined;
  if (status === 401) return 'authentication';
  if (status === 403) return 'permission';
  if (status === 404) return 'missing';
  if (resource?.manifest !== undefined && !eventManifest(resource)) return 'malformed';
  return resource?.error && state !== 'permission' ? 'error' : state;
}

export function EventResourceView({application, tree, resource, kind}: {application?: ApplicationState; tree?: ApplicationTree; resource?: ResourceState; kind: EventResourceKind}) {
  const manifest = kind === 'EventSource'
    ? eventSourceManifest(resource)
    : kind === 'Sensor'
      ? sensorManifest(resource)
      : eventBusManifest(resource);
  const resolvedResource = manifest
    ? {...resource, ...manifest, metadata: {...resource?.metadata, ...manifest.metadata}} as ResourceState
    : resource;
  const title = manifest?.metadata?.name || kind;
  const details = !manifest
    ? React.createElement('p', {role: 'alert'}, `${kind} data could not be read.`)
    : kind === 'EventSource'
      ? React.createElement(EventSourceDetails, {source: manifest as EventSourceManifest})
      : kind === 'Sensor'
        ? React.createElement(SensorDetails, {sensor: manifest as SensorManifest, tree})
        : React.createElement(EventBusDetails, {bus: manifest as EventBusManifest});

  return React.createElement(
    React.Fragment,
    null,
    React.createElement('style', null, EVENT_RESOURCE_STYLES),
    React.createElement('div', {className: 'wf-view-header'}, React.createElement('div', null, React.createElement('h3', null, title), React.createElement('p', null, `${kind} · read-only controller state`))),
    details,
    React.createElement(EventChainView, {application, tree, resource: resolvedResource, kind})
  );
}
