/**
 * Visual proof for the persona GUI (fixture `personas`): the /personas roster
 * and editor, the avatar crop dialog, the CCv3 import preview, the /new composer persona pick, a
 * persona-bound session header, and the memory page's persona group — at 1440
 * and 390, light and dark.
 *
 *   node scripts/visual-proof-personas.mjs [--only=page,avatar,import,new,header,memory]
 *
 * Screenshots land in .tmp/persona-proof/<stamp>/ as `<surface>-<theme>-<width>.png`.
 * Mock-only: the fixture server stands in for kap-server.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.tmp', 'persona-proof', String(Date.now()));
await mkdir(output, { recursive: true });
const only = new Set((process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) ?? 'page,avatar,import,new,header,memory').split(','));

const fixture = await startFixtureServer({ port: 0, scenario: 'personas' });
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
  await page.waitForTimeout(150);
}

async function shot(page, name) {
  await settle(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) errors.push(`${name}: horizontal overflow ${overflow}px`);
  const file = join(output, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

const walkers = {
  async page(page, tag, width) {
    await page.goto(url('/personas'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-persona-row="lin-lan"]', { timeout: 30_000 });
    await shot(page, `personas-list-${tag}`);
    await page.locator('[data-persona-row="lin-lan"]').click();
    await page.waitForSelector('[data-persona-editor="lin-lan"] [data-persona-field="description"]', { timeout: 10_000 });
    await page.waitForSelector('[data-persona-editor="lin-lan"] [data-persona-avatar-kind="image"]', { timeout: 10_000 });
    await shot(page, `personas-editor-${tag}`);
    if (width < 600) {
      await page.locator('[data-persona-field="description"]').scrollIntoViewIfNeeded();
      await shot(page, `personas-editor-lower-${tag}`);
    }
    // Validation + dirty bar: clear the name, try to save.
    await page.locator('[data-persona-field="name"]').fill('');
    await page.locator('[data-persona-editor] button[type="button"]:has-text("保存")').first().click().catch(() => {});
    await page.locator('[data-persona-editor] form, [data-persona-editor]').first().evaluate((form) => { form.requestSubmit?.(); });
    await page.waitForSelector('[data-field-issue]', { timeout: 5_000 });
    await shot(page, `personas-editor-invalid-${tag}`);
    await page.locator('[data-settings-discard]').click();
    await page.locator('[data-persona-actions]').click();
    await page.waitForSelector('[data-persona-actions-menu]');
    await shot(page, `personas-menu-${tag}`);
    await page.keyboard.press('Escape');
    // Archived rows only on request.
    await page.goto(url('/personas'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-persona-row="lin-lan"]');
    await page.getByText('显示已归档').click();
    await page.waitForSelector('[data-persona-row="standup-bot"]');
    await page.locator('[data-persona-row="a-che"]').click();
    await page.waitForSelector('[data-persona-editor="a-che"]');
    await shot(page, `personas-initial-${tag}`);
    // New persona draft.
    await page.locator('[data-persona-new]').click();
    await page.waitForSelector('[data-persona-editor="new"]');
    await page.locator('[data-persona-field="name"]').fill('Orin Hale');
    await shot(page, `personas-new-${tag}`);
  },
  async avatar(page, tag) {
    // Crop dialog: open a landscape picture, frame it square, then circle
    // zoomed in; save; the editor wears it round; remove goes back to the initial.
    await page.goto(url('/personas'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-persona-row="a-che"]', { timeout: 30_000 });
    await page.locator('[data-persona-row="a-che"]').click();
    await page.waitForSelector('[data-persona-editor="a-che"] [data-persona-avatar-upload]');
    await page.locator('[data-persona-editor="a-che"] input[type="file"][accept*="image/png"]').setInputFiles(join(root, 'fixtures', 'persona-media', 'landscape.jpg'));
    await page.waitForSelector('[data-persona-avatar-crop="ready"]');
    await shot(page, `avatar-crop-square-${tag}`);
    await page.locator('[data-persona-avatar-shape="circle"]').click();
    await page.locator('[data-persona-avatar-zoom]').fill('1.8');
    await page.locator('[data-persona-avatar-frame]').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    await shot(page, `avatar-crop-circle-${tag}`);
    await page.locator('[data-persona-avatar-save]').click();
    await page.waitForSelector('[data-persona-editor="a-che"] [data-persona-avatar-shape="circle"][data-persona-avatar-kind="image"]', { timeout: 10_000 });
    await shot(page, `avatar-saved-${tag}`);
    await page.locator('[data-persona-avatar-remove]').click();
    await shot(page, `avatar-remove-confirm-${tag}`);
    await page.locator('[role="alertdialog"] button:has-text("移除头像"), [role="dialog"] button:has-text("移除头像")').last().click();
    await page.waitForSelector('[data-persona-editor="a-che"] [data-persona-avatar-kind="initial"]', { timeout: 10_000 });
  },
  async import(page, tag) {
    await page.goto(url('/personas'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-persona-row="lin-lan"]', { timeout: 30_000 });
    await page.locator('[data-persona-import]').click();
    await page.waitForSelector('[data-persona-import-dialog="pick"]');
    await shot(page, `import-pick-${tag}`);
    await page.locator('input[type="file"][accept*="charx"]').setInputFiles({ name: 'mira.png', mimeType: 'image/png', buffer: Buffer.from('fixture-card') });
    await page.waitForSelector('[data-persona-import-preview]');
    await shot(page, `import-preview-${tag}`);
    await page.locator('[data-persona-import-block="examples"]').scrollIntoViewIfNeeded();
    await shot(page, `import-preview-lower-${tag}`);
  },
  async new(page, tag) {
    // Record what the GUI sends: the create body must carry the persona, and
    // the first prompt (answering the greeting) the greeting-reply bit.
    const posts = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().startsWith(endpoint)) posts.push(request.postData() ?? '');
    });
    await page.goto(url('/new'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#composer-agent-profile-select', { timeout: 30_000 });
    await page.locator('#composer-agent-profile-select').click();
    await page.waitForSelector('[data-option-value="persona:lin-lan"]');
    await shot(page, `new-picker-${tag}`);
    await page.locator('[data-option-value="persona:lin-lan"]').click();
    await page.waitForSelector('[data-composer-persona-chip="lin-lan"]', { timeout: 10_000 });
    await page.waitForSelector('[data-hero-persona-greeting="lin-lan"]', { timeout: 10_000 });
    await shot(page, `new-picked-${tag}`);
    await page.fill('textarea[data-composer]', '这周发 0.9，先看发布清单。');
    await page.press('textarea[data-composer]', 'Control+Enter');
    await page.waitForURL(/\/s\/session_/, { timeout: 15_000 });
    await page.waitForSelector('[data-session-persona="lin-lan"]', { timeout: 15_000 });
    await page.waitForTimeout(800);
    const create = posts.find((body) => body.includes('"agent_config"'));
    if (create === undefined || !create.includes('"persona"') || !create.includes('lin-lan')) errors.push(`${tag}: create body lacks persona: ${create}`);
    if (!posts.some((body) => body.includes('persona_greeting_reply') || body.includes('personaGreetingReply'))) errors.push(`${tag}: first prompt lacks greeting-reply bit: ${posts.join(' | ').slice(0, 600)}`);
    await shot(page, `new-sent-${tag}`);
  },
  async header(page, tag) {
    await page.goto(url('/s/session_fixture_persona'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-session-persona="lin-lan"] [data-persona-avatar-kind="image"]', { timeout: 30_000 });
    await shot(page, `header-${tag}`);
  },
  async memory(page, tag) {
    await page.goto(url('/memory?persona=lin-lan'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-memory-persona="lin-lan"][aria-pressed="true"]', { timeout: 30_000 });
    await shot(page, `memory-persona-${tag}`);
    await page.goto(url('/memory?persona=lin-lan&workspace=wd_fixture_000000000000'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-memory-persona="lin-lan"][aria-pressed="true"]', { timeout: 30_000 });
    await shot(page, `memory-persona-workspace-${tag}`);
  },
};

try {
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 390]) {
      for (const [name, walk] of Object.entries(walkers)) {
        if (!only.has(name)) continue;
        await control({ action: 'scenario', name: 'personas' });
        await withPage(theme, width, (page) => walk(page, `${theme}-${width}`, width));
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
