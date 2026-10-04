/**
 * Bounded-content continuation proof — one scenario, walked at 1440 and 390.
 *
 * It runs the shared proof runner with its own output and build directories, so
 * nothing here touches the shared `.tmp/visual-proof/dist` or the goldens:
 *
 *   KIKI_PROOF_OUTPUT_DIR=<dir>   screenshots (runner reads it)
 *   KIKI_PROOF_DIST_DIR=<dir>     this proof's build
 *   node scripts/visual-proof-content-continuation.mjs --matrix=all
 *
 * Every body is served by the fixture through the production `boundedEntity`
 * and `readContentSegment` functions over the real
 * `POST /api/klient/session-view/:id/transcript/content` route, so the screens
 * show the contract reached over HTTP. The error press is the one deliberate
 * exception: the browser fails that single request so the retry path can be
 * shown without a second fixture knob.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_ID = 'session_fixture_content_bounded';
const STEP_TIMEOUT = 20_000;

function fail(message) {
  throw new Error(message);
}

async function selectSession(page, link) {
  await openSession(page, link);
}

async function expandTool(page, toolCallId) {
  const row = page.locator(`[data-tool-id="${toolCallId}"]`).first();
  await row.waitFor({ timeout: STEP_TIMEOUT });
  // The row's own disclosure: the summary may hold other buttons (a file path
  // link, a copy button), so target the one that reports its expanded state.
  await row.locator('button[aria-expanded]').first().click();
}

/**
 * Open the session by its own route: the deep link carries the fixture origin,
 * and the walk does not depend on the sidebar (off-canvas at 390).
 */
async function openSession(page, link) {
  await page.goto(link(`/s/${SESSION_ID}`), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-transcript-scroll]', { timeout: STEP_TIMEOUT });
}

/**
 * Rows the timeline settled arrive folded (history folds, read/tool runs).
 * Open every collapsed fold until `selector` is on the page: the walk needs the
 * bodies themselves, not the summaries.
 */
async function reveal(page, selector) {
  for (let round = 0; round < 5; round += 1) {
    if (await page.locator(selector).count() > 0) return;
    const collapsed = page.locator('[data-history-fold] button[aria-expanded="false"], [data-read-run] button[aria-expanded="false"]');
    const count = await collapsed.count();
    for (let index = 0; index < count; index += 1) {
      await collapsed.nth(index).click({ timeout: 5_000 }).catch(() => undefined);
    }
    await page.waitForTimeout(300);
    if (count === 0) return;
  }
}

function bodyRow(page, toolCallId) {
  return page.locator(`[data-tool-id="${toolCallId}"] [data-content-continuation]`);
}

function bodyAction(page, toolCallId) {
  return page.locator(`[data-tool-id="${toolCallId}"] [data-content-continuation-action]`);
}

/** Wait until a body's own row reports at least this share of its field. */
async function waitForPercent(page, toolCallId, minimum) {
  await page.waitForFunction(
    ({ id, floor }) => {
      const node = document.querySelector(`[data-tool-id="${id}"] [data-content-continuation-progress]`);
      if (node === null) return false;
      const match = /(\d+)%/.exec(node.textContent ?? '');
      return match !== null && Number(match[1]) >= floor;
    },
    { id: toolCallId, floor: minimum },
    { timeout: STEP_TIMEOUT },
  );
}

async function progressText(page, toolCallId) {
  return (await page.locator(`[data-tool-id="${toolCallId}"] [data-content-continuation-progress]`).first().textContent()) ?? '';
}

/** Share of a text field already read, as the row prints it. */
function percentOf(text) {
  const match = /(\d+)%/.exec(text ?? '');
  return match === null ? Number.NaN : Number(match[1]);
}

