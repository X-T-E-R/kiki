/**
 * marketing-campaign — the public screenshot runner for the Features series.
 *
 *   node scripts/marketing-campaign.mjs                       # every shot
 *   node scripts/marketing-campaign.mjs --only=a19,a17        # names containing these
 *   node scripts/marketing-campaign.mjs --locales=zh
 *
 * Why this runner instead of scripts/marketing-shots.mjs: that one boots a
 * vite DEV server for the whole run. A dev server shares the worktree with
 * every other agent editing this repo, so a source edit elsewhere triggers an
 * HMR full reload that can land between a walker's wait and its capture. This
 * runner builds ONCE into a disposable directory and serves it statically, the
 * same way proof/runner.mjs does, so a capture cannot be invalidated by
 * someone else's edit. It is a separate file rather than a change to
 * proof/runner.mjs because that file is owned work in flight, and because the
 * promotional frames need DPR 2 masters where the proof goldens stay at 1.
 *
 * Output: KIKI_MARKETING_CAMPAIGN_DIR, defaulting to a directory under the
 * repo's .tmp/. Each run writes into its OWN timestamped subdirectory there and
 * deletes nothing, so two runs cannot collide and no other owner's frames are
 * at risk. Collecting into the tracked directories is a separate, explicit
 * copy (see scripts/marketing-collect.mjs).
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';
import { WORKBENCH_LONGWORK_SHOTS } from './marketing-workbench-longwork-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(ROOT, '..', '..');

/**
 * Where the frames go. The directory is created if absent and NEVER wiped:
 * this runner is told to stop deleting output directories wholesale, because a
 * recursive wipe is the same hazard whoever runs it — point it at a path
 * another agent owns and their frames are gone. Each run therefore writes into
 * its own subdirectory, so two concurrent runs cannot collide and nothing
 * already on disk is touched.
 */
const OUT_ROOT = resolve(
  process.env.KIKI_MARKETING_CAMPAIGN_DIR
    ?? join(REPO_ROOT, '.tmp', 'kiki-public-visuals', 'frames'),
);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(OUT_ROOT, runId);

/**
 * The build lives OUTSIDE the GUI package, in the repo's disposable .tmp. A
 * build inside apps/kiki-gui/.tmp is inside the directory tree other agents
 * are editing, and a build directory that sits among the sources invites
 * confusion about which bundle a run actually served. This one IS emptied by
 * `vite build --emptyOutDir`, which is safe precisely because it is this
 * runner's own build cache and nothing else is ever written there.
 */
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
 * The fixture clock is pinned so relative copy ("3 min ago") is stable across
 * runs, and its default epoch sits in January. A public frame must not carry
 * that pinned date into the pixels — a sidebar reading "Jan 1" or a run timer
 * reading "275d" is a fixture artifact, not the product. Anchoring the epoch to
 * a fixed recent date (the documented `KIKI_FIXTURE_EPOCH` lever) keeps the
 * run deterministic while making the rendered times read as a plausible
 * current day.
 */
