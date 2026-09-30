/**
 * Visual proof for thread rooms (fixture `thread-rooms`): a room of existing
 * threads with its members rail (busy thread, wait-while-busy switches,
 * leave), the Threads tab of Add member, the sidebar multi-select bar and
 * row menu, the new-room dialog, the join-room dialog, the session rail's
 * room deliveries, Activity › Thread messages with a room row, and the
 * disabled entries once thread communication is turned off.
 *
 *   node scripts/visual-proof-thread-rooms.mjs [--widths=1440] [--themes=light,dark]
 *
 * Screenshots land in .tmp/thread-rooms-proof/<stamp>/ as `<surface>-<theme>-<width>.png`.
 * Mock-only: the fixture server stands in for kap-server.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.tmp', 'thread-rooms-proof', String(Date.now()));
await mkdir(output, { recursive: true });
const widths = (process.argv.find((arg) => arg.startsWith('--widths='))?.slice('--widths='.length) ?? '1440').split(',').map(Number);
const themes = (process.argv.find((arg) => arg.startsWith('--themes='))?.slice('--themes='.length) ?? 'light,dark').split(',');

const SCENARIO = 'thread-rooms';
const fixture = await startFixtureServer({ port: 0, scenario: SCENARIO });
const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
process.env.KIKI_SERVER_URL = endpoint;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/*.test.ts', '**/*.test.tsx'] } } });
await vite.listen();
const web = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const errors = [];

const control = (body) => fetch(`${endpoint}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const api = (path, init) => fetch(`${endpoint}/api${path}`, { ...init, headers: { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/json', ...init?.headers } });
const url = (path) => `${web}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(endpoint)}&token=${FIXTURE_TOKEN}`;

async function withPage(theme, width, run) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => { errors.push(`${theme}-${width}: ${error.message}`); });
  await page.addInitScript((next) => {
    localStorage.setItem('kiki.locale', 'zh');
    localStorage.setItem('kiki.settings', JSON.stringify({ theme: next }));
  }, theme);
  try { await run(page); } finally { await page.close(); }
}

async function shot(page, name) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  });
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) errors.push(`${name}: horizontal overflow ${overflow}px`);
  const file = join(output, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

async function walk(page, tag) {
  // Room with thread members, rail open (1440 opens it by default).
  await page.goto(url('/rooms/api-contract'), { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-room-member="session_thread_backend"]', { timeout: 30_000 });
  await page.waitForSelector('[data-room-queued]', { timeout: 10_000 });
  await shot(page, `room-threads-${tag}`);
  // Add member › Threads tab.
  await page.locator('[data-room-add-tab="threads"]').click();
  await page.waitForSelector('[data-room-add-thread]', { timeout: 10_000 });
  const offered = await page.locator('[data-room-add-thread]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-room-add-thread')));
  if (offered.includes('session_thread_backend_child')) errors.push(`${tag}: subagent offered as a room member`);
  if (offered.includes('session_thread_backend')) errors.push(`${tag}: a member is offered again`);
  await page.locator('[data-room-add-threads]').scrollIntoViewIfNeeded();
  await shot(page, `room-add-threads-${tag}`);
  await page.locator('[data-room-thread-search]').fill('文档');
  await page.waitForSelector('[data-room-add-thread="session_thread_docs"]', { timeout: 10_000 });
  await page.locator('[data-room-add-thread="session_thread_docs"]').click();
  await page.waitForSelector('[data-room-member="session_thread_docs"]', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-room-system="member_joined"]').length >= 5, null, { timeout: 10_000 });
  await shot(page, `room-thread-added-${tag}`);

  // Sidebar multi-select → selection bar → row menu.
  await page.locator('[data-session-row="session_thread_backend"] > button').first().click({ modifiers: ['Control'] });
  await page.locator('[data-session-row="session_thread_frontend"] > button').first().click({ modifiers: ['Control'] });
  await page.waitForSelector('[data-session-selection]');
  await page.locator('[data-session-row="session_thread_frontend"]').click({ button: 'right' });
  await page.waitForSelector('[data-menu-item="new-thread-room"]');
  await shot(page, `sidebar-selection-menu-${tag}`);
  await page.locator('[data-menu-item="new-thread-room"]').click();
  await page.waitForSelector('[data-new-thread-room]');
  await page.waitForSelector('[data-room-add-thread]', { timeout: 10_000 });
  await shot(page, `new-thread-room-${tag}`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-new-thread-room]', { state: 'detached' });

  // Join room dialog from a single row.
  await page.locator('[data-session-row="session_thread_release"]').click({ button: 'right' });
  await page.locator('[data-menu-item="join-room"]').click();
  await page.waitForSelector('[data-join-room="api-contract"]');
  await shot(page, `join-room-${tag}`);
  await page.keyboard.press('Escape');

  // Session rail: room deliveries grouped by room.
  await page.goto(url('/s/session_thread_backend'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-comms-room="api-contract"]', { timeout: 30_000 });
  await page.locator('[data-comms-room="api-contract"]').scrollIntoViewIfNeeded();
  await shot(page, `rail-comms-room-${tag}`);

  // Activity › Thread messages.
  await page.goto(url('/activity?view=comms'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-activity-comms-item="rm_1"]', { timeout: 30_000 });
  await shot(page, `activity-comms-room-${tag}`);

  // Communication off: entries disabled with the reason.
  await api('/config', { method: 'POST', body: JSON.stringify({ thread_communication: { enabled: false } }) });
  await page.goto(url('/rooms/api-contract'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-room-member="session_thread_backend"]', { timeout: 30_000 });
  await page.locator('[data-room-add-tab="threads"]').click();
  await page.waitForSelector('[data-thread-room-comms-off]', { timeout: 10_000 });
  await page.locator('[data-room-add]').scrollIntoViewIfNeeded();
  await shot(page, `room-comms-off-${tag}`);
  await page.locator('[data-session-row="session_thread_tests"]').click({ button: 'right' });
  await page.waitForSelector('[data-menu-item="new-thread-room"][disabled]', { timeout: 10_000 });
  await shot(page, `sidebar-menu-comms-off-${tag}`);
}

try {
  for (const theme of themes) {
    for (const width of widths) {
      await control({ action: 'scenario', name: SCENARIO });
      await withPage(theme, width, (page) => walk(page, `${theme}-${width}`)).catch((error) => {
        errors.push(`${theme}-${width}: ${error.message.split('\n')[0]}`);
      });
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
