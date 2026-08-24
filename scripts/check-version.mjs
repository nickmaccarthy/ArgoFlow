import {readFile} from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
// Release builds must embed the semantic-release-computed version; local and
// PR builds fall back to the checked-in package.json value.
const expected = process.env.ARGOFLOW_VERSION || pkg.version;
const bundle = await readFile(new URL('../dist/extension-workflows.js', import.meta.url), 'utf8');

if (!bundle.includes(JSON.stringify(expected))) {
  throw new Error(`Built bundle does not embed version ${expected} (package.json is ${pkg.version}); rebuild before checking.`);
}

console.log(`Version check passed: bundle reports ${expected}.`);
