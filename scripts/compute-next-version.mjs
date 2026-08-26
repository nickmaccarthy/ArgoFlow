/**
 * Prints the version semantic-release would publish for HEAD, without touching
 * git state or the network.
 *
 * The release workflow builds the bundle BEFORE `semantic-release` runs, and
 * semantic-release never commits a package.json bump, so webpack cannot read
 * the released version from package.json. This dry run computes the identical
 * next version from the same commit range so the build can inject it via
 * ARGOFLOW_VERSION. When no release is pending (e.g. chore-only commits) it
 * falls back to the checked-in package.json value, which is then correct.
 */
import {readFile} from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const config = JSON.parse(await readFile(new URL('../.releaserc.json', import.meta.url), 'utf8'));

const {default: semrel} = await import('semantic-release');
const result = await semrel({
  ...config,
  // Analysis only: no prepare/publish plugins, so no git writes and no API
  // calls. A failing analysis must fail loudly rather than silently shipping a
  // stale version, so errors propagate to a nonzero exit.
  plugins: [['@semantic-release/commit-analyzer', {}]],
  ci: false,
  dryRun: true
});

process.stdout.write(result?.nextRelease?.version ?? pkg.version);
