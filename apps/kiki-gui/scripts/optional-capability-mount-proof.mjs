import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '../../../../tasks/task-0043/research/visual');
await mkdir(output, { recursive: true });
const vite = await createServer({
  root,
  server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/*.test.ts', '**/*.test.tsx'] } },
});
await vite.listen();
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (error) => { errors.push(error.message); });
const port = vite.httpServer.address().port;
const shot = async (name) => {
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  return `${name}.png`;
};
const row = (marker, id) => page.locator(`[data-mount-session="${marker}"] [data-optional-capability="${id}"]`);
try {
  await page.addInitScript(() => localStorage.setItem('kiki.locale', 'zh'));
  await page.goto(`http://127.0.0.1:${port}/proof/optional-capability-mount.html`, { waitUntil: 'networkidle', timeout: 120_000 });
  await page.locator('[data-mount-session="a"] [data-optional-capability="web"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-rail-plugin-source="home"]').waitFor({ timeout: 15_000 });
  assert.equal(await page.locator('[data-mount-session="a"] [data-optional-capability]').count(), 5);
  assert.equal(await page.locator('[data-mount-session="b"] [data-optional-capability]').count(), 5);
  assert.equal(await page.locator('[data-mount-draft] [data-optional-capabilities]').getAttribute('data-optional-capabilities'), 'draft');
  assert.equal(await page.locator('[data-mount-session="c"]').count(), 0);
  assert.equal(await page.locator('[data-rail-plugin-source="home"]').count(), 1);
  assert.equal(await page.locator('[data-rail-plugin-source="session"]').count(), 1);
  await page.locator('[data-rail-mcp-server="files"]').first().waitFor();
  const initial = await shot('01-rail-two-sessions-draft');
  assert.equal(await row('a', 'browser').getAttribute('data-optional-effective'), 'false');
  assert.equal(await row('a', 'computer').getAttribute('data-optional-effective'), 'false');
  assert.equal(await row('a', 'memory').getAttribute('data-optional-effective'), 'true');
  assert.equal(await row('a', 'thread').getAttribute('data-optional-effective'), 'true');
  assert.equal(await row('a', 'web').getAttribute('data-optional-effective'), 'true');
  await row('a', 'web').locator('[data-optional-set="off"]').click();
  await page.waitForFunction(() => document.querySelector('[data-mount-session="a"] [data-optional-capability="web"]')?.getAttribute('data-optional-effective') === 'false');
  assert.equal(await row('b', 'web').getAttribute('data-optional-effective'), 'true');
  assert.equal(await page.locator('[data-submitted-prompt="kept"]').innerText(), '已提交的提示仍在这条会话里。');
  const switched = await shot('02-session-a-web-off-b-unchanged');
  await page.locator('[data-mount-draft] [data-optional-capability="browser"] [data-optional-set="on"]').click();
  await page.locator('[data-mount-draft] [data-rail-mcp-server="files"] [data-rail-mcp-set="off"]').click();
  await page.waitForFunction(() => document.querySelector('[data-mount-draft] [data-optional-capability="browser"]')?.getAttribute('data-optional-choice') === 'on');
  assert.equal(await page.locator('[data-mount-session="c"]').count(), 0);
  assert.equal(await row('a', 'browser').getAttribute('data-optional-choice'), 'inherit');
  const draft = await shot('03-new-before-send');
  await page.locator('[data-mount-apply]').click();
  await page.locator('[data-mount-session="c"] [data-optional-capability="browser"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-mount-session="c"] [data-optional-capability="browser"]')?.getAttribute('data-optional-choice') === 'on');
  assert.equal(await page.locator('[data-mount-session="c"] [data-rail-mcp-server="files"]').getAttribute('data-rail-mcp-source'), 'session');
  assert.equal(await page.locator('[data-mount-session="c"] [data-rail-mcp-server="files"]').getAttribute('data-rail-mcp-effective'), 'false');
  assert.equal(await row('a', 'web').getAttribute('data-optional-effective'), 'false');
  assert.equal(await page.locator('[data-submitted-prompt="kept"]').count(), 1);
  const created = await shot('04-new-applied-and-effective');
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'manifest.json'), JSON.stringify({
    url: `http://127.0.0.1:${port}/proof/optional-capability-mount.html`,
    screenshots: [initial, switched, draft, created],
    checks: [
      'five capability rows on two live sessions',
      'session A web off leaves session B effective',
      'submitted prompt marker stays while effective flips',
      'draft thread and MCP choices exist before a session',
      'apply writes only the new session',
      'plugin source chips show home and session',
      'MCP rail shows session source and effective false',
    ],
  }, null, 2));
} finally {
  await browser.close();
  await vite.close();
}
