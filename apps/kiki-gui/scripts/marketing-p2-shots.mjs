/**
 * marketing-p2-shots — the P2 promotional screenshot runner (D01–D08 + the
 * task-board close-up).
 *
 *   node scripts/marketing-p2-shots.mjs                 # render every shot
 *   node scripts/marketing-p2-shots.mjs --only=d01,d05   # names containing a filter
 *   node scripts/marketing-p2-shots.mjs --collect        # copy masters to marketing/shots
 *
 * Every shot renders twice — en-light and zh-light — from a per-locale fixture
 * scenario (`marketing-d0X-en` / `marketing-d0X-zh`, built by
 * fixtures/marketing-p2-builders.mjs), so the zh image is the same screen with
 * translated body copy rather than English content under translated chrome.
 *
 * It boots the shared fixture server + a dedicated vite dev server (the same
 * mechanism scripts/marketing-shots.mjs and scripts/visual-proof.mjs use) and
 * drives the real GUI with Playwright. Each shot fixes the locale, theme,
 * viewport, DPR and layout prefs, waits for the concrete UI state (never
 * networkidle alone), parks the pointer away from hover targets, and writes a
 * DPR-2 PNG master as `<name>.<locale>.light.png`.
 *
 * The output directory is disposable and is wiped recursively on start — point
 * KIKI_PROOF_OUTPUT_DIR at a throwaway path, never at marketing/shots. There is
 * no --update-goldens path here; the tracked visual-proof goldens are never
 * touched.
 */

import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(ROOT, '..', '..');
const DPR = 2;
const COLLECT_DIR = join(REPO_ROOT, 'marketing', 'shots');
const OUT_DIR = process.env.KIKI_PROOF_OUTPUT_DIR ?? join(REPO_ROOT, '.tmp', 'marketing-p2-shots');
const LOCALES = ['en', 'zh'];

const argv = process.argv.slice(2);
const onlyArg = argv.find((arg) => arg === '--only' || arg.startsWith('--only='));
const only = onlyArg === undefined
  ? null
  : (onlyArg === '--only' ? '' : onlyArg.slice('--only='.length)).split(',').filter((value) => value !== '');
const collect = argv.includes('--collect');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => { probe.close(() => resolve()); });
  return port;
}

async function waitForServer(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`server never came up: ${url}`);
    await sleep(300);
  }
}

async function waitForPortFree(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const taken = await new Promise((resolve) => {
      const probe = net.createConnection({ port, host: '127.0.0.1' });
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (!taken) return;
    if (Date.now() > deadline) throw new Error(`port ${port} is still held — free it and rerun`);
    await sleep(300);
  }
}

function portHolderPids(port) {
  if (process.platform !== 'win32') return new Set();
  let out;
  try {
    out = execSync('netstat -ano -p tcp', { stdio: ['ignore', 'pipe', 'ignore'], shell: 'cmd.exe' }).toString();
  } catch {
    return new Set();
  }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue;
    const parts = line.trim().split(/\s+/);
    const local = parts[1];
    const pid = parts[parts.length - 1];
    if (local !== `127.0.0.1:${port}` && local !== `[::1]:${port}` && local !== `0.0.0.0:${port}`) continue;
    if (pid !== undefined && /^\d+$/.test(pid) && pid !== '0') pids.add(Number(pid));
  }
  return pids;
}

function isDescendantOf(pid, rootPid) {
  if (pid === rootPid) return true;
  const parentByPid = new Map();
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"',
      { stdio: ['ignore', 'pipe', 'ignore'], shell: 'cmd.exe' },
    ).toString();
    const rows = JSON.parse(out);
    for (const row of Array.isArray(rows) ? rows : [rows]) parentByPid.set(Number(row.ProcessId), Number(row.ParentProcessId));
  } catch {
    return false;
  }
  let current = pid;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = parentByPid.get(current);
    if (parent === undefined || parent === 0 || parent === current) return false;
    if (parent === rootPid) return true;
    current = parent;
  }
  return false;
}

