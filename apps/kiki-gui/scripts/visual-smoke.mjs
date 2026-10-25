/**
 * kiki-gui visual smoke (prototype) — a handful of key screens against a
 * static production build, one locale / theme / width, in parallel browser
 * contexts. Every context gets its own fixture server, so scenarios never
 * share server state. By default no vite dev server runs, so other owners'
 * source edits cannot trigger HMR. --web-url uses an existing preview instead;
 * keep its sources stable during capture and stop that preview separately.
 *
 *   node scripts/visual-smoke.mjs                  # build + all smoke scenarios
 *   node scripts/visual-smoke.mjs --no-build       # reuse the last smoke build
 *   node scripts/visual-smoke.mjs --only=hero-shell,settings
 *   node scripts/visual-smoke.mjs --only=archive-nested --web-url=http://127.0.0.1:5197
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
    name: 'nb-search-routing',
    fixture: 'settings',
    tags: ['smoke', 'settings', 'nb-search'],
    async run(page, link) {
      await page.goto(link('/settings/search'), { waitUntil: 'domcontentloaded' });
      await page.locator('[data-nb-search-tab="fetch"]').click();
      const routing = page.locator('[data-nb-search-routing-builtin]');
      await routing.waitFor({ timeout: 20_000 });
      // The maintained package and its rules must be readable without expanding
      // anything: a hidden rule list is how "which sites are covered" gets lost.
      if (await page.locator('[data-nb-search-routing-builtin-rule]').count() !== 4) {
        throw new Error('the built-in rule list is not shown on the fetch tab');
      }
      const shots = [await shot(page, 'nb-search-routing')];
      await routing.scrollIntoViewIfNeeded();
      await page.locator('[data-nb-search-routing-mode-choice="custom"]').click();
      await page.locator('[data-nb-search-routing-rule="docs-reference"]').waitFor({ timeout: 10_000 });
      if (await page.locator('[data-nb-search-routing-rule-id]').count() !== 3) {
        throw new Error('the saved user rules did not load into the editor');
      }
      shots.push(await shot(page, 'nb-search-routing-rules'));
      // The offline preview must predict the built-in package for a covered URL.
      await page.locator('[data-nb-search-routing-preview-input]').fill('https://raw.githubusercontent.com/o/r/main/README.md');
      const predicted = page.locator('[data-nb-search-routing-preview-result]');
      await predicted.waitFor({ timeout: 10_000 });
      if (await predicted.getAttribute('data-nb-search-routing-preview-result') !== 'builtin') {
        throw new Error('the route preview did not report the built-in match');
      }
      await predicted.scrollIntoViewIfNeeded();
      shots.push(await shot(page, 'nb-search-routing-preview'));
      await page.setViewportSize({ width: 390, height: 900 });
      await page.locator('[data-nb-search-routing-rule="docs-reference"]').scrollIntoViewIfNeeded();
      shots.push(await shot(page, 'nb-search-routing-narrow'));
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
    name: 'model-switch',
    fixture: 'model-switch',
    tags: ['smoke', 'transcript', 'queue', 'model-switch'],
    async run(page, link) {
      await openSession(page, link, 'session_fixture_model_switch');
      const notices = page.locator('[data-model-switch-notice]');
      await notices.first().waitFor({ timeout: 20_000 });
      if (await notices.count() !== 3) throw new Error(`expected three model-switch notices, got ${await notices.count()}`);
      for (const state of ['pending', 'completed', 'failed']) {
        if (await page.locator(`[data-model-switch-notice="${state}"]`).count() !== 1) {
          throw new Error(`missing ${state} model-switch notice`);
        }
      }
      const shots = [await shot(page, 'model-switch-timeline')];

      // Scroll to the newest turn first: that click lands outside the composer
      // header, which closes the queue detail again.
      const jumpToLatest = page.locator('[data-jump-to-latest]');
      if (await jumpToLatest.count() > 0) await jumpToLatest.click();
      await page.locator('[data-header-toggle="queue"]').click();
      const controlRow = page.locator('li[data-queue-model-switch="switch-fixture-pending"]');
      await controlRow.waitFor({ timeout: 15_000 });
      if (await page.locator('li[data-queue-item="prompt-fixture-model-switch"]').count() !== 1) {
        throw new Error('missing queued prompt row beside the model-switch control row');
      }
      if (await page.locator('[data-model-switch-pending="fresh"]').count() !== 1) {
        throw new Error('missing pending model-switch composer chip');
      }
      shots.push(await shot(page, 'model-switch-queue'));

      await page.locator('#composer-model-select').click();
      await page.locator('[role="option"][data-option-value="fixture/kiki-lite"]').click();
      const dialog = page.locator('[data-model-switch-mode="direct"]');
      await dialog.waitFor({ timeout: 15_000 });
      shots.push(await shot(page, 'model-switch-dialog-direct'));
      await page.locator('[data-model-switch-mode="fresh"]').click();
      await page.locator('[data-model-switch-fresh-extra]').waitFor({ timeout: 5_000 });
      shots.push(await shot(page, 'model-switch-dialog-fresh'));

      await page.setViewportSize({ width: 390, height: 900 });
      await page.locator('[data-model-switch-mode="fresh"]').waitFor();
      shots.push(await shot(page, 'model-switch-dialog-fresh-narrow'));

      // A phone-width composer says the queued switch in words above the input
      // instead of clipping the toolbar chip.
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-model-switch-pending-line="fresh"]', { timeout: 10_000 });
      if (await page.locator('[data-model-switch-pending]').isVisible()) {
        throw new Error('the narrow composer still shows the clipped switch chip');
      }
      shots.push(await shot(page, 'model-switch-narrow-composer'));

      // The proof lane uses this existing persisted setting; no new theme
      // switch is introduced for smoke. Reopen the same dialog in dark mode.
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => {
        const raw = localStorage.getItem('kiki.settings');
        const settings = raw === null ? {} : JSON.parse(raw);
        localStorage.setItem('kiki.settings', JSON.stringify({ ...settings, theme: 'dark' }));
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('[data-model-switch-notice]').first().waitFor({ timeout: 20_000 });
      await page.locator('#composer-model-select').click();
      await page.locator('[role="option"][data-option-value="fixture/kiki-lite"]').click();
      await page.locator('[data-model-switch-mode="direct"]').waitFor({ timeout: 15_000 });
      shots.push(await shot(page, 'model-switch-dialog-dark'));
      return shots;
    },
  },
  {
    name: 'model-switch-settings',
    fixture: 'model-switch',
    tags: ['smoke', 'settings', 'model-switch'],
    async run(page, link) {
      await page.goto(link('/settings/ai?tab=defaults'), { waitUntil: 'domcontentloaded' });
      await page.locator('#st-card-model-switch').waitFor({ timeout: 20_000 });
      const shots = [await shot(page, 'model-switch-settings')];
      await page.locator('[data-model-switch-rule-add]').click();
      const editor = page.locator('[data-model-switch-rule-editor]');
      await editor.waitFor({ timeout: 10_000 });
      const inputs = editor.locator('input[type="text"]');
      if (await inputs.count() !== 2) throw new Error(`expected two model-switch rule text inputs, got ${await inputs.count()}`);
      await inputs.nth(0).fill('fixture/old-*');
      await inputs.nth(1).fill('fixture/new');
      await editor.locator('[data-model-switch-rule-preview]').waitFor();
      shots.push(await shot(page, 'model-switch-settings-editor'));
      await page.setViewportSize({ width: 390, height: 900 });
      shots.push(await shot(page, 'model-switch-settings-narrow'));
      return shots;
    },
  },
  {
    name: 'model-switch-child',
    fixture: 'model-switch-child',
    tags: ['smoke', 'agents', 'model-switch'],
    async run(page, link) {
      // The child workspace reaches its own switch entries: the header menu and
      // the same three-mode panel, on a session whose conversation can be
      // renewed without a switch having to fail first.
      await page.goto(link('/s/session_fixture_switch_child/agent/agent-research'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('textarea:not([disabled])', { timeout: 25_000 });
      const shots = [await shot(page, 'model-switch-child-workspace')];

      const menu = page.locator('[data-agent-actions]');
      await menu.waitFor({ timeout: 15_000 });
      await menu.locator('button').first().click();
      const item = page.locator('[data-agent-fresh-context]');
      await item.waitFor({ timeout: 10_000 });
      shots.push(await shot(page, 'model-switch-child-menu'));

      await item.click();
      await page.locator('[data-model-switch-mode="fresh"]').waitFor({ timeout: 10_000 });
      if (await page.locator('[data-model-switch-mode="direct"]').count() !== 0) {
        throw new Error('a same-model child switch still offers the direct row');
      }
      shots.push(await shot(page, 'model-switch-child-dialog'));

      await page.setViewportSize({ width: 390, height: 900 });
      await page.locator('[data-model-switch-mode="fresh"]').waitFor();
      shots.push(await shot(page, 'model-switch-child-dialog-narrow'));
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-model-switch-pending-line="fresh"]', { timeout: 10_000 });
      shots.push(await shot(page, 'model-switch-child-narrow-composer'));
      return shots;
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
      await page.waitForSelector('[data-governance-dimensions]', { timeout: 20_000 });
      const shots = [await shot(page, 'usage-realtime')];
      const detailsToggle = page.locator('[data-governance-details-toggle]');
      await detailsToggle.click();
      await page.waitForSelector('[data-governance-dimensions]', { state: 'hidden', timeout: 20_000 });
      shots.push(await shot(page, 'usage-live-folded'));
      await detailsToggle.click();
      await page.waitForSelector('[data-governance-dimensions]', { timeout: 20_000 });
      shots.push(await shot(page, 'usage-live-details'));
      await page.goto(link('/usage?panel=limits'), { waitUntil: 'domcontentloaded' });
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
    name: 'usage-sources',
    fixture: 'usage-dashboard',
    tags: ['smoke', 'usage'],
    async run(page, link) {
      const shots = [];
      // Desktop: the whole range, one axis, no session trace on screen.
      await page.goto(link('/usage?range=last_7_days&granularity=day'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-usage-trend] [data-bucket]', { timeout: 20_000 });
      await page.waitForSelector('[data-usage-sources="model"]', { timeout: 20_000 });
      shots.push(await shot(page, 'usage-sources-range'));
      // Selecting a bar scopes the table below it and leaves the headline alone.
      await page.locator('[data-usage-trend] [data-bucket]').nth(2).click();
      await page.waitForSelector('[data-usage-clear-bucket]', { timeout: 10_000 });
      shots.push(await shot(page, 'usage-sources-bucket'));
      // One axis at a time; the provider rows replace the model rows.
      await page.locator('[data-usage-grouping="provider"]').click();
      await page.waitForSelector('[data-usage-sources="provider"]', { timeout: 10_000 });
      shots.push(await shot(page, 'usage-sources-provider'));
      // The prior period is only read once the reader asks.
      await page.locator('[data-usage-compare]').click();
      await page.waitForSelector('[data-usage-compare="delta"]', { timeout: 10_000 });
      shots.push(await shot(page, 'usage-sources-compare'));
      // The session trace is an explicit step.
      await page.locator('[data-usage-open-sessions]').click();
      await page.waitForSelector('[data-usage-session-panel]', { timeout: 15_000 });
      shots.push(await shot(page, 'usage-session-trace'));
      await page.keyboard.press('Escape');
      // 390: the same reading without horizontal page overflow.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(link('/usage?range=last_7_days&granularity=day'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-usage-sources="model"]', { timeout: 20_000 });
      await page.locator('[data-usage-trend] [data-bucket]').nth(2).click();
      await page.waitForSelector('[data-usage-clear-bucket]', { timeout: 10_000 });
      shots.push(await shot(page, 'usage-sources-mobile'));
      return shots;
    },
  },
  {
    name: 'usage-real',
    fixture: 'usage-real',
    tags: ['smoke', 'usage'],
    async run(page, link) {
      const shots = [];
      const requests = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === '/api/usage') requests.push(Object.fromEntries(url.searchParams));
      });
      // The seven-day read: bars, dates and amount are the captured response.
      await page.goto(link('/usage?range=last_7_days&granularity=day'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-usage-trend] [data-bucket]', { timeout: 20_000 });
      const rangeNote = await page.locator('[data-usage-range-note]').innerText();
      const buckets = await page.locator('[data-usage-trend] [data-bucket]').evaluateAll(
        (nodes) => nodes.map((node) => node.getAttribute('aria-label').split(' · ')[0]),
      );
      const headline = await page.locator('[data-usage-summary-cost]').innerText();
      // Every bar the reader sees falls inside the window the header states.
      const inWindow = buckets.every((label) => {
        const parsed = new Date(label);
        return Number.isFinite(parsed.getTime());
      });
      shots.push(await shot(page, 'usage-real-range'));

      // Select a period: the headline stays whole-range, the table narrows.
      await page.locator('[data-usage-trend] [data-bucket]').nth(3).click();
      await page.waitForSelector('[data-usage-source-subtotal]', { timeout: 10_000 });
      const headlineAfter = await page.locator('[data-usage-summary-cost]').innerText();
      const scope = await page.locator('[data-usage-source-scope]').innerText();
      const periodTotal = await page.locator('[data-usage-source-subtotal]').innerText();
      shots.push(await shot(page, 'usage-real-bucket'));

      // The prior period is read on request, with its own explicit window.
      await page.locator('[data-usage-compare]').click();
      // The prior window is not in the capture, so the comparison must say so
      // rather than read as a measured zero or invent a delta.
      await page.waitForSelector('[data-usage-compare-error]', { timeout: 15_000 });
      const compareCells = ['compare-error'];
      const compareError = await page.locator('[data-usage-compare-error]').innerText();
      const headlineDuringFailure = await page.locator('[data-usage-summary-cost]').innerText();
      shots.push(await shot(page, 'usage-real-compare-unavailable'));

      // The trace carries the captured per-session costs and turn ids.
      await page.locator('[data-usage-open-sessions]').click();
      await page.waitForSelector('[data-usage-session-panel] [data-usage-trace-session]', { timeout: 15_000 });
      await page.locator('[data-usage-trace-locate]').first().click();
      const hasTurns = await page.locator('[data-usage-trace-turns]').count() > 0;
      const traceTotal = await page.locator('[data-usage-trace-total]').innerText();
      const firstSession = await page.locator('[data-usage-trace-session]').first().innerText();
      shots.push(await shot(page, 'usage-real-trace'));
      // Pressing a turn opens the real session at that turn.
      const turnButtons = await page.locator('[data-usage-trace-turn]').count();
      let located = null;
      if (turnButtons > 0) {
        // Click one specific locator and prove that exact turn is the one that
        // ends up readable. Opening any turn and looking at the first row's
        // offset would only show that the page scrolled, not that it landed
        // on the target.
        const button = page.locator('[data-usage-trace-turn]').nth(20);
        const clickedTurnId = await button.getAttribute('data-usage-trace-turn');
        const before = page.url();
        await button.click();
        await page.waitForTimeout(1500);
        const url = new URL(page.url());
        located = await page.evaluate((wanted) => {
          const rows = [...document.querySelectorAll('[data-turn-id]')];
          const match = rows.find((row) => row.getAttribute('data-turn-id') === `t${wanted}`);
          if (match === undefined) return { found: false, rows: rows.length };
          const box = match.getBoundingClientRect();
          const read = (box.top > 0 && box.top < window.innerHeight && box.bottom > 0 && box.bottom < window.innerHeight);
          const text = match.textContent?.trim().slice(0, 80) ?? '';
          return {
            found: true,
            rows: rows.length,
            turnId: match.getAttribute('data-turn-id'),
            box: { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height) },
            readableInViewport: read,
            text,
          };
        }, clickedTurnId);
        located.clickedTurnId = clickedTurnId;
        located.routeBefore = before;
        located.routeAfter = page.url();
        located.routeSession = url.pathname.split('/s/')[1]?.split('?')[0];
        located.routeTurnParam = url.searchParams.get('turn');
        located.routeMatchesButton =
          located.routeSession === located.routeAfter.match(/\/s\/([^?]+)/)?.[1] &&
          located.routeTurnParam === clickedTurnId;
        if (!located.found || !located.readableInViewport) {
          throw new Error(`turn locator did not land on turn ${clickedTurnId}: ${JSON.stringify(located)}`);
        }
        await shot(page, 'usage-real-turn-located');
      }
      console.log('[usage-real]', JSON.stringify({
        rangeNote, buckets, inWindow, headline, headlineAfter, scope, periodTotal,
        compareCells, compareError, headlineDuringFailure, traceTotal, firstSession, hasTurns, turnButtons, located,
        lastRequests: requests.slice(-4),
      }, null, 1));
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
  {
    name: 'row-actions',
    fixture: 'subagents',
    tags: ['smoke', 'transcript', 'agents'],
    async run(page, link, control) {
      return walkRowActions(page, link, control, 'en');
    },
  },
  {
    name: 'row-actions-zh',
    fixture: 'subagents',
    locale: 'zh',
    tags: ['smoke', 'transcript', 'agents', 'i18n'],
    async run(page, link, control) {
      return walkRowActions(page, link, control, 'zh');
    },
  },
  {
    name: 'archive-thread',
    fixture: 'thread-relations',
    tags: ['smoke', 'sidebar', 'i18n'],
    async run(page, link, control) {
      return archiveThreadWalk(page, link, control, 'en');
    },
  },
  {
    name: 'archive-thread-zh',
    fixture: 'thread-relations',
    locale: 'zh',
    tags: ['smoke', 'sidebar', 'i18n'],
    async run(page, link, control) {
      return archiveThreadWalk(page, link, control, 'zh');
    },
  },
  {
    name: 'archive-nested',
    fixture: 'thread-relations',
    tags: ['smoke', 'sidebar'],
    async run(page, link, control) {
      return archiveNestedWalk(page, link, control);
    },
  },
  {
    name: 'archive-worktree-recovery',
    fixture: 'worktrees',
    tags: ['smoke', 'sidebar', 'worktrees'],
    run: archiveWorktreeRecoveryWalk,
  },
];

/**
 * Message-row actions and the ended-subagent row's trailing tiles. The strip
 * stays invisible and reserves no height until its row is hovered, and the
 * reveal must not move the row underneath it; the ended row carries icon
 * tiles whose words live in the tooltip. Runs once per locale.
 */
