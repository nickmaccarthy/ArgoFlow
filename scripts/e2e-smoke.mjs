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
 *   CHROME_PATH       Chrome/Chromium executable (default /usr/bin/google-chrome)
 */
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';

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

async function textExists(page, selector, text, timeoutMs) {
  await page.waitForFunction(
    (sel, needle) => [...document.querySelectorAll(sel)].some(node => (node.textContent || '').includes(needle)),
    {timeout: timeoutMs, polling: 500},
    selector,
    text
  );
}

async function clickExtensionTab(page, {text, icon}, timeoutMs = 120000) {
  // App-view extension tabs render as icon-only buttons in the view switcher.
  // Match on text, title/aria-label, or the Font Awesome icon class.
  const matcher = needle => [...document.querySelectorAll('button, a, [role="tab"], .application-details__view-type')].some(node => {
    const visible = (node.textContent || '').trim();
    const named = ((node.getAttribute && node.getAttribute('title')) || (node.getAttribute && node.getAttribute('aria-label')) || '').trim();
    const iconNode = node.querySelector && node.querySelector('i');
    const iconClass = iconNode ? String(iconNode.className) : '';
    return visible === needle.label || named === needle.label || (!!needle.icon && iconClass.includes(needle.icon));
  });
  await page.waitForFunction(matcher, {timeout: timeoutMs, polling: 500}, {label: text, icon});
  await page.evaluate(needle => {
    const target = [...document.querySelectorAll('button, a, [role="tab"], .application-details__view-type')].find(node => {
      const visible = (node.textContent || '').trim();
      const named = ((node.getAttribute && node.getAttribute('title')) || (node.getAttribute && node.getAttribute('aria-label')) || '').trim();
      const iconNode = node.querySelector && node.querySelector('i');
      const iconClass = iconNode ? String(iconNode.className) : '';
      return visible === needle.label || named === needle.label || (!!needle.icon && iconClass.includes(needle.icon));
    });
    if (!target) throw new Error(`No tab matching ${JSON.stringify(needle)}`);
    target.click();
  }, {label: text, icon});
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
      console.log(`[smoke] goto ${url} failed (attempt ${attempt}): ${String(error.message).split('\n')[0]}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  throw lastError;
}

async function shot(page, name) {
  await page.screenshot({path: `artifacts/${name}.png`, fullPage: true});
}

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: true,
  acceptInsecureCerts: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000']
});


try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.setViewport({width: 1600, height: 1000});

  // Surface everything the browser tells us: console lines and page errors.
  const browserConsole = [];
  page.on('console', message => {
    const line = `[browser:${message.type()}] ${message.text()}`;
    browserConsole.push(line);
    console.log(line);
  });
  page.on('pageerror', error => {
    const line = `[browser:pageerror] ${error.message}`;
    browserConsole.push(line);
    console.log(line);
  });

  // Capture the extension's anonymous telemetry stream for contract assertions.
  await page.evaluateOnNewDocument(() => {
    window.__argoflowTelemetry = [];
    window.addEventListener('argocd-workflows-extension:telemetry', event => {
      window.__argoflowTelemetry.push(event.detail);
    });
  });

  log(`opening ${BASE_URL}`);
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
  await gotoWithRetry(page, `${BASE_URL}/applications/${APP_NAME}`);
  await textExists(page, 'body', APP_NAME, 60000);
  log('application page loaded');

  // Why aren't the extension tabs there? Dump what the host actually loaded.
  const diagnostics = await page.evaluate(() => ({
    href: location.href,
    extensionScripts: [...document.querySelectorAll('script')].map(script => script.getAttribute('src')).filter(src => src && src.includes('extension')),
    extensionsApiType: typeof window.extensionsAPI,
    tabLikeTexts: [...document.querySelectorAll('[class*="tab" i], [role="tab"]')].map(node => (node.textContent || '').trim()).filter(Boolean).slice(0, 80),
    switcherButtons: [...document.querySelectorAll('button')].map(button => ({
      text: (button.textContent || '').trim().slice(0, 24),
      title: button.getAttribute('title'),
      ariaLabel: button.getAttribute('aria-label'),
      icon: button.querySelector('i') ? String(button.querySelector('i').className).slice(0, 80) : ''
    })).filter(info => info.title || info.ariaLabel || info.icon).slice(0, 40),
    telemetryCount: (window.__argoflowTelemetry || []).length,
    iconProbe: ['fa-bolt', 'fa-project-diagram'].map(cls => ({
      cls,
      matches: [...document.querySelectorAll(`.${cls}`)].map(element => ({
        tag: element.tagName,
        cls: String(element.className).slice(0, 80),
        parentTag: element.parentElement ? element.parentElement.tagName : '',
        parentCls: String((element.parentElement && element.parentElement.className) || '').slice(0, 100),
        text: element.parentElement ? (element.parentElement.textContent || '').trim().slice(0, 40) : ''
      })).slice(0, 10)
    })),
  }));
  console.log(`[smoke] diagnostics ${JSON.stringify(diagnostics, null, 2)}`);
  await shot(page, '00-application-page');

  // The Workflows app-view extension must render its bounded runs table.
  await clickExtensionTab(page, {text: 'Workflows', icon: 'fa-project-diagram'});
  await page.waitForSelector('#workflow-extension[aria-label="Workflow runs"]');
  await textExists(page, '#workflow-extension', 'Filters apply to this page', 30000);

  // Wait for the synced fixture run to appear; auto-refresh converges without clicks.
  log('waiting for the fixture Workflow row (auto-refresh should converge)');
  await textExists(page, '#workflow-extension', WORKFLOW_NAME, RUN_PAGE_TIMEOUT_MS);
  await shot(page, '01-workflows-view');
  log('workflows view rendered with the fixture run');

  // The Events app-view extension must render EventSource inventory.
  await clickExtensionTab(page, {text: 'Events', icon: 'fa-bolt'});
  await page.waitForSelector('#workflow-extension');
  await textExists(page, '#workflow-extension', 'EventSource', 60000);
  await shot(page, '02-events-view');
  log('events view rendered');

  // Deep link straight into the Workflow resource extension tab and its DAG.
  const resourcePath = encodeURIComponent(`argoproj.io/Workflow/argoflow-e2e/${WORKFLOW_NAME}/0`);
  await gotoWithRetry(page, `${BASE_URL}/applications/${APP_NAME}?view=Tree&resource=&node=${resourcePath}&tab=extension-0`);
  await page.waitForSelector('.wf-dag-shell svg', {timeout: 60000});
  await textExists(page, '.wf-workspace', 'Workflow graph', 30000);
  await shot(page, '03-workflow-dag');

  // Deep-link state: switching views writes namespaced hash keys.
  await clickButtonWithText(page, 'Grid');
  await page.waitForFunction(() => location.hash.includes('argoflow:run.view=grid'), {timeout: 15000, polling: 500});
  await shot(page, '04-workflow-grid-deeplink');
  log('resource tab DAG rendered and hash deep-linking works');

  // Telemetry contract: anonymous events only, with the expected lifecycle events.
  const events = await page.evaluate(() => window.__argoflowTelemetry || []);
  assert(events.some(event => event.event === 'extension.loaded'), 'expected extension.loaded telemetry');
  assert(events.some(event => event.event === 'run-page.loaded'), 'expected run-page.loaded telemetry');
  assert(events.some(event => event.event === 'workflow.ready'), 'expected workflow.ready telemetry');
  assert(!events.some(event => event.event === 'render.failed'), 'render.failed telemetry must stay absent');
  for (const event of events) {
    assert(!/payments|secret|bearer|token|namespace/i.test(JSON.stringify(event)), `telemetry leaked resource data: ${JSON.stringify(event)}`);
  }
  console.log('[smoke] telemetry contract verified:', JSON.stringify(events));

  console.log('[smoke] PASS');
} finally {
  await browser.close();
}
