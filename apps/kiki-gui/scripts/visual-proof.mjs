/**
 * kiki-gui visual proof — boots the fixture server + the vite dev server,
 * drives the real GUI with playwright chromium through every fixture
 * scenario, and writes screenshots to an ignored disposable directory by
 * default. The app contains zero fixture-specific code paths: it connects to
 * the fixture server exactly like a real kap-server (deep link with server URL
 * + fixture token).
 *
 *   node scripts/visual-proof.mjs                         # disposable full walk
 *   node scripts/visual-proof.mjs --only=reconnect        # disposable subset
 *   node scripts/visual-proof.mjs --update-goldens        # replace tracked goldens
 */

import { spawn, execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';
import { selectProofOutput } from './visual-proof-options.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURE_PORT = Number(process.env.KIKI_PROOF_FIXTURE_PORT ?? 58901);
const WEB_PORT = Number(process.env.KIKI_PROOF_WEB_PORT ?? 5179);
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function control(action) {
  const response = await fetch(`${FIXTURE_URL}/__control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });
  return response.json();
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`server never came up: ${url}`);
    await sleep(300);
  }
}

/**
 * Free a TCP port (Windows: netstat → taskkill; no-op elsewhere — the proof
 * runner is a Windows dev tool). Needed because shell-spawned vite children
 * orphan their grandchild (the actual listener) when killed.
 */
function killPort(port) {
  if (process.platform !== 'win32') return;
  try {
    const out = execSync(`netstat -ano | findstr "127.0.0.1:${port}" & netstat -ano | findstr "[::1]:${port}"`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: 'cmd.exe',
    }).toString();
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid !== undefined && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
    }
    for (const pid of pids) {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' });
      console.log(`[proof] freed port ${port} (pid ${pid})`);
    }
  } catch {
    // findstr exits 1 when nothing matches — the port is free
  }
}

// ---------------------------------------------------------------------------

let page;
const shot = async (name) => {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  console.log(`[shot] ${name}.png`);
};

async function selectSession(titleFragment) {
  const row = page.locator('aside div.group', { hasText: titleFragment }).first();
  await row.waitFor({ timeout: 10_000 });
  await row.click();
  await page.waitForTimeout(800);
}

async function resizeViewport(width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(300);
}

async function sendPrompt(text) {
  await page.fill('textarea', text);
  await page.press('textarea', 'Enter');
  console.log(`[flow] sent: ${text}`);
}

async function approveViaKeyboard() {
  await page.mouse.click(720, 120); // focus out of the textarea
  await page.keyboard.press('y');
}

async function waitForText(text, timeout = 20_000) {
  await page.waitForSelector(`text=${text}`, { timeout });
}

async function displayNodeKinds() {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('[role="log"] [data-block-id]')).map((child) => {
      const id = child.getAttribute('data-block-id') ?? '';
      if (id.startsWith('group-')) return 'group';
      if (id.startsWith('tool-')) return 'tool';
      if (id.startsWith('approval-')) return 'approval';
      if (id.startsWith('question-')) return 'question';
      if (id.startsWith('user-')) return 'user';
      if (id.startsWith('assistant-')) return 'assistant';
      return 'other';
    });
  });
}

// ------------------------------------------------------------- scenarios

async function scenarioBasicStream() {
  await selectSession('Fixture: basic stream');
  await sendPrompt('Run the fixture flow.');
  await waitForText('Here is the fixture answer');
  await page.waitForTimeout(700);
  await shot('basic-stream-streaming');
  await waitForText('Approval needed');
  await page.waitForTimeout(300);
  await shot('basic-stream-approval');
  await approveViaKeyboard();
  await page.waitForSelector('text=working', { state: 'detached', timeout: 30_000 });
  await page.waitForTimeout(1200); // shiki upgrade
  await shot('basic-stream-done');
}

async function scenarioPromptDedupe() {
  await selectSession('Fixture: prompt dedupe');
  await sendPrompt('One prompt, one user block.');
  await waitForText('The prompt appears once.');
  await page.waitForSelector('text=working', { state: 'detached', timeout: 20_000 });
  const userCount = await page.locator('[role="log"] [data-block-id^="user-"]', {
    hasText: 'One prompt, one user block.',
  }).count();
  console.log(`[check] prompt dedupe user blocks: ${userCount}`);
  if (userCount !== 1) throw new Error(`expected exactly one user block, saw ${userCount}`);
  await shot('prompt-dedupe');
}

async function scenarioSubagents() {
  await selectSession('Fixture: subagents');
  await sendPrompt('Delegate the fixture work.');
  await page.waitForSelector('[data-subagent-id="agent-research"]', { timeout: 20_000 });
  await page.waitForSelector('[data-subagent-id="agent-review"]', { timeout: 20_000 });
  await page.waitForSelector('text=working', { state: 'detached', timeout: 20_000 });
  const bubbleCount = await page.locator('[data-subagent-id]').count();
  const inlineToolCount = await page.locator('[role="log"] [data-block-id^="tool-"], [role="log"] [data-block-id^="group-"]').count();
  const railText = await page.locator('.app-rail').innerText();
  console.log(`[check] subagent bubbles=${bubbleCount} inlineTools=${inlineToolCount}`);
  if (bubbleCount !== 2 || inlineToolCount !== 0) {
    throw new Error(`expected 2 subagent bubbles and 0 inline tools, got ${bubbleCount}/${inlineToolCount}`);
  }
  if (!railText.includes('Researcher') || !railText.includes('Reviewer')) {
    throw new Error('subagent rail does not list both agents');
  }
  await shot('subagents-main');
  await page.locator('[data-subagent-id="agent-research"]').click();
  await page.waitForURL(/\/agent\/agent-research$/, { timeout: 10_000 });
  await waitForText('Protocol map complete.');
  await waitForText('Read');
  await page.waitForTimeout(500);
  await shot('subagents-agent-page');
}

async function scenarioGoalSwarm() {
  await selectSession('Fixture: goal + swarm');
  await waitForText('Prepare the release evidence bundle');
  await page.click('button:has-text("swarm")');
  await page.click('button:has-text("goal · active")');
  await page.fill('input[placeholder="Objective (optional)"]', 'Ship the fixture release');
  await page.click('button:has-text("goal · active")');
  await sendPrompt('Advance the release goal.');
  await waitForText('Swarm mode is on and the goal state is live.');
  const inspected = await control({ action: 'session', session_id: 'session_fixture_goal_swarm' });
  const submission = inspected.data?.last_prompt_submission;
  console.log(`[check] goal/swarm submission ${JSON.stringify(submission)}`);
  if (submission?.swarm_mode !== true || submission?.goal_objective !== 'Ship the fixture release') {
    throw new Error('PromptSubmission did not carry swarm_mode + goal_objective');
  }
  await page.click('button:has-text("goal · active")');
  await page.waitForTimeout(400);
  await shot('goal-swarm');
}

async function scenarioToolPipeline() {
  await selectSession('Fixture: tool pipeline');
  await waitForText('Steps · 3');
  await shot('tool-pipeline-grouped');
  // Expand the group, then the Edit card inside it (DiffCard with 2 hunks).
  // NB: target the card by its summary text — the group row itself contains
  // the tool names, so a bare hasText:'Edit' matches the row and re-toggles.
  await page.click('text=Steps · 3');
  await page.waitForTimeout(400);
  // The journaled Edit block has no display payload; its summary is the path —
  // same as Read's, so take the SECOND card carrying it (Read is first).
  await page.locator('button', { hasText: 'C:/fixture/workshop/plan.ts' }).nth(1).click();
  await page.waitForTimeout(400);
  await shot('tool-pipeline-expanded');
  // Live sequence 1: three consecutive tools fold into a group as they run.
  await sendPrompt('Run the tool sequences.');
  await page.waitForFunction(
    async () => {
      const groups = document.querySelectorAll('[role="log"] [data-block-id^="group-"]');
      return groups.length >= 2;
    },
    { timeout: 20_000 },
  );
  // Live sequence 2: tool / approval / tool boundary — approval flushes the group.
  await waitForText('Approval needed');
  await approveViaKeyboard();
  await page.waitForSelector('text=working', { state: 'detached', timeout: 30_000 });
  await page.waitForTimeout(600);
  const kinds = await displayNodeKinds();
  const groups = kinds.filter((k) => k === 'group').length;
  const singleTools = kinds.filter((k) => k === 'tool').length;
  const approvals = kinds.filter((k) => k === 'approval').length;
  console.log(`[check] display nodes: ${kinds.join(', ') || '(none)'}`);
  console.log(`[check] counts groups=${groups} singleTools=${singleTools} approvals=${approvals}`);
  if (groups !== 2 || singleTools < 1 || approvals < 1) {
    console.error('[FAIL] tool grouping sequence did not match expected live nodes');
    process.exitCode = 1;
  }
  await shot('tool-pipeline-live');
}

async function scenarioQuestionCard() {
  await selectSession('Fixture: question card');
  await sendPrompt('Ask me the fixture questions.');
  await waitForText('kiki asks');
  await page.waitForTimeout(400);
  await shot('question-card');
  // single select "Both" + two multi options, then submit
  await page.click('text=Both (Recommended)');
  await page.click('text=Typecheck');
  await page.click('text=Visual proof');
  await page.click('button:has-text("Submit")');
  await page.waitForSelector('text=working', { state: 'detached', timeout: 30_000 });
  await page.waitForTimeout(400);
  await shot('question-card-answered');
}

async function scenarioBusyRail() {
  await selectSession('Fixture: busy rail');
  await waitForText('fixture build (vite)');
  await page.waitForTimeout(500);
  await shot('busy-rail');
}

async function scenarioLongTranscript() {
  await selectSession('Fixture: long transcript');
  await page.waitForSelector('text=Turn 64', { timeout: 15_000 });
  await page.waitForTimeout(600);
  // Jump pill + turns dropdown from the bottom of the log.
  await page.mouse.move(720, 450);
  await page.mouse.wheel(0, -6000);
  await page.waitForTimeout(600);
  await shot('long-transcript-scrolled'); // jump pill visible
  // Paginate to the very top: two pages (14 older messages) + cap.
  for (let i = 0; i < 4; i += 1) {
    await page.mouse.wheel(0, -20000);
    await page.waitForTimeout(900);
  }
  await shot('long-transcript-top');
  // Turn jump dropdown.
  await page.click('button:has-text("turns")');
  await page.waitForTimeout(400);
  await shot('long-transcript-turns');
  await page.keyboard.press('Escape');
}

async function scenarioErrorAbort() {
  await selectSession('Fixture: error + abort');
  await sendPrompt('Run the failing then slow fixture.');
  await waitForText('Approval needed');
  await approveViaKeyboard();
  // The failed Bash + Read cards group and auto-expand on error; the slow
  // stream then starts — abort it mid-flight.
  await waitForText('recovering slowly', 20_000);
  await page.waitForTimeout(500);
  await page.mouse.click(720, 300); // non-editable focus
  await page.keyboard.press('Escape'); // …then aborted mid-stream
  await page.waitForSelector('text=Prompt aborted', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('error-abort');
}

async function scenarioApprovalsGallery() {
  await selectSession('Fixture: approvals gallery');
  await page.waitForSelector('text=ProbeTool', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('approvals-gallery');
  // Resolve the raw-JSON fallback card (last card) to show the outcome line.
  const approve = page.locator('button:has-text("Approve")').nth(4);
  await approve.click();
  await page.waitForTimeout(600);
  await shot('approvals-gallery-resolved');
}

async function scenarioReconnect() {
  await selectSession('Fixture: reconnect');
  await sendPrompt('Start the two-segment stream.');
  await waitForText('Segment A');
  await page.waitForTimeout(400);
  await control({ action: 'drop_ws' });
  // 'connecting' → "Connection lost — reconnecting…"; 'closed' → the
  // "Disconnected from the server" variant. Either proves the banner.
  await page.waitForSelector('text=/Connection lost|Disconnected from the server/', { timeout: 10_000 });
  await shot('reconnect-banner');
  // The script keeps running server-side; bump the epoch → client resyncs.
  await sleep(2500);
  await page.waitForSelector('text=/Connection lost|Disconnected from the server/', {
    state: 'detached',
    timeout: 15_000,
  });
  await control({ action: 'resync', session_id: 'session_fixture_reconnect' });
  await page.waitForSelector('text=Segment B', { timeout: 15_000 });
  await page.waitForSelector('text=working', { state: 'detached', timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(600);
  const aCount = await page.evaluate(
    () => document.body.innerText.split('Segment A — this part streamed live').length - 1,
  );
  const bCount = await page.evaluate(
    () => document.body.innerText.split('Segment B — this part landed').length - 1,
  );
  console.log(`[check] segment A occurrences: ${aCount}, segment B occurrences: ${bCount}`);
  if (aCount !== 1 || bCount !== 1) {
    console.error('[FAIL] duplicated or missing segments after resync');
    process.exitCode = 1;
  }
  await shot('reconnect-recovered');
}

async function scenarioEmptyStates() {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('text=No sessions yet', { timeout: 10_000 });
  await shot('empty-states');
  // Create a session through the /new draft page.
  await page.click('text=New session');
  await page.waitForSelector('text=New session', { timeout: 5000 });
  await page.fill('textarea', 'Fixture blank session');
  await page.press('textarea', 'Enter');
  await page.waitForURL(/\/s\//, { timeout: 10_000 });
  await page.waitForSelector('text=Fixture blank session', { timeout: 10_000 });
  await shot('empty-states-created');
}

async function scenarioDraftFlow() {
  await page.goto(`${WEB_URL}/new?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForSelector('text=New session', { timeout: 10_000 });
  await page.fill('textarea', 'Run the fixture draft flow.');
  await page.press('textarea', 'Enter');
  await page.waitForURL(/\/s\//, { timeout: 10_000 });
  await page.waitForSelector('text=working', { timeout: 10_000 });
  await page.waitForSelector('text=Here is the fixture answer', { timeout: 20_000 });
  await page.waitForTimeout(600);
  await shot('draft-flow');
}

async function scenarioSettings() {
  await page.goto(`${WEB_URL}/settings?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForSelector('text=Settings', { timeout: 10_000 });
  await page.waitForTimeout(500);
  await shot('settings-general');

  await page.click('text=Models');
  await page.waitForSelector('text=Kiki Pro', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('settings-models');

  await page.click('text=Capabilities');
  await page.waitForSelector('text=Tools', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('settings-capabilities');
}

async function scenarioResponsive() {
  await selectSession('Fixture: settings demo');

  const widths = [1440, 1024, 768, 320];
  for (const width of widths) {
    await resizeViewport(width);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('text=Fixture: settings demo', { timeout: 10_000 });
    await page.waitForTimeout(600);
    await shot(`responsive-session-${width}`);

    const railToggle = page.locator('button[aria-label="Toggle panel"]');
    await railToggle.waitFor({ timeout: 10_000 });
    if ((await railToggle.getAttribute('aria-expanded')) !== 'true') {
      await railToggle.click();
    }
    await page.waitForTimeout(400);
    await shot(`responsive-rail-${width}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    if (width < 768) {
      await page.click('button[aria-label="Open session menu"]');
      await page.waitForTimeout(400);
      await shot(`responsive-sidebar-${width}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }

    await page.goto(`${WEB_URL}/settings?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('text=Settings', { timeout: 10_000 });
    await page.waitForTimeout(400);
    await shot(`responsive-settings-${width}`);

    // Return to the session for the next width iteration.
    await page.goto(`${WEB_URL}/?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
      waitUntil: 'networkidle',
    });
  }
}

// ---------------------------------------------------------------------------

const SCENARIOS = [
  ['basic-stream', scenarioBasicStream],
  ['prompt-dedupe', scenarioPromptDedupe],
  ['subagents', scenarioSubagents],
  ['goal-swarm', scenarioGoalSwarm],
  ['tool-pipeline', scenarioToolPipeline],
  ['question-card', scenarioQuestionCard],
  ['busy-rail', scenarioBusyRail],
  ['long-transcript', scenarioLongTranscript],
  ['error-abort', scenarioErrorAbort],
  ['approvals-gallery', scenarioApprovalsGallery],
  ['reconnect', scenarioReconnect],
  ['empty-states', scenarioEmptyStates],
  ['draft-flow', scenarioDraftFlow],
  ['settings', scenarioSettings],
  ['responsive', scenarioResponsive],
];

const proofOutput = selectProofOutput(
  ROOT,
  process.argv.slice(2),
  SCENARIOS.map(([name]) => name),
);
const SHOTS = proofOutput.outputDir;
const wanted = (name) => proofOutput.only === null || proofOutput.only.includes(name);
console.log(`[proof] mode: ${proofOutput.mode}`);
console.log(`[proof] output: ${SHOTS}`);
// Validate all arguments before cleaning the selected output directory so a
// typo or an unsafe golden subset cannot remove existing screenshots.
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

async function main() {
  killPort(FIXTURE_PORT);
  killPort(WEB_PORT);
  const fixture = await startFixtureServer({ port: FIXTURE_PORT, scenario: 'basic-stream' });

  // Always spawn our own vite on a dedicated port so a stray dev server can't
  // shadow the run. Single-string command + shell: Windows refuses to spawn
  // .cmd shims without one (spawn EINVAL), and a single string sidesteps arg
  // escaping.
  const vite = spawn(`pnpm --filter @kiki/gui dev`, {
    cwd: join(ROOT, '..', '..'),
    env: { ...process.env, KIKI_GUI_PORT: String(WEB_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  vite.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`));
  vite.stderr.on('data', (d) => process.stdout.write(`[vite:err] ${d}`));
  vite.on('error', (error) => console.error('[vite:spawn-error]', error.message));
  const cleanup = async () => {
    // Tree-kill: the shell wrapper dies but the vite grandchild holds the port.
    if (process.platform === 'win32' && vite.pid !== undefined) {
      try {
        execSync(`taskkill /PID ${vite.pid} /F /T`, { stdio: 'ignore' });
      } catch {
        // already gone
      }
    }
    vite.kill();
    killPort(WEB_PORT);
    await fixture.stop();
  };
  process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));
  process.on('exit', () => vite.kill());

  try {
    await waitForServer(WEB_URL);
    console.log(`[proof] web up at ${WEB_URL}`);

    const browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (error) => console.error(`[pageerror] ${error}`));
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(`[console:error] ${message.text()}`);
    });

    const deepLink = `${WEB_URL}/?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`;
    await page.goto(deepLink, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=New session', { timeout: 15_000 });
    console.log('[proof] connected to fixture');

    for (const [name, run] of SCENARIOS) {
      if (!wanted(name)) continue;
      console.log(`[scenario] ${name}`);
      await control({ action: 'scenario', name });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('text=New session', { timeout: 15_000 });
      await page.waitForTimeout(900); // let the first sessions poll land
      try {
        await run();
      } catch (error) {
        console.error(`[FAIL] scenario ${name}:`, error.message);
        process.exitCode = 1;
        await shot(`${name}-FAIL`);
      }
    }

    await browser.close();
  } finally {
    await cleanup();
  }
  console.log(process.exitCode ? 'PROOF FAILED' : 'PROOF DONE');
}

await main();