async function walkRowActions(page, link, control, localeSuffix) {
  await openSession(page, link, 'session_fixture_subagents');
  await page.fill('textarea', 'Delegate the fixture work.');
  await page.press('textarea', 'Control+Enter');
  await page.locator('[data-subagent-id="agent-research"]').first().waitFor({ timeout: 20_000 });
  await page.waitForSelector('[data-header-working]', { state: 'detached', timeout: 20_000 });
  // The fixture flow waits for its agents, so no late receipt ever lands:
  // inject one — a subagent whose completion arrives after its dispatching
  // turn reads as one ended row pointing back at the card on the page.
  const at = new Date().toISOString();
  await control({
    action: 'emit_transcript',
    session_id: 'session_fixture_subagents',
    ops: [
      { op: 'turn.upsert', turn: { kind: 'turn', turnId: 't9', ordinal: 9, state: 'completed', origin: { kind: 'task', taskId: 'task-agent-review' }, startedAt: at, endedAt: at } },
      { op: 'step.upsert', turnId: 't9', step: { kind: 'step', stepId: 't9.1', turnId: 't9', ordinal: 1, state: 'completed', startedAt: at, endedAt: at } },
      {
        op: 'frame.upsert',
        turnId: 't9',
        stepId: 't9.1',
        frame: {
          kind: 'text',
          frameId: 't9-notification',
          role: 'user',
          taskId: 'task-agent-review',
          text: '<notification id="n9" category="task" type="task.completed" source_kind="background_task" source_id="task-agent-review">\nTitle: Background agent completed\nPresentation contract verified with no inline child tool cards.\n</notification>',
        },
      },
      // An assistant reply in the same turn gives the hover pass a prose row
      // with a left-aligned strip.
      {
        op: 'frame.upsert',
        turnId: 't9',
        stepId: 't9.1',
        frame: { kind: 'text', frameId: 't9-answer', role: 'assistant', text: 'Reviewer receipt is in — the presentation contract holds, no inline child tool cards.' },
      },
    ],
  });
  const ended = page.locator('[data-subagent-ended]').first();
  await ended.waitFor({ timeout: 20_000 });
  await page.mouse.move(0, 0);
  const shots = [];
  // 1 · Idle: no strip shows anywhere, and the ended row reads as one quiet
  // line with two glyph tiles.
  await ended.scrollIntoViewIfNeeded();
  shots.push(await shot(page, `row-actions-idle-${localeSuffix}`));
  await ended.screenshot({ path: join(OUT, `row-actions-ended-${localeSuffix}.png`) });
  shots.push(`row-actions-ended-${localeSuffix}.png`);
  for (const [selector, icon] of [['[data-subagent-ended-dispatch]', 'arrowUp'], ['[data-agent-open]', 'external']]) {
    const tile = ended.locator(selector).first();
    if ((await tile.getAttribute('title') ?? '') === '') throw new Error(`${selector} lost its tooltip`);
    if ((await tile.getAttribute('aria-label') ?? '') === '') throw new Error(`${selector} lost its accessible name`);
    if (await tile.locator(`[data-icon="${icon}"]`).count() !== 1) throw new Error(`${selector} is not the ${icon} glyph`);
  }
  // 2 · Idle → hover: the strip fades in as an overlay and the reveal never
  // moves anything — checked on the user bubble (right tiles, rows beneath
  // it) and on the assistant reply (left tiles, the timeline's last row).
  const scroller = page.locator('[data-transcript-scroll]');
  const hoverPass = async (stripSelector, shotSuffix) => {
    const strip = page.locator(stripSelector).first();
    const row = strip.locator('xpath=ancestor::*[@data-block-id][1]');
    await row.scrollIntoViewIfNeeded();
    const idleOpacity = await strip.evaluate((el) => getComputedStyle(el).opacity);
    if (Number(idleOpacity) > 0.05) throw new Error(`strip visible without hover: opacity=${idleOpacity}`);
    const next = row.locator('xpath=following::*[@data-block-id][1]');
    const parkedY = (await next.count()) > 0 ? await next.boundingBox() : null;
    const parkedHeight = await scroller.evaluate((el) => el.scrollHeight);
    await row.hover();
    await page.waitForTimeout(300);
    const hoverOpacity = await strip.evaluate((el) => getComputedStyle(el).opacity);
    if (Number(hoverOpacity) < 0.95) throw new Error(`strip did not reveal on hover: opacity=${hoverOpacity}`);
    const hoveredY = (await next.count()) > 0 ? await next.boundingBox() : null;
    const hoveredHeight = await scroller.evaluate((el) => el.scrollHeight);
    if (parkedY !== null && hoveredY !== null && Math.abs(hoveredY.y - parkedY.y) > 0.5) {
      throw new Error(`row actions reveal shifted the next row: ${parkedY.y} → ${hoveredY.y}`);
    }
    if (hoveredHeight !== parkedHeight) {
      throw new Error(`row actions reveal changed the timeline height: ${parkedHeight} → ${hoveredHeight}`);
    }
    shots.push(await shot(page, `row-actions-hover-${shotSuffix}-${localeSuffix}`));
    const rowBox = await row.boundingBox();
    if (rowBox !== null) {
      await page.screenshot({
        path: join(OUT, `row-actions-hover-closeup-${shotSuffix}-${localeSuffix}.png`),
        clip: { x: rowBox.x, y: rowBox.y, width: rowBox.width, height: Math.min(rowBox.height + 56, 900 - rowBox.y) },
      });
      shots.push(`row-actions-hover-closeup-${shotSuffix}-${localeSuffix}.png`);
    }
    await page.mouse.move(0, 0);
  };
  await hoverPass('[data-row-actions-align="right"]', 'user');
  await hoverPass('[data-row-actions-align="left"]', 'assistant');
  // 3 · 390px: the ended row keeps its tiles and the strip still overlays.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await ended.scrollIntoViewIfNeeded();
  await ended.screenshot({ path: join(OUT, `row-actions-narrow-ended-${localeSuffix}.png`) });
  shots.push(`row-actions-narrow-ended-${localeSuffix}.png`);
  const narrowRow = page.locator('[data-row-actions-align="right"]').first()
    .locator('xpath=ancestor::*[@data-block-id][1]');
  await narrowRow.scrollIntoViewIfNeeded();
  await narrowRow.hover();
  await page.waitForTimeout(300);
  shots.push(await shot(page, `row-actions-narrow-hover-${localeSuffix}`));
  return shots;
}

