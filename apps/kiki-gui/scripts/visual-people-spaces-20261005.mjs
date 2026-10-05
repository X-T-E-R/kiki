/**
 * visual-people-spaces-20261005 — the screenshot runner for the docs Features
 * pages `people` and `spaces` (docs/{zh,en}/features/{people,spaces}.md).
 *
 *   node scripts/visual-people-spaces-20261005.mjs
 *   node scripts/visual-people-spaces-20261005.mjs --only=ps-20261005-room --locales=zh
 *
 * Why this is a separate runner instead of entries in scripts/marketing-campaign.mjs:
 * that file is owned work in flight, and this slice needs three things it does not
 * offer — its own output namespace, its own scenario family, and browser-level
 * answers for `/api/remote-connections*`. It reuses everything expensive from the
 * shared path: the same vite build (pinned read-only, never rebuilt here), the
 * same `startFixtureServer`, and the same campaign scene builders.
 *
 * Why it needs those browser-level answers: the fixture server wires `/web-access`
 * and `/homes` but has NO route for `/api/remote-connections*`. Every settings →
 * spaces page therefore renders the product's real "The local control connection is
 * not ready." and "session.not_found (40401)" — which is exactly what the shipped
 * spaces frames show today. The records below answer those three GETs for this run
 * only, in the real wire shape (packages/protocol/src/rest/connections.ts):
 *   GET /api/remote-connections              -> RemoteConnection[]
 *   GET /api/remote-connections/inbound      -> { enabled, configuredEnabled, identity, grants[] }
 *   GET /api/remote-connections/handshake    -> { identity, serverId, inboundEnabled }
 * The GUI is real; the peers behind the records are example data, and every label
 * says so (`build.example.test`, `peer.example.test`).
 *
 * Output: KIKI_PS_SHOTS_DIR, defaulting to the repo's .tmp/visual-people-spaces-20261005.
 * Each run writes into its OWN timestamped subdirectory and deletes nothing.
 */

// MUST be first: helpers.mjs reads the fixture epoch once, at module
// evaluation, and a runner-body assignment would run after the hoisted imports
// below had already frozen the clock on its January default.
import './people-spaces-clock.mjs';

import { mkdirSync, statSync } from 'node:fs';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';
import { SESSION } from '../fixtures/marketing-scene.mjs';
import { ROOM_ID } from '../fixtures/people-spaces-scene.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(ROOT, '..', '..');

/**
 * The shared campaign build, read-only. This runner NEVER builds: the build is
 * another owner's single writer, and a second vite build into the same directory
 * would race it. If the directory is missing the runner stops with a clear
 * message instead of silently building something of its own.
 */
const DIST = resolve(
  process.env.KIKI_PS_SHOTS_DIST ?? join(REPO_ROOT, '.tmp', 'kiki-public-visuals', 'dist'),
);

const OUT_ROOT = resolve(
  process.env.KIKI_PS_SHOTS_DIR ?? join(REPO_ROOT, '.tmp', 'visual-people-spaces-20261005'),
);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(OUT_ROOT, runId);

/** 1440×900 @2x = 2880×1800 masters, matching the existing marketing frames. */
const DPR = 2;

const arg = (name, fallback) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};
const only = arg('only', null)?.split(',').filter((value) => value !== '') ?? null;
const locales = arg('locales', 'en,zh').split(',').filter((value) => value !== '');

/**
 * The fixture clock is pinned by ./people-spaces-clock.mjs (see the import note
 * there): it has to happen before helpers.mjs is evaluated, and imports are
 * hoisted, so it cannot live in this file's body.
 */

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

const pick = (locale, en, zh) => (locale === 'zh' ? zh : en);

// ---------------------------------------------------------------------------
// Browser-level answers for the remote-connection surface
// ---------------------------------------------------------------------------

