/**
 * control-ecosystem-shots — the Freedom / Extend / Ecosystem documentation
 * frames (`ce-20261005-*`), shot against the same pinned bundle and the same
 * fixture server the rest of the public visual set uses.
 *
 *   cd apps/kiki-gui
 *   KIKI_MARKETING_CAMPAIGN_REUSE_BUILD=1 \
 *   KIKI_CONTROL_ECOSYSTEM_DIR=../../.tmp/visual-control-ecosystem-20261005/frames \
 *   node scripts/control-ecosystem-shots.mjs --only=ce-extend
 *   node scripts/control-ecosystem-shots.mjs --only=ce-freedom-oauth-device --locales=en
 *
 * Why a second runner rather than a few rows in scripts/marketing-campaign.mjs.
 * That file, marketing-collect.mjs, fixture-server.mjs and
 * marketing-campaign-scene.mjs are owned work in flight on another stream, and
 * this slice adds frames for three pages that campaign does not shoot. Rather
 * than edit a file someone else is mid-change on, this runner composes the
 * same pipeline — the same static server, the same per-locale fixture boot, the
 * same DPR-2 1440×900 masters, the same settle discipline — from its own SHOTS
 * table, and writes only into its own output directory.
 *
 * Two rules this runner keeps so a frame cannot lie:
 *
 *   - It never deletes. Each run writes into its own timestamped subdirectory
 *     of KIKI_CONTROL_ECOSYSTEM_DIR, and never touches anything already there.
 *   - It never builds unless the bundle is missing. With
 *     KIKI_MARKETING_CAMPAIGN_REUSE_BUILD=1 the shared dist is taken as-is, so
 *     a capture cannot be invalidated by another agent's edit, and a build is
 *     never triggered from here by accident.
 *
 * The walkers below are all "drive the real control, then wait for the real
 * result". None of them composes a state by hiding something: an expanded row
 * is expanded by clicking its summary, a pending device flow is started by
 * pressing the sign-in button, and a probe result is the server's answer to the
 * probe the walker sent.
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(ROOT, '..', '..');

/** This runner's own frames, never another owner's. */
const OUT_ROOT = resolve(
  process.env.KIKI_CONTROL_ECOSYSTEM_DIR
    ?? join(REPO_ROOT, '.tmp', 'visual-control-ecosystem-20261005', 'frames'),
);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(OUT_ROOT, runId);

/** The shared, pinned build. Built only if genuinely absent. */
const DIST = resolve(
  process.env.KIKI_MARKETING_CAMPAIGN_DIST
    ?? join(REPO_ROOT, '.tmp', 'kiki-public-visuals', 'dist'),
);
/** 1440×900 @2x = 2880×1800 masters, matching the existing marketing frames. */
const DPR = 2;

const arg = (name, fallback) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};
const only = arg('only', null)?.split(',').filter((value) => value !== '') ?? null;
const locales = arg('locales', 'en,zh').split(',').filter((value) => value !== '');

/**
 * The fixture clock is pinned so relative copy ("3 min ago") is stable, and its
 * default epoch sits in January — a fixture artifact a public frame must not
 * carry. Anchoring it to a fixed recent date keeps the run deterministic while
 * making rendered times read as a plausible current day.
 */
if (process.env.KIKI_FIXTURE_EPOCH === undefined) {
  process.env.KIKI_FIXTURE_EPOCH = '2026-10-05T10:40:00.000Z';
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.ico': 'image/x-icon',
};

