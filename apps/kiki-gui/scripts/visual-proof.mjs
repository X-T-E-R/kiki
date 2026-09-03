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
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';
import { selectProofOutput } from './visual-proof-options.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Ports are OS-assigned at run start unless pinned by env: Windows
// Hyper-V/WSL keeps shifting its excluded port ranges (today 51695–51794),
// and a hardcoded port inside one accepts the bind yet black-holes Chromium's
// loopback connects. An OS-assigned port dodges the exclusions by
// construction.
let FIXTURE_PORT = Number(process.env.KIKI_PROOF_FIXTURE_PORT ?? 0);
let WEB_PORT = Number(process.env.KIKI_PROOF_WEB_PORT ?? 0);
let FIXTURE_URL = '';
let WEB_URL = '';

/** Ask the OS for a free loopback port (skipped by exclusion ranges). */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => { probe.close(() => resolve()); });
  return port;
}

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
    noTargetHint: 'to enable sending',
    sendAria: 'Send message',
    working: 'working',
    approvalNeeded: 'Approval needed',
    approve: 'Approve',
    approved: 'Approved',
    externalChanges: 'granted change',
    kikiAsks: 'kiki asks',
    submit: 'Submit',
    settings: 'Settings',
    tabProviders: 'Connections',
    capabilities: 'Capabilities',
    configuredProviders: 'Configured providers',
    tools: 'Tools',
    skills: 'Skills',
    mcp: 'MCP',
    automation: 'Tools & hooks',
    shimCapabilities: 'The capabilities panel was split into dedicated settings pages',
    shimPlugins: 'Plugins',
    newSessionDefaults: 'New-session defaults',
    appearanceTitle: 'Appearance',
    searchQuery: 'theme',
    themeDark: 'Dark',
    themeLight: 'Light',
    switcherSettingsGroup: 'Settings',
    savedTick: '✓ Saved',
    planModeToggle: 'Start new sessions in plan mode',
    permissionModeAuto: 'auto',
    fetchModelsButton: 'Test connection & pull models',
    providerBadgeKimiCode: 'Kimi',
    providerBadgeNone: 'None',
    providerBadgeNoneTitle: 'Provider request identity: None (no request identity)',
    requestIdentityLabel: 'Request identity',
    providerIdLabel: 'Provider ID',
    providerProtocolLabel: 'Protocol',
    saveProvider: 'Save provider',
    dangerTitle: 'Danger zone',
    disabledMainHint: 'Still available for main sessions',
    technicalDetails: 'Technical details',
    overriddenNote: 'Built-in profile overridden by',
    overridesBuiltinNote: 'overrides the built-in profile',
    shadowedNote: 'Not in effect',
    dirtyDiscard: 'Discard and leave',
    modelProfileLabel: 'model profile',
    promptModeLabel: 'prompt mode',
    delegationNoticeLabel: 'delegation notice',
    scopedBadgeLabel: 'Scoped',
    planGateTimeoutInvalid: 'Timeout must be at least 5 seconds.',
    nbSearchSave: 'Save search & retrieval',
    nbSearchSaved: 'Search & retrieval saved',
    nbSearchRunCheck: 'Run readiness check',
    nbSearchCheckFailed: 'Readiness check failed',
    nbSearchFailClosed: 'refuses to run',
    nbSearchRevision: 'Config revision',
    nbSearchReady: 'Ready',
    nbSearchDegraded: 'Degraded',
    nbSearchUnconfigured: 'Not configured',
    loadMore: 'Load more sessions',
    searchLoadMore: 'Load more results',
    workspaceFilterAll: 'All workspaces',
    groupPinned: 'Pinned',
    groupByTime: 'By time',
    groupByWorkspace: 'By workspace',
    groupUngrouped: 'Ungrouped',
    sortUpdatedDesc: 'Recently updated',
    sortUpdatedAsc: 'Least recently updated',
    sortTitle: 'By name',
    menuPin: 'Pin to top',
    menuUnpin: 'Unpin',
    renameButton: 'Rename',
    removeButton: 'Unregister',
    save: 'Save',
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
    compactOlderContext: 'Compact older context',
    contextDetails: 'Context details',
    sessionUsage: 'Session cumulative',
    usageAllHistory: 'All history · no time filter applied',
    usageEstimatedCost: 'Estimated cost',
    usagePartial: 'partially unknown',
    usageReliability: 'Data reliability',
    usageDeletedExcluded: 'Deleted sessions are not included',
    usageFiveHourRhythm: '5h rhythm',
    usageDrilldown: 'Sessions in this bucket',
    usageSubagentPattern: /subagent/,
    pasteAsPlainText: 'Paste as plain text',
    contextMenuSelectAll: 'Select all',
    bannerPattern: /Connection lost|Disconnected from the server/,
    resyncing: 'Resyncing…',
    noSessions: 'No sessions yet',
    subagentTranscript: 'Subagent transcript',
    blankPage: 'A blank page',
    steps3: 'Steps · 3',
    filesHeader: 'Files — mentioned as @path',
    notActivatable: 'not activatable',
    shortcuts: 'Shortcuts',
    sendAnyway: 'Send anyway',
    swarmTitlePrefix: 'Swarm mode',
    goalActive: 'goal · active',
    objectivePlaceholder: 'Objective (optional)',
    noMatches: 'No matches',
    systemReminder: 'System reminder',
    fromSubagentApprover: 'from subagent Approver',
    queuePromptAria: 'Queue prompt',
    cancelQueuedAria: 'Cancel queued prompt',
    sendNow: 'Send now',
    removeQueued: 'Remove',
    clearQueue: 'Clear all',
    queueClearTitle: 'Clear 1 queued prompts?',
    twoPromptsQueued: '2 prompts queued',
    togglePanelAria: 'Toggle panel',
    openMenuAria: 'Open session menu',
    sessionActionsAria: 'Session actions',
    terminalEmpty: 'No terminals yet',
    terminalKillConfirm: 'sure?',
    terminalExited: 'Process exited (code 0)',
    capPlugin: 'Plugin skills',
    pluginsAdd: 'Add a plugin',
    pluginsMarketplaceTab: 'Marketplace',
    pluginsUnconfigured: 'Save a catalog URL to show its plugins here.',
    pluginsSaveCatalog: 'Save catalog URL',
    pluginsCatalogNotes: 'Catalog Notes',
    pluginsUninstall: 'Uninstall',
    pluginsManifest: 'Manifest',
    pluginsMcpOn: 'On',
    pluginsInstall: 'Install',
    cancel: 'Cancel',
    capBuiltin: 'Built-in skills',
    capFilterAria: 'Filter capabilities',
    capEmptyFilter: 'No capabilities match',
    capNoWorkspace: 'No workspace is registered',
    capRestartRequested: 'Restart requested.',
    turnWorking: 'Working',
    stopped: 'Stopped',
    ranForPattern: /Ran for/,
    ttftPattern: /TTFT/,
    queueExpandAria: 'Show or hide the queued prompts',
    previewSource: 'Source',
    previewCollapse: 'Collapse preview panel',
    previewReadonlyPattern: /Read-only here/,
    editAction: 'edit',
    regenerateAction: 'regenerate',
    forkAction: 'fork',
    resendEdit: 'Resend',
    showMore: 'Show more',
    showLess: 'Show less',
    editNote: 'Full replacement',
    forkedDone: 'Forked — opened the copy.',
    quoteAction: 'Quote',
    annotateAction: 'Annotate',
    removeAnnotation: 'Remove annotation',
  },
  zh: {
    newSession: '新会话',
    noTargetHint: '才能发送',
    sendAria: '发送消息',
    working: '工作中',
    approvalNeeded: '需要批准',
    approve: '批准',
    approved: '已批准',
    externalChanges: '授予',
    kikiAsks: 'kiki 提问',
    submit: '提交',
    settings: '设置',
    tabProviders: '连接服务',
    capabilities: '能力',
    configuredProviders: '已配置的提供商',
    tools: '工具',
    skills: '技能',
    mcp: 'MCP',
    automation: '工具与 Hooks',
    shimCapabilities: '能力面板已拆分为独立的设置页面',
    shimPlugins: '插件',
    newSessionDefaults: '新会话默认值',
    appearanceTitle: '外观',
    searchQuery: '主题',
    themeDark: '暗色',
    themeLight: '亮色',
    switcherSettingsGroup: '设置',
    savedTick: '✓ 已保存',
    planModeToggle: '新会话默认开启计划模式',
    permissionModeAuto: '自动',
    fetchModelsButton: '测试连接并拉取模型',
    providerBadgeKimiCode: 'Kimi',
    providerBadgeNone: '无',
    providerBadgeNoneTitle: '提供商请求身份: 无（不发送请求身份）',
    requestIdentityLabel: '请求身份',
    providerIdLabel: '提供商 ID',
    providerProtocolLabel: '协议',
    saveProvider: '保存提供商',
    dangerTitle: '危险操作',
    disabledMainHint: '仍可用于主会话',
    technicalDetails: '技术细节',
    overriddenNote: '内置档已被',
    overridesBuiltinNote: '已覆盖同名的内置档',
    shadowedNote: '未生效',
    dirtyDiscard: '丢弃并离开',
    modelProfileLabel: '模型档',
    promptModeLabel: '提示词模式',
    delegationNoticeLabel: '委派通知',
    scopedBadgeLabel: '专用',
    planGateTimeoutInvalid: '超时时间最短为 5 秒。',
    nbSearchSave: '保存搜索与抓取',
    nbSearchSaved: '搜索与抓取配置已保存',
    nbSearchRunCheck: '运行就绪检查',
    nbSearchCheckFailed: '就绪检查失败',
    nbSearchFailClosed: '不会执行',
    nbSearchRevision: '配置修订',
    nbSearchReady: '就绪',
    nbSearchDegraded: '部分可用',
    nbSearchUnconfigured: '未配置',
    loadMore: '加载更多会话',
    searchLoadMore: '加载更多结果',
    workspaceFilterAll: '全部工作区',
    groupPinned: '已置顶',
    groupByTime: '按时间',
    groupByWorkspace: '按工作区',
    groupUngrouped: '未分组',
    sortUpdatedDesc: '最近更新',
    sortUpdatedAsc: '最早更新',
    sortTitle: '按名称',
    menuPin: '置顶',
    menuUnpin: '取消置顶',
    renameButton: '重命名',
    removeButton: '注销',
    save: '保存',
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
    compactOlderContext: '压缩较早上下文',
    contextDetails: '上下文详情',
    sessionUsage: '本会话累计',
    usageAllHistory: '全部历史 · 未套用时间过滤',
    usageEstimatedCost: '估算成本',
    usagePartial: '部分未知',
    usageReliability: '数据可信度',
    usageDeletedExcluded: '不含已删除会话',
    usageFiveHourRhythm: '5h 节奏',
    usageDrilldown: '该时间桶内的会话',
    usageSubagentPattern: /子代理/,
    pasteAsPlainText: '粘贴为纯文本',
    contextMenuSelectAll: '全选',
    bannerPattern: /正在重连|已与服务器断开连接/,
    resyncing: '正在重新同步…',
    noSessions: '还没有会话',
    subagentTranscript: '子代理会话记录',
    blankPage: '白纸一张',
    steps3: '步骤 · 3',
    filesHeader: '文件 — 在消息中以 @路径 引用',
    notActivatable: '不可激活',
    shortcuts: '快捷指令',
    sendAnyway: '仍要发送',
    swarmTitlePrefix: '集群模式',
    goalActive: '目标 · 进行中',
    objectivePlaceholder: '目标（可选）',
    noMatches: '没有匹配',
    systemReminder: '系统提醒',
    fromSubagentApprover: '来自子代理 Approver',
    queuePromptAria: '加入队列',
    cancelQueuedAria: '取消排队的消息',
    sendNow: '立即追加',
    removeQueued: '移除',
    clearQueue: '全部清除',
    queueClearTitle: '清除 1 条排队消息？',
    twoPromptsQueued: '2 条消息已排队',
    togglePanelAria: '切换面板',
    openMenuAria: '打开会话菜单',
    sessionActionsAria: '会话操作',
    terminalEmpty: '还没有终端',
    terminalKillConfirm: '确认？',
    terminalExited: '进程已退出（代码 0）',
    capPlugin: '插件技能',
    pluginsAdd: '添加插件',
    pluginsMarketplaceTab: '市场',
    pluginsUnconfigured: '保存 URL 后目录将在此出现。',
    pluginsSaveCatalog: '保存目录 URL',
    pluginsCatalogNotes: 'Catalog Notes',
    pluginsUninstall: '卸载',
    pluginsManifest: '清单',
    pluginsMcpOn: '开',
    pluginsInstall: '安装',
    cancel: '取消',
    capBuiltin: '内置技能',
    capFilterAria: '过滤能力',
    capEmptyFilter: '没有匹配',
    capNoWorkspace: '没有已注册的工作区',
    capRestartRequested: '已请求重启。',
    turnWorking: '正在工作',
    stopped: '已停止',
    ranForPattern: /用时/,
    ttftPattern: /首 token/,
    queueExpandAria: '展开或收起排队消息',
    previewSource: '源码',
    previewCollapse: '收起预览面板',
    previewReadonlyPattern: /此处为只读/,
    editAction: '编辑',
    regenerateAction: '重新生成',
    forkAction: '分叉',
    resendEdit: '重发',
    showMore: '展开全部',
    showLess: '收起',
    editNote: '完整替换语义',
    forkedDone: '已分叉 — 正在打开副本。',
    quoteAction: '引用',
    annotateAction: '标注',
    removeAnnotation: '移除标注',
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
 * Find PIDs LISTENING on a loopback TCP port (Windows; empty elsewhere).
 * The local-address column is compared exactly — a substring match on
 * "127.0.0.1:5173" would also match 51730-51739 and has killed unrelated
 * host processes in the past. Read-only: never kills anything.
 */
function portHolderPids(port) {
  if (process.platform !== 'win32') return new Set();
  let out;
  try {
    out = execSync('netstat -ano -p tcp', { stdio: ['ignore', 'pipe', 'ignore'], shell: 'cmd.exe' }).toString();
  } catch {
    return new Set();
  }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue;
    const parts = line.trim().split(/\s+/);
    const local = parts[1];
    const pid = parts[parts.length - 1];
    if (local !== `127.0.0.1:${port}` && local !== `[::1]:${port}` && local !== `0.0.0.0:${port}`) continue;
    if (pid !== undefined && /^\d+$/.test(pid) && pid !== '0') pids.add(Number(pid));
  }
  return pids;
}