if (process.env.KIKI_FIXTURE_EPOCH === undefined) {
  process.env.KIKI_FIXTURE_EPOCH = '2026-10-04T10:40:00.000Z';
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

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * A build key over the bundle inputs. An unchanged tree reuses the previous
 * build; any edit (even one that keeps the file size) bumps an mtime.
 */
function buildCacheKey() {
  const parts = [];
  // The workspace packages are part of the bundle, not optional context: the
  // GUI imports @kiki/session-core, and that package holds the i18n dictionary.
  // Keying only on apps/kiki-gui/src let a session-core edit reuse a stale
  // bundle, which is how a frame shipped with a string that no longer existed
  // in the source. If the dependency graph grows, add the package here.
  const inputs = [
    join(ROOT, 'src'),
    join(ROOT, 'index.html'),
    join(ROOT, 'vite.config.ts'),
    join(ROOT, 'public'),
    join(REPO_ROOT, 'packages', 'session-core', 'src'),
  ];
  for (const input of inputs) {
    const walk = (path) => {
      let info;
      try {
        info = statSync(path);
      } catch {
        return;
      }
      if (info.isDirectory()) {
        for (const child of readdirSync(path).sort()) walk(join(path, child));
        return;
      }
      // Labelled relative to the REPO root, because two of the inputs above
      // live outside the GUI package and ROOT-relative slicing would mangle
      // them into a negative offset.
      parts.push(`${path.slice(REPO_ROOT.length)}:${info.size}:${info.mtimeMs}`);
    };
    walk(input);
  }
  return parts.join('\n');
}

function build() {
  const started = Date.now();
  const result = spawnSync(process.execPath, [
    join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build',
    '--outDir', DIST, '--emptyOutDir', '--logLevel', 'warn',
  ], { cwd: ROOT, stdio: 'inherit', timeout: 300_000 });
  if (result.status !== 0) throw new Error(`vite build failed (status ${result.status})`);
  return Date.now() - started;
}

/**
 * Open the composer header row that docks the goal card and the queue strip.
 * Both are folded into that header until the reader opens them, so a walker
 * that waits for `[data-goal-card]` without this step waits forever on an
 * element that is correctly hidden. The toggle is the same one a person uses.
 */
async function openComposerHeader(page, which) {
  const tab = page.locator(`[data-composer-header] [data-header-toggle="${which}"]`);
  await tab.waitFor({ timeout: 30_000 });
  if ((await tab.getAttribute('aria-expanded')) !== 'true') await tab.click();
}

async function openQueue(page, link) {
  await open(page, link, `/s/${S}`, '[data-session-rail]', 60_000);
  await page.locator('[role="log"] [data-block-id^="user-"]').first().waitFor({ timeout: 45_000 });
  await openComposerHeader(page, 'queue');
  await page.locator('[data-queue-strip]').waitFor({ timeout: 30_000 });
}

async function openGoal(page, link) {
  await open(page, link, `/s/${S}`, '[data-session-rail]', 60_000);
  await page.locator('[role="log"] [data-block-id^="user-"]').first().waitFor({ timeout: 45_000 });
  await openComposerHeader(page, 'goal');
  await page.locator('[data-goal-card]').waitFor({ timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// Shot table
// ---------------------------------------------------------------------------

const S = 'sess_sample_prepare_release';
const READY = '[data-session-sidebar]';

/** Locale-aware copy, matching the fixtures' own helper. */
const pick = (locale, en, zh) => (locale === 'zh' ? zh : en);

/**
 * Remote connections have no fixture-server route: the only proven source for
 * them is the browser-level interception in
 * scripts/visual-proof-remote-spaces.mjs. Rather than fork that proof, the
 * campaign runner answers the same paths from its own neutral records, for the
 * one frame that shows the surface. The GUI is the real one and the records
 * carry the real wire shape; the peer behind them is example data, which the
 * frame's caption says out loud.
 */
function neutralRemoteRecords(locale) {
  const now = Date.now();
  const minute = 60_000;
  return [
    {
      id: '11111111-2222-4333-8444-555555555555',
      label: pick(locale, 'Build box — GPU server (office)', '构建机 — 办公室 GPU 服务器'),
      endpoint: 'https://build.example.test',
      target: { homeId: '0f4c6e1a-2b7d-4a3e-9c11-7d0a51b2c301', hostId: 'build-box', protocol: 1 },
      credentialRef: '11111111-2222-4333-8444-555555555555',
      purposes: ['gui'],
      enabled: true,
      backgroundSummary: true,
      state: 'online',
      lastConnectedAt: now - 40_000,
      activeLeases: 1,
      summary: {
        value: { online: true, busy_sessions: 3, needs_you_sessions: 2, revision: 'r-42', as_of: now - 3_000 },
        lastSeen: now - 3_000,
        stale: false,
      },
    },
    {
      id: '22222222-3333-4444-8555-666666666666',
      label: pick(locale, 'Kiki at home', '家里的 Kiki'),
      endpoint: 'https://home.example.test:8443',
      target: { homeId: 'b81c44a7-2f30-4d95-9e6a-3c17f2b8d406', hostId: 'home-desktop', protocol: 1 },
      credentialRef: '22222222-3333-4444-8555-666666666666',
      purposes: ['gui'],
      enabled: true,
      backgroundSummary: true,
      state: 'offline',
      lastConnectedAt: now - 9 * minute,
      activeLeases: 0,
      summary: {
        value: { online: true, busy_sessions: 1, needs_you_sessions: 0, revision: 'r-7', as_of: now - 9 * minute },
        lastSeen: now - 9 * minute,
        stale: true,
      },
    },
    {
      id: '33333333-4444-4555-8666-777777777777',
      label: pick(locale, 'A colleague’s Kiki', '同事的 Kiki'),
      endpoint: 'https://peer.example.test',
      target: { homeId: 'd2f7a0c5-8e41-4b73-a9c2-71e5d0b3f807', hostId: 'peer-laptop', protocol: 1 },
      credentialRef: '33333333-4444-4555-8666-777777777777',
      purposes: ['gui'],
      enabled: true,
      backgroundSummary: false,
      state: 'authentication_required',
      lastError: 'connection_not_approved',
      activeLeases: 0,
    },
  ];
}

function neutralInbound(locale) {
  const now = Date.now();
  return {
    enabled: false,
    configuredEnabled: false,
    identity: { homeId: '77aa11bb-22cc-4dd3-8ee4-99ff00aa11bb', hostId: 'this-machine', protocol: 1 },
    grants: [
      {
        id: 'ad10a1b2-c3d4-4e5f-8a91-b2c3d4e5f601',
        source: { homeId: '0f4c6e1a-2b7d-4a3e-9c11-7d0a51b2c301', hostId: 'build-box', protocol: 1 },
        target: { homeId: '77aa11bb-22cc-4dd3-8ee4-99ff00aa11bb', hostId: 'this-machine', protocol: 1 },
        purpose: 'gui',
        revision: 1,
        status: 'approved',
        label: pick(locale, 'Build box', '构建机'),
        createdAt: now - 3 * 3600_000,
        lastConnectedAt: now - 20_000,
        activeLeases: 1,
      },
    ],
  };
}

/** Answer the remote-connection API from example records, for this run only. */
async function serveRemote(page, locale) {
  const records = neutralRemoteRecords(locale);
  await page.route('**/api/remote-connections**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/remote-connections/, '');
    if (path.startsWith('/inbound')) {
      await route.fulfill({ json: { code: 0, msg: 'success', data: neutralInbound(locale) } });
      return;
    }
    if (path === '') {
      await route.fulfill({ json: { code: 0, msg: 'success', data: records } });
      return;
    }
    const one = records.find((record) => path.endsWith(record.id));
    await route.fulfill(one === undefined
      ? { status: 404, json: { code: 40409, msg: 'not found', data: null } }
      : { json: { code: 0, msg: 'success', data: one } });
  });
}

/** Open a route and wait for one concrete selector — never networkidle. */
async function open(page, link, path, selector, timeout = 45_000) {
  await page.goto(link(path), { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector(selector, { timeout });
  // A settings or management page paints its shell before its data arrives, so
  // a shell selector can match while the section below it is still empty. Give
  // the page's own queries a beat to land before a walker looks for content
  // inside it — otherwise the capture races the fetch and records an empty
  // frame as if the section were empty.
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

/**
 * The campaign compositions. Each entry names the frame, the scenario module
 * that serves it, and the walker. `viewport` is part of the composition: a
 * rail close-up and a full window are different crops of the same app, and the
 * frame has to be designed for the width it ships at.
 *
 * `scenario` is a PREFIX: the runner loads `<scenario>-<locale>`, matching the
 * existing marketing convention. An entry whose seed has no locale variant
 * sets `localeInName: false` and loads the bare module in every locale.
 */
const SHOTS = [
  {
    // The one screen a first-time reader has to understand: the lead session
    // and the work it has pushed out — dispatched subagents on their own
    // models, a running background task, the active goal, and a queued
    // message. Both dock elements are opened so they are in the frame.
    name: 'hero-workbench',
    scenario: 'marketing-h01',
    viewport: { width: 1440, height: 900 },
    themes: ['light', 'dark'],
    run: async ({ page, link, shot }) => {
      await openGoal(page, link);
      await openQueue(page, link);
      await settle(page);
      await shot();
    },
  },
  {
    name: 'workbench-per-role-models',
    scenario: 'marketing-r05',
    viewport: { width: 1200, height: 900 },
    run: async ({ page, link, shot }) => {
      // The rail close-up needs both halves of the story: the dispatch tree
      // with its per-role model chips, and a main turn beside it so the frame
      // reads as a session rather than a sidebar.
      await open(page, link, `/s/${S}`, '[data-session-rail] [data-agent-id]', 60_000);
      await page.locator('[role="log"] [data-block-id^="user-"]').first().waitFor({ timeout: 45_000 });
      await settle(page);
      await shot();
    },
  },
  {
    // Background tasks are a first-class page, not a rail section: the
    // workbench page is the one that says what is running while the agent
    // works, so the frame shows that page rather than a sidebar strip.
    name: 'workbench-background-tasks',
    scenario: 'marketing-d03',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      // `/s/:id/tasks` replaces the transcript, so the rail is not the marker
      // here; the running task rows are.
      await open(page, link, `/s/${S}/tasks`, '[data-session-sidebar]', 60_000);
      await page.waitForFunction(() => document.body.innerText.includes('transforming')
        || document.querySelectorAll('[data-task-row], [data-tasks-list] li, [data-task-card]').length > 0,
      undefined, { timeout: 45_000 });
      await settle(page);
      await shot();
    },
  },
  {
    name: 'long-work-goal-queue',
    scenario: 'marketing-r02',
    viewport: { width: 1200, height: 750 },
    run: async ({ page, link, shot }) => {
      await openGoal(page, link);
      await openQueue(page, link);
      // Each queued row's timing control appears on hover, and this frame's
      // whole point is that the send timing is per row — so the pointer stays
      // on the row instead of being parked by the settle.
      await page.locator('[data-queue-strip] li').first().hover();
      await page.locator('[data-queue-strip] [data-timing-picker]').first().waitFor({ timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(600);
      await shot({ skipSettle: true });
    },
  },
  {
    name: 'long-work-context-fresh',
    scenario: 'marketing-campaign-a16',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, `/s/${S}`, '[data-context-meter]');
      await page.locator('[data-context-meter]').click();
      await page.locator('[data-context-details]').waitFor({ timeout: 20_000 });
      // Fresh must be the SELECTED one, not merely present.
      await page.waitForFunction(() => document
        .querySelector('[data-context-strategy]')
        ?.getAttribute('data-strategy') === 'fresh', undefined, { timeout: 20_000 });
      await settle(page);
      await shot();
    },
  },
  {
    name: 'long-work-memory-scopes',
    scenario: 'marketing-campaign-a17',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      // The deep link alone is not enough: the page falls back to Global while
      // the persona directory is still loading. Drive the real control — the
      // persona scope is the subject, so the reader must see it chosen.
      await open(page, link, '/memory', '[data-memory-kind]', 60_000);
      await page.locator('[data-memory-kind="persona"]').click();
      await page.waitForFunction(() => document
        .querySelector('[data-memory-scope-kind]')
        ?.getAttribute('data-memory-scope-kind') === 'persona', undefined, { timeout: 30_000 });
      // Wait for real rows in the PERSONA scope, not merely for the scope
      // control: a frame taken between the two would claim the persona scope
      // while showing the global list.
      await page.waitForFunction(() => document.querySelectorAll('[data-memory-row]').length > 0
        && document.querySelector('[data-memory-scope-kind]')?.getAttribute('data-memory-scope-kind') === 'persona',
      undefined, { timeout: 30_000 });
      // Open the pinned persona entry specifically: it is the one carrying an
      // undoable change, so the frame shows the detail AND its history row with
      // Undo — the pair that proves a change can be taken back.
      const row = page.locator('[data-memory-row="mem_campaign_list_first"]:visible').first();
      await row.waitFor({ timeout: 30_000 });
      await row.click();
      await page.locator('[data-memory-detail]:visible').first().waitFor({ timeout: 30_000 });
      // The history list is its own block; wait for it so the frame cannot
      // record the "no history yet" empty state as the product's answer.
      await page.locator('[data-memory-history]:visible').first().waitFor({ timeout: 30_000 });
      await page.locator('[data-memory-undo]').first().waitFor({ timeout: 30_000 });
      await settle(page);
      await shot();
    },
  },
  {
    name: 'people-persona-card',
    scenario: 'marketing-campaign-a14',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/personas', '[data-persona-row]');
      await page.locator('[data-persona-row="lin-lan"]').click();
      await page.locator('[data-persona-editor="lin-lan"]').waitFor({ timeout: 20_000 });
      await settle(page);
      await shot();
    },
  },
  {
    name: 'people-daily-conversation',
    scenario: 'marketing-campaign-a18',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/personas?persona=lin-lan&view=conversations', '[data-persona-conversation-row]');
      await settle(page);
      await shot();
    },
  },
  {
    // The README's third image: a room where several personas discuss one topic.
    name: 'people-room',
    scenario: 'marketing-campaign-a19',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/rooms/release-031', '[data-room-log]');
      await page.locator('[data-room-message]').first().waitFor({ timeout: 20_000 });
      await settle(page);
      await shot();
    },
  },
  {
    // Spaces and Web access share one settings section, stacked. Each frame
    // scrolls its own card into view, because the section is taller than the
    // window and a full-height capture would show whichever card happened to
    // be on top rather than the one the caption promises.
    name: 'spaces-spaces-list',
    scenario: 'marketing-campaign-a20',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/settings/spaces', '[data-space-row]', 60_000);
      await page.locator('[data-space-list]').scrollIntoViewIfNeeded();
      await settle(page);
      await shot();
    },
  },
  {
    // Remote connections: one row per peer, each with its own state and the
    // moment its last reading was taken. The records are example data served
    // at the browser level (see serveRemote) — the surface is real, the peer
    // is not, and the caption says so.
    name: 'spaces-remote-connections',
    scenario: 'marketing-campaign-a20',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot, locale }) => {
      await serveRemote(page, locale);
      await open(page, link, '/settings/spaces', '[data-remote-connection]', 60_000);
      await page.locator('[data-remote-list]').scrollIntoViewIfNeeded();
      await settle(page);
      await shot();
    },
  },
  {
    name: 'spaces-web-access',
    scenario: 'marketing-campaign-web-access',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/settings/spaces', '[data-web-access]', 60_000);
      await page.locator('[data-web-access]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await settle(page);
      await shot();
    },
  },
  {
    name: 'freedom-connections',
    scenario: 'oauth-connections',
    localeInName: false,
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/settings/ai?tab=providers', '[data-connection-row]');
      await settle(page);
      await shot();
    },
  },
  {
    name: 'freedom-prompt-overrides',
    scenario: 'marketing-campaign-a02',
    viewport: { width: 1200, height: 900 },
    run: async ({ page, link, shot }) => {
      // The field editor is folded inside [data-prompt-config], so the rows
      // exist in the DOM but report a zero box until a person opens the
      // disclosure. That click is part of the story: overriding one tool's
      // description is a deliberate act, not a default view.
      await open(page, link, '/settings/agents', '[data-prompt-config]', 60_000);
      const disclosure = page.locator('[data-prompt-config]');
      if ((await disclosure.evaluate((node) => node.open)) === false) {
        // `.first()`: the card nests further disclosures (main agent,
        // externally delegated, preview), and the one that gates the field
        // rows is the card's own summary.
        await disclosure.locator('summary').first().click();
      }
      const rows = page.locator('[data-prompt-field-row]:visible');
      await rows.first().waitFor({ timeout: 30_000 });
      await rows.first().scrollIntoViewIfNeeded();
      // Open the preview: the point of the frame is the override and what the
      // model receives, side by side.
      const preview = page.locator('[data-prompt-preview] > summary');
      if ((await preview.count()) > 0) {
        const open = await preview.evaluate((node) => node.parentElement?.open ?? false);
        if (!open) await preview.click();
      }
      await page.waitForTimeout(500);
      await settle(page);
      await shot();
    },
  },
  {
    // A04 — the profiles roster. Settings → Agents is a single table: one row
    // per profile with its role (main agent or subagent), its own model, its
    // effort, and the subagents it may dispatch. That row set is the whole
    // claim the page makes, so the frame is the populated table.
    name: 'agents-profiles',
    scenario: 'marketing-campaign-a04',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/settings/agents', '[data-team-row]', 60_000);
      // Wait for the seeded roles, not merely for the table: an empty roster
      // renders the same wrapper, and the frame would claim a page that shows
      // nothing.
      await page.locator('[data-team-row="release-lead"]').waitFor({ timeout: 30_000 });
      await page.locator('[data-team-row="implementer"]').waitFor({ timeout: 30_000 });
      await settle(page);
      await shot();
    },
  },
  {
    // A04's second frame: one profile opened. The page's claim is that a
    // profile is ONE readable file — frontmatter bindings and the system
    // prompt in the same record — so the frame is the editor sheet with the
    // lead's own definition in it, not another list.
    name: 'agents-profile-editor',
    scenario: 'marketing-campaign-a04',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/settings/agents', '[data-team-row]', 60_000);
      const row = page.locator('[data-team-row="release-lead"] [data-team-open="release-lead"]').first();
      await row.waitFor({ timeout: 30_000 });
      await row.click();
      // The editor is a sheet keyed to the profile it opened; waiting on the
      // `main` field proves the sheet is the lead's record and not a stale
      // sheet or the new-profile form.
      const editor = page.locator('[data-profile-editor][data-agent-detail="release-lead"]');
      await editor.waitFor({ timeout: 30_000 });
      await editor.locator('[data-profile-field="main"]').waitFor({ timeout: 30_000 });
      await settle(page);
      await shot();
    },
  },
  {
    // A04's third frame, and the one the page most needs: the composer picker
    // that turns a profile into the session's main agent. It is a standalone
    // toolbar control (`#composer-agent-profile-select`) and it only exists
    // once the profile catalog has landed, so the frame opens it and lists the
    // candidates — the reader has to see that main-ness is a CHOICE made here.
    name: 'agents-profile-picker',
    scenario: 'marketing-campaign-a04',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/new', '#composer-agent-profile-select', 60_000);
      const trigger = page.locator('#composer-agent-profile-select').first();
      await trigger.waitFor({ timeout: 30_000 });
      await trigger.click();
      // The panel is a listbox; waiting for an option that names a seeded
      // candidate proves the catalog resolved, not merely that the control
      // painted.
      const option = page.locator('[role="option"]', { hasText: 'release-lead' }).first();
      await option.waitFor({ timeout: 30_000 });
      await settle(page);
      await shot();
    },
  },
  {
    name: 'daily-usage',
    scenario: 'marketing-campaign-a10',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/usage?panel=history', '[data-usage-panel="history"]');
      // The page opens on Today, which is one bar and one row. The frame has
      // to show what the page is FOR — a week of spend broken down by model —
      // so it drives the same range control a reader would.
      await page.locator('[data-axis="range"] [data-axis-value="last_7_days"]').click();
      // Wait for a full week of bars, not merely for the click: the range
      // change refetches, and a frame taken mid-fetch would show one day.
      await page.locator('[data-usage-trend] [data-bucket]').nth(6).waitFor({ timeout: 30_000 });
      await settle(page);
      await shot();
    },
  },
  {
    name: 'ecosystem-history-import',
    scenario: 'marketing-campaign-a12',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      // The source home is a field the reader fills, and the preview card only
      // exists once that field names a source the server knows. So the frame
      // performs the real action: pick Claude Code, type its history path, and
      // capture the preview that says what is kept and what is dropped.
      await open(page, link, '/capabilities?view=import', '[data-plugin-import-source]', 60_000);
      await page.locator('[data-plugin-import-source="kiki-history:claude-code"]').click();
      const home = page.locator('[data-plugin-import-home]');
      await home.waitFor({ timeout: 30_000 });
      // The path must match the seeded home byte for byte: the fixture keys its
      // homes by the exact string, and the UI only trims. Forward slashes here
      // because that is what the seed uses — a Windows-looking path with
      // backslashes silently finds nothing.
      await home.fill('C:/Users/you/.claude');
      // The working directory is the OTHER half of the request. It starts
      // empty, and a native read with no directory is not sent at all — so the
      // preview would never be asked for, and the frame would sit on
      // "Checking what would be kept…" forever. This is the order a person
      // works in: name the home, name where the session should live, then pick
      // the conversation.
      const workDir = page.locator('[data-plugin-import-workdir-input]');
      await workDir.waitFor({ timeout: 30_000 });
      await workDir.fill('C:/Projects/sample-app');
      const file = page.locator('[data-plugin-import-file]').first();
      await file.waitFor({ timeout: 40_000 });
      await file.click();
      const preview = page.locator('[data-plugin-import-preview]').first();
      await preview.waitFor({ timeout: 40_000 });
      await preview.scrollIntoViewIfNeeded();
      await settle(page);
      await shot();
    },
  },
  {
    name: 'look-skins',
    scenario: 'marketing-campaign-a08',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/settings/appearance', '[data-skin-settings]');
      await settle(page);
      await shot();
    },
  },
  // Slices that own their own scene seeds and walkers register here rather
  // than editing the table above. The spread is the whole integration point:
  // the module is standalone and carries its own `run` bodies.
  ...WORKBENCH_LONGWORK_SHOTS,
];

