/**
 * Persona-navigation capture: the 角色 navigation slice, on a real production
 * build against the `persona-navigation` fixture.
 *
 *   node scripts/persona-navigation-capture.mjs            # build + capture
 *   node scripts/persona-navigation-capture.mjs --no-build  # reuse the last build
 *
 * Every shot asserts the state it is about to file, so a screenshot can never
 * be recorded for a screen that did not show what it claims. Screens:
 *   - the 角色 group and the conversation switcher it opens (light, dark, 390);
 *   - /p/<id>/daily for a persona with a home (redirect + header identity) and
 *     for one without (the daily draft's hero: face, name, title, greeting);
 *   - the detail page's conversation list;
 *   - the 390 header identity stack (two lines) and the drawer.
 *
 * Placement is measured, not eyeballed: the header switcher has to open into
 * the content column (never over the sidebar), from the identity block's left
 * edge, under it, inside the viewport; the sidebar switcher opens from its
 * row's left edge, below it; the hero's face, the identity block, the target
 * row and the composer card share one column line at 1440 / 1024 / 390.
 *
 * Output: .tmp/persona-navigation/<run>/  (PNG per state).
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUN = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(process.env['PERSONA_NAV_OUT'] ?? join(ROOT, '.tmp', 'persona-navigation', RUN));
const DIST = resolve(process.env['PERSONA_NAV_DIST'] ?? join(ROOT, '.tmp', 'persona-navigation', 'dist'));
const BUILD = !process.argv.includes('--no-build');
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

function buildDist() {
  const result = spawnSync(process.execPath, [
    join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build',
    '--outDir', DIST, '--emptyOutDir', '--logLevel', 'warn',
  ], { cwd: ROOT, stdio: 'inherit', timeout: 300_000 });
  if (result.status !== 0) throw new Error(`vite build failed (status ${result.status})`);
}

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

function check(condition, label, detail) {
  const suffix = detail === undefined ? '' : ` — ${detail}`;
  if (!condition) throw new Error(`assertion failed: ${label}${suffix}`);
  console.log(`  ok   ${label}${suffix}`);
}

/** Positions are compared on real client rectangles, so "aligned" is measured,
 *  not eyeballed: 1.5px absorbs subpixel layout. */
const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance;
const round = (value) => Math.round(value * 10) / 10;

const PAPER_DARK = '#1b2226';

async function setTheme(page, theme) {
  await page.evaluate((next) => {
    const key = 'kiki.settings';
    const oldValue = localStorage.getItem(key);
    const settings = oldValue === null ? {} : JSON.parse(oldValue);
    const newValue = JSON.stringify({ ...settings, theme: next });
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage }));
  }, theme);
  await page.waitForFunction((next) => document.documentElement.dataset['theme'] === next, theme, { timeout: 10_000 });
  const paper = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-paper').trim());
  return (paper.toLowerCase() === PAPER_DARK) === (theme === 'dark');
}

