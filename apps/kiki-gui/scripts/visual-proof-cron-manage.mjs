/**
 * Visual proof for scheduled-task management (fixture `cron-manage`):
 * schedules that read in the reader's language instead of the engine's
 * English, a create entry that binds a conversation, an editor that opens a
 * complex rule on its own text, a detail panel with the full prompt, run now
 * at the bottom left, and a real refused save that keeps the draft.
 *
 *   node scripts/visual-proof-cron-manage.mjs [--widths=1440,390] [--themes=light,dark]
 *
 * Screenshots land in .tmp/cron-manage-proof/<stamp>/ as `<surface>-<tag>.png`.
 * Mock-only: the fixture server stands in for kap-server.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.tmp', 'cron-manage-proof', String(Date.now()));
await mkdir(output, { recursive: true });
const widths = (process.argv.find((arg) => arg.startsWith('--widths='))?.slice('--widths='.length) ?? '1440').split(',').map(Number);
const themes = (process.argv.find((arg) => arg.startsWith('--themes='))?.slice('--themes='.length) ?? 'light').split(',');

const SCENARIO = 'cron-manage';
const HOURLY = 'cron_fixture_hourly';
const DAILY = 'cron_fixture_daily';
const COMPLEX = 'cron_fixture_complex';
const PAUSED = 'cron_fixture_paused';
const WORKSPACE_TASK = 'cron_fixture_workspace';
// A minute cadence the friendly controls cannot represent, so the editor has
// to open on the expression rather than saving a simplification of it.
const FREQUENCY = 'cron_fixture_frequency';

const fixture = await startFixtureServer({ port: 0, scenario: SCENARIO });
const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
process.env.KIKI_SERVER_URL = endpoint;
// The shared vite config pins 5177 (or `KIKI_GUI_PORT`) unless this call
// wins, and another agent's dev server may already hold it. `strictPort: false`
// lets vite slide to a free port instead of aborting the run. `.tmp` holds
// scratch artifacts several agents write during a run; watching it turns
// their scratch files into page reloads under this walk.
const vite = await createServer({
  root,
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
    watch: { ignored: ['**/*.test.ts', '**/*.test.tsx', '.tmp/**', '**/.tmp/**'] },
  },
});
await vite.listen();
const web = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const errors = [];

const control = (body) => fetch(`${endpoint}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const api = (path, init) => fetch(`${endpoint}/api${path}`, { ...init, headers: { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/json', ...init?.headers } });
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

async function walkIn(options, walk, label) {
  const tag = `${options.locale ?? 'zh'}-${options.theme}-${options.width}${label === undefined ? '' : `-${label}`}`;
  await withPage(options, (page, full) => walk(page, full)).catch((error) => {
    // Keep the failing call site: a bare "click timed out" is not
    // actionable when one walk holds a dozen clicks.
    const lines = String(error.message).split('\n');
    const site = lines.find((line) => line.trim().startsWith('at ')) ?? '';
    errors.push(`${tag}: ${lines[0]} ${site.trim()}`);
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

/** The row text a person actually reads, with the engine's English excluded. */
async function rowText(page, id) {
  return (await page.locator(`[data-cron-task="${id}"]`).innerText()).replace(/\n/g, ' | ');
}

const scheduleOf = async (page, id) =>
  (await page.locator(`[data-cron-task="${id}"] [data-cron-schedule]`).innerText()).trim();

/**
 * A row control, scrolled into view before it is clicked. The dev server
 * reloads the page whenever a source file changes underneath a walk, and a
 * control that was on screen a moment ago is not necessarily on screen now.
 */
async function clickRow(page, id, action) {
  const control = page.locator(`[data-cron-task="${id}"] [data-cron-action="${action}"]`);
  await control.scrollIntoViewIfNeeded();
  await control.click({ timeout: 60_000 });
}