/**
 * Example peer records in the real `remoteConnectionSchema` shape. Two healthy
 * peers and one that the target has not approved, because "the target must
 * approve the source before anything flows" is the sentence this frame exists to
 * illustrate, and a list of three connected peers cannot show it.
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
      // Offline with its last-known reading kept: the page's promise is that an
      // offline peer keeps its measurement and its timestamp rather than
      // reporting invented zeros, so the frame has to show exactly that.
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
      label: pick(locale, 'A teammate’s Kiki', '队友的 Kiki'),
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

/**
 * Inbound status with the gate CLOSED and one grant still approved. The gate and
 * the list are deliberately two different things: enabling the gate approves
 * nobody, so a frame that shows an open gate with an empty list proves the wrong
 * half of that sentence.
 */
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

/** Answer the remote-connection reads from example records, for this run only. */
async function serveRemote(page, locale) {
  const records = neutralRemoteRecords(locale);
  const identity = neutralInbound(locale).identity;
  await page.route('**/api/remote-connections**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/remote-connections/, '');
    if (path.startsWith('/inbound')) {
      await route.fulfill({ json: { code: 0, msg: 'success', data: neutralInbound(locale) } });
      return;
    }
    if (path.startsWith('/handshake')) {
      await route.fulfill({ json: { code: 0, msg: 'success', data: { identity, serverId: 'srv-people-spaces', inboundEnabled: false } } });
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

// ---------------------------------------------------------------------------
// Walkers
// ---------------------------------------------------------------------------

const READY = '[data-session-sidebar]';

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

/**
 * The persona card's EXECUTION half: profile, model and effort, plus the work
 * directory and the delivery mode.
 *
 * The card is ~1715px tall in an ~835px pane, so identity and execution cannot
 * honestly share one frame — and the shipped people-persona-card frame already
 * covers identity (name, avatar, responsibility, the standing rules). This frame
 * is the complement that frame is missing: the page's second paragraph is the
 * claim that a persona is identity while a profile is execution, and with an
 * empty profile select the shipped frame cannot show that at all.
 *
 * So the frame pins the work section's TOP to the pane's top edge: the profile /
 * model / effort row lands in the upper third, and the work directory and
 * delivery mode follow it. The identity block is deliberately not in this frame —
 * that is the other frame's job, and showing a half-cropped name field twice
 * would read as a mistake rather than as a deliberate crop.
 */
async function framePersonaExecution(page) {
  const editor = '[data-persona-editor="lin-lan"]';
  await page.locator(`${editor} [data-persona-field="description"]`).waitFor({ timeout: 20_000 });
  // The work section is the last thing the editor renders; wait for its own
  // field rather than for the form, or the scroll below measures an empty box.
  await page.locator(`${editor} [data-persona-field="homeWorkspace"]`).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(600);
  const placed = await page.evaluate((selector) => {
    const form = document.querySelector(selector);
    const work = [...form.querySelectorAll('div,section')]
      .find((node) => node.querySelector('[data-persona-field="homeWorkspace"]') !== null);
    if (work === undefined) return false;
    // The nearest ancestor that actually scrolls is the pane to move; measuring
    // against document.scrollingElement here would scroll the whole window.
    let pane = work.parentElement;
    while (pane !== null && !/auto|scroll/.test(getComputedStyle(pane).overflowY)) {
      pane = pane.parentElement;
    }
    if (pane === null) return false;
    const target = pane.getBoundingClientRect().top;
    pane.scrollBy({ top: work.getBoundingClientRect().top - target });
    return true;
  }, editor);
  if (!placed) throw new Error('persona work section not found');
  await page.waitForTimeout(700);
  // The profile row is the whole point of this frame, so verify it is really
  // in view rather than shipping a frame that scrolled past it.
  const onScreen = await page.locator(`${editor} [data-persona-field="homeWorkspace"]`).evaluate(
    (node) => node.getBoundingClientRect().top >= 0 && node.getBoundingClientRect().bottom <= window.innerHeight,
  );
  if (!onScreen) throw new Error('persona work section is out of frame');
}

// ---------------------------------------------------------------------------
// Shot table
// ---------------------------------------------------------------------------

/**
 * Each entry names the frame, the scenario module that serves it, and the
 * walker. `scenario` is a PREFIX: the runner loads `<scenario>-<locale>`, so the
 * module files are `people-spaces-<key>-<locale>.scenario.mjs`.
 *
 * These are designed frames, not a matrix: every one of them is a screen the two
 * pages describe and no shipped frame shows.
 */
const SHOTS = [
  {
    // people.md §角色卡 — the EXECUTION side: which profile, model and effort
    // this persona runs on, and the directory it works in. The complement to the
    // shipped identity frame.
    name: 'ps-20261005-people-execution',
    scenario: 'people-spaces-card',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/personas?persona=lin-lan&view=settings', '[data-persona-row]', 60_000);
      await page.locator('[data-persona-row="lin-lan"]').click();
      await page.locator('[data-persona-editor="lin-lan"]').waitFor({ timeout: 20_000 });
      await framePersonaExecution(page);
      await settle(page);
      await shot();
    },
  },
  {
    // people.md §角色自己的记忆 — the persona scope, with its own entries.
    name: 'ps-20261005-people-memory',
    scenario: 'people-spaces-memory',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, '/memory', '[data-memory-kind]', 60_000);
      await page.locator('[data-memory-kind="persona"]').click();
      // Wait for real rows in the PERSONA scope, not merely for the scope
      // control: a frame between the two would claim the persona scope while
      // showing another list.
      await page.waitForFunction(() => document.querySelectorAll('[data-memory-row]').length > 0
        && document.querySelector('[data-memory-scope-kind]')?.getAttribute('data-memory-scope-kind') === 'persona',
      undefined, { timeout: 30_000 });
      // Open the pinned entry, so the frame shows the entry AND which persona
      // scope it belongs to — the pair that makes "its own memory" legible.
      const row = page.locator('[data-memory-row="mem_ps_checklist"]:visible').first();
      await row.waitFor({ timeout: 30_000 });
      await row.click();
      await page.locator('[data-memory-detail]:visible').first().waitFor({ timeout: 30_000 });
      await settle(page);
      await shot();
    },
  },
  {
    // people.md §房间 — the same room, paused because the budget ran out.
    name: 'ps-20261005-people-room-paused',
    scenario: 'people-spaces-room-paused',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, `/rooms/${ROOM_ID}`, '[data-room-log]');
      await page.locator('[data-room-message]').first().waitFor({ timeout: 20_000 });
      // The pause state has to be REAL: the frame must show the Continue
      // affordance and the spent budget, not just a paused-looking crop.
      await page.waitForSelector('[data-room-page][data-room-paused]', { timeout: 20_000 });
      await page.locator('[data-room-continue]').waitFor({ timeout: 20_000 });
      await settle(page);
      await shot();
    },
  },
  {
    // people.md §房间 — an existing THREAD seated beside the personas.
    name: 'ps-20261005-people-room-threads',
    scenario: 'people-spaces-room-threads',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, `/rooms/${ROOM_ID}`, '[data-room-log]');
      await page.locator('[data-room-message]').first().waitFor({ timeout: 20_000 });
      await page.locator('[data-room-member][data-room-member-kind="thread"]').waitFor({ timeout: 20_000 });
      await settle(page);
      await shot();
    },
  },
  {
    // spaces.md §空间 — the list, with the two failure lines gone.
    name: 'ps-20261005-spaces-list',
    scenario: 'people-spaces-spaces-list',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot, locale }) => {
      await serveRemote(page, locale);
      await open(page, link, '/settings/spaces', '[data-space-row]', 60_000);
      await page.locator('[data-space-list]').scrollIntoViewIfNeeded();
      await settle(page);
      await shot();
    },
  },
  {
    // spaces.md §空间 — the credential-scope choice, with the SSH copy list.
    name: 'ps-20261005-spaces-credentials',
    scenario: 'people-spaces-credentials',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot, locale }) => {
      await serveRemote(page, locale);
      await open(page, link, '/settings/spaces', '[data-space-row]', 60_000);
      // Drive the real menu item, not the dialog by construction: the row menu
      // is how a person reaches this choice.
      await page.locator('[data-space-menu="h-campaign000000001"]').click();
      await page.locator('[data-space-menu-item="credentials"]').waitFor({ timeout: 20_000 });
      await page.locator('[data-space-menu-item="credentials"]').click();
      await page.locator('[data-space-credentials="h-campaign000000001"]').waitFor({ timeout: 20_000 });
      // The isolated side of the choice is the target, and its SSH copy list is
      // only rendered for that target — so wait for a host row, not the dialog.
      await page.locator('[data-space-copy-ssh-host]').first().waitFor({ timeout: 20_000 });
      await settle(page);
      await shot();
    },
  },
  {
    // spaces.md §空间 — followed vs fixed, per domain, for one subspace.
    name: 'ps-20261005-spaces-detail',
    scenario: 'people-spaces-space-detail',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot, locale }) => {
      await serveRemote(page, locale);
      await open(page, link, '/settings/spaces', '[data-space-row]', 60_000);
      await page.locator('[data-space-menu="h-campaign000000001"]').click();
      await page.locator('[data-space-menu-item="settings"]').waitFor({ timeout: 20_000 });
      await page.locator('[data-space-menu-item="settings"]').click();
      // The detail read is a server round trip; wait for the real domain rows.
      await page.locator('[data-space-settings="h-campaign000000001"]').waitFor({ timeout: 30_000 });
      await page.locator('[data-space-group]').first().waitFor({ timeout: 20_000 });
      await settle(page);
      await shot();
    },
  },
  {
    // spaces.md §远端连接 — outbound peers, each with its own state.
    name: 'ps-20261005-spaces-remote',
    scenario: 'people-spaces-spaces-list',
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
    // spaces.md §远端连接 — inbound: the gate is off, one source is approved.
    name: 'ps-20261005-spaces-inbound',
    scenario: 'people-spaces-spaces-list',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot, locale }) => {
      await serveRemote(page, locale);
      await open(page, link, '/settings/spaces', '[data-inbound-connections]', 60_000);
      await page.locator('[data-inbound-gate]').waitFor({ timeout: 20_000 });
      await page.locator('[data-inbound-connections]').scrollIntoViewIfNeeded();
      await settle(page);
      await shot();
    },
  },
  {
    // spaces.md §Web 访问 — a temporary entry with its address expanded.
    name: 'ps-20261005-spaces-web-access',
    scenario: 'people-spaces-web-access',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot, locale }) => {
      await serveRemote(page, locale);
      await open(page, link, '/settings/spaces', '[data-web-access]', 60_000);
      await page.locator('[data-web-access]').scrollIntoViewIfNeeded();
      // Open the address disclosure: the link, the countdown and the
      // unencrypted-LAN warning are the three facts this section is about, and
      // all three are folded away by default.
      const toggle = page.locator('[data-web-access] summary, [data-web-access] [data-web-access-options]').first();
      if (await toggle.count() > 0) {
        const open_ = await toggle.evaluate((node) => node.tagName === 'DETAILS' ? node.open : node.getAttribute('aria-expanded') === 'true');
        if (!open_) await toggle.click();
      }
      await page.waitForTimeout(700);
      await settle(page);
      await shot();
    },
  },
  {
    // spaces.md §会话内 SSH — the resident strip, opened, with two hosts joined.
    name: 'ps-20261005-spaces-session-ssh',
    scenario: 'people-spaces-session-ssh',
    viewport: { width: 1440, height: 900 },
    run: async ({ page, link, shot }) => {
      await open(page, link, `/s/${SESSION.release}`, '[data-session-rail]', 60_000);
      await page.locator('[role="log"] [data-block-id^="user-"]').first().waitFor({ timeout: 45_000 });
      const strip = page.locator('[data-composer-ssh-strip]');
      await strip.waitFor({ timeout: 30_000 });
      // Two joined hosts with their own remove buttons is the whole claim of
      // this control, so the list has to be open rather than collapsed to a count.
      await page.locator('[data-composer-ssh-chip]').first().waitFor({ timeout: 30_000 });
      await page.locator('[data-composer-ssh-toggle]').click();
      await page.locator('[data-composer-ssh-list]').waitFor({ timeout: 20_000 });
      await settle(page);
      await shot();
    },
  },
];

