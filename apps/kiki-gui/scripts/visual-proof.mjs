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
 *
 * Locale: KIKI_PROOF_LOCALE=zh runs the same suite against the Chinese UI —
 * the runner seeds `kiki.locale` into localStorage before every app boot and
 * the walkers read UI chrome through the per-locale S table below (fixture
 * transcript content stays English; only chrome localizes). The `i18n`
 * scenario additionally toggles the language through Settings → General.
 */

import { spawn, execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
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

/** UI language for the run; the app defaults to English when unset. */
const LOCALE = process.env.KIKI_PROOF_LOCALE === 'zh' ? 'zh' : 'en';

/**
 * UI-chrome strings the walkers key on, per locale. Values must match
 * src/i18n/en.ts / zh.ts exactly — the proof fails loudly when they drift.
 * (Fixture content — session titles, streamed answers, question options —
 * comes from the server and stays English in both runs.)
 */
const STRINGS = {
  en: {
    newSession: 'New session',
    working: 'working',
    approvalNeeded: 'Approval needed',
    approve: 'Approve',
    approved: 'Approved',
    kikiAsks: 'kiki asks',
    submit: 'Submit',
    settings: 'Settings',
    models: 'Models',
    providersAuth: 'Providers & auth',
    capabilities: 'Capabilities',
    configuredProviders: 'Configured providers',
    tools: 'Tools',
    newSessionDefaults: 'New-session defaults',
    saveServerDefaults: 'Save server defaults',
    planModeToggle: 'Start new sessions in plan mode',
    permissionModeAuto: 'auto',
    settingsSavedEcho: 'Server saved and echoed permission=auto, plan=on.',
    skillDefaults: 'Skill and experiment defaults',
    saveCapabilityDefaults: 'Save capability defaults',
    experimentalAria: 'Experimental flag overrides',
    flagBoolFragment: 'must be true or false',
    loadMore: 'Load more sessions',
    queuedChip: 'Queued — starts when the current turn finishes',
    onePromptQueued: '1 prompt queued',
    queueBarPattern: /prompts? queued/,
    promptAborted: 'Prompt aborted',
    archiveDownloaded: 'Session archive downloaded.',
    undoTitle: 'Undo the last turn?',
    undoTurn: 'Undo turn',
    lastTurnRemoved: 'Last turn removed.',
    compactionRequested: 'Compaction requested',
    forkSession: 'Fork session',
    exportArchive: 'Export archive',
    undoLastTurn: 'Undo last turn',
    compactContext: 'Compact context',
    bannerPattern: /Connection lost|Disconnected from the server/,
    resyncing: 'Resyncing…',
    noSessions: 'No sessions yet',
    subagentTranscript: 'Subagent transcript',
    blankPage: 'A blank page',
    steps3: 'Steps · 3',
    filesHeader: 'Files — mentioned as @path',
    notActivatable: 'not activatable',
    shortcuts: 'Shortcuts',
    planPill: 'plan',
    swarmTitlePrefix: 'Swarm mode',
    goalActive: 'goal · active',
    objectivePlaceholder: 'Objective (optional)',
    turns: 'turns',
    noMatches: 'No matches',
    systemReminder: 'System reminder',
    fromSubagentApprover: 'from subagent Approver',
    queuePromptAria: 'Queue prompt',
    cancelQueuedAria: 'Cancel queued prompt',
    togglePanelAria: 'Toggle panel',
    openMenuAria: 'Open session menu',
    sessionActionsAria: 'Session actions',
    terminalEmpty: 'No terminals yet',
    terminalKillConfirm: 'sure?',
    terminalExited: 'Process exited (code 0)',
  },
  zh: {
    newSession: '新会话',
    working: '工作中',
    approvalNeeded: '需要批准',
    approve: '批准',
    approved: '已批准',
    kikiAsks: 'kiki 提问',
    submit: '提交',
    settings: '设置',
    models: '模型',
    providersAuth: '提供商与认证',
    capabilities: '能力',
    configuredProviders: '已配置的提供商',
    tools: '工具',
    newSessionDefaults: '新会话默认值',
    saveServerDefaults: '保存服务器默认值',
    planModeToggle: '新会话默认开启计划模式',
    permissionModeAuto: '自动',
    settingsSavedEcho: '服务器已保存并回显 permission=auto、plan=开。',
    skillDefaults: '技能与实验默认值',
    saveCapabilityDefaults: '保存能力默认值',
    experimentalAria: '实验开关覆盖',
    flagBoolFragment: '必须为 true 或 false',
    loadMore: '加载更多会话',
    queuedChip: '已排队 — 当前轮次结束后开始',
    onePromptQueued: '1 条消息已排队',
    queueBarPattern: /条消息已排队/,
    promptAborted: '消息已中止',
    archiveDownloaded: '会话归档已下载。',
    undoTitle: '撤销最后一轮？',
    undoTurn: '撤销本轮',
    lastTurnRemoved: '已移除最后一轮。',
    compactionRequested: '已请求压缩',
    forkSession: '复刻会话',
    exportArchive: '导出归档',
    undoLastTurn: '撤销最后一轮',
    compactContext: '压缩上下文',
    bannerPattern: /正在重连|已与服务器断开连接/,
    resyncing: '正在重新同步…',
    noSessions: '还没有会话',
    subagentTranscript: '子代理会话记录',
    blankPage: '白纸一张',
    steps3: '步骤 · 3',
    filesHeader: '文件 — 在消息中以 @路径 引用',
    notActivatable: '不可激活',
    shortcuts: '快捷指令',
    planPill: '计划',
    swarmTitlePrefix: '集群模式',
    goalActive: '目标 · 进行中',
    objectivePlaceholder: '目标（可选）',
    turns: '轮',
    noMatches: '没有匹配',
    systemReminder: '系统提醒',
    fromSubagentApprover: '来自子代理 Approver',
    queuePromptAria: '加入队列',
    cancelQueuedAria: '取消排队的消息',
    togglePanelAria: '切换面板',
    openMenuAria: '打开会话菜单',
    sessionActionsAria: '会话操作',
    terminalEmpty: '还没有终端',
    terminalKillConfirm: '确认？',
    terminalExited: '进程已退出（代码 0）',
  },
};
const S = STRINGS[LOCALE];

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
 * Wait until a TCP port answers NO connection. A stale listener (orphaned
 * vite grandchild) must be gone before we spawn our own — otherwise
 * waitForServer can report "web up" against the zombie and strictPort then
 * kills our real dev server, hanging the suite mid-run.
 */
async function waitForPortFree(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const taken = await new Promise((resolve) => {
      const probe = net.createConnection({ port, host: '127.0.0.1' });
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (!taken) return;
    if (Date.now() > deadline) throw new Error(`port ${port} is still held by a stale process — kill it and rerun`);
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
  await waitForText(S.approvalNeeded);
  await page.waitForTimeout(300);
  await shot('basic-stream-approval');
  await approveViaKeyboard();
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 30_000 });
  await page.waitForTimeout(1200); // shiki upgrade
  await shot('basic-stream-done');
}

async function scenarioPromptDedupe() {
  await selectSession('Fixture: prompt dedupe');
  await sendPrompt('One prompt, one user block.');
  await waitForText('The prompt appears once.');
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 20_000 });
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
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 20_000 });
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
  await page.click(`button[title^="${S.swarmTitlePrefix}"]`);
  await page.click(`button:has-text("${S.goalActive}")`);
  await page.fill(`input[placeholder="${S.objectivePlaceholder}"]`, 'Ship the fixture release');
  await page.click(`button:has-text("${S.goalActive}")`);
  await sendPrompt('Advance the release goal.');
  await waitForText('Swarm mode is on and the goal state is live.');
  const inspected = await control({ action: 'session', session_id: 'session_fixture_goal_swarm' });
  const submission = inspected.data?.last_prompt_submission;
  console.log(`[check] goal/swarm submission ${JSON.stringify(submission)}`);
  if (submission?.swarm_mode !== true || submission?.goal_objective !== 'Ship the fixture release') {
    throw new Error('PromptSubmission did not carry swarm_mode + goal_objective');
  }
  await page.click(`button:has-text("${S.goalActive}")`);
  await page.waitForTimeout(400);
  await shot('goal-swarm');
}

