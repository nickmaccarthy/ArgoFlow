import assert from 'node:assert/strict';
import test from 'node:test';

import {JSDOM} from 'jsdom';
import React from 'react';
import ReactDOM from 'react-dom';
import {act} from 'react-dom/test-utils';

import {ApplicationWorkflowsView} from '../src/application-workflows-view.ts';
import {parseHashState} from '../src/url-state.ts';
import {WorkflowWorkspace} from '../src/workflow-workspace.tsx';

const workflow = {
  metadata: {name: 'demo', namespace: 'workflows'},
  status: {
    nodes: {
      build: {id: 'build', name: 'demo.build', displayName: 'build', type: 'Pod', phase: 'Succeeded'},
      serve: {id: 'serve', name: 'demo.serve', displayName: 'serve', type: 'Pod', phase: 'Running'},
      report: {id: 'report', name: 'demo.report', displayName: 'report', type: 'Pod', phase: 'Failed'}
    }
  }
};

function installDom(hash = '') {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {url: `https://argocd.example/app${hash}`});
  const previous = new Map();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'HashChangeEvent', 'CustomEvent']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {configurable: true, value: dom.window[key], writable: true});
  }
  return {
    container: dom.window.document.querySelector('#root'),
    window: dom.window,
    navigate(nextHash) {
      dom.window.history.replaceState(null, '', `/app${nextHash}`);
      dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    },
    cleanup() {
      act(() => { ReactDOM.unmountComponentAtNode(dom.window.document.querySelector('#root')); });
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor === undefined) delete globalThis[key];
        else Object.defineProperty(globalThis, key, descriptor);
      }
    }
  };
}

async function render(element, container) {
  await act(async () => {
    ReactDOM.render(element, container);
    await Promise.resolve();
  });
}

async function navigate(dom, hash) {
  await act(async () => {
    dom.navigate(hash);
    await Promise.resolve();
  });
}

function pressed(container, label) {
  return container.querySelector(`button[aria-pressed="true"]`)?.textContent === label;
}

test('mounted Workflow workspace reconciles external hash navigation and ignores its own hash patch', async () => {
  const dom = installDom('#argoflow:run.view=list');
  try {
    await render(React.createElement(WorkflowWorkspace, {workflow}), dom.container);
    assert.equal(pressed(dom.container, 'List'), true);

    await navigate(dom, '#argoflow:run.view=grid&argoflow:run.q=rep&argoflow:run.phases=Failed&argoflow:run.node=report');

    assert.equal(pressed(dom.container, 'Grid'), true);
    assert.equal(dom.container.querySelector('input[type="search"]').value, 'rep');
    assert.equal(dom.container.querySelector('[aria-label="Remove Failed filter"]')?.textContent, 'Failed×');
    assert.equal(dom.container.querySelector('[aria-label="Selected node details"] h4')?.textContent, 'report');
    assert.deepEqual([...dom.container.querySelectorAll('.wf-status-cell')].map(cell => cell.getAttribute('aria-label')), ['report: Failed']);

    const gridState = parseHashState(dom.window.location.hash);
    await act(async () => {
      dom.container.querySelector('.wf-segmented button:nth-child(3)').dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
      await Promise.resolve();
    });
    assert.deepEqual(parseHashState(dom.window.location.hash), gridState);
    assert.equal(pressed(dom.container, 'Grid'), true);
    assert.equal(dom.container.querySelector('[aria-label="Selected node details"] h4')?.textContent, 'report');

    // A local change after external navigation must not be rolled back by the
    // hash state the view itself just patched.
    await act(async () => {
      dom.container.querySelector('.wf-segmented button:nth-child(2)').dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
      await Promise.resolve();
    });
    assert.equal(pressed(dom.container, 'List'), true);
    assert.equal(parseHashState(dom.window.location.hash)['run.view'], 'list');
    assert.equal(dom.container.querySelector('input[type="search"]').value, 'rep');
    assert.equal(dom.container.querySelector('[aria-label="Workflow nodes"] [role="table"]')?.getAttribute('aria-rowcount'), '2');
    assert.equal(dom.container.querySelector('[aria-label="Selected node details"] h4')?.textContent, 'report');

    // Absent keys must clear the previous query, phase and node selection in
    // the mounted view, rather than reusing the mount-time default node.
    await navigate(dom, '#argoflow:run.view=list');
    assert.equal(pressed(dom.container, 'List'), true);
    assert.equal(dom.container.querySelector('input[type="search"]').value, '');
    assert.equal(dom.container.querySelector('[aria-label^="Remove "]'), null);
    assert.equal(dom.container.querySelector('[aria-label="Workflow nodes"] [role="table"]')?.getAttribute('aria-rowcount'), '4');
    assert.equal(dom.container.querySelector('[aria-label="Selected node details"]'), null);

    await navigate(dom, '#argoflow:run.view=invalid&argoflow:run.phases=invalid&argoflow:run.node=missing');

    assert.equal(pressed(dom.container, 'DAG'), true);
    assert.equal(dom.container.querySelector('input[type="search"]').value, '');
    assert.equal(dom.container.querySelector('[aria-label^="Remove "]'), null);
    assert.equal(dom.container.querySelector('[aria-label="Selected node details"]'), null);

    await act(async () => {
      dom.container.querySelector('.wf-segmented button:nth-child(3)').dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
      await Promise.resolve();
    });
    assert.equal(pressed(dom.container, 'Grid'), true);
    assert.equal(parseHashState(dom.window.location.hash)['run.view'], 'grid');
  } finally {
    dom.cleanup();
  }
});

