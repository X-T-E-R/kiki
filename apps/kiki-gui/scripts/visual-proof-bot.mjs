/**
 * Visual proof for Bot mode and rooms (fixture `bot-mode`): the message view
 * (settled, an activity summary open, streaming, the process view), the
 * handoff arriving on the receiving Bot, the sidebar Bots / Rooms groups,
 * Bot settings, a budget-paused three-member room with its members rail, a
 * live room with a question and a member working — at 1440 and 390, light
 * and dark.
 *
 *   node scripts/visual-proof-bot.mjs [--only=message,handoff,settings,room,live]
 *
 * Screenshots land in .tmp/bot-proof/<stamp>/ as `<surface>-<theme>-<width>.png`.
 * Mock-only: the fixture server stands in for kap-server.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.tmp', 'bot-proof', String(Date.now()));
await mkdir(output, { recursive: true });
const only = new Set((process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) ?? 'message,handoff,settings,room,live').split(','));
const widths = (process.argv.find((arg) => arg.startsWith('--widths='))?.slice('--widths='.length) ?? '1440,390').split(',').map(Number);
const themes = (process.argv.find((arg) => arg.startsWith('--themes='))?.slice('--themes='.length) ?? 'light,dark').split(',');

const SCENARIO = 'bot-mode';
const fixture = await startFixtureServer({ port: 0, scenario: SCENARIO });
const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
process.env.KIKI_SERVER_URL = endpoint;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/*.test.ts', '**/*.test.tsx'] } } });
await vite.listen();
const web = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const errors = [];

