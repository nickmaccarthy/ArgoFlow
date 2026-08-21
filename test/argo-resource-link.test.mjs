import assert from 'node:assert/strict';
import test from 'node:test';

import {argoResourceHref} from '../src/argo-resource-link.ts';

test('builds Argo CD resource links for templates and core Pods', () => {
  assert.equal(
    argoResourceHref({group: 'argoproj.io', kind: 'WorkflowTemplate', namespace: 'argo', name: 'build'}, 'extension-0', '/applications/demo'),
    '/applications/demo?view=Tree&resource=&node=argoproj.io%2FWorkflowTemplate%2Fargo%2Fbuild%2F0&tab=extension-0'
  );
  assert.equal(
    argoResourceHref({kind: 'Pod', namespace: 'argo', name: 'build-123'}, 'logs', '/applications/demo'),
    '/applications/demo?view=Tree&resource=&node=%2FPod%2Fargo%2Fbuild-123%2F0&tab=logs'
  );
});