/**
 * Archiving from the sidebar, walked against the family response. A parent
 * with two attached conversations is archived: the row says it is archiving
 * while the request is open, keeps its title and its place, and refuses a
 * second attempt; other rows stay operable throughout; a released archive
 * takes the parent and its children out of the ordinary list; and a refused
 * archive leaves every row standing with the reason said in place.
 */
async function archiveThreadWalk(page, link, control, locale) {
  const parentId = 'session_fixture_release';
  const childId = 'session_fixture_docs_thread';
  const bystander = 'session_fixture_spike';
  const prefix = `archive-thread-${locale}`;
  const archivingText = locale === 'zh' ? '归档中…' : 'Archiving…';
  const refusedText = 'Archive refused: this conversation has uncommitted drafts';

  await openSession(page, link, childId);
  const parentRow = page.locator(`[data-session-row="${parentId}"]`);
  await parentRow.waitFor({ timeout: 20_000 });

  // The archive is held open on the server, so the pending state is on screen
  // rather than over before the shot can reach it.
  await control({ action: 'archive_stall_next' });
  await parentRow.locator('[data-session-title]').click({ button: 'right' });
  await page.locator('[data-session-menu] [data-menu-item="archive"]').click();
  const pending = parentRow.locator('[data-session-archiving]');
  await pending.waitFor({ timeout: 10_000 });
  if ((await pending.textContent())?.trim() !== archivingText) {
    throw new Error(`the archiving row does not say "${archivingText}"`);
  }
  if (await parentRow.locator('[data-session-title]').textContent() === null) {
    throw new Error('the archiving row lost its title');
  }
  const shots = [await shot(page, `${prefix}-1-archiving-desktop`)];

  // The menu closed with the request, and the same object cannot be asked
  // twice while its own archive is in flight.
  if (await page.locator('[data-session-menu]').count() !== 0) {
    throw new Error('the menu stayed open after archiving started');
  }
  // The same object refuses a second archive while its own is in flight.
  await parentRow.locator('[data-session-title]').click({ button: 'right' });
  await page.locator('[data-session-menu] [data-menu-item="archive"]').waitFor({ timeout: 10_000 });
  if (!(await page.locator('[data-session-menu] [data-menu-item="archive"]').isDisabled())) {
    throw new Error('the archiving row can still be asked to archive again');
  }
  await page.keyboard.press('Escape');

  // A row that is not archiving is untouched: still operable, no state on it.
  const other = page.locator(`[data-session-row="${bystander}"]`);
  if (await other.getAttribute('aria-busy') !== null) {
    throw new Error('an unrelated row claims to be archiving');
  }

  // At phone width the list is a drawer, so the archiving row is opened before
// it can be looked at — the state has to hold there too, not just at desktop.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-sidebar-menu]').click();
  await parentRow.locator('[data-session-archiving]').waitFor({ timeout: 10_000 });
  shots.push(await shot(page, `${prefix}-2-archiving-390`));
  await page.setViewportSize({ width: 1440, height: 900 });

  await control({ action: 'archive_release' });
  await parentRow.waitFor({ state: 'detached', timeout: 20_000 });
  // The attached conversation went with its parent, not just the row clicked.
  await page.locator(`[data-session-row="${childId}"]`).waitFor({ state: 'detached', timeout: 20_000 });
  if (await page.locator(`[data-session-row="${bystander}"]`).count() !== 1) {
    throw new Error('archiving one conversation removed an unrelated one');
  }
  shots.push(await shot(page, `${prefix}-3-after-success`));

  // A refused archive: the row stays, says why, and can be tried again.
  await control({ action: 'archive_fail_next' });
  const spikeRow = page.locator(`[data-session-row="${bystander}"]`);
  await spikeRow.locator('[data-session-title]').click({ button: 'right' });
  await page.locator('[data-session-menu] [data-menu-item="archive"]').click();
  const refusal = spikeRow.locator('[data-session-archive-error]');
  await refusal.waitFor({ timeout: 15_000 });
  // The row says why in words, not only by colour; the server's code suffix is
// appended to its own message, so the reason is matched, not the exact string.
if (!(await refusal.textContent())?.includes(refusedText)) {
    throw new Error(`the refused row does not say why: ${await refusal.textContent()}`);
  }
  if (await spikeRow.count() !== 1) {
    throw new Error('the refused row left the list');
  }
  shots.push(await shot(page, `${prefix}-4-refused-desktop`));

  await page.setViewportSize({ width: 390, height: 844 });
  shots.push(await shot(page, `${prefix}-5-refused-390`));
  return shots;
}

