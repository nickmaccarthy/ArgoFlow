import assert from 'node:assert/strict';
import test from 'node:test';

import {decodeNodePhases, encodeNodePhases, NODE_PHASES_HASH_KEY} from '../src/workflow-nodes.ts';
import {filterWorkflowNodes, normalizeWorkflowNodes} from '../src/workflow-nodes.ts';
import {parseHashState, serializeHashState} from '../src/url-state.ts';

const workflow = {
  status: {
    nodes: {
      build: {id: 'build', name: 'demo.build', displayName: 'build', type: 'Pod', phase: 'Succeeded'},
      serve: {id: 'serve', name: 'demo.serve', displayName: 'serve', type: 'Pod', phase: 'Running'},
      report: {id: 'report', name: 'demo.report', displayName: 'report', type: 'Pod', phase: 'Failed'}
    }
  }
};

test('phase codec round-trips a selection and omits empty ones from the hash', () => {
  assert.equal(encodeNodePhases([]), undefined);
  assert.equal(encodeNodePhases(['Running']), 'Running');
  // Duplicates collapse; insertion order is preserved for stable URLs.
  assert.deepEqual(decodeNodePhases(encodeNodePhases(['Running', 'Failed', 'Running'])), ['Running', 'Failed']);
});

test('phase decode drops unknown and malformed values instead of breaking the view', () => {
  assert.deepEqual(decodeNodePhases(undefined), []);
  assert.deepEqual(decodeNodePhases(''), []);
  assert.deepEqual(decodeNodePhases('Running,bogus,, Failed ,Succeeded'), ['Running', 'Failed', 'Succeeded']);
  assert.deepEqual(decodeNodePhases('bogus'), []);
  // Object.prototype names must not pass the membership check.
  assert.deepEqual(decodeNodePhases('toString,constructor,hasOwnProperty,Running'), ['Running']);
  // Every workflow phase plus the synthetic Unknown are accepted.
  assert.deepEqual(decodeNodePhases('Pending,Running,Succeeded,Failed,Error,Skipped,Omitted,Unknown'),
    ['Pending', 'Running', 'Succeeded', 'Failed', 'Error', 'Skipped', 'Omitted', 'Unknown']);
});

test('hard reload restores an active phase filter end-to-end from a copied URL', () => {
  const nodes = normalizeWorkflowNodes(workflow);

  // User filters to Running+Failed; the workspace writes namespaced hash state.
  const hash = serializeHashState('', {[NODE_PHASES_HASH_KEY]: encodeNodePhases(['Running', 'Failed'])});
  assert.match(hash, /argoflow:run\.phases=Running%2CFailed/);

  // A fresh mount (hard reload / shared link) reads the same key back.
  const restored = decodeNodePhases(parseHashState(`#${hash}`)[NODE_PHASES_HASH_KEY]);
  assert.deepEqual(restored, ['Running', 'Failed']);

  const visible = filterWorkflowNodes(nodes, '', restored);
  assert.deepEqual(visible.map(node => node.id), ['serve', 'report']);
});

test('both node-filter surfaces route through the persisted setter', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/workflow-workspace.tsx', import.meta.url), 'utf8'));
  assert.match(source, /setPhases=\{changePhases\}/);
  assert.match(source, /onFilterPhases=\{changePhases\}/);
  assert.match(source, /patchHash\(\{\[NODE_PHASES_HASH_KEY\]: encodeNodePhases\(next\)\}\)/);
  assert.doesNotMatch(source, /setPhases=\{setPhases/); // no direct setter may bypass persistence
});
