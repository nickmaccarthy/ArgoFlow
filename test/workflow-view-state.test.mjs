import assert from 'node:assert/strict';
import test from 'node:test';

import {decodeWorkspaceHash, defaultSelectedNodeId, WORKSPACE_VIEW_HASH_KEY, WORKSPACE_QUERY_HASH_KEY, WORKSPACE_NODE_HASH_KEY} from '../src/workflow-view-state.ts';
import {parseHashState, serializeHashState} from '../src/url-state.ts';
import {decodeNodePhases, encodeNodePhases, NODE_PHASES_HASH_KEY, normalizeWorkflowNodes} from '../src/workflow-nodes.ts';

const workflow = {
  status: {
    nodes: {
      build: {id: 'build', name: 'demo.build', displayName: 'build', type: 'Pod', phase: 'Succeeded'},
      serve: {id: 'serve', name: 'demo.serve', displayName: 'serve', type: 'Pod', phase: 'Running'},
      report: {id: 'report', name: 'demo.report', displayName: 'report', type: 'Pod', phase: 'Failed'}
    }
  }
};

const nodes = normalizeWorkflowNodes(workflow);

test('empty hash -> view: dag, query: "", phases: [], selectedId: undefined', () => {
  const hashState = parseHashState('');
  const result = decodeWorkspaceHash(hashState, {largeWorkflow: false, nodes});
  assert.strictEqual(result.view, 'dag');
  assert.strictEqual(result.query, '');
  assert.deepStrictEqual(result.phases, []);
  assert.strictEqual(result.selectedId, undefined);
});

test('invalid view value drops to dag', () => {
  const hashState = {};
  hashState[WORKSPACE_VIEW_HASH_KEY] = 'zzz';
  const result = decodeWorkspaceHash(hashState, {largeWorkflow: false, nodes});
  assert.strictEqual(result.view, 'dag');
});

test('invalid view value with largeWorkflow -> list', () => {
  const hashState = {};
  hashState[WORKSPACE_VIEW_HASH_KEY] = 'dag';
  const result = decodeWorkspaceHash(hashState, {largeWorkflow: true, nodes});
  assert.strictEqual(result.view, 'list');
});

test('grid view passes through with largeWorkflow', () => {
  const hashState = {};
  hashState[WORKSPACE_VIEW_HASH_KEY] = 'grid';
  const result = decodeWorkspaceHash(hashState, {largeWorkflow: true, nodes});
  assert.strictEqual(result.view, 'grid');
});

test('phase decode drops unknown and malformed values', () => {
  const hashState = {};
  hashState[NODE_PHASES_HASH_KEY] = 'toString,constructor,bogus,Running';
  const result = decodeWorkspaceHash(hashState, {largeWorkflow: false, nodes});
  assert.deepStrictEqual(result.phases, ['Running']);
});

test('run.node=does-not-exist yields selectedId: undefined', () => {
  const hashState = {};
  hashState[WORKSPACE_NODE_HASH_KEY] = 'does-not-exist';
  const result = decodeWorkspaceHash(hashState, {largeWorkflow: false, nodes});
  assert.strictEqual(result.selectedId, undefined);
});

test('valid deep link end-to-end: serialize then parse decode', () => {
  const hashState = {
    [WORKSPACE_VIEW_HASH_KEY]: 'list',
    [WORKSPACE_QUERY_HASH_KEY]: 'serve',
    [NODE_PHASES_HASH_KEY]: encodeNodePhases(['Running', 'Failed']),
    [WORKSPACE_NODE_HASH_KEY]: 'serve'
  };
  const serialized = serializeHashState('', hashState);
  const parsed = parseHashState(`#${serialized}`);
  const result = decodeWorkspaceHash(parsed, {largeWorkflow: false, nodes});
  assert.strictEqual(result.view, 'list');
  assert.strictEqual(result.query, 'serve');
  assert.deepStrictEqual(result.phases, ['Running', 'Failed']);
  assert.strictEqual(result.selectedId, 'serve');
});

test('DAG budget: largeWorkflow true, run.view=dag -> list', () => {
  const hashState = {};
  hashState[WORKSPACE_VIEW_HASH_KEY] = 'dag';
  const result = decodeWorkspaceHash(hashState, {largeWorkflow: true, nodes});
  assert.strictEqual(result.view, 'list');
});

test('DAG budget: largeWorkflow true, run.view=grid -> grid', () => {
  const hashState = {};
  hashState[WORKSPACE_VIEW_HASH_KEY] = 'grid';
  const result = decodeWorkspaceHash(hashState, {largeWorkflow: true, nodes});
  assert.strictEqual(result.view, 'grid');
});

test('DAG budget: largeWorkflow false, run.view=dag -> dag', () => {
  const hashState = {};
  hashState[WORKSPACE_VIEW_HASH_KEY] = 'dag';
  const result = decodeWorkspaceHash(hashState, {largeWorkflow: false, nodes});
  assert.strictEqual(result.view, 'dag');
});

test('URL-authoritative: hash without run.node yields selectedId: undefined', () => {
  const hashState = {};
  hashState[WORKSPACE_VIEW_HASH_KEY] = 'list';
  hashState[WORKSPACE_QUERY_HASH_KEY] = 'serve';
  // No run.node key
  const result = decodeWorkspaceHash(hashState, {largeWorkflow: false, nodes});
  assert.strictEqual(result.selectedId, undefined);
});

test('defaultSelectedNodeId returns Running node id separately', () => {
  const result = defaultSelectedNodeId(nodes);
  assert.strictEqual(result, 'serve');
});

test('back/forward semantics: decode hash A then hash B reflects B not A', () => {
  // Hash A: grid view with phases and selected node
  const hashStateA = {
    [WORKSPACE_VIEW_HASH_KEY]: 'grid',
    [NODE_PHASES_HASH_KEY]: encodeNodePhases(['Failed']),
    [WORKSPACE_NODE_HASH_KEY]: 'report'
  };
  const resultA = decodeWorkspaceHash(hashStateA, {largeWorkflow: false, nodes});
  assert.strictEqual(resultA.view, 'grid');
  assert.deepStrictEqual(resultA.phases, ['Failed']);
  assert.strictEqual(resultA.selectedId, 'report');

  // Hash B: plain list view, no phases, no node
  const hashStateB = {
    [WORKSPACE_VIEW_HASH_KEY]: 'list'
  };
  const resultB = decodeWorkspaceHash(hashStateB, {largeWorkflow: false, nodes});
  assert.strictEqual(resultB.view, 'list');
  assert.deepStrictEqual(resultB.phases, []);
  assert.strictEqual(resultB.selectedId, undefined);
});