async function openCron(page) {
  // This machine's cold Vite dev server needs well over a minute to finish
  // the first module graph, and it reloads the page whenever another agent
  // edits a source file. A navigation that dies mid-load is retried against
  // the reloaded server rather than being reported as a product failure.
  const deadline = Date.now() + 600_000;
  let lastError = 'never attempted';
  while (Date.now() < deadline) {
    try {
      await page.goto(url('/cron'), { waitUntil: 'domcontentloaded', timeout: 240_000 });
      await page.waitForSelector('[data-cron-task]', { timeout: 30_000 });
      return;
    } catch (error) {
      lastError = error.message.split('\n')[0];
      await page.waitForTimeout(3_000);
    }
  }
  throw new Error(`the /cron page never loaded: ${lastError}`);
}

async function walk(page, tag) {
  await openCron(page);

  // The schedules read in the reader's language. The engine's English and
  // the raw expression are not standing in for them.
  const hourly = await scheduleOf(page, HOURLY);
  if (hourly !== '每小时整点') errors.push(`${tag}: hourly schedule reads "${hourly}", expected 每小时整点`);
  const daily = await scheduleOf(page, DAILY);
  if (daily !== '工作日 09:00') errors.push(`${tag}: weekday schedule reads "${daily}", expected 工作日 09:00`);
  const listText = await page.locator('[data-cron-list]').innerText();
  for (const leaked of ['at minute 0 of every hour', 'at 09:00 every day', '(truncated)']) {
    if (listText.includes(leaked)) errors.push(`${tag}: the list still shows internal text "${leaked}"`);
  }
  // Run now sits on the row's lower line, left of the pause/delete group.
  const runBox = await page.locator(`[data-cron-task="${HOURLY}"] [data-cron-action="run"]`).boundingBox();
  const pauseBox = await page.locator(`[data-cron-task="${HOURLY}"] [data-cron-action="pause"]`).boundingBox();
  if (runBox === null || pauseBox === null) {
    errors.push(`${tag}: a row control is missing`);
  } else {
    if (runBox.x > pauseBox.x + 8) errors.push(`${tag}: Run now (x=${runBox.x}) is not left of Pause (x=${pauseBox.x})`);
    if (runBox.y <= pauseBox.y) errors.push(`${tag}: Run now (y=${runBox.y}) is not below Pause (y=${pauseBox.y})`);
  }
  await shot(page, `list-${tag}`);

  // The detail panel carries the full prompt and the expression.
  await clickRow(page, HOURLY, "expand");
  await page.waitForSelector(`[data-cron-task="${HOURLY}"] [data-cron-detail-prompt]`, { timeout: 15_000 })
    .catch(() => { errors.push(`${tag}: the detail panel never showed the full prompt`); });
  const detail = await page.locator(`[data-cron-task="${HOURLY}"] [data-cron-detail]`).innerText();
  if (!detail.includes('0 * * * *')) errors.push(`${tag}: the detail panel hides the expression`);
  if (detail.includes('…(truncated)')) errors.push(`${tag}: the detail prompt is still truncated`);
  if (!detail.includes('本轮无新增')) errors.push(`${tag}: the detail prompt is not the full text`);
  await shot(page, `detail-${tag}`);

  // The workspace task says it has no conversation rather than showing a link.
  const workspaceRow = await rowText(page, WORKSPACE_TASK);
  if (workspaceRow.includes('undefined')) errors.push(`${tag}: the unbound task renders "undefined"`);

  // Create: pick a conversation, set a schedule, save, and the server holds it.
  await page.locator('[data-cron-create]').click();
  await page.waitForSelector('[data-cron-editor-title]', { timeout: 15_000 });
  // A new task opens on the default timing, and says what it means.
  const defaultMode = await page.locator('[data-cron-delivery] [role="radio"][aria-checked="true"]').getAttribute('data-cron-delivery-mode');
  if (defaultMode !== 'idle') errors.push(`${tag}: a new task opens on "${defaultMode}", expected idle`);
  await page.locator('[data-cron-prompt]').fill('把昨夜的设计与验证增量汇总给我，只回新增项。');
  await page.locator('[data-cron-cadence="hourly"]').click();
  await page.locator('#cron-bind-session').click();
  await page.waitForSelector('[data-select-panel]', { timeout: 10_000 });
  const options = await page.locator('[data-option-value]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-option-value')));
  if (options.length < 3) errors.push(`${tag}: the bind picker offers ${options.length} conversations`);
  await shot(page, `editor-create-${tag}`);
  await page.locator('[data-option-value="session_fixture_cron_review"]').click();
  await page.locator('[data-cron-save]').click();
  await page.waitForSelector('[data-cron-editor-title]', { state: 'detached', timeout: 20_000 })
    .catch(() => { errors.push(`${tag}: the editor did not close after a saved create`); });
  const created = (await (await api('/cron')).json()).data.items.find((task) => task.prompt.startsWith('把昨夜的设计'));
  if (created === undefined) errors.push(`${tag}: the server did not keep the created task`);
  else if (created.session_id !== 'session_fixture_cron_review') errors.push(`${tag}: the task bound to ${created.session_id}, not the chosen conversation`);
  else if (created.cron !== '0 * * * *') errors.push(`${tag}: the created rule is "${created.cron}", not 0 * * * *`);
  else if (created.delivery_mode !== 'idle') errors.push(`${tag}: the created task stored "${created.delivery_mode}", not the default idle`);
  await page.waitForFunction((text) => {
    const list = document.querySelector('[data-cron-list]');
    return list !== null && list.textContent.includes(text);
  }, '把昨夜的设计', { timeout: 20_000 }).catch(() => { errors.push(`${tag}: the created task is not in the list`); });
  await shot(page, `created-${tag}`);

  // CR02: a minute frequency is not a schedule the controls can hold. The
  // editor must open on the expression; saving a simplification would turn
  // "every 30 minutes" into "once an hour" without saying so.
  await clickRow(page, FREQUENCY, 'edit');
  await page.waitForSelector('[data-cron-advanced-input]', { timeout: 30_000 })
    .catch(() => { errors.push(`${tag}: a minute frequency did not open on the expression`); });
  const frequency = await page.locator('[data-cron-advanced-input]').inputValue();
  if (frequency !== '*/30 * * * *') errors.push(`${tag}: the editor rewrote a frequency to "${frequency}"`);
  await shot(page, `editor-frequency-${tag}`);
  // Nothing was typed, so cancelling closes without asking: there is no
  // draft to lose and a prompt here would be noise.
  await page.locator('[data-cron-cancel]').click();
  await page.waitForSelector('[data-cron-editor-title]', { state: 'detached', timeout: 20_000 })
    .catch(() => { errors.push(`${tag}: cancelling an untouched editor did not close it`); });
  if (await page.locator('[role="alertdialog"]').count() > 0) {
    errors.push(`${tag}: cancelling an untouched editor asked to discard nothing`);
  }
  const frequencyAfter = (await (await api(`/cron/${FREQUENCY}`)).json()).data.task;
  if (frequencyAfter.cron !== '*/30 * * * *') {
    errors.push(`${tag}: the frequency rule became "${frequencyAfter.cron}"`);
  }

  // CR01: the editor must hold the full prompt, never the list row's
  // preview. This task's prompt is deliberately longer than its preview, so
  // a preview saved over it would be visible on the server.
  await clickRow(page, HOURLY, 'edit');
  await page.waitForSelector('[data-cron-prompt]', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const field = document.querySelector('[data-cron-prompt]');
    return field instanceof HTMLTextAreaElement && field.disabled === false;
  }, null, { timeout: 30_000 }).catch(() => { errors.push(`${tag}: the prompt box never became editable`); });
  const promptText = await page.locator('[data-cron-prompt]').inputValue();
  if (promptText.includes('(truncated)')) errors.push(`${tag}: the editor opened on the truncated preview`);
  if (!promptText.includes('本轮无新增')) errors.push(`${tag}: the editor did not load the full prompt`);
  // Change only the cadence, then save: the prompt must go out in full.
  await page.locator('[data-cron-cadence="hourly"]').click();
  await page.locator('[data-cron-save]').click();
  await page.waitForSelector('[data-cron-editor-title]', { state: 'detached', timeout: 20_000 })
    .catch(() => { errors.push(`${tag}: saving a schedule-only edit did not close the editor`); });
  const savedHourly = (await (await api(`/cron/${HOURLY}`)).json()).data.task;
  if (!savedHourly.prompt.includes('本轮无新增')) {
    errors.push(`${tag}: a schedule-only save wrote the preview over the prompt`);
  }
  // That save changed only the cadence, so the timing the task already had
  // must be exactly what it was — the form displayed it, it did not claim it.
  if (savedHourly.delivery_mode !== 'idle') {
    errors.push(`${tag}: a schedule-only save changed the timing to "${savedHourly.delivery_mode}"`);
  }

  // Delivery timing: each of the three is selectable, explained, and reaches
  // the server; an untouched save leaves an explicit timing alone.
  await clickRow(page, DAILY, 'edit');
  await page.waitForSelector('[data-cron-prompt]', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const field = document.querySelector('[data-cron-prompt]');
    return field instanceof HTMLTextAreaElement && field.disabled === false;
  }, null, { timeout: 30_000 }).catch(() => { errors.push(`${tag}: the prompt box never became editable`); });
  const openedMode = await page.locator('[data-cron-delivery] [role="radio"][aria-checked="true"]').getAttribute('data-cron-delivery-mode');
  if (openedMode !== 'queue') errors.push(`${tag}: the editor opened on "${openedMode}", expected the task's own queue`);
  await page.locator('[data-cron-delivery-mode="steer"]').click();
  const hint = await page.locator('[data-cron-delivery-hint]').innerText();
  if (hint.trim() === '') errors.push(`${tag}: the delivery timing carries no explanation`);
  await shot(page, `editor-delivery-${tag}`);
  await page.locator('[data-cron-save]').click();
  await page.waitForSelector('[data-cron-editor-title]', { state: 'detached', timeout: 20_000 })
    .catch(() => { errors.push(`${tag}: saving a timing change did not close the editor`); });
  const steered = (await (await api(`/cron/${DAILY}`)).json()).data.task;
  if (steered.delivery_mode !== 'steer') errors.push(`${tag}: the chosen timing was stored as "${steered.delivery_mode}"`);
  const steeredRow = page.locator(`[data-cron-task="${DAILY}"] [data-cron-delivery]`);
  if (await steeredRow.getAttribute('data-cron-delivery') !== 'steer') {
    errors.push(`${tag}: the row still reads "${await steeredRow.getAttribute('data-cron-delivery')}" after the change`);
  }
  await page.waitForFunction((id) => {
    const chip = document.querySelector(`[data-cron-task="${id}"] [data-cron-delivery]`);
    return chip?.getAttribute('data-cron-delivery') === 'steer';
  }, DAILY, { timeout: 20_000 }).catch(() => { errors.push(`${tag}: the list never settled on the new timing`); });
  await shot(page, `delivery-changed-${tag}`);

  // A task from before timing existed reports no mode. It must read as the
  // default rather than as a mode the server never claimed, and the editor
  // must say the server has none to keep.
  const legacyRow = page.locator(`[data-cron-task="${WORKSPACE_TASK}"] [data-cron-delivery]`);
  if (await legacyRow.getAttribute('data-cron-delivery') !== 'idle') {
    errors.push(`${tag}: a task with no recorded timing reads "${await legacyRow.getAttribute('data-cron-delivery')}"`);
  }
  await clickRow(page, WORKSPACE_TASK, 'edit');
  await page.waitForSelector('[data-cron-delivery]', { timeout: 30_000 })
    .catch(() => { errors.push(`${tag}: the editor has no delivery timing control`); });
  if (await page.locator('[data-cron-delivery-unsupported]').count() !== 1) {
    errors.push(`${tag}: a host reporting no timing did not say so in the editor`);
  }
  await shot(page, `editor-legacy-${tag}`);
  await page.locator('[data-cron-cancel]').click();
  await page.waitForSelector('[data-cron-editor-title]', { state: 'detached', timeout: 20_000 })
    .catch(() => { errors.push(`${tag}: cancelling the legacy editor did not close it`); });

  // Edit: a complex rule opens on its own text and survives a save.
  // The row is scrolled into view first: an HMR reload from a concurrent
  // editor can otherwise leave the click target outside the viewport.
  await clickRow(page, COMPLEX, "edit");
  await page.waitForSelector('[data-cron-advanced-input]', { timeout: 30_000 })
    .catch(() => { errors.push(`${tag}: a rule with no plain name did not open on the expression`); });
  const advanced = await page.locator('[data-cron-advanced-input]').inputValue();
  if (advanced !== '5,25 9,17 * * *') errors.push(`${tag}: the editor rewrote the rule to "${advanced}"`);
  await shot(page, `editor-advanced-${tag}`);
  await page.locator('[data-cron-save]').click();
  await page.waitForSelector('[data-cron-editor-title]', { state: 'detached', timeout: 20_000 })
    .catch(() => { errors.push(`${tag}: saving an untouched complex rule did not close the editor`); });
  const after = (await (await api(`/cron/${COMPLEX}?session_id=${(await (await api('/cron')).json()).data.items.find((t) => t.id === COMPLEX).session_id}`)).json()).data.task;
  if (after.cron !== '5,25 9,17 * * *') errors.push(`${tag}: saving rewrote the complex rule to "${after.cron}"`);
  if (after.id !== COMPLEX) errors.push(`${tag}: editing replaced the task id`);

  // A refused save keeps the draft and the panel, and says what to do.
  await clickRow(page, DAILY, "edit");
  await page.waitForSelector('[data-cron-prompt]', { timeout: 15_000 });
  await page.locator('[data-cron-prompt]').fill('换一条提示词，看看保存失败时草稿还在不在。');
  await control({ action: 'cron_fail_next_write' });
  await page.locator('[data-cron-save]').click();
  await page.waitForSelector('[data-cron-submit-error]', { timeout: 20_000 })
    .catch(() => { errors.push(`${tag}: a refused save did not surface an error`); });
  const keptDraft = await page.locator('[data-cron-prompt]').inputValue();
  if (!keptDraft.startsWith('换一条提示词')) errors.push(`${tag}: the refused save lost the draft ("${keptDraft.slice(0, 20)}")`);
  if (await page.locator('[data-cron-editor-title]').count() === 0) errors.push(`${tag}: the refused save closed the editor`);
  await shot(page, `editor-failed-${tag}`);
  await page.locator('[data-cron-cancel]').click();
  await page.waitForSelector('[role="alertdialog"]', { timeout: 10_000 })
    .catch(() => { errors.push(`${tag}: closing a dirty form did not ask first`); });
  await shot(page, `editor-discard-${tag}`);
  await page.locator('[role="alertdialog"] [data-confirm-action="confirm"]').click();

  // Cancel keeps the task exactly as it was.
  const dailyAfter = (await (await api(`/cron/${DAILY}`)).json()).data.task;
  if (dailyAfter.prompt === '换一条提示词，看看保存失败时草稿还在不在。') {
    errors.push(`${tag}: the refused save was written anyway`);
  }

  // Pause and delete stay apart from run-now.
  await clickRow(page, PAUSED, "pause");
  await page.waitForFunction((id) => {
    const node = document.querySelector(`[data-cron-task="${id}"] [data-cron-action="pause"]`);
    return node !== null && node.textContent.trim() === '暂停';
  }, PAUSED, { timeout: 20_000 }).catch(() => { errors.push(`${tag}: resuming the paused task did not settle on its label`); });
  await shot(page, `resumed-${tag}`);
}

try {
  for (const theme of themes) {
    for (const width of widths) {
      // The walk mutates the scenario (it creates, edits and pauses tasks),
      // so a retry always starts from a freshly loaded scenario.
      await control({ action: 'scenario', name: SCENARIO });
      await walkIn({ theme, width }, walk);
    }
  }
  // The other locale, so the schedule vocabulary is exercised in both.
  await control({ action: 'scenario', name: SCENARIO });
  await walkIn({ theme: 'light', width: widths[0], locale: 'en' }, async (page, tag) => {
    await openCron(page);
    const hourly = await scheduleOf(page, HOURLY);
    if (hourly !== 'Every hour on the hour') errors.push(`${tag}: the English schedule reads "${hourly}"`);
    await shot(page, `list-${tag}`);
  }, 'en');
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
