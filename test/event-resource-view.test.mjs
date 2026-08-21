import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('registers read-only EventSource, Sensor, and EventBus tabs with bounded chain handoff', async () => {
  const [entry, view] = await Promise.all([
    readFile(new URL('../src/index.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/event-resource-view.tsx', import.meta.url), 'utf8')
  ]);

  assert.match(entry, /registerResourceExtension\(EventSourceTab, 'argoproj\.io', 'EventSource', 'EVENT SOURCE'\)/);
  assert.match(entry, /registerResourceExtension\(SensorTab, 'argoproj\.io', 'Sensor', 'SENSOR'\)/);
  assert.match(entry, /registerResourceExtension\(EventBusTab, 'argoproj\.io', 'EventBus', 'EVENT BUS'\)/);
  assert.match(entry, /registerAppViewExtension\(ApplicationEventsView, 'Events', 'fa-bolt'\)/);
  assert.match(entry, /EventSource view could not be rendered/);
  assert.match(view, /import \{EventChainView\} from '\.\/event-chain-view'/);
  assert.match(view, /eventSourceManifest\(resource\)/);
  assert.match(view, /sensorManifest\(resource\)/);
  assert.match(view, /eventBusManifest\(resource\)/);
  assert.match(view, /React\.createElement\(EventChainView, \{application, tree, resource: resolvedResource, kind\}\)/);
  assert.match(view, /Safe source configuration summary/);
  assert.match(view, /Direct EventSource dependency references/);
  assert.match(view, /Configured trigger targets and controller evidence/);
  assert.match(view, /Controller conditions/);
  assert.match(view, /Partial controller evidence/);
  assert.match(view, /Controller activity/);
  assert.match(view, /exactTreeResource/);
  assert.match(view, /Workflow target is not named/);
  assert.match(view, /status === 401\) return 'authentication'/);
  assert.match(view, /status === 404\) return 'missing'/);
  assert.match(view, /aria-label': 'EventSource events'/);
  assert.match(view, /resource\?\.manifest !== undefined && !eventManifest\(resource\)\) return 'malformed'/);
  assert.doesNotMatch(view, /port-forward|kubectl|fetch\(/);
});
