import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { startFixtureServer, FIXTURE_TOKEN } from './fixture-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.tmp', 'fixture-klient-proof', String(Date.now()));
await mkdir(output, { recursive: true });
const fixture = await startFixtureServer({ port: 0, scenario: 'first-open' });
const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
process.env.KIKI_SERVER_URL = endpoint;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/*.test.ts', '**/*.test.tsx'] } } });
await vite.listen();
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const evidence = { mock: true, scenario: 'first-open', endpoint, requests: [], responses: [], errors: [], sockets: [], frames: [], checks: [] };
page.on('pageerror', (error) => evidence.errors.push(error.message));
page.on('request', (request) => { if (request.url().includes('/api/')) evidence.requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
page.on('response', async (response) => {
  if (!response.url().includes('/api/')) return;
  try { const result = await response.json(); evidence.responses.push({ path: new URL(response.url()).pathname, code: result.code, msg: result.code === 0 ? undefined : result.msg }); } catch {}
});
page.on('websocket', (socket) => {
  if (new URL(socket.url()).origin !== endpoint.replace('http:', 'ws:')) return;
  evidence.sockets.push(socket.url());
  socket.on('framereceived', ({ payload }) => {
    try { const frame = JSON.parse(String(payload)); evidence.frames.push({ type: frame.type, id: frame.id, signal: frame.data?.type, generation: frame.data?.generation, event: frame.data?.event?.type, msg: frame.msg }); } catch {}
  });
});
await page.addInitScript(() => localStorage.setItem('kiki.locale', 'zh'));
const checkLayout = async (phase) => {
  const geometry = await page.locator('[data-transcript-scroll]').evaluate(async (scroll) => {
    await document.fonts.ready;
    await Promise.all([...scroll.querySelectorAll('img')].map((image) => image.decode().catch(() => {})));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const viewport = scroll.getBoundingClientRect();
    const rows = [...scroll.querySelectorAll('[data-transcript-virtual-item]')].map((row) => {
      const rect = row.getBoundingClientRect();
      return { index: Number(row.dataset.index), top: rect.top, bottom: rect.bottom, height: rect.height };
    }).sort((a, b) => a.index - b.index);
    const gaps = rows.slice(1).flatMap((row, index) => {
      const previous = rows[index];
      if (row.index !== previous.index + 1 || row.bottom < viewport.top || previous.top > viewport.bottom) return [];
      return [{ from: previous.index, to: row.index, gap: row.top - previous.bottom }];
    });
    return { rows, gaps };
  });
  (evidence.geometry ??= []).push({ phase, ...geometry });
  assert.ok(geometry.gaps.length > 0, `${phase}: adjacent visible rows were measured`);
  for (const gap of geometry.gaps) assert.ok(gap.gap >= 14 && gap.gap <= 18, `${phase}: rows ${gap.from}/${gap.to} gap=${gap.gap}`);
};
try {
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/s/session_fixture_first_open?server=${encodeURIComponent(endpoint)}&token=${FIXTURE_TOKEN}`, { timeout: 120_000 });
  await page.waitForFunction(() => document.querySelector('textarea[data-composer]') && document.body.innerText.includes('先通读最近的任务记录'), { timeout: 30_000 });
  await page.waitForFunction(() => document.body.innerText.includes('ReadMediaFile'), { timeout: 30_000 });
  evidence.checks.push('full application renders existing first-open user message and ReadMediaFile tool');
  await page.getByText('先通读最近的任务记录与交接文档，然后逐项解决下面这些问题。').first().scrollIntoViewIfNeeded();
  await checkLayout('first-open-images-decoded');
  await page.screenshot({ path: join(output, '01-first-open-mock.png'), fullPage: true });
  await page.locator('[data-collapsible-toggle]').first().click();
  await checkLayout('long-message-expanded');
  await page.screenshot({ path: join(output, '01-expanded-mock.png'), fullPage: true });
  await page.locator('[data-collapsible-toggle]').first().click();
  await checkLayout('long-message-collapsed');
  await page.getByRole('button', { name: /步骤.*ReadMediaFile/ }).first().click();
  await page.getByText('ReadMediaFile', { exact: true }).first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, '01-tool-card-mock.png'), fullPage: true });
  const before = evidence.frames.filter((frame) => frame.signal === 'ready').length;
  await fetch(`${endpoint}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'drop_ws' }) });
  await page.waitForFunction(() => document.body.innerText.includes('先通读最近的任务记录') && document.body.innerText.includes('ReadMediaFile'));
  const deadline = Date.now() + 15_000;
  while (evidence.frames.filter((frame) => frame.signal === 'ready').length <= before && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
  assert.ok(evidence.frames.filter((frame) => frame.signal === 'ready').length > before, 'reconnected ordered view reaches ready');
  assert.ok((await page.locator('body').innerText()).includes('ReadMediaFile'));
  evidence.checks.push('shared socket drops, reconnects, reattaches ordered view and retains user/tool content');
  await checkLayout('reconnected');
  await page.screenshot({ path: join(output, '02-reconnected-mock.png'), fullPage: true });
  await page.setViewportSize({ width: 1000, height: 800 });
  await checkLayout('narrow-layout');
  await page.screenshot({ path: join(output, '03-narrow-mock.png'), fullPage: true });
  await page.reload();
  await page.waitForFunction(() => document.body.innerText.includes('先通读最近的任务记录') && document.body.innerText.includes('ReadMediaFile'), { timeout: 30_000 });
  await checkLayout('reloaded-narrow');
  await page.screenshot({ path: join(output, '04-reloaded-mock.png'), fullPage: true });
  assert.ok(evidence.sockets.length >= 2);
  assert.ok(evidence.sockets.every((url) => new URL(url).pathname === '/api/klient/events'));
  assert.deepEqual(evidence.errors, []);
  assert.ok(!evidence.frames.some((frame) => ['error', 'view_error'].includes(frame.type)));
  assert.ok(evidence.responses.some((response) => response.path === '/api/klient/call' && response.code === 0));
} catch (error) {
  evidence.failure = String(error);
  await page.screenshot({ path: join(output, 'failure-mock.png'), fullPage: true });
  throw error;
} finally {
  evidence.inbound = fixture.wsInbound;
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`Fixture-only evidence: ${output}`);
  await browser.close();
  await vite.close();
  await fixture.stop();
}