/** A static SPA server. `/__kiki/local-server` reports no local server. */
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
    const stream = createReadStream(file);
    stream.once('open', () => {
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      stream.pipe(res);
    });
    stream.once('error', () => {
      if (!res.headersSent) res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  return new Promise((ready) => { server.listen(0, '127.0.0.1', () => ready(server)); });
}

function build() {
  mkdirSync(DIST, { recursive: true });
  const result = spawnSync(process.execPath, [
    join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build',
    '--outDir', DIST, '--emptyOutDir', '--logLevel', 'warn',
  ], { cwd: ROOT, stdio: 'inherit', timeout: 300_000 });
  if (result.status !== 0) throw new Error(`vite build failed (status ${result.status})`);
}

/** Open a route and wait for one concrete selector — never networkidle. */
async function open(page, link, path, selector, timeout = 45_000) {
  await page.goto(link(path), { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector(selector, { timeout });
  // A settings page paints its shell before its data arrives, so a shell
  // selector can match while the section below it is still empty.
  await page.waitForTimeout(1_200);
}

/** Park the pointer away from every hover target and settle paint. */
async function settle(page) {
  await page.mouse.move(2, 2);
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations()
      .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined)));
  }).catch(() => undefined);
  await page.waitForTimeout(400);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(200);
}

/** Wait until a predicate over the DOM holds, so no frame races a refetch. */
async function until(page, predicate, timeout = 30_000) {
  await page.waitForFunction(predicate, undefined, { timeout });
}

// ---------------------------------------------------------------------------
// Shot table
// ---------------------------------------------------------------------------

