/**
 * Delivery-receipt proof for the message view: one persona conversation whose
 * seven turns carry every `SendMessage` receipt shape, served by the fixture
 * server and walked in the real GUI at desktop and phone widths.
 *
 * What it checks, in the reader's terms:
 *
 *   - a receipt with no `channels` still speaks a long message whole (tail,
 *     length, no leftover continuation);
 *   - media this conversation received is real: the picture decodes, the voice
 *     note plays, the clip shows its poster, and the document downloads;
 *   - a message delivered only to an IM channel is set under its destination
 *     line and is not promoted as this page's speech;
 *   - a partial send names what this conversation and another channel did not
 *     receive, and does not draw that media as delivered;
 *   - an unconfirmed outcome is its own row that opens the process;
 *   - a failed send keeps its reasons beside it, and a send refused for
 *     unsupported media still leads to the process holding the refusal.
 *
 *   KIKI_PROOF_OUTPUT_DIR=<dir> node scripts/visual-proof-message-channels.mjs
 *
 * Screenshots and `report.json` land in the output directory. Mock-only: the
 * fixture server stands in for kap-server; the media are real PNG/WAV/MP4/MD
 * bytes and all text is synthetic.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';
import { LEGACY_BODY, TAIL } from '../fixtures/message-channels.scenario.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.KIKI_PROOF_OUTPUT_DIR ?? join(root, '.tmp', 'message-channels');
await mkdir(output, { recursive: true });
const SESSION = 'session_fixture_message_channels';
const STEP_TIMEOUT = 30_000;

const fixture = await startFixtureServer({ port: 0, scenario: 'message-channels' });
const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
process.env.KIKI_SERVER_URL = endpoint;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/*.test.ts', '**/*.test.tsx'] } } });
await vite.listen();
const web = `http://127.0.0.1:${vite.httpServer.address().port}`;
// The voice note is played without a gesture, so the proof observes a player
// that really advances instead of a policy refusal.
const browser = await chromium.launch({ args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] });

const url = (path) => `${web}${path}?server=${encodeURIComponent(endpoint)}&token=${FIXTURE_TOKEN}`;
const report = { dom: {}, media: {}, errors: [] };
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

/** The message row's own text, as one string. */
async function rowText(page, blockId) {
  return page.locator(`[data-block-id="${blockId}"] [data-message-text]`).first().textContent().catch(() => null);
}

async function noteTexts(page, blockId) {
  return page.locator(`[data-block-id="${blockId}"] [data-message-delivery-note]`).evaluateAll(
    (nodes) => nodes.map((node) => ({ id: node.getAttribute('data-message-delivery-note'), text: (node.textContent ?? '').trim() })),
  ).catch(() => []);
}

const page = await browser.newPage({ viewport: { width: 1440, height: 2400 }, deviceScaleFactor: 1 });
page.on('pageerror', (error) => { errors.push(`pageerror: ${error.message}`); });
await page.addInitScript(() => {
  localStorage.setItem('kiki.locale', 'zh');
  localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'light' }));
  // Use the browser's anchor-download path (the one a browser without the File
  // System Access API takes), so the download is an observable event.
  Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
});

