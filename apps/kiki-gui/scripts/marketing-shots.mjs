/**
 * marketing-shots — promotional screenshot runner for the kiki GUI.
 *
 *   node scripts/marketing-shots.mjs                 # render every shot
 *   node scripts/marketing-shots.mjs --only=h01      # names containing "h01"
 *   node scripts/marketing-shots.mjs --collect       # copy masters to marketing/shots
 *
 * It boots the shared fixture server + a dedicated vite dev server (exactly
 * like scripts/visual-proof.mjs) and drives the real GUI with Playwright. Each
 * shot fixes its own locale, theme, viewport, DPR and layout prefs, waits for
 * the concrete UI state (not networkidle), parks the pointer away from any
 * hover target, and writes a DPR-2 PNG master.
 *
 * This runner never touches the tracked visual-proof goldens; there is no
 * --update-goldens path. The output directory is throwaway by default and is
 * wiped on start, so point KIKI_MARKETING_SHOTS_DIR at a disposable path.
 */

import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(ROOT, '..', '..');
const OUT_DIR = process.env.KIKI_MARKETING_SHOTS_DIR ?? join(REPO_ROOT, '.tmp', 'marketing-shots');
const COLLECT_DIR = join(REPO_ROOT, 'marketing', 'shots');
const DPR = 2;

const onlyArg = process.argv.find((arg) => arg === '--only' || arg.startsWith('--only='));
const only = onlyArg === undefined
  ? null
  : (onlyArg === '--only' ? '' : onlyArg.slice('--only='.length)).split(',').filter((v) => v !== '');
const collect = process.argv.includes('--collect');

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

let FIXTURE_PORTS = Number(process.env.KIKI_PROOF_FIXTURE_PORT ?? 0);
let WEB_PORT = Number(process.env.KIKI_PROOF_WEB_PORT ?? 0);
let FIXTURE_URL = '';
let WEB_URL = '';
let page;

