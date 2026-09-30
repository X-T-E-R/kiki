/**
 * kiki-gui visual proof — walks every GUI fixture scenario against a static
 * production build with playwright chromium and writes screenshots to an
 * ignored disposable directory by default. The app contains zero
 * fixture-specific code paths: it connects to the fixture server exactly like a
 * real kap-server (deep link with server URL + fixture token).
 *
 *   node scripts/visual-proof.mjs                         # disposable full walk
 *   node scripts/visual-proof.mjs --only=reconnect        # disposable subset
 *   node scripts/visual-proof.mjs --update-goldens        # replace tracked goldens
 *
 * `proof/runner.mjs` owns the build, the static server, the job queue and the
 * per-job browser context + fixture server; this file owns the scenarios.
 * Every scenario body here is written against one page and one fixture server
 * and reaches them through the per-job accessors below, so the scenarios can
 * run in parallel without sharing state.
 *
 * Views: a scenario that walks theme × width (or any other dimension) does not
 * loop over it — it declares the dimensions in `MATRIX` below, and the runner
 * runs one job per combination with its own context (locale, theme, viewport).
 * `--matrix=default` keeps the canonical en/light/1440 view, `--matrix=all`
 * expands every declared dimension.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_TOKEN } from './fixture-server.mjs';
import { assertTimelineIntegrity, drainTimeline } from './timeline-integrity.mjs';
import { runProof } from '../proof/runner.mjs';
import { createContextCompactWalker } from './visual-proof-context-compact.mjs';
import { createCapabilitiesWalker } from './visual-proof-capabilities.mjs';
import { createProfileEditorWalker } from './visual-proof-profile-editor.mjs';
import { createModelsPageWalker } from './visual-proof-models-page.mjs';
import { createSettingsIaWalker } from './visual-proof-settings-ia.mjs';
import { createWorktreesWalker } from './visual-proof-worktrees.mjs';
import { createNativeSshWalker } from './visual-proof-native-ssh.mjs';
import { createExternalMainWalker } from './visual-proof-external-main.mjs';
import { createSteerWalker } from './visual-proof-steer.mjs';
import { en as EN_DICTIONARY } from '../../../packages/session-core/src/i18n/en.ts';
import { zh as ZH_DICTIONARY } from '../../../packages/session-core/src/i18n/zh.ts';

/**
 * Scenarios whose walk exercises the transcript list (streaming, folding,
 * expansion, subagent tabs/routes, jumps). Every one ends with the timeline
 * integrity gate: no rows overlapping at rest and no overlap visible for more
 * than a few frames at any point of the walk.
 */
const TIMELINE_GATED = new Set([
  'long-transcript', 'subagents', 'subagents-burst', 'subagent-approval',
  'goal-swarm', 'tool-pipeline', 'rewrite-flow', 'error-abort', 'steer',
]);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Dimensions a scenario delegates to the runner. These walks used to loop
 * theme × width themselves and shoot every combination in one page; now each
 * combination is its own job, and the walk captions the single pass it is
 * given. `locale` is a base dimension of every scenario and is not listed.
 */
const MATRIX = {
  capabilities: ['theme', 'width'],
  'composer-modes': ['theme', 'width'],
  'context-compact': ['theme', 'width'],
  'models-page': ['theme', 'width'],
  'models-page-empty': ['theme', 'width'],
  'native-ssh': ['theme', 'width'],
  'profile-editor': ['theme', 'width'],
  'external-main': ['theme'],
  'settings-ia': ['theme', 'width'],
  skins: ['theme'],
  steer: ['width'],
  worktrees: ['theme', 'width'],
};

/**
 * UI-chrome strings the walkers key on, taken from the app's own dictionaries
 * instead of copied by hand. `SOURCES` maps a proof key to the i18n key the UI
 * renders, so a rewritten key or a changed translation flows straight through
 * instead of leaving the proof asserting copy no screen shows. Count-sensitive
 * copy names its `.one`/`.other` side (`count`), and `pattern` turns the
 * template into a RegExp matcher. `LITERALS` holds the few values that are not
 * a whole dictionary string — short probes matched with `hasText`/`includes`,
 * regex matchers, invariant word lists and typed input — and any probe or
 * matcher that names an `anchor` is re-checked against the dictionaries below.
 *
 * Fixture content — session titles, streamed answers, question options — comes
 * from the server and stays English in both runs.
 */
const DICTIONARIES = { en: EN_DICTIONARY, zh: ZH_DICTIONARY };
const LOCALES = ['en', 'zh'];

/** Mirrors session-core `translate()`: locale → English → Chinese → raw key. */
function dictionaryText(locale, key, params) {
  const template = DICTIONARIES[locale][key] ?? EN_DICTIONARY[key] ?? ZH_DICTIONARY[key];
  if (template === undefined) throw new Error(`visual-proof references unknown i18n key "${key}"`);
  if (params === undefined) return template;
  return template.replaceAll(/\{(\w+)\}/g, (raw, name) =>
    (params[name] === undefined ? raw : String(params[name])));
}

/** `params` entries may themselves be dictionary lookups. */
function resolvedParams(locale, params) {
  if (params === undefined) return undefined;
  const resolved = {};
  for (const [name, value] of Object.entries(params)) {
    resolved[name] = value !== null && typeof value === 'object'
      ? dictionaryText(locale, value.key, resolvedParams(locale, value.params))
      : value;
  }
  return resolved;
}