// ---------------------------------------------------------------------------

async function captureOne(browser, { webUrl, shot: def }) {
  // A seed without a locale variant is shot in both locales from one module:
  // the GUI localizes the chrome from `kiki.locale`, so the same fixture
  // renders EN and ZH surfaces without two copies of the data.
  const scenario = def.localeInName === false ? def.scenario : `${def.scenario}-${def.locale}`;
  const file = `${def.name}.${def.locale}.${def.theme}.png`;
  const fixture = await startFixtureServer({ port: 0, scenario });
  const fixtureUrl = `http://127.0.0.1:${fixture.http.address().port}`;
  const link = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`;
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
    await page.waitForSelector(READY, { timeout: 60_000 });
    await page.waitForTimeout(700);
    const target = join(OUT, file);
    const shot = async ({ skipSettle = false } = {}) => {
      if (!skipSettle) await settle(page);
      await page.screenshot({ path: target });
      console.log(`[shot] ${file} (${Math.round(statSync(target).size / 1024)} KB)`);
    };
    await def.run({ page, link, shot, locale: def.locale, fixtureUrl, control: async (body) => {
      const response = await fetch(`${fixtureUrl}/__control`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return response.json();
    } });
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
  // Create, never clear. `OUT` is a fresh per-run subdirectory, so there is
  // nothing of ours to clear and nothing of anyone else's to destroy.
  mkdirSync(OUT, { recursive: true });
  console.log(`[campaign] output: ${OUT}`);

  // One run, one bundle. The cache key is a fingerprint of every bundle input,
  // and this worktree is shared: an unrelated edit under src/ by another agent
  // bumps it, so without a pin a long run can rebuild between two frames and
  // serve a different app than the one the first frame was captured from. With
  // KIKI_MARKETING_CAMPAIGN_REUSE_BUILD=1 the existing build is taken as-is and
  // the run is pinned to it; otherwise the build is refreshed once, up front.
  const reuse = process.env.KIKI_MARKETING_CAMPAIGN_REUSE_BUILD === '1';
  const key = buildCacheKey();
  const keyFile = join(DIST, '.campaign-build-key');
  let buildMs = 0;
  if (existsSync(join(DIST, 'index.html')) && existsSync(keyFile)
    && (reuse || readFileSync(keyFile, 'utf8') === key)) {
    console.log(`[campaign] reusing build${reuse ? ' (pinned)' : ' (unchanged sources)'}`);
  } else {
    mkdirSync(DIST, { recursive: true });
    console.log(`[campaign] building -> ${DIST}`);
    buildMs = build();
    writeFileSync(keyFile, key);
  }

  const web = await startStatic(DIST);
  const webUrl = `http://127.0.0.1:${web.address().port}`;
  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const results = [];
  try {
    for (const def of SHOTS) {
      if (only !== null && !only.some((fragment) => `${def.name}-${def.scenario}`.includes(fragment))) continue;
      for (const locale of locales) {
        for (const theme of def.themes ?? ['light']) {
          const job = { ...def, locale, theme };
          const started = Date.now();
          const result = await captureOne(browser, { webUrl, shot: job });
          results.push({ name: def.name, locale, theme, ...result, ms: Date.now() - started });
          console.log(`[campaign] ${result.ok ? 'ok  ' : 'FAIL'} ${def.name}.${locale}.${theme} ${Date.now() - started}ms${result.ok ? '' : ` — ${result.error}`}`);
        }
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise((done) => { web.close(done); });
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`[campaign] build ${buildMs}ms, frames ${results.length}, failed ${failed.length}`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
