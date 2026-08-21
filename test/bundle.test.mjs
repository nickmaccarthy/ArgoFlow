import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const bundle = await readFile(new URL('../dist/extension-workflows.js', import.meta.url), 'utf8');

test('builds an Argo CD extension without bundling React', () => {
  assert.match(bundle, /registerAppViewExtension/);
  assert.match(bundle, /registerResourceExtension/);
  assert.match(bundle, /argoproj\.io/);
  assert.doesNotMatch(bundle, /__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED/);
});