async function scenarioToolPipeline() {
  await selectSession('Fixture: tool pipeline');
  await waitForText(S.steps3);
  await shot('tool-pipeline-grouped');
  // Expand the group, then the Edit card inside it (DiffCard with 2 hunks).
  // NB: target the card by its summary text — the group row itself contains
  // the tool names, so a bare hasText:'Edit' matches the row and re-toggles.
  await page.click(`text=${S.steps3}`);
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
  await waitForText(S.approvalNeeded);
  await approveViaKeyboard();
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 30_000 });
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
  await waitForText(S.kikiAsks);
  await page.waitForTimeout(400);
  await shot('question-card');
  // single select "Both" + two multi options, then submit
  await page.click('text=Both (Recommended)');
  await page.click('text=Typecheck');
  await page.click('text=Visual proof');
  await page.click(`button:has-text("${S.submit}")`);
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 30_000 });
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
  await page.click(`button:has-text("${S.turns}")`);
  await page.waitForTimeout(400);
  await shot('long-transcript-turns');
  await page.keyboard.press('Escape');
}

async function scenarioErrorAbort() {
  await selectSession('Fixture: error + abort');
  await sendPrompt('Run the failing then slow fixture.');
  await waitForText(S.approvalNeeded);
  await approveViaKeyboard();
  // The failed Bash + Read cards group and auto-expand on error; the slow
  // stream then starts — abort it mid-flight.
  await waitForText('recovering slowly', 20_000);
  await page.waitForTimeout(500);
  await page.mouse.click(720, 300); // non-editable focus
  await page.keyboard.press('Escape'); // …then aborted mid-stream
  await page.waitForSelector(`text=${S.promptAborted}`, { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('error-abort');
}

async function scenarioApprovalsGallery() {
  await selectSession('Fixture: approvals gallery');
  await page.waitForSelector('text=ProbeTool', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('approvals-gallery');
  // Resolve the raw-JSON fallback card (last card) to show the outcome line.
  const approve = page.locator(`button:has-text("${S.approve}")`).nth(4);
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
  // 'connecting' → the reconnecting banner; 'closed' → the disconnected
  // variant. Either proves the banner.
  await page.waitForSelector(`text=${S.bannerPattern}`, { timeout: 10_000 });
  await shot('reconnect-banner');
  // The script keeps running server-side; bump the epoch → client resyncs.
  await sleep(2500);
  await page.waitForSelector(`text=${S.bannerPattern}`, {
    state: 'detached',
    timeout: 15_000,
  });
  await control({ action: 'resync', session_id: 'session_fixture_reconnect' });
  await page.waitForSelector('text=Segment B', { timeout: 15_000 });
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 20_000 }).catch(() => undefined);
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
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`text=${S.noSessions}`, { timeout: 10_000 });
  await shot('empty-states');
  // Create a session through the /new draft page.
  await page.click(`text=${S.newSession}`);
  await page.waitForSelector(`text=${S.newSession}`, { timeout: 5000 });
  await page.fill('textarea', 'Fixture blank session');
  await page.press('textarea', 'Enter');
  await page.waitForURL(/\/s\//, { timeout: 10_000 });
  await page.waitForSelector('text=Fixture blank session', { timeout: 10_000 });
  await shot('empty-states-created');
}

async function scenarioDraftFlow() {
  await page.goto(`${WEB_URL}/new?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector(`text=${S.newSession}`, { timeout: 10_000 });
  await page.fill('textarea', 'Run the fixture draft flow.');
  await page.press('textarea', 'Enter');
  await page.waitForURL(/\/s\//, { timeout: 10_000 });
  await page.waitForSelector(`text=${S.working}`, { timeout: 10_000 });
  await page.waitForSelector('text=Here is the fixture answer', { timeout: 20_000 });
  await page.waitForTimeout(600);
  await shot('draft-flow');
}

async function scenarioSettings() {
  await page.goto(`${WEB_URL}/settings?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector(`text=${S.settings}`, { timeout: 10_000 });
  await page.waitForTimeout(500);
  await shot('settings-general');

  await page.click(`text=${S.models}`);
  await page.waitForSelector('text=Kiki Pro', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('settings-models');

  await page.click(`text=${S.providersAuth}`);
  await page.waitForSelector(`text=${S.configuredProviders}`, { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('settings-providers');

  await page.click(`text=${S.capabilities}`);
  await page.waitForSelector(`text=${S.tools}`, { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('settings-capabilities');
}

async function scenarioSettingsWrite() {
  await page.goto(`${WEB_URL}/settings/general?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector(`text=${S.newSessionDefaults}`, { timeout: 10_000 });
  await page.locator('button', { hasText: S.permissionModeAuto }).click();
  await page.locator('label', { hasText: S.planModeToggle }).click();
  await page.click(`button:has-text("${S.saveServerDefaults}")`);
  await waitForText(S.settingsSavedEcho);
  await shot('settings-write-saved');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`text=${S.newSessionDefaults}`, { timeout: 10_000 });
  const autoClass = await page.locator('button', { hasText: S.permissionModeAuto }).getAttribute('class');
  const planState = await page.locator('label', { hasText: S.planModeToggle }).locator('[role="switch"]').getAttribute('aria-checked');
  if (!autoClass?.includes('bg-accent-soft') || planState !== 'true') {
    throw new Error(`server setting did not survive reload: auto=${autoClass} plan=${planState}`);
  }
  await shot('settings-write-reloaded');
}

async function scenarioSettingsInvalid() {
  await page.goto(`${WEB_URL}/settings/capabilities?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector(`text=${S.skillDefaults}`, { timeout: 10_000 });
  await page.fill(`textarea[aria-label="${S.experimentalAria}"]`, '{"search_worker":"yes"}');
  await page.click(`button:has-text("${S.saveCapabilityDefaults}")`);
  await page.waitForSelector('[role="alert"]', { timeout: 5000 });
  await waitForText(S.flagBoolFragment);
  await shot('settings-invalid-inline-error');
}

async function scenarioSettingsDesktopGate() {
  await page.goto(`${WEB_URL}/settings/capabilities?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('[data-testid="desktop-config-disabled-hint"]', { timeout: 10_000 });
  const disabled = await page.locator('[data-testid="desktop-config-fields"]').evaluate((node) => node.disabled === true);
  if (!disabled) throw new Error('desktop-only config fieldset is enabled in the browser build');
  await page.locator('[data-testid="desktop-config-disabled-hint"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot('settings-desktop-disabled');
}

async function scenarioResponsive() {
  await selectSession('Fixture: settings demo');

  const widths = [1440, 1024, 768, 320];
  for (const width of widths) {
    await resizeViewport(width);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Fixture: settings demo', { timeout: 10_000 });
    await page.waitForTimeout(600);
    await shot(`responsive-session-${width}`);

    const railToggle = page.locator(`button[aria-label="${S.togglePanelAria}"]`);
    await railToggle.waitFor({ timeout: 10_000 });
    if ((await railToggle.getAttribute('aria-expanded')) !== 'true') {
      await railToggle.click();
    }
    await page.waitForTimeout(400);
    await shot(`responsive-rail-${width}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    if (width < 768) {
      await page.click(`button[aria-label="${S.openMenuAria}"]`);
      await page.waitForTimeout(400);
      await shot(`responsive-sidebar-${width}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }

    await page.goto(`${WEB_URL}/settings?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector(`text=${S.settings}`, { timeout: 10_000 });
    await page.waitForTimeout(400);
    await shot(`responsive-settings-${width}`);

    // Return to the session for the next width iteration.
    await page.goto(`${WEB_URL}/?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
      waitUntil: 'domcontentloaded',
    });
  }
}

async function scenarioQueue() {
  await selectSession('Fixture: queue');
  await sendPrompt('A: hold the floor.');
  await waitForText('A holds the floor.');
  // The busy composer keeps a mouse path to the queue: fill, then click Send.
  await page.fill('textarea', 'B: wait your turn.');
  await page.click(`button[aria-label="${S.queuePromptAria}"]`);
  console.log('[flow] queued via the busy Send button');
  // The parked prompt surfaces immediately: one user block + Queued chip + bar.
  await page.waitForSelector(`text=${S.queuedChip}`, { timeout: 10_000 });
  const bBlocks = page.locator('[role="log"] [data-block-id^="user-"]', { hasText: 'B: wait your turn.' });
  if ((await bBlocks.count()) !== 1) throw new Error(`expected one B user block, saw ${await bBlocks.count()}`);
  await page.waitForSelector(`text=${S.onePromptQueued}`, { timeout: 5000 });
  await shot('queue-queued');
  // Release A → B promotes to running; the chip and bar clear.
  await control({ action: 'release', session_id: 'session_fixture_queue' });
  await waitForText('B runs after A.');
  await page.waitForSelector(`text=${S.queuedChip}`, {
    state: 'detached',
    timeout: 10_000,
  });
  if ((await bBlocks.count()) !== 1) {
    const ids = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="log"] [data-block-id]')).map((n) => n.getAttribute('data-block-id')),
    );
    console.log('[debug] block ids at promotion:', JSON.stringify(ids));
    throw new Error(`B user block duplicated after promotion: ${await bBlocks.count()}`);
  }
  if ((await page.locator(`text=${S.queueBarPattern}`).count()) !== 0) throw new Error('queue bar still visible after promotion');
  await shot('queue-promoted');
  // Cancelling a parked prompt keeps its block but drops the chip.
  await sendPrompt('A: hold the floor.');
  await page.waitForSelector(`text=${S.working}`, { timeout: 10_000 });
  await sendPrompt('B: cancel me.');
  await page.waitForSelector(`text=${S.queuedChip}`, { timeout: 10_000 });
  await page.click(`button[aria-label="${S.cancelQueuedAria}"]`);
  await page.waitForSelector(`text=${S.promptAborted}`, { timeout: 10_000 });
  const cancelled = page.locator('[role="log"] [data-block-id^="user-"]', { hasText: 'B: cancel me.' });
  if ((await cancelled.count()) !== 1) throw new Error('cancelled queued prompt lost its user block');
  if ((await page.locator(`text=${S.queuedChip}`).count()) !== 0) {
    throw new Error('Queued chip survived the cancellation');
  }
  await shot('queue-cancelled');
  await control({ action: 'release', session_id: 'session_fixture_queue' });
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 10_000 }).catch(() => undefined);
}

async function scenarioBurst() {
  // Instrument BEFORE the app boots: count WS messages, wrap fetch to time
  // prompt POSTs, and collect longtasks. The runner already reloaded once for
  // this scenario; reload again so the init script wins over the app socket.
  await page.addInitScript(() => {
    window.__wsMessages = 0;
    window.__promptFetches = [];
    window.__longtasks = [];
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = class extends OriginalWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', () => {
          window.__wsMessages += 1;
        });
      }
    };
    const originalFetch = window.fetch;
    window.fetch = (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (typeof url === 'string' && url.includes('/prompts') && (init?.method ?? 'GET') === 'POST') {
        window.__promptFetches.push(performance.now());
      }
      return originalFetch(input, init);
    };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__longtasks.push(entry.duration);
    }).observe({ entryTypes: ['longtask'] });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`text=${S.newSession}`, { timeout: 15_000 });
  await selectSession('Fixture: burst');
  // Idle baseline: the same press→POST path before any flood begins.
  await page.fill('textarea', 'Start the burst.');
  const idlePressedAt = await page.evaluate(() => performance.now());
  await page.press('textarea', 'Enter');
  await page.waitForFunction(() => window.__promptFetches.length > 0, undefined, { timeout: 5000 });
  const idleLatency = await page.evaluate(
    (start) => window.__promptFetches[0] - start,
    idlePressedAt,
  );
  console.log(`[check] idle prompt POST initiation baseline: ${idleLatency.toFixed(1)}ms`);
  // Catch the storm while it is arriving: poll the in-page WS message counter.
  const baselineCount = await page.evaluate(() => window.__wsMessages);
  let streaming = false;
  for (let i = 0; i < 120; i += 1) {
    const current = await page.evaluate(() => window.__wsMessages);
    if (current - baselineCount > 100) {
      streaming = true;
      break;
    }
    await page.waitForTimeout(25);
  }
  if (!streaming) throw new Error('burst frames never streamed');
  // Mid-burst: a prompt POST must still initiate inside ~100ms. Both clocks
  // are the page's performance.now(): the gap covers event-queue wait plus
  // React handling plus fetch initiation — exactly what starvation destroys.
  const fetchesBefore = await page.evaluate(() => window.__promptFetches.length);
  await page.fill('textarea', 'B: second during burst.');
  const pressedAt = await page.evaluate(() => performance.now());
  await page.press('textarea', 'Enter');
  await page.waitForFunction((before) => window.__promptFetches.length > before, fetchesBefore, { timeout: 5000 });
  const latency = await page.evaluate(
    (start) => window.__promptFetches[window.__promptFetches.length - 1] - start,
    pressedAt,
  );
  const framesAtSend = await page.evaluate(() => window.__wsMessages);
  console.log(
    `[check] mid-burst prompt POST initiation: ${latency.toFixed(1)}ms (idle baseline ${idleLatency.toFixed(1)}ms)`,
  );
  // The second prompt parked behind the parked turn (A holds a release gate
  // after the storm, so B deterministically lands in the server queue).
  try {
    await page.waitForSelector(`text=${S.queuedChip}`, { timeout: 30_000 });
  } catch (error) {
    const ids = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="log"] [data-block-id]')).map((n) => n.getAttribute('data-block-id')),
    );
    console.log('[debug] block ids at chip timeout:', JSON.stringify(ids));
    throw error;
  }
  await shot('burst-queued');
  // Let A finish; B promotes out of the queue and runs.
  await control({ action: 'release', session_id: 'session_fixture_burst' });
  await waitForText('Burst survived — the composer stayed responsive.', 90_000);
  await waitForText('Second prompt landed after the burst — exactly once.', 30_000);
  await page.waitForTimeout(600);
  const report = await page.evaluate(() => ({
    frames: window.__wsMessages,
    longtasks: window.__longtasks.length,
    maxLongtask: window.__longtasks.length > 0 ? Math.max(...window.__longtasks) : 0,
  }));
  console.log(
    `[check] burst frames=${report.frames} (at B send: ${framesAtSend}) longtasks=${report.longtasks} maxLongtask=${report.maxLongtask.toFixed(0)}ms`,
  );
  if (report.frames - framesAtSend < 1000) {
    throw new Error('B was not sent mid-burst — the storm had already drained');
  }
  if (report.maxLongtask > 800) {
    throw new Error(`main-thread longtask ${report.maxLongtask.toFixed(0)}ms during burst`);
  }
  // Latency asserted after reporting so a failing run still prints the full
  // profile. Pre-pipeline this was seconds (a publish + full render per
  // frame); the budget is 250ms over the idle floor — an order of magnitude
  // below the starvation failure mode, tolerant of shared-machine load.
  if (latency > idleLatency + 250) {
    throw new Error(
      `prompt POST took ${latency.toFixed(1)}ms to initiate mid-burst (idle ${idleLatency.toFixed(1)}ms)`,
    );
  }
  const bBlocks = page.locator('[role="log"] [data-block-id^="user-"]', { hasText: 'B: second during burst.' });
  if ((await bBlocks.count()) !== 1) throw new Error(`expected one B user block, saw ${await bBlocks.count()}`);
  await shot('burst');
}

async function scenarioSubagentsBurst() {
  await selectSession('Fixture: subagents burst');
  await page.waitForSelector(`text=${S.blankPage}`, { timeout: 10_000 });
  await page.evaluate(() => {
    window.__mainMutations = 0;
    new MutationObserver((records) => {
      window.__mainMutations += records.length;
    }).observe(document.querySelector('main'), {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
  });
  const emitted = await control({ action: 'burst', session_id: 'session_fixture_subagents_burst', count: 8000 });
  console.log(`[check] hidden child deltas emitted: ${emitted.data?.emitted}`);
  await page.waitForTimeout(700); // let any straggler flush land
  const mutations = await page.evaluate(() => window.__mainMutations);
  console.log(`[check] main-DOM mutations during hidden child burst: ${mutations}`);
  if (mutations > 2) throw new Error(`hidden child deltas caused ${mutations} main-DOM mutations`);
  // The scoped per-agent channel captured the stream: open the agent page and
  // fire a second burst — the tool card materializes without a main resync.
  await page.goto(
    `${WEB_URL}/s/session_fixture_subagents_burst/agent/agent-hidden?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForSelector(`text=${S.subagentTranscript}`, { timeout: 15_000 });
  await control({ action: 'burst', session_id: 'session_fixture_subagents_burst', count: 500 });
  await page.waitForSelector('[data-block-id="tool-burst-call"]', { timeout: 15_000 });
  await page.waitForTimeout(400);
  await shot('subagents-burst-agent-page');
}

async function scenarioResyncHold() {
  await selectSession('Fixture: resync hold');
  await sendPrompt('Hold my snapshot.');
  await waitForText('Settled before the hold.');
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 20_000 }).catch(() => undefined);
  // Hold every snapshot fetch until released below.
  const held = [];
  let holding = true;
  await page.route('**/api/v1/sessions/*/snapshot', async (route) => {
    if (!holding) return route.continue();
    await new Promise((resolve) => held.push({ route, resolve }));
  });
  await control({ action: 'resync', session_id: 'session_fixture_resync_hold' });
  await page.waitForSelector(`text=${S.resyncing}`, { timeout: 10_000 });
  // A duplicate trigger must not stack a second in-flight snapshot.
  await control({ action: 'resync', session_id: 'session_fixture_resync_hold' });
  await page.waitForTimeout(1500);
  console.log(`[check] snapshot requests held in flight: ${held.length}`);
  if (held.length !== 1) throw new Error(`expected exactly 1 held snapshot request, saw ${held.length}`);
  await shot('resync-hold-held');
  holding = false;
  for (const { route, resolve } of held.splice(0)) {
    resolve();
    await route.continue();
  }
  await page.waitForSelector(`text=${S.resyncing}`, { state: 'detached', timeout: 15_000 });
  await page.unroute('**/api/v1/sessions/*/snapshot');
  await page.waitForTimeout(500);
  const occurrences = await page.evaluate(
    () => document.body.innerText.split('Settled before the hold.').length - 1,
  );
  if (occurrences !== 1) throw new Error(`expected the pre-hold text exactly once, saw ${occurrences}`);
  const userBlocks = page.locator('[role="log"] [data-block-id^="user-"]', { hasText: 'Hold my snapshot.' });
  if ((await userBlocks.count()) !== 1) throw new Error(`expected one user block after resync, saw ${await userBlocks.count()}`);
  await shot('resync-hold-recovered');
}

async function scenarioReminder() {
  await selectSession('Fixture: reminder');
  await waitForText('Fixed — the flake was a missing await on the fixture client.');
  const bubbles = page.locator('[role="log"] [data-block-id^="user-"]');
  if ((await bubbles.count()) !== 1) throw new Error(`expected exactly one user bubble, saw ${await bubbles.count()}`);
  const bubbleText = await bubbles.first().innerText();
  if (!bubbleText.includes('Fix the flaky integration test.')) throw new Error('user text missing from the bubble');
  if (bubbleText.includes('system-reminder') || bubbleText.includes('repeated several times')) {
    throw new Error('reminder content leaked into the user bubble');
  }
  const reminders = page.locator('[role="log"] button', { hasText: S.systemReminder });
  if ((await reminders.count()) !== 2) throw new Error(`expected 2 collapsed reminders, saw ${await reminders.count()}`);
  if ((await page.locator('text=The same tool call has been repeated').count()) !== 0) {
    throw new Error('collapsed reminder content rendered before expansion');
  }
  await shot('reminder-collapsed');
  await reminders.first().click();
  await waitForText('The same tool call has been repeated');
  await page.waitForTimeout(300);
  await shot('reminder-expanded');
}

async function scenarioSubagentApproval() {
  await selectSession('Fixture: subagent approval');
  await sendPrompt('Clean the build output.');
  // The child's request surfaces in the MAIN transcript, tagged with its
  // subagent name — and it is actionable in place.
  const card = page.locator('[data-approval-id="approval_fixture_child"]');
  await card.waitFor({ timeout: 15_000 });
  await waitForText(S.fromSubagentApprover);
  await shot('subagent-approval-main');
  await card.locator('button', { hasText: S.approve }).click();
  // Resolving with that approval_id unblocks the child (a wrong id would
  // 40902 and strand the run): the card collapses to its resolution line
  // (the resolved card no longer carries data-approval-id) and the turn ends.
  await page.getByText(S.approved, { exact: true }).waitFor({ timeout: 10_000 });
  await waitForText('The gated cleanup finished.');
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 20_000 }).catch(() => undefined);
  // The agent page carries the same interaction (from the transcript
  // response's interactions array), now resolved.
  await page.locator('[data-subagent-id="agent-worker"]').click();
  await page.waitForURL(/\/agent\/agent-worker$/, { timeout: 10_000 });
  await page.getByText(S.approved, { exact: true }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
  await shot('subagent-approval-agent-page');
}

async function scenarioReconnectMidTurn() {
  await selectSession('Fixture: reconnect mid-turn');
  await sendPrompt('Stream both halves.');
  await waitForText('Part one streamed before the drop.');
  await control({ action: 'drop_ws' });
  await page.waitForSelector(`text=${S.bannerPattern}`, { timeout: 10_000 });
  // The turn continues and ENDS during the blackout: its volatile deltas are
  // lost to the wire, only the journal commit persists. No epoch bump.
  await control({ action: 'release', session_id: 'session_fixture_reconnect_mid_turn' });
  await page.waitForSelector(`text=${S.bannerPattern}`, {
    state: 'detached',
    timeout: 15_000,
  });
  // Busy at drop ⇒ the post-reconnect ack triggers a snapshot resync, and the
  // finalized text must be COMPLETE — not truncated at the drop point.
  await page.waitForSelector(
    'text=Part two streamed during the blackout.',
    { timeout: 15_000 },
  );
  await page.waitForTimeout(600);
  const full = 'Part one streamed before the drop. Part two streamed during the blackout.';
  const occurrences = await page.evaluate(
    (needle) => document.body.innerText.split(needle).length - 1,
    full,
  );
  console.log(`[check] full-text occurrences after mid-turn reconnect: ${occurrences}`);
  if (occurrences !== 1) throw new Error(`expected the complete text exactly once, saw ${occurrences}`);
  await shot('reconnect-mid-turn');
}

async function scenarioSessionPages() {
  // 125 sessions: page 1 (100) + load-more page 2 (25) via before_id keyset.
  await page.waitForSelector('text=Fixture: paged session 001', { timeout: 15_000 });
  const rows = page.locator('aside div.group');
  const firstCount = await rows.count();
  console.log(`[check] sidebar first page rows: ${firstCount}`);
  if (firstCount !== 100) throw new Error(`expected 100 first-page rows, saw ${firstCount}`);
  await page.click(`button:has-text("${S.loadMore}")`);
  await page.waitForFunction(
    () => document.querySelectorAll('aside div.group').length === 125,
    undefined,
    { timeout: 15_000 },
  );
  // The page-1 poll keeps ticking every 5s; the merge must not duplicate rows.
  await page.waitForTimeout(6000);
  const finalCount = await rows.count();
  console.log(`[check] sidebar rows after load-more + poll ticks: ${finalCount}`);
  if (finalCount !== 125) throw new Error(`expected 125 unique rows, saw ${finalCount}`);
  await page.locator('aside div.group', { hasText: 'paged session 125' }).scrollIntoViewIfNeeded();
  await shot('session-pages');
}

async function scenarioTerminal() {
  const SID = 'session_fixture_terminal';
  const mirrorText = () =>
    page.evaluate(
      () => document.querySelector('[data-terminal-screen]')?.textContent ?? '',
    );
  const waitMirror = async (predicate, label, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const text = await mirrorText();
      if (predicate(text)) return text;
      if (Date.now() > deadline) {
        throw new Error(`terminal mirror never satisfied "${label}"; tail: ${JSON.stringify(text.slice(-120))}`);
      }
      await page.waitForTimeout(120);
    }
  };
  const canvas = page.locator('[data-terminal-canvas]:visible');

  await selectSession('Fixture: terminal');
  await page.click('[data-terminal-toggle]');
  await page.waitForSelector('[data-terminal-panel]', { timeout: 10_000 });
  // Empty state → the first terminal is created from it.
  await page.waitForSelector(`text=${S.terminalEmpty}`, { timeout: 10_000 });
  await shot('terminal-empty');
  await page.click('[data-terminal-new-empty]');
  await page.waitForSelector('[data-terminal-tab]', { timeout: 10_000 });
  // The fake shell's prompt rides the attach replay.
  await waitMirror((text) => text.includes('$'), 'initial prompt');

  // Full keyboard round-trip: typed input echoes, the command output follows.
  await canvas.click();
  await page.keyboard.type('echo kiki-term-ok');
  await page.keyboard.press('Enter');
  await waitMirror(
    (text) => text.split('kiki-term-ok').length - 1 >= 2,
    'echo input + output',
  );
  await page.waitForTimeout(400);
  await shot('terminal-open');

  // Drag the panel taller → fit → a resize frame reaches the fixture.
  const beforeResize = await control({ action: 'session', session_id: SID });
  const rowsBefore = beforeResize.data?.terminals?.[0]?.rows;
  const handle = page.locator('[data-terminal-panel] [role="separator"]');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 140, { steps: 6 });
  await page.mouse.up();
  let rowsAfter = rowsBefore;
  for (let i = 0; i < 40 && rowsAfter === rowsBefore; i += 1) {
    await sleep(150);
    const state = await control({ action: 'session', session_id: SID });
    rowsAfter = state.data?.terminals?.[0]?.rows;
  }
  console.log(`[check] terminal rows after drag: ${rowsBefore} → ${rowsAfter}`);
  if (rowsAfter === undefined || rowsAfter === rowsBefore) {
    throw new Error('panel drag never resized the PTY');
  }
  const heightBefore = await page.locator('[data-terminal-panel]').evaluate((node) => node.offsetHeight);

  // Second terminal in a tab; independent IO.
  await page.click('[data-terminal-new]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-terminal-tab]').length === 2,
    undefined,
    { timeout: 10_000 },
  );
  await canvas.click();
  await page.keyboard.type('echo second-shell');
  await page.keyboard.press('Enter');
  await waitMirror(
    (text) => text.split('second-shell').length - 1 >= 2,
    'second tab output',
  );
  await page.waitForTimeout(300);
  await shot('terminal-tabs');

  // Back on tab 1 its scrollback is still there (per-tab xterm instances).
  await page.locator('[data-terminal-tab]').first().click();
  await waitMirror((text) => text.includes('kiki-term-ok'), 'tab-1 scrollback');

  // Kill tab 2 — the two-step confirm guards it.
  await page.locator('[data-terminal-kill]').nth(1).click();
  await page.waitForSelector(`text=${S.terminalKillConfirm}`, { timeout: 5000 });
  await page.locator('[data-terminal-kill]').nth(1).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-terminal-tab]').length === 1,
    undefined,
    { timeout: 10_000 },
  );
  const afterKill = await control({ action: 'session', session_id: SID });
  if (afterKill.data?.terminals?.[1]?.status !== 'exited') {
    throw new Error(`killed terminal did not exit server-side: ${JSON.stringify(afterKill.data?.terminals)}`);
  }

  // `exit` in tab 1 → the dead state with the exit code, then restart.
  await canvas.click();
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await page.waitForSelector(`text=${S.terminalExited}`, { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('terminal-dead');
  await page.click('[data-terminal-restart]');
  await page.waitForSelector('[data-terminal-restart]', { state: 'detached', timeout: 10_000 });
  await canvas.click();
  await page.keyboard.type('echo back-alive');
  await page.keyboard.press('Enter');
  await waitMirror(
    (text) => text.split('back-alive').length - 1 >= 2,
    'restarted terminal output',
  );

  // Reload: the panel reopens at the dragged height, terminals relist, the
  // running one reattaches and replays its buffer without any typing.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-terminal-panel]', { timeout: 20_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-terminal-tab]').length === 3,
    undefined,
    { timeout: 15_000 },
  );
  await waitMirror(
    (text) => text.split('back-alive').length - 1 >= 2,
    'replayed scrollback after reload',
  );
  const heightAfter = await page.locator('[data-terminal-panel]').evaluate((node) => node.offsetHeight);
  console.log(`[check] panel height persisted: ${heightBefore} → ${heightAfter}`);
  if (Math.abs(heightAfter - heightBefore) > 4) {
    throw new Error(`panel height not persisted: ${heightBefore} vs ${heightAfter}`);
  }
  await page.waitForTimeout(400);
  await shot('terminal-restored');
}

// ---------------------------------------------------------------------------

/** 1x1 transparent PNG — the paste payload for the attachments walker. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function scenarioSlashCommands() {
  await selectSession('Fixture: slash commands');
  await page.click('textarea');
  // Typing "/" opens the menu: seeded skills + client shortcuts.
  await page.fill('textarea', '/');
  await page.waitForSelector('text=/review', { timeout: 5000 });
  await page.waitForSelector('text=/handoff', { timeout: 5000 });
  await page.waitForSelector(`text=${S.shortcuts}`, { timeout: 5000 });
  await page.waitForTimeout(450); // let the menu entrance animation settle
  await shot('slash-commands-menu');
  // The reference-type skill is visible but marked not activatable.
  await page.waitForSelector(`text=${S.notActivatable}`, { timeout: 5000 });
  // Filter + keyboard-accept the skill: draft becomes "/review " for args.
  await page.fill('textarea', '/rev');
  await page.waitForTimeout(300);
  await page.press('textarea', 'Enter');
  await page.waitForTimeout(300);
  const draft = await page.inputValue('textarea');
  if (draft !== '/review ') throw new Error(`expected "/review " after accept, saw "${draft}"`);
  await page.type('textarea', '--strict');
  await page.press('textarea', 'Enter');
  await waitForText('Skill /review ran in the fixture');
  await shot('slash-commands-activated');
  const activation = await control({ action: 'session', session_id: 'session_fixture_slash' });
  const lastActivation = activation.data?.last_skill_activation;
  if (lastActivation?.name !== 'review' || lastActivation?.args !== '--strict') {
    throw new Error(`skill activation mismatch: ${JSON.stringify(lastActivation)}`);
  }
  // Client shortcut: /plan toggles the plan pill. Assert the FLIP, not an
  // absolute state — client settings persisted by earlier scenarios
  // (settings-write) can start plan mode either way. aria-pressed is the
  // contractual hook; the accent class is presentation.
  const planPressed = () =>
    page.evaluate((pillText) => {
      const pill = [...document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === pillText,
      );
      return pill?.getAttribute('aria-pressed');
    }, S.planPill);
  const planBefore = await planPressed();
  await page.fill('textarea', '/pl');
  await page.waitForTimeout(300);
  await page.press('textarea', 'Enter');
  await page.waitForTimeout(300);
  const planAfter = await planPressed();
  if (planAfter === planBefore || planAfter === undefined) {
    throw new Error(`/plan did not toggle the plan pill (before=${planBefore}, after=${planAfter})`);
  }
  await shot('slash-commands-plan');
  // Unknown slash text degrades honestly: it goes out as a plain prompt.
  await page.fill('textarea', '/notarealcommand hello');
  await page.press('textarea', 'Enter');
  await waitForText('Plain prompt received by the fixture.');
  const after = await control({ action: 'session', session_id: 'session_fixture_slash' });
  const plainText = (after.data?.last_prompt_submission?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  if (!plainText.startsWith('/notarealcommand')) {
    throw new Error(`unknown slash command was not sent as plain text: "${plainText}"`);
  }
  await shot('slash-commands-plain');
}

async function scenarioAttachments() {
  await selectSession('Fixture: attachments');
  await page.click('textarea');
  // "@" opens the picker; an empty query lists the workspace top level.
  await page.fill('textarea', '@');
  await page.waitForSelector(`text=${S.filesHeader}`, { timeout: 5000 });
  await page.waitForSelector('[role="option"]:has-text("README.md")', { timeout: 5000 });
  await page.waitForTimeout(450); // menu entrance settle
  await shot('attachments-picker');
  // Filter, then accept the file row → reference chip, token lifted from text.
  await page.fill('textarea', '@serv');
  await page.waitForSelector('[role="option"]:has-text("server.ts")', { timeout: 5000 });
  await page.locator('[role="option"]', { hasText: 'server.ts' }).first().click();
  await page.waitForSelector('[data-attachment-chips]', { timeout: 5000 });
  const chipText = await page.locator('[data-attachment-chips]').innerText();
  if (!chipText.includes('server.ts')) throw new Error(`file chip missing: ${chipText}`);
  const remaining = await page.inputValue('textarea');
  if (remaining !== '') throw new Error(`@token should be lifted out of the draft, saw "${remaining}"`);
  await shot('attachments-chip');
  // Paste an image: preview chip with thumbnail.
  await page.evaluate((pngBase64) => {
    const bytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0));
    const file = new File([bytes], 'paste.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const textarea = document.querySelector('textarea');
    textarea?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, TINY_PNG_BASE64);
  await page.waitForSelector('[data-attachment-chips] img', { timeout: 5000 });
  await shot('attachments-image');
  // Send: text part carries the @path mention, image rides as a base64 part.
  await page.type('textarea', 'what is in these?');
  await page.press('textarea', 'Enter');
  await waitForText('Attachments received by the fixture.');
  const state = await control({ action: 'session', session_id: 'session_fixture_attach' });
  const content = state.data?.last_prompt_submission?.content ?? [];
  const textPart = content.find((part) => part.type === 'text');
  const imagePart = content.find((part) => part.type === 'image');
  if (textPart === undefined || !textPart.text.startsWith('@src/server.ts')) {
    throw new Error(`mention did not fold into the text part: ${JSON.stringify(textPart)}`);
  }
  if (!textPart.text.includes('what is in these?')) {
    throw new Error(`typed text missing from the text part: ${JSON.stringify(textPart)}`);
  }
  if (
    imagePart === undefined ||
    imagePart.source?.kind !== 'base64' ||
    imagePart.source?.media_type !== 'image/png' ||
    typeof imagePart.source?.data !== 'string' ||
    imagePart.source.data.length === 0
  ) {
    throw new Error(`image part missing or malformed: ${JSON.stringify(imagePart)}`);
  }
  await shot('attachments-sent');
}

async function scenarioSearch() {
  // Open a session first so the main panel is not sitting on the previous
  // scenario's (stale) lastSessionId redirect.
  await selectSession('Fixture: search gamma');
  await page.waitForSelector('text=Fixture: search alpha', { timeout: 10_000 });
  await page.fill('[data-search-box]', 'persimmon');
  await page.waitForSelector('text=rotate the persimmon cache', { timeout: 5000 });
  await page.waitForTimeout(300);
  await shot('search-results');
  const groupCount = await page
    .locator('[data-search-results] p')
    .filter({ hasText: /Fixture: search/ })
    .count();
  if (groupCount !== 2) throw new Error(`expected 2 session groups, saw ${groupCount}`);
  const state = await control({ action: 'state' });
  if (state.data?.last_search?.query !== 'persimmon') {
    throw new Error(`search body mismatch: ${JSON.stringify(state.data?.last_search)}`);
  }
  await page
    .locator('[data-search-results] button', { hasText: 'draining the queue' })
    .first()
    .click();
  await page.waitForURL(/\/s\/session_fixture_search_a/, { timeout: 5000 });
  await page.waitForSelector('text=Rotate the persimmon cache', { timeout: 10_000 });
  await shot('search-opened');
  // Empty state.
  await page.fill('[data-search-box]', 'zzzznothing');
  await page.waitForSelector(`text=${S.noMatches}`, { timeout: 5000 });
  await shot('search-empty');
  await page.fill('[data-search-box]', '');
}

async function scenarioSessionActions() {
  await selectSession('Fixture: session actions');
  await page.waitForSelector('text=Second reply, undone.', { timeout: 10_000 });
  // Export (header overflow) — playwright captures the raw download.
  await page.locator('[data-session-actions] > button').click();
  const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
  await page.locator('[data-session-actions] button', { hasText: S.exportArchive }).click();
  const download = await downloadPromise;
  const filename = download.suggestedFilename();
  if (!filename.includes('export')) throw new Error(`unexpected export filename: ${filename}`);
  await page.waitForSelector(`text=${S.archiveDownloaded}`, { timeout: 5000 });
  await shot('session-actions-export');
  // Undo (header overflow) — confirm-first, then the transcript resyncs.
  await page.locator('[data-session-actions] > button').click();
  await page.locator('[data-session-actions] button', { hasText: S.undoLastTurn }).click();
  await page.waitForSelector(`text=${S.undoTitle}`, { timeout: 5000 });
  await page.waitForTimeout(400); // dialog entrance settle
  await shot('session-actions-undo-confirm');
  await page.locator('button', { hasText: S.undoTurn }).click();
  await page.waitForSelector(`text=${S.lastTurnRemoved}`, { timeout: 5000 });
  await page.waitForSelector('text=Second exchange — removed by undo.', {
    state: 'detached',
    timeout: 10_000,
  });
  await page.waitForSelector('text=First reply — survives the undo.', { timeout: 10_000 });
  await shot('session-actions-undone');
  // Compact (sidebar context menu).
  const row = page.locator('aside div.group', { hasText: 'Fixture: session actions' }).first();
  await row.hover();
  await row.locator(`button[aria-label^="${S.sessionActionsAria}"]`).click();
  await page.locator('[data-session-menu] button', { hasText: S.compactContext }).click();
  await page.waitForSelector(`text=${S.compactionRequested}`, { timeout: 5000 });
  await shot('session-actions-compact');
  // Fork (sidebar context menu) → lands on the copy.
  await row.hover();
  await row.locator(`button[aria-label^="${S.sessionActionsAria}"]`).click();
  await page.locator('[data-session-menu] button', { hasText: S.forkSession }).click();
  await page.waitForSelector('text=Fixture: session actions (fork)', { timeout: 10_000 });
  await shot('session-actions-fork');
}

/**
 * Language toggle through Settings → General: switch to the OTHER locale,
 * assert the chrome re-renders instantly (no reload), verify the choice
 * persists across a reload, then switch back so later scenarios stay in the
 * run's locale.
 */
async function scenarioI18n() {
  const other = LOCALE === 'zh' ? 'en' : 'zh';
  const otherDefaults = STRINGS[other].newSessionDefaults;
  await page.goto(`${WEB_URL}/settings/general?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector(`text=${S.newSessionDefaults}`, { timeout: 10_000 });
  await page.selectOption('#language-select', other);
  // Instant switch: the same page re-renders in the other locale, no reload.
  await page.waitForSelector(`text=${otherDefaults}`, { timeout: 5000 });
  const htmlLang = await page.evaluate(() => document.documentElement.lang);
  if ((other === 'zh' ? 'zh-CN' : 'en') !== htmlLang) {
    throw new Error(`<html lang> did not follow the locale: ${htmlLang}`);
  }
  await page.waitForTimeout(400);
  await shot(`i18n-switched-${other}`);
  // Persisted per device: a reload keeps the choice.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`text=${otherDefaults}`, { timeout: 10_000 });
  // Back to the run locale.
  await page.selectOption('#language-select', LOCALE);
  await page.waitForSelector(`text=${S.newSessionDefaults}`, { timeout: 5000 });
  await shot(`i18n-restored-${LOCALE}`);
}

// ---------------------------------------------------------------------------

const SCENARIOS = [
  ['basic-stream', scenarioBasicStream],
  ['prompt-dedupe', scenarioPromptDedupe],
  ['queue', scenarioQueue],
  ['subagents', scenarioSubagents],
  ['subagent-approval', scenarioSubagentApproval],
  ['subagents-burst', scenarioSubagentsBurst],
  ['goal-swarm', scenarioGoalSwarm],
  ['tool-pipeline', scenarioToolPipeline],
  ['question-card', scenarioQuestionCard],
  ['busy-rail', scenarioBusyRail],
  ['burst', scenarioBurst],
  ['long-transcript', scenarioLongTranscript],
  ['reminder', scenarioReminder],
  ['error-abort', scenarioErrorAbort],
  ['approvals-gallery', scenarioApprovalsGallery],
  ['reconnect', scenarioReconnect],
  ['reconnect-mid-turn', scenarioReconnectMidTurn],
  ['resync-hold', scenarioResyncHold],
  ['session-pages', scenarioSessionPages],
  ['empty-states', scenarioEmptyStates],
  ['draft-flow', scenarioDraftFlow],
  ['settings', scenarioSettings],
  ['settings-write', scenarioSettingsWrite],
  ['settings-invalid', scenarioSettingsInvalid],
  ['settings-desktop-gate', scenarioSettingsDesktopGate],
  ['slash-commands', scenarioSlashCommands],
  ['attachments', scenarioAttachments],
  ['search', scenarioSearch],
  ['session-actions', scenarioSessionActions],
  ['terminal', scenarioTerminal],
  ['i18n', scenarioI18n],
  // responsive stays last: it shrinks the viewport to 320px and nothing
  // afterward may assume a desktop layout.
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
  await waitForPortFree(FIXTURE_PORT);
  await waitForPortFree(WEB_PORT);
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
  let viteExited = null;
  vite.on('exit', (code) => {
    viteExited = code;
  });
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
    if (viteExited !== null) {
      throw new Error(`vite dev server exited early (code ${viteExited}) — refusing to run against a stale listener on ${WEB_URL}`);
    }
    console.log(`[proof] web up at ${WEB_URL}`);

    const browser = await chromium.launch();
    const bootPage = async () => {
      const next = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      next.on('pageerror', (error) => console.error(`[pageerror] ${error}`));
      next.on('console', (message) => {
        if (message.type() === 'error') console.error(`[console:error] ${message.text()}`);
      });
      // Seed the UI locale before any app code runs — only when no choice
      // exists yet, so the i18n walker's settings-toggle survives its reload
      // (persistence check) while every other scenario still boots in LOCALE.
      await next.addInitScript((locale) => {
        try {
          if (localStorage.getItem('kiki.locale') === null) {
            localStorage.setItem('kiki.locale', locale);
          }
        } catch {
          // storage unavailable — the app falls back to the navigator default
        }
      }, LOCALE);
      return next;
    };
    page = await bootPage();
    console.log(`[proof] locale: ${LOCALE}`);

    const deepLink = `${WEB_URL}/?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`;
    // domcontentloaded + an explicit app-ready selector: the app opens a WS
    // and polls sessions on a 5s cadence, so 'networkidle' is never a
    // reliable condition (30s startup flake under cold vite transforms).
    // The FIRST navigation right after a previous run's teardown can wedge
    // entirely (a half-recycled port answers waitForServer's plain fetch but
    // never serves the document): retry once with a fresh page before failing.
    try {
      await page.goto(deepLink, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      console.log(`[proof] first navigation failed (${error.message}) — retrying on a fresh page`);
      await page.close().catch(() => undefined);
      page = await bootPage();
      await page.goto(deepLink, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    }
    await page.waitForSelector(`text=${S.newSession}`, { timeout: 30_000 });
    console.log('[proof] connected to fixture');

    for (const [name, run] of SCENARIOS) {
      if (!wanted(name)) continue;
      console.log(`[scenario] ${name}`);
      try {
        await control({ action: 'scenario', name });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector(`text=${S.newSession}`, { timeout: 30_000 });
        await page.waitForTimeout(900); // let the first sessions poll land
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
