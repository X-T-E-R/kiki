/**
 * Long-answer proof for the message view: one persona conversation whose
 * replies are ~20 000 characters, served through the production bounded-content
 * functions, walked at desktop and mobile widths.
 *
 * It answers one question with numbers on both ends of the chain:
 *
 *   model text (fixture) → API body this client receives → DOM text a reader
 *   can see, before and after switching views and after a cold reload.
 *
 *   KIKI_PROOF_OUTPUT_DIR=<dir> node scripts/visual-proof-message-long-answer.mjs
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
import { BODIES, TAIL } from '../fixtures/message-long-answer.scenario.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.KIKI_PROOF_OUTPUT_DIR ?? join(root, '.tmp', 'message-long-answer');
await mkdir(output, { recursive: true });
const SESSION = 'session_fixture_message_long';
const STEP_TIMEOUT = 30_000;

const fixture = await startFixtureServer({ port: 0, scenario: 'message-long-answer' });
const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
process.env.KIKI_SERVER_URL = endpoint;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/*.test.ts', '**/*.test.tsx'] } } });
await vite.listen();
const web = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ args: ['--no-proxy-server'] });

const url = (path) => `${web}${path}?server=${encodeURIComponent(endpoint)}&token=${FIXTURE_TOKEN}`;
const report = { canonical: {}, api: {}, dom: {}, copied: {}, errors: [] };
const errors = report.errors;

function check(condition, message) {
  if (!condition) errors.push(message);
}

/** The API body this client is served: the same call the timeline makes. */
async function apiTranscript() {
  const response = await fetch(`${endpoint}/api/klient/session-view/${SESSION}/transcript?agent_id=main&transcript_coverage_version=2`, {
    headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
  });
  const envelope = await response.json();
  if (envelope.code !== 0) throw new Error(`transcript read failed: ${envelope.msg}`);
  return envelope.data;
}

/** One bounded field, as the API served it: preview length, refs, and the rest by segment read. */
async function readField(data, frameId) {
  const frames = data.items
    .filter((item) => item.kind === 'turn')
    .flatMap((item) => item.steps.flatMap((step) => step.frames))
    .filter((frame) => frame.frameId === frameId);
  if (frames.length !== 1) throw new Error(`expected one ${frameId} frame, saw ${frames.length}`);
  const frame = frames[0];
  const field = frame.kind === 'tool' ? frame.input?.text : frame.text;
  const ref = (frame.contentRefs ?? []).find((entry) => entry.kind === 'text');
  let rest = '';
  if (ref !== undefined) {
    const response = await fetch(`${endpoint}/api/klient/session-view/${SESSION}/transcript/content`, {
      method: 'POST',
      headers: { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'main', ref }),
    });
    const envelope = await response.json();
    if (envelope.code !== 0) throw new Error(`content read failed: ${envelope.msg}`);
    rest = String(envelope.data.value ?? '');
  }
  return { preview: typeof field === 'string' ? field : '', refs: (frame.contentRefs ?? []).map((entry) => ({ path: entry.path, offset: entry.offset, total: entry.total })), rest };
}

async function rowText(page, origin) {
  return page.evaluate((wanted) => {
    const row = document.querySelector(`[data-message-origin="${wanted}"] [data-message-text]`);
    return row === null ? null : (row.textContent ?? '');
  }, origin);
}

/**
 * Wait until the row's own text carries the tail. A row that never reads the
 * rest is exactly the defect under test, so a timeout is not thrown: the
 * length and tail checks below name what is missing.
 */
async function waitForTail(page, tail, origin) {
  await page.waitForFunction(({ wanted, marker }) => {
    const row = document.querySelector(`[data-message-origin="${wanted}"] [data-message-text]`);
    return row !== null && (row.textContent ?? '').includes(marker);
  }, { wanted: origin, marker: tail }, { timeout: STEP_TIMEOUT }).catch(() => undefined);
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

async function open(page) {
  await page.goto(url(`/s/${SESSION}`), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-transcript-scroll]', { timeout: STEP_TIMEOUT });
}

async function readBothRows(page, label) {
  const reply = await rowText(page, 'ordinary_final');
  const message = await rowText(page, 'send_message');
  report.dom[label] = {
    reply: reply === null ? null : { chars: reply.length, tail: reply.includes(TAIL.reply) },
    message: message === null ? null : { chars: message.length, tail: message.includes(TAIL.message) },
  };
  return { reply, message };
}

const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
page.on('pageerror', (error) => { errors.push(`pageerror: ${error.message}`); });
await page.addInitScript(() => {
  localStorage.setItem('kiki.locale', 'zh');
  localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'light' }));
  const writes = [];
  Object.defineProperty(window, '__copied', { value: writes });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { writes.push(text); } } });
});

