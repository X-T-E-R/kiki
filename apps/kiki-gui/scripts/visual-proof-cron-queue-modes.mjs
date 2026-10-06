/**
 * Visual proof for what a scheduled task's delivery timing does to the queue
 * a user reads (fixture `cron-queue-modes`).
 *
 * The claim under test is narrow and product-shaped: the pending count and
 * the send-order controls describe the user's own messages and the scheduled
 * jobs that share their order — and say so plainly about the jobs the engine
 * holds ahead of it. A `queue` job keeps the controls a typed message has; an
 * `idle` and a `steer` job keep their text readable and lose them. A job with
 * no recorded timing was admitted into the ordinary order and still reads as
 * one of the user's messages.
 *
 *   node scripts/visual-proof-cron-queue-modes.mjs [--widths=1440,390] [--themes=light,dark]
 *
 * Screenshots land in .tmp/cron-queue-modes-proof/<stamp>/ as `<surface>-<tag>.png`.
 * Mock-only: the fixture server stands in for kap-server.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { en as EN } from '../../../packages/session-core/src/i18n/en.ts';
import { zh as ZH } from '../../../packages/session-core/src/i18n/zh.ts';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.tmp', 'cron-queue-modes-proof', String(Date.now()));
await mkdir(output, { recursive: true });
const widths = (process.argv.find((arg) => arg.startsWith('--widths='))?.slice('--widths='.length) ?? '1440,390').split(',').map(Number);
const themes = (process.argv.find((arg) => arg.startsWith('--themes='))?.slice('--themes='.length) ?? 'light').split(',');

const SCENARIO = 'cron-queue-modes';
const SID = 'session_fixture_cron_queue_modes';
const USER = 'prompt_fx_cqm_user';
const QUEUE_JOB = 'prompt_fx_cqm_queue';
const LEGACY = 'prompt_fx_cqm_legacy';
const IDLE = 'prompt_fx_cqm_idle';
const STEER = 'prompt_fx_cqm_steer';
const HELD_ONLY = 'session_fixture_cron_queue_modes_held';

const fixture = await startFixtureServer({ port: 0, scenario: SCENARIO });
const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
process.env.KIKI_SERVER_URL = endpoint;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: ['**/*.test.ts', '**/*.test.tsx', '.tmp/**', '**/.tmp/**'] } } });
await vite.listen();
const web = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const errors = [];

const url = (path) => `${web}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(endpoint)}&token=${FIXTURE_TOKEN}`;

async function withPage({ theme, width, locale = 'zh' }, run) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const tag = `${locale}-${theme}-${width}`;
  page.on('pageerror', (error) => { errors.push(`${tag}: ${error.message}`); });
  await page.addInitScript((next) => {
    localStorage.setItem('kiki.locale', next.locale);
    localStorage.setItem('kiki.settings', JSON.stringify({ theme: next.theme }));
  }, { locale, theme });
  try { await run(page, tag); } finally { await page.close(); }
}

async function walkIn(options, walk) {
  const tag = `${options.locale ?? 'zh'}-${options.theme}-${options.width}`;
  await withPage(options, (page) => walk(page, tag)).catch((error) => {
    errors.push(`${tag}: ${error.message.split('\n')[0]}`);
  });
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

const row = (page, id) => page.locator(`[data-queue-item="${id}"]`);

/**
 * A row's actions are out of the layout until the row is read, and how you
 * read them depends on the device: hover on a pointer, the `⋯` toggle where
 * there is no hover. Open them the way the running device would before
 * reading anything inside them.
 */
async function openRowActions(page, id) {
  const target = row(page, id);
  await target.hover();
  const toggle = target.locator('.dock-more');
  if (await toggle.isVisible()) await toggle.click();
  await page.waitForFunction((promptId) => {
    const node = document.querySelector(`[data-queue-item="${promptId}"] [data-queue-row-actions]`);
    return node !== null && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().width > 0;
  }, id, { timeout: 10_000 }).catch(() => { /* a hover-capable device already revealed it */ });
  return target;
}

/** Open the composer's queue stack; it is folded until the user clicks it. */
async function openQueue(page) {
  const summary = page.locator('[data-queue-count], [data-queue-held-count]').first();
  await summary.waitFor({ timeout: 30_000 });
  await summary.click();
  await page.waitForSelector('[data-queue-strip]', { timeout: 15_000 });
}

const hasControl = (page, id, selector) => page.evaluate(({ promptId, sel }) => {
  return document.querySelectorAll(`[data-queue-item="${promptId}"] ${sel}`).length;
}, { promptId: id, sel: selector });

