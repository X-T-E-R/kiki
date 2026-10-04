/**
 * Visual proof for the inspector's 本对话定时任务 block (fixture `rail-cron`):
 * three rows by default with the rest behind one control, the row action that
 * stays out of sight until the row is read, pause landing as the server
 * reports it, the block's empty state with its manage entry still present,
 * the narrow-window rail, and the /cron page the block leads to, scoped to
 * this one conversation.
 *
 *   node scripts/visual-proof-rail-cron.mjs [--widths=1440,390] [--themes=light,dark]
 *
 * Screenshots land in .tmp/rail-cron-proof/<stamp>/ as `<surface>-<tag>.png`.
 * Mock-only: the fixture server stands in for kap-server.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.tmp', 'rail-cron-proof', String(Date.now()));
await mkdir(output, { recursive: true });
const widths = (process.argv.find((arg) => arg.startsWith('--widths='))?.slice('--widths='.length) ?? '1440,390').split(',').map(Number);
const themes = (process.argv.find((arg) => arg.startsWith('--themes='))?.slice('--themes='.length) ?? 'light,dark').split(',');

const SCENARIO = 'rail-cron';
const SID = 'session_fixture_cron';
const OTHER = 'session_fixture_cron_other';
const OTHER_PROMPT = 'market data cache';
const WORKSPACE_PROMPT = 'workspace scratch';
const DIGEST = 'cron_fixture_digest';
const REVIEW = 'cron_fixture_review';
const DOCS = 'cron_fixture_docs';
const PRUNE = 'cron_fixture_prune';

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

async function withPage({ theme, width, locale = 'zh', railWidth }, run) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const tag = `${locale}-${theme}-${width}${railWidth === undefined ? '' : `-rail${railWidth}`}`;
  page.on('pageerror', (error) => { errors.push(`${tag}: ${error.message}`); });
  await page.addInitScript((next) => {
    localStorage.setItem('kiki.locale', next.locale);
    localStorage.setItem('kiki.settings', JSON.stringify({ theme: next.theme }));
    if (next.railWidth !== undefined) localStorage.setItem('kiki.layout', JSON.stringify({ railWidth: next.railWidth }));
  }, { locale, theme, railWidth });
  try { await run(page, tag); } finally { await page.close(); }
}

/** Runs one page walk and turns any thrown step into one collected error. */
async function walkIn(options, walk, label) {
  const tag = `${options.locale ?? 'zh'}-${options.theme}-${options.width}${options.railWidth === undefined ? '' : `-rail${options.railWidth}`}${label === undefined ? '' : `-${label}`}`;
  await withPage(options, (page) => walk(page, tag)).catch((error) => { errors.push(`${tag}: ${error.message.split('\n')[0]}`); });
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

/** The block's head is one button: its label must not clip at the narrowest rail. */
async function assertHeadFits(page, tag) {
  const fit = await page.locator('[data-rail-cron] > button').first().evaluate((node) => ({
    scroll: node.scrollWidth,
    client: node.clientWidth,
    chevron: node.querySelector('svg') !== null,
  }));
  if (fit.scroll > fit.client + 1) errors.push(`${tag}: rail-cron head clips (${fit.scroll} > ${fit.client})`);
  if (!fit.chevron) errors.push(`${tag}: rail-cron head lost its chevron`);
}

const rowIds = (page) => page.locator('[data-rail-cron-row]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-rail-cron-row')));

