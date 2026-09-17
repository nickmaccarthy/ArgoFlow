import assert from 'node:assert/strict';
import test from 'node:test';

import {parseHashState, serializeHashState, mergeHashState} from '../src/url-state.ts';

test('parses only namespaced argoflow keys and leaves host keys alone', () => {
  const state = parseHashState('#argocd-view=tree&argoflow:runs.source=Archive&argoflow:run.node=abc');
  assert.deepEqual(state, {'runs.source': 'Archive', 'run.node': 'abc'});
  assert.deepEqual(parseHashState(''), {});
  assert.deepEqual(parseHashState('#argoflow:broken'), {}); // valueless key is dropped
});

test('round-trips values through percent encoding and stable ordering', () => {
  const hash = serializeHashState('', {'run.q': 'hello world/x&y', 'runs.source': 'Live'});
  const reparsed = parseHashState(hash);
  assert.deepEqual(reparsed, {'run.q': 'hello world/x&y', 'runs.source': 'Live'});
  // Keys are sorted so identical state always serializes identically.
  assert.equal(serializeHashState('', {'a': '1', 'b': '2'}), serializeHashState('', {'b': '2', 'a': '1'}));
});

test('merging deletes empty values while serialization preserves foreign pairs', () => {
  const merged = mergeHashState({'runs.cursor': 'page-2', 'run.node': 'n1'}, {'runs.cursor': undefined, 'run.view': 'grid'});
  assert.deepEqual(merged, {'run.node': 'n1', 'run.view': 'grid'});

  const original = '#host-panel=logs';
  const rewritten = serializeHashState(original, mergeHashState(parseHashState(original), {'run.view': 'dag'}));
  assert.match(rewritten, /(^|&)host-panel=logs(&|$)/);
  assert.match(rewritten, /argoflow:run\.view=dag/);
});

test('serializing without namespaced or foreign values yields an empty, clean URL hash', () => {
  assert.equal(serializeHashState('', {}), '');
  assert.equal(serializeHashState('', mergeHashState({'run.node': 'x'}, {'run.node': undefined})), '');
});
