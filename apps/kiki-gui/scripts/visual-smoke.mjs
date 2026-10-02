/**
 * kiki-gui visual smoke (prototype) — a handful of key screens against a
 * static production build, one locale / theme / width, in parallel browser
 * contexts. Every context gets its own fixture server, so scenarios never
 * share server state. No vite dev server, so no HMR reload when other owners
 * edit sources mid-run.
 *
 *   node scripts/visual-smoke.mjs                  # build + all smoke scenarios
 *   node scripts/visual-smoke.mjs --no-build       # reuse the last smoke build
 *   node scripts/visual-smoke.mjs --only=hero-shell,settings
 *
 * Env: KIKI_SMOKE_OUTPUT_DIR (default .tmp/visual-smoke/<run-id>),
 *      KIKI_SMOKE_DIST (default .tmp/visual-smoke/dist),
 *      KIKI_SMOKE_WORKERS (default 4).
 * Selectors are data-* / ids only; text waits target fixture content, which
 * does not localize.
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(process.env.KIKI_SMOKE_OUTPUT_DIR ?? join(ROOT, '.tmp', 'visual-smoke', RUN_ID));
const DIST = resolve(process.env.KIKI_SMOKE_DIST ?? join(ROOT, '.tmp', 'visual-smoke', 'dist'));
const WORKERS = Math.max(1, Number(process.env.KIKI_SMOKE_WORKERS ?? 4));
const SCENARIO_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 5 * 60_000;
const VIEWPORT = { width: 1440, height: 900 };

/** Settle finite animations, then capture. Mirrors visual-proof's `shot`. */
async function shot(page, name) {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) =>
      animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  }).catch(() => undefined);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  return `${name}.png`;
}

async function openSession(page, link, sessionId) {
  await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
  const row = page.locator(`[data-session-row="${sessionId}"]`).first();
  await row.waitFor({ timeout: 20_000 });
  await row.click();
  await page.waitForSelector('textarea:not([disabled])', { timeout: 15_000 });
}