async function walk(page, tag) {
  await page.goto(url(`/s/${SID}`), { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-rail-cron-row]', { timeout: 30_000 });
  await assertHeadFits(page, tag);

  // Three rows, this conversation's only, paused state on its own row.
  const rows = await rowIds(page);
  if (rows.length !== 3) errors.push(`${tag}: expected 3 default rows, saw ${rows.length} (${rows.join(',')})`);
  if ([...rows].sort().join(',') !== [DIGEST, DOCS, REVIEW].sort().join(',')) errors.push(`${tag}: unexpected default rows ${rows.join(',')}`);
  const block = page.locator('[data-rail-cron]');
  const text = await block.innerText();
  if (text.includes(OTHER_PROMPT)) errors.push(`${tag}: another conversation's task rendered in this rail`);
  if (text.includes(WORKSPACE_PROMPT)) errors.push(`${tag}: a workspace-level task rendered in this rail`);
  if (!text.includes('还有 1 项')) errors.push(`${tag}: the folded rest is not offered (${text.replace(/\n/g, ' | ')})`);
  if (!(await page.locator('[data-rail-cron-manage]').isVisible())) errors.push(`${tag}: manage entry missing`);
  await shot(page, `rail-default-${tag}`);

  // The live row's action hides until the row is read; the paused row keeps it.
  const activeAction = page.locator(`[data-rail-cron-row="${DIGEST}"] [data-rail-cron-toggle]`);
  const pausedAction = page.locator(`[data-rail-cron-row="${REVIEW}"] [data-rail-cron-toggle]`);
  const hiddenOpacity = await activeAction.evaluate((node) => getComputedStyle(node).opacity);
  const pausedOpacity = await pausedAction.evaluate((node) => getComputedStyle(node).opacity);
  if (hiddenOpacity !== '0') errors.push(`${tag}: an unread live row already shows its pause control (opacity ${hiddenOpacity})`);
  if (pausedOpacity !== '1') errors.push(`${tag}: a paused row hides its resume control (opacity ${pausedOpacity})`);
  await page.locator(`[data-rail-cron-row="${DIGEST}"]`).hover();
  await page.waitForFunction((id) => {
    const node = document.querySelector(`[data-rail-cron-row="${id}"] [data-rail-cron-toggle]`);
    return node !== null && getComputedStyle(node).opacity === '1';
  }, DIGEST, { timeout: 5_000 }).catch(() => { errors.push(`${tag}: hovering the row did not reveal its pause control`); });
  await shot(page, `rail-row-hover-${tag}`);

  // The paused row says so, and resumes under its own label.
  if (!(await page.locator(`[data-rail-cron-row="${REVIEW}"] [data-rail-cron-state="paused"]`).isVisible())) errors.push(`${tag}: a paused row does not say it is paused`);
  if ((await pausedAction.innerText()).trim() !== '恢复') errors.push(`${tag}: a paused row's control reads "${await pausedAction.innerText()}"`);

  // Four rows once the folded one opens.
  await page.locator('[data-rail-cron-more]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-rail-cron-row]').length === 4, null, { timeout: 5_000 })
    .catch(() => { errors.push(`${tag}: opening the block did not reveal the fourth row`); });
  await shot(page, `rail-expanded-${tag}`);

  // Folded: the head keeps its count and reads the next fire while closed.
  const head = page.locator('[data-rail-cron] > button').first();
  await head.click();
  await page.waitForFunction(() => document.querySelectorAll('[data-rail-cron-row]').length === 0, null, { timeout: 5_000 })
    .catch(() => { errors.push(`${tag}: folding the block kept its rows`); });
  if (!(await head.innerText()).includes('剩余')) errors.push(`${tag}: the folded head does not read the next fire`);
  await shot(page, `rail-folded-${tag}`);
  await head.click();
  await page.waitForSelector('[data-rail-cron-row]', { timeout: 5_000 })
    .catch(() => { errors.push(`${tag}: unfolding the block did not bring its rows back`); });

  // Pause: the row follows the server, and the server really holds it.
  await page.locator(`[data-rail-cron-row="${DIGEST}"] [data-rail-cron-toggle]`).click();
  await page.waitForFunction((id) => {
    const node = document.querySelector(`[data-rail-cron-row="${id}"] [data-rail-cron-toggle]`);
    return node !== null && node.textContent.trim() === '恢复';
  }, DIGEST, { timeout: 10_000 }).catch(() => { errors.push(`${tag}: pausing the task did not settle on the resumed label`); });
  const paused = await (await api(`/cron?session_id=${SID}`)).json();
  const digest = paused.data.items.find((task) => task.id === DIGEST);
  if (digest === undefined || digest.paused !== true) errors.push(`${tag}: the server did not pause ${DIGEST}`);
  if (!(await page.locator(`[data-rail-cron-row="${DIGEST}"] [data-rail-cron-state="paused"]`).isVisible())) errors.push(`${tag}: the row does not read paused after pausing`);
  await shot(page, `rail-paused-${tag}`);

  // The block leads to /cron, scoped to this conversation and nothing else.
  await page.locator('[data-rail-cron-manage]').click();
  await page.waitForURL((next) => next.pathname === '/cron' && next.searchParams.get('session') === SID, { timeout: 15_000 })
    .catch(() => { errors.push(`${tag}: the manage entry did not open /cron?session=${SID}`); });
  await page.waitForSelector('[data-cron-session-scope]', { timeout: 20_000 });
  const pageRows = await page.locator('[data-cron-task]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-cron-task')));
  const expected = [DOCS, REVIEW, DIGEST, PRUNE].sort().join(',');
  if ([...pageRows].sort().join(',') !== expected) errors.push(`${tag}: /cron?session= listed ${pageRows.join(',')}`);
  const listedText = await page.locator('[data-cron-list]').innerText();
  if (listedText.includes(OTHER_PROMPT) || listedText.includes(WORKSPACE_PROMPT)) errors.push(`${tag}: /cron?session= leaked another conversation's tasks`);
  const pageText = await page.locator('[data-cron-session-scope]').innerText();
  if (!pageText.includes('Fixture: scheduled work')) errors.push(`${tag}: /cron?session= does not name the conversation (${pageText.replace(/\n/g, ' | ')})`);
  await shot(page, `cron-page-session-${tag}`);

  // Clearing the scope widens back to every conversation.
  await page.locator('[data-cron-session-clear]').click();
  await page.waitForFunction(() => document.querySelector('[data-cron-session-scope]') === null, null, { timeout: 10_000 })
    .catch(() => { errors.push(`${tag}: clearing the conversation scope did nothing`); });
  await page.waitForFunction(() => document.querySelectorAll('[data-cron-task]').length >= 5, null, { timeout: 10_000 })
    .catch(() => { errors.push(`${tag}: the widened list is missing tasks`); });
  await shot(page, `cron-page-all-${tag}`);

  // Empty: the block stays, says so, and keeps its way to manage.
  for (const task of (await (await api(`/cron?session_id=${SID}`)).json()).data.items) {
    await api(`/cron/${task.id}?session_id=${SID}`, { method: 'DELETE' });
  }
  await page.goto(url(`/s/${SID}`), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-rail-cron-empty]', { timeout: 30_000 })
    .catch(() => { errors.push(`${tag}: the empty state never appeared`); });
  if (!(await page.locator('[data-rail-cron]').isVisible())) errors.push(`${tag}: the empty block hid itself`);
  if (!(await page.locator('[data-rail-cron-manage]').isVisible())) errors.push(`${tag}: the empty block dropped its manage entry`);
  await shot(page, `rail-empty-${tag}`);
}

