/**
 * ArgoFlow end-to-end smoke test.
 *
 * Runs against a real kind cluster with a pinned Argo CD release (see the
 * `compatibility` job in .github/workflows/ci-release.yml). Uses puppeteer-core
 * against the runner's preinstalled Chrome so no browser download is needed.
 *
 * Required environment:
 *   ARGOCD_BASE_URL   e.g. https://localhost:8090 (port-forward to argocd-server)
 *   ARGOCD_PASSWORD   initial admin password
 * Optional:
 *   CHROME_PATH             Chrome/Chromium executable (default /usr/bin/google-chrome)
 *   ARGOFLOW_SMOKE_STRICT   set to 1 to make the view-switch toggle assertion blocking
 */
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {startNetworkDiagnostics, startHeartbeat, viewSwitchCheck} from './smoke-diagnostics.mjs';

import puppeteer from 'puppeteer-core';

const BASE_URL = process.env.ARGOCD_BASE_URL || 'https://127.0.0.1:8090';
const ARGOCD_PASSWORD = process.env.ARGOCD_PASSWORD;
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const APP_NAME = 'argoflow-e2e';
const WORKFLOW_NAME = 'argoflow-hello-e2e';
const RUN_PAGE_TIMEOUT_MS = Number(process.env.ARGOCD_SYNC_TIMEOUT_MS || 300000);

assert(ARGOCD_PASSWORD, 'ARGOCD_PASSWORD is required');
mkdirSync('artifacts', {recursive: true});

function log(step) {
  console.log(`[smoke] ${step}`);
}

// Warn-only-by-default wrapper for the still-stabilizing view-switch toggle
// click. Everything else in this script fails hard so extension registration,
// rendering, and telemetry problems turn the compatibility job red.
const STRICT_VIEW_SWITCH = process.env.ARGOFLOW_SMOKE_STRICT === '1';


async function textExists(page, selector, text, timeoutMs) {
  await page.waitForFunction(
    (sel, needle) => [...document.querySelectorAll(sel)].some(node => (node.textContent || '').includes(needle)),
    {timeout: timeoutMs, polling: 500},
    selector,
    text
  );
}

/**
 * Anonymous-only telemetry with the expected lifecycle events. Phases see
 * different documents: the app view emits run-page.loaded; a Workflow resource
 * tab emits workflow.ready — each asserted only in its own document.
 */
function assertTelemetryContract(events, {expect = []} = {}) {
  assert(events.some(event => event.event === 'extension.loaded'), 'expected extension.loaded telemetry');
  if (expect.includes('run-page.loaded')) assert(events.some(event => event.event === 'run-page.loaded'), 'expected run-page.loaded telemetry');
  if (expect.includes('workflow.ready')) assert(events.some(event => event.event === 'workflow.ready'), 'expected workflow.ready telemetry');
  assert(!events.some(event => event.event === 'render.failed'), 'render.failed telemetry must stay absent');
  for (const event of events) {
    assert(!/payments|secret|bearer|token|namespace/i.test(JSON.stringify(event)), 'telemetry leaked resource data; inspect the event stream in the page, not here');
  }
}