async function walk(page, tag, locale) {
  const L = locale === 'en' ? EN : ZH;
  const dragHandle = `button[aria-label="${L['queue.dragHandleAria']}"]`;
  const badge = L['transcript.marker.cron'];
  await page.goto(url(`/s/${SID}`), { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await page.waitForSelector('[data-queue-count]', { timeout: 60_000 });
  await openQueue(page);

  // Every seeded record is on screen: none is hidden, because its text is
  // work the user is waiting to have read.
  for (const id of [USER, QUEUE_JOB, LEGACY, IDLE, STEER]) {
    if (await row(page, id).count() !== 1) errors.push(`${tag}: ${id} is not in the queue`);
  }

  // The count is the user's own messages plus the job that shares their
  // order — three — not all five. The two held jobs are named beside it
  // rather than inflating it.
  const count = (await page.locator('[data-queue-count]').innerText()).trim();
  if (count !== L['composer.queueStack.count.other'].replace('{count}', '3')) {
    errors.push(`${tag}: the pending count reads "${count}", expected 3`);
  }
  const held = page.locator('[data-queue-held-count]');
  if (await held.count() !== 1) errors.push(`${tag}: the held scheduled jobs are not named beside the count`);
  else if ((await held.innerText()).trim() === '') errors.push(`${tag}: the held-job note is empty`);
  await shot(page, `queue-${tag}`);

  // A queue-mode job is a queued message like any other: same reorder handle,
  // same timing picker, same send-now, and it says it is a scheduled job.
  if (await row(page, QUEUE_JOB).getAttribute('data-queue-held') !== null) {
    errors.push(`${tag}: a queue-mode job is marked as held`);
  }
  if (!(await row(page, QUEUE_JOB).innerText()).includes(badge)) {
    errors.push(`${tag}: a queue-mode job lost its Scheduled job label`);
  }
  await openRowActions(page, QUEUE_JOB);
  if (await hasControl(page, QUEUE_JOB, dragHandle) !== 1) errors.push(`${tag}: a queue-mode job lost its reorder handle`);
  if (await hasControl(page, QUEUE_JOB, '[data-timing-picker]') !== 1) errors.push(`${tag}: a queue-mode job lost its timing picker`);
  if (await hasControl(page, QUEUE_JOB, `button[aria-label="${L['sv.queueSendNow']}"]`) !== 1) {
    errors.push(`${tag}: a queue-mode job lost its Send now`);
  }

  // A record from before timings existed sits in the same order, so it reads
  // the same way — not as something the engine holds.
  if (await row(page, LEGACY).getAttribute('data-queue-held') !== null) {
    errors.push(`${tag}: a job with no recorded timing was treated as held`);
  }
  await openRowActions(page, LEGACY);
  if (await hasControl(page, LEGACY, dragHandle) !== 1) {
    errors.push(`${tag}: a job with no recorded timing lost its reorder handle`);
  }
  if (!(await row(page, LEGACY).innerText()).includes(badge)) {
    errors.push(`${tag}: a job with no recorded timing lost its Scheduled job label`);
  }

  // The two held jobs say which timing holds them, and carry none of the
  // controls that would re-order or rush them. Remove stays, and so does the
  // text: a row the user cannot read is work they cannot act on.
  for (const [id, label] of [[IDLE, ZH['cron.delivery.idle']], [STEER, ZH['cron.delivery.steer']]]) {
    const heldRow = row(page, id);
    if (await heldRow.getAttribute('data-queue-held') === null) errors.push(`${tag}: ${id} is not marked as held`);
    const mode = await heldRow.locator('[data-queue-held-mode]').innerText();
    if (!mode.includes(label)) errors.push(`${tag}: ${id} names "${mode}", expected it to name ${label}`);
    await openRowActions(page, id);
    if (await hasControl(page, id, dragHandle) !== 0) errors.push(`${tag}: ${id} still offers a reorder handle`);
    if (await hasControl(page, id, '[data-timing-picker]') !== 0) errors.push(`${tag}: ${id} still offers a per-message timing picker`);
    // Absent, not greyed out: a dead control beside a live one reads as a
    // broken row, and the note that explained it cost the preview its width.
    if (await hasControl(page, id, `button[aria-label="${L['sv.queueSendNow']}"]`) !== 0) {
      errors.push(`${tag}: ${id} still offers a Send now`);
    }
    if (await heldRow.locator('[data-queue-read-only]').count() !== 0) {
      errors.push(`${tag}: ${id} still carries the read-only note`);
    }
    if (await hasControl(page, id, `button[aria-label="${ZH['sv.queueRemove']}"]`) !== 1) {
      errors.push(`${tag}: ${id} lost its Remove`);
    }
    // The preview keeps the width the note used to take: at the narrow width
    // the note pushed the text to an ellipsis on a row with room to show it.
    const preview = await heldRow.locator('details > summary > span').last().boundingBox();
    if (preview === null || preview.width < 80) {
      errors.push(`${tag}: ${id} has no room for its text (${preview?.width ?? 0}px)`);
    }
    if (!(await heldRow.innerText()).includes(badge)) errors.push(`${tag}: ${id} lost its Scheduled job label`);
  }
  await shot(page, `queue-rows-${tag}`);

  // The text is still readable: a held job expands to its full prompt, so
  // withholding the controls does not withhold the work.
  const idleDisclosure = row(page, IDLE).locator('details');
  await idleDisclosure.locator('summary').click();
  const body = (await idleDisclosure.locator('p').innerText()).trim();
  if (!body.includes('Controller self-check')) errors.push(`${tag}: the held job's body reads "${body}"`);
  await shot(page, `queue-expanded-${tag}`);

  // A session waiting only on held jobs. The header must name that work
  // instead of opening with "0 queued", and the rows must look the same
  // without a user message beside them to compare against.
  await page.goto(url(`/s/${HELD_ONLY}`), { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await page.waitForSelector('[data-queue-held-count]', { timeout: 60_000 });
  await openQueue(page);
  if (await page.locator('[data-queue-count]').count() !== 0) {
    errors.push(`${tag}: the held-only header shows a pending count of nothing queued`);
  }
  const heldLabel = (await page.locator('[data-queue-held-count]').innerText()).trim();
  if (!heldLabel.includes('2')) errors.push(`${tag}: the held-only header reads "${heldLabel}"`);
  for (const [id, modeLabel] of [
    ['prompt_fx_cqmo_idle', L['cron.delivery.idle']],
    ['prompt_fx_cqmo_steer', L['cron.delivery.steer']],
  ]) {
    if (await row(page, id).count() !== 1) { errors.push(`${tag}: ${id} is missing from the held-only queue`); continue; }
    if (await row(page, id).getAttribute('data-queue-held') === null) errors.push(`${tag}: ${id} is not marked as held`);
    if (!(await row(page, id).locator('[data-queue-held-mode]').innerText()).includes(modeLabel)) {
      errors.push(`${tag}: ${id} does not name its timing`);
    }
    await openRowActions(page, id);
    if (await hasControl(page, id, `button[aria-label="${L['sv.queueSendNow']}"]`) !== 0) {
      errors.push(`${tag}: ${id} gains a Send now just because nothing else is queued`);
    }
    if (await hasControl(page, id, `button[aria-label="${L['sv.queueRemove']}"]`) !== 1) {
      errors.push(`${tag}: ${id} lost its Remove in the held-only queue`);
    }
  }
  // Clearing still reaches them, so the confirmation has to say it does.
  await page.locator('[data-queue-strip]').getByText(L['sv.queueClearAll']).click();
  await page.waitForSelector('[role="alertdialog"]', { timeout: 10_000 })
    .catch(() => { errors.push(`${tag}: Clear all did not ask before touching held jobs`); });
  const confirmBody = await page.locator('[role="alertdialog"]').innerText();
  if (!confirmBody.includes(L['sv.queueClearBody'].split('.')[0].slice(0, 12))) {
    errors.push(`${tag}: the Clear all confirmation does not describe what it removes`);
  }
  await shot(page, `queue-held-only-clear-${tag}`);
}

try {
  for (const theme of themes) {
    for (const width of widths) {
      await walkIn({ theme, width }, (page, tag) => walk(page, tag, 'zh'));
    }
  }
  // The other locale, so the labels are exercised in both.
  await walkIn({ theme: themes[0], width: widths[0], locale: 'en' }, async (page, tag) => {
    await page.goto(url(`/s/${SID}`), { waitUntil: 'domcontentloaded', timeout: 240_000 });
    await page.waitForSelector('[data-queue-count], [data-queue-held-count]', { timeout: 60_000 });
    await openQueue(page);
    const count = (await page.locator('[data-queue-count]').innerText()).trim();
    if (count !== EN['composer.queueStack.count.other'].replace('{count}', '3')) errors.push(`${tag}: the pending count reads "${count}", expected 3`);
    if (!(await row(page, IDLE).innerText()).includes(EN['transcript.marker.cron'])) {
      errors.push(`${tag}: a held job lost its Scheduled job label`);
    }
    if (!(await row(page, IDLE).locator('[data-queue-held-mode]').innerText()).includes(EN['cron.delivery.idle'])) {
      errors.push(`${tag}: the idle job does not name its timing in English`);
    }
    // The English walk still proves the boundary, so a label change cannot
    // quietly stop the check from running at all.
    await openRowActions(page, IDLE);
    if (await hasControl(page, IDLE, `button[aria-label="${EN['sv.queueSendNow']}"]`) !== 0) {
      errors.push(`${tag}: a held job still offers Send now in English`);
    }
    await shot(page, `queue-${tag}`);
  });
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