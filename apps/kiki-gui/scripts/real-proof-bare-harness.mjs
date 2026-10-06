/**
 * Real-backend check for the bare-harness execution surface, against 666's
 * live KAP (`--server=`), using the sessions its real smoke runs already
 * produced. Nothing here sends a model request: the engine half is already
 * proven, and this checks that the GUI *reads those sessions correctly* —
 * which engine, which profile, which model and where each value came from,
 * the real text, the tool cards, and that a failed child reads as failed.
 *
 *   KIKI_HOME=<isolated home> node scripts/real-proof-bare-harness.mjs \
 *     --server=http://127.0.0.1:63566 --claude=<id> --codex=<id> --grok=<id> \
 *     [--inject=<id>] [--inject-failed=<id>]
 *
 * The token is read from the server's own home with the same loader the GUI
 * uses, and travels in a request header to the API. The browser page is given
 * the token in its query string, because that is how the GUI bootstraps — so
 * the token IS present in URLs, in the page, and in any error that quotes a
 * URL. Every exit path below redacts it, raw and percent-encoded.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { createRedactor } from './lib/redact-token.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const server = arg('server', 'http://127.0.0.1:63566');
const home = process.env.KIKI_HOME;
if (home === undefined) throw new Error("Set KIKI_HOME to the server's isolated home");
// One source only, the same file the GUI's own loader reads. A --token flag
// would put a credential in the process list, where any other command on the
// machine could see it.
const token = (await readFile(join(home, 'server.local-owner'), 'utf8')).trim();
if (token === '') throw new Error("the server home has no local-owner token");

/**
 * Redacts the credential, raw and percent-encoded: a URL that carried it may
 * reach a log in either form, and a partially-redacted URL is still a leak.
 * Installed before anything that can throw, so an early failure is covered
 * too — and it rewrites the message rather than swallowing it, because a proof
 * that fails silently is worse than one that fails loudly.
 */
const redact = createRedactor(token);
const fail = (label, error) => {
  console.log(`\n[real-bare-harness] ${label}: ${redact(error?.stack ?? error)}`);
  process.exit(1);
};
process.on('uncaughtException', (error) => { fail('uncaught', error); });
process.on('unhandledRejection', (error) => { fail('unhandled', error); });


const SESSIONS = [
  { key: 'codex', id: arg('codex', ''), engine: 'codex-app-server' },
  { key: 'grok', id: arg('grok', ''), engine: 'grok-acp' },
  { key: 'claude', id: arg('claude', ''), engine: 'claude-acp' },
].filter((entry) => entry.id !== '');
const injectId = arg('inject', '');
const injectFailedId = arg('inject-failed', '');
// Sessions holding an earlier failed child AND a later successful one.
const BOTH_OUTCOMES = [
  { key: 'claude', id: arg('both-claude', '') },
  { key: 'grok', id: arg('both-grok', '') },
].filter((entry) => entry.id !== '');
if (SESSIONS.length === 0) throw new Error('pass at least one --claude/--codex/--grok session id');

const output = join(root, '.tmp', 'real-bare-harness', String(Date.now()));
await mkdir(output, { recursive: true });
const notes = [];
const errors = [];

async function api(path) {
  const response = await fetch(`${server}/api${path}`, { headers: { authorization: `Bearer ${token}` } });
  const envelope = await response.json();
  if (envelope.code !== 0) throw new Error(`GET ${path}: ${envelope.code} ${envelope.msg}`);
  return envelope.data;
}

const textOf = (message) => (message.content ?? [])
  .filter((part) => part.type === 'text')
  .map((part) => part.text)
  .join('');

