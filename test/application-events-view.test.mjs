import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('renders a dedicated bounded Application Events workspace', async () => {
  const source = await readFile(new URL('../src/application-events-view.tsx', import.meta.url), 'utf8');
  assert.match(source, /loadApplicationEventData/);
  assert.match(source, /Event infrastructure, routing, and verified Workflow chains/);
  assert.match(source, /<EventChainGraphView data=\{data\} heading="Verified event chains"/);
  assert.match(source, /Refreshing Event evidence in place/);
});
