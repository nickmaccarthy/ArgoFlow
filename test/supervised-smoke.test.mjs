import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';

const supervisor = resolve('scripts/supervised-smoke.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture({smoke, forward, timeout = 12000}) {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'argoflow-forward-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const port = await freePort();
  const count = join(dir, 'starts');
  const flag = join(dir, 'stall');
  const forwardSource = join(bin, 'forward.mjs');
  writeFileSync(forwardSource, forward);
  writeFileSync(join(bin, 'kubectl'), `#!/bin/sh\nexec node "${forwardSource}" "$@"\n`, {mode: 0o755});
  const smokeFile = join(dir, 'smoke.mjs');
  writeFileSync(smokeFile, smoke);
  const child = spawn(process.execPath, [supervisor, process.execPath, smokeFile], {
    cwd: dir,
    env: {...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_PORT: String(port), TEST_COUNT: count,
      TEST_STALL: flag, ARGOCD_HEALTH_URL: `http://127.0.0.1:${port}/healthz?full=true`,
      ARGOCD_PROBE_INTERVAL_MS: '40', ARGOCD_PROBE_TIMEOUT_MS: '100', ARGOCD_READY_ATTEMPTS: '15',
      ARGOCD_MAX_RESTARTS: '2'},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  const result = await new Promise(resolve => child.on('exit', (code, signal) => resolve({code, signal})));
  clearTimeout(timer);
  await pause(40);
  const starts = readFileSync(count, 'utf8').trim().split('\n').length;
  rmSync(dir, {recursive: true, force: true});
  return {...result, starts, output};
}

const forward = `import http from 'node:http';
import {appendFileSync, existsSync, unlinkSync} from 'node:fs';
appendFileSync(process.env.TEST_COUNT, process.pid + '\\n');
if (existsSync(process.env.TEST_STALL)) unlinkSync(process.env.TEST_STALL);
const server = http.createServer((req, res) => {
  if (existsSync(process.env.TEST_STALL)) return; // PID is alive, streams stall.
  res.writeHead(200); res.end('ok');
});
server.listen(Number(process.env.TEST_PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

const recoverySmoke = `import {writeFileSync, readFileSync} from 'node:fs';
writeFileSync(process.env.TEST_STALL, 'stalled');
const until = Date.now() + 5000;
while (Date.now() < until) {
  if (readFileSync(process.env.TEST_COUNT, 'utf8').trim().split('\\n').length >= 2) process.exit(0);
  await new Promise(resolve => setTimeout(resolve, 20));
}
process.exit(1);
`;

test('restarts a live port-forward whose HTTP streams stall while smoke is running', async () => {
  const result = await fixture({smoke: recoverySmoke, forward});
  assert.equal(result.code, 0, result.output);
  assert.equal(result.starts, 2, result.output);
  assert.match(result.output, /two consecutive HTTP health failures; restarting/);
});

test('restarts an exited forward while smoke is running', async () => {
  const result = await fixture({smoke: recoverySmoke.replace("writeFileSync(process.env.TEST_STALL, 'stalled');", "process.kill(Number(readFileSync(process.env.TEST_COUNT, 'utf8').trim()), 'SIGTERM');"), forward});
  assert.equal(result.code, 0, result.output);
  assert.equal(result.starts, 2, result.output);
});

test('does not retry a failing smoke assertion', async () => {
  const result = await fixture({smoke: "console.error('assertion failed'); process.exit(7);", forward});
  assert.equal(result.code, 1, result.output);
  assert.equal(result.starts, 1, result.output);
  assert.match(result.output, /smoke exited with 7/);
});

test('fails when an established transport cannot be restored', async () => {
  const neverHealthyAfterRestart = forward.replace(
    "if (existsSync(process.env.TEST_STALL)) unlinkSync(process.env.TEST_STALL);",
    "if (existsSync(process.env.TEST_STALL) && existsSync(process.env.TEST_COUNT)) { /* keep stalled */ }"
  );
  const result = await fixture({smoke: `import {writeFileSync} from 'node:fs';
writeFileSync(process.env.TEST_STALL, 'stalled');
await new Promise(resolve => setTimeout(resolve, 5000));`, forward: neverHealthyAfterRestart});
  assert.equal(result.code, 1, result.output);
  assert.equal(result.starts, 2, result.output);
  assert.match(result.output, /did not recover after restart 1/);
});

test('does not start smoke if initial HTTP readiness never succeeds', async () => {
  const noHealth = forward.replace("res.writeHead(200); res.end('ok');", "res.writeHead(503); res.end('unhealthy');");
  const result = await fixture({smoke: "console.log('SMOKE_STARTED');", forward: noHealth});
  assert.equal(result.code, 1, result.output);
  assert.equal(result.starts, 1, result.output);
  assert.doesNotMatch(result.output, /SMOKE_STARTED/);
  assert.match(result.output, /did not become HTTP healthy at startup/);
});
