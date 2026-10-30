import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { chromium } from 'playwright';
import { startFixtureServer, FIXTURE_TOKEN } from './fixture-server.mjs';
import { HISTORY_PAGING_SESSION as sessionId, HISTORY_PAGING_TURNS as turns } from '../fixtures/history-paging.scenario.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.KIKI_HISTORY_PAGING_OUTPUT ?? join(root, '.tmp/history-paging', String(Date.now())));
await mkdir(output, { recursive: true });
const fixture = await startFixtureServer({ port: 0, scenario: 'history-paging' });
const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
process.env.KIKI_SERVER_URL = endpoint;
const dist = resolve(process.env.KIKI_HISTORY_PAGING_DIST ?? join(output, 'dist'));
if (!process.env.KIKI_HISTORY_PAGING_DIST) await build({ root, build: { outDir: dist, emptyOutDir: true }, logLevel: 'warn' });
const vite = await preview({ root, build: { outDir: dist }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' });
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const evidence = { scenario: 'history-paging', turns, requests: [], pages: [], errors: [], checks: [], screenshots: [] };
page.on('pageerror', error => evidence.errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') (evidence.consoleErrors ??= []).push(message.text()); });
page.on('requestfailed', request => { (evidence.failedRequests ??= []).push({ url: request.url(), failure: request.failure() }); });
page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
  try { const frame = JSON.parse(String(payload)); if (frame.type === 'view_error' || frame.type === 'error') (evidence.socketErrors ??= []).push(frame); } catch {}
}));
await page.addInitScript(() => localStorage.setItem('kiki.locale', 'en'));
let releaseSlow;
const slow = new Promise(resolve => { releaseSlow = resolve; });
let releaseFailure;
const failure = new Promise(resolve => { releaseFailure = resolve; });
const canonical = fixture.transcriptSource(fixture.sessions.get(sessionId), 'main').items;
const expected = canonical.filter(item => item.kind === 'turn').map(item => item.turnId);
const transcript = fixture.sessions.get(sessionId).transcript;
const resetEvent = transcript.resetEvent.bind(transcript);
transcript.resetEvent = (agentId, grade) => {
  const event = resetEvent(agentId, grade);
  if (agentId !== 'main') return event;
  const items = event.snapshot.items.slice(-20);
  return { ...event, snapshot: { ...event.snapshot, items, hasMoreOlder: true, olderCursor: `turn:${items[0].turnId}` },
    coverage: { kind: 'tail', hasMoreOlder: true }, has_more_older: true };
};
let attempt = 0;
const failedAt = new Map();
await page.route('**/api/klient/session-view/*/transcript?*', async route => {
  const url = new URL(route.request().url());
  const input = url.searchParams.get('before_item') ?? url.searchParams.get('before_turn');
  const number = ++attempt;
  evidence.requests.push({ attempt: number, cursor: input });
  if (number === 1) await slow;
  if (number === 2) {
    await failure;
    failedAt.set('network', input);
    return route.fulfill({ json: { code: 50001, msg: 'Injected temporary history failure', data: null, request_id: 'history-failure' } });
  }
  if (number === 4) {
    return route.fulfill({ json: { code: 0, msg: 'success', request_id: 'history-partial', data: {
      session_id: sessionId, agent_id: 'main', items: [], has_more: true, next_cursor: url.searchParams.get('before_item') ?? undefined,
      tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {}, agents: [], pending_interactions: [],
      transcript_coverage_version: 2, coverage: { kind: 'unknown', hasMoreOlder: true }, read: { source: 'cold', readiness: 'partial', reason: 'budget' },
    } } });
  }
  if (number === 6) {
    failedAt.set('timeout', input);
    await new Promise(resolve => setTimeout(resolve, 11_000));
    try { await route.abort('timedout'); } catch {}
    return;
  }
  const started = performance.now();
  const response = await route.fetch();
  const body = await response.json();
  assert.equal(body.code, 0);
  evidence.pages.push({ attempt: number, cursor: input, ms: performance.now() - started,
    items: body.data.items.map(item => item.kind === 'turn' ? item.turnId : `${item.kind}:${item.markerId ?? item.refId}`), hasMore: body.data.has_more });
  await route.fulfill({ response });
});
const shot = async name => {
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  evidence.screenshots.push(`${name}.png`);
};
const top = async () => {
  const scroll = page.locator('[data-transcript-scroll]').first();
  const before = attempt;
  for (let gesture = 0; gesture < 12; gesture++) {
    await scroll.evaluate(async element => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await scroll.hover();
    await page.mouse.wheel(0, -720);
    await scroll.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (attempt > before || await page.locator('[data-top-edge="beginning"], [data-top-edge="error"]').count()) return;
  }
  assert.fail('continued upward gestures did not request an earlier page');
};
try {
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/s/${sessionId}?server=${encodeURIComponent(endpoint)}&token=${FIXTURE_TOKEN}`, { timeout: 120_000 });
  await page.locator('[data-block-id]').first().waitFor({ timeout: 30_000 });
  await top();
  await page.locator('[data-top-edge="loading"]').waitFor();
  await shot('01-loading');
  releaseSlow();
  await page.locator('[data-top-edge="loading"]').waitFor({ state: 'detached' });
  await top();
  releaseFailure();
  await page.locator('[data-top-edge="error"]').waitFor();
  await shot('02-error-retry');
  await page.locator('[data-top-edge="error"] button').click();
  await page.locator('[data-top-edge="error"]').waitFor({ state: 'detached' });
  assert.equal(evidence.requests[2].cursor, failedAt.get('network'));
  evidence.checks.push('slow loading stays visible; a failed page retries the same continuation');
  for (let demand = 0; demand < turns; demand++) {
    if (await page.locator('[data-top-edge="beginning"]').count()) break;
    const before = attempt;
    await top();
    await page.waitForFunction(() => document.querySelector('[data-top-edge="loading"]') === null, undefined, { timeout: 15_000 });
    if (await page.locator('[data-top-edge="error"]').count()) {
      assert.match(await page.locator('[data-top-edge="error"]').innerText(), /timed out/);
      await shot('03-timeout-retry');
      await page.locator('[data-top-edge="error"] button').click();
      await page.waitForFunction(() => document.querySelector('[data-top-edge="loading"]') === null, undefined, { timeout: 15_000 });
      assert.equal(evidence.requests.find(request => request.attempt === 7)?.cursor, failedAt.get('timeout'));
    }
    if (attempt === before) await page.locator('[data-transcript-scroll]').first().press('Home');
  }
  await top();
  await page.locator('[data-top-edge="beginning"]').waitFor({ timeout: 15_000 });
  await page.getByText('Record 0000:', { exact: false }).waitFor();
  await shot('04-beginning');
  const delivered = evidence.pages.toReversed().flatMap(result => result.items);
  const initial = expected.slice(-20);
  assert.deepEqual([...delivered, ...initial], expected, 'every turn arrives exactly once in chronological order');
  assert.equal(new Set([...delivered, ...initial]).size, turns);
  evidence.checks.push('1200 turns reached the beginning through partial, failed and timed-out pages without gaps, duplicates or reordering');
  const rendered = await page.locator('[data-transcript-scroll]').first().evaluate(async scroll => {
    const records = new Map();
    const order = [];
    const collect = () => {
      const rows = [...scroll.querySelectorAll('[data-block-id]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      for (const row of rows) {
        const match = /^Record (\d{4}):/.exec(row.querySelector('[data-source-block-id]')?.textContent.trim() ?? '');
        if (!match) continue;
        const number = Number(match[1]);
        const ids = records.get(number) ?? new Set();
        if (!records.has(number)) order.push(number);
        ids.add(row.dataset.blockId);
        records.set(number, ids);
      }
    };
    scroll.scrollTop = 0;
    for (let frame = 0; frame < 5000; frame++) {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      collect();
      if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2) break;
      scroll.scrollTop += Math.max(100, scroll.clientHeight * 0.7);
    }
    return { records: [...records].map(([number, ids]) => [number, [...ids]]), order };
  });
  evidence.rendered = rendered;
  assert.deepEqual(rendered.order, Array.from({ length: turns }, (_, index) => index), 'all loaded user records render in order');
  for (const [number, ids] of rendered.records) assert.equal(ids.length, 1, `Record ${number} has one logical row`);
  evidence.checks.push('real virtualized GUI renders every record once and in order while walking from the beginning back to the latest');
  assert.deepEqual(evidence.errors, []);
} catch (error) {
  evidence.failure = String(error);
  await shot('failure');
  throw error;
} finally {
  releaseSlow();
  releaseFailure();
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`History paging GUI evidence: ${output}`);
  await browser.close();
  await new Promise(resolve => vite.httpServer.close(resolve));
  await fixture.stop();
}