try {
  await page.goto(url(`/s/${SESSION}`), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-transcript-scroll]', { timeout: STEP_TIMEOUT });
  await page.waitForSelector('[data-message-view-row="message"]', { timeout: STEP_TIMEOUT });

  // 1. A receipt that predates channel reporting still speaks its long body whole.
  //    The reader scrolls up to it; its continuation is read on the way in.
  await page.locator('[data-block-id="tool-t1-send"]').scrollIntoViewIfNeeded();
  await page.waitForFunction(({ blockId, marker }) => {
    const node = document.querySelector(`[data-block-id="${blockId}"] [data-message-text]`);
    return node !== null && (node.textContent ?? '').includes(marker);
  }, { blockId: 'tool-t1-send', marker: TAIL }, { timeout: STEP_TIMEOUT }).catch(() => undefined);
  const legacy = await rowText(page, 'tool-t1-send');
  report.dom.legacy = { chars: legacy?.length ?? 0, canonical: LEGACY_BODY.length, tail: legacy?.includes(TAIL) ?? false };
  check(legacy !== null && legacy.trimEnd().endsWith(TAIL), 'the legacy long message does not end on its tail');
  check((legacy?.length ?? 0) >= LEGACY_BODY.length * 0.95, `the legacy long message is short: ${legacy?.length}`);
  check(await page.locator('[data-block-id="tool-t1-send"] [data-content-continuation]').count() === 0, 'the legacy message still offers a continuation after reading it whole');
  check((await noteTexts(page, 'tool-t1-send')).length === 0, 'a legacy receipt shows delivery notes it has no facts for');

  // 2. Media this conversation received: a decoded picture, a playing voice
  //    note, a clip poster and a document that downloads.
  const delivered = '[data-block-id="tool-t2-send"]';
  check(await page.locator(`${delivered} [data-message-delivery-note]`).count() === 0, 'a fully delivered message shows a delivery note');
  const imageReady = await page.locator(`${delivered} [data-message-media="image"] img`).first().evaluate(
    (node) => new Promise((accept) => {
      if (node.complete) { accept({ width: node.naturalWidth, height: node.naturalHeight }); return; }
      node.addEventListener('load', () => accept({ width: node.naturalWidth, height: node.naturalHeight }), { once: true });
      node.addEventListener('error', () => accept({ width: 0, height: 0 }), { once: true });
    }),
  ).catch(() => ({ width: 0, height: 0 }));
  report.media.image = imageReady;
  check(imageReady.width > 0, 'the delivered picture did not decode');

  const poster = await page.locator(`${delivered} [data-message-media="video"] img`).first().evaluate(
    (node) => new Promise((accept) => {
      if (node.complete) { accept({ width: node.naturalWidth }); return; }
      node.addEventListener('load', () => accept({ width: node.naturalWidth }), { once: true });
      node.addEventListener('error', () => accept({ width: 0 }), { once: true });
    }),
  ).catch(() => ({ width: 0 }));
  report.media.poster = poster;
  check(poster.width > 0, 'the delivered clip has no poster frame');

  const voiceCaption = await page.locator(`${delivered} [data-message-media="audio"] span`).last().textContent().catch(() => null);
  const isVoice = await page.locator(`${delivered} [data-message-media="audio"]`).first().evaluate((node) => node.hasAttribute('data-message-voice'));
  report.media.voice = { caption: voiceCaption, intent: isVoice };
  check(isVoice === true, 'the voice note lost its declared intent');
  check((voiceCaption ?? '').includes('语音'), `the voice note is not labelled as a voice note: ${voiceCaption}`);
  const played = await page.locator(`${delivered} [data-message-media="audio"] audio`).first().evaluate(async (element) => {
    try { await element.play(); } catch (error) { return { failed: String(error) }; }
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { currentTime: element.currentTime, duration: element.duration, paused: element.paused };
  }).catch((error) => ({ failed: String(error) }));
  report.media.audio = played;
  check(typeof played.currentTime === 'number' && played.currentTime > 0, `the voice note did not play: ${JSON.stringify(played)}`);

  await page.locator(`${delivered} [data-message-media="file"] [data-message-attachment-open]`).click();
  await page.waitForSelector('[role="dialog"]', { timeout: STEP_TIMEOUT });
  const dialog = page.locator('[role="dialog"]');
  const documentText = await dialog.innerText();
  report.media.document = { preview: documentText.includes('周四冻结') };
  check(documentText.includes('周四冻结'), 'the delivered document has no readable preview');
  const download = page.waitForEvent('download', { timeout: STEP_TIMEOUT });
  await dialog.getByRole('button', { name: '下载' }).click();
  const saved = await download.catch((error) => ({ suggestedFilename: () => String(error) }));
  report.media.download = { name: saved.suggestedFilename() };
  check(saved.suggestedFilename().endsWith('.md'), `the document did not download: ${saved.suggestedFilename()}`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: STEP_TIMEOUT }).catch(() => undefined);

  // 3. Delivered elsewhere: a destination line, the words still readable, and
  //    no promoted reply claiming this page was the audience.
  const elsewhere = '[data-block-id="tool-t3-send"]';
  const elsewhereNotes = await noteTexts(page, 'tool-t3-send');
  report.dom.elsewhere = { notes: elsewhereNotes, text: await rowText(page, 'tool-t3-send') };
  check(elsewhereNotes.some((note) => note.id === 'elsewhere' && note.text.includes('已发送至 im:tg-main · 本对话未接收')),
    `the elsewhere row has no destination line: ${JSON.stringify(elsewhereNotes)}`);
  check((await rowText(page, 'tool-t3-send'))?.includes('Telegram') === true, 'the elsewhere body is missing');
  check(await page.locator('[data-message-origin="ordinary_final"]').count() === 0, 'a message delivered elsewhere was also promoted as this page’s reply');
  check(await page.locator(`${elsewhere} [data-message-reached="elsewhere"]`).count() === 1, 'the elsewhere row does not declare where it went');

  // 4. Partial delivery: this conversation did not receive the voice note and
  //    another channel did not receive the picture.
  const partial = '[data-block-id="tool-t4-send"]';
  const partialNotes = await noteTexts(page, 'tool-t4-send');
  report.dom.partial = { notes: partialNotes };
  check(partialNotes.some((note) => note.id === 'internal-unsupported' && note.text.includes('本对话未收到：语音')),
    `this conversation's undelivered voice note is not named: ${JSON.stringify(partialNotes)}`);
  check(partialNotes.some((note) => note.id === 'channel-unsupported-im:slack-ops' && note.text.includes('im:slack-ops 未收到 图片、语音')),
    `the channel that took no attachment is not named: ${JSON.stringify(partialNotes)}`);
  // A channel that delivered the message but skipped one kind reports
  // `delivered` plus that kind; the note must name it rather than stay quiet.
  check(partialNotes.some((note) => note.id === 'channel-unsupported-im:tg-main' && note.text.includes('im:tg-main 未收到 语音')),
    `a partially delivered channel's skipped media is not named: ${JSON.stringify(partialNotes)}`);
  check(await page.locator(`${partial} [data-message-media="image"]`).count() === 1, 'the picture that did arrive is missing');
  check(await page.locator(`${partial} [data-message-media="audio"]`).count() === 0, 'the voice note this conversation never received is drawn as delivered media');

  // 5. An unconfirmed outcome: its own row, and it opens the process.
  const pending = page.locator('[data-block-id="tool-t5-send"] [data-message-status="pending"]');
  check(await pending.count() === 1, 'the unconfirmed outcome is not its own pending row');
  const pendingNote = page.locator('[data-block-id="tool-t5-send"] [data-message-delivery-note="unconfirmed"]');
  check((await pendingNote.innerText()).includes('送达未确认'), 'the pending row does not say the delivery is unconfirmed');
  await pendingNote.click();
  await page.waitForSelector('[data-timeline-view-option="process"][aria-checked="true"]', { timeout: STEP_TIMEOUT });
  await page.waitForSelector('[data-block-id="tool-t5-send"]', { timeout: STEP_TIMEOUT });
  report.dom.unconfirmed = { openedProcess: true };
  await page.locator('[data-timeline-view-option="message"]').click();
  await page.waitForSelector('[data-message-view-row="message"]', { timeout: STEP_TIMEOUT });

  // 6. A failed send keeps the destination that failed beside it.
  const failedNotes = await noteTexts(page, 'tool-t6-send');
  report.dom.failed = { notes: failedNotes };
  check((await page.locator('[data-block-id="tool-t6-send"] [data-message-status="failed"]').count()) === 1, 'the failed send is not a failed row');
  check(failedNotes.some((note) => note.id === 'channel-failed-im:matrix-room' && note.text.includes('im:matrix-room：未送达')),
    `the failed channel is not named: ${JSON.stringify(failedNotes)}`);

  // 7. A send refused for unsupported media is recoverable: the process holds
  //    the refusal in full.
  const refused = page.locator('[data-block-id="tool-t7-send"] [data-message-status="failed"]');
  check(await refused.count() === 1, 'the refused send is not a failed row');
  const refusal = await page.locator('[data-block-id="tool-t7-send"] [data-message-failure-detail]').textContent().catch(() => null);
  report.dom.refused = { reason: refusal };
  check((refusal ?? '').includes('media_unsupported'), `the refusal reason is not shown with the failed row: ${refusal}`);
  await page.locator('[data-block-id="tool-t7-send"] button').first().click();
  await page.waitForSelector('[data-timeline-view-option="process"][aria-checked="true"]', { timeout: STEP_TIMEOUT });
  await page.waitForTimeout(400);
  const inProcess = await page.locator('[data-block-id="tool-t7-send"] [data-message-failure-detail]').count();
  report.dom.refused.inProcess = inProcess;
  check(inProcess === 1, 'the refusal reason is missing from the process view');
  await shot(page, '04-refusal-process-1440');

  await page.locator('[data-timeline-view-option="message"]').click();
  await page.waitForSelector('[data-message-view-row="message"]', { timeout: STEP_TIMEOUT });

  // Desktop shots at a normal window height, scrolled to what each one shows.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => { document.querySelector('[data-transcript-scroll]')?.scrollTo({ top: 0 }); });
  await shot(page, '01-message-view-top-1440');
  await page.locator('[data-block-id="tool-t2-send"]').scrollIntoViewIfNeeded();
  await shot(page, '02-delivered-media-1440');
  await page.locator('[data-block-id="tool-t4-send"]').scrollIntoViewIfNeeded();
  await shot(page, '03-partial-and-claims-1440');

  // 8. Phone width: the same rows, one column, nothing spilling sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.locator('[data-block-id="tool-t2-send"]').scrollIntoViewIfNeeded().catch(() => undefined);
  const narrow = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    audio: document.querySelectorAll('[data-message-media="audio"] audio').length,
    image: document.querySelectorAll('[data-message-media="image"] img').length,
  }));
  report.dom.narrow = narrow;
  check(narrow.overflow <= 1, `the narrow layout overflows by ${narrow.overflow}px`);
  check(narrow.audio >= 1, 'the voice note is missing at 390');
  await shot(page, '05-delivered-media-390');
  await page.locator('[data-block-id="tool-t5-send"]').scrollIntoViewIfNeeded().catch(() => undefined);
  await shot(page, '06-pending-and-partial-390');
} catch (error) {
  errors.push(`walk: ${error.message.split('\n')[0]}`);
} finally {
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  await vite.close();
  await fixture.stop();
}

console.log(JSON.stringify(report, null, 2));
console.log(`[message-channels] ${output}`);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
