import {readFile} from 'node:fs/promises';

const accepted = new Set([
  '(BSD-2-Clause OR MIT OR Apache-2.0)',
  '(MIT OR CC0-1.0)',
  'Apache-2.0',
  'Artistic-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'Python-2.0',
]);
const acceptedMissing = new Set(['node_modules/npm/node_modules/qrcode-terminal']); // Apache-2.0; omitted from its lock metadata.
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const invalid = Object.entries(lock.packages)
  .filter(([path, pkg]) => path && !accepted.has(pkg.license) && !acceptedMissing.has(path))
  .map(([path, pkg]) => `${path}: ${pkg.license ?? 'missing license'}`);

if (invalid.length) throw new Error(`Unapproved dependency licenses:\n${invalid.join('\n')}`);
console.log(`License check passed for ${Object.keys(lock.packages).length - 1} locked packages.`);