async function control(action) {
  const response = await fetch(`${FIXTURE_URL}/__control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });
  return response.json();
}

function deepLink(path, fixtureUrl = FIXTURE_URL) {
  return `${WEB_URL}${path}?server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`;
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
  const path = join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path });
  const bytes = statSync(path).size;
  console.log(`[shot] ${name}.png (${Math.round(bytes / 1024)} KB)`);
}

/**
 * Boot a fresh page for one shot. Locale, theme, layout and onboarding are
 * seeded before any app code runs; the fixture scenario is switched and the
 * page reloaded so the app pulls the new state from scratch. Readiness is
 * locale-agnostic: the sidebar root + a seeded session row, not a UI string.
 */
async function prepare(page_, shotDef) {
  page = page_;
  await page.goto(deepLink('/new'), { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-session-sidebar]', { timeout: 120_000 });
  await control({ action: 'scenario', name: shotDef.scenario });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-session-sidebar]', { timeout: 60_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-session-list] [data-session-title]').length >= 1,
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(700);
}

// --------------------------- per-shot walkers ------------------------------

const H01_SID = 'sess_sample_prepare_release';

async function shotH01() {
  await page.goto(deepLink(`/s/${H01_SID}`), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const rail = page.locator('[data-session-rail]');
  await rail.waitFor({ timeout: 30_000 });
  // A real, settled transcript turn is the app-ready marker for the session page.
  await page.locator('[role="log"] [data-block-id^="user-"]').first().waitFor({ timeout: 30_000 });
  await page.locator('[role="log"] [data-block-id^="group-"], [role="log"] [data-block-id^="tool-"]').first().waitFor({ timeout: 15_000 });
  // The dispatch tree must carry all three children (ids are locale-independent).
  for (const agentId of ['agent-explorer', 'agent-builder', 'agent-reviewer']) {
    await rail.locator(`[data-agent-id="${agentId}"]`).first().waitFor({ timeout: 15_000 });
  }
  // The rail's background section carries the running build + its Stop control.
  await rail.locator('[data-tasks-scroll]').first().waitFor({ timeout: 15_000 });
  await rail.locator('[data-tasks-scroll] button').first().waitFor({ timeout: 10_000 });
  await page.locator('[data-goal-card]').waitFor({ timeout: 15_000 });
  await page.locator('[data-queue-strip]').waitFor({ timeout: 15_000 });
  await settle();
}

const R02_SID = 'sess_sample_prepare_release';

async function shotR02() {
  await page.goto(deepLink(`/s/${R02_SID}`), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('[data-goal-card]').waitFor({ timeout: 30_000 });
  // Expand the queue strip so both queued rows show.
  const toggle = page.locator('[data-queue-strip] [aria-expanded]').first();
  if (await toggle.count() > 0) {
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  }
  await page.locator('[data-queue-strip] [data-timing-picker]').first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
  // R02's whole point is the per-row timing/edit/send-now controls, which the
  // product reveals on row hover. Hover one queued row and KEEP the pointer
  // there (the shell settle moves it away; this shot must not).
  await page.locator('[data-queue-strip] li').first().hover();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
}

async function shotR01() {
  await page.goto(deepLink('/settings/subagents'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const row = page.locator('#st-card-subagent-profiles [data-agent-profile="reviewer"]');
  await row.waitFor({ timeout: 30_000 });
  // Expand the row's proof-source details so the .md source path is in frame.
  await row.locator('[data-technical-details] summary').click();
  await row.locator('[data-technical-details]').evaluate((node) => { node.open = true; });
  const toggle = row.locator('[data-raw-file-collapse] button').first();
  await toggle.waitFor({ timeout: 15_000 });
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
  await toggle.click();
  // Wait for the fetched source file to land in the editor.
  await page.waitForFunction(
    () => {
      const area = document.querySelector('#st-card-subagent-profiles [data-agent-profile="reviewer"] [data-raw-file-collapse] textarea');
      return area !== null && (area.value ?? '').includes('---');
    },
    undefined,
    { timeout: 20_000 },
  );
  // Center the reviewer row so the page heading, the .md source path, the raw
  // editor and the Save button all stay in one 1200×900 frame.
  await row.evaluate((node) => { node.scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(300);
  await settle();
}

const R04_SID = 'sess_sample_prepare_release';

async function shotR04() {
  await page.goto(deepLink(`/s/${R04_SID}`), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const rail = page.locator('[data-session-rail]');
  await rail.waitFor({ timeout: 30_000 });
  const launcher = page.locator('[data-session-task-board]');
  await launcher.waitFor({ timeout: 15_000 });
  await launcher.click();
  await page.getByRole('dialog').waitFor({ timeout: 15_000 });
  await page.locator('[data-board-column="in_progress"]').waitFor({ timeout: 20_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-board-task-card]').length >= 7,
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(600);
  await settle();
}

// --------------------------- post-run invariants ---------------------------
// Each check asserts the concrete UI evidence is still on screen immediately
// before the capture (guards against a concurrent HMR reload blanking the page).

async function checkH01() {
  const rail = page.locator('[data-session-rail]');
  if (await rail.count() === 0) throw new Error('session rail missing');
  for (const agentId of ['agent-explorer', 'agent-builder', 'agent-reviewer']) {
    if (await rail.locator(`[data-agent-id="${agentId}"]`).count() === 0) throw new Error(`dispatch tree missing ${agentId}`);
  }
  if (await rail.locator('[data-tasks-scroll] button').count() === 0) throw new Error('background task stop missing');
  if (await page.locator('[data-goal-card]').count() === 0) throw new Error('goal card missing');
  if (await page.locator('[data-queue-strip]').count() === 0) throw new Error('queue strip missing');
  if (await page.locator('[role="log"] [data-block-id^="user-"]').count() === 0) throw new Error('transcript turn missing');
}

async function checkR01() {
  const row = page.locator('#st-card-subagent-profiles [data-agent-profile="reviewer"]');
  if (await row.count() === 0) throw new Error('reviewer profile row missing');
  const details = await row.locator('[data-technical-details]').innerText();
  if (!details.includes('reviewer.md')) throw new Error('source file path not visible');
  const value = await row.locator('[data-raw-file-collapse] textarea').inputValue();
  if (!value.includes('---')) throw new Error('raw file editor not populated');
}

async function checkR02() {
  if (await page.locator('[data-goal-card]').count() === 0) throw new Error('goal card missing');
  if (await page.locator('[data-queue-strip]').count() === 0) throw new Error('queue strip missing');
  if (await page.locator('[data-queue-strip] [data-timing-picker]').count() === 0) throw new Error('queue timing control missing');
}

async function checkR04() {
  if (await page.locator('[data-board-column="in_progress"]').count() === 0) throw new Error('board column missing');
  const cards = await page.locator('[data-board-task-card]').count();
  if (cards < 7) throw new Error(`expected 7 board cards, saw ${cards}`);
}

// ------------------------------- shot table --------------------------------

/**
 * Delivered compositions (all bilingual). R03 (approval card close-up) is
 * cancelled by the current brief. `railWidth` is part of the composition so
 * the docked goal/queue card keeps its objective readable at 1200px wide.
 */
const SHOTS = [
  { name: 'h01-fleet-workbench.en.light', scenario: 'marketing-h01-en', locale: 'en', theme: 'light', viewport: { width: 1440, height: 900 }, run: shotH01, check: checkH01 },
  { name: 'h01-fleet-workbench.zh.light', scenario: 'marketing-h01-zh', locale: 'zh', theme: 'light', viewport: { width: 1440, height: 900 }, run: shotH01, check: checkH01 },
  { name: 'h01-fleet-workbench.en.dark', scenario: 'marketing-h01-en', locale: 'en', theme: 'dark', viewport: { width: 1440, height: 900 }, run: shotH01, check: checkH01 },
  { name: 'r01-reviewer-profile.en.light', scenario: 'marketing-r01-en', locale: 'en', theme: 'light', viewport: { width: 1200, height: 900 }, run: shotR01, check: checkR01 },
  { name: 'r01-reviewer-profile.zh.light', scenario: 'marketing-r01-zh', locale: 'zh', theme: 'light', viewport: { width: 1200, height: 900 }, run: shotR01, check: checkR01 },
  { name: 'r02-goal-queue.en.light', scenario: 'marketing-r02-en', locale: 'en', theme: 'light', viewport: { width: 1200, height: 750 }, railWidth: 264, run: shotR02, check: checkR02 },
  { name: 'r02-goal-queue.zh.light', scenario: 'marketing-r02-zh', locale: 'zh', theme: 'light', viewport: { width: 1200, height: 750 }, railWidth: 264, run: shotR02, check: checkR02 },
  { name: 'r04-task-board.en.light', scenario: 'marketing-r04-en', locale: 'en', theme: 'light', viewport: { width: 1440, height: 900 }, run: shotR04, check: checkR04 },
  { name: 'r04-task-board.zh.light', scenario: 'marketing-r04-zh', locale: 'zh', theme: 'light', viewport: { width: 1440, height: 900 }, run: shotR04, check: checkR04 },
];

function activeShots() {
  return [...SHOTS];
}

function initScript({ locale, theme, railWidth }) {
  return (payload) => {
    try {
      localStorage.setItem('kiki.locale', payload.locale);
      localStorage.setItem('kiki.settings', JSON.stringify({ theme: payload.theme }));
      localStorage.setItem('kiki.layout', JSON.stringify({ groupBy: 'workspace', sortBy: 'updated-desc', sidebarWidth: 268, railWidth: payload.railWidth }));
      localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
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

  const fixture = await startFixtureServer({ port: FIXTURE_PORTS, scenario: 'marketing-h01-en' });
  const vite = spawn('pnpm --filter @kiki/gui dev', {
    cwd: REPO_ROOT,
    env: { ...process.env, KIKI_GUI_PORT: String(WEB_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  vite.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`));
  vite.stderr.on('data', (d) => process.stdout.write(`[vite:err] ${d}`));
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
      const wanted = activeShots().filter((s) => only === null || only.some((f) => s.name.includes(f)));
      if (wanted.length === 0) throw new Error(`no shots match --only=${only?.join(',')}`);
      for (const def of wanted) {
        console.log(`[shot:start] ${def.name}`);
        let captured = false;
        let lastError;
        // The workspace may be shared with other agents: a source-file edit
        // triggers a vite HMR full reload, which can land between the walker's
        // waits and the screenshot and capture a half-booted page. Re-check the
        // shot's invariant right before the capture and retry once if it broke.
        for (let attempt = 1; attempt <= 2 && !captured; attempt += 1) {
          const context = await browser.newContext({
            viewport: def.viewport,
            deviceScaleFactor: DPR,
            locale: def.locale === 'zh' ? 'zh-CN' : 'en-US',
            colorScheme: def.theme,
            timezoneId: 'Asia/Shanghai',
          });
          await context.addInitScript(initScript(def), { locale: def.locale, theme: def.theme, railWidth: def.railWidth ?? 322 });
          const page_ = await context.newPage();
          page_.on('pageerror', (error) => console.error(`[pageerror] ${def.name}: ${error.message}`));
          page_.on('console', (message) => {
            if (message.type() === 'error') console.error(`[console:error] ${def.name}: ${message.text()}`);
          });
          try {
            await prepare(page_, def);
            await def.run();
            if (def.check !== undefined) await def.check();
            await shot(def.name);
            captured = true;
          } catch (error) {
            lastError = error;
            console.error(`[warn] ${def.name} attempt ${attempt} failed: ${error.message}`);
            if (attempt === 2) {
              await page_.screenshot({ path: join(OUT_DIR, `${def.name}.FAIL.png`) }).catch(() => undefined);
            }
          } finally {
            await context.close();
          }
        }
        if (!captured) {
          failures.push({ name: def.name, message: lastError?.message ?? 'unknown' });
          console.error(`[FAIL] ${def.name}: ${lastError?.message ?? 'unknown'}`);
        }
      }
    } finally {
      await browser.close();
    }

    if (collect && failures.length === 0) {
      mkdirSync(COLLECT_DIR, { recursive: true });
      for (const file of readdirSync(OUT_DIR)) {
        if (!file.endsWith('.png')) continue;
        copyFileSync(join(OUT_DIR, file), join(COLLECT_DIR, file));
      }
      console.log(`[shots] collected ${readdirSync(OUT_DIR).filter((f) => f.endsWith('.png')).length} PNG(s) into ${COLLECT_DIR}`);
    }

    if (failures.length > 0) {
      process.exitCode = 1;
      console.error(`[shots] FAILED: ${failures.map((f) => f.name).join(', ')}`);
    } else {
      console.log('[shots] DONE');
    }
  } finally {
    await cleanup();
  }
}

await main();