async function walk({ page, shot, link }, prefix = '') {
  // Both jobs share one runner view (en/light), so the narrow job needs its own
  // file names rather than relying on a view suffix it does not have.
  const snap = (name) => shot(`${prefix}${name}`);
  const contentRequests = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/transcript/content')) contentRequests.push(request.url());
  });

  await selectSession(page, link);
  await page.waitForSelector('[data-content-continuation]', { timeout: STEP_TIMEOUT });

  // Closed bodies say nothing: only the turn whose step list was cut offers a
  // control on the first screen, and it names its own count.
  const firstScreen = await page.locator('[data-content-continuation]').count();
  if (firstScreen !== 1) fail(`expected only the cut turn to offer a control, found ${firstScreen} rows`);
  const firstScreenText = await page.locator('[data-content-continuation]').first().textContent();
  if (!/4 \/ 8/.test(firstScreenText ?? '')) fail(`the cut turn should read as 4 / 8 steps, read "${firstScreenText}"`);
  await snap('content-continuation-first-screen');

  // --- tool output: one press, one request, only this body grows ---
  // Settled rows arrive folded; open them so both bodies are on screen.
  await reveal(page, '[data-tool-id="read-big"]');
  await expandTool(page, 'read-big');
  await bodyRow(page, 'read-big').waitFor({ timeout: STEP_TIMEOUT });
  const start = await progressText(page, 'read-big');
  const startPercent = percentOf(start);
  if (!(startPercent > 0 && startPercent < 40)) fail(`a 40 KiB body should open with only a share read, read "${start}"`);

  const virtualBefore = await page.locator('[data-transcript-virtual-item]').count();
  // Bring the control into view first: a click that has to scroll would read
  // as if the append had moved the page.
  await bodyAction(page, 'read-big').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const anchorBefore = await page.evaluate(() => document.querySelector('[data-transcript-scroll]')?.scrollTop ?? 0);
  // Press until the last segment lands: each press must be exactly one
  // request, and a press that leaves the row in place must have grown it.
  let presses = 0;
  let lastPercent = startPercent;
  while (presses < 8) {
    if (await bodyRow(page, 'read-big').count() === 0) break;
    const before = contentRequests.length;
    await bodyAction(page, 'read-big').click();
    await page.waitForTimeout(600);
    if (contentRequests.length !== before + 1) {
      fail(`one press must read exactly one segment, press ${presses + 1} made ${contentRequests.length - before} requests`);
    }
    presses += 1;
    if (await bodyRow(page, 'read-big').count() === 0) break;
    lastPercent = percentOf(await progressText(page, 'read-big'));
    if (!(lastPercent > startPercent)) fail(`a segment must grow the body, ${startPercent}% → ${lastPercent}%`);
    if (presses === 1) {
      const scrollAfter = await page.evaluate(() => document.querySelector('[data-transcript-scroll]')?.scrollTop ?? 0);
      // The reader stays where they were: the appended text grows below the
      // control, and the anchor must not jump to the bottom of the list.
      if (Math.abs(scrollAfter - anchorBefore) > 120) {
        fail(`an append moved the reader's anchor by ${Math.abs(scrollAfter - anchorBefore)}px`);
      }
      const stillVisible = await bodyAction(page, 'read-big').isVisible();
      if (!stillVisible) fail('the control scrolled out of the reading position after one segment');
      await snap('content-continuation-after-one-press');
    }
  }
  await bodyRow(page, 'read-big').waitFor({ state: 'detached', timeout: STEP_TIMEOUT });
  await snap('content-continuation-complete');
  const virtualAfter = await page.locator('[data-transcript-virtual-item]').count();
  const notes = [`tool output ${start.trim()} → last share ${lastPercent}% → retired after ${presses} presses (virtual rows ${virtualBefore} → ${virtualAfter})`];

  // --- the shell card's command line: a long script, read as tool args ---
  // This is the frame-sourced args case, and the card that holds it is a
  // shell card, not a tool card. The walk opens the real one (the first shell
  // card is the script; the second is the task tail) and asserts the control
  // is on the paper below the island.
  // Settled rows arrive folded, so the script may not be on the page yet: open
  // the folds first, then the card itself (the card that holds the full
  // command line is the one that expanded).
  // Name the script by its own command in the collapsed header: the other shell
  // card in this session is the task tail, and both are shell cards.
  const scriptCard = page.locator('[data-shell]').filter({ hasText: 'echo' }).first();
  await scriptCard.waitFor({ timeout: STEP_TIMEOUT });
  // The card's own row toggle; the header also carries a copy button and a
  // path link, so the toggle is named rather than "the first button".
  // A settled shell card may already be open (a fold revealed it); open it only
  // when the full command line is not on the page, so this is idempotent.
  if (await scriptCard.locator('[data-shell-command-full]').count() === 0) {
    await scriptCard.locator('[data-activity-toggle]').click();
  }
  await scriptCard.locator('[data-shell-command-full]').waitFor({ timeout: STEP_TIMEOUT });
  // The command row is one of the card's own continuation rows; the tool's
  // output row of the same card (if any) must not be mistaken for it.
  const commandRow = scriptCard.locator('[data-continuation-kind="content"]').filter({ hasText: 'Command' }).first();
  await commandRow.waitFor({ timeout: STEP_TIMEOUT });
  // The control sits on the paper below a long island, so the shot is taken
  // with the row itself in view, and the press comes after it.
  await commandRow.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await snap('content-continuation-command');
  // Reading this ref's last segment retires its row, so the script's own
  // length is the evidence that the body grew.
  const commandBefore = (await scriptCard.locator('[data-shell-command-full]').textContent() ?? '').length;
  const requestsBeforeCommand = contentRequests.length;
  await commandRow.locator('[data-content-continuation-action]').click();
  await page.waitForTimeout(600);
  if (contentRequests.length !== requestsBeforeCommand + 1) {
    fail(`the command line must read exactly one segment, made ${contentRequests.length - requestsBeforeCommand} requests`);
  }
  const commandAfter = (await scriptCard.locator('[data-shell-command-full]').textContent() ?? '').length;
  if (!(commandAfter > commandBefore)) fail(`a command segment must grow the script, ${commandBefore} → ${commandAfter} chars`);

  // --- structure: the turn's own step list, addressed by the turn it names ---
  const stepsAction = page.locator('[data-content-continuation]').filter({ hasText: '4 / 8' }).first().locator('[data-content-continuation-action]');
  await stepsAction.waitFor({ timeout: STEP_TIMEOUT });
  const requestsBeforeSteps = contentRequests.length;
  await stepsAction.click();
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('[data-content-continuation-progress]')];
    return rows.every((row) => !/4 \/ 8/.test(row.textContent ?? ''));
  }, undefined, { timeout: STEP_TIMEOUT });
  if (contentRequests.length !== requestsBeforeSteps + 1) {
    fail(`the step continuation must read exactly one page, made ${contentRequests.length - requestsBeforeSteps} requests`);
  }
  await page.waitForTimeout(400);
  await snap('content-continuation-steps');

  // --- the shell card: a task tail, read through the task that owns it ---
  const taskShell = page.locator('[data-shell]').filter({ hasText: 'pnpm build' }).first();
  await taskShell.locator('[data-activity-toggle]').click();
  const shellRow = taskShell.locator('[data-content-continuation]');
  await shellRow.waitFor({ timeout: STEP_TIMEOUT });
  const shellProgress = (await taskShell.locator('[data-content-continuation-progress]').first().textContent()) ?? '';
  if (!(percentOf(shellProgress) > 0)) fail(`the shell task tail should report a share read, read "${shellProgress}"`);
  await snap('content-continuation-shell');

  // --- failure: the body stays, the row reports it, the retry reads again ---
  let failNext = true;
  await page.route('**/transcript/content', async (route) => {
    if (!failNext) { await route.continue(); return; }
    failNext = false;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 50001, msg: 'fixture refuses one segment', data: null, request_id: 'fixture-fail' }),
    });
  });
  const taskBody = taskShell.locator('pre').first();
  const bodyBefore = (await taskBody.textContent()) ?? '';
  await taskShell.locator('[data-content-continuation-action]').first().click();
  await taskShell.locator('[data-content-continuation][data-content-continuation="error"]').waitFor({ timeout: STEP_TIMEOUT });
  const alert = (await taskShell.locator('[role="alert"]').first().textContent()) ?? '';
  const bodyAfter = (await taskBody.textContent()) ?? '';
  if (bodyAfter !== bodyBefore) fail('a failed segment read must leave the shown body untouched');
  await snap('content-continuation-error');
  await taskShell.locator('[data-content-continuation-action]').first().click();
  await shellRow.waitFor({ state: 'detached', timeout: STEP_TIMEOUT });
  await page.unroute('**/transcript/content');
  notes.push(`shell tail kept its body on failure and reported "${alert.trim()}"`);

  // --- the session's own remainder: one root field the header shows ---
  // The header's own title is the one inside the session header; the sidebar
  // row with the same data attribute is a different element (it showed the
  // full title even while the header held the 512-char preview).
  const headerTitle = page.locator('h1 [data-session-title]').first();
  const remainderToggle = page.locator('[data-session-remainder-toggle]').first();
  await remainderToggle.waitFor({ timeout: STEP_TIMEOUT });
  const titleBefore = (await headerTitle.textContent() ?? '').length;
  if (!(titleBefore > 0 && titleBefore < 1400)) fail(`a cut session title should open as a preview, read ${titleBefore} chars`);
  await remainderToggle.click();
  const sessionRow = page.locator('[data-continuation-kind="session"]').first();
  await sessionRow.waitFor({ timeout: STEP_TIMEOUT });
  const sessionProgress = (await sessionRow.locator('[data-content-continuation-progress]').textContent() ?? '').trim();
  if (!/Session info/.test(sessionProgress)) fail(`the remainder row should name what it reads, read "${sessionProgress}"`);
  await snap('content-continuation-remainder-open');
  const requestsBeforeRoot = contentRequests.length;
  await sessionRow.locator('[data-content-continuation-action]').click();
  await page.waitForTimeout(700);
  if (contentRequests.length !== requestsBeforeRoot + 1) {
    fail(`one root press must read exactly one segment, made ${contentRequests.length - requestsBeforeRoot} requests`);
  }
  const titleAfter = (await headerTitle.textContent() ?? '').length;
  if (!(titleAfter > titleBefore)) fail(`a root segment must grow the header title, ${titleBefore} → ${titleAfter} chars`);
  // The last segment retires the row: nothing left that the reader would see.
  await page.waitForFunction(() => document.querySelectorAll('[data-continuation-kind="session"]').length === 0,
    undefined, { timeout: STEP_TIMEOUT });
  await snap('content-continuation-remainder');
  notes.push(`root title ${titleBefore} → ${titleAfter} chars, then the row retired`);
  console.log(`[note] ${notes.join(' | ')}`);
}

/** The same walk at phone width: the keys are the remainder row and the error. */
async function walkNarrow(context) {
  await context.page.setViewportSize({ width: 390, height: 844 });
  return walk(context, 'narrow-');
}

export const scenarios = [
  {
    name: 'content-continuation',
    fixture: 'content-continuation',
    matrix: ['width'],
    run: walk,
  },
  {
    name: 'content-continuation-narrow',
    fixture: 'content-continuation',
    matrix: [],
    run: walkNarrow,
  },
];

async function main() {
  const { failed, outputDir } = await runProof({
    root: ROOT,
    scenarios,
    argv: process.argv.slice(2),
    label: 'content-continuation',
  });
  console.log(`[content-continuation] screenshots: ${outputDir}`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