function killOwnPortHolder(port, rootPid) {
  if (process.platform !== 'win32' || rootPid === undefined) return;
  for (const pid of portHolderPids(port)) {
    if (!isDescendantOf(pid, rootPid)) {
      console.warn(`[shots] port ${port} held by foreign pid ${pid} — NOT killing it`);
      continue;
    }
    try {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
}

// ---------------------------------------------------------------------------

const { chromium } = await import('playwright');
const { FIXTURE_TOKEN, startFixtureServer } = await import('./fixture-server.mjs');

let FIXTURE_PORTS = Number(process.env.KIKI_PROOF_FIXTURE_PORT ?? 0);
let WEB_PORT = Number(process.env.KIKI_PROOF_WEB_PORT ?? 0);
let FIXTURE_URL = '';
let WEB_URL = '';
let page;
let locale = 'en';

async function control(action) {
  const response = await fetch(`${FIXTURE_URL}/__control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });
  return response.json();
}

function deepLink(path, fixtureUrl = FIXTURE_URL) {
  const separator = path.includes('?') ? '&' : '?';
  return `${WEB_URL}${path}${separator}server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`;
}

/** Park the pointer away from every hover target and settle paint. */
async function settle() {
  await page.mouse.move(4, 4);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(250);
}

async function shot(name) {
  const path = join(OUT_DIR, `${name}.${locale}.light.png`);
  await page.screenshot({ path });
  const bytes = statSync(path).size;
  console.log(`[shot] ${name}.${locale}.light.png (${Math.round(bytes / 1024)} KB)`);
}

const SESSION_ID = 'sess_sample_prepare_release';

/** Close the shared right rail when the shot is about the transcript itself. */
async function closeRail() {
  const rail = page.locator('[data-session-rail]');
  // The rail opens by default at ≥1024px; wait for it to mount instead of
  // racing the session view's first paint.
  await rail.waitFor({ timeout: 20_000 });
  const toggle = page.locator('[data-rail-toggle]').first();
  await toggle.waitFor({ timeout: 15_000 });
  await toggle.click();
  await rail.waitFor({ state: 'detached', timeout: 15_000 });
  await page.waitForTimeout(300);
}

/**
 * Boot a fresh page for one shot. Locale, theme, layout and onboarding are
 * seeded before any app code runs; the fixture scenario is switched and the
 * page reloaded so the app pulls the new state from scratch.
 */
async function prepare(page_, shotDef) {
  page = page_;
  // The shell root is locale-independent — waiting on it keeps a bad copy of
  // the localized heading from failing an otherwise healthy boot.
  const shell = '.conversation-shell';
  await page.goto(deepLink('/new'), { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector(shell, { timeout: 120_000 });
  const scenario = typeof shotDef.scenario === 'string' ? shotDef.scenario : shotDef.scenario[locale];
  await control({ action: 'scenario', name: scenario });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(shell, { timeout: 60_000 });
  // Booted against the scenario the shot needs, not the previous one.
  await page.waitForFunction(
    (expected) => document.body.textContent !== '',
    scenario,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(700);
}

// --------------------------- per-shot walkers ------------------------------

/** D01 — the completed Explorer opened as a panel tab next to the session. */
async function shotD01() {
  await page.goto(deepLink(`/s/${SESSION_ID}`), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const rail = page.locator('[data-session-rail]');
  await rail.waitFor({ timeout: 30_000 });
  await page.locator('[data-goal-card]').waitFor({ timeout: 20_000 });
  // The dispatch tree's node buttons carry `data-agent-id`; the transcript's
  // cards use `data-subagent-id`.
  const node = rail.locator('[data-agent-id="agent-explorer"]').first();
  await node.waitFor({ timeout: 20_000 });
  await node.click();
  const panel = page.locator('[data-preview-tabpanel="panel:agent-explorer"]');
  await panel.waitFor({ timeout: 20_000 });
  // Panel tab proving it is the real agent workspace: the effort chip in its
  // header and the subagent composer, both rendered by AgentWorkspace.
  await panel.locator('[data-agent-effort]').first().waitFor({ timeout: 20_000 });
  await panel.locator('[data-composer-variant="subagent"]').waitFor({ timeout: 20_000 });
  // Its own transcript: the explorer's four tool steps folded into one group…
  await panel.getByText(/Steps · 4|步骤 · 4/).first().waitFor({ timeout: 20_000 });
  // …and the result summary it returned, which is the point of the shot.
  const summary = locale === 'zh' ? '未发现版本漂移' : 'no version drift found';
  await panel.getByText(summary, { exact: false }).first().waitFor({ timeout: 20_000 });
  // The main timeline folds completed runs; expand it so the Explorer's own
  // card and summary sit next to the panel rather than behind one line.
  const run = page.locator('[role="log"] [data-history-run]').first();
  if (await run.count() > 0) {
    const toggle = run.locator('button[aria-expanded]').first();
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await page.waitForTimeout(400);
  }
  await closeRail();
  await settle();
}

/** D02 — the expanded prompt-fields card with its variable preview. */
async function shotD02() {
  await page.goto(deepLink('/settings/agents'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const card = page.locator('#st-card-prompt-config');
  await card.waitFor({ timeout: 30_000 });
  await card.locator('details[data-prompt-config] > summary').first().click();
  await card.locator('details[data-prompt-preview] > summary').first().click();
  // Substitution proof: the preview carries the variable's value and none of
  // the raw token.
  await page.waitForFunction(
    () => {
      const node = document.querySelector('#st-card-prompt-config [data-prompt-preview]');
      if (node === null) return false;
      const text = node.textContent ?? '';
      return text.includes('stable') && !text.includes('${release_channel}');
    },
    undefined,
    { timeout: 20_000 },
  );
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const scroller = document.querySelector('[data-settings-scroll]');
    const target = document.querySelector('#st-card-prompt-config');
    if (scroller !== null && target !== null) {
      scroller.scrollTop = target.offsetTop - scroller.offsetTop - 12;
    }
  });
  await page.waitForTimeout(400);
  await settle();
}

/** D03 — the tasks page with the running Bash task expanded. */
async function shotD03() {
  await page.goto(deepLink(`/s/${SESSION_ID}/tasks`), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('[data-tasks-page]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-task-row]').length === 3,
    undefined,
    { timeout: 20_000 },
  );
  const running = page.locator('[data-task-row]', { hasText: '--watch' }).first();
  await running.locator('button[aria-expanded]').first().click();
  await running.locator('[data-task-output]').waitFor({ timeout: 20_000 });
  const output = await running.locator('[data-task-output]').innerText();
  if (!output.includes('Watching for file changes')) {
    throw new Error(`running task output preview missing, saw "${output.slice(0, 80)}"`);
  }
  await settle();
}

/** D04 — folded tool steps plus one expanded completion notification. */
async function shotD04() {
  await page.goto(deepLink(`/s/${SESSION_ID}`), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await closeRail();
  const log = page.locator('[role="log"]');
  await log.waitFor({ timeout: 30_000 });
  // Three consecutive tool calls fold into one Steps row.
  await log.getByText(/Steps · 3|步骤 · 3/).first().waitFor({ timeout: 20_000 });
  const notification = log.locator('[data-system="task"]').first();
  await notification.waitFor({ timeout: 20_000 });
  await notification.locator('button[aria-expanded]').first().click();
  await page.waitForFunction(
    () => (document.querySelector('[role="log"]')?.textContent ?? '').includes('42 passed'),
    undefined,
    { timeout: 20_000 },
  );
  await settle();
}

/** D05 — the scheduled-task panel opened from the rail. */
async function shotD05() {
  await page.goto(deepLink(`/s/${SESSION_ID}`), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const rail = page.locator('[data-session-rail]');
  await rail.waitFor({ timeout: 30_000 });
  const launcher = page.locator('[data-session-cron-panel]');
  await launcher.waitFor({ timeout: 20_000 });
  await launcher.click();
  await page.locator('[data-cron-list]').waitFor({ timeout: 20_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-cron-task]').length === 3,
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(400);
  await settle();
}

/** D06 — the search-lanes tab. */
async function shotD06() {
  await page.goto(deepLink('/settings/search?tab=search'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const card = page.locator('#st-card-search-defaults');
  await card.waitFor({ timeout: 30_000 });
  for (const lane of ['github.repositories', 'exa.search', 'duckduckgo.search', 'tavily.search']) {
    await card.getByText(lane, { exact: true }).first().waitFor({ timeout: 20_000 });
  }
  // The unconfigured lane must carry its reason, not only a badge.
  const cardText = await card.innerText();
  if (!cardText.includes('CREDENTIAL_NOT_CONFIGURED')) {
    throw new Error('unconfigured lane reason missing from the lanes card');
  }
  await page.evaluate(() => { document.querySelector('[data-settings-scroll]')?.scrollTo({ top: 0 }); });
  await page.waitForTimeout(300);
  await settle();
}

/** D07 — the three-step fetch chain. */
async function shotD07() {
  await page.goto(deepLink('/settings/search?tab=fetch'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const card = page.locator('#st-card-search-fetch');
  await card.waitFor({ timeout: 30_000 });
  // A saved chain renders as editable selects, one per step: their values are
  // the pipeline ids, so the order is read from the product's own control.
  await card.locator('select').first().waitFor({ timeout: 20_000 });
  const pipelines = await card.locator('select').evaluateAll((nodes) => nodes.map((node) => node.value));
  const expected = ['tavily.extract', 'jina.reader', 'direct.fetch'];
  if (pipelines.join(' → ') !== expected.join(' → ')) {
    throw new Error(`fetch chain order wrong: ${pipelines.join(' → ')}`);
  }
  const cardText = await card.innerText();
  // Two fallback arrows between the three steps — one localized hint per gap.
  const fallbackHint = locale === 'zh' ? '失败时回退到下一条' : 'falls back to the next pipeline';
  const arrowCount = cardText.split(fallbackHint).length - 1;
  if (arrowCount !== 2) {
    throw new Error(`expected 2 fallback arrows between the chain steps, saw ${arrowCount}`);
  }
  // Per-step status, in chain order: the first pipeline is the unconfigured
  // one, the two fallbacks are ready. A saved override renders the availability
  // badge per step (it does not inline the issue list the way the inherited
  // list does), so the badge is the status evidence here.
  const unavailable = locale === 'zh' ? '不可用' : 'UNAVAILABLE';
  const ready = locale === 'zh' ? '就绪' : 'READY';
  const pattern = new RegExp([
    expected[0], unavailable, expected[1], ready, expected[2], ready,
  ].join('[\\s\\S]*?'));
  if (!pattern.test(cardText)) {
    throw new Error('per-step readiness badges missing from the fetch chain');
  }
  await page.evaluate(() => { document.querySelector('[data-settings-scroll]')?.scrollTo({ top: 0 }); });
  await page.waitForTimeout(300);
  await settle();
}

/** D08 — the attached sample recording, paused on a content frame. */
async function shotD08() {
  await page.goto(deepLink(`/s/${SESSION_ID}`), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await closeRail();
  const video = page.locator('[role="log"] video').first();
  await video.waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const node = document.querySelector('[role="log"] video');
      return node !== null && node.readyState >= 2 && node.videoWidth > 0;
    },
    undefined,
    { timeout: 60_000 },
  );
  // Park the player on a populated frame — the same seek a viewer performs.
  await video.evaluate(async (node) => {
    await new Promise((resolve) => {
      const done = () => { node.removeEventListener('seeked', done); resolve(); };
      node.addEventListener('seeked', done);
      node.currentTime = 6;
      setTimeout(done, 4000);
    });
    node.pause();
  });
  await page.waitForTimeout(600);
  const state = await video.evaluate((node) => ({ time: node.currentTime, paused: node.paused, width: node.videoWidth }));
  if (state.width === 0) throw new Error('video element has no decoded frame');
  if (!(state.time > 5 && state.time < 7)) throw new Error(`video did not seek to the content frame (t=${state.time})`);
  await settle();
}

/** Task-board close-up — one in_progress card opened in TaskDetailModal. */
async function shotBoardDetail() {
  await page.goto(deepLink(`/s/${SESSION_ID}`), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const rail = page.locator('[data-session-rail]');
  await rail.waitFor({ timeout: 30_000 });
  const launcher = page.locator('[data-session-task-board]');
  await launcher.waitFor({ timeout: 20_000 });
  await launcher.click();
  await page.locator('[data-board-column="in_progress"]').waitFor({ timeout: 20_000 });
  const title = locale === 'zh' ? '起草 0.4 更新日志' : 'Draft the 0.4 changelog';
  const card = page.locator('[data-board-task-card]', { hasText: title }).first();
  await card.waitFor({ timeout: 20_000 });
  await card.click();
  const detail = page.locator('[data-task-detail-modal]');
  await detail.waitFor({ timeout: 20_000 });
  // The body is fetched per card; wait for it instead of the loading skeleton.
  await page.waitForFunction(
    (expected) => {
      const modal = document.querySelector('[data-task-detail-modal]');
      if (modal === null) return false;
      const text = modal.textContent ?? '';
      return text.includes(expected) && text.includes('0.3');
    },
    title,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(500);
  await settle();
}

// ------------------------------- shot table --------------------------------

const SHOTS = [
  { name: 'd01-agent-preview', scenario: { en: 'marketing-d01-en', zh: 'marketing-d01-zh' }, viewport: { width: 1600, height: 1000 }, run: shotD01 },
  { name: 'd02-prompt-fields', scenario: { en: 'marketing-d02-en', zh: 'marketing-d02-zh' }, viewport: { width: 1200, height: 900 }, run: shotD02 },
  { name: 'd03-tasks-page', scenario: { en: 'marketing-d03-en', zh: 'marketing-d03-zh' }, viewport: { width: 1440, height: 900 }, run: shotD03 },
  { name: 'd04-tool-steps-notification', scenario: { en: 'marketing-d04-en', zh: 'marketing-d04-zh' }, viewport: { width: 1200, height: 900 }, run: shotD04 },
  { name: 'd05-cron-panel', scenario: { en: 'marketing-d05-en', zh: 'marketing-d05-zh' }, viewport: { width: 1200, height: 900 }, run: shotD05 },
  { name: 'd06-search-lanes', scenario: { en: 'marketing-d06-en', zh: 'marketing-d06-zh' }, viewport: { width: 1200, height: 900 }, run: shotD06 },
  { name: 'd07-fetch-chain', scenario: { en: 'marketing-d07-en', zh: 'marketing-d07-zh' }, viewport: { width: 1200, height: 900 }, run: shotD07 },
  { name: 'd08-video-attachment', scenario: { en: 'marketing-d08-en', zh: 'marketing-d08-zh' }, viewport: { width: 1440, height: 900 }, run: shotD08 },
  {
    name: 'board-task-detail',
    // The close-up reuses the P1 board scenarios: same cards, same columns and
    // the same linked sessions the task-board page shows.
    scenario: { en: 'marketing-r04-en', zh: 'marketing-r04-zh' },
    viewport: { width: 1200, height: 900 },
    run: shotBoardDetail,
  },
];

function initScript() {
  return (payload) => {
    try {
      localStorage.setItem('kiki.locale', payload.locale);
      localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'light' }));
      localStorage.setItem(
        'kiki.layout',
        JSON.stringify({ groupBy: 'workspace', sortBy: 'updated-desc', sidebarWidth: 268, railWidth: 322 }),
      );
      localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
      // D01 needs both workspaces side by side: the widest panel the splitter
      // allows, which a user can also reach by dragging the handle.
      localStorage.setItem('kiki.previewPanelWidth', '720');
    } catch {
      // storage unavailable — nothing to seed
    }
  };
}

async function main() {
  const fixturePinned = FIXTURE_PORTS !== 0;
  if (!fixturePinned) FIXTURE_PORTS = await freePort();
  if (WEB_PORT === 0) WEB_PORT = await freePort();
  FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORTS}`;
  WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
  await waitForPortFree(FIXTURE_PORTS);
  await waitForPortFree(WEB_PORT);

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[shots] output: ${OUT_DIR}`);

  const fixture = await startFixtureServer({ port: FIXTURE_PORTS, scenario: 'marketing-d01-en' });
  const vite = spawn('pnpm --filter @kiki/gui dev', {
    cwd: REPO_ROOT,
    env: { ...process.env, KIKI_GUI_PORT: String(WEB_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  vite.stdout.on('data', (data) => process.stdout.write(`[vite] ${data}`));
  vite.stderr.on('data', (data) => process.stdout.write(`[vite:err] ${data}`));
  let viteExited = null;
  vite.on('exit', (code) => { viteExited = code; });

  const cleanup = async () => {
    if (process.platform === 'win32' && vite.pid !== undefined) {
      try { execSync(`taskkill /PID ${vite.pid} /F /T`, { stdio: 'ignore' }); } catch { /* gone */ }
    }
    vite.kill();
    killOwnPortHolder(WEB_PORT, vite.pid);
    await fixture.stop();
  };
  process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));

  try {
    await waitForServer(WEB_URL, 120_000);
    if (viteExited !== null) throw new Error(`vite exited early (code ${viteExited})`);
    console.log(`[shots] web up at ${WEB_URL}`);

    const browser = await chromium.launch({ args: ['--no-proxy-server'] });
    const failures = [];
    try {
      const wanted = SHOTS.filter((entry) => only === null || only.some((filter) => entry.name.includes(filter)));
      if (wanted.length === 0) throw new Error(`no shots match --only=${only?.join(',')}`);
      for (const def of wanted) {
        for (const pass of LOCALES) {
          locale = pass;
          console.log(`[shot:start] ${def.name} (${locale})`);
          const context = await browser.newContext({
            viewport: def.viewport,
            deviceScaleFactor: DPR,
            locale: locale === 'zh' ? 'zh-CN' : 'en-US',
            colorScheme: 'light',
            timezoneId: 'Asia/Shanghai',
          });
          await context.addInitScript(initScript(), { locale, theme: 'light' });
          const page_ = await context.newPage();
          page_.on('pageerror', (error) => console.error(`[pageerror] ${def.name}.${locale}: ${error.message}`));
          page_.on('console', (message) => {
            if (message.type() === 'error') console.error(`[console:error] ${def.name}.${locale}: ${message.text()}`);
          });
          try {
            await prepare(page_, def);
            await def.run();
            await shot(def.name);
          } catch (error) {
            failures.push({ name: `${def.name}.${locale}`, message: error.message });
            console.error(`[FAIL] ${def.name}.${locale}: ${error.message}`);
            await page_.screenshot({ path: join(OUT_DIR, `${def.name}.${locale}.light.FAIL.png`) }).catch(() => undefined);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
    }

    if (collect && failures.length === 0) {
      mkdirSync(COLLECT_DIR, { recursive: true });
      let copied = 0;
      for (const file of readdirSync(OUT_DIR)) {
        if (!file.endsWith('.png')) continue;
        copyFileSync(join(OUT_DIR, file), join(COLLECT_DIR, file));
        copied += 1;
      }
      console.log(`[shots] collected ${copied} PNG(s) into ${COLLECT_DIR}`);
    }

    if (failures.length > 0) {
      process.exitCode = 1;
      console.error(`[shots] FAILED: ${failures.map((failure) => failure.name).join(', ')}`);
    } else {
      console.log('[shots] DONE');
    }
  } finally {
    await cleanup();
  }
}

await main();