async function capture() {
  if (BUILD) buildDist();
  const fixture = await startFixtureServer({ port: 0, scenario: 'persona-navigation' });
  const fixtureUrl = `http://127.0.0.1:${fixture.http.address().port}`;
  const web = await startStatic(DIST);
  const webUrl = `http://127.0.0.1:${web.address().port}`;
  const link = (path) => {
    const url = new URL(path, webUrl);
    url.searchParams.set('server', fixtureUrl);
    url.searchParams.set('token', FIXTURE_TOKEN);
    return url.toString();
  };

  const browser = await chromium.launch({ headless: true });
  const pages = [];

  const newPage = async (viewport, theme = 'light') => {
    const context = await browser.newContext({ viewport, locale: 'zh-CN', deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.addInitScript((initialTheme) => {
      try {
        localStorage.setItem('kiki.locale', 'zh');
        localStorage.setItem('kiki.settings', JSON.stringify({ theme: initialTheme, draftPersistence: true }));
        localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
      } catch { /* ignore */ }
    }, theme);
    pages.push({ context, page });
    return page;
  };

  const settle = async (page) => {
    await page.evaluate(async () => {
      const finite = document.getAnimations().filter(
        (animation) => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity,
      );
      await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
    }).catch(() => undefined);
  };

  const shot = async (page, name) => {
    await settle(page);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log(`  shot ${name}.png`);
  };

  const openSwitcherFromSidebar = async (page, personaName) => {
    const row = page.locator(`[data-sidebar-persona-row]`, { hasText: personaName }).first();
    await row.waitFor({ timeout: 20_000 });
    await row.locator('[data-persona-switcher-toggle]').click();
    await page.waitForSelector('[data-persona-conversation-switcher] [role="menuitem"]', { timeout: 10_000 });
    await settle(page);
    return page.locator('[data-persona-conversation-switcher]');
  };

  /** The switcher a session header opens, plus the boxes the placement is
   *  measured against: it has to hang under the identity block, from the
   *  identity's left edge, without covering the sidebar or leaving the
   *  viewport. */
  const openSwitcherFromHeader = async (page) => {
    await page.locator('[data-persona-header-toggle]').click();
    await page.waitForSelector('[data-persona-conversation-switcher] [role="menuitem"]', { timeout: 10_000 });
    // The enter animation translates the panel a few px; the geometry claims
    // below are about where it comes to rest.
    await settle(page);
    const switcher = await page.locator('[data-persona-conversation-switcher]').boundingBox();
    const identity = await page.locator('[data-session-persona-identity]').boundingBox();
    const sidebar = await page.locator('[data-session-sidebar]').boundingBox();
    const trigger = await page.locator('[data-persona-header-toggle]').boundingBox();
    const viewport = page.viewportSize();
    check(switcher !== null && identity !== null && sidebar !== null && trigger !== null && viewport !== null,
      'the header switcher and its reference boxes all have geometry');
    const label = `${viewport.width}x${viewport.height}`;
    check(switcher.x >= sidebar.x + sidebar.width - 1,
      `the panel opens into the content column, not over the sidebar (${label})`,
      `panel=${round(switcher.x)} sidebarRight=${round(sidebar.x + sidebar.width)}`);
    // The block's left edge, unless the window is too narrow for a 320px panel
    // to the right of it — then the clamp wins and the panel is flush with the
    // window's right margin, still never left of the sidebar.
    check(near(switcher.x, identity.x) || near(switcher.x + switcher.width, viewport.width - 8, 1.5),
      `the panel's left edge is the identity block's (${label})`,
      `panel=${round(switcher.x)} identity=${round(identity.x)} right=${round(switcher.x + switcher.width)}`);
    check(switcher.y >= identity.y + identity.height - 1 && switcher.y <= identity.y + identity.height + 10,
      `the panel hangs under the identity block (${label})`,
      `panelTop=${round(switcher.y)} identityBottom=${round(identity.y + identity.height)}`);
    check(switcher.y >= trigger.y + trigger.height - 1,
      `the panel does not cover the trigger it opened from (${label})`);
    check(switcher.x + switcher.width <= viewport.width - 8 + 0.5,
      `the panel stays inside the viewport (${label})`,
      `right=${round(switcher.x + switcher.width)} viewport=${viewport.width}`);
    const placement = await page.locator('[data-persona-conversation-switcher]').getAttribute('data-switcher-placement');
    check(switcher.y + switcher.height <= viewport.height - 7.5 || placement === 'above',
      `the panel is not cut off by the bottom edge (${label})`,
      `bottom=${round(switcher.y + switcher.height)} placement=${placement}`);
    return page.locator('[data-persona-conversation-switcher]');
  };

  /** The largest horizontal gap between two consecutive children of one line:
   *  a stray child (a workspace name pushed to the far end of the header) is a
   *  misalignment you can see and this can measure. */
  const maxChildGap = async (line) => line.evaluate((node) => {
    const rects = [...node.children]
      .map((child) => child.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    let gap = 0;
    for (let index = 1; index < rects.length; index += 1) {
      gap = Math.max(gap, rects[index].left - rects[index - 1].right);
    }
    return Math.round(gap * 10) / 10;
  });

  const secondIdentityLine = (page) => page.locator('[data-session-persona-identity] > div').nth(1);

  /** The daily hero: face at reading size, one column line for the identity
   *  block, the target row and the composer, and a name that is never hidden
   *  (only shortened). */
  const checkDailyHero = async (page, { avatar, label }) => {
    const identity = await page.locator('[data-hero-daily-identity]').boundingBox();
    const face = await page.locator('[data-hero-daily-identity] [data-persona-avatar]').first().boundingBox();
    const headline = await page.locator('[data-hero-headline]').boundingBox();
    const chrome = await page.locator('[data-hero-chrome]').boundingBox();
    const card = await page.locator('[data-composer-card]').boundingBox();
    const input = await page.locator('[data-composer]').boundingBox();
    const viewport = page.viewportSize();
    check(face !== null && face.height >= avatar,
      `the face leads the hero at ${avatar}px+ (${label})`, `face=${round(face?.height ?? -1)}`);
    check(face !== null && near(face.width, face.height, 2), `the face keeps its aspect (${label})`);
    check(near(identity.x, chrome.x + 24),
      `the identity block sits on the page's content column (${label})`,
      `identity=${round(identity.x)} column=${round(chrome.x + 24)}`);
    // The page's own content line carries the face block, the target row's
    // label and the starters; the composer's sheet starts at the same column
    // and keeps its own 12px inner gutter for the words it holds.
    check(card.x >= chrome.x - 0.5 && card.x + card.width <= chrome.x + chrome.width + 0.5,
      `the composer sheet sits on the hero's own column (${label})`,
      `card=${round(card.x)}..${round(card.x + card.width)} column=${round(chrome.x)}..${round(chrome.x + chrome.width)}`);
    check(near(input.x, card.x + 12, 2),
      `the composer's own text sits on the sheet's gutter (${label})`,
      `input=${round(input.x)} sheet=${round(card.x)}`);
    check(headline.x > identity.x, `the title hangs beside the face, not under it (${label})`,
      `title=${round(headline.x)} identity=${round(identity.x)}`);
    check(identity.y + identity.height <= viewport.height,
      `the hero fits the first screen (${label})`);
  };

  try {
    // 1. The 角色 group and its switcher (light, 1440).
    {
      const page = await newPage({ width: 1440, height: 900 });
      await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-sidebar-personas]', { timeout: 25_000 });
      const rows = page.locator('[data-sidebar-persona-row]');
      check(await rows.count() === 3, 'the sidebar lists all three personas', `count=${await rows.count()}`);
      const switcher = await openSwitcherFromSidebar(page, '林岚');
      const items = switcher.locator('[role="menuitem"]');
      check(await items.count() === 4, 'the switcher lists the daily conversation and three others', `count=${await items.count()}`);
      check((await items.first().textContent() ?? '').includes('日常对话'), 'the daily conversation is pinned first');
      check((await switcher.locator('[data-conversation-kind="room"]').textContent() ?? '').includes('发布房间'),
        'a room seat is named by its room');
      check(await switcher.locator('[data-conversation-item="session_daily_lin_lan"]').getAttribute('aria-current') === null,
        'no conversation claims to be current while /new is open');
      // The sidebar trigger anchors to its own row: the panel's left edge is
      // the row's, it hangs below it, and it stays inside the window.
      const row = page.locator('[data-sidebar-persona-row]', { hasText: '林岚' }).first();
      const rowBox = await row.boundingBox();
      const panelBox = await switcher.boundingBox();
      const size = page.viewportSize();
      check(near(panelBox.x, Math.max(8, rowBox.x)),
        'the sidebar panel opens from the row\'s own left edge',
        `panel=${round(panelBox.x)} row=${round(rowBox.x)}`);
      check(panelBox.y >= rowBox.y + rowBox.height - 1,
        'the sidebar panel hangs below the row instead of covering it',
        `panelTop=${round(panelBox.y)} rowBottom=${round(rowBox.y + rowBox.height)}`);
      check(panelBox.x >= 8 - 0.5 && panelBox.x + panelBox.width <= size.width - 8 + 0.5,
        'the sidebar panel stays inside the window',
        `left=${round(panelBox.x)} right=${round(panelBox.x + panelBox.width)} viewport=${size.width}`);
      await shot(page, 'nav-sidebar-switcher-1440');
      await page.close?.();
    }

    // 2. The daily draft for a persona without a home (light, 1440): the face
    // leads, the greeting follows it, everything on one column line.
    {
      const page = await newPage({ width: 1440, height: 900 });
      await page.goto(link('/p/a-che/daily'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-hero-daily-identity]', { timeout: 25_000 });
      check(await page.locator('[data-hero-daily-banner]').count() === 0, 'the removed intro banner is gone');
      const headline = await page.locator('[data-hero-headline]').textContent();
      check(headline?.trim() === '日常对话', 'the draft leads with the fixed title', `headline=${headline?.trim()}`);
      const identity = await page.locator('[data-hero-daily-identity]').textContent();
      check((identity ?? '').includes('阿澈'), 'the draft says whose daily conversation it is', `identity=${identity?.trim()}`);
      check(await page.locator('[data-hero-workspace]').textContent().then((text) => (text ?? '').includes('docs-site')),
        'the draft starts in the persona\'s own workspace');
      await checkDailyHero(page, { avatar: 56, label: '1440' });
      await page.locator('[data-hero-daily-greeting]').waitFor({ timeout: 10_000 });
      const greeting = await page.locator('[data-hero-daily-greeting]');
      const greetingBox = await greeting.boundingBox();
      // The quote's own box can carry the indent; what has to line up is where
      // its text starts.
      const greetingPad = await greeting.evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingLeft) || 0);
      const heroName = await page.locator('[data-hero-persona-name]').boundingBox();
      check(near(greetingBox.x + greetingPad, heroName.x),
        'the greeting\'s text starts at the name\'s column, under the face',
        `greeting=${round(greetingBox.x + greetingPad)} name=${round(heroName.x)}`);
      await shot(page, 'nav-daily-draft-1440');
      await page.close?.();
    }

    // 2b. The same hero at 1024 and 390, and at 390 with a long name: the
    // face steps down, the column line holds, nothing is cut.
    {
      const page = await newPage({ width: 1024, height: 900 });
      await page.goto(link('/p/a-che/daily'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-hero-daily-identity]', { timeout: 25_000 });
      await checkDailyHero(page, { avatar: 56, label: '1024' });
      await shot(page, 'nav-daily-draft-1024');
      await page.close?.();

      const narrow = await newPage({ width: 390, height: 844 });
      await narrow.goto(link('/p/xiao-lan/daily'), { waitUntil: 'domcontentloaded' });
      await narrow.waitForSelector('[data-hero-daily-identity]', { timeout: 25_000 });
      await checkDailyHero(narrow, { avatar: 48, label: '390' });
      const nameBox = await narrow.locator('[data-hero-persona-name]').boundingBox();
      const identityBox = await narrow.locator('[data-hero-daily-identity]').boundingBox();
      check(nameBox.width > 40 && nameBox.x + nameBox.width <= identityBox.x + identityBox.width + 0.5,
        'the long name stays inside the hero on a phone',
        `name=${round(nameBox.x)}..${round(nameBox.x + nameBox.width)} block=${round(identityBox.x + identityBox.width)}`);
      await shot(narrow, 'nav-daily-draft-390');
      await narrow.close?.();
    }

    // 3+4. The home conversation: the redirect, the two-line identity, and the
    // header's own switcher (light, 1440).
    {
      const page = await newPage({ width: 1440, height: 900 });
      await page.goto(link('/p/lin-lan/daily'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-session-persona-identity]', { timeout: 25_000 });
      check(new URL(page.url()).pathname === '/s/session_daily_lin_lan',
        'the daily address resolves to the existing home', page.url());
      const line = await page.locator('[data-session-conversation-kind="daily"]').textContent();
      check(line?.trim() === '日常对话', 'the second line names the daily conversation', `line=${line?.trim()}`);
      const workspace = await page.locator('[data-session-workspace]').textContent();
      check((workspace ?? '').includes('workshop'), 'the second line names the workspace', `workspace=${workspace?.trim()}`);
      check(await maxChildGap(secondIdentityLine(page)) <= 24,
        'the second line reads as one line, nothing pushed to the far end',
        `gap=${await maxChildGap(secondIdentityLine(page))}`);
      // Two lines fit the 48px header, and the actions sit on the right as one
      // group instead of crowding the face.
      const identityBox = await page.locator('[data-session-persona-identity]').boundingBox();
      const fits = await page.locator('[data-session-persona-identity]').evaluate((node) => node.scrollHeight <= node.clientHeight + 1);
      const headerBox = await page.locator('[data-session-persona-identity]').evaluate((node) => {
        const header = node.closest('header');
        const rect = header.getBoundingClientRect();
        return { top: rect.top, height: rect.height };
      });
      const headerName = await page.locator('[data-session-persona-name]').boundingBox();
      const actions = await page.locator('[data-session-actions]').boundingBox();
      check(fits, 'the second identity line is not clipped');
      check(identityBox.y >= headerBox.top - 0.5 && identityBox.y + identityBox.height <= headerBox.top + headerBox.height + 0.5,
        'the identity block stays inside the header band',
        `identity=${round(identityBox.y)}..${round(identityBox.y + identityBox.height)} header=${round(headerBox.top)}..${round(headerBox.top + headerBox.height)}`);
      check(actions.x - (headerName.x + headerName.width) >= 100,
        'the header keeps real space between the person and the actions',
        `nameRight=${round(headerName.x + headerName.width)} actions=${round(actions.x)}`);
      check(near(actions.y + actions.height / 2, headerBox.top + headerBox.height / 2, 2),
        'the action group is centred on the header band, not on the first line',
        `actions=${round(actions.y + actions.height / 2)} band=${round(headerBox.top + headerBox.height / 2)}`);
      await shot(page, 'nav-home-identity-1440');
      await openSwitcherFromHeader(page);
      const current = page.locator('[data-conversation-item="session_daily_lin_lan"]');
      check(await current.getAttribute('aria-current') === 'true', 'the current conversation is marked in the switcher');
      await shot(page, 'nav-header-switcher-1440');
      await page.close?.();
    }

    // 3b. A seat in a room: the second line names the room (never the seat's
    // own title), which is what the room roster on the wire has to support —
    // a member without `kind: 'persona'` is not a persona's seat.
    {
      const page = await newPage({ width: 1440, height: 900 });
      await page.goto(link('/s/session_room_release-031_lin-lan'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-session-persona-identity]', { timeout: 25_000 });
      const seat = await page.locator('[data-session-conversation-kind="room"]').textContent();
      check(seat?.trim() === '发布房间', 'the room seat is named by its room, not by a fallback', `seat=${seat?.trim()}`);
      check(await page.locator('[data-session-workspace]').textContent().then((text) => (text ?? '').includes('workshop')),
        'the room seat still names the workspace');
      // The roster on the wire: a persona's seat carries the discriminator the
      // room/member filters read (`kind: 'persona'`), not just a personaId.
      const roster = await fetch(`${fixtureUrl}/api/rooms/release-031`, { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } })
        .then((response) => response.json())
        .then((body) => (body.data ?? body).members ?? []);
      check(roster.length === 1 && roster[0].kind === 'persona' && roster[0].personaId === 'lin-lan',
        'the seeded room roster carries the persona discriminator the room filters read', JSON.stringify(roster));
      await shot(page, 'nav-room-identity-1440');
      await page.close?.();
    }

    // 4b. The same header switcher at 1024 and 390: the panel is anchored to
    // the person at every width, and at 390 the name is short, not hidden.
    // The ordinary-reply conversation comes first: same header, no 消息|过程.
    {
      const ordinary = await newPage({ width: 1440, height: 900 });
      await ordinary.goto(link('/s/session_lan_notes'), { waitUntil: 'domcontentloaded' });
      await ordinary.waitForSelector('[data-session-persona-identity]', { timeout: 25_000 });
      check(await ordinary.locator('[data-timeline-view-switch]').count() === 0,
        'an ordinary reply conversation keeps no 消息|过程 switch');
      const topic = await ordinary.locator('[data-session-persona-identity] [data-session-title]').textContent();
      check((topic ?? '').includes('证书续期'), 'the second line names the topic', `title=${topic?.trim()}`);
      check(await maxChildGap(secondIdentityLine(ordinary)) <= 24,
        'the topic line reads as one line, nothing pushed to the far end',
        `gap=${await maxChildGap(secondIdentityLine(ordinary))}`);
      check(await ordinary.locator('[data-session-persona-identity] [data-session-cwd]').isVisible()
        && await ordinary.locator('[data-session-persona-identity] [data-session-workspace]').count() === 0,
        'the topic line itself carries the path, so the workspace is not repeated');
      await shot(ordinary, 'nav-header-ordinary-1440');
      // Renaming in place swaps a taller control into the second line; the
      // 48px band has to hold it without clipping.
      await ordinary.locator('[data-session-persona-identity] [data-session-title]').click();
      await ordinary.locator('[data-session-rename-input]').waitFor({ timeout: 5_000 });
      const renameOverflow = await ordinary.locator('[data-session-persona-identity]').evaluate((node) => {
        const header = node.closest('header').getBoundingClientRect();
        const rect = node.getBoundingClientRect();
        return { clipped: node.scrollHeight > node.clientHeight + 1, past: Math.round((rect.bottom - (header.top + header.height)) * 10) / 10 };
      });
      check(!renameOverflow.clipped && renameOverflow.past <= 1,
        'renaming the topic in place still fits the header band', `past=${renameOverflow.past} clipped=${renameOverflow.clipped}`);
      await shot(ordinary, 'nav-header-rename-1440');
      await ordinary.close?.();

      const page = await newPage({ width: 1024, height: 900 });
      await page.goto(link('/s/session_daily_lin_lan'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-session-persona-identity]', { timeout: 25_000 });
      await openSwitcherFromHeader(page);
      await shot(page, 'nav-header-switcher-1024');
      await page.close?.();

      const narrow = await newPage({ width: 390, height: 844 });
      await narrow.goto(link('/s/session_lan_notes'), { waitUntil: 'domcontentloaded' });
      await narrow.waitForSelector('[data-session-persona-identity]', { timeout: 25_000 });
      const name = narrow.locator('[data-session-persona-name]');
      check(await name.isVisible(), 'the header names the person on a phone width instead of hiding it');
      const nameBox = await name.boundingBox();
      const identityBox = await narrow.locator('[data-session-persona-identity]').boundingBox();
      check(nameBox.width > 40 && nameBox.x + nameBox.width <= identityBox.x + identityBox.width + 0.5,
        'the long name is shortened, never overflowing the header',
        `name=${round(nameBox.x)}..${round(nameBox.x + nameBox.width)}`);
      check(await narrow.locator('[data-session-persona-identity]').evaluate((node) => node.scrollHeight <= node.clientHeight + 1),
        'both identity lines fit the phone header');
      check(await narrow.locator('[data-session-workspace]').count() === 1,
        'below sm the path is hidden, so the workspace name carries the project');
      await openSwitcherFromHeader(narrow);
      await shot(narrow, 'nav-header-switcher-390');
      await narrow.close?.();
    }

    // 5. The detail page's conversation list (light, 1440).
    {
      const page = await newPage({ width: 1440, height: 900 });
      await page.goto(link('/personas?persona=lin-lan&view=conversations'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-persona-conversation-row]', { timeout: 25_000 });
      const rows = page.locator('[data-persona-conversation-row]');
      check(await rows.count() === 4, 'the list is every conversation the server returns for the persona', `count=${await rows.count()}`);
      check(await page.locator('[data-persona-set-daily="session_lin_release"]').count() === 1,
        'a topic can become the daily conversation');
      check(await page.locator('[data-persona-set-daily="session_daily_lin_lan"]').count() === 0,
        'the current daily conversation does not offer to become itself');
      await page.locator('[data-persona-conversation-row="session_lin_release"]').hover();
      await shot(page, 'nav-conversations-1440');
      await page.close?.();
    }

    // 6. The same switcher in the dark palette (1440).
    {
      const page = await newPage({ width: 1440, height: 900 }, 'dark');
      await page.goto(link('/new'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-sidebar-personas]', { timeout: 25_000 });
      check(await setTheme(page, 'dark'), 'the dark palette really resolved');
      await openSwitcherFromSidebar(page, '林岚');
      await shot(page, 'nav-sidebar-switcher-1440-dark');
      await page.close?.();
    }

    // 7+8. 390: the header identity stack and the drawer.
    {
      const page = await newPage({ width: 390, height: 844 });
      await page.goto(link('/s/session_daily_lin_lan'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-session-persona-identity]', { timeout: 25_000 });
      check(await page.locator('[data-session-persona-name]').isVisible(),
        'the phone header shows whose conversation this is, not only the face');
      await shot(page, 'nav-identity-390');
      await page.locator('[data-sidebar-menu]').first().click();
      await page.waitForSelector('[data-sidebar-personas] [data-sidebar-persona-row]', { timeout: 15_000 });
      check(await page.locator('[data-sidebar-persona-row]').count() === 3, 'the drawer carries the 角色 group');
      await shot(page, 'nav-drawer-390');
      await page.close?.();
    }
  } finally {
    for (const { context } of pages) await context.close().catch(() => undefined);
    await browser.close();
    await new Promise((ready) => web.close(ready));
    await fixture.stop();
  }

  console.log(`\nScreens in ${OUT}`);
}

await capture();