// ---------------------------------------------------------------------------

/**
 * A deterministic port per frame. Settings → Spaces prints the control home's
 * address verbatim ("Configuring this Kiki: 127.0.0.1:<port>"), so an ephemeral
 * port lands in the pixels and changes on every run. Deriving the port from the
 * frame name keeps each frame byte-stable across runs, and the upward scan keeps
 * a concurrent run from colliding — this slice's captures and another owner's
 * can be in flight at the same time.
 */
function portFor(name) {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.codePointAt(0)) % 1_000_003;
  return 58_100 + (hash % 160);
}

async function listenFixture(scenario, name) {
  const first = portFor(name);
  for (let port = first; port < first + 60; port += 1) {
    try {
      return await startFixtureServer({ port, scenario });
    } catch (error) {
      // EADDRINUSE: another process holds this port, so the next one is tried.
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`no free port for ${name} near ${first}`);
}

async function captureOne(browser, { webUrl, shot: def }) {
  const scenario = def.localeInName === false ? def.scenario : `${def.scenario}-${def.locale}`;
  const file = `${def.name}.${def.locale}.light.png`;
  const fixture = await listenFixture(scenario, `${def.name}.${def.locale}`);
  const fixtureUrl = `http://127.0.0.1:${fixture.http.address().port}`;
  const link = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`;
  const context = await browser.newContext({
    viewport: def.viewport,
    deviceScaleFactor: DPR,
    locale: def.locale === 'zh' ? 'zh-CN' : 'en-US',
    colorScheme: 'light',
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
  }, { locale: def.locale, theme: 'light' });
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
      // A frame is a promise about its locale, and a zh shot carrying an en
      // label is a wrong frame rather than a slightly imperfect one. These two
      // checks are cheap and they catch the whole class: a walker that hardcodes
      // a locale when it serves browser-level records, and a frame that renders
      // the wrong dictionary.
      const stray = await page.evaluate((locale) => {
        const text = document.body.innerText;
        // CJK in an en frame and a small set of en chrome words in a zh frame.
        const hits = locale === 'en'
          ? [...new Set(text.match(/[一-鿿][^一-鿿\n]{0,24}/g) ?? [])].slice(0, 4)
          : [...new Set(['New session', 'Settings', 'Personas', 'New persona', 'Import persona card', 'Conversations', 'All conversations']
            .filter((word) => text.includes(word)))].slice(0, 4);
        return hits;
      }, def.locale);
      if (stray.length > 0) throw new Error(`locale leak into ${file}: ${stray.join(' | ')}`);
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
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error(`no GUI build at ${DIST}. This runner never builds — the shared campaign build is another owner's single writer.`);
  }
  mkdirSync(OUT, { recursive: true });
  console.log(`[ps] dist: ${DIST}`);
  console.log(`[ps] output: ${OUT}`);

  const web = await startStatic(DIST);
  const webUrl = `http://127.0.0.1:${web.address().port}`;
  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const results = [];
  try {
    for (const def of SHOTS) {
      if (only !== null && !only.some((fragment) => def.name.includes(fragment))) continue;
      for (const locale of locales) {
        const job = { ...def, locale, theme: 'light' };
        const started = Date.now();
        const result = await captureOne(browser, { webUrl, shot: job });
        results.push({ name: def.name, locale, ...result, ms: Date.now() - started });
        console.log(`[ps] ${result.ok ? 'ok  ' : 'FAIL'} ${def.name}.${locale} ${Date.now() - started}ms${result.ok ? '' : ` — ${result.error}`}`);
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
    web.close();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`[ps] ${results.length - failed.length}/${results.length} ok → ${OUT}`);
  if (failed.length > 0) {
    console.error(`[ps] failures:\n${failed.map((result) => `  - ${result.name}.${result.locale}: ${result.error}`).join('\n')}`);
    process.exitCode = 1;
  }
}

await main();