const SHOTS = [
  // -------------------------------------------------------------------------
  // Freedom
  // -------------------------------------------------------------------------
  {
    // The device flow, mid-flight. The prose on this page describes a code, a
    // verification page, a validity window and a cancel; this is the only
    // screen where all four exist at once, and they only exist once a person
    // has pressed "Sign in". The walker presses it.
    name: 'ce-freedom-oauth-device',
    scenario: 'ce-freedom-oauth',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shotClip }) => {
      // `#st-card-auth` is the page's own deep link into the account lane of
      // Add connection. Using it is the path a reader takes.
      await open(page, link, '/settings/ai?tab=providers#st-card-auth', '[data-account-sign-in]', 60_000);
      const method = page.locator('[data-oauth-method="openai-codex"]');
      await method.waitFor({ timeout: 30_000 });
      // The device card appears under the method that started the flow, so
      // the button must be pressed before the code can exist.
      await method.locator('[data-account-sign-in-button]').click();
      // The code is the thing the frame is about: wait for it, not for the
      // click's promise, or a frame would record the pre-flow list.
      await until(page, () => {
        const code = document.querySelector('[data-oauth-method="openai-codex"] code');
        return code !== null && code.textContent?.trim() !== '';
      });
      await until(page, () => document.querySelector('[data-oauth-cancel]') !== null);
      await settle(page);
      // `.kiki-side-panel` is the panel's own chrome class, and it is a
      // full-height column: cropping to it leaves more than half the frame as
      // empty paper below the card. The device card is the subject, so the
      // crop runs from the panel's header — which carries the "Add
      // connection" title and the account/api choice the flow started from —
      // down to the cancel button, which is the last control the card
      // renders, plus its card's own bottom padding.
      const panelBox = await page.locator('.kiki-side-panel').boundingBox();
      const cancelBox = await page.locator('[data-oauth-cancel]').boundingBox();
      await shotClip({
        x: panelBox.x,
        y: panelBox.y,
        width: panelBox.width,
        height: cancelBox.y + cancelBox.height - panelBox.y + 20,
      });
    },
  },
  {
    // "Check this machine, then use this sign-in." The panel below is only
    // there once a probe has answered, and the answer names the account and
    // where the credential lives — which is what the prose says happens
    // *before* the offer appears. A frame of the empty panel would show the
    // wrong half of that sentence.
    name: 'ce-freedom-oauth-reuse',
    scenario: 'ce-freedom-oauth',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shotClip }) => {
      await open(page, link, '/settings/ai?tab=providers#st-card-auth', '[data-original-source="openai-codex"]', 60_000);
      const probe = page.locator('[data-original-source="openai-codex"] [data-original-source-probe]');
      await probe.waitFor({ timeout: 30_000 });
      await probe.click();
      // Two things must be true for this frame to be honest: the machine's
      // answer is on screen, and the offer to use it followed it.
      await until(page, () => document.querySelector('[data-original-source-result]') !== null);
      await until(page, () => document.querySelector('[data-original-source-connect]') !== null);
      await settle(page);
      // Same trim as the device frame, for the same reason: the panel is a
      // full-height column and "Use this sign-in" is the last control in it.
      const panelBox = await page.locator('.kiki-side-panel').boundingBox();
      const connectBox = await page.locator('[data-original-source-connect]').boundingBox();
      await shotClip({
        x: panelBox.x,
        y: panelBox.y,
        width: panelBox.width,
        height: connectBox.y + connectBox.height - panelBox.y + 20,
      });
    },
  },
  {
    // The permission picker, opened from the composer's own approvals chip.
    //
    // There is no settings page for this control — it is the chip in the
    // composer status line, and its menu is where all four modes and their
    // one-line meanings are visible at once. So the walker opens a session and
    // presses the chip, which is the only path a reader has to it. The frame
    // is cropped to the menu: the four rows are the point, and a full window
    // would spend most of its pixels on a transcript.
    name: 'ce-freedom-permission-modes',
    scenario: 'ce-freedom-permissions',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shotClip }) => {
      await open(page, link, '/s/session_fixture_ce_permissions', '[data-session-sidebar]', 60_000);
      // The composer only renders once the session's snapshot has landed, so
      // wait for the chip rather than for the rail.
      const chip = page.locator('[data-mode-select] button[aria-haspopup="listbox"]');
      await chip.waitFor({ timeout: 45_000 });
      await chip.click();
      // All four modes must be offered. Three would mean one is gated off on
      // this build, and the frame would read as "these are the modes" when it
      // is showing a subset.
      await until(page, () => document.querySelectorAll('[data-permission-mode]').length === 4);
      // Choose "Approve for me" by pressing it, rather than seeding a default
      // and hoping it wins. The chip's value resolves from the live session
      // state first and the server default only as a fallback, so a seeded
      // default is not guaranteed to be what the menu shows — and pressing
      // the row is the interaction the page's own paragraph describes. It is
      // also the mode a reader is least likely to guess exists, so it is the
      // one worth having selected in the frame.
      await page.locator('[data-permission-mode="review"]').click();
      // The chip re-labels in the page's own language, so this waits on the
      // ROW's checked state rather than on the chip's text — an English-only
      // text match would wait forever on the Chinese frame.
      await until(page, () => document
        .querySelector('[data-mode-select] button[aria-haspopup="listbox"]')?.textContent?.trim() !== '');
      // Reopen: picking a mode closes the menu, and the frame needs it open.
      await chip.click();
      await until(page, () => document.querySelector('[data-permission-mode][aria-selected="true"]') !== null);
      // Crop to the composer card rather than the menu alone. The menu on its
      // own is four rows with no anchor: a reader cannot tell it is a
      // composer control rather than a settings list, and the page's claim is
      // about how often the agent asks *while working*. The card contains the
      // chip that opened the menu, so the frame shows where the choice lives.
      const card = page.locator('[data-composer-card]').first();
      await card.scrollIntoViewIfNeeded();
      const panel = page.locator('[data-permission-panel]');
      await panel.waitFor({ timeout: 20_000 });
      const cardBox = await card.boundingBox();
      const panelBox = await panel.boundingBox();
      // The menu pops up above the card's status line, so the crop starts at
      // the panel's own top edge and runs down through the card's footer.
      await settle(page);
      await shotClip({
        x: Math.min(cardBox.x, panelBox.x),
        y: panelBox.y,
        width: Math.max(cardBox.width, panelBox.width),
        height: cardBox.y + cardBox.height - panelBox.y,
      });
    },
  },
  {
    // The prompt-field override editor, with its live preview.
    //
    // This replaces the existing `freedom-prompt-overrides` frame rather than
    // adding to it: in the shipped ZH frame the page heading is cut through
    // mid-glyph at the top edge and the preview card's bottom border is
    // cropped, so the one frame on this page that documents "down to one tool
    // description" is the frame that cannot be read cleanly.
    name: 'ce-freedom-prompt-overrides',
    scenario: 'ce-freedom-prompts',
    // Tall enough to hold the whole card. The shipped master was shot at
    // 1200×900 with a card that does not fit, which is why its heading is cut
    // through mid-glyph at the top and its preview card's bottom border is
    // cropped: the card needs about 960 CSS px once the field editor and the
    // preview are both open. A docs image is read by scrolling the page, not
    // by scrolling the picture, so the frame has to contain the whole card.
    viewport: { width: 1200, height: 1000 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/settings/agents', '[data-prompt-config]', 60_000);
      // The field editor is folded inside the card's own disclosure, so the
      // rows exist in the DOM but report a zero box until a person opens it.
      // That click is part of the story: overriding one tool's description is
      // a deliberate act, not a default view.
      const disclosure = page.locator('[data-prompt-config]').first();
      if ((await disclosure.evaluate((node) => node.open)) === false) {
        await disclosure.locator('summary').first().click();
      }
      const rows = page.locator('[data-prompt-field-row]:visible');
      await rows.first().waitFor({ timeout: 30_000 });
      // Open the preview: the point of the frame is the override and what the
      // model receives, side by side.
      const preview = page.locator('[data-prompt-preview] > summary');
      if ((await preview.count()) > 0
        && await preview.evaluate((node) => node.parentElement?.open ?? false) === false) {
        await preview.click();
      }
      await until(page, () => (document.querySelector('[data-prompt-preview]')?.textContent?.trim().length ?? 0) > 0);
      // The whole window, at a viewport tall enough for the card. Cropping to
      // the card was tried and is worse: it cuts the app's own chrome away, so
      // the frame no longer reads as a screenshot of Kiki, and it clips the
      // preview's last line at the same time. The clipped paragraph above the
      // card is the price of keeping the frame honest about what it is, and a
      // short unrelated line at the top is a smaller cost than losing the
      // product's own frame around it.
      await page.locator('[data-prompt-config]').first().scrollIntoViewIfNeeded();
      await settle(page);
      await shot();
    },
  },

  // -------------------------------------------------------------------------
  // Extend
  // -------------------------------------------------------------------------
  {
    // One installed plugin, opened. The marketplace grid cannot answer "what
    // did this plugin add"; the detail page can, and it groups the answer by
    // kind — which is exactly the list the page's prose enumerates.
    name: 'ce-extend-plugins',
    scenario: 'ce-extend-plugins',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/capabilities?plugin=kiki-office', '[data-plugin-detail="kiki-office"]', 60_000);
      // The contributions are one block; waiting for it means the frame shows
      // the groups, not a header that has not filled in.
      await until(page, () => document.querySelectorAll('[data-plugin-contribution]').length > 0);
      await settle(page);
      await shot();
    },
  },
  {
    // The skill catalog. A row carries both halves of the claim at once: the
    // workflow's description and the `/name` a person would type, and the
    // source it came from. One row's Markdown file does not show a catalog.
    name: 'ce-extend-skills',
    scenario: 'ce-extend-skills',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/capabilities?tab=skills', '[data-skill-row]', 60_000);
      // Wait for the plugin-sourced rows specifically: a frame taken between
      // the first and the last fetch would show a project-only catalog and
      // imply skills only come from the repository.
      await until(page, () => document.querySelector('[data-skill-source="plugin"]') !== null
        && document.querySelector('[data-skill-source="builtin"]') !== null);
      await settle(page);
      await shot();
    },
  },
  {
    // The MCP list. Three transports and four states sit together here, and
    // one row is expanded so the tools it contributes are visible — the
    // concrete form of "reaches the agent exactly like built-in tools".
    name: 'ce-extend-mcp',
    scenario: 'ce-extend-mcp',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/capabilities?tab=mcp', '[data-mcp-server]', 60_000);
      // All three transports must be on screen, or the frame cannot claim
      // the list carries them.
      await until(page, () => {
        const rows = [...document.querySelectorAll('[data-mcp-server]')];
        return rows.length >= 4 && rows.some((row) => row.textContent?.includes('stdio'))
          && rows.some((row) => row.textContent?.includes('http'))
          && rows.some((row) => row.textContent?.includes('sse'));
      });
      // Expand the connected stdio server: its tool list is the evidence the
      // frame exists for, and the expand is a click on the row's own button.
      const row = page.locator('[data-mcp-server="github-issues"]');
      await row.locator('button[aria-expanded]').first().click();
      await until(page, () => document.querySelector('[data-mcp-server-detail="github-issues"]')?.textContent?.includes('create_issue') === true);
      await settle(page);
      await shot();
    },
  },
  {
    // The retrieval module's own overview: which configuration source is in
    // effect, and whether the server reuses the local search config. This is
    // the claim that "the module is inspectable" rests on, and no other
    // screen states it.
    name: 'ce-extend-search-source',
    scenario: 'ce-extend-search',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      // The overview is the default tab; the readiness rows it prints are the
      // evidence the frame is about, so wait for the config-source block
      // rather than for a shell selector that matches before data lands.
      await open(page, link, '/settings/search', 'text=/Reuse server nb-search configuration|复用服务器本机 nb-search 配置/', 60_000);
      // Both tool rows must have resolved to a working tool. Readiness is
      // DERIVED from the capabilities seed by `nbSearchReadinessFromCapabilities`
      // rather than read from an `nbSearchTest` seed, so the honest signal is
      // each row printing both a status and what is in effect.
      //
      // This asserts the module is WORKING, not merely that its rows
      // resolved. The frame documents the retrieval module set up and in use,
      // so a Degraded row with an internal issue code in the middle of a
      // public screenshot reads as "this is what you get" when it is only what
      // an unconfigured server gets.
      //
      // The assertion is on the absence of the failure vocabulary rather than
      // the presence of "Ready", because the status word is localized — an
      // English-only match passes on the English frame and waits out its
      // timeout on the Chinese one. Both states have fixed keys:
      // `st.nbSearch.partialReadyHint` and the `st.nbSearch.issue.*` codes.
      await until(page, () => {
        const text = document.body.innerText;
        const partial = /Partially ready|部分就绪/.test(text);
        const issue = /LANE_NOT_CONFIGURED|CREDENTIAL_NOT_CONFIGURED|ENDPOINT_NOT_CONFIGURED|RATE_LIMIT_UNAUTHENTICATED/.test(text);
        const resolved = (text.match(/In effect:/g) ?? []).length + (text.match(/生效/g) ?? []).length;
        return !partial && !issue && resolved >= 2;
      });
      await settle(page);
      await shot();
    },
  },
  {
    // The named lanes, with the default one selected. Search "runs on named
    // lanes you can inspect"; a lane list with readiness and one chosen is
    // what that looks like, and it is a different claim from the source.
    name: 'ce-extend-search-lanes',
    scenario: 'ce-extend-search',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      // The tab id is `search`, not `lanes`: the section calls the lane list
      // "Search lanes" and the fetch one "Fetch chain", and the ids are
      // `search` / `fetch`.
      await open(page, link, '/settings/search?tab=search', '[data-nb-search-lane-row]', 60_000);
      // The default lane must be checked AND the frame's own subject must be a
      // working set of lanes. The tab suppresses an issue line for any row
      // that is merely unselected, so the two methods that still need a key
      // are legible as options without printing a red code — the frame shows
      // what a reader picks from, and the ones on offer are not the ones
      // running.
      await until(page, () => {
        const rows = [...document.querySelectorAll('[data-nb-search-lane-row]')];
        const sync = rows.filter((row) => row.querySelector('[data-nb-search-lane-execution="sync"]'));
        return rows.length >= 3 && sync.length >= 3
          && document.querySelector('input[type="radio"]:checked') !== null
          // No red reason is on screen: the tab only reveals those for a
          // selected, pinned, expanded or filtered row, and none is.
          && !/LANE_NOT_CONFIGURED|CREDENTIAL_NOT_CONFIGURED|RATE_LIMIT_UNAUTHENTICATED/.test(document.body.innerText);
      });
      await settle(page);
      await shot();
    },
  },
  {
    // The fetch chain, in order, every step working. "A fetch runs a chain
    // with visible fallbacks, so you can see which extractor produced the
    // text" is a claim about ordering and about a second extractor being
    // available when the first one comes back too thin. Both halves need a
    // step that can actually run: a fallback to an unavailable pipeline is a
    // failure, not a fallback, and the frame used to show exactly that — step
    // 1 in red with an internal issue code.
    name: 'ce-extend-fetch-chain',
    scenario: 'ce-extend-search',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/settings/search?tab=fetch', '[data-fetch-chain-step]', 60_000);
      // More than one step, in order — a one-step chain cannot show a
      // fallback — and none of them carrying a problem. The two names in the
      // seed's chain are asserted by name rather than by count, so a seed
      // change cannot quietly turn a two-step chain into a different one and
      // still pass.
      await until(page, () => {
        const steps = [...document.querySelectorAll('[data-fetch-chain-step]')];
        const text = document.body.innerText;
        return steps.length >= 2
          && steps.some((step) => step.getAttribute('data-fetch-chain-step') === 'direct.fetch')
          && steps.some((step) => step.getAttribute('data-fetch-chain-step') === 'jina.reader')
          && !/LANE_NOT_CONFIGURED|CREDENTIAL_NOT_CONFIGURED|ENDPOINT_NOT_CONFIGURED/.test(text);
      });
      await settle(page);
      await shot();
    },
  },

  // -------------------------------------------------------------------------
  // Ecosystem
  // -------------------------------------------------------------------------
  {
    // The external-executor direction: each engine checked, and the steps
    // that remain for the ones that are not ready. Two ready rows, one ready
    // but signed out, one missing with its install command — a frame of only
    // the ready rows would imply the product only ever says yes.
    name: 'ce-ecosystem-engines',
    scenario: 'ce-ecosystem-engines',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/settings/ai?tab=providers', '[data-engine-row]', 60_000);
      // The signed-out engine must have been checked, not assumed: the setup
      // steps only exist after a check answers. Do this before scrolling,
      // because clicking needs the row in view to be sure the target is the
      // one under the pointer.
      const codex = page.locator('[data-engine-row="codex"]');
      // `summary` is not unique inside the row — the engine's own facts block
      // nests a disclosure of its own — so address the row's direct summary.
      await codex.locator('> summary').click();
      await codex.locator('[data-engine-check-button]').waitFor({ timeout: 30_000 });
      await codex.locator('[data-engine-check-button]').click();
      await until(page, () => document
        .querySelector('[data-engine-row="codex"] [data-engine-last-check]')
        ?.getAttribute('data-engine-last-check') === 'warning');
      // The engines share the page with the connections list, and one row is
      // taller than the space left below it. `scrollIntoViewIfNeeded` is a
      // no-op here — the row is already partly on screen — so the frame asks
      // for an explicit offset: the expanded row's summary lands just below
      // the page header, which puts the ready row above it and the
      // missing-engine row below it both inside the window. Scrolling to
      // either end of the list instead cuts the other end in half.
      await page.evaluate(() => {
        const summary = document.querySelector('[data-engine-row="codex"] > summary');
        if (summary === null) return;
        // The settings page scrolls inside its own column, not the window, so
        // `window.scrollTo` moves nothing. Walk up to the nearest ancestor
        // that actually scrolls and move that one.
        const delta = summary.getBoundingClientRect().top - 120;
        let node = summary.parentElement;
        while (node !== null && node !== document.body) {
          const overflow = getComputedStyle(node).overflowY;
          if (overflow === 'auto' || overflow === 'scroll' || node.scrollHeight > node.clientHeight) {
            node.scrollTop += delta;
            return;
          }
          node = node.parentElement;
        }
        window.scrollBy({ top: delta });
      });
      await settle(page);
      await shot();
    },
  },
  {
    // The source list with two homes probed: one holding conversations, one
    // holding nothing. The preview frame already shows what is kept and
    // dropped; this shows the step before it — that a source can be
    // unreadable, and you learn that before you commit to anything.
    name: 'ce-ecosystem-import-sources',
    scenario: 'ce-ecosystem-import',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/capabilities?view=import', '[data-plugin-import-source]', 60_000);
      // Pick the readable source and name its home: the discovery list is
      // empty until the home matches a directory the server knows.
      await page.locator('[data-plugin-import-source="kiki-history:claude-code"]').click();
      const home = page.locator('[data-plugin-import-home]');
      await home.waitFor({ timeout: 30_000 });
      // Forward slashes: that is the form the seed uses, and the UI only
      // trims — a Windows-looking path with backslashes finds nothing.
      await home.fill('C:/Users/you/.claude');
      // The conversation list only appears once the probe has answered.
      await until(page, () => document.querySelectorAll('[data-plugin-import-file]').length >= 2);
      // Blur the field without selecting a conversation. The focus ring
      // around a text input is a state, not a fact about this screen, and a
      // reader would take it for an error border — but selecting a row is not
      // the way to clear it: selecting asks the server what the import would
      // keep, and the request needs a working directory the form has not been
      // told, so the view parks on "Checking what would be kept…" and the
      // frame records a spinner. The preview is the subject of the OTHER
      // ecosystem frame; this one is about the source list.
      await page.locator('h1, h2, [data-capabilities-tab]').first().click();
      await page.waitForTimeout(300);
      // The section is taller than the window and the reader's route through
      // it starts at the top ("what this conversation becomes"), so the frame
      // scrolls the *last* conversation into view rather than the first. That
      // puts the source tabs, the home field and the whole discovered list in
      // one frame, with the list's tail as the lower edge instead of its head.
      await page.locator('[data-plugin-import-file]').last().scrollIntoViewIfNeeded();
      await settle(page);
      await shot();
    },
  },
];

