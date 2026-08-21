import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const [entry, applicationView, dag, nodes] = await Promise.all([
  readFile(new URL('../src/index.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/application-workflows-view.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/workflow-dag-view.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/workflow-nodes-view.tsx', import.meta.url), 'utf8')
]);

test('keeps extension UI names, focus treatment, and host-theme CSS scoped', () => {
  assert.match(applicationView, /#workflow-extension button:focus-visible/);
  assert.match(applicationView, /body\[style\*="background: rgb\(16, 15, 15\)"\] #workflow-extension/);
  assert.match(applicationView, /wf-segmented button:disabled/);
  assert.match(entry, /WORKFLOW_EXTENSION_STYLES/);
  assert.match(entry, /Workflow view could not be rendered/);
  assert.match(dag, /aria-label="Workflow DAG"/);
  assert.match(dag, /event\.key === 'Enter' \|\| event\.key === ' '/);
  assert.match(dag, /className="wf-dag-card"/);
  assert.match(dag, /workflowEdgePath\(from, to\)/);
  assert.match(dag, /GraphIconButton action="zoom-in"/);
  assert.match(applicationView, /\.wf-icon-button svg/);
  assert.match(nodes, /aria-label': `View details for \$\{node\.displayName\}`/);
  assert.match(nodes, /wf-node-table-button/);
  assert.match(nodes, /React\.createElement\('pre', null, React\.createElement\('code'/);
  assert.match(nodes, /waiting for resume\. No Pod or logs are available/);
  assert.match(nodes, /wf-node-related-button/);
  assert.match(entry, /argoResourceHref/);
  assert.match(entry, /'WorkflowTemplate'/);
  assert.match(entry, /'Pod'.*'logs'/s);
});