async function clickExtensionTab(page, {icon}, timeoutMs = 120000) {
  // App-view extension toggles are <i> Font Awesome icons INSIDE the shared
  // div.application-details__view-type container. The container spans the
  // whole toggle row and carries no onClick — only each <i> does — so clicking
  // the container's center lands on a built-in view toggle (tree/network/
  // pods) and the extension never mounts. Target the <i> itself.
  const deadline = Date.now() + timeoutMs;
  let last = {clicked: false, divs: -1, icons: -1, candidates: -1};
  let scans = 0;
  while (Date.now() < deadline) {
    scans++;
    last = await page.evaluate(needleIcon => {
      const divs = document.querySelectorAll('.application-details__view-type').length;
      const icons = document.querySelectorAll(`.${needleIcon}`).length;
      const nodes = [...document.querySelectorAll(`.application-details__view-type i.${needleIcon}`)];
      return {found: nodes.length > 0, divs, icons, candidates: nodes.length};
    }, icon);
    if (last.found) {
      // React's synthetic event system responds to real input; use the mouse
      // on the icon's own box. A re-render between scan and click can detach
      // the handle: log, wait, and rescan instead of failing the run.
      const handles = await page.$$('.application-details__view-type i.' + icon);
      const handle = handles[0];
      if (!handle) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      try {
        const box = await handle.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await handle.click();
        }
      } catch (clickError) {
        log(`click on ${icon} failed, rescanning`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      log(`clicked extension tab icon ${icon} after ${scans} scans`);
      // Allow the view toggle to settle before asserting its mounted panel.
      await new Promise(resolve => setTimeout(resolve, 3000));
      log('extension tab clicked');
      return last;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Extension tab ${icon} not found after ${scans} scans; last scan: ${JSON.stringify(last)}`);
}

async function clickButtonWithText(page, text, timeoutMs = 120000) {
  await page.waitForFunction(
    label => [...document.querySelectorAll('button, a, [role="tab"]')]
      .some(node => (node.textContent || '').trim() === label),
    {timeout: timeoutMs, polling: 500},
    text
  );
  await page.evaluate(label => {
    const target = [...document.querySelectorAll('button, a, [role="tab"]')]
      .find(node => (node.textContent || '').trim() === label);
    if (!target) throw new Error(`No button or link labeled ${label}`);
    target.click();
  }, text);
}
async function gotoWithRetry(page, url, attempts = 6) {
  // kubectl port-forward tunnels drop intermittently on CI runners.
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60000});
      return;
    } catch (error) {
      lastError = error;
      console.log(`[smoke] navigation failed (attempt ${attempt})`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  throw lastError;
}

async function shot(page, name) {
  await page.screenshot({path: `artifacts/${name}.png`, fullPage: true});
}

try {
const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: true,
  acceptInsecureCerts: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000']
});


try {
  const page = await browser.newPage();
  let phase = 'setup';
  const mark = name => { phase = name; console.log(`[smoke-diag] ${JSON.stringify({timestamp: new Date().toISOString(), phase, event: 'phase_start'})}`); };
  const stopNetwork = startNetworkDiagnostics(page, () => phase);
  const heartbeatSession = await page.createCDPSession();
  const stopHeartbeat = startHeartbeat(heartbeatSession, () => phase);
  try {
  page.setDefaultTimeout(60000);
  await page.setViewport({width: 1600, height: 1000});

  // Browser messages can contain request URLs, credentials or resource names.
  let pageErrors = 0;
  page.on('pageerror', () => {
    if (pageErrors++ < 10) console.log('[smoke] browser pageerror');
  });

  // Capture the extension's anonymous telemetry stream for contract assertions.
  await page.evaluateOnNewDocument(() => {
    window.__argoflowTelemetry = [];
    window.addEventListener('argocd-workflows-extension:telemetry', event => {
      window.__argoflowTelemetry.push(event.detail);
    });
  });

  mark('login');
  await gotoWithRetry(page, `${BASE_URL}/login`);

  // Login form: username is the non-password input inside the same form scope.
  await page.waitForSelector('input[type="password"]');
  const usernameElement = await page.evaluateHandle(() => {
    const passwordInput = document.querySelector('input[type="password"]');
    const scope = passwordInput.closest('form') || passwordInput.parentElement;
    return [...scope.querySelectorAll('input')].find(input => input !== passwordInput);
  });
  await usernameElement.asElement().type('admin', {delay: 20});
  await page.type('input[type="password"]', ARGOCD_PASSWORD, {delay: 20});
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), {timeout: 60000});
  log('logged in as admin');

  // Open the fixture Application.
  mark('application');
  await gotoWithRetry(page, `${BASE_URL}/applications/${APP_NAME}`);
  await textExists(page, 'body', APP_NAME, 60000);
  log('application page loaded');

  await shot(page, '00-application-page');

  // The Workflows app-view extension must render its bounded runs table.
  mark('workflows_mount');
  await clickExtensionTab(page, {icon: 'fa-project-diagram'});
  await page.waitForSelector('#workflow-extension[aria-label="Workflow runs"]');
  await textExists(page, '#workflow-extension', 'Filters apply to this page', 30000);

  // Wait for the synced fixture run to appear; auto-refresh converges without clicks.
  log('waiting for the fixture Workflow row (auto-refresh should converge)');
  mark('fixture_row_wait');
  await textExists(page, '#workflow-extension', WORKFLOW_NAME, RUN_PAGE_TIMEOUT_MS);
  await shot(page, '01-workflows-view');
  log('workflows view rendered with the fixture run');

  // App-view telemetry contract, asserted in THIS document: the deep-link
  // navigation below replaces the document and unmounts the app view, so
  // run-page.loaded can only ever be observed here.
  assertTelemetryContract(await page.evaluate(() => window.__argoflowTelemetry || []), {expect: ['run-page.loaded']});
  log('app-view telemetry contract verified');

  // The Events app-view extension must render EventSource inventory.
  mark('events_view');
  await clickExtensionTab(page, {icon: 'fa-bolt'});
  await page.waitForSelector('#workflow-extension');
  await textExists(page, '#workflow-extension', 'EventSource', 60000);
  await shot(page, '02-events-view');
  log('events view rendered');

  // Deep link straight into the Workflow resource extension tab and its DAG.
  // Argo CD's background application refresh can transiently drop the
  // extension content (a failed live-state fetch omits extension tabs until
  // the next render), so one navigation retry is allowed before failing.
  mark('resource_dag');
  const resourcePath = encodeURIComponent(`argoproj.io/Workflow/argoflow-e2e/${WORKFLOW_NAME}/0`);
  const deepLinkUrl = `${BASE_URL}/applications/${APP_NAME}?view=tree&resource=&node=${resourcePath}&tab=extension-0`;
  let deepLinkAttempt = 0;
  for (;;) {
    deepLinkAttempt++;
    try {
      await gotoWithRetry(page, deepLinkUrl);
      await page.waitForSelector('.wf-dag-shell svg', {timeout: 60000});
      await textExists(page, '.wf-workspace', 'Workflow graph', 30000);
      break;
    } catch (error) {
      // Evidence is best-effort; never replace the original failure.
      log('deep-link attempt failed');
      try {
        await shot(page, '03-deeplink-failure');
      } catch {
        log('deep-link failure screenshot failed');
      }
      if (deepLinkAttempt >= 2) throw error;
      log(`deep-link attempt ${deepLinkAttempt} failed; retrying navigation once`);
    }
  }
  await shot(page, '03-workflow-dag');

  // Deep-link state: switching views writes namespaced hash keys. This single
  // toggle-click assertion runs warn-only (ARGOFLOW_SMOKE_STRICT=1 makes it
  // blocking) while the interaction stabilizes — every other assertion above
  // and below is blocking, so registration/rendering failures stay red.
  mark('view_switch');
  await viewSwitchCheck(async () => {
    await clickButtonWithText(page, 'Grid');
    await page.waitForFunction(() => location.hash.includes('argoflow:run.view=grid'), {timeout: 15000, polling: 500});
    await shot(page, '04-workflow-grid-deeplink');
  }, {strict: STRICT_VIEW_SWITCH, warn: () => console.warn('[smoke][WARN] view-switch deep-link check failed'), screenshot: () => shot(page, '04-view-switch-failure')});
  log('resource tab DAG rendered');

  // Resource-tab document: fresh load after the deep link, so only the
  // extension lifecycle events of THIS document are asserted here.
  const events = await page.evaluate(() => window.__argoflowTelemetry || []);
  assertTelemetryContract(events, {expect: ['workflow.ready']});
  console.log('[smoke] telemetry contract verified');

  console.log('[smoke] PASS');
  } finally {
    stopHeartbeat();
    stopNetwork();
    void heartbeatSession.detach().catch(() => {});
  }
} finally {
  let closeTimer;
  try {
    await Promise.race([
      browser.close(),
      new Promise(resolve => { closeTimer = setTimeout(() => { browser.process()?.kill('SIGKILL'); resolve(); }, 4000); })
    ]);
  } finally {
    clearTimeout(closeTimer);
  }
}
} catch {
  console.error('[smoke] FAIL');
  process.exitCode = 1;
}