async function threadDisplayWalk(page, link, control, locale = 'en') {
  const parentId = 'session_fixture_parent';
  const childId = 'session_fixture_child';
  const recentId = 'session_fixture_recent';
  const prefix = `thread-order-${locale}`;
  const nested = page.locator(`[data-session-threads="${parentId}"] [data-session-row="${childId}"]`);
  const topLevel = () => page.locator('[data-session-row]').evaluateAll((rows) => rows
    .filter((row) => row.closest('[data-session-threads]') === null)
    .map((row) => row.dataset.sessionRow));
  await openSession(page, link, childId);
  if (await nested.count() !== 1 || JSON.stringify(await topLevel()) !== JSON.stringify([recentId, parentId])) {
    throw new Error('initial parent order or nesting is wrong');
  }
  const before = (await control({ action: 'session', session_id: parentId })).data.record.updated_at;
  const shots = [await shot(page, `${prefix}-before-activity`)];
  await page.fill('textarea', 'Run the child review.');
  await page.press('textarea', 'Control+Enter');
  await page.waitForSelector('text=Child activity completed.', { timeout: 15_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await nested.waitFor({ timeout: 20_000 });
  const after = (await control({ action: 'session', session_id: parentId })).data.record.updated_at;
  const child = (await control({ action: 'session', session_id: childId })).data.record;
  if (before !== after || child.updated_at <= before || JSON.stringify(await topLevel()) !== JSON.stringify([recentId, parentId])) {
    throw new Error('child activity moved the parent or did not advance its own time');
  }
  shots.push(await shot(page, `${prefix}-after-activity`));
  await nested.click({ button: 'right' });
  const toggle = page.locator('[data-menu-item="thread-display"]');
  if (await toggle.textContent() !== (locale === 'zh' ? '恢复顶层显示' : 'Show at top level')) throw new Error('missing promotion label');
  shots.push(await shot(page, `${prefix}-menu`));
  await toggle.click();
  await nested.waitFor({ state: 'detached' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const childRow = page.locator(`[data-session-row="${childId}"]`);
  await childRow.waitFor({ timeout: 20_000 });
  if (await nested.count() !== 0 || (await topLevel())[0] !== childId) throw new Error('promotion did not persist or sort independently');
  if ((await control({ action: 'session', session_id: childId })).data.record.metadata.created_by_session_id !== parentId) {
    throw new Error('promotion changed the creator relationship');
  }
  shots.push(await shot(page, `${prefix}-top-level`));
  if (locale === 'zh') {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-sidebar-menu]').click();
  }
  await childRow.click({ button: 'right' });
  if (await toggle.textContent() !== (locale === 'zh' ? '恢复嵌套显示' : 'Show nested')) throw new Error('missing nesting label');
  const menuBox = await page.locator('[data-session-menu]').boundingBox();
  const viewport = page.viewportSize();
  if (menuBox === null || menuBox.x < 0 || menuBox.y < 0 || menuBox.x + menuBox.width > viewport.width || menuBox.y + menuBox.height > viewport.height) {
    throw new Error('thread menu overflows the viewport');
  }
  shots.push(await shot(page, `${prefix}-${locale === 'zh' ? 'narrow-menu' : 'return-menu'}`));
  await toggle.click();
  await nested.waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (locale === 'zh') await page.locator('[data-sidebar-menu]').click();
  await nested.waitFor({ timeout: 20_000 });
  shots.push(await shot(page, `${prefix}-nested-again`));
  return shots;
}

/**
 * Smoke registry: name = fixture scenario, tags for later `--tag` selection.
 * Each walk asserts the one thing that makes the screen meaningful.
 */
const SCENARIOS = [
  {
    name: 'thread-order',
    tags: ['smoke', 'sidebar', 'threads'],
    run: threadDisplayWalk,
  },
  {
    name: 'thread-order-zh',
    fixture: 'thread-order',
    locale: 'zh',
    tags: ['smoke', 'sidebar', 'threads', 'i18n', 'narrow'],
    run: (page, link, control) => threadDisplayWalk(page, link, control, 'zh'),
  },
  {
    name: 'hero-shell',
    tags: ['smoke', 'shell'],
    async run(page, link) {
      await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-phase="hero"]', { timeout: 20_000 });
      await page.waitForSelector('textarea:not([disabled])', { timeout: 15_000 });
      return [await shot(page, 'hero-desktop')];
    },
  },
  {
    name: 'basic-stream',
    tags: ['smoke', 'transcript', 'approvals'],
    async run(page, link) {
      await openSession(page, link, 'session_fixture_basic');
      await page.fill('textarea', 'Run the fixture flow.');
      await page.press('textarea', 'Control+Enter');
      await page.waitForSelector('text=Here is the fixture answer', { timeout: 20_000 });
      await page.waitForSelector('[data-approval-id]', { timeout: 20_000 });
      const shots = [await shot(page, 'basic-stream-approval')];
      await page.mouse.click(720, 120);
      await page.keyboard.press('y');
      await page.waitForSelector('[data-approval-id]', { state: 'detached', timeout: 15_000 });
      await page.waitForSelector('text=printed as expected', { timeout: 20_000 });
      shots.push(await shot(page, 'basic-stream-done'));
      return shots;
    },
  },
  {
    name: 'long-transcript',
    tags: ['smoke', 'transcript'],
    async run(page, link) {
      await openSession(page, link, 'session_fixture_long');
      await page.waitForSelector('[data-block-id]', { timeout: 20_000 });
      return [await shot(page, 'long-transcript')];
    },
  },
  {
    name: 'session-pages',
    tags: ['smoke', 'sidebar'],
    async run(page, link) {
      await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-session-row]', { timeout: 20_000 });
      return [await shot(page, 'sidebar-sessions')];
    },
  },
  {
    name: 'search-s4',
    fixture: 'search',
    tags: ['smoke', 'sidebar', 'search'],
    async run(page, link) {
      await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
      await page.locator('[data-search-toggle]').click();
      await page.locator('[data-search-box]').fill('persimmon');
      const hit = page.locator('[data-search-messages] button').first();
      await hit.waitFor({ timeout: 20_000 });
      if (!(await hit.textContent())?.includes('persimmon')) throw new Error('content hit not rendered');
      const shots = [await shot(page, 'search-hit')];
      await hit.click();
      await page.waitForURL(/\/s\/session_fixture_search_a\?turn=1/, { timeout: 20_000 });
      await page.waitForSelector('[data-block-id]', { timeout: 20_000 });
      shots.push(await shot(page, 'search-located-turn'));
      await page.goto(link('/settings/search?tab=advanced'), { waitUntil: 'domcontentloaded' });
      const desktopSearch = page.locator('[data-experimental-row="desktop_search"]');
      await desktopSearch.waitFor({ timeout: 20_000 });
      await desktopSearch.scrollIntoViewIfNeeded();
      shots.push(await shot(page, 'search-desktop-setting'));
      return shots;
    },
  },
  {
    name: 'settings',
    tags: ['smoke', 'settings'],
    async run(page, link) {
      await page.goto(link('/settings/general'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-settings-page-title]', { timeout: 20_000 });
      const shots = [await shot(page, 'settings-general')];
      await page.goto(link('/settings/ai'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-model-row]', { timeout: 20_000 });
      shots.push(await shot(page, 'settings-models'));
      await page.locator('[data-ai-tab="providers"]').click();
      await page.waitForSelector('[data-connection-list] [data-connection-row]', { timeout: 15_000 });
      shots.push(await shot(page, 'settings-providers'));
      return shots;
    },
  },
  {
    name: 'settings-appearance',
    tags: ['smoke', 'settings', 'appearance'],
    async run(page, link) {
      await page.goto(link('/settings/appearance'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-appearance-preview]', { timeout: 20_000 });
      return [await shot(page, 'settings-appearance')];
    },
  },
  {
    name: 'subagents',
    tags: ['smoke', 'agents'],
    async run(page, link) {
      await openSession(page, link, 'session_fixture_subagents');
      await page.fill('textarea', 'Delegate the fixture work.');
      await page.press('textarea', 'Control+Enter');
      await page.locator('[data-subagent-id="agent-research"]').first().waitFor({ timeout: 20_000 });
      await page.locator('[data-subagent-id="agent-review"]').first().waitFor({ timeout: 20_000 });
      return [await shot(page, 'subagents')];
    },
  },
  {
    name: 'question-card',
    tags: ['smoke', 'interactions'],
    async run(page, link) {
      await openSession(page, link, 'session_fixture_question');
      await page.fill('textarea', 'Ask me the fixture questions.');
      await page.press('textarea', 'Control+Enter');
      const card = page.locator('[data-question-card]');
      await card.waitFor({ timeout: 20_000 });
      return [await shot(page, 'question-card')];
    },
  },
  {
    name: 'reconnect',
    tags: ['smoke', 'connection'],
    async run(page, link, control) {
      await openSession(page, link, 'session_fixture_reconnect');
      await page.fill('textarea', 'Start the two-segment stream.');
      await page.press('textarea', 'Control+Enter');
      await page.waitForSelector('text=Segment A', { timeout: 20_000 });
      await control({ action: 'drop_ws' });
      await page.locator('[data-app-banner]').waitFor({ timeout: 10_000 });
      return [await shot(page, 'reconnect-banner')];
    },
  },
  {
    name: 'usage-governance',
    fixture: 'usage-dashboard',
    tags: ['smoke', 'usage'],
    async run(page, link) {
      await page.goto(link('/usage?panel=realtime'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-governance-active]', { timeout: 20_000 });
      const shots = [await shot(page, 'usage-realtime')];
      await page.locator('[data-usage-panel="limits"]').click();
      await page.waitForSelector('[data-governance-rule="kimi-cap"]', { timeout: 20_000 });
      shots.push(await shot(page, 'usage-limits'));
      await page.locator('[data-governance-rule="kimi-cap"] button').first().click();
      await page.waitForSelector('[data-governance-editor]', { timeout: 10_000 });
      shots.push(await shot(page, 'usage-limits-editor'));
      await page.locator('[data-governance-editor] button[type="button"]', { hasText: 'Cancel' }).click();
      // Delete both rules through their editors: the list empties into the
      // guided empty state, whose action opens a fresh rule form.
      for (const id of ['kimi-cap', 'session-focus']) {
        await page.locator(`[data-governance-rule="${id}"] button`).first().click();
        await page.locator('[data-governance-editor-delete]').click();
        await page.locator('[data-confirm-action="confirm"]').click();
        await page.waitForSelector(`[data-governance-rule="${id}"]`, { state: 'detached', timeout: 10_000 });
      }
      await page.waitForSelector('[data-governance-empty]', { timeout: 10_000 });
      shots.push(await shot(page, 'usage-limits-empty'));
      await page.locator('[data-governance-add]').click();
      await page.waitForSelector('[data-governance-editor]', { timeout: 10_000 });
      shots.push(await shot(page, 'usage-limits-new'));
      return shots;
    },
  },
  {
    name: 'first-run',
    tags: ['smoke', 'onboarding'],
    onboarding: false,
    async run(page, link) {
      await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
      await page.locator('[role="dialog"]').waitFor({ timeout: 20_000 });
      return [await shot(page, 'first-run-onboarding')];
    },
  },
  {
    name: 'hero-shell-zh',
    fixture: 'hero-shell',
    locale: 'zh',
    tags: ['smoke', 'shell', 'i18n'],
    async run(page, link) {
      await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-phase="hero"]', { timeout: 20_000 });
      await page.waitForSelector('textarea:not([disabled])', { timeout: 15_000 });
      return [await shot(page, 'hero-zh')];
    },
  },
  {
    name: 'capabilities-empty-zh',
    fixture: 'hero-shell',
    locale: 'zh',
    tags: ['smoke', 'capabilities', 'i18n'],
    async run(page, link) {
      await page.route('**/api/workspaces', (route) => route.fulfill({
        json: { code: 0, msg: 'ok', data: { items: [] }, request_id: 'fixture-cap-empty' },
      }));
      await page.goto(link('/capabilities?tab=skills'), { waitUntil: 'domcontentloaded' });
      const empty = page.locator('[data-capability-empty]');
      await empty.waitFor({ timeout: 20_000 });
      if (!(await empty.textContent())?.includes('还没有可查看技能的工作区')) throw new Error('missing workspace empty state');
      const action = empty.locator('a[href="/new"]');
      await action.waitFor();
      const shots = [await shot(page, 'capabilities-empty-zh')];
      await action.click();
      await page.waitForURL(/\/new$/, { timeout: 20_000 });
      return shots;
    },
  },
  {
    name: 'capabilities-workspaces-zh',
    fixture: 'hero-shell',
    locale: 'zh',
    tags: ['smoke', 'capabilities', 'i18n'],
    async run(page, link) {
      const items = ['Alpha', 'Beta'].map((name) => ({
        id: `ws_${name.toLowerCase()}`, name, root: `C:/projects/${name}`,
        created_at: '2026-01-01T00:00:00Z', last_opened_at: '2026-01-01T00:00:00Z', session_count: 1, pinned: false, isGit: false,
      }));
      await page.route('**/api/workspaces', (route) => route.fulfill({
        json: { code: 0, msg: 'ok', data: { items }, request_id: 'fixture-cap-workspaces' },
      }));
      await page.route('**/api/workspaces/*/skills', (route) => {
        const id = new URL(route.request().url()).pathname.split('/').at(-2);
        return route.fulfill({ json: { code: 0, msg: 'ok', data: { skills: [{
          name: `${id}-review`, description: 'Review project changes', source: 'project',
          path: `C:/projects/${id}/.agents/skills/review/SKILL.md`,
        }] }, request_id: 'fixture-cap-skills' } });
      });
      await page.goto(link('/capabilities?tab=skills&workspace=ws_beta'), { waitUntil: 'domcontentloaded' });
      await page.locator('[data-skill-row="ws_beta-review"]').waitFor({ timeout: 20_000 });
      await page.locator('#capabilities-workspace').click();
      await page.getByRole('option').filter({ hasText: 'Alpha' }).click();
      await page.waitForURL(/workspace=ws_alpha/, { timeout: 20_000 });
      await page.locator('[data-skill-row="ws_alpha-review"]').waitFor({ timeout: 20_000 });
      await page.locator('#capabilities-workspace').click();
      const shots = [await shot(page, 'capabilities-workspaces-zh')];
      await page.keyboard.press('Escape');
      await page.goBack();
      await page.waitForURL(/workspace=ws_beta/, { timeout: 20_000 });
      await page.locator('[data-skill-row="ws_beta-review"]').waitFor({ timeout: 20_000 });
      return shots;
    },
  },
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

/** Static SPA server over the build; `/__kiki/local-server` reports no local server. */
function startStatic(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__kiki/local-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(dir, 'index.html');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(server)));
}

function build() {
  const started = Date.now();
  const result = spawnSync(process.execPath, [
    join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'warn',
  ], { cwd: ROOT, stdio: 'inherit', timeout: 180_000 });
  if (result.status !== 0) throw new Error(`vite build failed (status ${result.status})`);
  return Date.now() - started;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function runScenario(browser, webUrl, scenario) {
  const started = Date.now();
  const fixture = await startFixtureServer({ port: 0, scenario: scenario.fixture ?? scenario.name });
  const fixtureUrl = `http://127.0.0.1:${fixture.http.address().port}`;
  const link = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`;
  const control = async (body) => {
    const response = await fetch(`${fixtureUrl}/__control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`fixture control failed with HTTP ${response.status}`);
    return response.json();
  };
  const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'reduce' });
  const errors = [];
  try {
    await context.addInitScript(({ locale, onboardingCompleted }) => {
      try {
        localStorage.setItem('kiki.locale', locale);
        if (onboardingCompleted) {
          if (localStorage.getItem('kiki.onboarding') === null) {
            localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
          }
        } else {
          localStorage.removeItem('kiki.onboarding');
          localStorage.removeItem('kiki.newSessionDraft');
        }
      } catch { /* storage unavailable */ }
    }, {
      locale: scenario.locale ?? 'en',
      onboardingCompleted: scenario.onboarding !== false,
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    const shots = await withTimeout(scenario.run(page, link, control), SCENARIO_TIMEOUT_MS, `scenario ${scenario.name}`);
    if (errors.length > 0) throw new Error(`pageerror: ${errors.join(' | ')}`);
    return { name: scenario.name, ok: true, ms: Date.now() - started, shots };
  } catch (error) {
    const page = context.pages()[0];
    if (page !== undefined) await page.screenshot({ path: join(OUT, `${scenario.name}-FAIL.png`) }).catch(() => undefined);
    return { name: scenario.name, ok: false, ms: Date.now() - started, error: error.message };
  } finally {
    await context.close().catch(() => undefined);
    await fixture.stop().catch(() => undefined);
  }
}

async function main() {
  const onlyArg = argv.find((arg) => arg.startsWith('--only='));
  const only = onlyArg === undefined ? null : onlyArg.slice('--only='.length).split(',');
  const unknown = only?.filter((name) => !SCENARIOS.some((s) => s.name === name)) ?? [];
  if (unknown.length > 0) throw new Error(`unknown smoke scenario(s): ${unknown.join(', ')}`);
  const selected = SCENARIOS.filter((s) => only === null || only.includes(s.name));

  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const buildMs = argv.includes('--no-build') && existsSync(join(DIST, 'index.html')) ? 0 : build();
  const web = await startStatic(DIST);
  const webUrl = `http://127.0.0.1:${web.address().port}`;
  const t1 = Date.now();
  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const launchMs = Date.now() - t1;
  const results = [];
  try {
    const queue = [...selected];
    const worker = async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const result = await runScenario(browser, webUrl, next);
        console.log(`[smoke] ${result.ok ? 'ok  ' : 'FAIL'} ${result.name} ${result.ms}ms${result.ok ? '' : ` — ${result.error}`}`);
        results.push(result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, selected.length) }, worker));
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise((done) => web.close(done));
  }
  const failed = results.filter((r) => !r.ok);
  const shots = results.reduce((n, r) => n + (r.shots?.length ?? 0), 0);
  console.log(`[smoke] build ${buildMs}ms, chromium ${launchMs}ms, scenarios ${results.length}, shots ${shots}, total ${Date.now() - t0}ms`);
  console.log(`[smoke] output: ${OUT}`);
  console.log(failed.length > 0 ? 'SMOKE FAILED' : 'SMOKE DONE');
  process.exitCode = failed.length > 0 ? 1 : 0;
}

export { SCENARIOS };

// Importing this module (the registry test) must not build or launch Chromium.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Hard watchdog: never outlive the budget (unref'd so a clean run exits).
  setTimeout(() => {
    console.error(`[smoke] run exceeded ${RUN_TIMEOUT_MS}ms — exiting`);
    process.exit(2);
  }, RUN_TIMEOUT_MS).unref();

  await main();
}
