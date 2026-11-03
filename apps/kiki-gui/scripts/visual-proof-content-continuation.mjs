import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_ID = 'session_fixture_content_bounded';

async function reveal(page, selector) {
  for (let round = 0; round < 5; round += 1) {
    if (await page.locator(selector).count() > 0) return;
    const folded = page.locator('[data-history-fold] button[aria-expanded="false"], [data-read-run] button[aria-expanded="false"]');
    const count = await folded.count();
    for (let index = 0; index < count; index += 1) await folded.nth(index).click();
    if (count === 0) break;
  }
  await page.locator(selector).waitFor();
}

async function walk({ page, shot, link, out, errors }) {
  const calls = [];
  let releaseOld;
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  let failTask = true;
  let failUser = true;
  await page.route('**/transcript/content', async route => {
    const input = route.request().postDataJSON();
    const { ref } = input;
    calls.push({ source: ref.source, path: ref.path, offset: ref.offset, total: ref.total });
    if (ref.source.kind === 'task' && failTask) {
      failTask = false;
      return route.fulfill({ json: { code: 50001, msg: 'Fixture segment failure', data: null } });
    }
    if (ref.source.kind === 'turn' && ref.source.id === '1' && ref.path[0] === 'prompt') {
      if (failUser) { failUser = false; return route.fulfill({ json: { code: 50001, msg: 'Fixture user read failure', data: null } }); }
      return route.fulfill({ json: { code: 0, msg: 'ok', data: { ref, value: ref.offset === 3 ? 'def' : 'ghi', next: ref.offset === 3 ? { ...ref, offset: 6 } : undefined, contentRefs: [] } } });
    }
    const response = await route.fetch();
    const body = await response.json();
    if (typeof body.data?.value === 'string' && body.data.value.length > 2048) {
      body.data.value = body.data.value.slice(0, 2048);
      body.data.next = { ...ref, offset: ref.offset + body.data.value.length };
    }
    if (ref.source.id === 'tool-read-big' && calls.filter(call => call.source.id === ref.source.id).length === 1) await oldResponse;
    await route.fulfill({ json: body }).catch(() => undefined);
  });
  await page.goto(link(`/s/${SESSION_ID}`), { waitUntil: 'domcontentloaded' });
  await page.locator('[data-transcript-scroll]').waitFor();
  await page.waitForFunction(() => document.querySelector('h1 [data-session-title]')?.textContent?.length === 1400);
  assert.equal(calls.filter(call => call.source.kind === 'frame' || call.source.kind === 'task').length, 0);
  const userError = page.locator('[data-content-continuation="error"]:has([data-user-ellipsis])');
  await userError.waitFor();
  await shot('content-user-real-failure');
  await userError.locator('[data-content-continuation-action]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-collapsible-content]')].some(node => node.textContent === 'abcdefghi'));
  assert.equal(calls.filter(call => call.source.kind === 'turn' && call.source.id === '1').length, 3);
  assert.equal(await page.locator('[data-user-ellipsis]').count(), 0);
  await shot('content-user-retry-auto-complete');
  await reveal(page, '[data-tool-id="read-big"]');
  const tool = page.locator('[data-tool-id="read-big"]');
  await tool.locator('button[aria-expanded]').first().click();
  await page.waitForFunction(() => document.querySelector('[data-tool-id="read-big"] [data-content-continuation="loading"]') !== null);
  await tool.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const scroll = document.querySelector('[data-transcript-scroll]');
    const row = document.querySelector('[data-tool-id="read-big"]');
    scroll.scrollTop += row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 100;
    scroll.dispatchEvent(new Event('scroll'));
    window.__continuationClicks = 0;
    document.addEventListener('click', event => { if (event.target.closest('[data-content-continuation-action]')) window.__continuationClicks += 1; });
  });
  const anchor = () => page.evaluate(() => document.querySelector('[data-tool-id="read-big"] button[aria-expanded]').getBoundingClientRect().top);
  const before = await anchor();
  await shot('content-tail-reading');
  releaseOld();
  await page.waitForFunction(() => document.querySelector('[data-tool-id="read-big"] [data-content-continuation]') === null, undefined, { timeout: 20_000 });
  const after = await anchor();
  assert.ok(Math.abs(after - before) <= 2, `reading anchor moved ${after - before}px`);
  assert.equal(await page.evaluate(() => window.__continuationClicks), 0);
  await tool.locator('[data-virtual-tool-text]').evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
  await page.waitForFunction(() => document.querySelector('[data-tool-id="read-big"] [data-virtual-tool-text]')?.textContent.includes('[line 00500]'));
  const text = await tool.locator('[data-virtual-tool-text]').textContent();
  const outputCalls = calls.filter(call => call.source.id === 'tool-read-big');
  assert.ok(outputCalls.length > 3);
  assert.equal(new Set(outputCalls.map(call => call.offset)).size, outputCalls.length);
  await shot('content-tail-auto-complete');

  const task = page.locator('[data-shell]').filter({ hasText: 'pnpm build --reporter=verbose' }).first();
  await task.locator('[data-activity-toggle]').click();
  await task.locator('[data-content-continuation="error"]').waitFor();
  await shot('content-tail-real-failure');
  await task.locator('[data-content-continuation-action]').click();
  await task.locator('[data-content-continuation]').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.__continuationClicks), 1);
  assert.ok((await task.locator('pre').last().textContent()).includes('[line 00070]'));
  assert.equal(await page.locator('[data-session-remainder]').count(), 0);
  assert.deepEqual(errors, []);
  await shot('content-tail-retry-complete');
  const report = { outputCalls, taskCalls: calls.filter(call => call.source.kind === 'task'), automaticOutputClicks: 0, failureRetryClicks: 1, anchorBefore: before, anchorAfter: after, anchorDelta: after - before, canonicalOutputChars: outputCalls[0].total, visibleTailChars: text.length, titleChars: 1400, closedBodyReadsBeforeOpen: 0, errors };
  writeFileSync(join(out, 'content-tail-report.json'), JSON.stringify(report, null, 2));
  console.log(`[check] tail auto-complete (${outputCalls.length} bounded requests), retry drains remaining task pages, anchor delta ${after - before}px, closed bodies unread before opening`);
}

export const scenarios = [{ name: 'content-continuation', fixture: 'content-automatic-tail', matrix: ['width'], run: walk }];

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'content-continuation', workers: 1 });
  console.log(`[content-continuation] screenshots: ${result.outputDir}`);
  if (result.failed.length > 0) process.exitCode = 1;
}