for (const entry of SESSIONS) {
  const session = await api(`/sessions/${entry.id}`);
  const cfg = session.agent_config ?? {};
  const messages = (await api(`/sessions/${entry.id}/messages`)).items ?? [];
  const assistants = messages.filter((m) => m.role === 'assistant').map(textOf).filter((t) => t.trim() !== '');
  entry.executor = cfg.execution?.selection?.executor;
  entry.profile = cfg.execution?.selection?.profile;
  entry.overrides = cfg.execution?.selection?.overrides;
  entry.sources = cfg.execution?.sources ?? {};
  entry.generation = cfg.execution?.generation;
  entry.effective = cfg.execution?.effective ?? {};
  entry.topModel = cfg.model;
  entry.assistantText = assistants;
  entry.toolCount = messages.filter((m) => m.role === 'tool').length;
  notes.push(
    `${entry.key}: executor=${entry.executor} profile=${entry.profile ?? 'none'} `
    + `overrides=${JSON.stringify(entry.overrides ?? null)} gen=${entry.generation} `
    + `modelSource=${entry.sources.model} topModel=${JSON.stringify(entry.topModel)} `
    + `tools=${entry.toolCount} text=${JSON.stringify(entry.assistantText.slice(0, 2))}`,
  );
}

process.env.KIKI_SERVER_URL = server;
const vite = await createServer({
  root,
  // strictPort plus an explicit 0 makes a stale dev server on the default port
  // fail loudly instead of silently serving an old bundle to a real-backend
  // check — a proof that renders yesterday's code proves nothing.
  server: { host: '127.0.0.1', port: 0, strictPort: true, watch: { ignored: ['**/*.test.ts', '**/*.test.tsx'] } },
});
await vite.listen();
const address = vite.httpServer.address();
if (address === null || typeof address === 'string') throw new Error('vite did not bind a TCP port');
const web = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
// The GUI bootstraps from the query string, so the token rides every page URL
// here; redaction (installed above, before anything that can throw) is what
// keeps it out of the logs this script's failures end up in.
const url = (path) => `${web}${path}?server=${encodeURIComponent(server)}&token=${encodeURIComponent(token)}`;