/**
 * True when `pid` is `rootPid` itself or one of its descendants (Windows,
 * via CIM parent walk). Used to ensure the proof runner only ever kills
 * processes it spawned itself.
 */
function isDescendantOf(pid, rootPid) {
  if (pid === rootPid) return true;
  const parentByPid = new Map();
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"',
      { stdio: ['ignore', 'pipe', 'ignore'], shell: 'cmd.exe' },
    ).toString();
    const rows = JSON.parse(out);
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      parentByPid.set(Number(row.ProcessId), Number(row.ParentProcessId));
    }
  } catch {
    return false;
  }
  let current = pid;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = parentByPid.get(current);
    if (parent === undefined || parent === 0 || parent === current) return false;
    if (parent === rootPid) return true;
    current = parent;
  }
  return false;
}

/**
 * Kill a port holder only when it belongs to our own spawned tree
 * (the vite dev server we started). Foreign processes are never touched;
 * the caller must re-probe a different port or fail instead.
 */
function killOwnPortHolder(port, rootPid) {
  if (process.platform !== 'win32' || rootPid === undefined) return;
  for (const pid of portHolderPids(port)) {
    if (!isDescendantOf(pid, rootPid)) {
      console.warn(`[proof] port ${port} held by foreign pid ${pid} — NOT killing it`);
      continue;
    }
    try {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' });
      console.log(`[proof] freed port ${port} (own pid ${pid})`);
    } catch {
      // already gone
    }
  }
}

// ---------------------------------------------------------------------------

let page;
const pageErrors = [];
let pageErrorCursor = 0;

function throwOnPageErrors(context) {
  const pending = pageErrors.slice(pageErrorCursor);
  pageErrorCursor = pageErrors.length;
  if (pending.length === 0) return;
  const detail = pending.map((error) => error.stack ?? error.message ?? String(error)).join('\n\n');
  throw new Error(`${context} emitted ${pending.length} pageerror event(s):\n${detail}`);
}

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

/** The three permission modes live behind [mode ▾]. */
async function openModePanel() {
  const trigger = page.locator('[data-mode-select] > button');
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await page.waitForSelector('[data-mode-select] [role="option"]', { timeout: 5000 });
}

