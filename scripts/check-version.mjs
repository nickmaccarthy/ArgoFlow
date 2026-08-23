import {readFile} from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const bundle = await readFile(new URL('../dist/extension-workflows.js', import.meta.url), 'utf8');

if (!bundle.includes(JSON.stringify(pkg.version))) {
  throw new Error(`Built bundle does not embed package version ${pkg.version}; rebuild before checking.`);
}

console.log(`Version check passed: bundle reports ${pkg.version}.`);