test('mounted runs view clears an Application cursor before later hash navigation and reconciles valid fields', async () => {
  const dom = installDom('#argoflow:runs.source=Archive&argoflow:runs.cursor=A-page2&argoflow:runs.query=old');
  const callsA = [];
  const callsB = [];
  const page = cursor => ({
    rows: [], excluded: [], pageSize: 25, source: 'Archive', cursor, state: 'empty',
    capability: {live: 'available', archive: {state: 'available'}}
  });
  const archiveA = {capability: {state: 'available'}, fetchPage: async request => { callsA.push(request); return page(request.cursor); }};
  const archiveB = {capability: {state: 'available'}, fetchPage: async request => { callsB.push(request); return page(request.cursor); }};
  const applicationA = {metadata: {uid: 'app-a', namespace: 'argocd', name: 'a'}};
  const applicationB = {metadata: {uid: 'app-b', namespace: 'argocd', name: 'b'}};

  try {
    await render(React.createElement(ApplicationWorkflowsView, {application: applicationA, archive: archiveA, tree: {nodes: []}}), dom.container);
    assert.equal(callsA.at(-1)?.cursor, 'A-page2');

    await render(React.createElement(ApplicationWorkflowsView, {application: applicationB, archive: archiveB, tree: {nodes: []}}), dom.container);
    assert.equal(callsB.at(-1)?.cursor, undefined);
    assert.equal(parseHashState(dom.window.location.hash)['runs.cursor'], undefined);

    await navigate(dom, '#argoflow:runs.source=Archive&argoflow:runs.query=new');
    assert.equal(callsB.some(call => call.cursor === 'A-page2'), false);
    assert.equal(dom.container.querySelector('[aria-label="Filter by name or template"]').value, 'new');

    await navigate(dom, '#argoflow:runs.source=Archive&argoflow:runs.cursor=B-page2&argoflow:runs.phase=Failed&argoflow:runs.query=report&argoflow:runs.namespace=workflows&argoflow:runs.lifecycle=completed&argoflow:runs.from=2026-09-01&argoflow:runs.to=2026-09-26');
    assert.equal(callsB.at(-1)?.cursor, 'B-page2');
    assert.equal(dom.container.querySelector('[aria-label="Workflow run source"]').value, 'Archive');
    assert.equal(dom.container.querySelector('[aria-label="Filter by status"]').value, 'Failed');
    assert.equal(dom.container.querySelector('[aria-label="Filter by name or template"]').value, 'report');
    assert.equal(dom.container.querySelector('[aria-label="Filter by namespace"]').value, 'workflows');
    assert.equal(dom.container.querySelector('[aria-label="Filter active or completed runs"]').value, 'completed');
    assert.equal(dom.container.querySelector('[aria-label="Runs from date"]').value, '2026-09-01');
    assert.equal(dom.container.querySelector('[aria-label="Runs to date"]').value, '2026-09-26');

    await navigate(dom, '#argoflow:runs.source=invalid&argoflow:runs.phase=invalid&argoflow:runs.lifecycle=invalid');
    assert.equal(dom.container.querySelector('[aria-label="Workflow run source"]').value, 'Live');
    assert.equal(dom.container.querySelector('[aria-label="Filter by status"]').value, '');
    assert.equal(dom.container.querySelector('[aria-label="Filter active or completed runs"]').value, 'all');
    assert.equal(dom.container.querySelector('[aria-label="Filter by name or template"]').value, '');
  } finally {
    dom.cleanup();
  }
});

test('coordinated host navigation keeps the incoming Application\'s deep-linked cursor', async () => {
  const dom = installDom('#argoflow:runs.source=Archive&argoflow:runs.cursor=A-page2');
  const callsA = [];
  const callsB = [];
  const page = cursor => ({
    rows: [], excluded: [], pageSize: 25, source: 'Archive', cursor, state: 'empty',
    capability: {live: 'available', archive: {state: 'available'}}
  });
  const archiveA = {capability: {state: 'available'}, fetchPage: async request => { callsA.push(request); return page(request.cursor); }};
  const archiveB = {capability: {state: 'available'}, fetchPage: async request => { callsB.push(request); return page(request.cursor); }};
  const applicationA = {metadata: {uid: 'app-a', namespace: 'argocd', name: 'a'}};
  const applicationB = {metadata: {uid: 'app-b', namespace: 'argocd', name: 'b'}};

  try {
    await render(React.createElement(ApplicationWorkflowsView, {application: applicationA, archive: archiveA, tree: {nodes: []}}), dom.container);
    assert.equal(callsA.at(-1)?.cursor, 'A-page2');

    // Model coordinated navigation: update the URL hash to B's cursor before B renders,
    // without dispatching hashchange (simulating the URL being updated first).
    dom.window.history.replaceState(null, '', '#argoflow:runs.source=Archive&argoflow:runs.cursor=B-page2');

    await render(React.createElement(ApplicationWorkflowsView, {application: applicationB, archive: archiveB, tree: {nodes: []}}), dom.container);

    // Dispatch that navigation's hashchange WITHOUT rewriting the hash: re-writing it
    // here would mask the regression, because the pre-fix switch effect deleted the
    // incoming cursor from the URL and a helper that re-sets it would restore it.
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
      await Promise.resolve();
    });

    // The valid deep link survives: B-page2 is preserved in the hash.
    assert.equal(parseHashState(dom.window.location.hash)['runs.cursor'], 'B-page2');
    // B loads its page 2, not its first page.
    assert.equal(callsB.at(-1)?.cursor, 'B-page2');
    // The outgoing Application's token never crosses over.
    assert.equal(callsB.some(call => call.cursor === 'A-page2'), false);
    // A's last recorded cursor is unchanged.
    assert.equal(callsA.at(-1)?.cursor, 'A-page2');
  } finally {
    dom.cleanup();
  }
});