try {
  report.canonical = { reply: BODIES.reply.length, message: BODIES.message.length };

  const data = await apiTranscript();
  const replyField = await readField(data, 't1-reply');
  const messageField = await readField(data, 't2-send');
  report.api = {
    reply: { preview: replyField.preview.length, refs: replyField.refs, rest: replyField.rest.length, restHasTail: replyField.rest.includes(TAIL.reply) },
    message: { preview: messageField.preview.length, refs: messageField.refs, rest: messageField.rest.length, restHasTail: messageField.rest.includes(TAIL.message) },
  };
  // The window carries a preview and the offsets of the rest — nothing is lost
  // at the wire, and the remainder is one segment read away.
  check(report.api.reply.preview > 0 && report.api.reply.preview < BODIES.reply.length, 'api reply preview is not a cut of the whole reply');
  check(report.api.reply.restHasTail, 'api reply segment does not carry the reply tail');
  check(report.api.message.preview > 0 && report.api.message.preview < BODIES.message.length, 'api message preview is not a cut of the whole message');
  check(report.api.message.restHasTail, 'api message segment does not carry the message tail');

  await open(page);
  await page.waitForSelector('[data-message-view-row="message"]', { timeout: STEP_TIMEOUT });
  await waitForTail(page, TAIL.reply, 'ordinary_final');
  await waitForTail(page, TAIL.message, 'send_message');
  const first = await readBothRows(page, 'message-first-open');
  check(first.reply?.trimEnd().endsWith(TAIL.reply), 'message view reply does not end on the model tail');
  check(first.message?.trimEnd().endsWith(TAIL.message), 'message view message does not end on the model tail');
  check((first.reply?.length ?? 0) >= BODIES.reply.length * 0.95, `message view reply is short: ${first.reply?.length}`);
  check((first.message?.length ?? 0) >= BODIES.message.length * 0.95, `message view message is short: ${first.message?.length}`);
  await shot(page, '01-message-view-1440');

  // The reply row's own progress line must be gone once the text is whole.
  check(await page.locator('[data-message-origin="ordinary_final"] [data-content-continuation]').count() === 0, 'the reply row still offers a continuation after reading it whole');
  check(await page.locator('[data-message-origin="send_message"] [data-content-continuation]').count() === 0, 'the message row still offers a continuation after reading it whole');

  await page.evaluate(() => {
    const row = document.querySelector('[data-message-origin="ordinary_final"] [data-message-text]');
    row?.scrollIntoView({ block: 'end' });
  });
  await shot(page, '02-message-tail-1440');

  // 消息 → 过程 → 消息: the same text on every visit, nothing re-cut.
  await page.locator('[data-timeline-view-option="process"]').click();
  await page.waitForSelector('[data-assistant-prose]', { timeout: STEP_TIMEOUT });
  await page.waitForFunction((marker) => [...document.querySelectorAll('[data-assistant-prose]')].some((node) => (node.textContent ?? '').includes(marker)), TAIL.reply, { timeout: STEP_TIMEOUT }).catch(() => undefined);
  const processText = await page.evaluate((marker) => {
    const prose = [...document.querySelectorAll('[data-assistant-prose]')].find((node) => (node.textContent ?? '').includes(marker));
    return prose === null || prose === undefined ? null : (prose.textContent ?? '');
  }, TAIL.reply);
  report.dom['process-view'] = { reply: processText === null ? null : { chars: processText.length, tail: processText.includes(TAIL.reply) } };
  check((processText?.length ?? 0) >= BODIES.reply.length * 0.95, `process view reply is short: ${processText?.length}`);
  await page.evaluate((marker) => {
    const prose = [...document.querySelectorAll('[data-assistant-prose]')].find((node) => (node.textContent ?? '').includes(marker));
    prose?.scrollIntoView({ block: 'end' });
  }, TAIL.reply);
  await shot(page, '03-process-view-1440');

  // Copy reads the same body the reader sees.
  await page.evaluate((marker) => {
    const prose = [...document.querySelectorAll('[data-assistant-prose]')].find((node) => (node.textContent ?? '').includes(marker));
    const row = prose?.closest('[data-transcript-virtual-item]') ?? prose?.closest('[data-block-id]') ?? prose;
    const button = row?.querySelector('[data-row-action="copy"]');
    button?.click();
  }, TAIL.reply);
  await page.waitForTimeout(300);
  const copied = await page.evaluate(() => window.__copied);
  report.copied = { chars: copied[0]?.length ?? 0, tail: (copied[0] ?? '').includes(TAIL.reply) };
  check(report.copied.tail, 'copy of the long reply does not carry its tail');

  // Back to the message view: the same rows, still whole.
  await page.locator('[data-timeline-view-option="message"]').click();
  await page.waitForSelector('[data-message-view-row="message"]', { timeout: STEP_TIMEOUT });
  await waitForTail(page, TAIL.reply, 'ordinary_final');
  await waitForTail(page, TAIL.message, 'send_message');
  const back = await readBothRows(page, 'message-after-switch');
  check(back.reply?.trimEnd().endsWith(TAIL.reply), 'reply tail is missing after switching back');
  check(back.message?.trimEnd().endsWith(TAIL.message), 'message tail is missing after switching back');
  check(back.reply?.length === first.reply?.length, `reply length changed across the switch: ${first.reply?.length} → ${back.reply?.length}`);
  check(back.message?.length === first.message?.length, `message length changed across the switch: ${first.message?.length} → ${back.message?.length}`);

  // Cold read: a reload rebuilds the page from the wire preview and must end up whole again.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-transcript-scroll]', { timeout: STEP_TIMEOUT });
  await waitForTail(page, TAIL.reply, 'ordinary_final');
  await waitForTail(page, TAIL.message, 'send_message');
  const cold = await readBothRows(page, 'message-cold-reload');
  check(cold.reply?.trimEnd().endsWith(TAIL.reply), 'reply tail is missing after a cold reload');
  check(cold.message?.trimEnd().endsWith(TAIL.message), 'message tail is missing after a cold reload');
  await shot(page, '04-message-view-1440-after-reload');

  // 390: the same rows, one column.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const narrow = await readBothRows(page, 'message-narrow-390');
  check(narrow.reply?.trimEnd().endsWith(TAIL.reply), 'reply tail is missing at 390');
  check(narrow.message?.trimEnd().endsWith(TAIL.message), 'message tail is missing at 390');
  await shot(page, '05-message-view-390');
} catch (error) {
  errors.push(`walk: ${error.message.split('\n')[0]}`);
} finally {
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  await vite.close();
  await fixture.stop();
}

console.log(JSON.stringify(report, null, 2));
console.log(`[message-long-answer] ${output}`);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