/** Narrow recovery walk against mock HTTP, never injected component state. */
async function archiveNestedWalk(page, link, control) {
  const rootId = 'session_fixture_release';
  const childId = 'session_fixture_docs_thread';
  const failedId = 'session_fixture_changelog_thread';
  const archiveRow = async (id) => {
    await page.locator(`[data-session-row="${id}"] [data-session-title]`).click({ button: 'right' });
    await page.locator('[data-session-menu] [data-menu-item="archive"]').click();
  };
  await openSession(page, link, childId);
  const nested = page.locator(`[data-session-threads="${rootId}"] [data-session-row="${childId}"]`);
  await nested.waitFor({ timeout: 20_000 });
  await control({ action: 'archive_stall_next' });
  const archiveRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === `/api/sessions/${childId}:archive`);
  await archiveRow(childId);
  const request = await archiveRequest;
  if (request.postDataJSON()?.include_attached !== true) {
    throw new Error(`nested archive request mismatch: ${request.postData()}`);
  }
  console.log(`[archive-nested] matched POST ${new URL(request.url()).pathname}, family=true`);
  const status = nested.locator('[data-session-archiving]');
  await status.waitFor({ timeout: 10_000 });
  if (!(await status.textContent())?.includes('Archiving') || !(await nested.locator('[data-session-title]').textContent())?.includes('Docs pass')) {
    throw new Error('nested archive lost its status or title');
  }
  const shots = [await shot(page, 'archive-nested-1-archiving')];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-sidebar-menu]').click();
  await status.waitFor();
  shots.push(await shot(page, 'archive-nested-2-archiving-390'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await control({ action: 'archive_release' });
  await nested.waitFor({ state: 'detached', timeout: 20_000 });
  // Chromium may withhold sensitive header details until the stalled response
  // finishes; collecting them before the shot would wait out the HTTP deadline.
  if ((await request.allHeaders()).authorization !== `Bearer ${FIXTURE_TOKEN}`) {
    throw new Error('nested archive did not authenticate to the fixture');
  }

  await control({ action: 'archive_fail_next' });
  await archiveRow(failedId);
  const other = page.locator(`[data-session-row="${failedId}"]`);
  await other.locator('[data-session-archive-error]').waitFor({ timeout: 10_000 });
  shots.push(await shot(page, 'archive-nested-3-refused'));

  // The HTTP adapter rejects archived:false even though the root succeeded.
  await control({ action: 'archive_partial_fail_next', session_id: failedId });
  await archiveRow(rootId);
  await page.locator(`[data-session-row="${rootId}"]`).waitFor({ state: 'detached', timeout: 20_000 });
  const banner = page.locator('[role="alert"]').filter({ hasText: 'Some conversations could not be archived' });
  await banner.waitFor({ timeout: 10_000 });
  if (!(await banner.textContent())?.includes(failedId) || await other.count() !== 1) {
    throw new Error('partial failure lost its unfinished conversation or recovery reason');
  }
  if ((await control({ action: 'session', session_id: rootId })).data.record.archived !== true ||
      (await control({ action: 'session', session_id: failedId })).data.record.archived === true) {
    throw new Error('partial fixture outcomes did not match the refreshed UI');
  }
  shots.push(await shot(page, 'archive-nested-4-partial-recovery'));
  await archiveRow(failedId);
  await other.waitFor({ state: 'detached', timeout: 20_000 });
  console.log('[archive-nested] release removed child; refusal retained row; partial removed root and retained reason + child; retry removed unfinished child');
  return shots;
}

async function archiveWorktreeRecoveryWalk(page, link, control) {
  const id = 'session_fixture_wt_active';
  await openSession(page, link, id);
  const row = page.locator(`[data-session-row="${id}"]`);
  let removalRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/worktrees\/[^/]+:remove$/.test(new URL(request.url()).pathname)) removalRequests++;
  });
  await row.locator('[data-session-title]').click({ button: 'right' });
  await page.locator('[data-session-menu] [data-menu-item="archive"]').click();
  const confirm = page.locator('[data-archive-confirm]');
  const checkbox = page.locator('[data-archive-remove-worktree] input');
  await confirm.waitFor();
  if (await checkbox.isChecked()) throw new Error('checkout removal must start unchecked');
  await checkbox.check();
  await control({ action: 'archive_fail_next' });
  const freshRead = page.waitForRequest((request) => request.method() === 'GET' && new URL(request.url()).pathname === '/api/sessions');
  await confirm.click();
  await page.locator('[role="alert"]').filter({ hasText: 'Archive refused' }).waitFor();
  await freshRead;
  if (!(await checkbox.isChecked()) || await confirm.isDisabled() || removalRequests !== 0) {
    throw new Error('failed worktree archive lost its choice, retry or checkout');
  }
  const shots = [await shot(page, 'archive-worktree-1-refused')];
  await checkbox.uncheck();
  await confirm.click();
  await confirm.waitFor({ state: 'detached', timeout: 20_000 });
  await row.waitFor({ state: 'detached', timeout: 20_000 });
  if (removalRequests !== 0) throw new Error('unchecked archive deleted the checkout');
  console.log('[archive-worktree] refusal refreshed sessions and retained checked confirmation; unchecked retry archived without checkout removal');
  return shots;
}

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
  const previewUrl = argv.find((arg) => arg.startsWith('--web-url='))?.slice('--web-url='.length);
  const buildMs = previewUrl !== undefined || (argv.includes('--no-build') && existsSync(join(DIST, 'index.html'))) ? 0 : build();
  const web = previewUrl === undefined ? await startStatic(DIST) : undefined;
  const webUrl = previewUrl ?? `http://127.0.0.1:${web.address().port}`;
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
    if (web !== undefined) await new Promise((done) => web.close(done));
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
