/**
 * Failed-turn proof for the message view: a persona conversation whose first
 * turn failed after writing text, served by the fixture server and walked in
 * the real GUI.
 *
 * What it checks, in the reader's terms:
 *
 *   - the failed turn is not spoken as a reply, and is not read as a cancel or
 *     as "没有回复";
 *   - it still says once, in the message view, that the turn failed, and that
 *     line opens the process holding its partial text;
 *   - the turn after it answers in full.
 *
 *   KIKI_PROOF_OUTPUT_DIR=<dir> node scripts/visual-proof-message-failed.mjs
 *
 * Screenshots and `report.json` land in the output directory. Mock-only: the
 * fixture server stands in for kap-server, and all text is synthetic.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';
import { ANSWER, PARTIAL } from '../fixtures/message-failed-turn.scenario.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.KIKI_PROOF_OUTPUT_DIR ?? join(root, '.tmp', 'message-failed-turn');
await mkdir(output, { recursive: true });
const SESSION = 'session_fixture_message_failed';
const STEP_TIMEOUT = 30_000;

const fixture = await startFixtureServer({ port: 0, scenario: 'message-failed-turn' });
const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
process.env.KIKI_SERVER_URL = endpoint;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/*.test.ts', '**/*.test.tsx'] } } });
await vite.listen();
const web = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ args: ['--no-proxy-server'] });

const url = (path) => `${web}${path}?server=${encodeURIComponent(endpoint)}&token=${FIXTURE_TOKEN}`;
const report = { dom: {}, errors: [] };
const errors = report.errors;

function check(condition, message) {
  if (!condition) errors.push(message);
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  });
  await page.waitForTimeout(200);
}

async function shot(page, name) {
  await settle(page);
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: false });
}

/** Everything the message view says, read as the reader sees it. */
async function readMessageView(page, label) {
  const seen = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('[data-message-text]')].map((node) => node.textContent ?? ''),
    origins: [...document.querySelectorAll('[data-message-origin]')].map((node) => node.getAttribute('data-message-origin')),
    outcomes: [...document.querySelectorAll('[data-message-outcome]')].map((node) => ({
      kind: node.getAttribute('data-message-outcome'),
      text: (node.textContent ?? '').trim(),
    })),
  }));
  report.dom[label] = {
    rows: seen.rows.map((text) => ({ chars: text.length, hasPartial: text.includes(PARTIAL), hasAnswer: text.includes(ANSWER) })),
    origins: seen.origins,
    outcomes: seen.outcomes,
  };
  return seen;
}

async function open(page) {
  await page.goto(url(`/s/${SESSION}`), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-transcript-scroll]', { timeout: STEP_TIMEOUT });
  await page.waitForSelector('[data-message-view-row="message"]', { timeout: STEP_TIMEOUT });
}

const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
page.on('pageerror', (error) => { errors.push(`pageerror: ${error.message}`); });
await page.addInitScript(() => {
  localStorage.setItem('kiki.locale', 'zh');
  localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'light' }));
});

try {
  await open(page);
  const message = await readMessageView(page, 'message-1440');
  // The answer the reader did receive, and only that one.
  check(message.rows.some((text) => text.includes(ANSWER)), 'the completed turn’s answer is missing from the message view');
  check(!message.rows.some((text) => text.includes(PARTIAL)), 'the failed turn’s partial text is spoken as a message');
  check(message.outcomes.filter((outcome) => outcome.kind === 'danger').map((outcome) => outcome.text).join('|') === '轮次失败 · 查看过程',
    `the failed turn has no single failure line: ${JSON.stringify(message.outcomes)}`);
  check(!message.outcomes.some((outcome) => outcome.kind === 'no-reply'), 'the failed turn is read as “没有回复”');
  await shot(page, '01-message-view-1440');

  // The line opens the process that holds the cut-off text.
  await page.locator('[data-message-outcome="danger"] button').click();
  await page.waitForSelector('[data-assistant-prose]', { timeout: STEP_TIMEOUT });
  await page.waitForFunction((marker) => [...document.querySelectorAll('[data-assistant-prose]')].some((node) => (node.textContent ?? '').includes(marker)), PARTIAL, { timeout: STEP_TIMEOUT }).catch(() => undefined);
  const process = await page.evaluate((marker) => {
    const prose = [...document.querySelectorAll('[data-assistant-prose]')].find((node) => (node.textContent ?? '').includes(marker));
    const row = prose?.closest('[data-block-id]') ?? prose?.parentElement ?? null;
    return {
      text: prose === null || prose === undefined ? null : (prose.textContent ?? ''),
      internal: row?.querySelector('[data-assistant-internal]') !== null && row?.querySelector('[data-assistant-internal]') !== undefined,
      answer: [...document.querySelectorAll('[data-assistant-prose]')].some((node) => (node.textContent ?? '').includes('周四冻结')),
    };
  }, PARTIAL);
  report.dom['process-view'] = {
    partial: process.text === null ? null : { chars: process.text.length, internal: process.internal },
    answer: process.answer,
  };
  check(process.text?.includes(PARTIAL) === true, 'the process view lost the failed turn’s text');
  check(process.internal, 'the failed turn’s text is not marked as internal prose in the process view');
  check(process.answer, 'the completed turn’s answer is missing from the process view');
  await shot(page, '02-process-view-1440');

  // Back to the message view: the same one line, still no speech for the failure.
  await page.locator('[data-timeline-view-option="message"]').click();
  await page.waitForSelector('[data-message-view-row="message"]', { timeout: STEP_TIMEOUT });
  const back = await readMessageView(page, 'message-after-switch');
  check(!back.rows.some((text) => text.includes(PARTIAL)), 'the partial text became speech after switching back');
  check(back.outcomes.filter((outcome) => outcome.kind === 'danger').length === 1, 'the failure line is not exactly one after switching back');
  await shot(page, '03-message-view-1440-after-switch');

  // 390: the line still fits one column and still names the failure.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const narrow = await readMessageView(page, 'message-390');
  check(narrow.outcomes.some((outcome) => outcome.kind === 'danger'), 'the failure line is missing at 390');
  check(!narrow.rows.some((text) => text.includes(PARTIAL)), 'the partial text is spoken at 390');
  const clipped = await page.evaluate(() => {
    const row = document.querySelector('[data-message-outcome="danger"]');
    if (row === null) return 'missing';
    const box = row.getBoundingClientRect();
    return box.right <= window.innerWidth + 1 ? 'fits' : `overflows ${Math.round(box.right)} > ${window.innerWidth}`;
  });
  report.dom['message-390'].fit = clipped;
  check(clipped === 'fits', `the failure line does not fit the narrow column: ${clipped}`);
  await page.locator('[data-message-outcome="danger"]').scrollIntoViewIfNeeded();
  await shot(page, '04-message-view-390');
} catch (error) {
  errors.push(`walk: ${error.message.split('\n')[0]}`);
} finally {
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  await vite.close();
  await fixture.stop();
}

console.log(JSON.stringify(report, null, 2));
console.log(`[message-failed-turn] ${output}`);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