// ---------------------------------------------------------------------------

async function captureOne(browser, { webUrl, shot: def }) {
  const scenario = def.localeInName === false ? def.scenario : `${def.scenario}-${def.locale}`;
  const file = `${def.name}.${def.locale}.${def.theme}.png`;
  const fixture = await startFixtureServer({ port: 0, scenario });
  const fixtureUrl = `http://127.0.0.1:${fixture.http.address().port}`;
  /**
   * The server address and token travel in the query string, and a route may
   * already carry both a query and a hash (`#st-card-auth` opens the account
   * lane). They have to be appended BEFORE the hash: put them after it and
   * they land inside the fragment, the app never receives them, and every
   * frame silently degrades to the "Connect to Kiki" gate.
   */
  const link = (path) => {
    const [beforeHash, hash = ''] = path.split('#', 2);
    const joined = `${beforeHash}${beforeHash.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`;
    return `${webUrl}${joined}${hash === '' ? '' : `#${hash}`}`;
  };
  const context = await browser.newContext({
    viewport: def.viewport,
    deviceScaleFactor: DPR,
    locale: def.locale === 'zh' ? 'zh-CN' : 'en-US',
    colorScheme: def.theme,
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
  });
  await context.addInitScript((payload) => {
    try {
      localStorage.setItem('kiki.locale', payload.locale);
      localStorage.setItem('kiki.settings', JSON.stringify({ theme: payload.theme }));
      localStorage.setItem('kiki.layout', JSON.stringify({ groupBy: 'workspace', sortBy: 'updated-desc' }));
      localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
    } catch { /* storage unavailable */ }
  }, { locale: def.locale, theme: def.theme });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(link('/new'), { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForSelector('[data-session-sidebar]', { timeout: 60_000 });
    await page.waitForTimeout(700);
    const target = join(OUT, file);
    const write = async (options) => {
      await page.screenshot({ path: target, ...options });
      console.log(`[shot] ${file} (${Math.round(statSync(target).size / 1024)} KB)`);
    };
    const shot = async () => {
      await settle(page);
      await write();
    };
    /**
     * A frame cropped to one element instead of the whole window.
     *
     * A side panel is an overlay: a full-window shot of one shows the list it
     * covers, and the covered rows are cut mid-word by the panel's own edge —
     * which reads as a broken frame rather than as a covered page. Cropping to
     * the panel gives a frame whose every pixel belongs to the thing the
     * caption names, at the same 2× density so the type stays legible.
     */
    const shotElement = async (selector) => {
      const element = page.locator(selector).first();
      await element.waitFor({ timeout: 30_000 });
      await settle(page);
      await write({ clip: await element.boundingBox() });
    };
    /**
     * A frame cropped to a rectangle the walker computes itself.
     *
     * Some subjects span two elements that are not nested — a popover menu
     * that opens above the control that opened it, say. Neither element's own
     * box contains the other, so a crop to either one cuts the other in half.
     * The walker states the rectangle it means instead.
     */
    const shotClip = async (box) => {
      await write({ clip: {
        x: Math.max(0, Math.round(box.x)),
        y: Math.max(0, Math.round(box.y)),
        width: Math.round(box.width),
        height: Math.round(box.height),
      } });
    };
    await def.run({ page, link, shot, shotElement, shotClip, locale: def.locale, fixtureUrl });
    if (errors.length > 0) throw new Error(`pageerror: ${errors.join(' | ')}`);
    return { ok: true };
  } catch (error) {
    await page.screenshot({ path: join(OUT, `${file.replace(/\.png$/, '')}.FAIL.png`) }).catch(() => undefined);
    return { ok: false, error: error.message };
  } finally {
    await context.close().catch(() => undefined);
    await fixture.stop().catch(() => undefined);
  }
}

async function main() {
  // Create, never clear: `OUT` is a fresh per-run subdirectory, so there is
  // nothing of ours to clear and nothing of anyone else's to destroy.
  mkdirSync(OUT, { recursive: true });
  console.log(`[ce] output: ${OUT}`);

  // The shared build is taken as-is. A build is only produced when the bundle
  // is genuinely absent, because rebuilding here would serve a different app
  // than the one the other frames were captured from.
  if (!existsSync(join(DIST, 'index.html'))) {
    console.log(`[ce] no bundle at ${DIST}; building once`);
    build();
  } else {
    console.log(`[ce] reusing build ${DIST}`);
  }

  const web = await startStatic(DIST);
  const webUrl = `http://127.0.0.1:${web.address().port}`;
  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const results = [];
  try {
    for (const def of SHOTS) {
      if (only !== null && !only.some((fragment) => def.name.includes(fragment))) continue;
      for (const locale of locales) {
        for (const theme of def.themes ?? ['light']) {
          const job = { ...def, locale, theme };
          const started = Date.now();
          const result = await captureOne(browser, { webUrl, shot: job });
          results.push({ name: def.name, locale, theme, ...result, ms: Date.now() - started });
          console.log(`[ce] ${result.ok ? 'ok  ' : 'FAIL'} ${def.name}.${locale}.${theme} ${Date.now() - started}ms${result.ok ? '' : ` — ${result.error}`}`);
        }
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise((done) => { web.close(done); });
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`[ce] frames ${results.length}, failed ${failed.length}`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