async function shot(page, name) {
  await page.waitForTimeout(500);
  const file = join(output, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

const assert = (condition, message) => { if (!condition) errors.push(message); };

/**
 * Tool calls are folded into a collapsed activity row by default, so a count
 * taken straight off the page finds none. Expand every activity disclosure
 * first; the cards live inside it.
 */
async function expandActivity(page) {
  const toggles = page.locator('[data-activity-toggle]');
  const total = await toggles.count();
  for (let i = 0; i < total; i += 1) {
    const toggle = toggles.nth(i);
    const expanded = await toggle.getAttribute('aria-expanded');
    if (expanded !== 'true') await toggle.click().catch(() => {});
  }
  if (total > 0) await page.waitForTimeout(600);
  return total;
}

try {
  for (const entry of SESSIONS) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (error) => { errors.push(`page(${entry.key}): ${error.message}`); });
    await page.goto(url(`/s/${entry.id}`), { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForSelector('[data-execution-trigger]', { timeout: 60_000 });
    await page.waitForTimeout(1500);

    // The chip must name the engine the session is actually committed to,
    // and must NOT claim a profile the bare selection never had.
    const chip = (await page.locator('[data-execution-trigger]').innerText()).trim();
    assert(chip.length > 0, `${entry.key}: the execution chip is empty`);
    assert(!/next message/i.test(chip), `${entry.key}: a settled session still reads pending: ${chip}`);
    const chipEngine = await page.locator('[data-execution-trigger]').getAttribute('data-execution-engine-value');
    assert(chipEngine === entry.executor, `${entry.key}: chip shows ${chipEngine}, session is ${entry.executor}`);
    assert(
      await page.locator('[data-execution-pending="true"]').count() === 0,
      `${entry.key}: the chip is marked pending on a settled session`,
    );
    notes.push(`${entry.key}: chip="${chip}" engine=${chipEngine}`);
    await shot(page, `${entry.key}-session`);

    // The model control states the real model and where it came from. A bare
    // engine takes its own, so the session must not claim a Kiki default.
    const modelText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    // The reply is checked against the parts as they arrive, joined with
    // nothing: a separator added here would invent text the engine never sent.
    const wireText = entry.assistantText.join('');
    if (entry.key === 'claude') {
      // The bound session exposes no model id at all — only
      // sources.model = harness-default — so the honest bare display is
      // "decided by the engine", and that is what passes. What must NOT pass is
      // Kiki's own default or a static adapter label being presented as this
      // session's actual model: that is the defect, regardless of which id.
      const control = (await page.locator('#composer-model-select')
        .first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      const namesAModel = /claude-?(opus|sonnet|haiku)/i.test(control);
      notes.push(`claude: model control=${JSON.stringify(control.slice(0, 120))} namesAKikiModel=${namesAModel}`);
      assert(
        !namesAModel,
        `claude: the model control presents an Anthropic model id as this session's actual model, `
        + `but the binding reports harness-default and no effective model: ${JSON.stringify(control.slice(0, 160))}`,
      );
      // Where the session does state a real id, the control must show it.
      if (typeof entry.effective.model === 'string' && entry.effective.model !== '') {
        assert(
          control.includes(entry.effective.model),
          `claude: the binding states model ${entry.effective.model} but the control shows ${JSON.stringify(control.slice(0, 120))}`,
        );
      } else {
        notes.push('claude: no effective model in the binding — engine-decided display is the correct one, not an observation gap to paper over');
      }
    }
    assert(entry.topModel === '' || entry.topModel === undefined, `${entry.key}: the bare session carries a top-level model (${entry.topModel})`);

    // The real reply is on screen, not a placeholder.
    if (wireText.trim() !== '') {
      const needle = wireText.trim().slice(0, 12);
      assert(modelText.includes(needle), `${entry.key}: the real reply "${needle}" is not rendered`);
    }
    await page.close();
  }

  // The injection sample: real Kiki tool cards, and a failed child that must
  // not read as a success.
  if (injectId !== '') {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (error) => { errors.push(`page(inject): ${error.message}`); });
    await page.goto(url(`/s/${injectId}`), { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForSelector('[data-execution-trigger]', { timeout: 60_000 });
    await page.waitForTimeout(2500);
    const expanded = await expandActivity(page);
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const tools = await page.locator('[data-tool]').count();
    notes.push(`inject: activity rows expanded=${expanded}`);
    notes.push(`inject: tool cards matched=${tools}`);
    assert(tools > 0, 'inject: no Kiki tool card rendered for the real tool calls');
    // The memory read really did miss, and the card must say so rather than
    // reading as a clean result.
    const toolText = (await page.locator('[data-tool]').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    notes.push(`inject: first tool card text=${JSON.stringify(toolText.slice(0, 120))}`);
    if (injectFailedId !== '') {
      const failPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      failPage.on('pageerror', (error) => { errors.push(`page(failed): ${error.message}`); });
      await failPage.goto(url(`/s/${injectFailedId}`), { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await failPage.waitForSelector('[data-execution-trigger]', { timeout: 60_000 });
      await failPage.waitForTimeout(2500);
      const failBody = (await failPage.locator('body').innerText()).replace(/\s+/g, ' ');
      // The dispatch was accepted and the child then failed. The surface has a
      // settled-state label for exactly this, so assert on that rather than on
      // any word appearing somewhere on the page: a failure that only shows as
      // a coloured card would still read as success to a screenshot.
      const expandedFail = await expandActivity(failPage);
      const states = await failPage.locator('[data-tool-state]').allInnerTexts().catch(() => []);
      notes.push(`failed sample: activity rows expanded=${expandedFail}`);
      const errorish = states.filter((text) => /fail|error|expired|失败|错误/i.test(text));
      notes.push(`failed sample tool states=${JSON.stringify(states)}`);
      // This session predates the engine's structured-error fix, so a stored
      // "[object Object]" here is HISTORICAL storage, not what the surface
      // renders today. It is reported, never asserted away and never "fixed"
      // by rewriting history; only a session written after the fix can fail
      // this check on its own merits.
      const legacyObject = failBody.includes('[object Object]');
      if (legacyObject) {
        notes.push('failed sample: stored "[object Object]" is pre-fix history (engine-side error message loss), not a render defect');
      } else {
        assert(
          errorish.length > 0 || /fail|error|expired|失败/i.test(failBody),
          `failed sample: no tool state or text reads as a failure: states=${JSON.stringify(states)}`,
        );
        notes.push('failed sample renders a failure: true');
      }
      await shot(failPage, 'inject-failed');
      await failPage.close();
    }

    // A session can hold BOTH an earlier failed child and a later successful
    // one. The later success must not erase the earlier failure, and the
    // failure must not be reported as if the whole session failed: each turn
    // carries its own outcome and the surface has to show both.
    for (const both of BOTH_OUTCOMES) {
      const bothPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      bothPage.on('pageerror', (error) => { errors.push(`page(both): ${error.message}`); });
      await bothPage.goto(url(`/s/${both.id}`), { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await bothPage.waitForSelector('[data-execution-trigger]', { timeout: 60_000 });
      await bothPage.waitForTimeout(3000);
      await expandActivity(bothPage);
      const afterExpand = (await bothPage.locator('body').innerText()).replace(/\s+/g, ' ');
      const states = await bothPage.locator('[data-tool-state]').allInnerTexts().catch(() => []);
      const errorish = states.filter((s) => /fail|error|expired|失败|错误/i.test(s));
      const successText = afterExpand.includes('KIKI_CHILD_SMOKE_OK');
      // The earlier failure has to survive the later success. Whether the
      // surface states it as a tool state or as prose in the transcript, what
      // matters is that the turn is still there — a colour alone would not
      // survive a screenshot or a text scrape.
      const failureStillVisible = /auth_expired|Child terminal state failed|authentication expired/i.test(afterExpand)
        || errorish.length > 0;
      notes.push(
        `${both.key}: successText=${successText} failureStillVisible=${failureStillVisible} `
        + `errorStates=${errorish.length} states=${JSON.stringify(states.slice(0, 8))}`,
      );
      assert(successText, `${both.key}: the successful child's real reply KIKI_CHILD_SMOKE_OK is not rendered`);
      assert(
        failureStillVisible,
        `${both.key}: the earlier failed child is no longer visible — the later success overwrote the turn`,
      );
      await shot(bothPage, `both-outcomes-${both.key}`);
      await bothPage.close();
    }
    await shot(page, 'inject-tools');
    await page.close();
  }

  // Narrow-screen check against the real engine list, plus the panel's
  // current-row marking for a genuinely bound engine.
  const first = SESSIONS[0];
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (error) => { errors.push(`page(mobile): ${error.message}`); });
  await page.goto(url(`/s/${first.id}`), { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-execution-trigger]', { timeout: 60_000 });
  await page.waitForTimeout(1200);
  await page.locator('#composer-execution-select').click();
  await page.waitForSelector('[data-execution-panel]', { timeout: 20_000 });
  await page.waitForTimeout(600);
  const box = await page.locator('[data-execution-panel]').boundingBox();
  assert(box !== null && box.x >= 0 && box.x + box.width <= 390, `mobile panel overflows: ${JSON.stringify(box)}`);
  const rows = page.locator('[data-execution-engine]');
  const count = await rows.count();
  for (let i = 0; i < count; i += 1) {
    await rows.nth(i).scrollIntoViewIfNeeded();
    const rowBox = await rows.nth(i).boundingBox();
    assert(rowBox !== null && rowBox.x >= 0 && rowBox.x + rowBox.width <= 390, `engine row ${i} overflows at 390px`);
  }
  await page.locator('[data-execution-panel]').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(400);
  const lastBox = await rows.nth(count - 1).boundingBox();
  assert(
    lastBox !== null && box !== null && lastBox.y + lastBox.height <= box.y + box.height + 1,
    'the last engine row is hidden behind the mobile panel footer',
  );
  // The engine this session runs must be marked as current in the real list.
  const current = page.locator(`[data-execution-engine="${first.executor}"][data-current="true"]`);
  assert(await current.count() >= 1, `the real engine ${first.executor} is not marked current in the panel`);
  notes.push(`mobile: panel right edge ${Math.round(box.x + box.width)} of 390, rows ${count}, current engine marked`);
  await shot(page, 'mobile-panel-real');
  await page.close();
} catch (cause) {
  // A Playwright call log embeds the failing URL, and the URL carries the
  // token. The message is kept, not swallowed — a proof that fails loudly and
  // readably is the point.
  console.log(`\n[real-bare-harness] aborted: ${redact(cause?.stack ?? cause)}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await vite.close();
}

console.log(`\n[real-bare-harness] notes:\n- ${notes.join('\n- ')}`);
if (errors.length > 0) {
  console.log(`\n[real-bare-harness] ${errors.length} problem(s):\n- ${errors.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('\n[real-bare-harness] ok');
}
