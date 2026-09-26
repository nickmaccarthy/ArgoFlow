// Keep the CI port-forward usable throughout the smoke, not just at startup.
// Only transport is retried; the smoke's DOM and telemetry assertions remain blocking.
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const healthUrl = process.env.ARGOCD_HEALTH_URL || 'https://127.0.0.1:8090/healthz?full=true';
const intervalMs = Number(process.env.ARGOCD_PROBE_INTERVAL_MS || 3000);
const timeoutMs = Number(process.env.ARGOCD_PROBE_TIMEOUT_MS || 4000);
const readyAttempts = Number(process.env.ARGOCD_READY_ATTEMPTS || 30);
const maxRestarts = Number(process.env.ARGOCD_MAX_RESTARTS || 3);
const smokeCommand = process.argv.slice(2);
if (!smokeCommand.length) throw new Error('usage: node scripts/supervised-smoke.mjs <smoke command> [args...]');

const logStream = createWriteStream('artifacts-portforward.log', {flags: 'a'});
let forward;
let smoke;
let stopping = false;
let restarts = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    process.exitCode = 1;
    smoke?.kill(signal);
    forward?.kill(signal);
  });
}

function probe() {
  return new Promise(resolve => {
    const transport = healthUrl.startsWith('https:') ? https : http;
    const req = transport.get(healthUrl, {rejectUnauthorized: false, timeout: timeoutMs}, response => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    req.on('timeout', () => req.destroy(new Error('health probe timeout')));
    req.on('error', () => resolve(false));
  });
}

function startForward() {
  const child = spawn('kubectl', ['-n', 'argocd', 'port-forward', 'svc/argocd-server', '8090:443'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.pipe(logStream, {end: false});
  child.stderr.pipe(logStream, {end: false});
  child.ended = false;
  // Retain a rejection-free exit promise even if it exits between probes.
  child.exited = new Promise(resolve => {
    child.once('error', error => {
      child.ended = true;
      console.error(`[forward] failed to start: ${error.message}`);
      resolve();
    });
    child.once('exit', () => { child.ended = true; resolve(); });
  });
  forward = child;
  console.log(`[forward] started pid=${child.pid}`);
}

async function stopForward() {
  if (!forward) return;
  const child = forward;
  forward = undefined;
  if (!child.ended) child.kill('SIGTERM');
  await Promise.race([child.exited, delay(3000)]);
  if (!child.ended) {
    child.kill('SIGKILL');
    await child.exited;
  }
}

async function ready() {
  for (let attempt = 0; attempt < readyAttempts && !stopping; attempt++) {
    if (!forward.ended && await probe()) return true;
    await delay(intervalMs);
  }
  return false;
}

async function restart(reason) {
  if (++restarts > maxRestarts) throw new Error(`port-forward unhealthy (${reason}); exhausted ${maxRestarts} restarts`);
  console.error(`[forward] ${reason}; restarting (${restarts}/${maxRestarts})`);
  await stopForward();
  startForward();
  if (!await ready()) throw new Error(`port-forward did not recover after restart ${restarts}`);
  console.log('[forward] HTTP health recovered');
}

async function monitor() {
  let failures = 0;
  while (!stopping) {
    await delay(intervalMs);
    if (stopping) break;
    if (forward.ended) {
      await restart('process exited');
      failures = 0;
    } else if (await probe()) {
      failures = 0;
    } else if (++failures >= 2) {
      await restart('two consecutive HTTP health failures');
      failures = 0;
    }
  }
}

async function runSmoke() {
  smoke = spawn(smokeCommand[0], smokeCommand.slice(1), {stdio: 'inherit'});
  smoke.exited = new Promise((resolve, reject) => {
    smoke.once('error', reject);
    smoke.once('exit', (code, signal) => resolve({code, signal}));
  });
  return smoke.exited;
}

try {
  startForward();
  if (!await ready()) throw new Error('port-forward did not become HTTP healthy at startup');
  console.log('[forward] HTTP health ready');
  const watched = monitor().then(() => ({type: 'monitor'}), error => ({type: 'failure', error}));
  const completed = runSmoke().then(result => ({type: 'smoke', ...result}), error => ({type: 'failure', error}));
  const result = await Promise.race([watched, completed]);
  if (result.type === 'failure') throw result.error;
  if (result.type !== 'smoke') throw new Error('forward monitor stopped unexpectedly');
  if (result.code !== 0) throw new Error(`smoke exited with ${result.code ?? result.signal}`);
} catch (error) {
  console.error(`[forward] ${error.message}`);
  process.exitCode = 1;
} finally {
  stopping = true;
  if (smoke && smoke.exitCode === null && smoke.signalCode === null) {
    smoke.kill('SIGTERM');
    await Promise.race([smoke.exited.catch(() => {}), delay(3000)]);
    if (smoke.exitCode === null && smoke.signalCode === null) smoke.kill('SIGKILL');
  }
  await stopForward();
  logStream.end();
}