const control = (body) => fetch(`${endpoint}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const url = (path) => `${web}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(endpoint)}&token=${FIXTURE_TOKEN}`;

async function withPage(theme, width, run) {
  const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => { errors.push(`${theme}-${width}: ${error.message}`); });
  await page.addInitScript((next) => {
    localStorage.setItem('kiki.locale', 'zh');
    localStorage.setItem('kiki.settings', JSON.stringify({ theme: next }));
  }, theme);
  try { await run(page); } finally { await page.close(); }
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  });
  await page.waitForTimeout(200);
}

/**
 * DOM audit of this slice's surfaces on the rendered page: text contrast
 * against the nearest opaque background (AA: 4.5, 3 for ≥18.66px bold /
 * 24px), controls smaller than 24×24, text clipped without an ellipsis,
 * and the room header / log / composer overlapping each other.
 */
async function audit(page, name) {
  const findings = await page.evaluate(() => {
    const SCOPE = '[data-room-page], [data-sidebar-bot-rooms], [data-bot-settings], [data-message-view-row], [data-room-mentions], [data-enable-bot-menu], [data-create-room], [role="menu"]';
    const parse = (value) => {
      const match = /rgba?\(([^)]+)\)/u.exec(value);
      if (match === null) return undefined;
      const [r, g, b, a = '1'] = match[1].split(/[ ,/]+/u).filter(Boolean);
      return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
    };
    const lum = ({ r, g, b }) => {
      const channel = (value) => { const s = value / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const background = (element) => {
      const layers = [];
      for (let node = element; node !== null; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color !== undefined && color.a > 0) {
          layers.push(color);
          if (color.a >= 0.99) break;
        }
      }
      let base = { r: 255, g: 255, b: 255 };
      for (const layer of layers.reverse()) {
        base = { r: layer.r * layer.a + base.r * (1 - layer.a), g: layer.g * layer.a + base.g * (1 - layer.a), b: layer.b * layer.a + base.b * (1 - layer.a) };
      }
      return base;
    };
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) return false;
      for (let node = element; node !== null; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.5) return false;
      }
      return true;
    };
    const label = (element) => `${element.tagName.toLowerCase()}${[...element.attributes].filter((attr) => attr.name.startsWith('data-')).map((attr) => `[${attr.name}]`).slice(0, 2).join('')} "${(element.textContent ?? '').trim().slice(0, 24)}"`;
    const out = [];
    for (const scope of document.querySelectorAll(SCOPE)) {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
        const element = text.parentElement;
        if (element === null || seen.has(element) || (text.textContent ?? '').trim() === '' || !visible(element)) continue;
        if (element.closest('[disabled], [aria-hidden="true"], input, textarea') !== null) continue;
        // Visually hidden labels (sr-only, incl. breakpoint variants) are clipped by design.
        if (getComputedStyle(element).position === 'absolute' && element.getBoundingClientRect().width <= 1) continue;
        seen.add(element);
        const style = getComputedStyle(element);
        const fg = parse(style.color);
        if (fg === undefined) continue;
        const bg = background(element);
        const blended = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
        const [hi, lo] = [lum(blended), lum(bg)].sort((a, b) => b - a);
        const ratio = (hi + 0.05) / (lo + 0.05);
        const size = Number.parseFloat(style.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
        if (ratio < (large ? 3 : 4.5)) out.push(`contrast ${ratio.toFixed(2)} ${label(element)}`);
        if (style.textOverflow !== 'ellipsis' && style.overflow !== 'visible' && element.scrollWidth > element.clientWidth + 1 && style.whiteSpace === 'nowrap') {
          out.push(`clipped ${label(element)}`);
        }
      }
      for (const control of scope.querySelectorAll('button, a[href], [role="option"], select')) {
        if (!visible(control) || control.closest('[aria-hidden="true"]') !== null) continue;
        const rect = control.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24) out.push(`target ${Math.round(rect.width)}x${Math.round(rect.height)} ${label(control)}`);
      }
    }
    const header = document.querySelector('[data-room-header]')?.getBoundingClientRect();
    const log = document.querySelector('[data-room-log]')?.getBoundingClientRect();
    const composer = document.querySelector('[data-room-composer]')?.getBoundingClientRect();
    for (const row of document.querySelectorAll('[data-message-view-row="message"], [data-room-from]:not([data-room-from="user"])')) {
      if (!visible(row)) continue;
      const width = row.getBoundingClientRect().width;
      if (width > 641) out.push(`agent row wider than 640 (${Math.round(width)}) ${label(row)}`);
    }
    for (const bubble of document.querySelectorAll('[data-room-from="user"] > div:first-child')) {
      if (!visible(bubble)) continue;
      if (Math.abs(bubble.parentElement.getBoundingClientRect().right - bubble.getBoundingClientRect().right) > 1) out.push(`user bubble not right-aligned ${label(bubble)}`);
    }
    for (const scope of document.querySelectorAll(SCOPE)) {
      for (const element of scope.querySelectorAll('*')) {
        if (!visible(element)) continue;
        const rect = element.getBoundingClientRect();
        let clipRight = innerWidth;
        for (let node = element.parentElement; node !== null; node = node.parentElement) {
          if (getComputedStyle(node).overflowX !== 'visible') { clipRight = Math.min(clipRight, node.getBoundingClientRect().right); break; }
        }
        if (Math.min(rect.right, clipRight) > innerWidth + 1) { out.push(`offscreen right ${Math.round(rect.right - innerWidth)}px ${label(element)}`); break; }
      }
    }
    // The room composer's card carries focus; the textarea draws no box of its own.
    const input = document.querySelector('[data-room-input]');
    if (input !== null && document.activeElement === input && getComputedStyle(input).outlineStyle !== 'none') {
      out.push(`room input draws its own outline (${getComputedStyle(input).outlineStyle})`);
    }
    // The roster notice must not strand a character on its last line.
    const notice = document.querySelector('[data-room-roster-locked] > span');
    if (notice !== null && visible(notice)) {
      const range = document.createRange();
      range.selectNodeContents(notice);
      const lines = [...range.getClientRects()];
      const lastTop = Math.max(...lines.map((rect) => rect.top));
      const lastWidth = lines.filter((rect) => Math.abs(rect.top - lastTop) < 2).reduce((sum, rect) => sum + rect.width, 0);
      if (lastWidth < Number.parseFloat(getComputedStyle(notice).fontSize) * 2.5) out.push(`roster notice last line ${Math.round(lastWidth)}px (orphan)`);
    }
    if (header && log && header.bottom > log.top + 1) out.push('overlap room header/log');
    if (log && composer && log.bottom > composer.top + 1) out.push('overlap room log/composer');
    return [...new Set(out)];
  });
  for (const finding of findings) errors.push(`${name}: ${finding}`);
}

async function shot(page, name) {
  await settle(page);
  await audit(page, name);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) errors.push(`${name}: horizontal overflow ${overflow}px`);
  const file = join(output, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

async function openSidebar(page, width) {
  if (width >= 768) return;
  await page.locator('button[aria-label="打开会话菜单"]').first().click();
  await page.waitForTimeout(250);
}

const LIN = 'session_bot_lin_lan';

const walkers = {
  async message(page, tag, width) {
    await page.goto(url(`/s/${LIN}`), { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForSelector('[data-message-view-row="message"]', { timeout: 30_000 });
    if ((await page.locator('[data-timeline-view-switch="message"]').count()) === 0 && width >= 640) errors.push(`${tag}: header view switch missing`);
    const noReply = await page.locator('[data-message-outcome="no-reply"]').count();
    if (noReply !== 1) errors.push(`${tag}: expected one no-reply line, saw ${noReply}`);
    if ((await page.getByText('小蓝还没回，我先不打扰用户').count()) > 0) errors.push(`${tag}: internal prose leaked into the message view`);
    await shot(page, `message-${tag}`);
    // Sidebar Bots / Rooms groups.
    await openSidebar(page, width);
    await page.waitForSelector('[data-sidebar-bot="lin-lan"]', { timeout: 10_000 });
    await shot(page, `sidebar-${tag}`);
    if (width < 768) await page.keyboard.press('Escape');
    await page.goto(url(`/s/${LIN}`), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-activity-summary-toggle]', { timeout: 30_000 });
    await page.locator('[data-activity-summary-toggle]').first().click();
    await page.waitForSelector('[data-activity-summary-members]');
    await page.locator('[data-activity-summary-members]').first().scrollIntoViewIfNeeded();
    await shot(page, `message-activity-open-${tag}`);
    // Process view: the same speech, internal prose marked.
    if (width >= 640) await page.locator('[data-timeline-view-option="process"]').click();
    else {
      await page.locator('[data-session-actions] > button').click();
      await page.locator('[data-timeline-view-menu="process"]').click();
    }
    await page.waitForSelector('[data-assistant-internal]', { timeout: 10_000 });
    await shot(page, `process-${tag}`);
    // Delivery menu with the next-turn hint shows while a turn runs: stream one.
    if (width >= 640) await page.locator('[data-timeline-view-option="message"]').click();
    else {
      await page.locator('[data-session-actions] > button').click();
      await page.locator('[data-timeline-view-menu="message"]').click();
    }
    const composer = page.locator('textarea').last();
    await composer.fill('证书那边怎么样了？');
    await composer.press('Control+Enter');
    await page.waitForSelector('[data-message-status="sending"]', { timeout: 15_000 });
    await page.waitForFunction(() => (document.querySelector('[data-message-status="sending"] [data-message-text]')?.textContent ?? '').includes('核对'), null, { timeout: 15_000 });
    await shot(page, `message-streaming-${tag}`);
    await page.locator('[data-session-actions] > button').click();
    await page.locator('[data-delivery-option="reply"]').click();
    await page.locator('[data-session-actions] > button').click();
    await page.waitForSelector('[data-delivery-pending]', { timeout: 20_000 });
    await shot(page, `delivery-next-turn-${tag}`);
    await page.keyboard.press('Escape');
    await control({ action: 'release', session_id: LIN });
    await page.waitForSelector('[data-message-row="tool-stream_send"][data-message-status="sent"]', { timeout: 15_000 }).catch(() => { errors.push(`${tag}: streamed message never settled`); });
  },
  async handoff(page, tag) {
    await page.goto(url(`/s/${LIN}`), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-message-handoff]', { timeout: 30_000 });
    await page.locator('[data-message-handoff]').first().scrollIntoViewIfNeeded();
    await shot(page, `handoff-sender-${tag}`);
    await page.goto(url('/s/session_bot_a_che'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-message-handoff]', { timeout: 30_000 });
    await shot(page, `handoff-receiver-${tag}`);
  },
  async settings(page, tag) {
    await page.goto(url(`/s/${LIN}`), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-message-view-row="message"]', { timeout: 30_000 });
    await page.locator('[data-session-actions] > button').click();
    await page.locator('[data-bot-settings-open]').click();
    await page.waitForSelector('[data-bot-settings] [data-bot-description]', { timeout: 10_000 });
    await shot(page, `bot-settings-${tag}`);
  },
  async room(page, tag, width) {
    await page.goto(url('/rooms/release-031'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-room-system-live]', { timeout: 30_000 });
    if (width < 1280 && (await page.locator('[data-room-members]').count()) === 0) {
      await page.locator('[data-room-roster]').click();
      await page.waitForSelector('[data-room-members]');
    }
    await shot(page, `room-paused-members-${tag}`);
    if (width < 1280) {
      await page.locator('[data-room-members] button[aria-label="关闭成员面板"]').click();
    } else {
      await page.locator('[data-room-roster]').click();
    }
    await page.waitForSelector('[data-room-members]', { state: 'detached' });
    await shot(page, `room-paused-${tag}`);
    const input = page.locator('[data-room-input]');
    // Typed, not filled: keyboard input makes the textarea :focus-visible,
    // the state the double-outline regression showed up in.
    await input.focus();
    await page.keyboard.type('@');
    await page.waitForSelector('[data-room-mentions]');
    if (!(await input.evaluate((node) => node.matches(':focus-visible')))) errors.push(`${tag}: room input not :focus-visible`);
    await shot(page, `room-mention-${tag}`);
    await input.fill('');
    await page.locator('[data-room-system-continue]').click();
    await page.waitForSelector('[data-room-system="continued"]', { timeout: 10_000 });
    await page.locator('[data-room-input]').fill('按周五发。@阿澈 公告也一起起草。');
    await page.locator('[data-room-input]').press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-room-from="user"]')].some((node) => node.textContent?.includes('公告也一起起草')), null, { timeout: 10_000 });
    await shot(page, `room-continued-${tag}`);
  },
  async live(page, tag, width) {
    await page.goto(url('/rooms/docs-review'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-room-question]', { timeout: 30_000 });
    await page.waitForSelector('[data-message-presence]', { timeout: 10_000 });
    if (width < 1280 && (await page.locator('[data-room-members]').count()) > 0) {
      await page.locator('[data-room-members] button[aria-label="关闭成员面板"]').click();
    }
    await shot(page, `room-live-${tag}`);
    if ((await page.locator('[data-room-members]').count()) === 0) await page.locator('[data-room-roster]').click();
    await page.waitForSelector('[data-room-roster-locked]');
    await shot(page, `room-live-members-${tag}`);
  },
};

try {
  for (const theme of themes) {
    for (const width of widths) {
      for (const [name, walk] of Object.entries(walkers)) {
        if (!only.has(name)) continue;
        await control({ action: 'scenario', name: SCENARIO });
        await withPage(theme, width, (page) => walk(page, `${theme}-${width}`, width)).catch((error) => {
          errors.push(`${name} ${theme}-${width}: ${error.message.split('\n')[0]}`);
        });
      }
    }
  }
} finally {
  await browser.close();
  await vite.close();
  await fixture.stop();
}
console.log(`[proof] ${output}`);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