/** Below lg the rail is unavailable in this shell (no overlay, no entry): the
 * block must not invent a narrow surface of its own. */
async function walkNarrow(page, tag) {
  await page.goto(url(`/s/${SID}`), { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('textarea:not([disabled])', { timeout: 30_000 });
  if (await page.locator('[data-session-rail]').count() > 0) errors.push(`${tag}: a rail rendered below lg`);
  if (await page.locator('[data-rail-toggle]').count() > 0) errors.push(`${tag}: a rail entry appeared below lg`);
  if (await page.locator('[data-rail-cron]').count() > 0) errors.push(`${tag}: the block invented a narrow surface`);
  await shot(page, `narrow-wide-shot-${tag}`);
}

try {
  for (const theme of themes) {
    for (const width of widths) {
      await control({ action: 'scenario', name: SCENARIO });
      await walkIn({ theme, width }, width < 1024 ? walkNarrow : walk);
    }
  }
  // Worst case for the head's label: the narrowest rail, in the longer locale.
  for (const locale of ['en', 'zh']) {
    await control({ action: 'scenario', name: SCENARIO });
    await walkIn({ theme: 'light', width: 1440, locale, railWidth: 240 }, async (page, tag) => {
      await page.goto(url(`/s/${SID}`), { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.waitForSelector('[data-rail-cron-row]', { timeout: 30_000 });
      await assertHeadFits(page, tag);
      await shot(page, `rail-min-width-${tag}`);
    });
  }
  // A conversation whose own list is empty while the full list is not: the
  // block shows its own only.
  await control({ action: 'scenario', name: SCENARIO });
  await walkIn({ theme: 'light', width: 1440, locale: 'zh' }, async (page, tag) => {
    await page.goto(url(`/s/${OTHER}`), { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForSelector('[data-rail-cron-row]', { timeout: 30_000 });
    const rows = await rowIds(page);
    if (rows.join(',') !== 'cron_fixture_other_hourly') errors.push(`${tag}: saw ${rows.join(',')}`);
    await shot(page, `rail-other-conversation-${tag}`);
  }, 'other');
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