async function closeModePanel() {
  const trigger = page.locator('[data-mode-select] > button');
  if ((await trigger.getAttribute('aria-expanded')) === 'true') {
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(200);
}

/** Plan, swarm and the goal objective live behind their own [plan ▾]. */
async function openPlanPanel() {
  const trigger = page.locator('[data-plan-select] > button');
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await page.waitForSelector('[data-plan-select] [data-mode-switch="plan"]', { timeout: 5000 });
}

async function closePlanPanel() {
  const trigger = page.locator('[data-plan-select] > button');
  if ((await trigger.getAttribute('aria-expanded')) === 'true') {
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(200);
}

async function approveViaKeyboard() {
  await page.mouse.click(720, 120); // focus out of the textarea
  await page.keyboard.press('y');
}

async function waitForText(text, timeout = 20_000) {
  await page.waitForSelector(`text=${text}`, { timeout });
}

const CANONICAL_PROOF_SCENARIOS = new Set([
  'basic-stream',
  'queue',
  'reconnect',
  'reconnect-mid-turn',
  'resync-hold',
  'rewrite-flow',
  'subagents',
  'long-transcript',
  'subagent-approval',
  'attachments',
]);

async function assertCanonicalTranscriptProtocol(scenarioName) {
  const log = await control({ action: 'ws_log' });
  const inbound = log.data?.inbound ?? [];
  const outbound = log.data?.outbound ?? [];
  const subscribeV2 = inbound.filter((frame) => frame.type === 'subscribe_v2');
  const transcriptFrames = outbound.filter(
    (frame) => frame.type === 'transcript.reset' || frame.type === 'transcript.ops',
  );
  console.log(`[check] ${scenarioName} subscribe_v2=${subscribeV2.length} transcriptFrames=${transcriptFrames.length}`);
  if (subscribeV2.length === 0) {
    throw new Error(`${scenarioName}: expected the GUI to send subscribe_v2`);
  }
  const grades = subscribeV2.at(-1)?.payload?.transcript ?? {};
  if (grades.main !== 'delta' && grades['*'] === undefined) {
    throw new Error(`${scenarioName}: subscribe_v2 missing per-agent grades`);
  }
  if (transcriptFrames.length === 0) {
    throw new Error(`${scenarioName}: expected transcript.reset/ops frames on the wire`);
  }
}

async function assertCanonicalDomSurface() {
  const probe = await page.evaluate(() => {
    const log = document.querySelector('[role="log"]');
    const rows = [...(log?.querySelectorAll('[data-block-id]') ?? [])];
    return {
      blockIds: rows.map((row) => row.getAttribute('data-block-id')),
      subagentIds: [...document.querySelectorAll('[data-subagent-id]')].map((el) => el.getAttribute('data-subagent-id')),
      rowActions: [...document.querySelectorAll('[data-row-action]')].map((el) => el.getAttribute('data-row-action')),
      turnTail: document.querySelector('[data-turn-tail]') !== null,
      userKeys: rows
        .filter((row) => (row.getAttribute('data-block-id') ?? '').startsWith('user-'))
        .map((row) => row.getAttribute('data-block-id')),
    };
  });
  console.log(`[check] canonical DOM blocks=${probe.blockIds.length} subagents=${probe.subagentIds.length} actions=${probe.rowActions.join(',')}`);
  if (probe.blockIds.length === 0) throw new Error('canonical DOM: expected data-block-id rows');
  return probe;
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

/**
 * rewrite-flow — the message-closure walk: long user message collapse, floor
 * nav rail, hover row actions, edit-resend (truncates the tail), regenerate,
 * and fork-to-new-session navigation. Asserts hit the fixture control plane
 * (last_message_action / message_ids) so the wire contract itself is proven,
 * not just the repaint.
 */
async function scenarioRewriteFlow() {
  await selectSession('Fixture: rewrite flow');
  await waitForText('TAIL-REPLY doomed to be rewritten away.');

  // A2: the long user message clamps and offers the expand toggle.
  const longRow = page.locator('[data-block-id^="user-"]', { hasText: 'Requirement 14' }).first();
  await longRow.waitFor({ timeout: 10_000 });
  const clamped = longRow.locator('[data-collapsible-content]');
  const clampBox = await clamped.boundingBox();
  const toggle = longRow.locator('[data-collapsible-toggle]');
  await toggle.waitFor({ timeout: 5_000 });
  console.log(`[check] collapsed user bubble height=${clampBox?.height}`);
  if (clampBox === null || clampBox.height > 320) {
    throw new Error(`expected the long user message to be clamped, got height ${clampBox?.height}`);
  }
  await shot('rewrite-flow-collapsed');
  await toggle.click();
  await page.waitForTimeout(400);
  const expandedBox = await clamped.boundingBox();
  console.log(`[check] expanded user bubble height=${expandedBox?.height}`);
  if (expandedBox === null || expandedBox.height <= 320) {
    throw new Error('expected the user message to expand past the clamp');
  }
  await shot('rewrite-flow-expanded');
  // Collapse back so the edit walk starts from a compact layout.
  await longRow.locator('[data-collapsible-toggle]').click();
  await page.waitForTimeout(300);

  // A3: scrolling reveals the floor rail; clicking a tick jumps.
  await page.mouse.move(720, 450);
  await page.mouse.wheel(0, -3000);
  await page.waitForTimeout(400);
  const rail = page.locator('[data-floor-nav]');
  await rail.waitFor({ timeout: 5_000 });
  const railOpacity = await rail.evaluate((el) => getComputedStyle(el).opacity);
  console.log(`[check] floor rail opacity while scrolling=${railOpacity}`);
  if (Number(railOpacity) < 0.9) throw new Error('floor rail did not reveal on scroll');
  const tickCount = await rail.locator('[data-floor-tick]').count();
  console.log(`[check] floor ticks=${tickCount}`);
  if (tickCount !== 3) throw new Error(`expected 3 floor ticks, got ${tickCount}`);
  await shot('rewrite-flow-floors');
  await rail.locator('[data-floor-tick]').first().click();
  await page.waitForTimeout(700);

  // A1 edit: hover the first user row, open the inline editor, resend.
  const firstRow = page.locator('[data-block-id^="user-"]', { hasText: 'First fixture question' }).first();
  await firstRow.hover();
  await firstRow.locator('[data-row-action="edit"]').click();
  const editor = page.locator('[data-edit-editor]');
  await editor.waitFor({ timeout: 5_000 });
  await waitForText(S.editNote);
  await shot('rewrite-flow-editing');
  await editor.locator('textarea').fill('First fixture question — edited resend.');
  await editor.locator('[data-edit-submit]').click();
  await waitForText('EDITED-REPLY landed after the rewrite.');
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(800); // resync repaint settles
  // The truncated tail is gone from both the DOM and the server journal.
  const tailGone = await page.locator('text=TAIL-REPLY').count();
  const tailPromptGone = await page.locator('text=Tail question that edits will truncate.').count();
  console.log(`[check] after edit tail blocks=${tailGone + tailPromptGone}`);
  if (tailGone + tailPromptGone !== 0) throw new Error('edit-resend did not truncate the tail');
  const afterEdit = await control({ action: 'session', session_id: 'session_fixture_rewrite' });
  console.log(`[check] edit action=${JSON.stringify(afterEdit.data?.last_message_action?.action)} ids=${JSON.stringify(afterEdit.data?.message_ids)}`);
  if (afterEdit.data?.last_message_action?.action !== 'edit') {
    throw new Error('fixture did not record the edit action');
  }
  // Editing the FIRST user message truncates all six originals; the journal
  // then holds exactly the resent user message and the committed reply.
  if ((afterEdit.data?.message_ids ?? []).length !== 2) {
    throw new Error('expected 2 messages after the edit truncation');
  }
  await shot('rewrite-flow-edit-done');

  // A1 regenerate: only the latest final assistant reply offers it.
  const replyRow = page.locator('[data-block-id^="agent-frame-"], [data-block-id^="assistant-"]', { hasText: 'EDITED-REPLY' }).first();
  await replyRow.hover();
  await replyRow.locator('[data-row-action="regenerate"]').click();
  await waitForText('REGENERATED-REPLY replaced the old tail.');
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  const afterRegen = await control({ action: 'session', session_id: 'session_fixture_rewrite' });
  console.log(`[check] regenerate action=${JSON.stringify(afterRegen.data?.last_message_action?.action)}`);
  if (afterRegen.data?.last_message_action?.action !== 'regenerate') {
    throw new Error('fixture did not record the regenerate action');
  }
  await shot('rewrite-flow-regenerated');

  // A1 fork: from the first user message — navigates to the truncated copy.
  const forkRow = page.locator('[data-block-id^="user-"]', { hasText: 'First fixture question' }).first();
  await forkRow.hover();
  await forkRow.locator('[data-row-action="fork"]').click();
  await page.waitForURL(/\/s\/session_/, { timeout: 10_000 });
  await page.waitForFunction(
    () => !window.location.pathname.includes('session_fixture_rewrite'),
    { timeout: 10_000 },
  );
  await waitForText('First fixture question');
  await page.waitForTimeout(500);
  // Fork through the (only) user message: the copy keeps just that message —
  // the reply comes after it, and the fork's tail stays open.
  const forkUrl = page.url();
  const forkId = forkUrl.split('/s/')[1];
  const forked = await control({ action: 'session', session_id: forkId });
  console.log(`[check] fork messages=${JSON.stringify(forked.data?.message_ids)}`);
  if ((forked.data?.message_ids ?? []).length !== 1) {
    throw new Error('expected the fork to keep 1 message (through the first user message)');
  }
  await shot('rewrite-flow-forked');
}


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
  if (bubbleCount !== 2) {
    throw new Error(`expected 2 subagent bubbles, got ${bubbleCount}/${inlineToolCount}`);
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
  // Swarm and the objective are two rows of the [plan ▾] panel now.
  await openPlanPanel();
  await page.click(`[data-mode-switch="swarm"][title^="${S.swarmTitlePrefix}"]`);
  await page.click('[data-goal-open]');
  await page.fill(`input[placeholder="${S.objectivePlaceholder}"]`, 'Ship the fixture release');
  await closePlanPanel();
  await sendPrompt('Advance the release goal.');
  await waitForText('Swarm mode is on and the goal state is live.');
  const inspected = await control({ action: 'session', session_id: 'session_fixture_goal_swarm' });
  const submission = inspected.data?.last_prompt_submission;
  console.log(`[check] goal/swarm submission ${JSON.stringify(submission)}`);
  if (submission?.swarm_mode !== true || submission?.goal_objective !== 'Ship the fixture release') {
    throw new Error('PromptSubmission did not carry swarm_mode + goal_objective');
  }
  // The live goal keeps a resident trace on the chip band, with its run-state
  // controls attached — nothing has to be reopened to see or steer it.
  const goalChip = page.locator('[data-goal-chip]');
  await goalChip.waitFor({ timeout: 10_000 });
  const goalChipText = await goalChip.textContent();
  if (goalChipText === null || !goalChipText.includes(S.goalActive)) {
    throw new Error(`goal chip must trace the run state, got "${goalChipText}"`);
  }
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
  // Jump pill + floor rail from the bottom of the log.
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

async function scenarioExternalHarness() {
  await selectSession('Fixture: external harness');
  // Agent-supplied strings, not localized chrome: the option list and the
  // turn-header badge anchor on fixture content.
  await waitForText('Grok wants to run', 10_000);
  // Turn-header execution badge rides turn.execution (transcriptTurnExecutionSchema).
  await page.waitForSelector('[data-turn-execution]', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('external-harness');
  // Expand "what this grants" on the allow-always option, then pick it — the
  // resolve body carries selected_option_id=opt-allow-always.
  await page.locator(`button:has-text("${S.externalChanges}")`).click();
  await page.waitForTimeout(300);
  await shot('external-harness-changes');
  await page.locator('[role="radio"]:has-text("Always allow pnpm test")').click();
  await page.waitForTimeout(600);
  await shot('external-harness-resolved');
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

async function scenarioNewNoWorkspace() {
  // Zero registered workspaces: the /new composer keeps the textarea
  // editable but blocks sending, and the hero names the next step instead of
  // showing a bare disabled button.
  await page.goto(`${WEB_URL}/new?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('[data-phase="hero"]', { timeout: 15_000 });
  await page.waitForSelector(`text=${S.noTargetHint}`, { timeout: 15_000 });
  await page.fill('textarea', 'Still editable while no workspace is chosen.');
  const textarea = page.locator('textarea[data-composer]');
  if (await textarea.isDisabled()) {
    throw new Error('textarea must stay editable when no workspace exists');
  }
  const sendButton = page.locator(`button[aria-label="${S.sendAria}"]`);
  if (!(await sendButton.isDisabled())) {
    throw new Error('send must stay blocked until a workspace or absolute path is chosen');
  }
  if ((await sendButton.getAttribute('title')) === null) {
    throw new Error('the blocked send button must carry an explanatory tooltip');
  }
  await page.waitForTimeout(400);
  await shot('new-no-workspace');
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

/**
 * hero-shell — the conversation-shell proof: hero phase on /new (centered
 * composer + chrome + warm glow), the single-tree flip into /s/:id (the
 * composer textarea must stay the SAME DOM node, focus kept), the docked
 * active phase with its 36px fade mask, and hero/active geometry at tablet
 * and mobile widths. Restores the desktop viewport for later scenarios.
 */
async function scenarioHeroShell() {
  const deepLink = (path) =>
    `${WEB_URL}${path}?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`;

  await page.goto(deepLink('/new'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-phase="hero"]', { timeout: 15_000 });
  await page.waitForSelector('textarea:not([disabled])', { timeout: 15_000 });
  await page.waitForTimeout(600);
  await shot('hero-desktop');

  // Agent picker: a standalone toolbar control again. Only main profiles are
  // conversation partners — subagent profiles (reviewer) never list, and with
  // every option a main profile the labels carry no ` · main` suffix.
  await page.waitForSelector('#composer-agent-profile-select', { timeout: 10_000 });
  const profileTrigger = page.locator('#composer-agent-profile-select');
  const profileTriggerText = await profileTrigger.textContent();
  if (profileTriggerText === null || !profileTriggerText.includes('agent') || /main|主档/.test(profileTriggerText)) {
    throw new Error(`agent picker trigger must show the plain profile name, got "${profileTriggerText}"`);
  }
  await profileTrigger.click();
  const profileOptions = await page
    .locator('#composer-agent-profile-select-list [role="option"]')
    .allTextContents();
  if (
    profileOptions.length !== 2
    || !profileOptions.some((text) => text.includes('grok-only'))
    || profileOptions.some((text) => text.includes('reviewer'))
  ) {
    throw new Error(`agent picker must list exactly the main profiles, got ${JSON.stringify(profileOptions)}`);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // The workspace chip opens the shared workspace/cwd fields as a popover.
  await page.click('[data-hero-workspace] > button');
  await page.waitForTimeout(400);
  await shot('hero-workspace-chip');
  await page.click('[data-hero-workspace] > button');

  // Mark the composer node, send, and prove identity across the flip.
  await page.click('textarea');
  await page.fill('textarea', 'Run the fixture hero shell flow.');
  await shot('hero-filled');
  await page.evaluate(() => {
    window.__heroTextarea = document.querySelector('textarea');
  });
  await page.press('textarea', 'Enter');
  await page.waitForURL(/\/s\//, { timeout: 10_000 });
  await page.waitForSelector('[data-phase="active"]', { timeout: 10_000 });
  const identity = await page.evaluate(() => ({
    same: document.querySelector('textarea') === window.__heroTextarea,
    focused: document.activeElement === window.__heroTextarea,
  }));
  console.log(
    `[check] composer node across hero→active flip: same=${identity.same} focused=${identity.focused}`,
  );
  if (!identity.same) {
    throw new Error('composer textarea was remounted across the /new → /s/:id flip');
  }
  // Focus returns once the composer re-enables: the send's busy flip
  // (disabled textarea) force-blurs, and the session is still loading here —
  // the one-shot refocus lands when the transcript has loaded and the answer
  // streams.
  await page.waitForSelector('text=Here is the fixture answer from the hero shell flow.', {
    timeout: 20_000,
  });
  const focusedAfter = await page.evaluate(
    () => document.activeElement === window.__heroTextarea,
  );
  console.log(`[check] composer focus restored after the flip: ${focusedAfter}`);
  if (!focusedAfter) {
    throw new Error('composer textarea never regained focus after the /new → /s/:id flip');
  }
  await page
    .waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 20_000 })
    .catch(() => undefined);
  await page.waitForTimeout(700);
  await shot('hero-flip-active');

  // The docked composer's fade mask, up close (transcript tail → card top).
  const seatBox = await page.locator('[data-composer-seat]').boundingBox();
  if (seatBox === null) throw new Error('composer seat missing after the flip');
  const clipTop = Math.max(0, seatBox.y - 140);
  await page.screenshot({
    path: join(SHOTS, 'hero-active-mask.png'),
    clip: { x: 0, y: clipTop, width: 1440, height: seatBox.y + seatBox.height - clipTop },
  });
  console.log('[shot] hero-active-mask.png');
  const sessionPath = new URL(page.url()).pathname;

  // Back on /new the hero returns, now with the recent-sessions chips.
  await page.goto(deepLink('/new'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-phase="hero"]', { timeout: 15_000 });
  await page.waitForSelector('text=hero shell flow', { timeout: 10_000 });
  await page.waitForTimeout(500);
  await shot('hero-recents');

  // Tablet (768–1023): hero.
  await resizeViewport(900);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-phase="hero"]', { timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot('hero-tablet-900');

  // Mobile (≤767): hero, the sidebar drawer from the hero header, then the
  // cold-loaded session (settling → active) with the docked composer.
  await resizeViewport(390);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-phase="hero"]', { timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot('hero-mobile-390');
  await page.click(`button[aria-label="${S.openMenuAria}"]`);
  await page.waitForTimeout(400);
  await shot('hero-mobile-drawer');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await page.goto(deepLink(sessionPath), { waitUntil: 'domcontentloaded' });
  const coldPhase = await page.waitForSelector('[data-phase]', { timeout: 15_000 });
  console.log(`[check] cold session load opens in phase: ${await coldPhase.getAttribute('data-phase')}`);
  await page.waitForSelector('[data-phase="active"]', { timeout: 15_000 });
  await page.waitForSelector('text=hero shell flow', { timeout: 15_000 });
  await page.waitForTimeout(600);
  await shot('hero-active-mobile-390');

  // Leave the desktop layout for the scenarios that follow.
  await resizeViewport(1440);
}

async function scenarioSettings() {
  await page.goto(`${WEB_URL}/settings?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector(`text=${S.settings}`, { timeout: 10_000 });
  await page.waitForTimeout(500);
  await shot('settings-general');

  // Batch 2 merged Models + Providers into one "Models & providers" entry
  // with three tabs; the nav leaf opens the default (Available models) tab.
  await page.locator('nav [data-settings-nav-leaf="ai"]').click();
  await page.waitForSelector('text=Kiki Pro', { timeout: 10_000 });
  // The second fixture provider proves the per-provider grouping renders.
  await page.waitForSelector('text=Alt Claude X', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('settings-models');

  await page.locator('[data-ai-tab="providers"]').click();
  await page.waitForSelector(`text=${S.configuredProviders}`, { timeout: 10_000 });
  // The pending device-code flow is seeded by the scenario — proof for the
  // OAuth card (code, countdown, polling indicator).
  await page.waitForSelector('text=ABCD-EFGH', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('settings-providers');

  // Reload-proof + legacy-route proof: the pre-merge /settings/providers
  // bookmark redirects to /settings/ai?tab=providers and lands on the same
  // card, so a dev-server reload cannot strand the assertions on the wrong tab.
  await page.goto(`${WEB_URL}/settings/providers?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#st-card-providers', { timeout: 10_000 });

  // Collapsed provider summaries always carry the request-identity badge:
  // the configured preset on `fixture`, the explicit none on managed `alt`.
  const providerSummary = (id) => page.locator('#st-card-providers details summary', { hasText: id });
  await providerSummary('fixture').getByText(S.providerBadgeKimiCode, { exact: false }).waitFor({ timeout: 5000 });
  await providerSummary('alt').getByText(S.providerBadgeNone, { exact: false }).waitFor({ timeout: 5000 });
  // The short badge keeps the full label on its tooltip for clarity.
  await providerSummary('alt').locator(`[title="${S.providerBadgeNoneTitle}"]`).waitFor({ timeout: 5000 });

  // Expand the OAuth-managed provider: id/protocol stay locked, the request
  // identity dropdown stays editable, the Save surface renders, and the
  // credential field + danger zone stay hidden.
  const managedEditor = page.locator('#st-card-providers details', { hasText: 'alt' });
  await managedEditor.locator('summary').click();
  const managedIdInput = managedEditor.getByLabel(S.providerIdLabel);
  const managedProtocol = managedEditor.getByLabel(S.providerProtocolLabel);
  if (!(await managedIdInput.isDisabled()) || !(await managedProtocol.isDisabled())) {
    throw new Error('managed provider id/protocol inputs must be disabled');
  }
  // The identity select is the one carrying the kimi_code preset option; a
  // label lookup cannot work here (the wrapping label's text includes every
  // option, and the summary badge's aria-label shares the label prefix).
  const managedIdentity = managedEditor.locator('select', {
    has: page.locator('option[value="kimi_code"]'),
  });
  if (await managedIdentity.isDisabled()) {
    throw new Error('managed provider request identity dropdown must stay editable');
  }
  if ((await managedIdentity.inputValue()) !== 'none') {
    throw new Error(`managed provider request identity should echo the none preset, got ${await managedIdentity.inputValue()}`);
  }
  await managedEditor.getByRole('button', { name: S.saveProvider }).waitFor({ timeout: 5000 });
  if ((await managedEditor.locator('input[type="password"]').count()) !== 0) {
    throw new Error('managed provider must not render the API-key field');
  }
  if ((await managedEditor.getByText(S.dangerTitle, { exact: true }).count()) !== 0) {
    throw new Error('managed provider must not render the danger zone');
  }
  // Frame the shot from the editor's top so the summary badge, the locked
  // id/protocol fields, the identity dropdown, and the Save button all fit.
  await managedEditor.evaluate((element) => { element.scrollIntoView({ block: 'start' }); });
  await page.waitForTimeout(200);
  await shot('settings-providers-managed');
  // Fold it back so the wizard flow below sees the original layout.
  await managedEditor.locator('summary').click();

  // New-provider wizard: pick the Anthropic template, point it at the fixture
  // server's mock upstream, and pull its model list through the browser fetch.
  await page.locator('button:has(span:text-is("Anthropic"))').click();
  await page.locator('input[placeholder="https://api.example.com/v1"]:visible')
    .fill(`${FIXTURE_URL}/provider-mock/v1`);
  await page.locator('input[type="password"]:visible').fill('fixture-key');
  await page.locator(`button:has-text("${S.fetchModelsButton}"):visible`).click();
  await page.waitForSelector('text=mock-pro', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('settings-providers-wizard');

  // Batch 3 split the capabilities leaf into skills / mcp / automation under
  // "Capabilities & extensions". Nav leaf ids are stable, so click them
  // directly (the app sidebar no longer carries a capabilities entry).
  await page.locator('nav [data-settings-nav-leaf="skills"]').click();
  // The unsaved wizard draft arms the dirty guard: confirm the discard so the
  // navigation proceeds (the dialog itself is proof the guard fired).
  await page.waitForSelector(`text=${S.dirtyDiscard}`, { timeout: 5000 });
  await shot('settings-dirty-guard');
  await page.click(`text=${S.dirtyDiscard}`);
  // Skills leaf: server-side defaults card plus the workspace skill catalog
  // (the old /capabilities browser, re-homed).
  await page.waitForSelector('#st-card-caps', { timeout: 10_000 });
  await page.waitForSelector('#st-card-skill-catalog', { timeout: 10_000 });
  await page.waitForSelector(`text=${S.capPlugin}`, { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('settings-skills');

  // MCP leaf: per-workspace config entries, live status rows, and the
  // server-wide timeouts that moved out of runtime (redesign §8.3).
  await page.locator('nav [data-settings-nav-leaf="mcp"]').click();
  await page.waitForSelector('#st-card-mcp', { timeout: 10_000 });
  await page.waitForSelector('text=fixture-mcp', { timeout: 10_000 });
  await page.waitForSelector('#st-card-mcp-status', { timeout: 10_000 });
  await page.waitForSelector('#st-card-mcp-timeouts', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('settings-mcp');

  // Plugins leaf (batch 5): installed list plus the add card. Default fixture
  // has no marketplace URL, so the Marketplace tab is a how-to, not an error.
  await page.locator('nav [data-settings-nav-leaf="plugins"]').click();
  await page.waitForSelector('#st-card-plugins', { timeout: 10_000 });
  await page.waitForSelector('#st-card-plugins-add', { timeout: 10_000 });
  await page.waitForSelector('text=fixture-plugin', { timeout: 10_000 });
  await page.locator('[data-plugin-details-toggle="fixture-plugin"]').click();
  await page.waitForSelector('[data-plugin-details="fixture-plugin"]', { timeout: 10_000 });
  await page.waitForSelector('text=fixture-plugin-mcp', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('settings-plugins');
  await page.locator(`[data-plugin-add-tab-button="marketplace"]`).click();
  await page.waitForSelector('[data-marketplace-empty]', { timeout: 10_000 });
  await page.waitForSelector(`text=${S.pluginsUnconfigured}`, { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('settings-plugins-marketplace');
  await page.locator('[data-plugin-add-tab="marketplace"] input').fill('https://example.test/marketplace.json');
  await page.getByRole('button', { name: S.pluginsSaveCatalog }).click();
  await page.waitForSelector('[data-marketplace-row="catalog-notes"]', { timeout: 10_000 });
  await page.waitForSelector(`text=${S.pluginsCatalogNotes}`, { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('settings-plugins-marketplace-catalog');
  await page.locator('[data-plugin-details-toggle="fixture-plugin"]').click();
  await page.locator('[data-marketplace-row="catalog-update"]').scrollIntoViewIfNeeded();
  await page.waitForSelector('[data-marketplace-action="fixture-plugin"]', { timeout: 10_000 });
  await page.waitForSelector('[data-marketplace-action="catalog-update"]', { timeout: 10_000 });
  await page.waitForTimeout(200);
  await shot('settings-plugins-marketplace-states');
  await page.locator('[data-plugin-uninstall="fixture-plugin"]').click();
  await page.waitForSelector('[role="alertdialog"]', { timeout: 10_000 });
  await page.waitForTimeout(200);
  await shot('settings-plugins-uninstall');
  await page.locator('[role="alertdialog"]').getByRole('button', { name: S.cancel, exact: true }).click();

  // Automation leaf: tool policy plus the raw hooks editor.
  await page.locator('nav [data-settings-nav-leaf="automation"]').click();
  await page.waitForSelector('#st-card-tools', { timeout: 10_000 });
  await page.waitForSelector(`text=${S.tools}`, { timeout: 10_000 });
  await page.waitForSelector('#st-card-hooks', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('settings-automation');

  // Legacy redirect proof (redesign §10.2 rule 3): the retired capabilities
  // section still resolves — a precise card hash follows the card across the
  // split, landing on the MCP leaf instead of skills.
  await page.goto(`${WEB_URL}/settings/capabilities?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}#st-card-mcp`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#st-card-mcp', { timeout: 10_000 });
  await page.waitForSelector('#st-card-mcp-timeouts', { timeout: 10_000 });
  if (!page.url().includes('/settings/mcp')) {
    throw new Error(`legacy capabilities#st-card-mcp must canonicalize to the mcp leaf, got ${page.url()}`);
  }
}

/**
 * E4 settings convenience. Search is the shortest path to a setting, so this
 * walks it end to end: Ctrl+, opens settings with the caret already in the
 * field, Enter jumps to the card and flashes it, and Ctrl+K reaches the same
 * cards from a session. The density claim (flat grouped rows put all of
 * General on one 1280×800 screen) is measured, not eyeballed, and the dark
 * theme gets its own pass because the new rows lean on hairline tokens.
 */
async function scenarioSettingsSearch() {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${WEB_URL}/new?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector(`text=${S.newSession}`, { timeout: 10_000 });

  // Ctrl+, from outside settings: the page opens with focus in the search box.
  await page.keyboard.press('Control+Comma');
  await page.waitForURL(/\/settings/, { timeout: 10_000 });
  await page.waitForSelector('[data-settings-search]', { timeout: 10_000 });
  await page.waitForFunction(
    () => document.activeElement?.hasAttribute('data-settings-search') === true,
    { timeout: 5000 },
  );
  await page.waitForTimeout(400);
  await shot('settings-search-focused');

  // Density: the General content region must fit below the fixed scope header
  // at 1280×800 — the header is an intentional settings-redesign element, so
  // the content density budget is measured net of its height. When the batch
  // 2/3 split lands, General shrinks again and this can return to a plain
  // zero-overflow assertion.
  const overflow = await page.evaluate(() => {
    const pane = document.querySelector('[data-settings-scroll]');
    if (pane === null) return null;
    const header = document.querySelector('[data-settings-scope-header]');
    const headerHeight = header === null ? 0 : header.getBoundingClientRect().height;
    return pane.scrollHeight - pane.clientHeight - Math.round(headerHeight);
  });
  if (overflow === null) throw new Error('settings scroll pane not found');
  if (overflow > 0) {
    throw new Error(`General section still scrolls at 1280×800 (${overflow}px overflow beyond the scope header)`);
  }

  // Type → hit list → Enter lands on the card and flashes it.
  await page.keyboard.type(S.searchQuery);
  await page.waitForSelector(`[role="option"]:has-text("${S.appearanceTitle}")`, { timeout: 5000 });
  await page.waitForTimeout(200);
  await shot('settings-search-hits');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#st-card-appearance.settings-card-flash', { timeout: 5000 });
  await shot('settings-search-landed');

  // Dark theme: the flat rows carry their grouping through the dark tokens too.
  await page.locator('#st-card-appearance').getByRole('button', { name: S.themeDark, exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset['theme'] === 'dark',
    { timeout: 5000 },
  );
  await page.waitForTimeout(600); // let the flash finish so the shot is steady
  await shot('settings-search-dark');

  // Narrow viewport keeps the search box above the section select.
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(300);
  await page.waitForSelector('[data-settings-search]:visible', { timeout: 5000 });
  await shot('settings-search-narrow');
  await page.setViewportSize({ width: 1280, height: 800 });

  // Ctrl+K from a session reaches settings cards by name, under the session
  // and message groups.
  await page.goto(`${WEB_URL}/new?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector(`text=${S.newSession}`, { timeout: 10_000 });
  await page.keyboard.press('Control+k');
  await page.waitForSelector('#quick-switcher-list', { timeout: 5000 });
  await page.keyboard.type(S.searchQuery);
  const switcherList = page.locator('#quick-switcher-list');
  await switcherList.getByText(S.switcherSettingsGroup, { exact: true }).waitFor({ timeout: 5000 });
  const settingRow = switcherList.locator('[role="option"]', { hasText: S.appearanceTitle });
  await settingRow.first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(200);
  await shot('settings-search-switcher');
  await settingRow.first().click();
  await page.waitForSelector('#st-card-appearance.settings-card-flash', { timeout: 10_000 });
  await shot('settings-search-switcher-landed');

  // Restore the light palette and the desktop viewport for later scenarios.
  await page.locator('#st-card-appearance').getByRole('button', { name: S.themeLight, exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset['theme'] === 'light',
    { timeout: 5000 },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function scenarioSettingsWrite() {
  await page.goto(`${WEB_URL}/settings/general?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector(`text=${S.newSessionDefaults}`, { timeout: 10_000 });
  // Defaults apply on change now — no save button; each click PATCHes and the
  // ✓ Saved tick confirms the server echo.
  await page.locator('button', { hasText: S.permissionModeAuto }).click();
  await waitForText(S.savedTick);
  await page.locator('label', { hasText: S.planModeToggle }).click();
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
  // Client-side validation with no server round-trip: the plan-enter approval
  // timeout floor (5s) rejects an under-floor draft with an inline alert and
  // reverts the field to the server-known value. (The pool-model governance
  // editor this scenario originally exercised was removed in 2ffdfd8e5.)
  await page.goto(`${WEB_URL}/settings/general?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector(`text=${S.newSessionDefaults}`, { timeout: 10_000 });
  const timeout = page.locator('#plan-gate-timeout');
  await timeout.fill('2');
  await timeout.press('Enter');
  await page.waitForSelector('[role="alert"]', { timeout: 5000 });
  await waitForText(S.planGateTimeoutInvalid);
  const reverted = await timeout.inputValue();
  if (reverted !== '60') {
    throw new Error(`invalid timeout draft did not revert to the server value, saw "${reverted}"`);
  }
  await shot('settings-invalid-inline-error');
}

async function scenarioSettingsBrowserEditable() {
  await page.goto(`${WEB_URL}/settings/agents?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  const mainAgents = page.locator('#st-card-main-agents');
  await mainAgents.waitFor({ state: 'visible', timeout: 10_000 });
  const enabledSwitch = mainAgents.locator('[data-agent-profile="agent"] [role="switch"]');
  await enabledSwitch.waitFor({ state: 'visible', timeout: 10_000 });
  if (await enabledSwitch.isDisabled()) {
    throw new Error('browser agent settings remained disabled after the server response');
  }
  await mainAgents.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot('settings-browser-editable');
}

async function scenarioWorkspaces() {
  // Workspace rename + unregister over the two `settings.scenario.mjs` rows.
  await page.goto(`${WEB_URL}/settings/workspaces?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#st-card-workspaces', { timeout: 10_000 });
  await page.waitForSelector('#st-card-workspaces >> text=other', { timeout: 10_000 });
  await shot('settings-workspaces');

  // Rename the "fixture" row via its aria-label (locale-independent name) and
  // confirm the dialog + server echo update the list.
  const renameByAria = page.locator(`#st-card-workspaces [aria-label="${S.renameButton} fixture"]`);
  await renameByAria.click();
  const renameDialog = page.locator('[role="dialog"][aria-label="Rename workspace"]');
  await renameDialog.waitFor({ timeout: 5000 });
  await renameDialog.locator('input').fill('fixture-renamed');
  await renameDialog.locator(`button:has-text("${S.save}")`).click();
  await page.waitForSelector('#st-card-workspaces >> text=fixture-renamed', { timeout: 5000 });
  await shot('settings-workspace-renamed');

  // Unregister the renamed workspace; the confirm dialog proves the entry is
  // gone after the DELETE resolves and refetch reconciles.
  const removeByAria = page.locator(`#st-card-workspaces [aria-label="${S.removeButton} fixture-renamed"]`);
  await removeByAria.click();
  await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 });
  await page.click(`[role="alertdialog"] button:has-text("${S.removeButton}")`);
  await page.waitForFunction(
    () => !document.querySelector('#st-card-workspaces')?.textContent?.includes('fixture-renamed'),
    undefined,
    { timeout: 5000 },
  );
  await shot('settings-workspace-removed');
}

async function scenarioSettingsAgents() {
  // Batch 3 split this walk across two leaves (redesign §10.3): the
  // main-agent card stays on /settings/agents while the subagent profiles,
  // delegation governance and the subagent timeout moved to
  // /settings/subagents. Phase A covers the main card; phase B the sub card.
  // The merged view (the fixture workspaces share one `reviewer` profile)
  // plus both disable channels — named profiles write
  // disabled_named_profiles, built-ins write disabled_builtin_profiles, and
  // both survive a reload through the fixture config echo. Same-name pairs
  // prove the override rules: user `explore.md` (override: true) shadows the
  // built-in explore, user `scout.md` (no flag) loses to the built-in scout.
  await page.goto(`${WEB_URL}/settings/agents?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#st-card-main-agents', { timeout: 10_000 });
  await page.waitForSelector('#st-card-main-agents [data-agent-profile="agent"]', { timeout: 10_000 });
  if ((await page.locator('#st-card-subagent-profiles').count()) !== 0) {
    throw new Error('subagent profiles must live on the subagents leaf after the batch-3 split');
  }
  // The builtin main profile falls back to the most recent workspace for its
  // new-session deep link.
  const mainHref = await page.locator('[data-agent-profile="agent"] [data-new-session-href]').first().getAttribute('data-new-session-href');
  if (mainHref !== '/new?workspace=wd_fixture_000000000000&agent=agent') {
    throw new Error(`main-agent new-session href mismatch: ${mainHref}`);
  }
  await page.waitForTimeout(300);
  await shot('settings-agents-main');

  // Disabled split semantics on the MAIN profile: turning a main agent off
  // only stops subagent calls — the new-session button stays, and the row
  // explains why it is still usable.
  const mainRow = page.locator('[data-agent-profile="agent"]');
  await mainRow.locator('[role="switch"]').click();
  await page.waitForSelector('[data-agent-profile="agent"] [role="switch"][aria-checked="false"]', { timeout: 5000 });
  if (await mainRow.locator('[data-new-session-href]').isDisabled()) {
    throw new Error('disabled main profile must keep its new-session button');
  }
  await mainRow.getByText(S.disabledMainHint, { exact: false }).waitFor({ timeout: 5000 });
  await mainRow.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await shot('settings-agents-main-disabled');
  // Re-enable the main profile so the reload assertions below stay canonical.
  await mainRow.locator('[role="switch"]').click();
  await page.waitForSelector('[data-agent-profile="agent"] [role="switch"][aria-checked="true"]', { timeout: 5000 });

  // Phase B: subagent profiles on their own leaf, next to the governance
  // card and the relocated subagent timeout.
  await page.locator('nav [data-settings-nav-leaf="subagents"]').click();
  await page.waitForSelector('#st-card-subagent-profiles', { timeout: 10_000 });
  await page.waitForSelector('#st-card-subagents', { timeout: 10_000 });
  await page.waitForSelector('#st-card-subagent-timeout', { timeout: 10_000 });
  await page.waitForSelector('#st-card-subagent-profiles [data-agent-profile="reviewer"]', { timeout: 10_000 });
  const reviewerRows = await page.locator('[data-agent-profile="reviewer"]').count();
  if (reviewerRows !== 1) {
    throw new Error(`merged view must render reviewer once, got ${reviewerRows} rows`);
  }
  // Same-name override rendering: the built-in explore collapses to a muted
  // "overridden by" line with NO switch (only the file profile is live), the
  // overriding user file explains itself, and the flag-less user scout file
  // carries a not-in-effect warning while the built-in scout stays canonical.
  const builtinExplore = page.locator('[data-agent-profile="explore"][data-agent-source="builtin"]');
  await builtinExplore.waitFor({ timeout: 5000 });
  if ((await builtinExplore.getAttribute('data-override-state')) !== 'overridden') {
    throw new Error('built-in explore must render in the overridden state');
  }
  await builtinExplore.getByText(S.overriddenNote, { exact: false }).waitFor({ timeout: 5000 });
  await builtinExplore.getByText('explore.md', { exact: false }).waitFor({ timeout: 5000 });
  const exploreSwitches = await page.locator('[data-agent-profile="explore"] [role="switch"]').count();
  if (exploreSwitches !== 1) {
    throw new Error(`only the overriding file row may carry a switch, got ${exploreSwitches}`);
  }
  const userExplore = page.locator('[data-agent-profile="explore"][data-agent-source="user"]');
  if ((await userExplore.getAttribute('data-override-state')) !== 'overrides') {
    throw new Error('the overriding user explore file must render in the overrides state');
  }
  await userExplore.getByText(S.overridesBuiltinNote, { exact: false }).waitFor({ timeout: 5000 });
  const userScout = page.locator('[data-agent-profile="scout"][data-agent-source="user"]');
  if ((await userScout.getAttribute('data-override-state')) !== 'shadowed') {
    throw new Error('the flag-less user scout file must render in the shadowed state');
  }
  await userScout.getByText(S.shadowedNote, { exact: false }).waitFor({ timeout: 5000 });
  // A shadowed file profile must not offer a new session — the session would
  // silently run the same-named built-in instead — and the disabled button
  // carries the reason as its tooltip.
  const shadowedNewSession = userScout.locator('[data-new-session-href]');
  if (!(await shadowedNewSession.isDisabled())) {
    throw new Error('a shadowed file profile must lose its new-session button');
  }
  const shadowedNewSessionTitle = await shadowedNewSession.getAttribute('title');
  if (shadowedNewSessionTitle === null || !shadowedNewSessionTitle.includes(S.shadowedNote)) {
    throw new Error(`shadowed new-session tooltip mismatch: ${shadowedNewSessionTitle}`);
  }
  const shadowedIsDanger = await page.evaluate(() => {
    const row = document.querySelector('[data-agent-profile="scout"][data-agent-source="user"]');
    const node = Array.from(row?.querySelectorAll('p') ?? [])
      .find((p) => p.textContent?.includes('override: true'));
    return node?.className.includes('text-danger') === true;
  });
  if (!shadowedIsDanger) {
    throw new Error('the not-in-effect warning must render in danger ink');
  }
  await page.waitForSelector('[data-agent-profile="scout"][data-agent-source="builtin"] [role="switch"][aria-checked="true"]', { timeout: 5000 });
  await userExplore.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await shot('settings-agents-override');
  // Workspace chips live inside the per-row technical-details disclosure now.
  await page.locator('[data-agent-profile="reviewer"] [data-technical-details] summary').click();
  // Three workspace ids collapse into two chips + an overflow pill.
  await page.waitForSelector('[data-agent-profile="reviewer"] >> text=+1', { timeout: 5000 });
  // The file-backed reviewer pins its own workspace on the new-session link.
  const reviewerHref = await page.locator('[data-agent-profile="reviewer"] [data-new-session-href]').first().getAttribute('data-new-session-href');
  if (reviewerHref !== '/new?workspace=wd_fixture_000000000000&agent=reviewer') {
    throw new Error(`reviewer new-session href mismatch: ${reviewerHref}`);
  }
  // Read-only projection fields render in the technical-details disclosure
  // (frontend fixture row), including the structured lease's nested
  // constraint fields.
  await page.locator('[data-agent-profile="frontend"] [data-technical-details] summary').click();
  await page.waitForSelector(`[data-agent-profile="frontend"] >> text=${S.modelProfileLabel}`, { timeout: 5000 });
  await page.waitForSelector(`[data-agent-profile="frontend"] >> text=${S.promptModeLabel}`, { timeout: 5000 });
  await page.waitForSelector(`[data-agent-profile="frontend"] >> text=${S.delegationNoticeLabel}`, { timeout: 5000 });
  // Dedicated (scoped) source leases carry the Scoped badge, the relative
  // source path, and — when unavailable — the diagnostic in danger ink.
  await page.waitForSelector(`[data-agent-profile="frontend"] >> text=${S.scopedBadgeLabel}`, { timeout: 5000 });
  await page.waitForSelector('[data-agent-profile="frontend"] >> text=./_private/research/writer.md', { timeout: 5000 });
  await page.waitForSelector('[data-agent-profile="frontend"] >> text=source file missing', { timeout: 5000 });
  const diagnosticIsDanger = await page.evaluate(() => {
    const row = document.querySelector('[data-agent-profile="frontend"]');
    const node = Array.from(row?.querySelectorAll('p') ?? [])
      .find((p) => p.textContent?.includes('source file missing'));
    return node?.className.includes('text-danger') === true;
  });
  if (!diagnosticIsDanger) {
    throw new Error('unavailable scoped lease diagnostic must render in danger ink');
  }
  await page.locator('[data-agent-profile="frontend"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await shot('settings-agents-lease-detail');
  await shot('settings-agents-merged');

  const reviewerSwitch = () => page.locator('[data-agent-profile="reviewer"] [role="switch"]');
  const scoutSwitch = () => page.locator('[data-agent-profile="scout"][data-agent-source="builtin"] [role="switch"]');
  await reviewerSwitch().click();
  await page.waitForSelector('[data-agent-profile="reviewer"] [role="switch"][aria-checked="false"]', { timeout: 5000 });
  await scoutSwitch().click();
  await page.waitForSelector('[data-agent-profile="scout"][data-agent-source="builtin"] [role="switch"][aria-checked="false"]', { timeout: 5000 });
  // Disabling the built-in scout lifts the shadow: the same-named file
  // profile takes effect without needing the override flag — the warning
  // clears and the new-session button comes back.
  await page.waitForFunction(
    (warning) => !document
      .querySelector('[data-agent-profile="scout"][data-agent-source="user"]')
      ?.textContent?.includes(warning),
    S.shadowedNote,
    { timeout: 5000 },
  );
  if (await userScout.locator('[data-new-session-href]').isDisabled()) {
    throw new Error('the file profile must regain its new-session button once the built-in is disabled');
  }
  // A disabled SUBAGENT profile loses its new-session button (the mirror of
  // the main-profile rule proven on the agents leaf above).
  const reviewerNewSession = page.locator('[data-agent-profile="reviewer"] [data-new-session-href]');
  if (!(await reviewerNewSession.isDisabled())) {
    throw new Error('disabled subagent profile must lose its new-session button');
  }
  // Let the switch's color transition settle before the shot.
  await page.waitForTimeout(300);
  await shot('settings-agents-disabled');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-agent-profile="reviewer"] [role="switch"][aria-checked="false"]', { timeout: 10_000 });
  await page.waitForSelector('[data-agent-profile="scout"][data-agent-source="builtin"] [role="switch"][aria-checked="false"]', { timeout: 10_000 });
  // Re-enable so the merged row returns to full opacity for the next run.
  await reviewerSwitch().click();
  await page.waitForSelector('[data-agent-profile="reviewer"] [role="switch"][aria-checked="true"]', { timeout: 5000 });
  await shot('settings-agents-disabled-reloaded');
}

/**
 * Search & retrieval leaf (nb_search domain): partial seed renders WebSearch
 * ready on exa.search and FetchURL degraded; the walker changes the default
 * lane, sets tavily's credential env NAME (never a secret value), saves the
 * replace-domain patch, and proves the echo survives reload. Diagnostics run
 * only on demand; empty + error scenarios cover fail-closed and check-failed.
 */
async function scenarioSettingsNbSearch() {
  const searchUrl = `${WEB_URL}/settings/search?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#st-card-search-status', { timeout: 10_000 });
  await waitForText(S.nbSearchDegraded);
  const statusText = await page.locator('#st-card-search-status').textContent();
  if (!statusText?.includes(S.nbSearchReady) || !statusText.includes(S.nbSearchDegraded)) {
    throw new Error(`status card must show WebSearch ready + FetchURL degraded, saw "${statusText}"`);
  }
  await shot('settings-nbsearch');

  // Default lane is a radio over existing lanes only (no new lane creation).
  await page.locator('#st-card-search-defaults label', { hasText: 'github.repositories' })
    .locator('input[type="radio"]').click();
  // Credential slot editing is the env-var name; the secret never appears.
  const tavilyCard = page.locator('#st-card-search-providers details', { hasText: 'tavily.default' });
  await tavilyCard.locator('input[placeholder="NB_SEARCH_EXA_API_KEY"]').fill('NB_SEARCH_TAVILY_API_KEY');
  await tavilyCard.scrollIntoViewIfNeeded();
  await shot('settings-nbsearch-provider-edit');
  await page.locator('button', { hasText: S.nbSearchSave }).click();
  await waitForText(S.nbSearchSaved);
  await shot('settings-nbsearch-saved');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#st-card-search-defaults', { timeout: 10_000 });
  const checkedLane = await page.locator('#st-card-search-defaults input[type="radio"]:checked')
    .evaluate((element) => element.closest('label')?.textContent ?? '');
  if (!checkedLane.includes('github.repositories')) {
    throw new Error(`nb_search lane choice did not survive reload, checked="${checkedLane}"`);
  }
  const savedEnv = await tavilyCard.locator('input[placeholder="NB_SEARCH_EXA_API_KEY"]').inputValue();
  if (savedEnv !== 'NB_SEARCH_TAVILY_API_KEY') {
    throw new Error(`credential env name did not survive reload, saw "${savedEnv}"`);
  }
  await shot('settings-nbsearch-reloaded');

  // Diagnostics are explicit: nothing runs until the button is pressed.
  await page.locator('#st-card-search-diagnostics').scrollIntoViewIfNeeded();
  await page.locator('button', { hasText: S.nbSearchRunCheck }).click();
  await waitForText(S.nbSearchRevision);
  await page.locator('#st-card-search-diagnostics').scrollIntoViewIfNeeded();
  await shot('settings-nbsearch-diagnostics');

  // Mobile width: single-column cards, provider details still reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#st-card-search-status', { timeout: 10_000 });
  await waitForText(S.nbSearchDegraded);
  await shot('settings-nbsearch-mobile');
  await page.setViewportSize({ width: 1440, height: 900 });

  // Empty nb_search: WebSearch fails closed, FetchURL stays ready.
  await control({ action: 'scenario', name: 'settings-nbsearch-empty' });
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#st-card-search-status', { timeout: 10_000 });
  await waitForText(S.nbSearchFailClosed);
  const emptyStatus = await page.locator('#st-card-search-status').textContent();
  if (!emptyStatus?.includes(S.nbSearchUnconfigured) || !emptyStatus.includes(S.nbSearchReady)) {
    throw new Error(`empty config must show WebSearch unconfigured + FetchURL ready, saw "${emptyStatus}"`);
  }
  await shot('settings-nbsearch-empty');

  // Readiness check failure surfaces as an inline error, not a crash.
  await control({ action: 'scenario', name: 'settings-nbsearch-down' });
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#st-card-search-diagnostics', { timeout: 10_000 });
  await page.locator('button', { hasText: S.nbSearchRunCheck }).click();
  await waitForText(S.nbSearchCheckFailed);
  await page.locator('#st-card-search-diagnostics').scrollIntoViewIfNeeded();
  await shot('settings-nbsearch-error');
}


/** Grouping, sorting, scope and archived visibility all live behind the
 * sidebar's ⋮ view menu now, so every view change opens it first. */
async function pickViewOption(selector) {
  if ((await page.locator('[data-view-menu]').count()) === 0) {
    await page.click('[data-view-menu-toggle]');
    await page.waitForSelector('[data-view-menu]', { timeout: 5000 });
  }
  await page.click(`[data-view-menu] ${selector}`);
}

/** The panel overlays the list's top rows, so screenshots close it first. */
async function closeViewMenu() {
  if ((await page.locator('[data-view-menu]').count()) > 0) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-view-menu]', { state: 'detached', timeout: 5000 });
    await page.waitForTimeout(150);
  }
}

async function scenarioSidebarOrganize() {
  // Three sessions across two workspaces; the pinned row floats to a "Pinned"
  // group and the rest bucket by recency.
  await page.waitForSelector('[data-view-menu-toggle]', { timeout: 10_000 });

  // Scope every assertion to the sidebar so the /new recent-session chips
  // (which render the same titles in the main panel) never match.
  const sidebarTitles = async () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('aside [data-session-title]')).map((n) => n.textContent ?? ''),
    );
  const groupKeys = async () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('aside [data-session-group]')).map((n) => n.getAttribute('data-session-group')),
    );

  await page.waitForFunction(
    () => {
      const titles = Array.from(document.querySelectorAll('aside [data-session-title]')).map((n) => n.textContent ?? '');
      return titles.some((t) => t.includes('ws-a pinned'));
    },
    undefined,
    { timeout: 10_000 },
  );

  // Pinned rows must appear above the newest unpinned row.
  const order = await sidebarTitles();
  const pinnedIdx = order.findIndex((t) => t.includes('ws-a pinned'));
  const alphaIdx = order.findIndex((t) => t.includes('ws-a alpha'));
  if (pinnedIdx < 0 || alphaIdx < 0) throw new Error(`missing rows in sidebar: ${JSON.stringify(order)}`);
  if (pinnedIdx > alphaIdx) throw new Error('pinned session did not sort above the newest unpinned session');

  // --- Resizing: the sidebar element's rendered width changes and persists.
  await page.waitForSelector('[data-sidebar-resizer]', { timeout: 5000 });
  const sidebarPxWidth = () =>
    page.evaluate(() => {
      const el = document.querySelector('[data-session-sidebar]');
      return el === null ? null : Math.round(el.getBoundingClientRect().width);
    });
  const widthBefore = await sidebarPxWidth();
  const handle = await page.locator('[data-sidebar-resizer]').boundingBox();
  if (handle === null) throw new Error('sidebar resizer has no box');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 60, handle.y + handle.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const widthAfter = await sidebarPxWidth();
  const storedAfter = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('kiki.layout') ?? '{}')?.sidebarWidth;
    } catch {
      return undefined;
    }
  });
  if (widthBefore === null || widthAfter === null) throw new Error('sidebar element missing');
  if (Math.abs(widthAfter - widthBefore) < 30) {
    throw new Error(`sidebar width did not meaningfully change: ${widthBefore} -> ${widthAfter}`);
  }
  if (storedAfter === undefined || Math.abs(widthAfter - storedAfter) > 1) {
    throw new Error(`rendered sidebar width (${widthAfter}) diverges from stored width (${storedAfter})`);
  }
  await shot('sidebar-resized');

  // Double-click resets to the default.
  await page.locator('[data-sidebar-resizer]').dblclick();
  await page.waitForTimeout(200);
  const resetWidth = await sidebarPxWidth();
  if (resetWidth !== 264) {
    throw new Error(`sidebar double-click did not reset to 264 (got ${resetWidth})`);
  }

  // --- Workspace grouping: the pinned row keeps a global leading bucket and
  // the remaining buckets follow the sidebar's workspace order — pinned
  // workspaces first, then recency (the fixture's wd_…001 is the pinned one).
  await pickViewOption('[data-group-by="workspace"]');
  await closeViewMenu();
  await page.waitForFunction(
    () => document.querySelectorAll('aside [data-session-group]').length === 3,
    undefined,
    { timeout: 5000 },
  );
  const wsKeys = await groupKeys();
  if (
    wsKeys[0] !== 'pinned'
    || wsKeys[1] !== 'wd_fixture_000000000001'
    || wsKeys[2] !== 'wd_fixture_000000000000'
  ) {
    throw new Error(`unexpected workspace grouping: ${JSON.stringify(wsKeys)}`);
  }
  await shot('sidebar-group-by-workspace');

  // --- Sorting: "By name" reorders the unpinned rows within their bucket.
  await pickViewOption('[data-group-by="time"]');
  await page.waitForTimeout(200);
  await pickViewOption('[data-sort-by="title"]');
  await closeViewMenu();
  await page.waitForFunction(
    () => {
      const titles = Array.from(document.querySelectorAll('aside [data-session-title]')).map((n) => n.textContent ?? '');
      const alphaIdx = titles.findIndex((t) => t.includes('ws-a alpha'));
      const betaIdx = titles.findIndex((t) => t.includes('ws-b beta'));
      return alphaIdx >= 0 && betaIdx >= 0 && alphaIdx < betaIdx;
    },
    undefined,
    { timeout: 5000 },
  );
  await shot('sidebar-sort-by-name');

  // Restore default ordering for later assertions.
  await pickViewOption('[data-sort-by="updated-desc"]');
  await pickViewOption('[data-group-by="time"]');

  // Workspace filtering narrows the sidebar to workspace B's row only, and
  // leaves a revocable chip on the list's upper edge.
  await pickViewOption('[data-workspace-filter="wd_fixture_000000000001"]');
  await closeViewMenu();
  await page.waitForFunction(
    () => {
      const titles = Array.from(document.querySelectorAll('aside [data-session-title]')).map((n) => n.textContent ?? '');
      return titles.includes('Fixture: ws-b beta') && !titles.includes('Fixture: ws-a alpha');
    },
    undefined,
    { timeout: 5000 },
  );
  await page.waitForSelector('[data-sidebar-filter-chip="workspace"]', { timeout: 5000 });
  await shot('sidebar-workspace-filter');

  // The chip's × is the shortest way back to every workspace.
  await page.click('[data-sidebar-filter-clear="workspace"]');
  await page.waitForFunction(
    () => {
      const titles = Array.from(document.querySelectorAll('aside [data-session-title]')).map((n) => n.textContent ?? '');
      return titles.includes('Fixture: ws-a pinned') && titles.includes('Fixture: ws-a alpha');
    },
    undefined,
    { timeout: 5000 },
  );
  await shot('sidebar-pinned-group');
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

  // Queue strip: two parked prompts render as ordered rows above the composer.
  await sendPrompt('A: hold the floor.');
  await page.waitForSelector(`text=${S.working}`, { timeout: 10_000 });
  await sendPrompt('B: steer me in.');
  // Back-to-back queueing must wait out the previous send's draft clear,
  // otherwise the next fill is wiped before Enter fires.
  await page.waitForSelector('[data-queue-strip] li', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('textarea')?.value === '');
  await sendPrompt('C: clear me out.');
  await page.waitForSelector(`text=${S.twoPromptsQueued}`, { timeout: 10_000 });
  const strip = page.locator('[data-queue-strip]');
  if ((await strip.locator('li').count()) !== 2) {
    throw new Error(`expected 2 queue-strip rows, saw ${await strip.locator('li').count()}`);
  }
  // Multi-prompt default: the list collapses behind the count header…
  const collapseToggle = strip.locator(`button[aria-label="${S.queueExpandAria}"]`);
  if ((await collapseToggle.getAttribute('aria-expanded')) !== 'false') {
    throw new Error('queue strip did not default to collapsed with 2 prompts');
  }
  if ((await strip.locator('li:visible').count()) !== 0) {
    throw new Error('collapsed queue strip still shows rows');
  }
  await shot('queue-collapsed');
  // …and the header expands it again for row actions.
  await collapseToggle.click();
  if ((await strip.locator('li:visible').count()) !== 2) {
    throw new Error('queue strip toggle did not expand the rows');
  }
  // Let the rows' anim-enter fade finish before the shot.
  await page.waitForTimeout(600);
  await shot('queue-two-rows');

  // Send now (wire steer): B leaves the queue immediately while A keeps
  // running; the strip drops to one row and B's transcript chip detaches.
  // Chip queries are scoped to the transcript log: the strip header copy
  // itself matches the chip's "…queued — starts when…" substring.
  const transcriptChips = page.locator('[role="log"]').locator(`text=${S.queuedChip}`);
  await strip.locator('li', { hasText: 'B: steer me in.' })
    .locator(`button[aria-label="${S.sendNow}"]`)
    .click();
  await page.waitForSelector(`text=${S.onePromptQueued}`, { timeout: 10_000 });
  if ((await strip.locator('li').count()) !== 1) throw new Error('steered prompt stayed in the strip');
  if ((await transcriptChips.count()) !== 1) {
    throw new Error('steered prompt kept its Queued chip');
  }
  await shot('queue-steered');

  // Clear all empties the queue: confirm the dialog, then the strip and every
  // Queued chip disappear.
  await page.getByRole('button', { name: S.clearQueue }).click();
  const clearDialog = page.getByRole('alertdialog', { name: S.queueClearTitle });
  await clearDialog.waitFor({ timeout: 5000 });
  await clearDialog.getByRole('button', { name: S.clearQueue }).click();
  await page.waitForSelector('[data-queue-strip]', { state: 'detached', timeout: 10_000 });
  if ((await page.locator(`text=${S.queueBarPattern}`).count()) !== 0) {
    throw new Error('queue bar survived Clear all');
  }
  if ((await transcriptChips.count()) !== 0) {
    throw new Error('a Queued chip survived Clear all');
  }
  await shot('queue-cleared');
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
  await page.route('**/api/v1/sessions/*/snapshot**', async (route) => {
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
  await page.unroute('**/api/v1/sessions/*/snapshot**');
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

async function scenarioTaskNotifiedMidturn() {
  await selectSession('Fixture: task notified mid-turn');
  await waitForText('Suite is green — 42 passed.');
  // Positive control: the typed prompt is the only You bubble.
  const bubbles = page.locator('[role="log"] [data-block-id^="user-"]');
  if ((await bubbles.count()) !== 1) {
    throw new Error(`expected exactly one user bubble, saw ${await bubbles.count()}`);
  }
  const bubbleText = await bubbles.first().innerText();
  if (!bubbleText.includes('Run the fixture suite in the background.')) {
    throw new Error('user text missing from the bubble');
  }
  if (bubbleText.includes('Background process completed') || bubbleText.includes('<notification')) {
    throw new Error('task notification leaked into the user bubble');
  }
  // Both notification shapes (origin-carried + bare envelope) land collapsed
  // on the left system/task lane.
  const systemRows = page.locator('[role="log"] [data-block-id^="system-"]');
  if ((await systemRows.count()) !== 2) {
    throw new Error(`expected 2 system rows, saw ${await systemRows.count()}`);
  }
  if ((await page.locator('text=pnpm test — 42 passed').count()) !== 0) {
    throw new Error('collapsed notification body rendered before expansion');
  }
  await shot('task-notified-collapsed');
  await systemRows.first().locator('button').first().click();
  await waitForText('pnpm test — 42 passed');
  await page.waitForTimeout(300);
  await shot('task-notified-expanded');
}

async function scenarioInjectionLanes() {
  await selectSession('Fixture: injection lanes');
  await waitForText('Nightly job fired on schedule');
  // Positive control: only the typed prompt is a You bubble.
  const bubbles = page.locator('[role="log"] [data-block-id^="user-"]');
  if ((await bubbles.count()) !== 1) {
    throw new Error(`expected exactly one user bubble, saw ${await bubbles.count()}`);
  }
  const bubbleText = await bubbles.first().innerText();
  if (!bubbleText.includes('Keep an eye on the nightly job.')) {
    throw new Error('user text missing from the bubble');
  }
  for (const leaked of ['cron-fire', 'SKILL.md', 'Continue toward the goal', 'Earlier context summarized']) {
    if (bubbleText.includes(leaked)) throw new Error(`injection leaked into the user bubble: ${leaked}`);
  }
  // cron + compaction + non-slash skill + goal continuation: four left-lane
  // system rows, all collapsed (bodies hidden until expanded).
  const systemRows = page.locator('[role="log"] [data-block-id^="system-"]');
  if ((await systemRows.count()) !== 4) {
    throw new Error(`expected 4 system rows, saw ${await systemRows.count()}`);
  }
  if ((await page.locator('text=Continue toward the goal').count()) !== 0) {
    throw new Error('collapsed injection body rendered before expansion');
  }
  await shot('injection-lanes');
}

async function scenarioTurnPolish() {
  await selectSession('Fixture: turn polish');
  // 1) Abort mid-stream: the assistant message gains a Stopped marker and
  // the orphaned running tool flips to its amber stopped square.
  await sendPrompt('Abort me mid-stream.');
  await waitForText('half-finished sentence', 20_000);
  await page.mouse.click(720, 300); // non-editable focus
  await page.keyboard.press('Escape'); // abort mid-stream
  await page.waitForSelector(`text=${S.promptAborted}`, { timeout: 10_000 });
  const stoppedMark = page.locator('[data-block-id^="agent-frame-"], [data-block-id^="assistant-"]', { hasText: S.stopped });
  if ((await stoppedMark.count()) !== 1) {
    throw new Error(`expected 1 Stopped assistant marker, saw ${await stoppedMark.count()}`);
  }
  await page.waitForTimeout(400);
  await shot('turn-stopped');
  // 2) Slow first token: the status line shows during the gap, its cumulative
  // clock once the wait passes 15s (the fixture pauses 16.5s), then the turn
  // tail reports "Ran for … · TTFT …".
  await sendPrompt('Think slowly before answering.');
  const status = page.locator('[data-turn-status]');
  await status.waitFor({ timeout: 10_000 });
  if (!(await status.innerText()).includes(S.turnWorking)) {
    throw new Error('turn status line missing the Working label');
  }
  await page.waitForFunction(
    () => /\d/.test(document.querySelector('[data-turn-status] [aria-hidden="true"]')?.textContent ?? ''),
    undefined,
    { timeout: 20_000 },
  );
  await shot('turn-status-clock');
  await page.waitForSelector('[data-turn-tail]', { timeout: 20_000 });
  const tail = await page.locator('[data-turn-tail]').innerText();
  if (!S.ranForPattern.test(tail) || !S.ttftPattern.test(tail)) {
    throw new Error(`turn tail missing Ran for / TTFT facts: ${tail}`);
  }
  await page.waitForTimeout(300);
  await shot('turn-tail');
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
  // The panel's header toggle now lives in the ⋯ menu; open it there once so
  // the menu item is proven, and close it with the new Ctrl+` binding below.
  await page.click(`header button[aria-label="${S.sessionActionsAria}"]`);
  await page.waitForSelector('[data-terminal-toggle]', { timeout: 5000 });
  await shot('session-actions-menu');
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

  // Theme hot-swap: xterm cannot read CSS variables, so the panel re-resolves
  // the shell tokens when <html data-theme> flips and pushes them into the
  // mounted instance. The DOM renderer paints the ground as an inline style on
  // .xterm-viewport — that property is the observable.
  const terminalGround = () =>
    page.evaluate(() => {
      const host = document.querySelector('[data-terminal-canvas]:not(.hidden)');
      const viewport = host?.querySelector('.xterm-viewport');
      return viewport?.style.backgroundColor ?? null;
    });
  const groundBefore = await terminalGround();
  await page.evaluate(() => { document.documentElement.dataset['theme'] = 'dark'; });
  let groundAfter = groundBefore;
  for (let i = 0; i < 40 && groundAfter === groundBefore; i += 1) {
    await sleep(100);
    groundAfter = await terminalGround();
  }
  console.log(`[check] terminal theme hot-swap: ${groundBefore} → ${groundAfter}`);
  if (groundBefore === null || groundAfter === null) {
    throw new Error('terminal viewport ground not readable for the hot-swap proof');
  }
  if (groundAfter === groundBefore) {
    throw new Error('mounted terminal did not follow the app theme flip');
  }
  await shot('terminal-theme-dark');
  await page.evaluate(() => { document.documentElement.dataset['theme'] = 'light'; });
  await page.waitForTimeout(300);

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

  // Ctrl+` closes and reopens the panel from the transcript — the binding is
  // the only keyboard path now that the header toggle is gone.
  await page.mouse.click(720, 300);
  await page.keyboard.press('Control+`');
  await page.waitForSelector('[data-terminal-panel]', { state: 'detached', timeout: 5000 });
  await page.keyboard.press('Control+`');
  await page.waitForSelector('[data-terminal-panel]', { timeout: 5000 });

  // Overflow the bounded server buffer while the socket is down. The
  // reconnect must reset old xterm/ANSI history and visibly disclose that the
  // replay is only a retained suffix.
  const restored = await control({ action: 'session', session_id: SID });
  const running = restored.data?.terminals?.find((terminal) => terminal.status === 'running');
  if (running?.id === undefined) throw new Error('no running terminal for truncation proof');
  await control({
    action: 'terminal_gap',
    session_id: SID,
    terminal_id: running.id,
    count: 2001,
  });
  await page.waitForSelector('[data-terminal-truncated]', { timeout: 20_000 });
  const suffix = await waitMirror(
    (text) => text.includes('gap-output-2001') && !text.includes('back-alive'),
    'truncated replay suffix replaces prior scrollback',
    20_000,
  );
  if (suffix.includes('gap-output-1\n')) {
    throw new Error('truncated replay incorrectly retained the evicted first frame');
  }
  await page.waitForTimeout(400);
  await shot('terminal-truncated');
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
  // Client shortcut: /plan toggles the plan switch, which now lives one level
  // in — behind its own [plan ▾]. Assert the FLIP, not an absolute state:
  // client settings persisted by earlier scenarios (settings-write) can start
  // plan mode either way. aria-pressed is the contractual hook; the accent
  // class and the trigger's `· plan` segment are presentation.
  const planPressed = async () => {
    await openPlanPanel();
    const pressed = await page
      .locator('[data-mode-switch="plan"]')
      .getAttribute('aria-pressed');
    await closePlanPanel();
    return pressed;
  };
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
  // Unknown slash text degrades honestly — but since a8b237bfa the typo guard
  // holds the send behind an explicit confirm; the proof walks through the
  // gate, then still asserts the draft ships verbatim as a plain prompt.
  await page.fill('textarea', '/notarealcommand hello');
  await page.press('textarea', 'Enter');
  await page.waitForSelector('[data-slash-confirm]', { timeout: 5000 });
  await shot('slash-commands-unknown-confirm');
  await page.locator('[data-slash-confirm] button', { hasText: S.sendAnyway }).click();
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

/**
 * selection-annotate — the transcript selection popover's two actions:
 * "Quote" chips the selection (blockquote prefix on send, unchanged), while
 * "Annotate" opens an in-place comment input (Enter commits, Esc cancels) and
 * chips quote+comment pairs. Chips accumulate across selections, survive each
 * other, and are individually removable. The sent prompt is asserted on the
 * control plane: annotation segments (blockquote + `Comment:`) first, then the
 * plain quote blockquote, then the typed text — plain text all the way down.
 */
async function scenarioSelectionAnnotate() {
  await selectSession('Fixture: selection annotate');
  await waitForText('drains parked prompts in order');

  const FRAGMENT_A = 'batches transcript blocks into floors';
  const COMMENT_A = 'Floor batching keeps long sessions cheap';
  const FRAGMENT_B = 'drains parked prompts in order';
  const COMMENT_B = 'Promotion order matters';
  const QUOTE = 'Queue promotion';
  const TYPED = 'please factor these in';

  // Select a text fragment inside the transcript and fire the mouseup the
  // floating popover listens for.
  const selectFragment = async (marker) => {
    await page.evaluate((needle) => {
      const log = document.querySelector('[role="log"]');
      const walker = document.createTreeWalker(log, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node !== null) {
        const index = node.textContent.indexOf(needle);
        if (index !== -1) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + needle.length);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          break;
        }
        node = walker.nextNode();
      }
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, marker);
    await page.waitForSelector('[data-selection-quote]', { timeout: 5000 });
  };
  const annotate = async (marker, comment) => {
    await selectFragment(marker);
    await page.click('[data-selection-annotate-action]');
    await page.waitForSelector('[data-selection-annotate-input]', { timeout: 5000 });
    await page.fill('[data-selection-annotate-input]', comment);
    await page.press('[data-selection-annotate-input]', 'Enter');
    await page.waitForTimeout(300); // let the chip entrance animation settle
  };
  const annotationChips = page.locator('[data-annotation-chip]');

  // A1: the popover offers both actions above the selection.
  await selectFragment(FRAGMENT_A);
  await page.waitForTimeout(300); // let the popover entrance animation settle
  const pillText = await page.locator('[data-selection-quote]').innerText();
  if (!pillText.includes(S.quoteAction) || !pillText.includes(S.annotateAction)) {
    throw new Error(`selection popover missing an action: ${pillText}`);
  }
  await shot('selection-annotate-actions');

  // A2: annotate opens the in-place comment input.
  await page.click('[data-selection-annotate-action]');
  await page.waitForSelector('[data-selection-annotate-input]', { timeout: 5000 });
  await shot('selection-annotate-input');
  await page.fill('[data-selection-annotate-input]', COMMENT_A);
  await page.press('[data-selection-annotate-input]', 'Enter');
  await page.waitForSelector('[data-annotation-chip]', { timeout: 5000 });
  if ((await annotationChips.count()) !== 1) throw new Error('first annotation chip missing');

  // A3: annotations accumulate — a second selection adds a second chip.
  await annotate(FRAGMENT_B, COMMENT_B);
  if ((await annotationChips.count()) !== 2) {
    throw new Error(`annotations did not accumulate: ${await annotationChips.count()}`);
  }
  await shot('selection-annotate-chips');

  // A4: chips are individually removable; the other one stays.
  await annotationChips.nth(1).locator(`button[aria-label="${S.removeAnnotation}"]`).click();
  if ((await annotationChips.count()) !== 1) throw new Error('annotation chip was not removable');
  const remaining = await annotationChips.nth(0).innerText();
  if (!remaining.includes(COMMENT_A)) throw new Error(`wrong chip survived removal: ${remaining}`);
  await annotate(FRAGMENT_B, COMMENT_B);
  if ((await annotationChips.count()) !== 2) throw new Error('re-annotation did not restore the chip');

  // A5: the quote action still lands its own chip beside the annotations.
  await selectFragment(QUOTE);
  await page.locator('[data-selection-quote] button', { hasText: S.quoteAction }).click();
  await page.waitForSelector('[data-quote-chip]', { timeout: 5000 });
  if ((await annotationChips.count()) !== 2) throw new Error('quote replaced the annotations');
  await page.waitForTimeout(300); // let the chip entrance animation settle
  await shot('selection-annotate-quote-chip');

  // A6: send — the wire text carries annotation segments, then the quote
  // blockquote, then the typed text.
  await page.click('textarea');
  await page.type('textarea', TYPED);
  await page.press('textarea', 'Enter');
  await waitForText('Selection annotations received by the fixture.');
  const state = await control({ action: 'session', session_id: 'session_fixture_selection_annotate' });
  const content = state.data?.last_prompt_submission?.content ?? [];
  const textPart = content.find((part) => part.type === 'text');
  const expected =
    `> ${FRAGMENT_A}\n\nComment: ${COMMENT_A}\n\n` +
    `> ${FRAGMENT_B}\n\nComment: ${COMMENT_B}\n\n` +
    `> ${QUOTE}\n\n${TYPED}`;
  if (textPart === undefined || textPart.text !== expected) {
    throw new Error(`selection carry-overs assembled wrong: ${JSON.stringify(textPart)}`);
  }
  await shot('selection-annotate-sent');
}

async function scenarioPreviewWorkbench() {
  await selectSession('Fixture: preview workbench');
  await page.waitForSelector('text=Workbench notes', { timeout: 10_000 });
  // Clicking a transcript file link opens the resident workspace with one tab.
  await page.locator('.conversation-body a', { hasText: 'server.ts' }).first().click();
  await page.waitForSelector('[data-preview-workspace]', { timeout: 5000 });
  await page.waitForSelector('[data-preview-tab="C:/fixture/workshop/src/server.ts"]');
  // Code tab: CodeMirror mounts (read-only in the browser build — the hint
  // strip asserts the missing server write endpoint degradation).
  await page.waitForSelector('[data-preview-tabpanel="C:/fixture/workshop/src/server.ts"] .cm-content', { timeout: 10_000 });
  await shot('preview-workbench-code');
  const readonlyHint = await page.locator('[data-preview-workspace]').innerText();
  if (!S.previewReadonlyPattern.test(readonlyHint)) {
    throw new Error(`read-only hint missing from the browser build: ${readonlyHint}`);
  }
  // A second link adds a tab and activates it; markdown defaults to rendered.
  await page.locator('.conversation-body a', { hasText: 'design.md' }).first().click();
  await page.waitForSelector('[data-preview-tab="C:/fixture/workshop/docs/design.md"]');
  await page.waitForSelector('[data-preview-tabpanel="C:/fixture/workshop/docs/design.md"] h1', { timeout: 5000 });
  await shot('preview-workbench-markdown');
  // Source mode swaps the renderer for the editor.
  await page.locator('[data-md-mode="source"]').click();
  await page.waitForSelector('[data-preview-tabpanel="C:/fixture/workshop/docs/design.md"] .cm-content', { timeout: 10_000 });
  await shot('preview-workbench-md-source');
  // Image tab renders inline bytes.
  await page.locator('.conversation-body a', { hasText: 'board.svg' }).first().click();
  await page.waitForSelector('[data-preview-tab="C:/fixture/workshop/shots/board.svg"]');
  await page.waitForSelector('[data-preview-tabpanel="C:/fixture/workshop/shots/board.svg"] img', { timeout: 5000 });
  await shot('preview-workbench-image');
  // Re-clicking an already-open file only reactivates its tab (no duplicate).
  await page.locator('.conversation-body a', { hasText: 'server.ts' }).first().click();
  await page.waitForTimeout(300);
  const tabCount = await page.locator('[data-preview-tab]').count();
  if (tabCount !== 3) throw new Error(`expected 3 tabs after re-open, saw ${tabCount}`);
  // Context menu → close others leaves exactly the right-clicked tab.
  await page.locator('[data-preview-tab="C:/fixture/workshop/src/server.ts"]').click({ button: 'right' });
  await page.waitForSelector('[data-preview-tab-menu]', { timeout: 5000 });
  // Let the 200ms anim-enter fade finish so the menu box is fully opaque.
  await page.waitForTimeout(300);
  await shot('preview-workbench-tab-menu');
  await page.locator('[data-preview-tab-menu] button').nth(1).click();
  await page.waitForTimeout(300);
  const remaining = await page.locator('[data-preview-tab]').count();
  if (remaining !== 1) throw new Error(`close-others should leave 1 tab, saw ${remaining}`);
  // Collapse hides the panel; the header toggle brings it back.
  await page.getByRole('button', { name: S.previewCollapse }).click();
  await page.waitForSelector('[data-preview-workspace]', { state: 'detached', timeout: 5000 });
  await page.locator('[data-preview-toggle]').click();
  await page.waitForSelector('[data-preview-workspace]', { timeout: 5000 });
  await shot('preview-workbench-reopened');
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

  // Pagination: the fixture ents the first page to 2 hits, so a "load more"
  // button must appear and advance to the remaining hits on request.
  const loadMoreButton = page.locator('[data-search-load-more]');
  await loadMoreButton.waitFor({ state: 'visible', timeout: 5000 });
  await loadMoreButton.click();
  await page.waitForSelector('text=keep the persimmon cache under half of the heap', {
    timeout: 5000,
  });
  await shot('search-results-paged');

  const state = await control({ action: 'state' });
  if (state.data?.last_search?.query !== 'persimmon') {
    throw new Error(`search body mismatch: ${JSON.stringify(state.data?.last_search)}`);
  }
  if (state.data?.last_search?.page_token === undefined) {
    throw new Error(`expected the load-more request to carry a page_token: ${JSON.stringify(state.data?.last_search)}`);
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

/**
 * /usage V2 dashboard (§15.3): the no-query all-history default with the
 * explicit chip and the cost/tokens KPIs, the three-axis filter bar driving
 * the URL, the 5h rhythm granularity with a bucket drilldown into
 * session/turn ids, the agent dimension's parent/child breakdown tree, the
 * always-visible data-reliability card, and the 390px mobile layout.
 */
async function scenarioUsageDashboard() {
  const usageUrl = (query) =>
    `${WEB_URL}/usage${query === '' ? '' : `?${query}&`}${query === '' ? '?' : ''}server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`;

  // 1. No-query visit: all history, said out loud; the unknown-price note and
  //    the partially-unknown cost chip come from the seeded `mystery-9` model.
  await page.goto(usageUrl(''), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`text=${S.usageEstimatedCost}`, { timeout: 15_000 });
  await page.waitForSelector(`text=${S.usageAllHistory}`, { timeout: 10_000 });
  await page.waitForSelector(`text=${S.usagePartial}`, { timeout: 10_000 });
  await page.waitForSelector('text=mystery-9', { timeout: 10_000 });
  await page.waitForSelector('[data-usage-trend]', { timeout: 10_000 });
  await page.waitForTimeout(500);
  await shot('usage-all-history');

  // 2. Three axes + the fixed reliability card (scrolled into view).
  await page.locator('[data-axis="range"] [data-axis-value="last_7_days"]').click();
  await page.locator('[data-axis="dimension"] [data-axis-value="agent"]').click();
  await page.waitForSelector('[data-usage-reliability]', { timeout: 10_000 });
  await page.waitForSelector(`text=${S.usageDeletedExcluded}`, { timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.locator('[data-usage-reliability]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot('usage-filters-reliability');

  // 3. Agent breakdown tab: parent/child tree expands to the researcher rows.
  //    The tab switch must land in the URL so the view is shareable.
  await page.locator('[data-usage-tab="breakdown"]').click();
  await page.waitForSelector('[data-usage-agent-tree]', { timeout: 10_000 });
  if (!page.url().includes('view=breakdown')) {
    throw new Error(`breakdown tab missing from the URL: ${page.url()}`);
  }
  await page.locator('[data-usage-agent-tree] button', { hasText: S.usageSubagentPattern }).first().click();
  await page.waitForSelector('text=researcher', { timeout: 5000 });
  await page.waitForTimeout(300);
  await shot('usage-breakdown-agents');

  // 4. 5h rhythm tab: switch granularity, then the tab itself renders the
  //    per-window session/turn drilldown (not just the trend chart).
  await page.locator('[data-axis="granularity"] [data-axis-value="five_hour"]').click();
  await page.waitForTimeout(700);
  await page.locator('[data-usage-tab="fiveHour"]').click();
  await page.waitForSelector('[data-usage-fivehour]', { timeout: 10_000 });
  if (!page.url().includes('view=five_hour') || !page.url().includes('granularity=five_hour')) {
    throw new Error(`5h view missing from the URL: ${page.url()}`);
  }
  const fiveHour = page.locator('[data-usage-fivehour]');
  const fiveHourText = await fiveHour.innerText();
  if (!fiveHourText.includes('session_fixture_usage_zeta')) {
    throw new Error(`5h tab missing seeded session: ${fiveHourText}`);
  }
  const turnChips = await fiveHour.locator('[data-usage-turn]').count();
  console.log(`[check] 5h windows=${await fiveHour.locator('[data-usage-fivehour-window]').count()} turnChips=${turnChips}`);
  if (turnChips === 0) throw new Error('5h tab renders no turn locators');
  await shot('usage-fivehour-drilldown');

  // 5. Mobile: narrow viewport must not overflow; the strip and filter bar wrap.
  await resizeViewport(390);
  await page.goto(usageUrl('granularity=day'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-usage-trend]', { timeout: 15_000 });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 1) throw new Error(`390px layout overflows by ${overflow}px`);
  // The main pane clips horizontal overflow (overflow-y auto), so also assert
  // every axis group stays inside the viewport instead of bleeding off-edge.
  const bleeders = await page.evaluate(() => {
    const names = [];
    for (const el of document.querySelectorAll('[data-axis]')) {
      const rect = el.getBoundingClientRect();
      if (rect.right > window.innerWidth + 1 || rect.left < -1) names.push(el.dataset.axis);
    }
    return names;
  });
  if (bleeders.length > 0) throw new Error(`390px axis groups bleed off-edge: ${bleeders.join(',')}`);
  await shot('usage-mobile-390');
  await resizeViewport(1440);
}

/**
 * Session footer context ring: open the composer's ring detail card (amber at
 * ~57%), assert its lifetime session-usage rows, verify clicking the card
 * (not the ring) triggers compaction; then open the textarea's custom
 * right-click menu (cut/copy disabled without a selection, paste/select-all
 * present), and prove the ring apologizes in place during a stream by flipping
 * amber → red once the context crosses the danger threshold.
 */
async function scenarioContextRing() {
  await selectSession('Fixture: context ring');
  await page.waitForSelector('[data-context-meter]', { timeout: 10_000 });
  const levelBefore = await page
    .locator('[data-context-meter]')
    .getAttribute('data-context-level');
  if (levelBefore !== 'warn') throw new Error(`expected warn ring on load, saw ${levelBefore}`);
  const warnArc = await page.evaluate(() => {
    const arc = document.querySelector('[data-context-meter] circle[stroke-dasharray="100"]');
    return arc === null ? null : getComputedStyle(arc).stroke;
  });
  console.log(`[check] warn arc stroke: ${warnArc}`);
  // c92a2a (--color-danger) / e8b04b (--color-amber-rule) / e8590c (--color-accent)
  const AMBER = 'rgb(232, 176, 75)';
  if (warnArc !== AMBER) throw new Error(`expected amber warn arc, saw ${warnArc}`);
  await shot('context-ring-warn');

  // Open the detail card via the ring; its usage rows must carry the seeded numbers.
  await page.click('[data-context-meter]');
  await page.waitForSelector('[data-context-details]', { timeout: 5000 });
  const detailsText = await page.locator('[data-context-details]').innerText();
  for (const expected of [S.sessionUsage, S.contextDetails]) {
    if (!detailsText.includes(expected)) throw new Error(`detail card missing "${expected}"`);
  }
  await shot('context-ring-details');

  // Compaction fires from the detail card's button, not the ring click itself.
  await page.locator('[data-context-details] button', { hasText: S.compactOlderContext }).click();
  await page.waitForSelector(`text=${S.compactionRequested}`, { timeout: 5000 });
  await shot('context-ring-compact');

  // The input's custom right-click menu.
  await page.fill('textarea', 'ring menu probe');
  await page.click('textarea');
  await page.press('textarea', 'Control+A');
  await page.click('textarea', { button: 'right' });
  await page.waitForSelector('[data-composer-context-menu]', { timeout: 5000 });
  const menuText = await page.locator('[data-composer-context-menu]').innerText();
  if (!menuText.includes('Cut') || !menuText.includes('Copy') || !menuText.includes(S.pasteAsPlainText) || !menuText.includes(S.contextMenuSelectAll)) {
    throw new Error(`unexpected context menu: ${menuText}`);
  }
  await shot('context-menu-open');
  await page.locator('[data-composer-context-menu] button', { hasText: S.contextMenuSelectAll }).click();
  await page.waitForSelector('[data-composer-context-menu]', { state: 'detached', timeout: 5000 });

  // Now prove the ring recolors live during a stream.
  await page.fill('textarea', 'Push the context over the danger threshold.');
  await page.press('textarea', 'Enter');
  await page.waitForFunction(
    () => document.querySelector('[data-context-meter]')?.getAttribute('data-context-level') === 'danger',
    { timeout: 15_000 },
  );
  // The arc transitions stroke + dash offset over 300ms — let it settle so the
  // computed color reflects the target danger red, not the transition start.
  await page.waitForTimeout(450);
  const dangerArc = await page.evaluate(() => {
    const arc = document.querySelector('[data-context-meter] circle[stroke-dasharray="100"]');
    return arc === null ? null : getComputedStyle(arc).stroke;
  });
  console.log(`[check] danger arc stroke: ${dangerArc}`);
  const RED = 'rgb(201, 42, 42)'; // --color-danger
  if (dangerArc !== RED) throw new Error(`expected red danger arc, saw ${dangerArc}`);
  await shot('context-ring-danger');
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 20_000 }).catch(() => undefined);
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

/**
 * /capabilities retired in the batch-3 settings split (redesign §10.2 rule
 * 3): the shim redirects a bare visit to /settings/skills with a split
 * signpost, the relocated catalog still groups/filters/expands, and the MCP
 * restart round-trip now lives on the MCP settings leaf.
 */
async function scenarioCapabilities() {
  const url = `${WEB_URL}/capabilities?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`;
  const skillsUrl = `${WEB_URL}/settings/skills?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-capabilities-shim-note]', { timeout: 10_000 });
  const redirected = page.url();
  if (!redirected.includes('/settings/skills') || !redirected.includes('from=capabilities')) {
    throw new Error(`capabilities shim must land on /settings/skills?from=capabilities, got ${redirected}`);
  }
  await page.waitForSelector(`text=${S.shimCapabilities}`, { timeout: 5000 });
  // Scoped to the note: the leaf name alone also appears in the nav rail.
  await page.waitForSelector(`[data-capabilities-shim-note] >> text=${S.shimPlugins}`, { timeout: 5000 });
  await page.waitForSelector('#st-card-skill-catalog', { timeout: 10_000 });
  await page.waitForSelector(`text=${S.capPlugin}`, { timeout: 10_000 });
  // Plugin skill rows (MCP servers live on the MCP leaf after the split).
  await page.waitForSelector('text=web-research', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('capabilities-shim-skills');

  // The builtin group starts collapsed; expand it for the density check.
  await page.locator('[data-capability-group="builtin"] > button').click();
  await page.waitForSelector('text=write-goal', { timeout: 5000 });
  await page.waitForTimeout(300);
  await shot('capabilities-builtin-expanded');

  // Client-side filter with no matches → page-level empty state.
  await page.fill(`input[aria-label="${S.capFilterAria}"]`, 'zzz-no-match');
  await page.waitForSelector(`text=${S.capEmptyFilter}`, { timeout: 5000 });
  await shot('capabilities-filter-empty');

  // MCP restart round-trip (scoped to the status card row — "Restart" is
  // generic). The flow moved from /capabilities to the MCP settings leaf.
  await page.goto(`${WEB_URL}/settings/mcp?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#st-card-mcp-status', { timeout: 10_000 });
  await page.locator('#st-card-mcp-status div.rounded-lg', { hasText: 'fixture-fs' }).locator('button').click();
  await page.waitForSelector(`text=${S.capRestartRequested}`, { timeout: 5000 });
  await shot('capabilities-mcp-restart');

  // Mobile width: hamburger header, single-column cards on the skills leaf.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(skillsUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`text=${S.capPlugin}`, { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('capabilities-mobile');
  await page.setViewportSize({ width: 1440, height: 900 });

  // No workspace registered → quiet hint inside the relocated catalog.
  await page.route('**/api/v1/workspaces', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, msg: 'success', data: { items: [] }, request_id: 'req_fixture' }),
    }),
  );
  await page.goto(skillsUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`text=${S.capNoWorkspace}`, { timeout: 10_000 });
  await shot('capabilities-no-workspace');
  await page.unroute('**/api/v1/workspaces');

  // Workspace listing failure → inline error on the skills leaf.
  await page.route('**/api/v1/workspaces', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ code: 50001, msg: 'fixture boom', data: null, request_id: 'req_fixture' }),
    }),
  );
  await page.goto(skillsUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=fixture boom', { timeout: 10_000 });
  await shot('capabilities-load-failed');
  await page.unroute('**/api/v1/workspaces');
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
  ['task-notified-midturn', scenarioTaskNotifiedMidturn],
  ['injection-lanes', scenarioInjectionLanes],
  ['turn-polish', scenarioTurnPolish],
  ['error-abort', scenarioErrorAbort],
  ['approvals-gallery', scenarioApprovalsGallery],
  ['external-harness', scenarioExternalHarness],
  ['reconnect', scenarioReconnect],
  ['reconnect-mid-turn', scenarioReconnectMidTurn],
  ['resync-hold', scenarioResyncHold],
  ['session-pages', scenarioSessionPages],
  ['sidebar-organize', scenarioSidebarOrganize],
  ['empty-states', scenarioEmptyStates],
  ['new-no-workspace', scenarioNewNoWorkspace],
  ['draft-flow', scenarioDraftFlow],
  ['hero-shell', scenarioHeroShell],
  ['settings', scenarioSettings],
  ['settings-search', scenarioSettingsSearch],
  ['settings-write', scenarioSettingsWrite],
  ['settings-invalid', scenarioSettingsInvalid],
  ['settings-browser-editable', scenarioSettingsBrowserEditable],
  ['settings-workspaces', scenarioWorkspaces],
  ['settings-agents', scenarioSettingsAgents],
  ['settings-nbsearch', scenarioSettingsNbSearch],
  ['slash-commands', scenarioSlashCommands],
  ['attachments', scenarioAttachments],
  ['selection-annotate', scenarioSelectionAnnotate],
  ['preview-workbench', scenarioPreviewWorkbench],
  ['search', scenarioSearch],
  ['session-actions', scenarioSessionActions],
  ['context-ring', scenarioContextRing],
  ['usage-dashboard', scenarioUsageDashboard],
  ['terminal', scenarioTerminal],
  ['capabilities', scenarioCapabilities],
  ['i18n', scenarioI18n],
  ['rewrite-flow', scenarioRewriteFlow],
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
  const fixturePinned = FIXTURE_PORT !== 0;
  const webPinned = WEB_PORT !== 0;
  if (!fixturePinned) FIXTURE_PORT = await freePort();
  if (!webPinned) WEB_PORT = await freePort();
  // Never kill foreign processes: an OS-assigned port that turns out held is
  // re-probed; a pinned port that is held fails with instructions.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const fixtureHolders = portHolderPids(FIXTURE_PORT);
    const webHolders = portHolderPids(WEB_PORT);
    if (fixtureHolders.size === 0 && webHolders.size === 0) break;
    if (fixturePinned && fixtureHolders.size > 0) {
      throw new Error(`fixture port ${FIXTURE_PORT} is held by pid(s) ${[...fixtureHolders].join(', ')} — free it yourself or unset KIKI_PROOF_FIXTURE_PORT`);
    }
    if (webPinned && webHolders.size > 0) {
      throw new Error(`web port ${WEB_PORT} is held by pid(s) ${[...webHolders].join(', ')} — free it yourself or unset KIKI_PROOF_WEB_PORT`);
    }
    if (fixtureHolders.size > 0) FIXTURE_PORT = await freePort();
    if (webHolders.size > 0) WEB_PORT = await freePort();
  }
  FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;
  WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
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
    killOwnPortHolder(WEB_PORT, vite.pid);
    await fixture.stop();
  };
  process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));
  process.on('exit', () => vite.kill());

  try {
    // Cold vite on this monorepo can take ~20s+ to open its listener after
    // the "ready" banner (plugin/transform warmup) — give it real headroom.
    await waitForServer(WEB_URL, 90_000);
    if (viteExited !== null) {
      throw new Error(`vite dev server exited early (code ${viteExited}) — refusing to run against a stale listener on ${WEB_URL}`);
    }
    console.log(`[proof] web up at ${WEB_URL}`);

    // Bypass any system proxy: the proof only ever talks to loopback, and a
    // machine-level proxy (or TUN-mode tool) can otherwise hijack Chromium's
    // loopback navigation between runs.
    const browser = await chromium.launch({ args: ['--no-proxy-server'] });
    const bootPage = async () => {
      const next = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      next.on('pageerror', (error) => {
        pageErrors.push(error);
        console.error(`[pageerror] ${error}`);
      });
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
    // Warm vite's transform pipeline before Chromium's first load: a cold dev
    // server on a loaded machine can spend tens of seconds in dep
    // re-optimization, and the 30s/45s navigation budgets wedge on it (the
    // listener answers waitForServer long before the first document finishes
    // transforming).
    await fetch(WEB_URL).catch(() => undefined);
    await fetch(`${WEB_URL}/src/main.tsx`).catch(() => undefined);
    // domcontentloaded + an explicit app-ready selector: the app opens a WS
    // and polls sessions on a 5s cadence, so 'networkidle' is never a
    // reliable condition (30s startup flake under cold vite transforms).
    // The FIRST navigation right after a previous run's teardown can wedge
    // entirely (a half-recycled port answers waitForServer's plain fetch but
    // never serves the document): retry once with a fresh page before failing.
    // Budgets are generous because a heavily loaded shared machine stretches
    // vite's cold transform of the entry graph far past a minute.
    try {
      await page.goto(deepLink, { waitUntil: 'domcontentloaded', timeout: 240_000 });
    } catch (error) {
      console.log(`[proof] first navigation failed (${error.message}) — retrying on a fresh page`);
      await page.close().catch(() => undefined);
      page = await bootPage();
      await page.goto(deepLink, { waitUntil: 'domcontentloaded', timeout: 300_000 });
    }
    await page.waitForSelector(`text=${S.newSession}`, { timeout: 120_000 });
    console.log('[proof] connected to fixture');
    throwOnPageErrors('initial app boot');

    for (const [name, run] of SCENARIOS) {
      if (!wanted(name)) continue;
      console.log(`[scenario] ${name}`);
      let failure = null;
      try {
        // Leave /s/:id before the fixture wipes sessions, otherwise the still-
        // mounted SessionView 404s and toasts "This session no longer exists".
        await page.evaluate(() => {
          try { localStorage.removeItem('kiki.lastSessionId'); } catch { /* ignore */ }
        });
        await page.goto(`${WEB_URL}/new?server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}`, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        await control({ action: 'scenario', name });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector(`text=${S.newSession}`, { timeout: 30_000 });
        await page.waitForTimeout(900); // let the first sessions poll land
        await run();
        if (CANONICAL_PROOF_SCENARIOS.has(name)) {
          await assertCanonicalTranscriptProtocol(name);
          await assertCanonicalDomSurface();
        }
      } catch (error) {
        failure = error;
      }
      try {
        throwOnPageErrors(`scenario ${name}`);
      } catch (error) {
        failure ??= error;
      }
      if (failure !== null) {
        console.error(`[FAIL] scenario ${name}:`, failure.message);
        process.exitCode = 1;
        await shot(`${name}-FAIL`);
      }
    }

    throwOnPageErrors('visual proof shutdown');
    await browser.close();
  } finally {
    await cleanup();
  }
  console.log(process.exitCode ? 'PROOF FAILED' : 'PROOF DONE');
}

await main();