/** A dictionary template with every `{placeholder}` widened into a matcher. */
function placeholderPattern(template) {
  return new RegExp(template
    .split(/(\{\w+\})/)
    .map((part) => {
      if (/^\{\w+\}$/.test(part)) return part === '{count}' ? '\\d+' : '.+';
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join(''));
}

function resolveSource(locale, source) {
  const fill = (template) => template.replaceAll(/\{(\w+)\}/g, (raw, name) => {
    const value = source.params?.[name];
    return value === undefined ? raw : dictionaryText(locale, value.key, resolvedParams(locale, value.params));
  });
  if (source.template !== undefined) return fill(source.template);
  const key = source.count === undefined
    ? source.key
    : `${source.key}.${source.count === 1 ? 'one' : 'other'}`;
  const params = resolvedParams(locale, source.params);
  // A matcher keeps `{count}` raw so it widens into `\d+` instead of a number.
  const filled = source.count === undefined || source.pattern === true
    ? params
    : { ...params, count: source.count };
  const text = dictionaryText(locale, key, filled);
  return source.pattern === true ? placeholderPattern(text) : text;
}

/** Proof key → the i18n key (plus placeholders) the UI renders for it. */
const SOURCES = {
  newSession: { key: 'sidebar.newSession' },
  autoWorkspace: { key: 'new.autoWorkspace' },
  sendAria: { key: 'composer.sendAria' },
  working: { key: 'sv.working' },
  approvalNeeded: { key: 'ia.approvalNeeded' },
  approve: { key: 'ia.approve' },
  approved: { key: 'ia.resolution.approved' },
  kikiAsks: { key: 'ia.kikiAsks' },
  submit: { key: 'ia.submit' },
  settings: { key: 'sidebar.settings' },
  tabProviders: { key: 'st.ai.tab.providers' },
  capabilities: { key: 'rail.capabilities.title' },
  tools: { key: 'st.tools.title' },
  skills: { key: 'st.section.skills' },
  mcp: { key: 'st.section.mcp' },
  automation: { key: 'st.section.automation' },
  shimPlugins: { key: 'st.section.plugins' },
  composerCardTitle: { key: 'st.composer.title' },
  appearanceTitle: { key: 'st.appearance.title' },
  themeDark: { key: 'st.appearance.theme.dark' },
  themeLight: { key: 'st.appearance.theme.light' },
  switcherSettingsGroup: { key: 'switcher.settings' },
  savedTick: { key: 'st.savedTick' },
  planModeToggle: { key: 'st.defaults.planMode' },
  permissionModeAuto: { key: 'st.defaults.permission.auto' },
  onboardingTitle: { key: 'onboarding.title' },
  onboardingNext: { key: 'onboarding.next' },
  onboardingBack: { key: 'onboarding.back' },
  onboardingSaveNext: { key: 'onboarding.saveNext' },
  onboardingFinish: { key: 'onboarding.finish' },
  onboardingSkipForNow: { key: 'onboarding.skipForNow' },
  onboardingSkip: { key: 'onboarding.skip' },
  onboardingRecommended: { key: 'onboarding.permissions.recommended' },
  onboardingReenter: { key: 'onboarding.reenter' },
  onboardingTest: { key: 'onboarding.model.test' },
  fetchModelsButton: { key: 'st.fetchModels.button' },
  requestIdentityLabel: { key: 'st.section.identity' },
  saveProvider: { key: 'st.providers.save' },
  providerApiKey: { key: 'st.providers.apiKey' },
  oauthCancel: { key: 'st.oauth.cancel' },
  technicalDetails: { key: 'st.namedAgents.technicalDetails' },
  dirtyDiscard: { key: 'st.dirty.leaveConfirm' },
  promptModeLabel: { key: 'st.namedAgents.promptMode' },
  delegationNoticeLabel: { key: 'st.namedAgents.delegationNotice' },
  scopedBadgeLabel: { key: 'st.namedAgents.scopedBadge' },
  shippedRestore: { key: 'st.shipped.restore' },
  shippedRestored: { key: 'st.shipped.restored' },
  // The badge is two keys joined by the row: "Built-in · modified".
  shippedBadgeModified: { template: '{badge} · {status}', params: { badge: { key: 'st.shipped.badge' }, status: { key: 'st.shipped.custom' } } },
  shippedBadgeRemoved: { template: '{badge} · {status}', params: { badge: { key: 'st.shipped.badge' }, status: { key: 'st.shipped.removed' } } },
  subagentDefaultLabel: { key: 'st.subagentDefault.label' },
  subagentDefaultStrict: { key: 'st.subagentDefault.strict' },
  planGateTimeoutInvalid: { key: 'st.defaults.planGateTimeoutInvalid' },
  nbSearchSave: { key: 'st.nbSearch.save' },
  nbSearchRunCheck: { key: 'st.nbSearch.runCheck' },
  nbSearchCheckFailed: { key: 'st.nbSearch.checkFailed' },
  nbSearchReady: { key: 'st.nbSearch.stateReady' },
  nbSearchDegraded: { key: 'st.nbSearch.stateDegraded' },
  nbSearchUnconfigured: { key: 'st.nbSearch.stateUnconfigured' },
  // The source line under a stored secret on the shared secret field.
  secretSourceKiki: { key: 'st.secret.source.kiki' },
  secretSourceNone: { key: 'st.secret.source.none' },
  loadMore: { key: 'sidebar.loadMore' },
  searchLoadMore: { key: 'sidebar.searchLoadMore' },
  // The sidebar's "no content hits" line, with the query this walk types.
  sidebarNoMatches: { key: 'sidebar.results.none', params: { query: 'zzzznothing' } },
  workspaceFilterAll: { key: 'sidebar.workspaceAll' },
  groupPinned: { key: 'sidebar.groupPinned' },
  groupByTime: { key: 'sidebar.groupByTime' },
  groupByWorkspace: { key: 'sidebar.groupByWorkspace' },
  groupUngrouped: { key: 'sidebar.groupUngrouped' },
  sortUpdatedDesc: { key: 'sidebar.sortUpdatedDesc' },
  sortUpdatedAsc: { key: 'sidebar.sortUpdatedAsc' },
  sortTitle: { key: 'sidebar.sortTitle' },
  menuPin: { key: 'menu.pin' },
  menuUnpin: { key: 'menu.unpin' },
  renameButton: { key: 'st.workspaces.rename' },
  workspaceRenameTitle: { key: 'st.workspaces.renameTitle' },
  removeButton: { key: 'st.workspaces.remove' },
  save: { key: 'common.save' },
  // The dirty-form discard button (settings cards and the profile editor).
  discardChanges: { key: 'st.advanced.discard' },
  // Unsent selection notes fold into one pill; `.one`/`.other` on the count.
  notesPillOne: { key: 'composer.notes.pill', count: 1 },
  notesPillTwo: { key: 'composer.notes.pill', count: 2 },
  // A settled stretch of process rows folds into one line naming its steps.
  foldWorked: { key: 'transcript.fold.worked' },
  foldSteps2: { key: 'transcript.fold.steps', count: 2 },
  foldSteps3: { key: 'transcript.fold.steps', count: 3 },
  foldSteps6: { key: 'transcript.fold.steps', count: 6 },
  foldNotes1: { key: 'transcript.fold.notes', count: 1 },
  // Appearance › the prose font select: its label (the trigger's aria name)
  // and the two presets the walk picks between.
  proseFontLabel: { key: 'st.appearance.prose' },
  proseSans: { key: 'st.appearance.prose.sans' },
  proseSerif: { key: 'st.appearance.prose.serif' },
  // The queue row's resting count comes from the composer's queue stack.
  onePromptQueued: { key: 'composer.queueStack.count', count: 1 },
  twoPromptsQueued: { key: 'composer.queueStack.count', count: 2 },
  queueBarPattern: { key: 'composer.queueStack.count', count: 2, pattern: true },
  queueClearTitle: { key: 'sv.queueClearTitle', params: { count: 1 } },
  promptAborted: { key: 'transcript.stoppedByYou' },
  archiveDownloaded: { key: 'action.exportDoneSession' },
  undoTitle: { key: 'undo.title' },
  undoTurn: { key: 'undo.confirm' },
  lastTurnRemoved: { key: 'action.undoDoneSession' },
  memorySaved: { key: 'memory.saved' },
  memoryDelete: { key: 'memory.delete' },
  forkSession: { key: 'menu.fork' },
  compactContext: { key: 'menu.compact' },
  compactOlderContext: { key: 'context.compactAction' },
  contextDetails: { key: 'context.detailsTitle' },
  sessionUsage: { key: 'context.sessionUsage' },
  usageAllHistory: { key: 'usage.allHistoryChip' },
  usageEstimatedCost: { key: 'usage.kpi.estimatedCost' },
  usagePartial: { key: 'usage.kpi.partialUnknown' },
  usageReliability: { key: 'usage.reliability.title' },
  usageDeletedExcluded: { key: 'usage.reliability.deleted.excluded' },
  usageFiveHourRhythm: { key: 'usage.tab.fiveHour' },
  usageDrilldown: { key: 'usage.drilldown.title' },
  contextMenuCut: { key: 'contextMenu.cut' },
  contextMenuCopy: { key: 'contextMenu.copy' },
  pasteAsPlainText: { key: 'contextMenu.paste' },
  contextMenuSelectAll: { key: 'contextMenu.selectAll' },
  resyncing: { key: 'sv.resyncing' },
  notActivatable: { key: 'composer.slash.notActivatable' },
  shortcuts: { key: 'composer.slash.shortcuts' },
  sendAnyway: { key: 'composer.slash.sendAnyway' },
  queueRecoveredDismiss: { key: 'sv.queueRecovered.dismiss' },
  objectivePlaceholder: { key: 'composer.goalObjectivePlaceholder' },
  systemReminder: { key: 'transcript.systemReminder' },
  fromSubagentApprover: { key: 'ia.fromSubagent', params: { name: 'Approver' } },
  goalFollowUpSubagents: { key: 'goal.followUp', params: { timing: { key: 'timing.subagentsDone' } } },
  queuePromptAria: { key: 'composer.queueAria' },
  sendNow: { key: 'sv.queueSendNow' },
  removeQueued: { key: 'sv.queueRemove' },
  clearQueue: { key: 'sv.queueClearAll' },
  queueRemoveConfirm: { key: 'queue.removeConfirm' },
  togglePanelAria: { key: 'sv.togglePanelAria' },
  openMenuAria: { key: 'sv.openMenuAria' },
  sessionActionsAria: { key: 'sv.actionsAria' },
  terminalKillConfirm: { key: 'term.killConfirm' },
  pluginsAdd: { key: 'st.plugins.addTitle' },
  pluginsMarketplaceTab: { key: 'st.plugins.tab.marketplace' },
  pluginsUninstall: { key: 'st.plugins.uninstall' },
  pluginsManifest: { key: 'st.plugins.details' },
  pluginsMcpOn: { key: 'st.plugins.mcpOn' },
  pluginsInstall: { key: 'st.plugins.install' },
  cancel: { key: 'common.cancel' },
  capBuiltin: { key: 'cap.group.builtin' },
  capFilterAria: { key: 'cap.filterAria' },
  capRestartRequested: { key: 'st.mcp.restartRequested' },
  turnWorking: { key: 'composer.working' },
  stopped: { key: 'transcript.stopped' },
  queueExpandAria: { key: 'sv.queueExpandAria' },
  queueEditRowAria: { key: 'sv.queueEditAria' },
  queueEditingBadge: { key: 'queue.editingBadge' },
  queueEditConfirmAria: { key: 'composer.queueEditConfirm' },
  queueDragHandleAria: { key: 'queue.dragHandleAria' },
  previewSource: { key: 'preview.source' },
  previewCollapse: { key: 'preview.collapse' },
  editAction: { key: 'transcript.edit' },
  regenerateAction: { key: 'transcript.regenerate' },
  forkAction: { key: 'transcript.fork' },
  resendEdit: { key: 'transcript.editSubmit' },
  showMore: { key: 'transcript.showMore' },
  showLess: { key: 'transcript.showLess' },
  forkedDone: { key: 'action.forkDoneSession' },
  quoteAction: { key: 'composer.quoteSelection' },
  annotateAction: { key: 'composer.annotateSelection' },
  removeAnnotation: { key: 'composer.removeAnnotation' },
  // Composed chrome the walkers match as one string.
  steps3: { key: 'transcript.steps', params: { count: 3 } },
  terminalExited: { key: 'term.exited', params: { code: 0 } },
  subagentTranscript: { key: 'sv.subagentNote' },
};

/**
 * Values that are not a whole dictionary string. `anchor` (a key, or several)
 * names the dictionary copy the value must stay a part of; `anchorless`
 * entries are matchers and input with nothing in the dictionaries to gate on.
 */
const LITERALS = {
  // Short probes: the walk matches a fragment inside a longer rendered row.
  externalChanges: { en: 'granted change', zh: '授予', anchor: 'ia.external.changes.one' },
  onboardingReady: { en: 'A model provider is connected', zh: '已连接模型供应商', anchor: 'onboarding.model.ready' },
  onboardingTestedOk: { en: 'Connection works', zh: '连接成功', anchor: 'onboarding.model.testedOk' },
  disabledMainHint: { en: 'Still available for main sessions', zh: '仍可用于主会话', anchor: 'st.namedAgents.disabledMainHint' },
  overriddenNote: { en: 'Built-in agent overridden by', zh: '内置智能体已被', anchor: 'st.namedAgents.overriddenByFile' },
  overridesBuiltinNote: { en: 'overrides the built-in agent', zh: '已覆盖同名的内置智能体', anchor: 'st.namedAgents.overridesBuiltin' },
  shadowedNote: { en: 'Not in effect', zh: '未生效', anchor: 'st.namedAgents.shadowedByBuiltin' },
  shippedRestoreTitle: { en: 'Restore the original of built-in agent', zh: '恢复内置智能体', anchor: 'st.shipped.restoreTitle' },
  subagentDefaultStrictHint: { en: 'fail with an error instead of falling back', zh: '未指定子智能体的派发将报错', anchor: 'st.subagentDefault.strictHint' },
  nbSearchSaved: { en: 'Search & retrieval saved', zh: '搜索与抓取配置已保存', anchor: 'st.nbSearch.saved' },
  nbSearchFailClosed: { en: 'refuses to run', zh: '不会执行', anchor: 'st.nbSearch.failClosedNote' },
  nbSearchRevision: { en: 'Config revision', zh: '配置修订', anchor: 'st.nbSearch.lastChecked' },
  noSessions: { en: 'No sessions yet', zh: '还没有会话', anchor: 'sidebar.noSessions' },
  blankPage: { en: 'A blank page', zh: '白纸一张', anchor: 'transcript.blank' },
  filesHeader: { en: 'Files — mentioned as @path', zh: '文件 — 在消息中以 @路径 引用', anchor: 'composer.filesHeader' },
  noMatches: { en: 'No matches', zh: '没有匹配', anchor: 'select.noMatches' },
  terminalEmpty: { en: 'No terminals yet', zh: '还没有终端', anchor: 'term.empty' },
  capEmptyFilter: { en: 'No capabilities match', zh: '没有匹配', anchor: 'cap.emptyFilter' },
  capNoWorkspace: { en: 'No workspace is registered', zh: '没有已注册的工作区', anchor: 'cap.noWorkspace' },
  queueEditBanner: { en: 'Editing a queued message', zh: '正在编辑排队消息', anchor: 'composer.queueEditBanner' },
  editNote: { en: 'Full replacement', zh: '完整替换语义', anchor: 'transcript.editAttachmentsNote' },
  compactionRequested: { en: 'Compaction requested', zh: '已请求压缩', anchor: 'context.strategy.compactRequested.summarize' },
  exportArchive: { en: 'Export archive', zh: '导出归档', anchor: 'menu.export' },
  undoLastTurn: { en: 'Undo last turn', zh: '撤销最后一轮', anchor: 'menu.undo' },
  // Regex matchers, each anchored to the copy it must keep matching.
  bannerPattern: { en: /Connection lost|Disconnected from the server/, zh: /正在重连|已与服务器断开连接/, anchor: ['app.reconnecting', 'app.disconnected'] },
  ranForPattern: { en: /Ran for/, zh: /用时/, anchor: 'transcript.ranFor' },
  ttftPattern: { en: /TTFT/, zh: /首 token/, anchor: 'transcript.ttft' },
  previewReadonlyPattern: { en: /Read-only here/, zh: /此处为只读/, anchor: 'preview.editUnsupported' },
  // Word list the delete confirmation must never use, and a fragment of the
  // fixture server's own agent name — neither is dictionary copy.
  memoryBannedInDelete: { en: ['permanent', 'cannot be undone', 'forever'], zh: ['永久', '不可恢复', '无法撤销'] },
  usageSubagentPattern: { en: /subagent/, zh: /子智能体/ },
  // Typed into the settings search box; the same word in both runs.
  searchQuery: { en: 'theme', zh: '主题' },
  // Kept for walkers not yet written; these screens were retired.
  shimCapabilities: { en: 'The capabilities panel was split into dedicated settings pages', zh: '能力面板已拆分为独立的设置页面' },
  modelProfileLabel: { en: 'model profile', zh: '模型设置' },
  swarmTitlePrefix: { en: 'Swarm mode', zh: '集群模式' },
  goalActive: { en: 'goal · active', zh: '目标 · 进行中' },
};

function buildStrings(locale) {
  const strings = {};
  for (const [key, spec] of Object.entries(LITERALS)) strings[key] = spec[locale];
  for (const [key, source] of Object.entries(SOURCES)) strings[key] = resolveSource(locale, source);
  return strings;
}

/**
 * A probe or matcher is only as good as the copy it points at: a dictionary
 * rewrite would leave it matching nothing (or something else) instead of
 * failing. Re-check every anchored entry against today's dictionaries so the
 * drift surfaces here, with the offending key, rather than mid-walk.
 */
function assertStringsMatchDictionary() {
  const problems = [];
  for (const [key, spec] of Object.entries(LITERALS)) {
    if (spec.anchor === undefined) continue;
    for (const locale of LOCALES) {
      for (const anchor of [spec.anchor].flat()) {
        const template = dictionaryText(locale, anchor);
        const ok = spec[locale] instanceof RegExp ? spec[locale].test(template) : template.includes(spec[locale]);
        if (!ok) problems.push(`${key}[${locale}] ${String(spec[locale])} no longer agrees with ${anchor} ${JSON.stringify(template)}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`visual-proof copy drifted from the session-core dictionaries:\n  ${problems.join('\n  ')}`);
  }
}
assertStringsMatchDictionary();

export const STRINGS = { en: buildStrings('en'), zh: buildStrings('zh') };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The job the calling walker runs in. Scenario bodies here are written against
 * one page and one fixture server, but the runner gives every job its own pair
 * — these accessors resolve to the caller's job, so the same bodies run in
 * parallel contexts without sharing state.
 */
const jobs = new AsyncLocalStorage();

function job() {
  const current = jobs.getStore();
  if (current === undefined) throw new Error('scenario code ran outside a proof job');
  return current;
}

/** The calling job's page; method calls bind to that page on access. */
const page = new Proxy({}, {
  get: (_target, property) => {
    const target = job().page;
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

/** UI chrome of the calling job's locale (fixture content stays English). */
const S = new Proxy({}, {
  get: (_target, key) => STRINGS[job().view.locale]?.[key],
});

const shot = (name) => job().shot(name);
const control = (action) => job().control(action);
/** The calling job's fixture origin; the app reaches it through the deep link. */
const fixtureUrl = () => job().fixtureUrl;
/** Static server origin; one build serves every job of the run. */
let WEB_URL = '';

function throwOnPageErrors(context) {
  const current = job();
  const cursor = current.errorCursor ?? 0;
  const pending = current.errors.slice(cursor);
  current.errorCursor = current.errors.length;
  if (pending.length === 0) return;
  const detail = pending.join('\n\n');
  throw new Error(`${context} emitted ${pending.length} pageerror event(s):\n${detail}`);
}

async function selectSession(titleFragment) {
  // Below md the sidebar is an off-canvas drawer; a translated-away row is
  // visible to the locator but cannot be clicked, so open the drawer first.
  const sidebar = page.locator('aside[data-session-sidebar]');
  const sidebarBox = await sidebar.boundingBox();
  const viewport = page.viewportSize();
  if (sidebarBox !== null && viewport !== null
    && (sidebarBox.x + sidebarBox.width <= 1 || sidebarBox.x >= viewport.width - 1)) {
    await page.locator(`button[aria-label="${S.openMenuAria}"]`).first().click();
    await page.waitForTimeout(300);
  }
  const row = page.locator('aside div.group', { hasText: titleFragment }).first();
  await row.waitFor({ timeout: 10_000 });
  await row.click();
  // The session view fetches its transcript before the composer can take a
  // prompt; a fixed sleep here raced that mount under load and sent the prompt
  // into a composer that was not the session's yet.
  await page.waitForURL(/\/s\//, { timeout: 15_000 });
  // An empty, idle session renders the blank wordmark instead of the scroll
  // container, so settle on whichever body this session actually shows —
  // waiting only for the scroll container burned its whole timeout there.
  await page.waitForSelector(`[data-transcript-scroll], text=${S.blankPage}`, { timeout: 20_000 }).catch(() => undefined);
  // With a pending decision and an empty draft the composer card is taken over:
  // the textarea stays mounted but hidden, and the takeover's "back to input"
  // row is the live seat.
  await page.waitForSelector('textarea:not([disabled]), [data-needs-you-back]', { timeout: 20_000 });
  await page.waitForTimeout(300); // first paint of the transcript rows
}

/** The inspector is closed by default; open it from the header toggle. */
async function openInspector() {
  const rail = page.locator('[data-session-rail]');
  if (await rail.count() > 0) return;
  await page.locator('[data-rail-toggle]').first().click();
  await rail.waitFor({ timeout: 10_000 });
}

async function resizeViewport(width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(300);
}

async function sendPrompt(text, mode = 'send-now') {
  await page.fill('textarea', text);
  if (mode === 'queue') {
    // This button is the ordinary send path when idle and the queue path while
    // busy; unlike Ctrl+Enter it never steers into the running turn.
    await page.locator('button[data-send-ready]').click();
  } else {
    await page.press('textarea', 'Control+Enter');
  }
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

/** Mode (Normal / Plan / Goal, plan gate nested under Plan) lives under ＋ → Mode. */
async function openPlanPanel() {
  if ((await page.locator('[data-run-mode-panel]').count()) > 0) return;
  const trigger = page.locator('[data-add-menu-trigger]');
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await page.locator('[data-add-menu-mode]').click();
  await page.waitForSelector('[data-plan-select] [data-mode-switch="plan"]', { timeout: 5000 });
}

async function closePlanPanel() {
  const trigger = page.locator('[data-add-menu-trigger]');
  if ((await trigger.getAttribute('aria-expanded')) === 'true') {
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(200);
}

/** Arms goal mode through the Mode panel (the Goal row keeps data-goal-mode-toggle). */
async function armGoalMode() {
  await openPlanPanel();
  await page.click('[data-goal-mode-toggle]');
  await closePlanPanel();
}

/**
 * The "Needs you" tray owns pending approvals/questions: its current item must
 * be fully inside the viewport (no scrolling to find the decision), and the
 * transcript must carry one-line records instead of full cards.
 */
async function assertTrayVisible(label) {
  const tray = page.locator('[data-needs-you-tray]');
  await tray.waitFor({ timeout: 10_000 });
  const box = await page.locator('[data-needs-you-tray] [data-tray-current]').boundingBox();
  const viewport = page.viewportSize();
  if (box === null || viewport === null || box.y < 0 || box.y + Math.min(box.height, 120) > viewport.height) {
    throw new Error(`${label}: tray item not visible without scrolling (${JSON.stringify(box)})`);
  }
  const records = await page.locator('[role="log"] [data-interaction-record]').count();
  console.log(`[check] ${label}: tray visible at y=${Math.round(box.y)}, timeline records=${records}`);
  if (records === 0) throw new Error(`${label}: timeline must keep a one-line record per pending item`);
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
  // The rail whispers while the log scrolls and reaches full contrast only
  // under the pointer (FloorNavRail): check both steps.
  const railOpacity = await rail.evaluate((el) => getComputedStyle(el).opacity);
  console.log(`[check] floor rail opacity while scrolling=${railOpacity}`);
  if (Number(railOpacity) < 0.5) throw new Error('floor rail did not reveal on scroll');
  await rail.hover();
  await page.waitForTimeout(300);
  const hoverOpacity = await rail.evaluate((el) => getComputedStyle(el).opacity);
  console.log(`[check] floor rail opacity under pointer=${hoverOpacity}`);
  if (Number(hoverOpacity) < 0.9) throw new Error('floor rail did not reach full contrast under the pointer');
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
  for (const agentId of ['agent-research', 'agent-review']) {
    await page.locator(`[data-subagent-id="${agentId}"]`).first().waitFor({ timeout: 20_000 });
  }
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 20_000 });
  // Settled cards stay in place on the timeline: no history run to open, so
  // each card must still be mounted once the turn has settled.
  if (await page.locator('[data-history-run]').count() !== 0) {
    throw new Error('settled subagent cards were folded behind a history run');
  }
  for (const agentId of ['agent-research', 'agent-review']) {
    await page.locator(`[data-subagent-id="${agentId}"]`).waitFor({ timeout: 10_000 });
  }
  const bubbleCount = await page.locator('[data-subagent-id]').count();
  const inlineToolCount = await page.locator('[role="log"] [data-block-id^="tool-"], [role="log"] [data-block-id^="group-"]').count();
  await openInspector();
  const railText = await page.locator('[data-session-rail]').innerText();
  console.log(`[check] subagent bubbles=${bubbleCount} inlineTools=${inlineToolCount}`);
  if (bubbleCount !== 2) {
    throw new Error(`expected 2 subagent bubbles after history expansion, got ${bubbleCount}/${inlineToolCount}`);
  }
  if (!railText.includes('Researcher') || !railText.includes('Reviewer')) {
    throw new Error('subagent rail does not list both agents');
  }
  const rail = page.locator('[data-session-rail]');
  const railToggle = page.locator('[data-rail-toggle]');
  // Esc closes the rail via the session view's window keydown handler, so
  // never assume the rail is still open; make every step explicit.
  const ensureRailOpen = async () => {
    if (await rail.count() === 0) {
      await railToggle.click();
      await rail.waitFor({ timeout: 10_000 });
    }
  };
  // The board's one entry is the sidebar nav row, pre-filtered to this
  // session's workspace; the inspector does not repeat it.
  const launcher = page.locator('aside [data-nav-board]');
  const openBoardFromNav = async () => {
    await launcher.click();
    await page.waitForSelector('[data-task-board-page]', { timeout: 10_000 });
    if (!/\/board\?workspace=/.test(page.url())) throw new Error(`board link lost the workspace scope: ${page.url()}`);
    await page.goBack();
    await page.waitForSelector('[data-rail-toggle]', { timeout: 10_000 });
  };
  await ensureRailOpen();
  if (await rail.locator('[data-session-task-board]').count() !== 0) throw new Error('inspector still repeats the board link');
  await openBoardFromNav();
  await ensureRailOpen();
  await page.locator('[data-subagent-id="agent-research"]').click();
  // Subagent panels open as preview-workspace tabs by default — no route change.
  // The tab renders the unified agent workspace (transcript + composer); the
  // fullscreen /agent/ route is covered by subagents-burst.
  const agentTabPanel = page.locator('[data-preview-tabpanel="panel:agent-research"]');
  await agentTabPanel.waitFor({ timeout: 10_000 });
  await waitForText('Protocol map complete.');
  await agentTabPanel.locator('[data-composer-variant="subagent"]').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await shot('subagents-agent-page');
  await page.setViewportSize({ width: 700, height: 760 });
  await page.waitForTimeout(250);
  if (await rail.count() === 0) {
    await page.locator('[data-agent-rail-toggle]').click();
    await rail.waitFor({ timeout: 5_000 });
  }
  // The narrow rail's tail (folded setup / session rows) stays inside it.
  const tail = rail.locator('[data-inspector-tail]');
  await tail.scrollIntoViewIfNeeded();
  const tailBox = await tail.boundingBox();
  const railBox = await rail.boundingBox();
  if (tailBox === null || railBox === null
    || tailBox.x < railBox.x - 1 || tailBox.y < railBox.y - 1
    || tailBox.x + tailBox.width > railBox.x + railBox.width + 1
    || tailBox.y + tailBox.height > railBox.y + railBox.height + 1) {
    throw new Error('narrow rail tail is not contained in the rail');
  }
  await page.locator('[data-agent-panel-scroll]').evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.waitForTimeout(100);
  await shot('subagents-relief-narrow');
  await page.goto(page.url().replace(/\/s\/[^?]+/, '/board'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-task-board-page]', { timeout: 10_000 });
  console.log('[check] narrow viewport opened the /board page');
  await page.waitForTimeout(400);
  await shot('board-page-narrow');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await shot('board-page');
  // The Scheduled tasks nav row opens /cron with the same workspace scope.
  await page.locator('aside [data-nav-cron]').click();
  await page.waitForSelector('[data-cron-page]', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('cron-page');
}

async function scenarioGoalSwarm() {
  await selectSession('Fixture: goal + swarm');
  // Goal state is the composer card's top row whose detail expands in the
  // card; the right rail no longer carries the objective as resident prose.
  const goalTab = page.locator('[data-composer-header] [data-header-toggle="goal"]');
  await goalTab.waitFor({ timeout: 10_000 });
  if (!((await goalTab.innerText()).includes('Prepare the release evidence bundle'))) {
    throw new Error('composer row must name the goal objective');
  }
  await openGoalDrawer();
  const goalCard = page.locator('[data-goal-card]');
  const initialGoalCardText = await goalCard.textContent();
  if (initialGoalCardText === null || !initialGoalCardText.includes('Prepare the release evidence bundle')) {
    throw new Error(`goal card must be visible on load, got "${initialGoalCardText}"`);
  }
  await openInspector();
  const railText = await page.locator('[data-session-rail]').innerText();
  if (railText.includes('Prepare the release evidence bundle')) {
    throw new Error('right rail still renders the goal objective as resident prose');
  }
  // Mode menu: exactly Normal / Plan / Goal — parallel subagents is gone.
  await openPlanPanel();
  const modeRows = await page.locator('[data-run-mode-panel] [data-mode-switch]').evaluateAll(
    (rows) => rows.map((row) => row.getAttribute('data-mode-switch')),
  );
  if (JSON.stringify(modeRows) !== JSON.stringify(['normal', 'plan', 'goal'])) {
    throw new Error(`Mode menu must offer normal/plan/goal only, saw ${JSON.stringify(modeRows)}`);
  }
  await page.click('[data-goal-mode-toggle]');
  await closePlanPanel();
  const modeChip = await page.locator('[data-run-mode-chip]').getAttribute('data-run-mode-chip');
  if (modeChip !== 'goal') throw new Error(`goal mode must show the mode chip, saw ${modeChip}`);
  await page.locator('[data-goal-armed]').waitFor({ timeout: 5000 });
  await sendPrompt('Ship the fixture release');
  await waitForText('Swarm mode is on and the goal state is live.');
  const inspected = await control({ action: 'session', session_id: 'session_fixture_goal_swarm' });
  const submission = inspected.data?.last_prompt_submission;
  console.log(`[check] goal/swarm submission ${JSON.stringify(submission)}`);
  if (submission?.goal_objective !== 'Ship the fixture release' || submission?.swarm_mode !== undefined) {
    throw new Error('PromptSubmission must carry goal_objective and no retired swarm_mode');
  }
  // The card tracks the goal as it evolves — the updated objective and the
  // follow-up timing stay visible without reopening anything.
  await page.waitForFunction(
    () => document.querySelector('[data-header-toggle="goal"]')?.textContent?.includes('Ship the fixture release') === true,
    undefined,
    { timeout: 10_000 },
  );
  await openGoalDrawer();
  const goalCardText = await goalCard.textContent();
  if (goalCardText === null || !goalCardText.includes(S.goalFollowUpSubagents)) {
    throw new Error(`goal card must trace the follow-up timing, got "${goalCardText}"`);
  }
  await page.waitForTimeout(400);
  await shot('goal-swarm');
}

async function scenarioGoalQueue() {
  await selectSession('Fixture: goal + queue');
  // The goal rides in the composer's top row; its detail shows the follow-up.
  await openGoalDrawer();
  const card = page.locator('[data-goal-card]');
  const cardText = await card.textContent();
  if (cardText === null || !cardText.includes('Prepare the release evidence bundle')) {
    throw new Error(`goal card must show the objective, got "${cardText}"`);
  }
  if (!cardText.includes(S.goalFollowUpSubagents)) {
    throw new Error(`goal card must show the follow-up timing, got "${cardText}"`);
  }
  // The restored queue is gated: the recovery bar asks before anything resumes.
  const hold = page.locator('[data-recovery-hold]');
  await hold.waitFor({ timeout: 10_000 });
  await shot('goal-queue-recovery-hold');
  await hold.locator(`button:has-text("${S.queueRecoveredDismiss}")`).click();
  await page.waitForSelector('[data-recovery-hold]', { state: 'detached', timeout: 5000 });
  // The queue rests as row text; open its detail, then each row's own
  // append-timing dropdown sits in the row's hover-revealed action group.
  // The fixture seeds the two rows differently.
  await openQueueStrip();
  const changelog = page.locator('select[data-timing-picker="prompt_fx_gq_changelog"]');
  const artifacts = page.locator('select[data-timing-picker="prompt_fx_gq_artifacts"]');
  await changelog.waitFor({ state: 'attached', timeout: 10_000 });
  await artifacts.waitFor({ state: 'attached', timeout: 10_000 });
  if ((await changelog.inputValue()) !== 'agent_idle') {
    throw new Error(`changelog row must start on agent_idle, got "${await changelog.inputValue()}"`);
  }
  if ((await artifacts.inputValue()) !== 'tasks_done') {
    throw new Error(`artifacts row must start on tasks_done, got "${await artifacts.inputValue()}"`);
  }
  // Re-time the first row: the select is React-controlled, so its value snaps
  // back until the fixture's revision bump lands; the row action also disables
  // the select while the round trip is pending. Poll for both settled signals.
  await page.locator('[data-queue-item="prompt_fx_gq_changelog"]').hover();
  await changelog.selectOption('tasks_done');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('select[data-timing-picker="prompt_fx_gq_changelog"]');
      return el !== null && !el.disabled && el.value === 'tasks_done';
    },
    undefined,
    { timeout: 5000 },
  );
  await shot('goal-queue-retimed');
  // Arm goal mode from ＋ → Mode; the chip explains the next send.
  await armGoalMode();
  await page.locator('[data-goal-armed]').waitFor({ timeout: 5000 });
  await page.waitForTimeout(400); // let the chip's enter animation settle
  await shot('goal-queue-goal-armed');
  // Mobile pass: card, strip, and the timing segments must survive 390px.
  await resizeViewport(390);
  // Below lg the rail becomes an overlay that covers the dock — close it so
  // the card and strip are what the shot judges.
  const rail = page.locator('[data-session-rail]');
  if ((await rail.count()) > 0 && (await rail.isVisible())) {
    await page.keyboard.press('Escape');
    await rail.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
  await shot('goal-queue-mobile');
  await resizeViewport(1440);
}

async function scenarioToolPipeline() {
  await selectSession('Fixture: tool pipeline');
  // The journaled Read → Edit → Write chain is settled process between two
  // messages, so it folds into one line that counts what happened.
  const settledFold = page.locator('[role="log"] [data-history-fold]').first();
  await settledFold.waitFor({ timeout: 10_000 });
  const settledText = await settledFold.innerText();
  for (const expected of [S.foldWorked, S.foldSteps3]) {
    if (!settledText.includes(expected)) {
      throw new Error(`settled chain line must read "${expected}", saw "${settledText}"`);
    }
  }
  if (await page.locator('[role="log"] [data-history-fold-members]').count() !== 0) {
    throw new Error('folded history rendered its members before expansion');
  }
  if (await page.locator('[role="log"] [data-tool-id]').count() !== 0) {
    throw new Error('folded history rendered its tool rows before expansion');
  }
  await shot('tool-pipeline-folded-history');
  // Opening it lays the original rows back down, one quiet line per action.
  await settledFold.locator('[data-activity-toggle]').first().click();
  await page.locator('[role="log"] [data-history-fold-members]').waitFor({ timeout: 5000 });
  const settledRows = page.locator('[role="log"] [data-history-fold-members] [data-tool-id]');
  if (await settledRows.count() !== 3) {
    throw new Error(`expected 3 unfolded tool rows, saw ${await settledRows.count()}`);
  }
  if (await page.locator('[role="log"] [data-read-run]').count() !== 0) {
    throw new Error('settled actions were folded although fold-steps is off by default');
  }
  await shot('tool-pipeline-grouped');
  // The journaled Edit block has no display payload; its summary is the path —
  // same as Read's, so take the SECOND card carrying it (Read is first).
  await page.locator('button', { hasText: 'C:/fixture/workshop/plan.ts' }).nth(1).click();
  await page.waitForTimeout(400);
  await shot('tool-pipeline-expanded');
  await sendPrompt('Run the tool sequences.');
  // Pending approval remains a visible boundary; its resolution moves to history.
  await waitForText(S.approvalNeeded);
  // The tray promotes the decision to its current item a beat after the
  // timeline records it, and only then does y/n answer it.
  await page.locator('[data-needs-you-tray] [data-tray-current]').waitFor({ timeout: 10_000 });
  await approveViaKeyboard();
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 30_000 });
  await page.waitForTimeout(600);
  if (await page.locator('[role="log"] [data-approval-id]').count() !== 0) {
    throw new Error('resolved approval retained active decision controls');
  }
  if (await page.locator('[role="log"] [data-read-run]').count() !== 0) {
    throw new Error('live actions were folded although fold-steps is off by default');
  }
  // The finished turn's process settles into one line per run; the gated
  // boundary is the run holding the resolved approval, which the fold counts
  // as a note beside its steps. Rows the reader is still looking at are held
  // open, so return to the end of the log first.
  await page.evaluate(() => {
    const log = document.querySelector('[role="log"]');
    if (log !== null) log.scrollTop = log.scrollHeight;
  });
  await page.waitForTimeout(600);
  const boundaryFold = page.locator('[role="log"] [data-history-fold]')
    .filter({ hasText: S.foldNotes1 }).first();
  await boundaryFold.waitFor({ timeout: 10_000 });
  const boundaryText = await boundaryFold.innerText();
  if (!boundaryText.includes(S.foldWorked) || !boundaryText.includes(S.foldSteps2)) {
    throw new Error(`the gated boundary must fold its two steps, saw "${boundaryText}"`);
  }
  await boundaryFold.locator('[data-activity-toggle]').first().click();
  await page.locator('[role="log"] [data-history-fold-members]').first().waitFor({ timeout: 5000 });
  const history = page.locator('[role="log"] [data-history-fold-members] [data-history-line]');
  await history.getByText(S.approved, { exact: true }).waitFor({ timeout: 10_000 });
  if ((await history.boundingBox())?.height > 40) throw new Error('resolved approval must stay a compact timeline row');
  // One verb per row: the label names the action, so the detail never
  // repeats it ("Read read C:/…").
  const doubled = await page.locator('[role="log"] [data-tool] [data-activity-toggle]').evaluateAll((rows) =>
    rows.map((row) => row.textContent ?? '').filter((text) => /^(Read|Edit|Write|Glob)\s*(read|edit|write|list)\b/i.test(text.trim())));
  if (doubled.length > 0) throw new Error(`tool rows repeat their verb: ${doubled.slice(0, 2).join(' | ')}`);
  console.log('[check] settled runs fold into counted lines; approval resolution is one compact row');
  await shot('tool-pipeline-live');
  // Keyboard focus lands visibly on a timeline row.
  await page.locator('[role="log"] [data-tool] [data-activity-toggle]').last().focus();
  await page.waitForTimeout(200);
  await shot('tool-pipeline-focus');
  // Opt-in read fold: inside an opened run, only the ≥3 pure-read stretch
  // collapses, and its line names the objects it looked at.
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('kiki.settings') ?? '{}');
    localStorage.setItem('kiki.settings', JSON.stringify({ ...settings, foldSteps: true }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'kiki.settings', storageArea: localStorage }));
  });
  // The live sequence is its own settled run: open it to reach the read fold.
  const sequenceFold = page.locator('[role="log"] [data-history-fold]')
    .filter({ hasText: S.foldSteps6 }).first();
  await sequenceFold.waitFor({ timeout: 10_000 });
  if (await sequenceFold.getAttribute('data-history-fold-open') === null) {
    await sequenceFold.locator('[data-activity-toggle]').first().click();
    await page.waitForTimeout(400);
  }
  const run = page.locator('[role="log"] [data-read-run]').first();
  await run.waitFor({ timeout: 10_000 });
  const runText = (await run.textContent()) ?? '';
  if (!runText.includes('notes.md') || !runText.includes('version')) {
    throw new Error(`folded read run must name its objects: ${runText}`);
  }
  if (await page.locator('[role="log"] [data-read-run]').count() !== 1) {
    throw new Error('only the pure-read stretch may fold');
  }
  await run.locator('[data-activity-toggle]').first().click();
  await page.waitForTimeout(300);
  const spine = await run.evaluate((node) => {
    const rail = node.querySelector('.border-l');
    const member = rail?.querySelector('[data-activity-toggle]');
    if (!rail || !member) return undefined;
    return { rail: rail.getBoundingClientRect().left, wash: member.getBoundingClientRect().left };
  });
  if (spine === undefined || spine.wash < spine.rail) {
    throw new Error(`nested hover wash crosses the spine: ${JSON.stringify(spine)}`);
  }
  await run.locator('.border-l [data-activity-toggle]').first().hover();
  await page.waitForTimeout(200);
  await shot('tool-pipeline-folded');
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('kiki.settings') ?? '{}');
    localStorage.setItem('kiki.settings', JSON.stringify({ ...settings, foldSteps: false }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'kiki.settings', storageArea: localStorage }));
  });
  await page.locator('[role="log"] [data-read-run]').waitFor({ state: 'detached', timeout: 5_000 });
  // Narrow window: rows truncate inside the column, nothing overflows.
  await resizeViewport(390);
  await page.waitForTimeout(400);
  const overflow = await page.locator('[role="log"]').evaluate((log) => log.scrollWidth - log.clientWidth);
  if (overflow > 1) throw new Error(`timeline overflows the 390 viewport by ${overflow}px`);
  await shot('tool-pipeline-390');
  await resizeViewport(1440);
}

async function scenarioQuestionCard() {
  await selectSession('Fixture: question card');
  await sendPrompt('Ask me the fixture questions.');
  await waitForText(S.kikiAsks);
  await assertTrayVisible('question-card');
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
  await openInspector();
  await waitForText('fixture build (vite)');
  await page.waitForTimeout(500);
  await shot('busy-rail');
}

async function scenarioRailScale() {
  // A 65-agent, three-level fleet: approvals from nested workers bubble to the
  // rail's top and resolve in place; the roster stays grouped and folded.
  await selectSession('Fixture: agent fleet');
  await openInspector();
  const items = page.locator('[data-needs-you-item]');
  await items.first().waitFor({ timeout: 15_000 });
  if (await items.count() !== 2) throw new Error(`expected 2 bubbled approvals, got ${await items.count()}`);
  const summary = page.locator('[data-roster-summary]');
  await summary.waitFor({ timeout: 10_000 });
  // Failures are not a bucket: only waiting is set apart, the rest ran or ended.
  for (const [bucket, expected] of Object.entries({ waiting: 2, running: 16, ended: 47 })) {
    const count = await summary.locator(`[data-roster-filter="${bucket}"]`).getAttribute('data-roster-count');
    if (count !== String(expected)) throw new Error(`roster summary ${bucket} count wrong: ${count} (expected ${expected})`);
  }
  if (await summary.locator('[data-roster-filter="failed"]').count() !== 0) throw new Error('roster still filters by failure');
  const railText = await page.locator('[data-session-rail]').innerText();
  if (/\{"|"\s*:\s*[{"\d]/.test(railText)) throw new Error('rail shows a raw JSON payload');
  // The rail head names who its page is about; the reference section below it
  // unfolds onto the capability tabs.
  const rail = page.locator('[data-session-rail]');
  await rail.locator('[data-rail-profile-head]').waitFor({ timeout: 10_000 });
  const capabilities = rail.locator('[data-rail-capabilities]');
  await capabilities.evaluate((node) => { node.scrollIntoView({ block: 'center' }); });
  await capabilities.locator('button').first().click();
  await rail.locator('[data-capability-tab-button="skills"]').click();
  await rail.locator('[data-capability-source="global"]').first().waitFor({ timeout: 10_000 });
  await page.locator('[data-roster-toggle="agent-docs"]').click();
  await page.waitForTimeout(300);
  await shot('rail-scale');
  await page.locator('[data-needs-you-approve="approval_fleet_api"]').click();
  await page.locator('[data-needs-you-item="approval_fleet_api"]').waitFor({ state: 'detached', timeout: 10_000 });
  await selectSession('Fixture: idle overview');
  await openInspector();
  await page.locator('[data-inspector-overview]').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('rail-scale-idle');
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
  // Floor jumps land far from any measured row: every row the jump reaches
  // must be positioned from its real height (the timeline gate below fails
  // on rows painted over their neighbours).
  for (const tick of [0, 12, 30]) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(250);
    await page.evaluate((index) => { document.querySelectorAll('[data-floor-tick]')[index]?.click(); }, tick);
    await page.waitForTimeout(1200);
    await assertTimelineIntegrity(page, `long-transcript floor jump ${tick}`);
  }
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
  // The stop control is a drawn icon; address it by its accessible name.
  await page.locator('[data-composer-toolbar] button[aria-label="Abort the running prompt"], [data-composer-toolbar] button[aria-label="中止正在运行的消息"]').first().click();
  await page.waitForSelector(`text=${S.promptAborted}`, { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('error-abort');
}

async function scenarioApprovalsGallery() {
  await selectSession('Fixture: approvals gallery');
  await page.waitForSelector('[data-needs-you-tray]', { timeout: 10_000 });
  await assertTrayVisible('approvals-gallery');
  await page.waitForTimeout(400);
  await shot('approvals-gallery');
  // Pick the raw-JSON fallback (the ProbeTool row) from the collapsed rows,
  // then approve it in the tray to show its outcome line in the timeline.
  const probeRow = page.locator('[data-tray-item]', { hasText: 'ProbeTool' });
  if ((await probeRow.count()) > 0) await probeRow.first().click();
  await page.locator('[data-tray-current] [data-approval-id]').waitFor({ timeout: 5000 });
  await page.locator(`[data-tray-current] button:has-text("${S.approve}")`).first().click();
  await page.waitForTimeout(600);
  await shot('approvals-gallery-resolved');
  // Narrow width: the tray still sits above the composer, inside the viewport.
  await resizeViewport(390);
  await assertTrayVisible('approvals-gallery-mobile');
  await shot('approvals-gallery-tray-mobile');
  await resizeViewport(1440);
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
  await page.press('textarea', 'Control+Enter');
  await page.waitForURL(/\/s\//, { timeout: 10_000 });
  await page.waitForSelector('text=Fixture blank session', { timeout: 10_000 });
  await shot('empty-states-created');
}

async function scenarioNewNoWorkspace() {
  // Other scenarios may have selected a workspace that this empty fixture no
  // longer knows. A fresh /new draft must take the automatic workspace path.
  await page.evaluate(() => localStorage.removeItem('kiki.newSessionDraft'));
  await page.goto(`${WEB_URL}/new?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('[data-phase="hero"]', { timeout: 15_000 });
  await page.locator('[data-hero-workspace] > button', { hasText: S.autoWorkspace }).waitFor({ timeout: 15_000 });
  await page.fill('textarea', 'Create a workspace for this first session.');
  const textarea = page.locator('textarea[data-composer]');
  if (await textarea.isDisabled()) {
    throw new Error('textarea must stay editable when no workspace exists');
  }
  await page.waitForFunction((ariaLabel) => {
    const button = document.querySelector(`button[aria-label="${ariaLabel}"]`);
    return button !== null && !button.disabled;
  }, S.sendAria, { timeout: 15_000 });
  await page.waitForTimeout(400);
  await shot('new-no-workspace');
  const createRequest = page.waitForRequest((request) =>
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions');
  await page.press('textarea', 'Control+Enter');
  const body = (await createRequest).postDataJSON();
  if (body.workspace_id !== undefined || body.metadata?.cwd !== undefined) {
    throw new Error(`automatic workspace creation must omit workspace_id and cwd: ${JSON.stringify(body)}`);
  }
  await page.waitForURL(/\/s\//, { timeout: 10_000 });
}

async function scenarioDraftFlow() {
  await page.goto(`${WEB_URL}/new?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector(`text=${S.newSession}`, { timeout: 10_000 });
  await page.fill('textarea', 'Run the fixture draft flow.');
  await page.press('textarea', 'Control+Enter');
  await page.waitForURL(/\/s\//, { timeout: 10_000 });
  await page.waitForSelector('[data-phase="active"]', { timeout: 10_000 });
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
/**
 * composer-modes — the composer's own walker, run in light and dark at 1440
 * and 390: the ＋ menu, the Mode menu (exactly Normal / Plan / Goal, plan
 * gate nested under Plan), the mode chip with ✕, the permission menu, and the
 * "Needs you" card that takes the composer over (the walk releases it back to
 * the input before touching the menus). Then the /new hero and the
 * onboarding wizard's permissions step in dark.
 */
async function scenarioComposerModes() {
  const modeShots = async (suffix) => {
    await page.waitForSelector('[data-needs-you-tray]', { timeout: 10_000 });
    await page.waitForTimeout(400);
    await shot(`composer-tray-${suffix}`);
    // Pending approvals take the composer over, hiding the toolbar behind
    // the card's "back to input" affordance.
    if (!(await page.locator('[data-add-menu-trigger]').isVisible())) {
      await page.locator('[data-needs-you-back]').click();
      await page.locator('[data-add-menu-trigger]').waitFor({ state: 'visible', timeout: 5000 });
    }
    await page.locator('[data-add-menu-trigger]').click();
    await page.waitForSelector('[data-add-menu-mode]', { timeout: 5000 });
    await page.waitForTimeout(250);
    await shot(`composer-add-menu-${suffix}`);
    await page.locator('[data-add-menu-mode]').click();
    await page.waitForSelector('[data-run-mode-panel]', { timeout: 5000 });
    const rows = await page.locator('[data-run-mode-panel] [data-mode-switch]').evaluateAll(
      (els) => els.map((el) => el.getAttribute('data-mode-switch')),
    );
    if (JSON.stringify(rows) !== JSON.stringify(['normal', 'plan', 'goal'])) {
      throw new Error(`Mode menu must offer normal/plan/goal, saw ${JSON.stringify(rows)}`);
    }
    await page.click('[data-run-mode-panel] [data-mode-switch="plan"]');
    await page.waitForSelector('[data-run-mode-panel] [data-mode-switch="planGate"]', { timeout: 5000 });
    await page.waitForTimeout(250);
    await shot(`composer-mode-plan-${suffix}`);
    await page.keyboard.press('Escape');
    const chip = page.locator('[data-run-mode-chip="plan"]');
    await chip.waitFor({ timeout: 5000 });
    await page.waitForTimeout(250);
    await shot(`composer-mode-chip-${suffix}`);
    await page.locator('[data-mode-select] > button').click();
    await page.waitForSelector('[data-mode-select] [role="option"]', { timeout: 5000 });
    await page.waitForTimeout(250);
    await shot(`composer-permission-menu-${suffix}`);
    await page.keyboard.press('Escape');
    // ✕ returns to Normal and the chip leaves the status line.
    await chip.locator('button').last().click();
    await chip.waitFor({ state: 'detached', timeout: 5000 });
    // Ctrl+Shift+M opens the Mode menu straight from the input.
    await page.locator('textarea').first().focus();
    await page.keyboard.press('Control+Shift+M');
    await page.waitForSelector('[data-run-mode-panel]', { timeout: 5000 });
    await page.click('[data-goal-mode-toggle]');
    await page.keyboard.press('Escape');
    await page.locator('[data-run-mode-chip="goal"]').waitFor({ timeout: 5000 });
    await page.waitForTimeout(250);
    await shot(`composer-mode-goal-${suffix}`);
    await page.locator('[data-run-mode-chip="goal"] button').last().click();
    // Send-ready: the filled accent Send carries its glyph in the on-accent ink.
    await page.locator('textarea').first().fill('Summarize the pending approvals');
    await page.waitForTimeout(200);
    await shot(`composer-send-ready-${suffix}`);
    await page.locator('textarea').first().fill('');
  };
  // Select once at desktop width: the theme reload keeps the session route,
  // and at 390 the sidebar is off-canvas.
  await selectSession('Fixture: approvals gallery');
  const { theme, width } = job().view;
  await modeShots(`${theme}-${width}`);
  if (width === 390) {
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflows) throw new Error(`composer overflows the 390 viewport (${theme})`);
    return;
  }
  // The dark-only blocks below are not a theme × width matrix; they run once,
  // in the dark job, and shoot both widths themselves.
  if (theme !== 'dark') return;
  // /new hero with the Goal objective field (dark), both widths.
  await page.goto(`${WEB_URL}/new?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-phase="hero"]', { timeout: 15_000 });
  for (const width of [1440, 390]) {
    await resizeViewport(width);
    await page.locator('[data-add-menu-trigger]').click();
    await page.locator('[data-add-menu-mode]').click();
    await page.click('[data-goal-mode-toggle]');
    await page.waitForSelector('[data-goal-open]', { timeout: 5000 });
    await page.waitForTimeout(250);
    await shot(`composer-new-goal-dark-${width}`);
    await page.keyboard.press('Escape');
    await page.locator('[data-run-mode-chip="goal"] button').last().click();
    await page.waitForTimeout(200);
    await shot(`composer-hero-dark-${width}`);
  }
  // Onboarding (dark): replayed from Settings › About; Auto is preselected.
  await resizeViewport(1440);
  await page.evaluate(() => { try { localStorage.removeItem('kiki.onboarding'); } catch { /* ignore */ } });
  await page.goto(`${WEB_URL}/settings/about?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, { waitUntil: 'domcontentloaded' });
  const replay = page.getByRole('button', { name: S.onboardingReenter, exact: true });
  await replay.waitFor({ timeout: 15_000 });
  await replay.click();
  const wizard = page.locator('[role="dialog"]');
  await wizard.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(450);
  await shot('composer-onboarding-welcome-dark-1440');
  // Walk forward until the permissions step; a step count would break when a
  // step is added.
  for (let step = 0; step < 6 && await wizard.locator('[data-permission-choice]').count() === 0; step += 1) {
    await wizard.locator('button[data-autofocus]').last().click();
    await page.waitForTimeout(350);
  }
  await wizard.locator('[data-permission-choice]').first().waitFor({ timeout: 5000 });
  await shot('composer-onboarding-permissions-dark-1440');
  await resizeViewport(390);
  await shot('composer-onboarding-permissions-dark-390');
  await page.keyboard.press('Escape');
}

async function scenarioHeroShell() {
  const deepLink = (path) =>
    `${WEB_URL}${path}?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`;

  await page.goto(deepLink('/new'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-phase="hero"]', { timeout: 15_000 });
  await page.waitForSelector('textarea:not([disabled])', { timeout: 15_000 });
  await page.waitForTimeout(600);
  await shot('hero-desktop');

  // Agent picker: a standalone toolbar control again. Only enabled main
  // profiles are conversation candidates (agent and grok-only; the non-main
  // reviewer is not offered) — and the labels carry no ` · main` suffix.
  await page.waitForSelector('#composer-agent-profile-select', { timeout: 10_000 });
  const profileTrigger = page.locator('#composer-agent-profile-select');
  const profileTriggerText = await profileTrigger.textContent();
  // The default `agent` profile displays as the product name ("Kiki").
  if (profileTriggerText === null || !profileTriggerText.includes('Kiki') || /main|主档/.test(profileTriggerText)) {
    throw new Error(`agent picker trigger must show the display name, got "${profileTriggerText}"`);
  }
  await profileTrigger.click();
  const profileOptions = await page
    .locator('#composer-agent-profile-select-list [role="option"]')
    .allTextContents();
  const reviewerIndex = profileOptions.findIndex((text) => text.includes('reviewer'));
  const grokIndex = profileOptions.findIndex((text) => text.includes('grok-only'));
  const agentIndex = profileOptions.findIndex((text) => text.includes('Kiki'));
  if (
    profileOptions.length !== 2
    || agentIndex === -1
    || grokIndex === -1
    || reviewerIndex !== -1
    || agentIndex > grokIndex
  ) {
    throw new Error(`agent picker must list only enabled main profiles in catalog order, got ${JSON.stringify(profileOptions)}`);
  }
  // Let the panel's enter animation settle before the shot.
  await page.waitForTimeout(400);
  await shot('hero-profile-picker');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Model picker: provider groups, capability/effort badges, effort footer.
  await page.locator('#composer-model-select').click();
  await page.waitForSelector('#composer-model-select-list [role="option"]', { timeout: 5000 });
  await page.waitForTimeout(400);
  await shot('hero-model-picker');
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
  await page.press('textarea', 'Control+Enter');
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
    path: join(job().out, 'hero-active-mask.png'),
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

  // The pickers must not degrade at mobile width: the panel narrows to the
  // viewport instead of overflowing it.
  await page.locator('#composer-agent-profile-select').click();
  await page.waitForSelector('#composer-agent-profile-select-list [role="option"]', { timeout: 5000 });
  await page.waitForTimeout(400);
  const mobilePickerBox = await page
    .locator('#composer-agent-profile-select-list')
    .boundingBox();
  if (mobilePickerBox === null || mobilePickerBox.x < 0 || mobilePickerBox.x + mobilePickerBox.width > 390) {
    throw new Error(`profile picker overflows the 390px viewport: ${JSON.stringify(mobilePickerBox)}`);
  }
  await shot('hero-profile-picker-mobile');
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
  await page.goto(`${WEB_URL}/settings?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
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

  // Connections tab (models batch): one list of rows, each a <details> keyed
  // by provider id with its health in words; request identity and the rest of
  // the rarely touched fields live under the row editor's Advanced disclosure.
  await page.locator('[data-ai-tab="providers"]').click();
  await page.waitForSelector('[data-connection-list] [data-connection-row="fixture"]', { timeout: 10_000 });
  await page.waitForSelector('[data-connection-row="alt"][data-connection-health="setup"]', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('settings-providers');

  // Reload-proof + legacy-route proof: the pre-merge /settings/providers
  // bookmark redirects to /settings/ai?tab=providers and lands on the same
  // card, so a dev-server reload cannot strand the assertions on the wrong tab.
  await page.goto(`${WEB_URL}/settings/providers?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#st-card-providers [data-connection-row="fixture"]', { timeout: 10_000 });
  if (!page.url().includes('/settings/ai') || !page.url().includes('tab=providers')) {
    throw new Error(`legacy /settings/providers must canonicalize to the connections tab, got ${page.url()}`);
  }

  // Expand a stored API connection: its id is fixed (named in the row, no id
  // input), the key field and Save render, and the provider-level request
  // identity echoes the seeded kimi_code preset inside Advanced.
  const storedRow = page.locator('[data-connection-row="fixture"]');
  await storedRow.locator('> summary').click();
  await storedRow.locator('[data-connection-test-button]').waitFor({ timeout: 5000 });
  if ((await storedRow.locator('#provider-field-id').count()) !== 0) {
    throw new Error('a stored connection must not offer an editable provider id');
  }
  // The API key is a write-only secret field: one masked slot whose value
  // rests behind the token layer, and it names where the value comes from.
  const storedKey = storedRow.locator('[data-secret-field]').filter({
    has: page.locator(`label:text-is("${S.providerApiKey}")`),
  });
  if ((await storedKey.count()) !== 1) {
    throw new Error('a stored API connection must render its API-key field');
  }
  if ((await storedKey.getAttribute('data-secret-source')) !== 'kiki') {
    throw new Error('the stored API connection must show its key comes from Kiki');
  }
  await storedRow.getByRole('button', { name: S.saveProvider }).waitFor({ timeout: 5000 });
  await storedRow.locator('[data-advanced^="provider-"] > button').click();
  // The identity picker is a list box now; its wrapper carries the live value.
  const storedIdentity = storedRow.locator('[data-request-identity-choice]');
  await storedIdentity.waitFor({ timeout: 5000 });
  const identityValue = await storedIdentity.getAttribute('data-request-identity-choice');
  if (identityValue !== 'kimi_code') {
    throw new Error(`stored provider request identity should echo kimi_code, got ${identityValue}`);
  }
  await storedRow.evaluate((element) => { element.scrollIntoView({ block: 'start' }); });
  await page.waitForTimeout(200);
  await shot('settings-providers-editor');
  await storedRow.locator('> summary').click();

  // Account lane: starting a sign-in opens the device-code card (code,
  // countdown, cancel) under the method that started it.
  await page.click('[data-add-connection]');
  await page.click('[data-connection-choice="account"]');
  await page.locator('[data-oauth-method="kimi-code"] button').click();
  await page.waitForSelector('[data-oauth-method="kimi-code"] >> text=WXYZ-1234', { timeout: 10_000 });
  await page.locator('#st-card-providers-add').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot('settings-providers-oauth');
  await page.locator('[data-oauth-method="kimi-code"]').getByRole('button', { name: S.oauthCancel }).click();

  // New-connection form: the API-key lane's Anthropic protocol. "Test
  // connection & pull models" probes the unsaved fields on the server
  // (`POST /providers:probe`) and answers the remote model ids.
  await page.click('[data-connection-choice="api"]');
  await page.click('[data-provider-protocol="anthropic"]');
  await page.locator('#provider-field-base-url').fill(`${fixtureUrl()}/provider-mock/v1`);
  await page.locator('#st-card-providers-add input[type="password"]').fill('fixture-key');
  await page.locator(`button:has-text("${S.fetchModelsButton}"):visible`).click();
  // Probed models stay unsaved suggestions: they surface inside the model
  // picker's listbox, not as page text, until one is picked and saved.
  const modelPicker = page.locator('#provider-model-0-id:visible');
  await modelPicker.click();
  await page.locator('[role="listbox"]:visible').waitFor({ timeout: 5000 });
  await page
    .locator('[role="listbox"]:visible')
    .locator('text=fixture-probe-model')
    .waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('settings-providers-wizard');
  await resizeViewport(390);
  await modelPicker.scrollIntoViewIfNeeded();
  const mobileModelList = await page.locator('[role="listbox"]:visible').boundingBox();
  if (mobileModelList === null || mobileModelList.x < 0 || mobileModelList.x + mobileModelList.width > 390) {
    throw new Error(`provider model picker overflows the 390px viewport: ${JSON.stringify(mobileModelList)}`);
  }
  await shot('settings-providers-wizard-mobile');
  await page.keyboard.press('Escape');
  await resizeViewport(1440);

  // Batch 3 split the capabilities leaf into skills / mcp / automation under
  // "Capabilities & extensions". Nav leaf ids are stable, so click them
  // directly (the app sidebar no longer carries a capabilities entry).
  // The connection wizard is a side panel: Escape closes it (dropping its
  // draft) rather than arming the shared dirty guard, so the navigation needs
  // no confirmation here; the guard itself is walked in `settings-agents`.
  await page.locator('nav [data-settings-nav-leaf="skills"]').click();
  // Capability leaves hold server defaults only; browsing, installing and
  // inspecting live on /capabilities (walked by the `capabilities` scenario),
  // so each leaf proves its defaults card plus the link there.
  await page.waitForSelector('#st-card-caps', { timeout: 10_000 });
  await page.waitForSelector('#st-card-skill-catalog [data-capability-link="skills"]', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('settings-skills');

  // MCP leaf: the capability link plus the server-wide timeouts that moved
  // out of runtime (redesign §8.3).
  await page.locator('nav [data-settings-nav-leaf="mcp"]').click();
  await page.waitForSelector('#st-card-mcp [data-capability-link="mcp"]', { timeout: 10_000 });
  await page.waitForSelector('#st-card-mcp-timeouts', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('settings-mcp');

  // Plugins leaf: the capability link, the catalog source, and the web-bridge
  // runtime readiness card.
  await page.locator('nav [data-settings-nav-leaf="plugins"]').click();
  await page.waitForSelector('#st-card-plugins [data-capability-link="plugins"]', { timeout: 10_000 });
  await page.waitForSelector('#st-card-webbridge', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('settings-plugins');

  // Permissions leaf (IA v2): default mode, reviewer, tool policy. Hooks have their own leaf.
  await page.locator('nav [data-settings-nav-leaf="permissions"]').click();
  await page.waitForSelector('#st-card-tools', { timeout: 10_000 });
  await page.waitForSelector(`text=${S.tools}`, { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('settings-automation');
  await page.locator('nav [data-settings-nav-leaf="hooks"]').click();
  await page.waitForSelector('#st-card-hooks', { timeout: 10_000 });

  // Legacy redirect proof (redesign §10.2 rule 3): the retired capabilities
  // section still resolves — a precise card hash follows the card across the
  // split, landing on the MCP leaf instead of skills.
  await page.goto(`${WEB_URL}/settings/capabilities?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}#st-card-mcp`, {
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
  await page.goto(`${WEB_URL}/new?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
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

  // Settings may scroll vertically as panels grow; horizontal overflow must
  // never hide actions or search targets at this viewport.
  const overflow = await page.evaluate(() => {
    const pane = document.querySelector('[data-settings-scroll]');
    return pane === null ? null : pane.scrollWidth - pane.clientWidth;
  });
  if (overflow === null) throw new Error('settings scroll pane not found');
  if (overflow > 1) throw new Error(`Settings content overflows horizontally by ${overflow}px`);

  // Type → hit list → Enter lands on the card and flashes it.
  await page.keyboard.type(S.searchQuery);
  await page.waitForSelector(`[role="option"]:has-text("${S.appearanceTitle}")`, { timeout: 5000 });
  await page.waitForTimeout(200);
  await shot('settings-search-hits');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#st-card-appearance.settings-card-flash', { timeout: 5000 });
  await shot('settings-search-landed');

  // Dark theme: the flat rows carry their grouping through the dark tokens too.
  await page.locator('#st-card-appearance [data-theme-choice="dark"]').click();
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
  await page.goto(`${WEB_URL}/new?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
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
  await page.locator('#st-card-appearance [data-theme-choice="light"]').click();
  await page.waitForFunction(
    () => document.documentElement.dataset['theme'] === 'light',
    { timeout: 5000 },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function scenarioSettingsWrite() {
  const generalUrl = `${WEB_URL}/settings/permissions?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`;
  const tasksUrl = `${WEB_URL}/settings/sessions?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`;
  await page.goto(generalUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#st-card-permission-defaults', { timeout: 10_000 });
  const permissionModeGroup = page.locator('#st-card-permission-defaults [role="group"]');
  const permissionPending = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/config');
  await permissionModeGroup.getByRole('button', { name: S.permissionModeAuto, exact: true }).click();
  const permissionResponse = await permissionPending;
  const permissionSent = permissionResponse.request().postDataJSON();
  const permissionResult = await permissionResponse.json();
  const permissionKeys = Object.keys(permissionSent).sort();
  if (permissionKeys.length !== 1 || permissionKeys[0] !== 'default_permission_mode' ||
      permissionSent.default_permission_mode !== 'auto' || permissionSent.default_plan_mode !== undefined ||
      permissionSent.plan !== undefined || permissionResult.code !== 0 ||
      permissionResult.data.default_permission_mode !== 'auto' || permissionResult.data.default_plan_mode !== false) {
    throw new Error(`permission defaults save mismatch: keys=${permissionKeys.join(',')} sent=${JSON.stringify(permissionSent)} echoed mode=${permissionResult.data?.default_permission_mode} plan=${permissionResult.data?.default_plan_mode} code=${permissionResult.code}`);
  }
  console.log('[check] permission default saved with narrow mode-only patch');
  await waitForText(S.savedTick);

  await page.goto(tasksUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#st-card-defaults', { timeout: 10_000 });
  const planPending = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/config');
  await page.locator('#st-card-defaults label', { hasText: S.planModeToggle }).click();
  const planResponse = await planPending;
  const planSent = planResponse.request().postDataJSON();
  const planResult = await planResponse.json();
  const planKeys = Object.keys(planSent).sort();
  if (planKeys.length !== 1 || planKeys[0] !== 'default_plan_mode' ||
      planSent.default_plan_mode !== true || planSent.default_permission_mode !== undefined ||
      planSent.plan !== undefined || planResult.code !== 0 ||
      planResult.data.default_permission_mode !== 'auto' || planResult.data.default_plan_mode !== true) {
    throw new Error(`plan defaults save mismatch: keys=${planKeys.join(',')} sent=${JSON.stringify(planSent)} echoed mode=${planResult.data?.default_permission_mode} plan=${planResult.data?.default_plan_mode} code=${planResult.code}`);
  }
  console.log('[check] plan default saved with plan-only patch while preserving mode=auto');
  await page.waitForFunction(() => document.querySelector('#st-card-defaults [data-plan-settings] [role="switch"]')?.getAttribute('aria-checked') === 'true', undefined, { timeout: 10_000 });
  await shot('settings-write-saved');

  const tasksRead = page.waitForResponse((response) =>
    response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/config');
  await page.reload({ waitUntil: 'domcontentloaded' });
  const persistedTasks = await (await tasksRead).json();
  if (persistedTasks.code !== 0 || persistedTasks.data.default_permission_mode !== 'auto' || persistedTasks.data.default_plan_mode !== true) {
    throw new Error(`server defaults did not survive tasks reload: mode=${persistedTasks.data?.default_permission_mode} plan=${persistedTasks.data?.default_plan_mode} code=${persistedTasks.code}`);
  }
  await page.waitForFunction(() => document.querySelector('#st-card-defaults [data-plan-settings] [role="switch"]')?.getAttribute('aria-checked') === 'true', undefined, { timeout: 10_000 });

  await page.goto(generalUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#st-card-permission-defaults', { timeout: 10_000 });
  const generalRead = page.waitForResponse((response) =>
    response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/config');
  await page.reload({ waitUntil: 'domcontentloaded' });
  const persistedGeneral = await (await generalRead).json();
  if (persistedGeneral.code !== 0 || persistedGeneral.data.default_permission_mode !== 'auto' || persistedGeneral.data.default_plan_mode !== true) {
    throw new Error(`server defaults did not survive general reload: mode=${persistedGeneral.data?.default_permission_mode} plan=${persistedGeneral.data?.default_plan_mode} code=${persistedGeneral.code}`);
  }
  await page.waitForFunction(({ auto }) => {
    const group = document.querySelector('#st-card-permission-defaults [role="group"]');
    const button = [...(group?.querySelectorAll('button') ?? [])].find((node) => node.textContent?.trim() === auto);
    return button?.getAttribute('aria-pressed') === 'true';
  }, { auto: S.permissionModeAuto }, { timeout: 10_000 });
  await shot('settings-write-reloaded');
}

async function scenarioConnectionToken() {
  await page.goto(`${WEB_URL}/settings/connection?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  const card = page.locator('#st-card-conn-server');
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  const input = card.locator('#st-conn-token');
  // The token lives in this browser and is fetched only on request: the field
  // rests on its fixed mask, so the value never sits in the DOM unasked.
  const masked = await input.inputValue();
  if (masked === FIXTURE_TOKEN || masked === '') {
    throw new Error(`the stored connection token must rest masked, saw "${masked}"`);
  }
  const reveal = card.locator('[data-secret-reveal]');
  if (await reveal.count() !== 1) {
    throw new Error('expected one accessible token visibility control');
  }
  await card.scrollIntoViewIfNeeded();
  await shot('settings-connection-token-masked');
  await reveal.click();
  await page.waitForFunction((token) => document.querySelector('#st-conn-token')?.value === token, FIXTURE_TOKEN, { timeout: 5000 });
  await shot('settings-connection-token-revealed');
  await reveal.click();
  await page.waitForFunction((token) => document.querySelector('#st-conn-token')?.value !== token, FIXTURE_TOKEN, { timeout: 5000 });
  if (await input.inputValue() !== masked) {
    throw new Error('hiding the saved connection token must restore the mask');
  }
}

async function scenarioSettingsInvalid() {
  // Client-side validation with no server round-trip: the plan-enter approval
  // timeout floor (5s) rejects an under-floor value when the field commits
  // (blur / Enter), keeps it for correction, and Escape restores the
  // server-known value. The card saves each control itself — there is no
  // Save/Discard transaction to click.
  await page.goto(`${WEB_URL}/settings/sessions?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#st-card-defaults', { timeout: 10_000 });
  // The timeout input stays disabled until the plan gate is switched on.
  const gateSwitch = page.locator('#st-card-defaults [role="switch"]').nth(1);
  if ((await gateSwitch.getAttribute('aria-checked')) !== 'true') {
    await gateSwitch.click();
    await page.waitForSelector('#plan-gate-timeout:not([disabled])', { timeout: 5000 });
  }
  const timeout = page.locator('#plan-gate-timeout');
  await timeout.fill('2');
  await timeout.press('Enter');
  await page.waitForSelector('[data-field-issue]', { timeout: 5000 });
  await waitForText(S.planGateTimeoutInvalid);
  if (await timeout.inputValue() !== '2') {
    throw new Error('invalid timeout draft must remain editable after a failed commit');
  }
  await shot('settings-invalid-inline-error');
  await timeout.press('Escape');
  if (await timeout.inputValue() !== '60') {
    throw new Error('Escape must restore the server-known timeout');
  }
}

async function scenarioSettingsBrowserEditable() {
  await page.goto(`${WEB_URL}/settings/agents?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  const mainAgents = page.locator('#st-card-main-agents');
  await mainAgents.waitFor({ state: 'visible', timeout: 10_000 });
  await mainAgents.locator('[data-team-open="reviewer"]').click();
  const editor = page.locator('[data-agent-detail="reviewer"] #profile-prompt');
  await editor.waitFor({ state: 'visible', timeout: 10_000 });
  if (await editor.isDisabled()) {
    throw new Error('browser agent editor remained disabled after the server response');
  }
  await page.waitForTimeout(300);
  await shot('settings-browser-editable');
}

async function scenarioSettingsCommunication() {
  await page.goto(`${WEB_URL}/settings/general?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  const card = page.locator('#st-card-append-timing');
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  const idle = card.locator('[data-append-timing="agent_idle"]');
  const tasks = card.locator('[data-append-timing="tasks_done"]');
  if ((await idle.getAttribute('aria-pressed')) !== 'true') {
    throw new Error('default append timing must start on agent_idle');
  }
  await tasks.click();
  await page.waitForFunction(
    () => document.querySelector('[data-append-timing="tasks_done"]')?.getAttribute('aria-pressed') === 'true',
    undefined,
    { timeout: 5000 },
  );
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot('settings-communication');
  // The store is localStorage-backed and this browser context outlives the
  // scenario — restore the default so later walks queue on agent_idle again.
  await idle.click();
  await page.waitForFunction(
    () => document.querySelector('[data-append-timing="agent_idle"]')?.getAttribute('aria-pressed') === 'true',
    undefined,
    { timeout: 5000 },
  );
}

async function scenarioWorkspaces() {
  // Workspace rename + unregister over the two `settings.scenario.mjs` rows.
  await page.goto(`${WEB_URL}/settings/workspaces?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#st-card-workspaces', { timeout: 10_000 });
  await page.waitForSelector('#st-card-workspaces >> text=other', { timeout: 10_000 });
  await shot('settings-workspaces');

  // Rename the "fixture" row via its aria-label (locale-independent name) and
  // confirm the dialog + server echo update the list.
  const renameByAria = page.locator(`#st-card-workspaces [aria-label="${S.renameButton} fixture"]`);
  await renameByAria.click();
  const renameDialog = page.getByRole('dialog', { name: S.workspaceRenameTitle });
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
  await page.goto(`${WEB_URL}/settings/agents?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  // Team table + editor sheet (the full walk lives in the profile-editor scenario).
  await page.waitForSelector('#st-card-main-agents [data-team-row="agent"]', { timeout: 10_000 });
  if (!(await page.locator('[data-team-open="agent"]').textContent())?.includes('Kiki')) {
    throw new Error('the default agent must display as Kiki in the team table');
  }
  if (await page.locator('#st-card-subagent-profiles').count()) {
    throw new Error('a separate subagent list must not render on the Agents leaf');
  }
  await shot('settings-agents-main');

  const list = page.locator('#st-card-main-agents');
  await list.locator('[data-team-filter="subagent"]').click();
  await page.waitForSelector('[data-team-row="reviewer"]', { timeout: 5000 });
  if (await list.locator('[data-team-row="agent"]').count()) {
    throw new Error('the Subagent filter must hide main agents');
  }
  await shot('settings-agents-filtered');
  await list.locator('[data-team-open="reviewer"]').click();
  const prompt = page.locator('[data-agent-detail="reviewer"] #profile-prompt');
  await prompt.waitFor({ timeout: 5000 });
  await shot('settings-agents-instructions');
  const savedPrompt = await prompt.inputValue();
  await prompt.fill(`${savedPrompt}\nVisual proof unsaved draft`);
  await page.locator('[role="dialog"] [data-agent-back]').click();
  await page.waitForSelector(`text=${S.dirtyDiscard}`, { timeout: 5000 });
  await shot('settings-agents-dirty-guard');
  await page.click(`text=${S.dirtyDiscard}`);
  await page.waitForSelector('[data-profile-editor]', { state: 'detached', timeout: 5000 });

  await list.locator('[data-team-filter="all"]').click();
  await list.locator('[data-profile-new]').click();
  await page.waitForSelector('[data-agent-create]', { timeout: 5000 });
  for (const start of ['copy', 'template', 'blank']) {
    if (!(await page.locator(`[data-new-start="${start}"]`).isVisible())) throw new Error(`missing agent creation start: ${start}`);
  }
  await page.locator('[data-new-start="blank"]').click();
  await page.locator('#new-profile-name').fill('visual-proof-helper');
  await page.locator('#new-profile-description').fill('Visual proof agent');
  await page.locator('#new-profile-prompt').fill('Help the user.');
  await page.waitForTimeout(300); // let the Save button's colour transition settle
  await shot('settings-agents-new');
  await page.locator('[role="dialog"] [data-agent-back]').click();
  await page.click(`text=${S.dirtyDiscard}`).catch(() => undefined);
  await page.waitForSelector('[data-agent-create]', { state: 'detached', timeout: 5000 });
  await list.locator('[data-team-open="reviewer"]').click();
  await page.locator('[data-profile-section="advanced"] > summary').click();
  await shot('settings-agents-advanced');
  await page.locator('[role="dialog"] [data-agent-back]').click();
  await resizeViewport(390);
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflows) throw new Error('unified agents settings overflow the mobile viewport');
  await shot('settings-agents-mobile');
  await resizeViewport(1440);

  await page.locator('nav [data-settings-nav-leaf="subagents"]').click();
  await page.waitForSelector('#st-card-subagents', { timeout: 10_000 });
  await page.waitForSelector('#st-card-subagent-limits', { timeout: 10_000 });
  if (await page.locator('#st-card-subagent-profiles').count()) {
    throw new Error('Subagent rules must contain governance but not a second agent list');
  }
  await shot('settings-agents-subagent-rules');

  await page.goto(`${WEB_URL}/settings/permissions?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#st-card-reviewer', { timeout: 10_000 });
  await page.locator('#st-card-reviewer').scrollIntoViewIfNeeded();
  await shot('settings-reviewer-model');
  await page.locator('#st-card-reviewer [data-reviewer-backend-choice="jev"]').click();
  await shot('settings-reviewer-jev-consent');
  await page.locator('#st-card-reviewer input[type="checkbox"]').first().check();
  await shot('settings-reviewer-jev-ready');
  await page.locator('#st-card-reviewer').getByRole('button', { name: S.discardChanges, exact: true }).click();
  await resizeViewport(390);
  await page.locator('#st-card-reviewer').scrollIntoViewIfNeeded();
  const reviewerOverflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (reviewerOverflows) throw new Error('reviewer settings overflow the mobile viewport');
  await shot('settings-reviewer-mobile');
  await resizeViewport(1440);
}

/**
 * Shipped (built-in) profile management + the default subagent target
 * (settings-shipped scenario): the Subagent rules leaf holds the server-wide
 * default target; the unified Agents list shows the managed `general` copy's
 * modification badge and double-confirmed restore, plus the removed `plan`
 * copy's restorable tombstone. The fixture
 * flips restored entries back to clean and echoes config patches.
 */
async function scenarioSettingsShipped() {
  await page.goto(`${WEB_URL}/settings/subagents?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  // Default subagent target: unset config resolves to the engine fallback
  // (general); strict mode and any loaded subagent profile are the options.
  await page.waitForSelector('#st-card-subagent-default-target', { timeout: 10_000 });
  const targetSelect = page.locator('[data-subagent-default-target]');
  const targetTrigger = page.locator('#subagent-default-profile-select');
  await targetSelect.waitFor({ timeout: 5000 });
  await page.waitForFunction(
    () => document.querySelector('[data-subagent-default-target]')?.getAttribute('data-value') === 'general',
    undefined,
    { timeout: 5000 },
  );
  await targetTrigger.click();
  await page.locator('[role="option"]', { hasText: 'general' }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(200);
  await shot('settings-subagents-default-profile');
  await page.keyboard.press('Escape');
  await resizeViewport(390);
  const mobileOverflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (mobileOverflows) throw new Error('subagent default profile setting overflows the mobile viewport');
  await shot('settings-subagents-default-profile-mobile');
  await resizeViewport(1440);
  // Managed copies now live in the same Agents list as main agents. The
  // governance leaf retains only the server-wide default target and limits.
  await page.locator('nav [data-settings-nav-leaf="agents"]').click();
  await page.waitForSelector('#st-card-main-agents [data-team-row="general"]', { timeout: 10_000 });
  const tombstone = page.locator('#st-card-main-agents [data-shipped-removed="plan"]');
  await tombstone.waitFor({ timeout: 5000 });
  await tombstone.getByText(S.shippedBadgeRemoved, { exact: true }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(500); // let the catalog refetch settle before opening a row
  await page.locator('[data-team-open="general"]').click();
  await page.waitForSelector('[data-agent-detail="general"]', { timeout: 5000 });
  await shot('settings-subagents-shipped-open');
  const generalRow = page.locator('[data-agent-detail="general"]');
  await generalRow.locator('[data-shipped-status="custom"]').waitFor({ timeout: 5000 });
  await generalRow.getByText(S.shippedBadgeModified, { exact: true }).waitFor({ timeout: 5000 });
  await shot('settings-subagents-shipped');

  // Restore is double-confirmed and names the agent; Esc cancels safely.
  await generalRow.locator('[data-shipped-restore="general"]').click();
  const dialog = page.locator('[role="alertdialog"]');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByText(S.shippedRestoreTitle, { exact: false }).waitFor({ timeout: 5000 });
  await shot('settings-subagents-restore-confirm');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="alertdialog"]', { state: 'detached', timeout: 5000 });
  await generalRow.locator('[data-shipped-status="custom"]').waitFor({ timeout: 5000 });
  await generalRow.locator('[data-shipped-restore="general"]').click();
  await dialog.locator('button', { hasText: S.shippedRestore }).click();
  await generalRow.locator('[data-shipped-status="clean"]').waitFor({ timeout: 5000 });
  // The editor sheet affirms the restore with the shared transient ✓ Saved.
  await page.locator('[data-settings-draft-saved] [data-saved-tick]').waitFor({ timeout: 5000 });
  await generalRow.locator('[data-agent-back]').click();
  await page.waitForSelector('[data-profile-editor]', { state: 'detached', timeout: 5000 });

  await page.locator('nav [data-settings-nav-leaf="subagents"]').click();
  await page.waitForSelector('#st-card-subagent-default-target', { timeout: 5000 });
  // The default target saves on selection: strict mode stores the empty
  // string and explains itself inline.
  await page.locator('#st-card-subagent-default-target').evaluate((element) => {
    element.scrollIntoView({ block: 'start' });
  });
  await targetTrigger.click();
  await page.getByRole('option', { name: S.subagentDefaultStrict }).click();
  await page.getByText(S.subagentDefaultStrictHint, { exact: false }).waitFor({ timeout: 5000 });
  await page.waitForFunction(
    () => document.querySelector('[data-subagent-default-target]')?.getAttribute('data-value') === '__strict__',
    undefined,
    { timeout: 5000 },
  );
  await page.evaluate(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const pane = document.querySelector('[data-settings-scroll]');
    if (pane instanceof HTMLElement) pane.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  await shot('settings-subagents-default-strict');
}

/**
 * Search & retrieval leaf (nb_search domain): partial seed renders WebSearch
 * ready on exa.search and FetchURL degraded; the walker changes the default
 * lane, sets tavily's credential env NAME (never a secret value), saves the
 * replace-domain patch, and proves the echo survives reload. Diagnostics run
 * only on demand; empty + error scenarios cover fail-closed and check-failed.
 */
async function scenarioSettingsNbSearch() {
  const searchUrl = `${WEB_URL}/settings/search?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`;
  const openTab = async (tab) => {
    await page.locator(`#nb-search-tab-${tab}`).click();
  };
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#st-card-search-status', { timeout: 10_000 });
  await waitForText(S.nbSearchDegraded);
  const statusText = await page.locator('#st-card-search-status').textContent();
  if (!statusText?.includes(S.nbSearchReady) || !statusText.includes(S.nbSearchDegraded)) {
    throw new Error(`status card must show WebSearch ready + FetchURL degraded, saw "${statusText}"`);
  }
  await shot('settings-nbsearch');

  // Default lane is a radio over existing lanes only (no new lane creation).
  await openTab('search');
  const defaultsText = await page.locator('#st-card-search-defaults').textContent();
  if (!defaultsText?.includes('results · nb-search.results@1') || !defaultsText.includes('typed · example.documents@1')) {
    throw new Error(`lane outputs must show results and synthetic typed channel schemas, saw "${defaultsText}"`);
  }
  await page.locator('#st-card-search-defaults label', { hasText: 'github.repositories' })
    .locator('input[type="radio"]').click();
  // Switching subpages preserves the unsaved lane choice.
  await openTab('providers');
  const tavilyCard = page.locator('#st-card-search-providers details', { hasText: 'tavily.default' });
  const tavilyEnv = tavilyCard.locator('input[placeholder="NB_SEARCH_TAVILY_API_KEY"]');
  const loadedEnv = await tavilyEnv.inputValue();
  if (loadedEnv !== 'TEAM_TAVILY_API_KEY') {
    throw new Error(`credential env name did not load through the custom slot id, saw "${loadedEnv}"`);
  }
  await tavilyEnv.fill('NB_SEARCH_TAVILY_API_KEY');
  await tavilyCard.scrollIntoViewIfNeeded();
  await shot('settings-nbsearch-provider-edit');
  await page.locator('button', { hasText: S.nbSearchSave }).click();
  await waitForText(S.nbSearchSaved);
  await shot('settings-nbsearch-saved');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await openTab('search');
  await page.waitForSelector('#st-card-search-defaults', { timeout: 10_000 });
  const checkedLane = await page.locator('#st-card-search-defaults input[type="radio"]:checked')
    .evaluate((element) => element.closest('label')?.textContent ?? '');
  if (!checkedLane.includes('github.repositories')) {
    throw new Error(`nb_search lane choice did not survive reload, checked="${checkedLane}"`);
  }
  await openTab('providers');
  const savedEnv = await tavilyCard.locator('input[placeholder="NB_SEARCH_TAVILY_API_KEY"]').inputValue();
  if (savedEnv !== 'NB_SEARCH_TAVILY_API_KEY') {
    throw new Error(`credential env name did not survive reload, saw "${savedEnv}"`);
  }
  await shot('settings-nbsearch-reloaded');

  // The provider's credential is the shared secret field: the value the
  // fixture saved in Kiki rests masked, the eye fetches it on demand, an
  // override saves over it, and clearing falls back to the other sources.
  const exaCard = page.locator('#st-card-search-providers details', { hasText: 'exa.default' });
  if (!await exaCard.evaluate((node) => node.open)) await exaCard.locator('summary').click();
  const credential = exaCard.locator('[data-nb-search-credential="exa.default"]');
  const secretInput = credential.locator('[data-secret-field] input');
  await credential.locator('[data-secret-field][data-secret-source="kiki"]').waitFor({ timeout: 10_000 });
  await credential.getByText(S.secretSourceKiki, { exact: false }).waitFor({ timeout: 5000 });
  const reveal = credential.locator('[data-secret-reveal]');
  const masked = await secretInput.inputValue();
  if (masked === 'fixture-managed-exa-key') throw new Error('a saved credential must rest masked');
  if (await reveal.isDisabled()) throw new Error('fixture managed credential reveal is disabled after config reload');
  await reveal.click();
  await page.waitForFunction(
    () => document.querySelector('[data-nb-search-credential="exa.default"] input')?.value === 'fixture-managed-exa-key',
    undefined,
    { timeout: 5000 },
  );
  await exaCard.scrollIntoViewIfNeeded();
  await shot('settings-nbsearch-credential-revealed');
  // The eye toggles back to the mask (from the same single fetch).
  await reveal.click();
  await page.waitForFunction(
    ([selector, expected]) => document.querySelector(selector)?.value === expected,
    ['[data-nb-search-credential="exa.default"] input', masked],
    { timeout: 5000 },
  );
  // Editing saves a Kiki value that overrides the stored one.
  await credential.locator('[data-secret-edit]').click();
  await secretInput.fill('fixture-managed-exa-updated');
  await credential.getByRole('button', { name: S.save, exact: true }).click();
  await credential.locator('[data-saved-tick]').waitFor({ timeout: 5000 });
  await page.waitForFunction(
    () => document.querySelector('[data-nb-search-credential="exa.default"] input')?.value !== 'fixture-managed-exa-updated',
    undefined,
    { timeout: 5000 },
  );
  await shot('settings-nbsearch-credential-saved');
  await reveal.click();
  await page.waitForFunction(
    () => document.querySelector('[data-nb-search-credential="exa.default"] input')?.value === 'fixture-managed-exa-updated',
    undefined,
    { timeout: 5000 },
  );
  await reveal.click();
  await credential.locator('[data-secret-clear]').click();
  await credential.getByRole('button', { name: S.save, exact: true }).click();
  await credential.locator('[data-secret-field][data-secret-source="none"]').waitFor({ timeout: 5000 });
  await credential.getByText(S.secretSourceNone, { exact: false }).waitFor({ timeout: 5000 });
  if (await credential.locator('[data-secret-clear]').count() !== 0) {
    throw new Error('a cleared credential must not offer clear again');
  }
  if (!await credential.locator('[data-secret-reveal]').isDisabled()) {
    throw new Error('cleared managed credential must not remain revealable');
  }
  await shot('settings-nbsearch-credential-cleared');

  // Diagnostics are explicit: nothing runs until the button is pressed.
  await openTab('advanced');
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
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflows) throw new Error('search settings overflow the mobile viewport');
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
  await openTab('advanced');
  await page.waitForSelector('#st-card-search-diagnostics', { timeout: 10_000 });
  await page.locator('button', { hasText: S.nbSearchRunCheck }).click();
  await waitForText(S.nbSearchCheckFailed);
  const checkFailure = page.locator('#st-card-search-diagnostics').getByText(S.nbSearchCheckFailed, { exact: false });
  await checkFailure.scrollIntoViewIfNeeded();
  const failureBox = await checkFailure.boundingBox();
  const actionBarBox = await page.locator('[data-search-action-bar]').boundingBox();
  if (failureBox === null || actionBarBox === null || failureBox.y < 0
    || failureBox.y + failureBox.height > actionBarBox.y + 1) {
    throw new Error('readiness failure is clipped or covered by the search action bar');
  }
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

/** Open the sidebar Filter menu (if closed) and click an option inside it. */
async function pickFilterOption(selector) {
  if ((await page.locator('[data-filter-menu]').count()) === 0) {
    await page.click('[data-filter-menu-toggle]');
    await page.waitForSelector('[data-filter-menu]', { timeout: 5000 });
  }
  await page.click(`[data-filter-menu] ${selector}`);
}

async function closeFilterMenu() {
  if ((await page.locator('[data-filter-menu]').count()) > 0) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-filter-menu]', { state: 'detached', timeout: 5000 });
    await page.waitForTimeout(150);
  }
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
  await pickFilterOption('[data-workspace-filter="wd_fixture_000000000001"]');
  await closeFilterMenu();
  await page.waitForFunction(
    () => {
      // The title row also carries the trailing [data-session-time]; compare
      // the title alone.
      const titles = Array.from(document.querySelectorAll('aside [data-session-title]')).map((n) => {
        const text = n.textContent ?? '';
        return text.slice(0, text.length - (n.querySelector('[data-session-time]')?.textContent ?? '').length);
      });
      return titles.includes('Fixture: ws-b beta') && !titles.includes('Fixture: ws-a alpha');
    },
    undefined,
    { timeout: 5000 },
  );
  await page.waitForSelector('[data-sidebar-filter-chip="ws"]', { timeout: 5000 });
  await shot('sidebar-workspace-filter');

  // The chip's × is the shortest way back to every workspace.
  await page.click('[data-sidebar-filter-clear="ws"]');
  await page.waitForFunction(
    () => {
      // The title row also carries the trailing [data-session-time]; compare
      // the title alone.
      const titles = Array.from(document.querySelectorAll('aside [data-session-title]')).map((n) => {
        const text = n.textContent ?? '';
        return text.slice(0, text.length - (n.querySelector('[data-session-time]')?.textContent ?? '').length);
      });
      return titles.includes('Fixture: ws-a pinned') && titles.includes('Fixture: ws-a alpha');
    },
    undefined,
    { timeout: 5000 },
  );
  await shot('sidebar-pinned-group');

  // Group by None: one flat list, no group headings.
  await pickViewOption('[data-group-by="none"]');
  await closeViewMenu();
  await page.waitForFunction(
    () => document.querySelectorAll('aside [data-session-group]').length <= 1,
    undefined,
    { timeout: 5000 },
  );
  await shot('sidebar-group-none');
  await pickViewOption('[data-group-by="time"]');
  await closeViewMenu();

  // Status + archived filters compose into persisted chips that stay visible.
  await pickFilterOption('[data-status-filter="idle"]');
  await pickFilterOption('[data-archived-filter="include"]');
  await closeFilterMenu();
  await page.waitForSelector('[data-sidebar-filter-chip="status"]', { timeout: 5000 });
  await page.waitForSelector('[data-sidebar-filter-chip="archived"]', { timeout: 5000 });
  const storedFilters = await page.evaluate(() => JSON.parse(localStorage.getItem('kiki.layout') ?? '{}')?.filters);
  if (storedFilters?.status?.[0] !== 'idle' || storedFilters?.archived !== 'include') {
    throw new Error(`filters were not persisted: ${JSON.stringify(storedFilters)}`);
  }
  await shot('sidebar-filter-chips');
  await page.click('[data-sidebar-filters-clear-all]');
  await page.waitForSelector('[data-sidebar-filter-chip]', { state: 'detached', timeout: 5000 });
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

    await page.goto(`${WEB_URL}/settings?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector(`text=${S.settings}`, { timeout: 10_000 });
    await page.waitForTimeout(400);
    await shot(`responsive-settings-${width}`);

    // Return to the session for the next width iteration.
    await page.goto(`${WEB_URL}/?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
      waitUntil: 'domcontentloaded',
    });
  }
}

/**
 * Queue rows rest as one summary line tucked behind the composer and keep
 * their actions in a hover-revealed group: open the strip when it is folded,
 * then point at the row the way a user would before reaching its action.
 */
async function queueRowAction(row, label) {
  await openQueueStrip();
  await row.hover();
  return row.locator(`button[aria-label="${label}"]`);
}

/** The queue's rows grow inside the composer card: open them from the row. */
async function openQueueStrip() {
  const tab = page.locator('[data-composer-header] [data-header-toggle="queue"]');
  if ((await tab.getAttribute('aria-expanded')) !== 'true') await tab.click();
  await page.locator('[data-queue-strip]').waitFor({ state: 'visible', timeout: 5000 });
  // Let the detail's rise land before a row is hovered or shot.
  await page.waitForTimeout(500);
}

/** The goal's detail grows inside the composer card: open it from the row. */
async function openGoalDrawer() {
  const tab = page.locator('[data-composer-header] [data-header-toggle="goal"]');
  await tab.waitFor({ timeout: 10_000 });
  if ((await tab.getAttribute('aria-expanded')) !== 'true') await tab.click();
  await page.locator('[data-goal-card]').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(500);
}

async function scenarioQueue() {
  await selectSession('Fixture: queue');
  await sendPrompt('A: hold the floor.');
  await waitForText('A holds the floor.');
  // The busy composer keeps a mouse path to the queue: fill, then click Send.
  await page.fill('textarea', 'B: wait your turn.');
  await page.click(`button[aria-label="${S.queuePromptAria}"]`);
  console.log('[flow] queued via the busy Send button');
  // The parked prompt surfaces in the queue bar only — the transcript stays
  // clean until the prompt actually starts running.
  await page.waitForSelector(`text=${S.onePromptQueued}`, { timeout: 10_000 });
  const bBlocks = page.locator('[role="log"] [data-block-id^="user-"]', { hasText: 'B: wait your turn.' });
  if ((await bBlocks.count()) !== 0) {
    throw new Error(`queued prompt leaked into the transcript: ${await bBlocks.count()} block(s)`);
  }
  await shot('queue-queued');
  // Release A → B promotes to running: its user block lands in the transcript
  // exactly once and the queue bar clears.
  await control({ action: 'release', session_id: 'session_fixture_queue' });
  await waitForText('B runs after A.');
  await bBlocks.waitFor({ timeout: 10_000 });
  if ((await bBlocks.count()) !== 1) {
    const ids = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="log"] [data-block-id]')).map((n) => n.getAttribute('data-block-id')),
    );
    console.log('[debug] block ids at promotion:', JSON.stringify(ids));
    throw new Error(`B user block duplicated after promotion: ${await bBlocks.count()}`);
  }
  if ((await page.locator(`text=${S.queueBarPattern}`).count()) !== 0) throw new Error('queue bar still visible after promotion');
  await shot('queue-promoted');
  // Removing a parked prompt leaves no transcript trace at all: it never
  // started, so there is no user block and no aborted marker.
  await sendPrompt('A: hold the floor.', 'queue');
  await page.waitForSelector(`text=${S.working}`, { timeout: 10_000 });
  await sendPrompt('B: cancel me.', 'queue');
  await page.waitForSelector(`text=${S.onePromptQueued}`, { timeout: 10_000 });
  const cancelRow = page.locator('[data-queue-strip] li', { hasText: 'B: cancel me.' });
  await (await queueRowAction(cancelRow, S.removeQueued)).click();
  await cancelRow.locator(`button[aria-label="${S.queueRemoveConfirm}"]`).click();
  await page.waitForSelector('[data-queue-strip]', { state: 'detached', timeout: 10_000 });
  if ((await page.locator('[role="log"] [data-block-id^="user-"]', { hasText: 'B: cancel me.' }).count()) !== 0) {
    const ids = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="log"] [data-block-id]')).map((n) => n.getAttribute('data-block-id')),
    );
    console.log('[debug] block ids at removal leak:', JSON.stringify(ids));
    throw new Error('removed queued prompt leaked into the transcript');
  }
  if ((await page.locator(`text=${S.queueBarPattern}`).count()) !== 0) {
    throw new Error('queue bar survived the removal');
  }
  await shot('queue-cancelled');
  await control({ action: 'release', session_id: 'session_fixture_queue' });
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 10_000 }).catch(() => undefined);

  // Queue strip: two parked prompts render as ordered rows above the composer.
  await sendPrompt('A: hold the floor.', 'queue');
  await page.waitForSelector(`text=${S.working}`, { timeout: 10_000 });
  await sendPrompt('B: steer me in.', 'queue');
  // Back-to-back queueing must wait out the previous send's draft clear,
  // otherwise the next fill is wiped before Enter fires.
  await page.waitForSelector('[data-composer-header] [data-header-toggle="queue"]', { state: 'attached', timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('textarea')?.value === '');
  await sendPrompt('C: clear me out.', 'queue');
  await page.waitForSelector(`text=${S.twoPromptsQueued}`, { timeout: 10_000 });
  await openQueueStrip();
  const strip = page.locator('[data-queue-strip]');
  if ((await strip.locator('li').count()) !== 2) {
    throw new Error(`expected 2 queue-strip rows, saw ${await strip.locator('li').count()}`);
  }
  // At rest the queue is text in the composer's top row ("2 queued");
  // its rows expand inside the card and collapse again on Escape.
  const queueTab = page.locator('[data-composer-header] [data-header-toggle="queue"]');
  // The detail stays as the user left it (the cancel step above opened it);
  // Escape from its half collapses it back to the resting row.
  if ((await queueTab.getAttribute('aria-expanded')) === 'true') {
    await queueTab.focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
  if ((await queueTab.getAttribute('aria-expanded')) !== 'false') {
    throw new Error('queue detail did not default to collapsed');
  }
  if (!((await queueTab.innerText()).includes(S.twoPromptsQueued))) {
    throw new Error('composer row does not carry the queue count');
  }
  await page.waitForTimeout(400);
  await shot('queue-collapsed');
  await openQueueStrip();
  if ((await queueTab.getAttribute('aria-expanded')) !== 'true') {
    throw new Error('queue half did not expand its rows');
  }
  if ((await strip.locator('li:visible').count()) !== 2) {
    throw new Error('expanded queue detail hid its rows');
  }
  // Let the rows' anim-enter fade finish before the shot.
  await page.waitForTimeout(600);
  await shot('queue-two-rows');

  // Edit round-trip: the row's Edit parks its text in the composer (banner +
  // confirm icon + row badge), Enter replaces the prompt AT ITS SLOT.
  await (await queueRowAction(strip.locator('li', { hasText: 'C: clear me out.' }), S.queueEditRowAria)).click();
  await page.waitForFunction(() => document.querySelector('textarea')?.value === 'C: clear me out.');
  await page.waitForSelector(`text=${S.queueEditBanner}`, { timeout: 5000 });
  if ((await page.locator(`button[aria-label="${S.queueEditConfirmAria}"]`).count()) !== 1) {
    throw new Error('composer send button did not switch to the queue-edit confirm');
  }
  if ((await strip.locator('li [data-queue-edit-status]').count()) !== 1) {
    throw new Error('edited row did not pick up its editing status');
  }
  // Edit hold: C (#2) is edited, so B (#1, ahead) still sends as usual and
  // the notice says so; nothing sits behind C.
  if ((await strip.locator('[data-queue-hold-notice]').count()) !== 1) {
    throw new Error('queue detail did not explain the edit hold');
  }
  if ((await strip.locator('[data-queue-waits-hint]').count()) !== 0) {
    throw new Error('a row ahead of the edit was marked as waiting');
  }
  // The banner and badge mount with anim-enter — let the fade land.
  await page.waitForTimeout(300);
  await shot('queue-edit-roundtrip');
  await page.fill('textarea', 'C: clear me out. (edited)');
  await page.press('textarea', 'Control+Enter');
  await page.waitForSelector('[data-queue-edit-banner]', { state: 'detached', timeout: 10_000 });
  // Confirmed: the composer hands the pre-edit draft back (empty here)…
  await page.waitForFunction(() => document.querySelector('textarea')?.value === '');
  // …and the row keeps its #2 slot with the new text — no requeue to the tail.
  await page.waitForFunction(
    (expected) => {
      const rows = Array.from(document.querySelectorAll('[data-queue-strip] ol > li:not([aria-hidden])'));
      return rows.length === 2 && rows[1]?.textContent?.includes(expected) === true;
    },
    'C: clear me out. (edited)',
    { timeout: 10_000 },
  );
  await shot('queue-edit-confirmed');

  // Keyboard reorder: focus C's drag handle, ArrowUp moves it above B. The
  // strip repaints from the server's post-move order (prompt.moved).
  const rowTexts = async () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-queue-strip] ol > li:not([aria-hidden])')).map(
        (row) => row.textContent ?? '',
      ),
    );
  await strip.locator('li', { hasText: 'C: clear me out. (edited)' })
    .locator(`button[aria-label="${S.queueDragHandleAria}"]`)
    .press('ArrowUp');
  await page.waitForFunction(
    (expected) => {
      const rows = Array.from(document.querySelectorAll('[data-queue-strip] ol > li:not([aria-hidden])'));
      return rows.length === 2 && rows[0]?.textContent?.includes(expected) === true;
    },
    'C: clear me out. (edited)',
    { timeout: 10_000 },
  );
  if (!((await rowTexts())[1] ?? '').includes('B: steer me in.')) {
    throw new Error('keyboard reorder did not land B below C');
  }
  // Reordering moves the DOM rows, which replays their anim-enter fade — let
  // it finish before the shot.
  await page.waitForTimeout(600);
  await shot('queue-reordered');

  // Send now (wire steer): B leaves the queue immediately while A keeps
  // running; the strip drops to one row and B's user block lands in the
  // transcript. C stays parked without any transcript trace.
  await (await queueRowAction(strip.locator('li', { hasText: 'B: steer me in.' }), S.sendNow)).click();
  await page.waitForSelector(`text=${S.onePromptQueued}`, { timeout: 10_000 });
  if ((await strip.locator('li').count()) !== 1) throw new Error('steered prompt stayed in the strip');
  const steeredBlock = page.locator('[role="log"] [data-block-id^="user-"]', { hasText: 'B: steer me in.' });
  await steeredBlock.waitFor({ timeout: 10_000 });
  if ((await steeredBlock.count()) !== 1) throw new Error('steered prompt landed in the transcript twice');
  const parkedBlock = page.locator('[role="log"] [data-block-id^="user-"]', { hasText: 'C: clear me out. (edited)' });
  if ((await parkedBlock.count()) !== 0) {
    throw new Error('still-queued prompt leaked into the transcript');
  }
  await shot('queue-steered');

  // Clear all empties the queue: confirm the dialog, then the strip and the
  // bar disappear; the cleared prompt never touches the transcript.
  await openQueueStrip();
  await page.getByRole('button', { name: S.clearQueue }).click();
  const clearDialog = page.getByRole('alertdialog', { name: S.queueClearTitle });
  await clearDialog.waitFor({ timeout: 5000 });
  await clearDialog.getByRole('button', { name: S.clearQueue }).click();
  await page.waitForSelector('[data-queue-strip]', { state: 'detached', timeout: 10_000 });
  if ((await page.locator(`text=${S.queueBarPattern}`).count()) !== 0) {
    throw new Error('queue bar survived Clear all');
  }
  if ((await parkedBlock.count()) !== 0) {
    throw new Error('cleared queued prompt leaked into the transcript');
  }
  await shot('queue-cleared');

  // Two-step remove: the first click only arms the row's Remove ("Remove?"),
  // the second actually drops the parked prompt.
  await sendPrompt('B: remove me.', 'queue');
  await page.waitForSelector('[data-composer-header] [data-header-toggle="queue"]', { state: 'attached', timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('textarea')?.value === '');
  await sendPrompt('C: remove me too.', 'queue');
  await page.waitForSelector(`text=${S.twoPromptsQueued}`, { timeout: 10_000 });
  const removeRow = strip.locator('li', { hasText: 'B: remove me.' });
  await (await queueRowAction(removeRow, S.removeQueued)).click();
  // Armed, not executed: both rows are still there and the button now asks.
  await page.waitForSelector(`button[aria-label="${S.queueRemoveConfirm}"]`, { timeout: 5000 });
  if ((await strip.locator('li').count()) !== 2) {
    throw new Error('an armed (not confirmed) Remove dropped the row');
  }
  // The hover-revealed action group fades in (transition-opacity) — let it land.
  await page.waitForTimeout(300);
  await shot('queue-remove-armed');
  await removeRow.locator(`button[aria-label="${S.queueRemoveConfirm}"]`).click();
  await page.waitForSelector(`text=${S.onePromptQueued}`, { timeout: 10_000 });
  if ((await strip.locator('li').count()) !== 1) {
    throw new Error('confirmed Remove did not drop the row');
  }
  if ((await strip.locator('li', { hasText: 'B: remove me.' }).count()) !== 0) {
    throw new Error('removed row is still in the strip');
  }
  await shot('queue-remove-confirmed');
  // Leave the session clean: clear the leftover row, then release the floor.
  await openQueueStrip();
  await page.getByRole('button', { name: S.clearQueue }).click();
  const tailClearDialog = page.getByRole('alertdialog', { name: S.queueClearTitle });
  await tailClearDialog.waitFor({ timeout: 5000 });
  await tailClearDialog.getByRole('button', { name: S.clearQueue }).click();
  await page.waitForSelector('[data-queue-strip]', { state: 'detached', timeout: 10_000 });
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
  await page.press('textarea', 'Control+Enter');
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
  // Ctrl+Enter is the product's busy-state "send now" shortcut: it steers
  // the prompt into A instead of leaving it in the queue. Use the ordinary
  // busy-state send button so this walk exercises queue → promotion.
  await page.getByRole('button', { name: S.queuePromptAria }).click();
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
  // after the storm, so B deterministically lands in the server queue). A
  // queued prompt shows in the strip only — never in the transcript.
  const queueToggle = page.locator('[data-composer-header] [data-header-toggle="queue"]');
  try {
    await queueToggle.waitFor({ state: 'attached', timeout: 30_000 });
  } catch (error) {
    const ids = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="log"] [data-block-id]')).map((n) => n.getAttribute('data-block-id')),
    );
    console.log('[debug] block ids at chip timeout:', JSON.stringify(ids));
    throw error;
  }
  await shot('burst-queued');
  // Let A finish; B must leave the queue through promotion before its script
  // emits the reply. This distinguishes a real queue drain from a missing B.
  await control({ action: 'release', session_id: 'session_fixture_burst' });
  await waitForText('Burst survived — the composer stayed responsive.', 90_000);
  await queueToggle.waitFor({ state: 'detached', timeout: 30_000 });
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
    `${WEB_URL}/s/session_fixture_subagents_burst/agent/agent-hidden?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`,
    { waitUntil: 'domcontentloaded' },
  );
  // The subagent note is a header tooltip now; wait on the workspace itself.
  await page.waitForSelector('[data-agent-workspace-target="agent-hidden"] [data-transcript-scroll]', { timeout: 15_000 });
  await page.waitForSelector('[data-composer-variant="subagent"]', { timeout: 15_000 });
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
  await page.route('**/api/klient/session-view/*/snapshot**', async (route) => {
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
  await page.unroute('**/api/klient/session-view/*/snapshot**');
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
  // The folded row names the reminder by its first readable line; the rest of
  // the body is rendered only once the row is opened.
  const firstLine = await reminders.first().innerText();
  if (!firstLine.includes('The same tool call has been repeated')) {
    throw new Error(`collapsed reminder must name its first line, saw "${firstLine}"`);
  }
  if ((await page.locator('text=Before making your next call').count()) !== 0) {
    throw new Error('collapsed reminder content rendered before expansion');
  }
  await shot('reminder-collapsed');
  await reminders.first().click();
  await waitForText('Before making your next call');
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
  // Both notification shapes stay inline as their own rows (no history run),
  // each with its body collapsed until opened.
  if (await page.locator('[role="log"] [data-history-run]').count() !== 0) {
    throw new Error('task notifications were folded behind a history run');
  }
  const systemRows = page.locator('[role="log"] [data-system="task"]');
  if ((await systemRows.count()) !== 2) {
    throw new Error(`expected 2 retained task notifications, saw ${await systemRows.count()}`);
  }
  if ((await page.locator('text=pnpm test — 42 passed').count()) !== 0) {
    throw new Error('collapsed notification body rendered before expansion');
  }
  await shot('task-notified-collapsed');
  await systemRows.first().locator('[data-activity-toggle]').first().click();
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
  // cron + compaction + goal continuation are system rows; a non-slash skill
  // activation is its own left-lane row. All four stay collapsed (bodies
  // hidden until expanded).
  const systemRows = page.locator('[role="log"] [data-block-id^="system-"]');
  if ((await systemRows.count()) !== 3) {
    throw new Error(`expected 3 system rows, saw ${await systemRows.count()}`);
  }
  const skillRows = page.locator('[role="log"] [data-block-id^="skill-"]');
  if ((await skillRows.count()) !== 1) {
    throw new Error(`expected 1 skill row, saw ${await skillRows.count()}`);
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
  // Escape arbitration: the first Escape closes the open rail drawer; the
  // subsequent Escape reaches the session controller to abort mid-stream.
  const rail = page.locator('[data-session-rail]');
  if ((await rail.count()) > 0 && (await rail.isVisible())) {
    await page.keyboard.press('Escape');
    await rail.waitFor({ state: 'detached', timeout: 5000 });
  }
  await page.keyboard.press('Escape'); // abort mid-stream
  await page.waitForSelector(`text=${S.promptAborted}`, { timeout: 10_000 });
  // The latest turn's stop reads as ONE line: the cancelled turn tail
  // ("Stopped by you · Resume"). The inline assistant "Stopped" mark is kept
  // for older stopped turns only, so it must not repeat the tail here.
  const stoppedTail = page.locator('[data-turn-tail-state="cancelled"]');
  if ((await stoppedTail.count()) !== 1) {
    throw new Error(`expected 1 cancelled turn tail, saw ${await stoppedTail.count()}`);
  }
  await stoppedTail.locator('[data-turn-tail-resume]').waitFor({ timeout: 5000 });
  const stoppedMark = page.locator('[data-block-id^="agent-frame-"], [data-block-id^="assistant-"]', { hasText: S.stopped });
  if ((await stoppedMark.count()) !== 0) {
    throw new Error(`the cancelled tail already states the stop; saw ${await stoppedMark.count()} inline Stopped marks`);
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
  // The same approval ID unblocks the child; its resolved fact remains inline
  // as a history line and no pending controls survive.
  await card.waitFor({ state: 'detached', timeout: 10_000 });
  await waitForText('The gated cleanup finished.');
  const revealResolvedApproval = async () => {
    // Resolved approvals render in place — nothing to unfold first.
    const line = page.locator('[data-history-line]', { hasText: S.approved }).first();
    await line.waitFor({ timeout: 10_000 });
    return line;
  };
  await revealResolvedApproval();
  if (await page.locator('[data-approval-id="approval_fixture_child"]').count() !== 0) throw new Error('resolved child approval still exposes pending actions');
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 20_000 });
  // Focusing the child retains that same archived approval, without pending actions.
  // Subagent panels open as preview-workspace tabs by default — no route change.
  const childCard = page.locator('[data-subagent-id="agent-worker"]');
  const childRail = page.locator('[data-agent-id="agent-worker"]');
  if (await childCard.count() > 0) {
    await childCard.click();
  } else {
    await openInspector();
    await childRail.waitFor({ timeout: 10_000 });
    await childRail.click();
  }
  await page.locator('[data-preview-tabpanel="panel:agent-worker"]').waitFor({ timeout: 10_000 });
  await revealResolvedApproval();
  if (await page.locator('[data-approval-id="approval_fixture_child"]').count() !== 0) throw new Error('resolved child approval still exposes pending actions');
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
  await page.press('textarea', 'Control+Enter');
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
      .getAttribute('aria-checked');
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
  await page.press('textarea', 'Control+Enter');
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
  await page.press('textarea', 'Control+Enter');
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
    await page.waitForTimeout(300); // let the pill entrance animation settle
  };
  // Unsent notes fold into ONE pill; its panel lists them one row each.
  const notesPill = page.locator('[data-composer-notes-pill]');
  const noteRows = page.locator('[data-composer-note]');
  const openNotesPanel = async () => {
    await page.waitForSelector('[data-composer-notes-pill]', { timeout: 5000 });
    await notesPill.click();
    await page.waitForSelector('[data-composer-notes-panel]', { timeout: 5000 });
  };
  // A second click on the pill closes the pinned panel again, so the panel
  // never sits between the pointer and the transcript selection popover.
  const closeNotesPanel = async () => {
    await notesPill.click();
    await page.waitForSelector('[data-composer-notes-panel]', { state: 'detached', timeout: 5000 });
  };

  // A1: the popover offers both actions above the selection.
  await selectFragment(FRAGMENT_A);
  await page.waitForTimeout(300); // let the popover entrance animation settle
  const pillText = await page.locator('[data-selection-quote]').innerText();
  if (!pillText.includes(S.quoteAction) || !pillText.includes(S.annotateAction)) {
    throw new Error(`selection popover missing an action: ${pillText}`);
  }
  await shot('selection-annotate-actions');

  // A2: annotate opens the in-place comment input; the note lands in the
  // composer's single notes pill, which lists it in its panel.
  await page.click('[data-selection-annotate-action]');
  await page.waitForSelector('[data-selection-annotate-input]', { timeout: 5000 });
  await shot('selection-annotate-input');
  await page.fill('[data-selection-annotate-input]', COMMENT_A);
  await page.press('[data-selection-annotate-input]', 'Enter');
  await page.waitForSelector('[data-composer-notes-pill]', { timeout: 5000 });
  const oneNotePill = (await notesPill.innerText()).trim();
  if (oneNotePill !== S.notesPillOne) {
    throw new Error(`notes pill should read the one-note count, saw ${oneNotePill}`);
  }
  await openNotesPanel();
  if ((await noteRows.count()) !== 1) throw new Error('first note missing from the notes panel');
  const firstRow = await noteRows.nth(0).innerText();
  if (!firstRow.includes(COMMENT_A) || !firstRow.includes(FRAGMENT_A)) {
    throw new Error(`notes panel row does not name its note: ${firstRow}`);
  }
  await shot('selection-annotate-note-panel');
  await closeNotesPanel();

  // A3: notes accumulate — a second selection keeps the one pill and adds a row.
  await annotate(FRAGMENT_B, COMMENT_B);
  const twoNotePill = (await notesPill.innerText()).trim();
  if (twoNotePill !== S.notesPillTwo) {
    throw new Error(`notes did not accumulate in the pill: ${twoNotePill}`);
  }
  await openNotesPanel();
  if ((await noteRows.count()) !== 2) {
    throw new Error(`notes did not accumulate: ${await noteRows.count()}`);
  }
  await shot('selection-annotate-notes');

  // A4: notes are individually removable; the other one stays.
  await noteRows.nth(1).getByRole('button', { name: S.removeAnnotation }).click();
  if ((await noteRows.count()) !== 1) throw new Error('note was not removable');
  const remaining = await noteRows.nth(0).innerText();
  if (!remaining.includes(COMMENT_A)) throw new Error(`wrong note survived removal: ${remaining}`);
  await closeNotesPanel();
  await annotate(FRAGMENT_B, COMMENT_B);
  await openNotesPanel();
  if ((await noteRows.count()) !== 2) throw new Error('re-annotation did not restore the note');
  await closeNotesPanel();

  // A5: the quote action still lands its own chip beside the notes.
  await selectFragment(QUOTE);
  await page.locator('[data-selection-quote] button', { hasText: S.quoteAction }).click();
  await page.waitForSelector('[data-quote-chip]', { timeout: 5000 });
  if ((await notesPill.innerText()).trim() !== S.notesPillTwo) {
    throw new Error('quote replaced the annotations');
  }
  await page.waitForTimeout(300); // let the chip entrance animation settle
  await shot('selection-annotate-quote-chip');

  // A6: send — the wire text carries annotation segments, then the quote
  // blockquote, then the typed text.
  await page.click('textarea');
  await page.type('textarea', TYPED);
  await page.press('textarea', 'Control+Enter');
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
  // Collapsing hides the panel in place (mounted editors keep their buffers);
  // the header toggle brings it back.
  await page.getByRole('button', { name: S.previewCollapse }).click();
  await page.waitForSelector('[data-preview-workspace][hidden]', { state: 'attached', timeout: 5000 });
  if (await page.locator('[data-preview-workspace]').isVisible()) {
    throw new Error('collapsed preview workspace is still visible');
  }
  await page.locator('[data-preview-toggle]').click();
  await page.waitForSelector('[data-preview-workspace]', { state: 'visible', timeout: 5000 });
  await shot('preview-workbench-reopened');

  await page.getByRole('link', { name: 'taskService.ts:1063', exact: true }).click();
  const taskPanel = '[data-preview-tabpanel="C:/fixture/workshop/src/taskService.ts"]';
  await page.waitForSelector(`${taskPanel} .cm-content`, { timeout: 10_000 });
  await page.waitForFunction((selector) => {
    const panel = document.querySelector(selector);
    const scroller = panel?.querySelector('.cm-scroller');
    const line = [...(panel?.querySelectorAll('.cm-line') ?? [])]
      .find((item) => item.textContent.includes('citation-line-1063'));
    if (!scroller || !line) return false;
    const viewport = scroller.getBoundingClientRect();
    const bounds = line.getBoundingClientRect();
    return scroller.scrollTop > 0 && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
  }, taskPanel);
  await shot('preview-workbench-citation-1063');
  await page.getByRole('link', { name: 'taskService.ts:4', exact: true }).click();
  await page.waitForFunction((selector) => {
    const panel = document.querySelector(selector);
    const scroller = panel?.querySelector('.cm-scroller');
    const line = [...(panel?.querySelectorAll('.cm-line') ?? [])]
      .find((item) => item.textContent === 'export const task4 = 4;');
    if (!scroller || !line) return false;
    const viewport = scroller.getBoundingClientRect();
    const bounds = line.getBoundingClientRect();
    return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
  }, taskPanel);
  if (await page.locator('[data-preview-tab="C:/fixture/workshop/src/taskService.ts"]').count() !== 1) {
    throw new Error('citation navigation created duplicate tabs');
  }
  await shot('preview-workbench-citation-revisit');
}

/**
 * The sidebar search field is collapsed behind the header's search icon
 * ([data-search-toggle]); open it (if closed) before typing into it.
 */
async function fillSidebarSearch(text) {
  if ((await page.locator('[data-search-box]').count()) === 0) {
    await page.click('[data-search-toggle]');
    await page.waitForSelector('[data-search-box]', { timeout: 5000 });
  }
  await page.fill('[data-search-box]', text);
}

async function scenarioSearch() {
  // Open a session first so the main panel is not sitting on the previous
  // scenario's (stale) lastSessionId redirect.
  await selectSession('Fixture: search gamma');
  await page.waitForSelector('text=Fixture: search alpha', { timeout: 10_000 });
  await fillSidebarSearch('persimmon');
  await page.waitForSelector('text=rotate the persimmon cache', { timeout: 5000 });
  await page.waitForTimeout(300);
  await shot('search-results');
  // Messages group: every content hit names its session; both fixture
  // sessions with persimmon hits appear.
  const hitSessions = await page.evaluate(() =>
    [...new Set(Array.from(document.querySelectorAll('[data-search-messages] [data-search-result]'))
      .map((row) => row.textContent ?? '')
      .flatMap((text) => (text.match(/Fixture: search \w+/) ?? [])))]);
  if (hitSessions.length !== 2) throw new Error(`expected hits from 2 sessions, saw ${JSON.stringify(hitSessions)}`);
  // Highlighted terms render as <mark>.
  if ((await page.locator('[data-search-messages] mark').count()) === 0) throw new Error('content hits carry no highlight');

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
  // Local layer: a title match is instant (no network) and keyboard-driven.
  await fillSidebarSearch('gamma');
  await page.waitForSelector('[data-search-result^="s:"]', { timeout: 2000 });
  await shot('search-local');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/s\/session_fixture_search_c/, { timeout: 5000 });

  // Workspace filter scopes the content layer: exactly one workspace sends
  // workspace_id on the /search body, and the chip stays visible.
  await pickFilterOption('[data-workspace-filter="wd_fixture_000000000000"]');
  await closeFilterMenu();
  await fillSidebarSearch('persimmon');
  await page.waitForSelector('[data-search-messages] [data-search-result]', { timeout: 5000 });
  await page.waitForSelector('[data-sidebar-filter-chip="ws"]', { timeout: 2000 });
  await page.waitForSelector('[data-search-scope]', { timeout: 2000 });
  const scoped = await control({ action: 'state' });
  if (scoped.data?.last_search?.workspace_id !== 'wd_fixture_000000000000') {
    throw new Error(`scoped search did not send workspace_id: ${JSON.stringify(scoped.data?.last_search)}`);
  }
  await shot('search-scoped');
  await page.click('[data-sidebar-filter-clear="ws"]');

  // Empty state; Esc clears the query.
  await fillSidebarSearch('zzzznothing');
  await page.waitForSelector('text=Nothing matches', { timeout: 5000 });
  await shot('search-empty');
  await page.focus('[data-search-box]');
  await page.keyboard.press('Escape');
  if ((await page.inputValue('[data-search-box]')) !== '') throw new Error('Esc did not clear the search');
}

/**
 * /usage V2 dashboard (§15.3): today's default, explicit all-history selection,
 * the cost/tokens KPIs, and the three-axis filter bar driving
 * the URL, the 5h rhythm granularity with a bucket drilldown into
 * session/turn ids, the agent dimension's parent/child breakdown tree, the
 * always-visible data-reliability card, and the 390px mobile layout.
 */
async function scenarioUsageDashboard() {
  const usageUrl = (query) =>
    `${WEB_URL}/usage${query === '' ? '' : `?${query}&`}${query === '' ? '?' : ''}server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`;

  // 1. A plain visit starts today; all-history remains an explicit choice.
  //    The partially-unknown cost chip comes from the seeded `mystery-9` model.
  await page.goto(usageUrl(''), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`text=${S.usageEstimatedCost}`, { timeout: 15_000 });
  await page.waitForSelector('[data-axis="range"] [data-axis-value="today"][aria-pressed="true"]', { timeout: 10_000 });
  await page.waitForSelector(`text=${S.usagePartial}`, { timeout: 10_000 });
  await page.waitForSelector('text=mystery-9', { timeout: 10_000 });
  await page.waitForSelector('[data-usage-trend]', { timeout: 10_000 });
  await page.waitForTimeout(500);
  await shot('usage-today');
  await page.locator('[data-axis="range"] [data-axis-value="all"]').click();
  await page.waitForSelector(`text=${S.usageAllHistory}`, { timeout: 10_000 });
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

  // 6. Workspace breakdown over a week (names resolve from the registry), the
  //    cache-hit trend metric, and the 820px + dark-theme passes.
  await resizeViewport(1440);
  await page.goto(usageUrl('range=last_7_days&dimension=project&view=breakdown'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-usage-breakdown-row="wd_docs_site_000000000000"]', { timeout: 15_000 });
  const projectText = await page.locator('[data-usage-breakdown-row="wd_docs_site_000000000000"]').innerText();
  if (!projectText.includes('docs-site')) throw new Error(`workspace breakdown shows no workspace name: ${projectText}`);
  await page.waitForTimeout(300);
  await shot('usage-breakdown-workspace');
  await page.goto(usageUrl('range=last_7_days'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-usage-trend]', { timeout: 15_000 });
  await page.locator('[data-trend-metric="cache"]').click();
  await page.waitForTimeout(300);
  await shot('usage-week-cache');
  await page.locator('[data-trend-metric="cost"]').click();
  await page.locator('[data-usage-trend] [data-bucket]').nth(3).click();
  await page.waitForSelector('[data-usage-drilldown]', { timeout: 5000 });
  await page.waitForTimeout(300);
  await shot('usage-week-drilldown');
  await resizeViewport(820);
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await page.waitForTimeout(300);
  const overflow820 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow820 > 1) throw new Error(`820px usage layout overflows by ${overflow820}px`);
  await shot('usage-week-820');
  await setProofTheme('dark');
  await shot('usage-week-820-dark');
  await resizeViewport(1440);
  await shot('usage-week-dark');
  await setProofTheme('light');
}

/** Flip the stored theme preference and wait for `<html data-theme>`. */
async function setProofTheme(theme) {
  await page.evaluate((next) => {
    const raw = localStorage.getItem('kiki.settings');
    const settings = raw === null ? {} : JSON.parse(raw);
    localStorage.setItem('kiki.settings', JSON.stringify({ ...settings, theme: next }));
  }, theme);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction((next) => document.documentElement.dataset['theme'] === next, theme, { timeout: 10_000 });
  await page.waitForTimeout(900);
}

/**
 * /board and /cron across both scopes: all workspaces (every row tagged)
 * and one workspace (filtered, scope control shows it), at 1440 and 820 in
 * both themes. Switching the scope must land in the URL.
 */
async function scenarioWorkspaceTools() {
  const pageUrl = (path) => `${WEB_URL}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`;

  await page.goto(pageUrl('/cron'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-cron-section="active"] [data-cron-task]', { timeout: 15_000 });
  const allRows = await page.locator('[data-cron-task]').count();
  if (allRows !== 5) throw new Error(`cron all-scope expected 5 rows, got ${allRows}`);
  if (await page.locator('[data-scope-option="all"][aria-pressed="true"]').count() !== 1) throw new Error('cron all-scope not pressed');
  await page.waitForTimeout(300);
  await shot('cron-all');
  await page.locator('[data-scope-option="wd_docs_site_000000000000"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-cron-task]').length === 2, null, { timeout: 5000 });
  if (!page.url().includes('workspace=wd_docs_site_000000000000')) throw new Error(`cron scope not in URL: ${page.url()}`);
  await page.waitForTimeout(300);
  await shot('cron-workspace');
  await resizeViewport(820);
  await shot('cron-workspace-820');
  await setProofTheme('dark');
  await shot('cron-workspace-820-dark');
  await resizeViewport(1440);
  await page.locator('[data-scope-option="all"]').click();
  await page.waitForTimeout(300);
  await shot('cron-all-dark');
  await setProofTheme('light');

  await page.goto(pageUrl('/board'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-board-task-card]', { timeout: 15_000 });
  await page.waitForTimeout(500);
  const allCards = await page.locator('[data-board-task-card]').count();
  if (allCards !== 8) throw new Error(`board all-scope expected 8 cards, got ${allCards}`);
  await shot('board-all');
  await page.locator('[data-scope-option="wd_fixture_000000000000"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-board-task-card]').length === 5, null, { timeout: 10_000 });
  if (!page.url().includes('workspace=wd_fixture_000000000000')) throw new Error(`board scope not in URL: ${page.url()}`);
  await page.waitForTimeout(300);
  await shot('board-workspace');
  await resizeViewport(820);
  await shot('board-workspace-820');
  await setProofTheme('dark');
  await page.waitForSelector('[data-board-task-card]', { timeout: 15_000 });
  await page.waitForTimeout(400);
  await shot('board-workspace-820-dark');
  await resizeViewport(1440);
  await shot('board-workspace-dark');
  // Workspace tags are an all-workspaces affordance only.
  if (await page.locator('[data-board-card-workspace]').count() !== 0) throw new Error('board workspace scope still tags cards with their workspace');
  await page.locator('[data-scope-option="all"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-board-task-card]').length === 8, null, { timeout: 10_000 });
  if (await page.locator('[data-board-card-workspace]').count() !== 8) throw new Error('board all-scope cards are missing their workspace tag');
  await page.waitForTimeout(300);
  await shot('board-all-dark');

  // Card detail: markdown description, linked session, status transitions.
  const openDetail = async () => {
    await page.locator('[data-board-task-card*="board_tools_flaky"]').click();
    await page.waitForSelector('[data-task-detail-description] ul', { timeout: 10_000 });
    await page.waitForTimeout(300);
  };
  await openDetail();
  await shot('board-detail-dark');
  await page.keyboard.press('Escape');
  await setProofTheme('light');
  await page.waitForSelector('[data-board-task-card]', { timeout: 15_000 });
  await openDetail();
  if (await page.locator('[data-task-detail-move="in_progress"][aria-pressed="true"]').count() !== 1) throw new Error('board detail does not mark the current status');
  if (await page.locator('[data-task-detail-open-session]').count() !== 1) throw new Error('board detail lost its linked session');
  await shot('board-detail');
  await resizeViewport(390);
  await page.waitForTimeout(300);
  await shot('board-detail-390');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await shot('board-all-390');
  await resizeViewport(820);
  await shot('board-all-820');
  await resizeViewport(1440);

  // Status transition from the detail footer lands the card in the next lane.
  await openDetail();
  await page.locator('[data-task-detail-next="done"]').click();
  await page.waitForSelector('[data-board-column="done"] [data-board-task-card*="board_tools_flaky"]', { timeout: 10_000 });
  await page.waitForSelector('[data-task-detail-move="done"][aria-pressed="true"]', { timeout: 5000 });
  await page.waitForTimeout(300);
  await shot('board-detail-moved');
  // A linked session opens straight from the detail.
  await page.locator('[data-task-detail-open-session]').first().click();
  await page.waitForFunction(() => !location.pathname.startsWith('/board'), null, { timeout: 10_000 });
  console.log('[check] board detail session link left the board');
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
  // The arc paints the token layer (ContextMeter's LEVEL_STROKE), so resolve
  // the token in this page instead of copying the hex it happens to hold.
  const tokenColor = (name) => page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${cssVar})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
  const AMBER = await tokenColor('--color-amber-rule');
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
  if (!menuText.includes(S.contextMenuCut) || !menuText.includes(S.contextMenuCopy) || !menuText.includes(S.pasteAsPlainText) || !menuText.includes(S.contextMenuSelectAll)) {
    throw new Error(`unexpected context menu: ${menuText}`);
  }
  await shot('context-menu-open');
  await page.locator('[data-composer-context-menu] button', { hasText: S.contextMenuSelectAll }).click();
  await page.waitForSelector('[data-composer-context-menu]', { state: 'detached', timeout: 5000 });

  // Now prove the ring recolors live during a stream.
  await page.fill('textarea', 'Push the context over the danger threshold.');
  await page.press('textarea', 'Control+Enter');
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
  const RED = await tokenColor('--color-danger'); // --color-danger in the token layer
  if (dangerArc !== RED) throw new Error(`expected red danger arc, saw ${dangerArc}`);
  await shot('context-ring-danger');
  await page.waitForSelector(`text=${S.working}`, { state: 'detached', timeout: 20_000 }).catch(() => undefined);
}

/** Settings IA v2: nav blocks, owned pages, storage line, search, redirects (scripts/visual-proof-settings-ia.mjs). */
async function scenarioSettingsIa() {
  const walk = createSettingsIaWalker({
    page, shot, resizeViewport, setProofTheme, view: job().view,
    webUrl: WEB_URL, fixtureUrl: () => fixtureUrl(), fixtureToken: FIXTURE_TOKEN,
  });
  await walk();
}

/** Agents team view + profile editor (scripts/visual-proof-profile-editor.mjs). */
async function scenarioProfileEditor() {
  const walk = createProfileEditorWalker({
    page, shot, resizeViewport, setProofTheme, control, view: job().view,
    webUrl: WEB_URL, fixtureUrl: () => fixtureUrl(), fixtureToken: FIXTURE_TOKEN,
  });
  await walk();
}

/** External harness as main: sessions, profile switch, Antigravity (scripts/visual-proof-external-main.mjs). */
async function scenarioExternalMain() {
  const walk = createExternalMainWalker({
    page, shot, view: job().view, webUrl: WEB_URL, fixtureUrl: () => fixtureUrl(), fixtureToken: FIXTURE_TOKEN,
  });
  await walk();
}

/** Send now into a running main / child turn (scripts/visual-proof-steer.mjs). */
async function scenarioSteer() {
  const walk = createSteerWalker({
    page, shot, control, view: job().view, webUrl: WEB_URL, fixtureUrl: () => fixtureUrl(), fixtureToken: FIXTURE_TOKEN,
  });
  await walk();
}

/** Settings › Models & providers (scripts/visual-proof-models-page.mjs). */
const modelsPageWalker = () => createModelsPageWalker({
  page, shot, resizeViewport, setProofTheme, view: job().view,
  webUrl: WEB_URL, fixtureUrl: () => fixtureUrl(), fixtureToken: FIXTURE_TOKEN, locale: job().view.locale,
});
async function scenarioModelsPage() { await modelsPageWalker().populated(); }

/** Worktree isolation: /new opt-in, branch marks, Worktrees card, archive option (scripts/visual-proof-worktrees.mjs). */
async function scenarioWorktrees() {
  const walk = createWorktreesWalker({
    page, shot, resizeViewport, setProofTheme, control, view: job().view,
    webUrl: WEB_URL, fixtureUrl: () => fixtureUrl(), fixtureToken: FIXTURE_TOKEN, locale: job().view.locale,
  });
  await walk();
}
async function scenarioModelsPageEmpty() { await modelsPageWalker().empty(); }

/** Native SSH: settings, composer hosts, SSH approval cards (scripts/visual-proof-native-ssh.mjs). */
async function scenarioNativeSsh() {
  const walk = createNativeSshWalker({
    page, shot, resizeViewport, setProofTheme, control, view: job().view,
    webUrl: WEB_URL, fixtureUrl: () => fixtureUrl(), fixtureToken: FIXTURE_TOKEN, locale: job().view.locale,
  });
  await walk();
}

/** Automatic-compaction point: panel, model editor, profile editor (scripts/visual-proof-context-compact.mjs). */
async function scenarioContextCompact() {
  const walk = createContextCompactWalker({
    page, shot, selectSession, resizeViewport, setProofTheme, control, view: job().view,
    webUrl: WEB_URL, fixtureUrl: () => fixtureUrl(), fixtureToken: FIXTURE_TOKEN,
  });
  await walk();
}

/**
 * /memory, all three states. Off → the turn-on guide (nav entry present, one
 * switch, no console). On → the entry console: global list, type filter,
 * search, the detail editor with its history and Undo, the per-workspace
 * switch, and a save that survives a reload. Review → the Inbox tab, which
 * only exists at `approval: 'review'`. Both themes; 1440 and 390.
 */
async function scenarioMemoryOff() {
  const memoryUrl = `${WEB_URL}/memory?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`;
  // The nav entry is permanent — prove it is there while memory is off.
  if (await page.locator('[data-nav-memory]').count() !== 1) throw new Error('memory nav entry missing while memory is off');
  await page.locator('[data-nav-memory]').click();
  await page.waitForSelector('[data-memory-intro]', { timeout: 15_000 });
  if (await page.locator('[data-memory-console]').count() !== 0) throw new Error('memory console rendered while memory is off');
  await page.waitForTimeout(300);
  await shot('memory-off');
  await resizeViewport(390);
  await shot('memory-off-390');
  await setProofTheme('dark');
  await page.goto(memoryUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-memory-intro]', { timeout: 15_000 });
  await shot('memory-off-390-dark');
  await resizeViewport(1440);
  await shot('memory-off-dark');
  await setProofTheme('light');

  // Turning it on from the guide swaps in the console, no reload.
  await page.goto(memoryUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-memory-enable]', { timeout: 15_000 });
  await page.locator('[data-memory-enable]').click();
  await page.waitForSelector('[data-memory-console]', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('memory-turned-on');
}

async function scenarioMemory() {
  const memoryUrl = `${WEB_URL}/memory?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`;
  await page.goto(memoryUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-memory-list] [data-memory-row]', { timeout: 15_000 });
  const globalRows = await page.locator('[data-memory-row]').count();
  if (globalRows !== 3) throw new Error(`memory global scope expected 3 active rows, got ${globalRows}`);
  // Inbox only exists under approval=review.
  if (await page.locator('[data-memory-tab="inbox"]').count() !== 0) throw new Error('inbox tab present with approval=auto');
  await page.waitForTimeout(300);
  await shot('memory-global');

  // Archived entries are opt-in.
  await page.locator('[data-memory-console] [role="switch"]').first().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-memory-row]').length === 4, null, { timeout: 5000 });
  await shot('memory-global-archived');
  await page.locator('[data-memory-console] [role="switch"]').first().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-memory-row]').length === 3, null, { timeout: 5000 });

  // Type filter, then search.
  await page.locator('[data-memory-type-filter="feedback"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-memory-row]').length === 1, null, { timeout: 5000 });
  await shot('memory-filter-feedback');
  await page.locator('[data-memory-type-filter="all"]').click();
  await page.fill('[data-memory-search]', 'analyses');
  await page.waitForFunction(() => document.querySelectorAll('[data-memory-row]').length === 1, null, { timeout: 8000 });
  await shot('memory-search');
  await page.fill('[data-memory-search]', '');
  await page.waitForFunction(() => document.querySelectorAll('[data-memory-row]').length === 3, null, { timeout: 8000 });

  // Detail: editor + journal history with Undo.
  await page.locator('[data-memory-row="m_20260926_d4e5f6"]').click();
  await page.waitForSelector('[data-memory-detail="m_20260926_d4e5f6"]', { timeout: 10_000 });
  await page.waitForSelector('[data-memory-history]', { timeout: 10_000 });
  if (await page.locator('[data-memory-undo]').count() === 0) throw new Error('memory history offers no undo');
  await page.waitForTimeout(300);
  await shot('memory-detail');

  // A real save round-trips through PUT with expected_revision.
  await page.fill('[data-memory-body]', 'Finishing a task does not mean writing a summary file. Only create documents that were asked for.');
  await page.locator('[data-memory-save]').click();
  await page.waitForSelector(`text=${S.memorySaved}`, { timeout: 8000 });
  await shot('memory-saved');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-memory-row]', { timeout: 15_000 });
  await page.locator('[data-memory-row="m_20260926_d4e5f6"]').click();
  const savedBody = await page.locator('[data-memory-body]').inputValue();
  if (!savedBody.startsWith('Finishing a task does not mean writing a summary file')) {
    throw new Error(`memory edit did not persist: ${savedBody}`);
  }

  // Workspace scope: its own switch, and its own entries.
  await page.locator('[data-scope-option="wd_fixture_000000000000"]').click();
  await page.waitForSelector('[data-memory-workspace-switch]', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-memory-row]').length === 3, null, { timeout: 10_000 });
  if (!page.url().includes('workspace=wd_fixture_000000000000')) throw new Error(`memory scope not in URL: ${page.url()}`);
  await page.waitForTimeout(300);
  await shot('memory-workspace');
  await page.locator('[data-memory-ws-option="false"]').click();
  await page.waitForSelector('[data-memory-scope-off]', { timeout: 8000 });
  await shot('memory-workspace-off');
  await page.locator('[data-memory-ws-option="null"]').click();
  await page.waitForSelector('[data-memory-scope-off]', { state: 'detached', timeout: 8000 });

  await resizeViewport(390);
  await page.waitForTimeout(300);
  await shot('memory-workspace-390');
  await setProofTheme('dark');
  await page.waitForSelector('[data-memory-row]', { timeout: 15_000 });
  await page.waitForTimeout(400);
  await shot('memory-workspace-390-dark');
  await resizeViewport(1440);
  await shot('memory-workspace-dark');
  await setProofTheme('light');

  // The delete confirmation must not claim anything is permanent.
  await page.waitForSelector('[data-memory-row]', { timeout: 15_000 });
  await page.locator('[data-memory-row="m_20260925_555666"]').click();
  await page.waitForSelector('[data-memory-delete]', { timeout: 10_000 });
  await page.locator('[data-memory-delete]').click();
  await page.waitForTimeout(400);
  const confirmText = await page.locator('[role="alertdialog"]').first().innerText();
  for (const banned of S.memoryBannedInDelete) {
    if (confirmText.toLowerCase().includes(banned.toLowerCase())) {
      throw new Error(`delete confirmation claims permanence: ${confirmText}`);
    }
  }
  await shot('memory-delete-confirm');
  await page.locator(`[role="alertdialog"] button:has-text("${S.memoryDelete}")`).last().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-memory-row]').length === 2, null, { timeout: 8000 });
  await shot('memory-deleted');

  // Timeline: the quiet memory rows, with View / Undo on the write.
  await selectSession('Fixture: memory');
  await page.waitForSelector('[data-memory-tool="MemoryWrite"]', { timeout: 15_000 });
  const memoryTools = await page.locator('[data-memory-tool]').count();
  if (memoryTools !== 3) throw new Error(`expected 3 memory tool rows, got ${memoryTools}`);
  if (await page.locator('[data-memory-tool-view]').count() !== 1) throw new Error('memory write row has no View action');
  if (await page.locator('[data-memory-tool-undo]').count() !== 1) throw new Error('memory write row has no Undo action');
  await page.waitForTimeout(300);
  await shot('memory-timeline');
  await page.locator('[data-memory-tool="MemoryWrite"] [data-memory-tool-toggle]').click();
  await page.waitForTimeout(250);
  await shot('memory-timeline-expanded');
  await setProofTheme('dark');
  await page.waitForSelector('[data-memory-tool="MemoryWrite"]', { timeout: 15_000 });
  await page.waitForTimeout(400);
  await shot('memory-timeline-dark');
  await setProofTheme('light');
}

async function scenarioMemoryReview() {
  // The tab selection is component state, so every reload (theme switch) needs
  // the tab re-opened before the inbox rows can be asserted again.
  const openInbox = async () => {
    await page.waitForSelector('[data-memory-tab="inbox"]', { timeout: 15_000 });
    await page.locator('[data-memory-tab="inbox"]').click();
    await page.waitForSelector('[data-memory-inbox-row]', { timeout: 10_000 });
  };
  await page.goto(`${WEB_URL}/memory?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, { waitUntil: 'domcontentloaded' });
  await openInbox();
  const pending = await page.locator('[data-memory-inbox-row]').count();
  if (pending !== 2) throw new Error(`memory inbox expected 2 pending entries, got ${pending}`);
  await page.waitForTimeout(300);
  await shot('memory-inbox');
  await resizeViewport(390);
  await shot('memory-inbox-390');
  await setProofTheme('dark');
  await openInbox();
  await page.waitForTimeout(300);
  await shot('memory-inbox-390-dark');
  await resizeViewport(1440);
  await shot('memory-inbox-dark');
  await setProofTheme('light');
  // Keep promotes one entry out of the inbox.
  await openInbox();
  await page.locator('[data-memory-inbox-row="m_20260928_pend01"] [data-memory-inbox-keep]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-memory-inbox-row]').length === 1, null, { timeout: 8000 });
  await shot('memory-inbox-kept');
}

/**
 * Thread relations in the sidebar: sessions a session started (ThreadCreate)
 * and branches forked off it sit directly under their creator as single
 * indented rows (no spine, no fold bar; only the branch carries a glyph); a
 * relation whose creator is not loaded stays top-level and names it. Checked in
 * the time view and the workspace view, because the nesting rules differ there.
 */
async function scenarioThreadRelations() {
  await page.waitForSelector('[data-session-row]', { timeout: 15_000 });
  const spine = '[data-session-threads="session_fixture_release"]';
  await page.waitForSelector(spine, { timeout: 10_000 });
  const nested = await page.locator(`${spine} [data-session-row]`).count();
  if (nested !== 2) throw new Error(`expected 2 threads under the release session, got ${nested}`);
  // The fork nests under its own parent, with the branch glyph.
  await page.waitForSelector('[data-session-threads="session_fixture_spike"] [data-session-relation="branch"]', { timeout: 10_000 });
  // ThreadCreate children carry no glyph, and nothing folds.
  if (await page.locator(`${spine} [data-session-relation]`).count() !== 0) {
    throw new Error('a ThreadCreate child carries a relation glyph');
  }
  if (await page.locator('[data-session-threads-toggle]').count() !== 0) {
    throw new Error('the thread fold bar is back');
  }
  // The orphan keeps its row and names the creator it could not nest under.
  await page.waitForSelector('[data-session-relation-note="thread"]', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('thread-relations-time');
  await page.hover('[data-session-row="session_fixture_changelog_thread"]');
  await page.waitForTimeout(250);
  await shot('thread-relations-hover');
  await page.mouse.move(900, 450);
  await setProofTheme('dark');
  await page.waitForSelector('[data-session-row]', { timeout: 15_000 });
  await page.waitForTimeout(400);
  await shot('thread-relations-time-dark');
  await setProofTheme('light');

  // Workspace view: nesting stays inside a bucket, so the docs-site thread
  // becomes a top-level row in its own workspace group and says where it came from.
  await pickViewOption('[data-group-by="workspace"]');
  await closeViewMenu();
  await page.waitForSelector('[data-session-group]', { timeout: 10_000 });
  await page.waitForSelector('[data-session-row="session_fixture_docs_thread"]', { timeout: 10_000 });
  const docsNested = await page.locator(`${spine} [data-session-row="session_fixture_docs_thread"]`).count();
  if (docsNested !== 0) throw new Error('cross-workspace thread nested inside another workspace group');
  await page.waitForTimeout(300);
  await shot('thread-relations-workspace');
  await setProofTheme('dark');
  await page.waitForSelector('[data-session-row]', { timeout: 15_000 });
  await page.waitForTimeout(400);
  await shot('thread-relations-workspace-dark');
  await setProofTheme('light');
  await pickViewOption('[data-group-by="time"]');
  await closeViewMenu();

  // 390: the sidebar is a drawer here, so open it — the indent and the time
  // must still fit without clipping a title.
  await resizeViewport(390);
  await page.click(`button[aria-label="${S.openMenuAria}"]`);
  await page.waitForTimeout(400);
  await shot('thread-relations-390');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await resizeViewport(1440);
}

/**
 * Activity inbox: the bell in the sidebar header is the one place that counts
 * what needs you; /activity lists blocked sessions first, then finished-unread
 * ones. The sidebar rows show the four row states (waiting, still working,
 * unread, caught up with no dot). The caught-up row needs a seen-mark, so it
 * is seeded before the reload.
 */
async function scenarioActivityInbox() {
  await page.evaluate(() => {
    localStorage.setItem('kiki.sessionSeen.v1', JSON.stringify({ session_fixture_act_read: 7 }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-session-row="session_fixture_act_read"]', { timeout: 15_000 });
  await page.waitForSelector('[data-activity-badge]', { timeout: 10_000 });
  if (await page.locator('[data-session-row="session_fixture_act_read"] [data-life]').count() !== 0) {
    throw new Error('a caught-up row still draws a status dot');
  }
  await page.waitForTimeout(300);
  await shot('activity-sidebar');
  await page.locator('[data-nav-activity]').click();
  await page.waitForSelector('[data-activity-page]', { timeout: 10_000 });
  await page.waitForSelector('[data-activity-group="needs-you"] [data-activity-item]', { timeout: 10_000 });
  await page.waitForSelector('[data-activity-group="unread"] [data-activity-item]', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('activity-page');
  await setProofTheme('dark');
  await page.waitForSelector('[data-activity-page]', { timeout: 15_000 });
  await shot('activity-page-dark');
  await setProofTheme('light');
  await resizeViewport(390);
  await page.waitForTimeout(400);
  await shot('activity-page-390');
  await resizeViewport(1440);
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
  const locale = job().view.locale;
  const other = locale === 'zh' ? 'en' : 'zh';
  // General's "Composer & session" card title (st-card-composer) is the
  // locale probe; new-session defaults moved to Models & providers › Defaults.
  const otherTitle = STRINGS[other].composerCardTitle;
  const cardTitle = (text) => `#st-card-composer >> text=${text}`;
  await page.goto(`${WEB_URL}/settings/general?server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector(cardTitle(S.composerCardTitle), { timeout: 10_000 });
  await page.locator(`[data-locale-choice="${other}"]`).click();
  // Instant switch: the same page re-renders in the other locale, no reload.
  await page.waitForSelector(cardTitle(otherTitle), { timeout: 5000 });
  const htmlLang = await page.evaluate(() => document.documentElement.lang);
  if ((other === 'zh' ? 'zh-CN' : 'en') !== htmlLang) {
    throw new Error(`<html lang> did not follow the locale: ${htmlLang}`);
  }
  await page.waitForTimeout(400);
  await shot(`i18n-switched-${other}`);
  // Persisted per device: a reload keeps the choice.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(cardTitle(otherTitle), { timeout: 10_000 });
  // Back to the run locale.
  await page.locator(`[data-locale-choice="${locale}"]`).click();
  await page.waitForSelector(cardTitle(S.composerCardTitle), { timeout: 5000 });
  await shot(`i18n-restored-${locale}`);
}

// ---------------------------------------------------------------------------

/** /capabilities and the settings Skills / MCP / Plugins leaves (scripts/visual-proof-capabilities.mjs). */
async function scenarioCapabilities() {
  const walk = createCapabilitiesWalker({
    page, shot, setProofTheme, control, view: job().view,
    webUrl: WEB_URL, fixtureUrl: () => fixtureUrl(), fixtureToken: FIXTURE_TOKEN,
  });
  await walk();
}

/**
 * first-run — the onboarding wizard walk on a freshly installed kiki: the
 * auto-popup opens on boot, "Save & continue" persists the API-key form
 * before advancing, the permissions step preselects auto, finish lands on
 * /new with an empty composer and starter chips, and a reload proves the run is
 * marked completed (no second popup) with the provider still saved.
 */
async function scenarioFirstRun() {
  const wizard = () => page.locator('[role="dialog"]');
  const wizardButton = (name) => wizard().getByRole('button', { name, exact: true });

  // First-run means a clean slate: the generic harness boots /new under the
  // previous scenario, which persists a workspace draft that is meaningless
  // here (and renders a stale "workspace unavailable" line in every shot).
  await page.evaluate(() => {
    try {
      localStorage.removeItem('kiki.onboarding');
      localStorage.removeItem('kiki.newSessionDraft');
    } catch { /* ignore */ }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`text=${S.newSession}`, { timeout: 30_000 });
  await page.waitForSelector('[role="dialog"]', { timeout: 15_000 });
  if (!(await wizard().getAttribute('aria-label'))?.includes('Kiki')) {
    throw new Error('first-run dialog did not auto-open');
  }
  // Let the dialog's entrance animation settle before the first shot.
  await page.waitForTimeout(450);
  await shot('onboarding-1-welcome');

  // Welcome (language + theme, palette, picture on one page) → model.
  await wizard().locator('[data-onboarding-appearance]').waitFor({ timeout: 5000 });
  await wizardButton(S.onboardingNext).click();
  await wizard().locator('[data-preset-grid] input[type="search"]').fill('kimi');
  await wizard().locator('[data-provider-template="moonshot"]').waitFor({ timeout: 5000 });
  await shot('onboarding-2-model-light');
  await shot('onboarding-2-model');
  // Back to the welcome page for the theme, then forward again.
  await wizardButton(S.onboardingBack).click();
  await wizardButton(job().view.locale === 'zh' ? '暗色' : 'Dark').click();
  await wizardButton(S.onboardingNext).click();
  await wizard().locator('[data-preset-grid] input[type="search"]').fill('kimi');
  await wizard().locator('[data-provider-template="moonshot"]').waitFor({ timeout: 5000 });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await shot('onboarding-2-model-dark');
  await wizardButton(S.onboardingBack).click();
  await wizardButton(job().view.locale === 'zh' ? '亮色' : 'Light').click();
  await wizardButton(S.onboardingNext).click();
  await wizard().locator('[data-preset-grid] input[type="search"]').fill('kimi');

  // API-key lane: search result → key → server probe → pick a suggested model,
  // then "Save & continue" persists.
  await wizard().locator('[data-provider-template="moonshot"]').click();
  await wizard().locator('input[type="password"]').fill('sk-proof-key');
  await wizardButton(S.onboardingTest).click();
  const chip = wizard().locator('[data-model-suggestion="kimi-for-coding"]');
  await chip.waitFor({ timeout: 5000 });
  await waitForText(S.onboardingTestedOk);
  await chip.click();
  const modelId = await wizard().locator('input[placeholder="model-id"]').inputValue();
  if (modelId !== 'kimi-for-coding') {
    throw new Error(`suggestion chip must fill the model input, saw "${modelId}"`);
  }
  await shot('onboarding-3-model-form');

  // Mobile width: the dialog stays single-column and inside the viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflows) throw new Error('onboarding dialog overflows the mobile viewport');
  await shot('onboarding-3-model-form-mobile');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(250);

  await wizardButton(S.onboardingSaveNext).click();
  await wizard().locator('[data-permission-choice]').first().waitFor({ timeout: 5000 });
  // Saved + advanced: going Back shows the persisted connection read-out.
  await wizardButton(S.onboardingBack).click();
  await waitForText(S.onboardingReady);
  await shot('onboarding-3-model-saved');
  await wizardButton(S.onboardingNext).click();
  await waitForText(S.onboardingRecommended);
  if (await wizard().locator('[data-workspace-choice]').count() !== 0) {
    throw new Error('onboarding must not ask for a workspace');
  }
  // Fresh runs preselect auto, and every wire mode is offered.
  const checked = await wizard().locator('[data-permission-choice][aria-checked="true"]').getAttribute('data-permission-choice');
  if (checked !== 'auto') throw new Error(`permissions step must preselect auto, saw "${checked}"`);
  const offered = await wizard().locator('[data-permission-choice]').count();
  console.log(`[check] onboarding offers ${offered} permission modes`);
  await shot('onboarding-5-permissions');

  await wizardButton(S.onboardingFinish).click();
  await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 15_000 });
  await page.waitForSelector('textarea', { timeout: 15_000 });
  await page.waitForTimeout(600);
  // Finish lands on the /new hero with an EMPTY composer and starter chips.
  await page.waitForSelector('[data-phase="hero"]', { timeout: 15_000 });
  const draft = await page.locator('textarea').first().inputValue();
  if (draft !== '') throw new Error(`finish must not prefill the composer, saw "${draft.slice(0, 80)}"`);
  const starters = await page.locator('[data-hero-starter]').count();
  if (starters !== 4) throw new Error(`hero must offer 4 starter chips, saw ${starters}`);
  await page.locator('[data-hero-starter]').first().click();
  const filled = await page.locator('textarea').first().inputValue();
  if (filled === '') throw new Error('a starter chip must fill the draft');
  if (page.url().includes('/s/')) throw new Error('a starter chip must not send');
  await shot('onboarding-6-finished');
  await page.fill('textarea', '');

  // The saved provider seeds the server's default model; the composer must not
  // greet the first session with a stale "model unavailable" diagnostic.
  const serverDefault = await page.evaluate(async ([base, token]) => {
    const res = await fetch(`${base}/api/config`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return (await res.json()).data?.default_model;
  }, [fixtureUrl(), FIXTURE_TOKEN]);
  const diagnostics = await page.locator('[data-selection-diagnostic]').allTextContents();
  console.log(`[first-run] server default_model=${JSON.stringify(serverDefault)} diagnostics=${JSON.stringify(diagnostics)}`);
  if (diagnostics.length !== 0) {
    throw new Error(`finish leaves a selection diagnostic on /new: ${diagnostics.join(' | ')}`);
  }

  // Reload: onboarding stays completed and the saved provider keeps the
  // wizard from ever auto-opening again.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`text=${S.newSession}`, { timeout: 30_000 });
  await page.waitForTimeout(1200);
  if ((await page.locator('[role="dialog"]').count()) !== 0) {
    throw new Error('onboarding wizard reopened after completion');
  }
  const diagnosticsAfter = await page.locator('[data-selection-diagnostic]').allTextContents();
  console.log(`[first-run] diagnostics after reload=${JSON.stringify(diagnosticsAfter)}`);
}

// ---------------------------------------------------------------------------

/**
 * skins — native reskinning.
 *
 * Walks every skin (built-in and from the fixture themes directory) across
 * light and dark, on the four surfaces a palette actually has to survive:
 * the conversation, the new-session page, settings, and usage. Then the
 * adjustment controls (live preview) and the export field.
 *
 * Skins are applied by writing localStorage and reloading rather than by
 * clicking through settings for each one: the point of these shots is the
 * palette on four different routes, and thirty-two navigations through a
 * picker would be the slowest possible way to get them.
 */
async function scenarioSkins() {
  const link = (path) =>
    `${WEB_URL}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`;
  const SESSION = '/s/session_fixture_skins';

  const applySkin = async (source, id, theme) => {
    await page.evaluate(([src, skinId, mode]) => {
      localStorage.setItem('kiki.skin', JSON.stringify({ selection: { source: src, id: skinId }, tweaks: {} }));
      const settings = JSON.parse(localStorage.getItem('kiki.settings') ?? '{}');
      settings.theme = mode;
      localStorage.setItem('kiki.settings', JSON.stringify(settings));
    }, [source, id, theme]);
  };

  // Land on settings once so the skin catalog query runs and the user skins
  // are in the store before anything is selected.
  await page.goto(link('/settings/appearance'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-skin-settings]', { timeout: 15_000 });
  await page.waitForSelector('[data-skin-choice="ocean"]', { timeout: 15_000 });
  await page.waitForSelector('[data-skin-choice="midnight"]', { timeout: 10_000 });

  // The two invalid files must be reported as skipped, not silently dropped:
  // a TUI theme in the same directory and a skin carrying raw CSS.
  const skipped = await page.locator('[data-skin-settings] details summary').first().textContent();
  if (!/2/.test(skipped ?? '')) {
    throw new Error(`expected 2 skipped skin files, summary read: ${skipped}`);
  }
  await page.locator('[data-skin-settings] details summary').first().click();
  await page.locator('#st-card-skin-files').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await shot('skins-picker');

  const directory = await page.locator('[data-skin-directory]').textContent();
  console.log(`[skins] themes directory reported: ${directory}`);
  const theme = job().view.theme;

  // Every skin on every surface it has to hold up on.
  const SURFACES = [
    ['session', SESSION],
    ['new', '/new'],
    ['settings', '/settings/appearance'],
    ['usage', '/usage'],
  ];
  const SKINS = [
    ['builtin', 'paper', ['light', 'dark']],
    ['builtin', 'graphite', ['light', 'dark']],
    ['builtin', 'contrast', ['light', 'dark']],
    ['builtin', 'nocturne', ['dark']],
    ['user', 'ocean', ['light', 'dark']],
    ['user', 'midnight', ['dark']],
  ];

  for (const [source, id, themes] of SKINS) {
    // The theme is the job's dimension (`matrix: ['theme']`): shoot this skin
    // only in the theme it declares, in the context that already carries it.
    if (!themes.includes(theme)) continue;
    await applySkin(source, id, theme);
    for (const [label, path] of SURFACES) {
        await page.goto(link(path), { waitUntil: 'domcontentloaded' });
        // Each route has its own landmark; waiting on the skin attribute alone
        // would screenshot a half-painted page.
        if (label === 'usage') {
          await page.waitForSelector('[data-usage-trend]', { timeout: 20_000 });
        } else if (label === 'settings') {
          await page.waitForSelector('[data-skin-settings]', { timeout: 20_000 });
        } else {
          await page.waitForSelector('textarea', { timeout: 20_000 });
        }
        const applied = await page.evaluate(() => ({
          skin: document.documentElement.dataset.skin ?? null,
          theme: document.documentElement.dataset.theme ?? null,
          paper: getComputedStyle(document.documentElement).getPropertyValue('--color-paper').trim(),
        }));
        if (applied.skin !== id) {
          throw new Error(`expected data-skin=${id} on ${label}, got ${applied.skin}`);
        }
        if (applied.theme !== theme) {
          throw new Error(`expected data-theme=${theme} on ${label}, got ${applied.theme}`);
        }
        await page.waitForTimeout(350);
        await shot(`skin-${id}-${theme}-${label}`);
    }
    console.log(`[skins] ${id}/${theme}: 4 surfaces captured`);
  }

  // Adjustments apply at once (the page has no draft): the accent repaints
  // the whole app and lands in storage in the same step.
  await applySkin('builtin', 'graphite', 'light');
  await page.goto(link('/settings/appearance'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-skin-settings]', { timeout: 15_000 });

  const accentBefore = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim());
  // `fill` sets the value and fires the React-visible input event; a
  // hand-dispatched event on a native color picker does not reach React.
  await page.locator('#skin-accent').fill('#7c3aed');
  await page.locator('#skin-radius').fill('2');
  await page.locator('[aria-labelledby="skin-density-label"] button', { hasText: /Compact|紧凑/ }).click();
  await page.waitForTimeout(400);
  const accentAfter = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim());
  if (accentAfter === accentBefore) {
    throw new Error(`accent tweak did not apply (still ${accentBefore})`);
  }
  console.log(`[skins] accent applied ${accentBefore} -> ${accentAfter}`);
  const stored = await page.evaluate(() => localStorage.getItem('kiki.skin'));
  if (!/7c3aed/i.test(stored ?? '')) {
    throw new Error(`the accent tweak did not persist: ${stored}`);
  }
  await shot('skins-tweaks-saved');

  // The tweak survives a reload and still shows on a real page.
  await page.goto(link(SESSION), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('textarea', { timeout: 20_000 });
  await page.waitForTimeout(400);
  await shot('skins-tweaks-session');

  // Export: fill a name and confirm the affirmation. The download itself is a
  // host concern; what matters here is that the control completes.
  await page.goto(link('/settings/appearance'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-skin-settings]', { timeout: 15_000 });
  await page.locator('#skin-export-name').fill('My Slate');
  await page.locator('#st-card-skin-files').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await shot('skins-export');

  // Leave the run on the default skin so later scenarios are not reskinned.
  await page.evaluate(() => { localStorage.removeItem('kiki.skin'); });
}

/**
 * settings-appearance — the Appearance leaf and the settings shell around it.
 *
 * Captures the page in light, dark and a non-default skin at desktop and
 * phone widths, a second leaf (General) for the shared shell, and asserts the
 * contract the page promises: the old `#st-card-appearance` anchor lands on
 * the new page, motion/prose choices reach <html>, and the nav selection is a
 * raised sheet rather than an accent fill.
 */
async function scenarioSettingsAppearance() {
  const link = (path) =>
    `${WEB_URL}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl())}&token=${FIXTURE_TOKEN}`;
  const setLook = async (skin, theme) => {
    await page.evaluate(([skinId, mode]) => {
      localStorage.setItem('kiki.skin', JSON.stringify({ selection: { source: 'builtin', id: skinId }, tweaks: {} }));
      const settings = JSON.parse(localStorage.getItem('kiki.settings') ?? '{}');
      settings.theme = mode;
      localStorage.setItem('kiki.settings', JSON.stringify(settings));
    }, [skin, theme]);
  };

  // The retired General anchor redirects to the new leaf.
  await page.goto(`${link('/settings/general')}#st-card-appearance`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-appearance-page]', { timeout: 15_000 });
  if (!page.url().includes('/settings/appearance')) {
    throw new Error(`#st-card-appearance did not land on /settings/appearance: ${page.url()}`);
  }

  const shots = [
    ['paper', 'light'],
    ['paper', 'dark'],
    ['graphite', 'light'],
  ];
  for (const [skin, theme] of shots) {
    await setLook(skin, theme);
    for (const [width, height, label] of [[1440, 1000, 'desktop'], [390, 844, 'mobile']]) {
      await page.setViewportSize({ width, height });
      await page.goto(link('/settings/appearance'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-appearance-preview]', { timeout: 15_000 });
      await page.waitForTimeout(350);
      await shot(`appearance-${skin}-${theme}-${label}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  // Controls reach <html> immediately and "Restore defaults" appears. The
  // prose font is a select over the registered presets now.
  await setLook('paper', 'light');
  await page.goto(link('/settings/appearance'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-appearance-preview]', { timeout: 15_000 });
  await page.locator(`[data-font-role="prose"] [aria-label="${S.proseFontLabel}"]`).click();
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 });
  await page.getByRole('option', { name: S.proseSans, exact: true }).click();
  await page.locator('[data-motion-choice="reduce"]').click();
  const attrs = await page.evaluate(() => ({
    motion: document.documentElement.dataset.kikiMotion,
    prose: document.documentElement.dataset.kikiProse,
  }));
  if (attrs.motion !== 'reduce' || attrs.prose !== 'sans') {
    throw new Error(`appearance attributes not applied: ${JSON.stringify(attrs)}`);
  }
  await page.waitForSelector('[data-appearance-restore]', { timeout: 3000 });
  await page.locator('#st-card-appearance-type').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await shot('appearance-changed-type');
  await page.locator('[data-appearance-restore]').click();
  await page.waitForTimeout(250);
  await page.evaluate(() => { document.querySelector('[data-settings-scroll]')?.scrollTo(0, 0); });
  await page.waitForTimeout(200);
  await shot('appearance-restored-undo');

  // The nav selection is a raised sheet in every leaf, never an accent fill.
  const navActive = await page.locator('nav [aria-current="page"]').first().getAttribute('class');
  if (/accent/.test(navActive ?? '')) throw new Error(`nav selection uses accent: ${navActive}`);

  // Shared shell on a draft-bearing leaf, clean and dirty.
  for (const [path, label] of [['/settings/general', 'general'], ['/settings/tasks', 'tasks'], ['/settings/ai?tab=providers', 'providers']]) {
    await page.goto(link(path), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-settings-page-title]', { timeout: 15_000 });
    await page.waitForTimeout(500);
    await shot(`settings-shell-${label}`);
  }
  await setLook('paper', 'dark');
  await page.goto(link('/settings/tasks'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-settings-page-title]', { timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot('settings-shell-tasks-dark');

  await page.evaluate(() => {
    localStorage.removeItem('kiki.skin');
    const settings = JSON.parse(localStorage.getItem('kiki.settings') ?? '{}');
    delete settings.theme;
    delete settings.motion;
    delete settings.proseFont;
    localStorage.setItem('kiki.settings', JSON.stringify(settings));
  });
}

// ---------------------------------------------------------------------------

/**
 * Scenario registry: one entry per GUI fixture scenario. `fixture` names the
 * data module under ../fixtures; the runner gives every entry its own browser
 * context, fixture server and screenshot budget.
 */
function scenario(name, run, extra = {}) {
  return {
    name,
    fixture: name,
    ...extra,
    async run(context) {
      return jobs.run(context, async () => {
        await drainTimeline(page); // count only this scenario's frames
        const shots = await run();
        if (TIMELINE_GATED.has(name)) {
          const integrity = await assertTimelineIntegrity(page, `scenario ${name}`);
          console.log(`[check] timeline integrity: ${integrity.frames} frames, ${JSON.stringify(integrity.totals)}`);
        }
        return shots;
      });
    },
  };
}

/**
 * Registry fields a scenario needs beyond name and body.
 *
 * `onboarding`: the runner seeds a completed `kiki.onboarding` so the wizard
 * does not auto-open over a fixture that has no provider; the first-run
 * scenario is the one that must meet the wizard.
 */
const ENTRY_EXTRA = {
  'first-run': { onboarding: false },
};

/** Walk order. `responsive` shrinks the viewport, so it stays last. */
const BODIES = [
  ['basic-stream', scenarioBasicStream],
  ['prompt-dedupe', scenarioPromptDedupe],
  ['queue', scenarioQueue],
  ['steer', scenarioSteer],
  ['subagents', scenarioSubagents],
  ['subagent-approval', scenarioSubagentApproval],
  ['subagents-burst', scenarioSubagentsBurst],
  ['goal-swarm', scenarioGoalSwarm],
  ['goal-queue', scenarioGoalQueue],
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
  ['external-main', scenarioExternalMain],
  ['reconnect', scenarioReconnect],
  ['reconnect-mid-turn', scenarioReconnectMidTurn],
  ['resync-hold', scenarioResyncHold],
  ['session-pages', scenarioSessionPages],
  ['sidebar-organize', scenarioSidebarOrganize],
  ['empty-states', scenarioEmptyStates],
  ['new-no-workspace', scenarioNewNoWorkspace],
  ['first-run', scenarioFirstRun],
  ['draft-flow', scenarioDraftFlow],
  ['hero-shell', scenarioHeroShell],
  ['composer-modes', scenarioComposerModes],
  ['settings', scenarioSettings],
  ['settings-search', scenarioSettingsSearch],
  ['settings-write', scenarioSettingsWrite],
  ['connection-token', scenarioConnectionToken],
  ['settings-invalid', scenarioSettingsInvalid],
  ['settings-browser-editable', scenarioSettingsBrowserEditable],
  ['settings-communication', scenarioSettingsCommunication],
  ['settings-workspaces', scenarioWorkspaces],
  ['settings-agents', scenarioSettingsAgents],
  ['settings-shipped', scenarioSettingsShipped],
  ['settings-nbsearch', scenarioSettingsNbSearch],
  ['settings-ia', scenarioSettingsIa],
  ['slash-commands', scenarioSlashCommands],
  ['attachments', scenarioAttachments],
  ['selection-annotate', scenarioSelectionAnnotate],
  ['preview-workbench', scenarioPreviewWorkbench],
  ['search', scenarioSearch],
  ['session-actions', scenarioSessionActions],
  ['memory-off', scenarioMemoryOff],
  ['memory', scenarioMemory],
  ['memory-review', scenarioMemoryReview],
  ['thread-relations', scenarioThreadRelations],
  ['activity-inbox', scenarioActivityInbox],
  ['context-ring', scenarioContextRing],
  ['context-compact', scenarioContextCompact],
  ['models-page', scenarioModelsPage],
  ['models-page-empty', scenarioModelsPageEmpty],
  ['worktrees', scenarioWorktrees],
  ['native-ssh', scenarioNativeSsh],
  ['profile-editor', scenarioProfileEditor],
  ['usage-dashboard', scenarioUsageDashboard],
  ['workspace-tools', scenarioWorkspaceTools],
  ['terminal', scenarioTerminal],
  ['capabilities', scenarioCapabilities],
  ['skins', scenarioSkins],
  ['settings-appearance', scenarioSettingsAppearance],
  ['i18n', scenarioI18n],
  ['rewrite-flow', scenarioRewriteFlow],
  ['rail-scale', scenarioRailScale],
  // responsive stays last: it shrinks the viewport to 320px and nothing
  // afterward may assume a desktop layout.
  ['responsive', scenarioResponsive],
];

export const scenarios = BODIES.map(([name, body]) => scenario(name, body, { ...ENTRY_EXTRA[name], matrix: MATRIX[name] }));

async function main() {
  const { failed } = await runProof({
    root: ROOT,
    scenarios,
    argv: process.argv.slice(2),
    label: 'proof',
    onWebUp: (url) => { WEB_URL = url; },
  });
  process.exitCode = failed.length > 0 ? 1 : 0;
}

// Importing this module (the registry test) must not build or launch Chromium.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
