import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computerControlPreference, computerControlPreferencePatch, computerControlConnection, computerControlConnectionPatch, computerControlVerdict, isComputerControlEnabled, computerControlEnabledPatch, isComputerToolPolicyDenied, isComputerToolPolicyPartiallyDenied } from './computerControl';
import { isBrowserControlEnabled, browserControlEnabledPatch, browserControlVerdict, isBrowserToolPolicyDenied, isBrowserToolPolicyPartiallyDenied, isBrowserConnectionEffectiveAllowed, effectiveAllowedBrowserCount, browserSourceOfConnectionType } from './browserControl';
import { patchConfigRequestSchema } from '@kiki/protocol';
import { MEMORY_ADVISOR_RANGES, memoryAdvisorEndpointIssue, memoryAdvisorModelBaseUrl, memoryAdvisorModePatch, memoryAdvisorNumberValue, memoryAdvisorOn, memoryAdvisorSelectorFromDraft, memoryAdvisorView, parseMemoryAdvisorNumber } from './memoryAdvisor';

import {
  DEFAULT_DESKTOP_SETTINGS,
  DEFAULT_MODEL_CAPABILITIES,
  EXPERIMENTAL_FLAG_HOMES,
  EXPERIMENTAL_FALLBACK_SECTION,
  experimentalFlagHome,
  experimentalSectionForFlag,
  agentIdentityPatch,
  appendExtraSkillDirs,
  AI_SETTINGS_TABS,
  aiTabForCard,
  CONNECTION_SETTINGS_TABS,
  connectionTabForCard,
  buildSettingsSearchIndex,
  clearRestartRequirement,
  configureSpacePortableSettings,
  refreshSpacePortableSettings,
  threadAllowPatch,
  threadCommunicationPatch,
  tokenCountingPatch,
  agentNotifyParentPatch,
  fetchRemoteModels,
  humanizeMs,
  acknowledgeRestartRequirement,
  isProviderDraftDirty,
  isRestartRequirementAcknowledged,
  markRestartRequired,
  marketplaceUrlPatch,
  mcpTimeoutsPatch,
  msUnitFor,
  normalizeTags,
  parseAdvancedServerConfig,
  parseExperimentalFlags,
  parseHooksJson,
  parseHooksConfigJson,
  hooksConfigPatch,
  parseRemoteModels,
  providerDraftFromCatalog,
  providerModelDraftFromCatalog,
  providerDefaultRow,
  providerCreateBody,
  providerPatchBody,
  modelPatchBody,
  modelCreateBody,
  providerTemplateFor,
  composerEnterAction,
  isComposerSendKey,
  isDefaultAppendTiming,
  readDesktopPrefs,
  readRestartRequirement,
  readDeviceSettings,
  readSettings,
  requestIdentityLayerDraftFromPolicy,
  requestIdentityPolicyFromDraft,
  resourceLimitPatch,
  sessionTitleModelPatch,
  sessionTitlePromptPatch,
  sessionTitleSettingsPatch,
  remoteModelsHeaders,
  remoteModelsUrl,
  resolveEffectiveModel,
  resolveModelSource,
  resolveSessionModelOverride,
  resolveSettingsRoute,
  installedPluginsPath,
  pluginSettingsIdFromQuery,
  pluginSettingsPath,
  restartRequirementSnapshot,
  runtimeConfigDraftFromConfig,
  searchSettings,
  SEARCH_SETTINGS_TABS,
  SESSIONS_SETTINGS_TABS,
  searchTabForCard,
  sessionsTabForCard,
  connectionServicesTabForCard,
  CONNECTION_SERVICES_SETTINGS_TABS,
  serverFileSettingsFromConfig,
  serverFileSettingsPatch,
  SETTINGS_SEARCH_SPEC,
  SETTINGS_SECTIONS,
  SETTINGS_NAV_TREE,
  SETTINGS_SECTION_META,
  settingsSectionIsDeviceOnly,
  settingsSectionSupportsSpace,
  settingsGroupForSection,
  settingsSectionForCard,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeRestartRequirement,
  subscribeSettings,
  taskRuntimePatch,
  toolPolicyDraftFromConfig,
  toolPolicyPatch,
  validateDesktopConfigDraft,
  validateNewProviderDraft,
  validateProviderDraft,
  validateRequestTimeoutSeconds,
  validateServerDefaults,
  writeDesktopPrefs,
  writeSettings,
  type ProviderDraft,
} from './settings';
import { clearStoredDrafts, flushDrafts, readDraft, resetDraftMemoryForTests, writeDraft } from '../composer/drafts';
import { translate, type I18nKey } from '../i18n/locale';
import { en } from '../i18n/en';
import { zh } from '../i18n/zh';
import { parseNamedAgentTools } from './agentSettings';
import { mcpConfigFromDraft } from './mcp';

class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();
  get length(): number { return this.#items.size; }
  clear(): void { this.#items.clear(); }
  getItem(key: string): string | null { return this.#items.get(key) ?? null; }
  key(index: number): string | null { return [...this.#items.keys()][index] ?? null; }
  removeItem(key: string): void { this.#items.delete(key); }
  setItem(key: string, value: string): void { this.#items.set(key, value); }
}

const providerDraft = (patch: Partial<ProviderDraft> = {}): ProviderDraft => ({
  id: 'example',
  type: 'openai',
  baseUrl: 'https://api.example.test/v1',
  defaultModel: 'example/chat',
  apiKey: '',
  clearApiKey: false,
  requestIdentityChoice: 'inherit',
  requestIdentityOverridesJson: '',
  imageAcceptedTypes: null,
  imageConvertUnsupported: null,
  models: [
    {
      id: 'example/chat',
      remoteId: 'chat',
      maxContextSize: 128000,
      displayName: 'Example Chat',
      capabilities: ['reasoning'],
      supportEfforts: ['low', 'high'],
      requestIdentityChoice: 'inherit',
      requestIdentityOverridesJson: '',
      imageAcceptedTypes: null,
      imageConvertUnsupported: null,
    },
  ],
  ...patch,
});

describe('settings persistence and validation', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
    vi.restoreAllMocks();
  });

  it('reads normalized device settings without bridge authority and preserves pre-normalization undefined overrides', () => {
    expect(localStorage.getItem('kiki.settings')).toBeNull();
    expect(readDeviceSettings()).toEqual(DEFAULT_DESKTOP_SETTINGS);
    localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'light', foldSteps: false, sendShortcut: 'invalid', requestTimeoutSeconds: -1 }));
    configureSpacePortableSettings({ read: () => ({ theme: 'dark', foldSteps: true }), write: vi.fn() });
    try {
      expect(readDeviceSettings()).toMatchObject({ theme: 'light', foldSteps: false, sendShortcut: 'enter', requestTimeoutSeconds: 30 });
      expect(readSettings()).toMatchObject({ theme: 'dark', foldSteps: true, sendShortcut: 'enter', requestTimeoutSeconds: 30 });
      configureSpacePortableSettings({ read: () => ({ theme: undefined, foldSteps: undefined }), write: vi.fn() });
      expect(readSettings()).toMatchObject({ theme: 'system', foldSteps: false });
      expect(readDeviceSettings()).toMatchObject({ theme: 'light', foldSteps: false });
    } finally { configureSpacePortableSettings(); }
  });

  it('uses space authority for portable settings without changing device preferences or trusting stale cache writes', () => {
    writeSettings({ theme: 'light', sendShortcut: 'cmd-enter', motion: 'reduce', foldSteps: false });
    let confirmed = { theme: 'dark' as 'light' | 'dark' | 'system', proseFont: 'sans' as const, foldSteps: true, defaultAppendTiming: 'tasks_done' as const, worktreeSkipConfirm: false };
    const writes = vi.fn();
    configureSpacePortableSettings({ read: () => confirmed, write: writes });
    try {
      expect(readSettings()).toMatchObject({ theme: 'dark', sendShortcut: 'cmd-enter', motion: 'reduce', foldSteps: true });
      writeSettings({ theme: 'system', sendShortcut: 'enter', foldSteps: false });
      expect(writes).toHaveBeenCalledWith({ theme: 'system', foldSteps: false });
      expect(JSON.parse(localStorage.getItem('kiki.settings')!)).toMatchObject({ theme: 'light', sendShortcut: 'enter', foldSteps: false });
      expect(readSettings().theme).toBe('dark');
      confirmed = { ...confirmed, theme: 'system' };
      refreshSpacePortableSettings();
      expect(settingsSnapshot().theme).toBe('system');
      localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'light', sendShortcut: 'cmd-enter' }));
      expect(readSettings().theme).toBe('system');
      expect(readSettings().sendShortcut).toBe('cmd-enter');
    } finally { configureSpacePortableSettings(); }
  });

  it('parses named-agent tool text from comma and newline separated input', () => {
    expect(parseNamedAgentTools('Read, Bash\nSkill')).toEqual(['Read', 'Bash', 'Skill']);
    expect(parseNamedAgentTools('  \n, ')).toBeNull();
  });

  it('defaults absent, partial, and malformed storage to safe local values', () => {
    writeSettings({});
    expect(readSettings().closeToTray).toBe(true);
    expect(readSettings().requestTimeoutSeconds).toBe(30);
    expect(readSettings().subagentPanelOpenMode).toBe('tab');
    expect(readSettings().defaultAppendTiming).toBe('agent_idle');
    expect(readDesktopPrefs().closeToTray).toBe(true);

    localStorage.setItem('kiki.settings', JSON.stringify({
      sendShortcut: 'invalid',
      defaultPermissionMode: 'root',
      requestTimeoutSeconds: 601,
      subagentPanelOpenMode: 'invalid',
      defaultAppendTiming: 'immediate',
    }));
    localStorage.setItem('kiki.desktopPrefs', JSON.stringify({ notifications: false }));
    expect(readSettings().sendShortcut).toBe('enter');
    expect(readSettings().defaultPermissionMode).toBe('auto');
    expect(readSettings().requestTimeoutSeconds).toBe(30);
    expect(readSettings().subagentPanelOpenMode).toBe('tab');
    expect(readSettings().defaultAppendTiming).toBe('agent_idle');
    expect(readDesktopPrefs()).toEqual({
      notifications: false,
      closeToTray: true,
      updateChannel: 'stable',
      autoUpdate: 'notify',
      updateState: undefined,
      logLevel: 'warn',
      compatibility: {
        homeKind: 'kimi',
        customHome: undefined,
      },
      windowMode: 'switch',
    });

    localStorage.setItem('kiki.desktopPrefs', '{not-json');
    expect(readDesktopPrefs().closeToTray).toBe(true);
  });

  it('defaults reading to unlimited and applies device-only reading timeout edits independently of ordinary requests', () => {
    expect(readSettings().readingTimeoutSeconds).toBe(0);
    writeSettings({ readingTimeoutSeconds: 3600 });
    expect(readSettings()).toMatchObject({ readingTimeoutSeconds: 3600, requestTimeoutSeconds: 30 });
    writeSettings({ readingTimeoutSeconds: 0 });
    expect(readSettings().readingTimeoutSeconds).toBe(0);
    for (const readingTimeoutSeconds of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_484]) {
      localStorage.setItem('kiki.settings', JSON.stringify({ readingTimeoutSeconds }));
      expect(readSettings().readingTimeoutSeconds).toBe(0);
    }
  });

  it('persists request timeout seconds only within the supported range', () => {
    expect(validateRequestTimeoutSeconds(5)).toBeNull();
    expect(validateRequestTimeoutSeconds(600)).toBeNull();
    expect(validateRequestTimeoutSeconds(4)).toEqual({ key: 'val.requestTimeoutSeconds' });
    expect(validateRequestTimeoutSeconds(30.5)).toEqual({ key: 'val.requestTimeoutSeconds' });

    writeSettings({ requestTimeoutSeconds: 120 });
    expect(readSettings().requestTimeoutSeconds).toBe(120);
  });

  it('persists a valid default append timing and falls back on illegal values', () => {
    expect(isDefaultAppendTiming('agent_idle')).toBe(true);
    expect(isDefaultAppendTiming('subagents_done')).toBe(true);
    expect(isDefaultAppendTiming('tasks_done')).toBe(true);
    expect(isDefaultAppendTiming('immediate')).toBe(false);

    writeSettings({ defaultAppendTiming: 'tasks_done' });
    expect(readSettings().defaultAppendTiming).toBe('tasks_done');
    expect(settingsSnapshot().defaultAppendTiming).toBe('tasks_done');

    localStorage.setItem('kiki.settings', JSON.stringify({ defaultAppendTiming: 'all_quiet' }));
    expect(readSettings().defaultAppendTiming).toBe('agent_idle');
  });

  it('preserves an explicitly persisted quit choice', () => {
    writeDesktopPrefs({ closeToTray: false });
    expect(readDesktopPrefs().closeToTray).toBe(false);
  });

  it('persists desktop log levels and defaults invalid or missing values to warn', () => {
    expect(readDesktopPrefs().logLevel).toBe('warn');
    writeDesktopPrefs({ logLevel: 'trace' });
    expect(readDesktopPrefs().logLevel).toBe('trace');
    writeDesktopPrefs({ closeToTray: false });
    expect(readDesktopPrefs().logLevel).toBe('trace');
    localStorage.setItem('kiki.desktopPrefs', JSON.stringify({ logLevel: 'verbose' }));
    expect(readDesktopPrefs().logLevel).toBe('warn');
  });

  it('persists valid automatic update modes and falls back from invalid values', () => {
    expect(readDesktopPrefs().autoUpdate).toBe('notify');
    writeDesktopPrefs({ autoUpdate: 'install' });
    expect(readDesktopPrefs().autoUpdate).toBe('install');

    localStorage.setItem('kiki.desktopPrefs', JSON.stringify({
      notifications: false,
      autoUpdate: 'silent',
    }));
    expect(readDesktopPrefs().notifications).toBe(false);
    expect(readDesktopPrefs().autoUpdate).toBe('notify');
  });

  it('persists the cross-run update record per channel', () => {
    expect(readDesktopPrefs().updateState).toBeUndefined();

    writeDesktopPrefs({ updateState: { skipped: { stable: ['0.3.2'] }, snoozedUntil: 5_000, lastCheckedAt: 1_000 } });
    expect(readDesktopPrefs().updateState).toEqual({
      skipped: { stable: ['0.3.2'] },
      snoozedUntil: 5_000,
      lastCheckedAt: 1_000,
    });

    // A later skip on the beta channel leaves the stable list alone.
    writeDesktopPrefs({ updateState: { skipped: { stable: ['0.3.2'], beta: ['0.4.0'] } } });
    expect(readDesktopPrefs().updateState?.skipped).toEqual({ stable: ['0.3.2'], beta: ['0.4.0'] });
  });

  it('drops a malformed update record rather than trusting part of it', () => {
    localStorage.setItem('kiki.desktopPrefs', JSON.stringify({ updateState: 'yesterday' }));
    expect(readDesktopPrefs().updateState).toBeUndefined();

    localStorage.setItem('kiki.desktopPrefs', JSON.stringify({
      updateState: { skipped: { stable: ['0.3.2', 7] }, snoozedUntil: -1, lastCheckedAt: 'soon' },
    }));
    expect(readDesktopPrefs().updateState).toEqual({ skipped: { stable: ['0.3.2'] } });
  });

  it('keeps the update record when a whole native snapshot arrives without it', () => {
    writeDesktopPrefs({ updateState: { lastCheckedAt: 1_000 } });
    // The boot sync hands the native snapshot in whole; the native side does
    // not know this key, so a spread would erase it on every launch.
    writeDesktopPrefs({ notifications: true, closeToTray: true, updateChannel: 'stable', autoUpdate: 'notify', updateState: undefined, windowMode: 'switch' });
    expect(readDesktopPrefs().updateState?.lastCheckedAt).toBe(1_000);
  });

  it('maps the native window_mode spelling onto windowMode and validates it', () => {
    expect(readDesktopPrefs().windowMode).toBe('switch');
    writeDesktopPrefs({ window_mode: 'windows' } as Parameters<typeof writeDesktopPrefs>[0]);
    expect(readDesktopPrefs().windowMode).toBe('windows');
    expect(JSON.parse(localStorage.getItem('kiki.desktopPrefs') ?? '{}')).not.toHaveProperty('window_mode');
    writeDesktopPrefs({ windowMode: 'switch' });
    expect(readDesktopPrefs().windowMode).toBe('switch');
    localStorage.setItem('kiki.desktopPrefs', JSON.stringify({ window_mode: 'windows' }));
    expect(readDesktopPrefs().windowMode).toBe('windows');
    localStorage.setItem('kiki.desktopPrefs', JSON.stringify({ windowMode: 'tabs' }));
    expect(readDesktopPrefs().windowMode).toBe('switch');
  });

  it('defaults and validates the persisted Kimi Home selection', () => {
    expect(readDesktopPrefs().compatibility).toEqual({
      homeKind: 'kimi',
      customHome: undefined,
    });
    localStorage.setItem('kiki.desktopPrefs', JSON.stringify({
      compatibility: {
        homeKind: 'custom',
        customHome: 'C:\\compat-home',
      },
    }));
    expect(readDesktopPrefs().compatibility).toEqual({
      homeKind: 'custom',
      customHome: 'C:\\compat-home',
    });
    localStorage.setItem('kiki.desktopPrefs', JSON.stringify({
      compatibility: { homeKind: 'sessions' },
    }));
    expect(readDesktopPrefs().compatibility.homeKind).toBe('kimi');
  });

  it('persists restart-required fields until cleared after a verified restart', () => {
    expect(readRestartRequirement().required).toBe(false);
    markRestartRequired(['subagent']);
    const pending = markRestartRequired(['agents', 'subagent']);
    expect(pending.required).toBe(true);
    expect(pending.fields).toEqual(['subagent', 'agents']);
    expect(readRestartRequirement().changedAt).toBeTypeOf('string');
    clearRestartRequirement();
    expect(readRestartRequirement()).toEqual({ required: false, changedAt: undefined, fields: [] });
  });

  it('acknowledges the restart banner for this run without erasing the requirement', () => {
    clearRestartRequirement();
    const first = markRestartRequired(['subagent']);
    expect(isRestartRequirementAcknowledged(first)).toBe(false);
    acknowledgeRestartRequirement();
    expect(isRestartRequirementAcknowledged(restartRequirementSnapshot())).toBe(true);
    // The pending requirement itself survives for a later desktop restart.
    expect(readRestartRequirement().required).toBe(true);
    expect(readRestartRequirement().fields).toEqual(['subagent']);
    // A new change re-arms the banner even within this acknowledged run.
    let second = markRestartRequired(['modelCatalog']);
    while (second.changedAt === first.changedAt) second = markRestartRequired(['mcp']);
    expect(isRestartRequirementAcknowledged(second)).toBe(false);
    clearRestartRequirement();
  });

  it('rejects invalid server, desktop, provider, and experiment values before writes', () => {
    expect(validateServerDefaults('root')?.key).toBe('val.permissionMode');
    expect(validateServerDefaults('auto')).toBeNull();
    expect(validateDesktopConfigDraft({
      subagentTimeoutMs: 60_000,
    })).toBeNull();
    expect(validateDesktopConfigDraft({
      subagentTimeoutMs: 86_400_001,
    })?.key).toBe('val.timeoutMax');
    expect(validateProviderDraft(providerDraft({ baseUrl: 'file:///secret' }))?.key).toBe('val.baseUrlHttp');
    expect(validateProviderDraft(providerDraft({ apiKey: 'bad\nkey' }))?.key).toBe('val.apiKeyLineBreaks');
    expect(() => parseExperimentalFlags('{"flag":"yes"}')).toThrow('true or false');
    expect(parseExperimentalFlags('{"desktop_search":true}')).toEqual({ desktop_search: true });
    expect(() => parseAdvancedServerConfig('{"hooks":{}}')).toThrow('Unsupported');
    expect(() => parseAdvancedServerConfig('{"services":{}}')).toThrow('Unsupported');
    expect(() => parseAdvancedServerConfig('{"unknown":true}')).toThrow('Unsupported');
    // Hooks left the advanced editor in the batch-3 split: they only enter
    // through the Automation leaf's parseHooksJson, so a pasted hooks key is
    // rejected as an unsupported field like any other unknown domain.
    expect(() => parseAdvancedServerConfig('{"hooks":[],"background":{"max":2}}')).toThrow('Unsupported');
    expect(parseAdvancedServerConfig('{"background":{"max":2}}')).toEqual({
      permission: undefined,
      loop_control: undefined,
      background: { max: 2 },
    });
  });

  it('maps server-file settings to and from the kap-server config API shape', () => {
    const settings = serverFileSettingsFromConfig({
      providers: {},
      subagent: { timeoutMs: 60_000 },
      agents: { enabled: false },
      builtin_product_skills: false,
    });

    expect(serverFileSettingsPatch(settings)).toEqual({
      subagent: { timeout_ms: 60_000 },
      agents: { enabled: false },
      builtin_product_skills: false,
    });
  });

  it('maps every engine config domain from GET projection to the split narrow patches', () => {
    const draft = runtimeConfigDraftFromConfig({
      providers: {},
      cron: { debug: true, noJitter: true, noStale: false, disabled: false, manualTick: true, clock: 'utc', pollIntervalMs: null },
      thread_communication: { enabled: true },
      token_counting: { strategy: 'measured' },
      workspace_instance: { idleTtlMs: 120_000 },
      image: { maxEdgePx: 2048, readByteBudget: 4_000_000 },
      task: { maxRunningTasks: 4, keepAliveOnExit: true, printBackgroundMode: 'drain' },
      identity: { name: 'Example Agent', slug: 'example-agent', advertiseAsKimiCode: true },
      extra_agent_dirs: ['C:\\agents'],
      disabled_named_profiles: ['reviewer'],
      mcp: { startupTimeoutMs: 30_000, toolTimeoutMs: 60_000 },
      tools: { enabled: ['Read'], disabled: ['Bash'] },
    });
    draft.extraAgentDirs.push(' C:\\agents ', 'D:\\agents');
    draft.disabledNamedProfiles = [];

    // cron is env-driven and never persisted — no patch emits or replaces it.
    const taskPatch = taskRuntimePatch(draft.task);
    expect(taskPatch.task).toEqual(expect.objectContaining({ max_running_tasks: 4, keep_alive_on_exit: true, print_background_mode: 'drain' }));
    expect(taskPatch.replace_domains).toEqual(['task']);
    expect(taskPatch.cron).toBeUndefined();

    const resourcePatch = resourceLimitPatch(draft);
    expect(resourcePatch.workspace_instance).toEqual({ idle_ttl_ms: 120_000 });
    expect(resourcePatch.image).toEqual({ max_edge_px: 2048, read_byte_budget: 4_000_000 });
    expect(resourcePatch.replace_domains).toEqual(['workspace_instance', 'image']);

    expect(threadCommunicationPatch(true)).toEqual({
      thread_communication: { enabled: true },
      replace_domains: ['thread_communication'],
    });
    expect(threadAllowPatch(null)).toEqual({ thread_communication: { enabled: null } });
    expect(threadAllowPatch(false)).toEqual({ thread_communication: { enabled: false } });
    expect(tokenCountingPatch('estimated')).toEqual({
      token_counting: { strategy: 'estimated' },
      replace_domains: ['token_counting'],
    });
    // The notify-parent toggle shares the agents domain with the subagents
    // leaf's enabled flag, so it merges without replace_domains.
    expect(agentNotifyParentPatch(false)).toEqual({
      agents: { notify_parent: false },
    });

    const identityPatch = agentIdentityPatch(draft);
    expect(identityPatch.identity).toEqual({
      name: 'Example Agent',
      slug: 'example-agent',
      advertise_as_kimi_code: true,
    });
    expect(identityPatch.extra_agent_dirs).toEqual(['C:\\agents', 'D:\\agents']);
    expect(identityPatch.disabled_named_profiles).toEqual([]);
    expect(identityPatch.replace_domains).toEqual(['identity', 'extra_agent_dirs', 'disabled_named_profiles']);

    // mcp and tools belong to other leaves — none of the split patches sends
    // or replaces them, so a stale draft can never roll them back.
    const commPatches = [
      threadCommunicationPatch(draft.threadCommunicationEnabled),
      tokenCountingPatch(draft.tokenCountingStrategy),
      agentNotifyParentPatch(draft.agentsNotifyParent),
    ];
    for (const patch of [taskPatch, resourcePatch, ...commPatches, identityPatch]) {
      expect(patch.cron).toBeUndefined();
      expect(patch.mcp).toBeUndefined();
      expect(patch.tools).toBeUndefined();
      expect(patch.replace_domains ?? []).not.toContain('cron');
      expect(patch.replace_domains ?? []).not.toContain('mcp');
      expect(patch.replace_domains ?? []).not.toContain('tools');
    }
  });

  it('projects task engine defaults while preserving explicit overrides', () => {
    expect(runtimeConfigDraftFromConfig({}).task).toMatchObject({ bashAutoBackgroundOnTimeout: true, printBackgroundMode: 'steer' });
    expect(runtimeConfigDraftFromConfig({ task: { keepAliveOnExit: false } }).task.printBackgroundMode).toBe('steer');
    expect(runtimeConfigDraftFromConfig({ task: { keepAliveOnExit: true } }).task.printBackgroundMode).toBe('drain');
    for (const printBackgroundMode of ['exit', 'drain', 'steer'] as const) {
      expect(runtimeConfigDraftFromConfig({ task: { keepAliveOnExit: true, bashAutoBackgroundOnTimeout: false, printBackgroundMode } }).task)
        .toMatchObject({ bashAutoBackgroundOnTimeout: false, printBackgroundMode });
    }
  });

  it('clears saved task timeout fields without writing engine defaults', () => {
    const draft = runtimeConfigDraftFromConfig({ task: { printWaitCeilingS: 30, bashTaskTimeoutS: 45 } }).task;
    const patch = taskRuntimePatch({ ...draft, printWaitCeilingS: '', bashTaskTimeoutS: '' });
    expect(patch.task?.print_wait_ceiling_s).toBeUndefined();
    expect(patch.task?.bash_task_timeout_s).toBeUndefined();
    expect(JSON.parse(JSON.stringify(patch)).task).not.toHaveProperty('print_wait_ceiling_s');
    expect(JSON.parse(JSON.stringify(patch)).task).not.toHaveProperty('bash_task_timeout_s');
  });

  it('projects malformed config roots and lists to safe canonical defaults', () => {
    expect(runtimeConfigDraftFromConfig(null)).toMatchObject({
      extraAgentDirs: [],
      disabledNamedProfiles: [],
    });
    expect(toolPolicyDraftFromConfig(null)).toEqual({ toolsEnabled: [], toolsDisabled: [] });
    expect(serverFileSettingsFromConfig('not-a-config')).toMatchObject({
      subagent: { timeoutMs: 7_200_000 },
      agents: { enabled: true },
    });

    expect(() => runtimeConfigDraftFromConfig({
      extra_agent_dirs: { path: 'C:/agents' },
      disabled_named_profiles: 42,
      tools: { enabled: 'Read', disabled: { Bash: true } },
    })).not.toThrow();
    const draft = runtimeConfigDraftFromConfig({
      extra_agent_dirs: { path: 'C:/agents' },
      disabled_named_profiles: 'reviewer',
      tools: { enabled: 'Read', disabled: { Bash: true } },
    });
    expect(draft.extraAgentDirs).toEqual([]);
    expect(draft.disabledNamedProfiles).toEqual(['reviewer']);
    const policy = toolPolicyDraftFromConfig({ tools: { enabled: 'Read', disabled: { Bash: true } } });
    expect(policy.toolsEnabled).toEqual(['Read']);
    expect(policy.toolsDisabled).toEqual([]);
  });

  it('rejects invalid engine integers before config writes', () => {
    const draft = runtimeConfigDraftFromConfig({ providers: {} });
    draft.imageMaxEdgePx = '0';
    expect(() => resourceLimitPatch(draft)).toThrow(/Image maximum edge/);
    draft.imageMaxEdgePx = '';
    // The mcp domain upper bound is enforced by its own leaf's patch helper.
    expect(() => mcpTimeoutsPatch('2147483648', '')).toThrow(/MCP startup timeout/);
  });

  it('emits only fields changed from the last server echo', () => {
    const baseline = serverFileSettingsFromConfig({
      providers: {},
      subagent: { timeoutMs: 60_000 },
      agents: { enabled: true },
      builtin_product_skills: true,
    });
    const first = structuredClone(baseline);
    first.agents.enabled = false;
    const second = structuredClone(baseline);
    second.builtinProductSkills = false;

    expect(serverFileSettingsPatch(first, baseline)).toEqual({
      subagent: undefined,
      agents: { enabled: false },
      builtin_product_skills: undefined,
    });
    expect(serverFileSettingsPatch(second, baseline)).toEqual({
      subagent: undefined,
      agents: undefined,
      builtin_product_skills: false,
    });
  });

  it('appends native directory selections without dropping manual entries or duplicating paths', () => {
    expect(
      appendExtraSkillDirs(
        'C:\\skills\\shared\nD:\\team\\skills',
        ['D:\\team\\skills', 'E:\\personal\\skills', '  '],
      ),
    ).toBe('C:\\skills\\shared\nD:\\team\\skills\nE:\\personal\\skills');
  });

  it('prefills an editable provider draft with the stored inline key', () => {
    const draft = providerDraftFromCatalog(
      {
        id: 'example',
        type: 'openai',
        base_url: 'https://api.example.test/v1',
        default_model: 'example/chat',
        request_identity: { preset: 'kimi_code' },
        api_key: 'sk-stored',
        has_api_key: true,
        status: 'connected',
        models: ['example/chat'],
      },
      [{
        id: 'example/chat',
        provider_id: 'example',
        remote_id: 'chat',
        display_name: 'Example Chat',
        max_context_size: 128000,
        capabilities: ['reasoning'],
        support_efforts: ['high'],
        request_identity: { overrides: { client: { user_agent: 'host' } } },
      }],
    );
    expect(draft?.apiKey).toBe('sk-stored');
    expect(draft?.defaultModel).toBe('example/chat');
    expect(draft?.models[0]?.id).toBe('example/chat');
    expect(draft?.models[0]?.remoteId).toBe('chat');
    expect(draft?.requestIdentityChoice).toBe('kimi_code');
    expect(draft?.models[0]?.requestIdentityChoice).toBe('custom_overrides');
  });

  it('keeps a local alias whose text says nothing about the remote model', () => {
    const draft = providerDraftFromCatalog(
      {
        id: 'edge',
        type: 'openai',
        default_model: 'fast',
        has_api_key: true,
        status: 'connected',
        models: ['fast'],
      },
      [{
        id: 'fast',
        provider_id: 'edge',
        remote_id: 'vendor/model:v1',
        max_context_size: 200000,
      }],
    );
    expect(draft?.models[0]).toMatchObject({
      id: 'fast',
      remoteId: 'vendor/model:v1',
      displayName: '',
    });
    expect(draft?.defaultModel).toBe('fast');
    expect(providerDefaultRow(draft!)?.remoteId).toBe('vendor/model:v1');
  });

  it('keeps a connection with zero models editable', () => {
    const draft = providerDraftFromCatalog(
      {
        id: 'managed:kimi-code',
        type: 'kimi',
        has_api_key: false,
        status: 'connected',
        models: [],
      },
      [],
    );
    expect(draft).toMatchObject({ id: 'managed:kimi-code', models: [] });
    expect(validateProviderDraft(draft!)).toBeNull();
    expect(
      providerDraftFromCatalog(
        { id: 'mystery', type: 'mystery', has_api_key: false, status: 'unconfigured' },
        [],
      ),
    ).toBeNull();
  });

  it('enforces provider IDs only when creating a provider', () => {
    const legacy = providerDraft({ id: 'managed:kimi-code' });
    expect(validateProviderDraft(legacy)).toBeNull();
    expect(validateNewProviderDraft(legacy)?.key).toBe('val.providerId');
    expect(validateNewProviderDraft(providerDraft({ id: '!bad' }))?.key).toBe('val.providerId');
    expect(validateNewProviderDraft(providerDraft({ id: 'valid-provider_1' }))).toBeNull();
  });

  it('creates a connection with zero models and no default pointer', () => {
    const draft = providerDraft({ models: [], defaultModel: '' });
    expect(validateNewProviderDraft(draft)).toBeNull();
    expect(providerCreateBody(draft)).toMatchObject({ models: [], default_model: undefined });
    expect(validateNewProviderDraft({ ...draft, defaultModel: 'missing' })?.key).toBe('val.defaultModelInModels');
  });

  it('does not validate an unchanged dangling default when writing independent fields', () => {
    const baseline = providerDraft({ defaultModel: 'removed-alias' });
    const next = { ...baseline, apiKey: 'YOUR_API_KEY', baseUrl: 'https://fixed.example.test/v1' };
    expect(validateProviderDraft(next, baseline)).toBeNull();
    expect(providerPatchBody(next, baseline)).toEqual({ api_key: 'YOUR_API_KEY', base_url: 'https://fixed.example.test/v1' });
    expect(validateProviderDraft({ ...baseline, defaultModel: 'another-missing' }, baseline)?.key).toBe('val.defaultModelInModels');
    expect(validateProviderDraft({ ...baseline, defaultModel: '' }, baseline)).toBeNull();
    expect(providerPatchBody({ ...baseline, defaultModel: '' }, baseline)).toEqual({ default_model: null });
    expect(validateProviderDraft({ ...baseline, defaultModel: 'example/chat' }, baseline)).toBeNull();
    expect(providerPatchBody({ ...baseline, defaultModel: 'example/chat' }, baseline)).toEqual({ default_model: 'example/chat' });
  });

  it('validates only edited fields of existing providers and model rows, but validates new rows fully', () => {
    const baseline = providerDraft({
      baseUrl: 'legacy-endpoint',
      defaultModel: 'removed-alias',
      requestIdentityChoice: 'custom_overrides',
      requestIdentityOverridesJson: '{',
      imageAcceptedTypes: [],
      models: [{
        ...providerDraft().models[0]!, remoteId: '', maxContextSize: -1,
        requestIdentityChoice: 'custom_overrides', requestIdentityOverridesJson: '{', imageAcceptedTypes: [],
      }],
    });
    const next = { ...baseline, apiKey: 'YOUR_API_KEY' };
    expect(validateProviderDraft(next, baseline)).toBeNull();
    expect(providerPatchBody(next, baseline)).toEqual({ api_key: 'YOUR_API_KEY' });
    const renamed = { ...baseline.models[0]!, displayName: 'Renamed' };
    expect(validateProviderDraft({ ...baseline, models: [renamed] }, baseline)).toBeNull();
    expect(modelPatchBody(renamed, baseline.models[0]!)).toEqual({ display_name: 'Renamed' });
    expect(validateProviderDraft({ ...next, baseUrl: 'another-invalid' }, baseline)?.key).toBe('val.baseUrlAbsolute');
    expect(validateProviderDraft({ ...next, requestIdentityOverridesJson: '[1]' }, baseline)?.key).toBe('val.requestIdentityOverridesInvalid');
    expect(validateProviderDraft({ ...next, imageAcceptedTypes: ['invalid'] }, baseline)?.key).toBe('val.imageMime');
    expect(validateProviderDraft({ ...next, models: [{ ...renamed, remoteId: ' ' }] }, baseline)?.key).toBe('val.modelIdEmpty');
    expect(validateProviderDraft({ ...next, models: [{ ...renamed, maxContextSize: -2 }] }, baseline)?.key).toBe('val.modelContextSize');
    expect(validateProviderDraft({ ...next, models: [{ ...renamed, requestIdentityOverridesJson: '[1]' }] }, baseline)?.key).toBe('val.modelRequestIdentity');
    expect(validateProviderDraft({ ...next, models: [{ ...renamed, id: '' }] }, baseline)?.key).toBe('val.modelIdEmpty');
  });

  it('maps authored image policies and preserves model inheritance', () => {
    const draft = providerDraftFromCatalog(
      {
        id: 'example',
        type: 'openai',
        images: {
          accepted_types: ['image/jpeg', 'image/png'],
          convert_unsupported: 'auto',
        },
        has_api_key: true,
        status: 'connected',
      },
      [{
        id: 'example/chat',
        provider_id: 'example',
        remote_id: 'chat',
        max_context_size: 128000,
      }],
    )!;
    expect(draft.imageAcceptedTypes).toEqual(['image/jpeg', 'image/png']);
    expect(draft.models[0]).toMatchObject({
      imageAcceptedTypes: null,
      imageConvertUnsupported: null,
    });
    expect(providerCreateBody(draft)).toMatchObject({
      images: {
        accepted_types: ['image/jpeg', 'image/png'],
        convert_unsupported: 'auto',
      },
      models: [expect.not.objectContaining({ images: expect.anything() })],
    });
  });

  it('validates image conversion targets and builds sparse image patches', () => {
    const baseline = providerDraft();
    expect(validateProviderDraft(providerDraft({ imageAcceptedTypes: [] }))?.key)
      .toBe('val.imageAcceptedTypesEmpty');
    expect(validateProviderDraft(providerDraft({
      imageAcceptedTypes: ['image/webp'],
      imageConvertUnsupported: 'png',
    }))?.key).toBe('val.imageConversionTarget');
    expect(validateProviderDraft(providerDraft({
      imageAcceptedTypes: ['image/webp'],
      imageConvertUnsupported: 'auto',
    }))?.key).toBe('val.imageAutoTarget');
    expect(providerPatchBody(providerDraft({
      imageAcceptedTypes: ['image/png'],
      imageConvertUnsupported: 'png',
    }), baseline)).toEqual({
      images: {
        accepted_types: ['image/png'],
        convert_unsupported: 'png',
      },
    });
    expect(providerPatchBody(providerDraft({
      imageAcceptedTypes: null,
      imageConvertUnsupported: null,
    }), providerDraft({
      imageAcceptedTypes: ['image/png'],
      imageConvertUnsupported: 'png',
    }))).toEqual({ images: null });
  });

  it('round-trips the OpenCode identity through a settings layer', () => {
    const policy = { preset: 'opencode_compatible' as const };
    const draft = requestIdentityLayerDraftFromPolicy(policy);
    expect(draft.requestIdentityChoice).toBe('opencode_compatible');
    expect(requestIdentityPolicyFromDraft(draft)).toEqual(policy);
  });

  it('maps authored request identity layers to the wire without inventing presets', () => {
    const draft = providerDraftFromCatalog(
      {
        id: 'example',
        type: 'openai_responses',
        request_identity: {
          preset: 'codex_compatible',
          overrides: { client: { user_agent: 'codex' } },
        },
        has_api_key: true,
        status: 'connected',
        models: ['example/chat'],
      },
      [{
        id: 'example/chat',
        provider_id: 'example',
        remote_id: 'chat',
        max_context_size: 128000,
        request_identity: { overrides: { request: { logical_id: 'turn' } } },
      }],
    );
    expect(draft?.requestIdentityChoice).toBe('codex_compatible');
    expect(draft?.models[0]?.requestIdentityChoice).toBe('custom_overrides');
    expect(JSON.parse(draft?.requestIdentityOverridesJson ?? '')).toEqual({
      client: { user_agent: 'codex' },
    });

    const body = providerCreateBody(draft!);
    expect(body.request_identity).toEqual({
      preset: 'codex_compatible',
      overrides: { client: { user_agent: 'codex' } },
    });
    expect(body.models).toEqual([
      expect.objectContaining({
        remote_id: 'chat',
        request_identity: { overrides: { request: { logical_id: 'turn' } } },
      }),
    ]);
  });

  it('rejects malformed advanced request identity JSON without saving', () => {
    expect(
      validateProviderDraft(
        providerDraft({
          requestIdentityChoice: 'grok_build_compatible',
          requestIdentityOverridesJson: '{',
        }),
      )?.key,
    ).toBe('val.requestIdentityJson');
    expect(validateProviderDraft(providerDraft({
      requestIdentityChoice: 'custom_overrides',
      requestIdentityOverridesJson: '',
    }))?.key).toBe('val.requestIdentityOverridesRequired');
    expect(validateProviderDraft(providerDraft({
      requestIdentityChoice: 'custom_overrides',
      requestIdentityOverridesJson: '{}',
    }))?.key).toBe('val.requestIdentityOverridesInvalid');
  });

  it('builds a sparse connection patch that never carries a model list', () => {
    const baseline = providerDraft();
    const edited = providerDraft({ baseUrl: 'https://api.example.test/v2' });
    expect(providerPatchBody(edited, baseline)).toEqual({
      base_url: 'https://api.example.test/v2',
    });
    expect(providerPatchBody(baseline, baseline)).toBeNull();

    const cleared = providerPatchBody(
      providerDraft({ baseUrl: '', defaultModel: '' }),
      baseline,
    );
    expect(cleared).toMatchObject({ base_url: null, default_model: null });

    expect(
      providerPatchBody(providerDraft({ defaultModel: 'example/chat' }), providerDraft({ defaultModel: '' }))?.[
        'default_model'
      ],
    ).toBe('example/chat');

    expect(providerPatchBody(providerDraft({ apiKey: 'sk-new' }), baseline)?.['api_key'])
      .toBe('sk-new');
    const stored = providerDraft({ apiKey: 'sk-stored' });
    expect(providerPatchBody(stored, stored)).toBeNull();
    expect(providerPatchBody({ ...stored, baseUrl: 'https://api.example.test/v2' }, stored))
      .toEqual({ base_url: 'https://api.example.test/v2' });
    expect(providerPatchBody({ ...stored, apiKey: 'sk-replaced' }, stored)).toEqual({ api_key: 'sk-replaced' });
    expect(providerPatchBody({ ...stored, apiKey: '' }, stored)).toEqual({ api_key: '' });
    expect(providerPatchBody(providerDraft({ clearApiKey: true }), baseline)?.['api_key'])
      .toBe('');
  });

  it('builds a sparse model patch that leaves unlisted fields alone', () => {
    const baseline = providerDraft().models[0]!;
    expect(modelPatchBody(baseline, baseline)).toBeNull();
    expect(modelPatchBody({ ...baseline, displayName: 'Renamed' }, baseline)).toEqual({
      display_name: 'Renamed',
    });
    expect(modelPatchBody({ ...baseline, maxContextSize: 0 }, baseline)).toEqual({
      max_context_size: null,
    });
    expect(modelPatchBody({ ...baseline, remoteId: 'vendor/model:v2' }, baseline)).toEqual({
      remote_id: 'vendor/model:v2',
    });
    expect(modelPatchBody({ ...baseline, capabilities: [] }, baseline)).toEqual({
      capabilities: [],
    });
    expect(
      modelPatchBody({ ...baseline, requestIdentityChoice: 'none' }, baseline),
    ).toEqual({ request_identity: { preset: 'none' } });
    expect(modelPatchBody({ ...baseline, remoteId: '' }, baseline)).toBeNull();
  });

  it('serializes each model autoCompact independently and keeps omission as inheritance', () => {
    const initial = providerDraft();
    const row = initial.models[0]!;
    const draft = providerDraft({ models: [
      { ...row, remoteId: 'chat', autoCompact: 120000 },
      { ...row, remoteId: 'other', autoCompact: 90000 },
      { ...row, remoteId: 'inherited' },
    ] });
    const body = JSON.parse(JSON.stringify(providerCreateBody(draft)));
    expect(body.models).toEqual([
      expect.objectContaining({ remote_id: 'chat', auto_compact: 120000 }),
      expect.objectContaining({ remote_id: 'other', auto_compact: 90000 }),
      expect.not.objectContaining({ auto_compact: expect.anything() }),
    ]);
    expect(initial.models[0]!.autoCompact).toBeUndefined();
    expect(modelCreateBody('example', draft.models[0]!).auto_compact).toBe(120000);
    expect(modelCreateBody('example', row).auto_compact).toBeUndefined();
    expect(isProviderDraftDirty(providerDraft({ models: [{ ...row, autoCompact: 120000 }] }), initial)).toBe(true);
  });

  it('reads authored auto_compact back and patches only changed targets without flattening usage', () => {
    const draft = providerDraftFromCatalog({
      id: 'example', type: 'openai', has_api_key: false, status: 'unconfigured', models: ['example/chat', 'example/other'],
    }, [
      { id: 'example/chat', provider_id: 'example', remote_id: 'chat', max_context_size: 200000, auto_compact: 120000 },
      { id: 'example/other', provider_id: 'example', remote_id: 'other', max_context_size: 200000 },
    ])!;
    const row = draft.models[0]!;
    expect(row.autoCompact).toBe(120000);
    expect(draft.models[1]!.autoCompact).toBeUndefined();
    expect(modelPatchBody(row, row)).toBeNull();
    expect(modelPatchBody({ ...row, displayName: 'Renamed' }, row)).toEqual({ display_name: 'Renamed' });
    expect(modelPatchBody({ ...row, autoCompact: 110000 }, row)).toEqual({ auto_compact: 110000 });
    expect(modelPatchBody({ ...row, autoCompact: undefined }, row)).toEqual({ auto_compact: null });
    expect(providerPatchBody({ ...draft, models: [{ ...row, autoCompact: 110000 }, draft.models[1]!] }, draft)).toBeNull();
  });

  it('omits inherited provider and model layers when creating', () => {
    const body = providerCreateBody(providerDraft());
    expect(body.request_identity).toBeUndefined();
    expect(body.models).toEqual([
      expect.not.objectContaining({ request_identity: expect.anything() }),
    ]);
    expect(body.default_model).toBe('chat');
    expect(body.models?.[0]).toMatchObject({ remote_id: 'chat', max_context_size: 128000 });
  });

  it('creates a model row with the suggested alias only when the name differs', () => {
    const row = providerDraft().models[0]!;
    expect(modelCreateBody('example', row)).toMatchObject({
      provider_id: 'example',
      remote_id: 'chat',
      id: undefined,
    });
    expect(modelCreateBody('example', { ...row, id: 'example/daily' })).toMatchObject({
      id: 'example/daily',
    });
    expect(modelCreateBody('example', { ...row, id: 'example/chat' })).toMatchObject({
      id: undefined,
    });
  });

  it('maps global authored layers and rejects empty override-only layers', () => {
    const overrideOnly = requestIdentityLayerDraftFromPolicy({
      overrides: { cache: { source: 'session' } },
    });
    expect(overrideOnly.requestIdentityChoice).toBe('custom_overrides');
    expect(requestIdentityPolicyFromDraft(overrideOnly)).toEqual({
      overrides: { cache: { source: 'session' } },
    });
    expect(requestIdentityLayerDraftFromPolicy(undefined)).toEqual({
      requestIdentityChoice: 'inherit',
      requestIdentityOverridesJson: '',
    });
    expect(() => requestIdentityPolicyFromDraft({
      requestIdentityChoice: 'custom_overrides',
      requestIdentityOverridesJson: '{}',
    })).toThrow(/at least one supported field/);
  });

  it('tracks provider and model request identity edits as dirty', () => {
    const initial = providerDraft();
    expect(isProviderDraftDirty(providerDraft({ requestIdentityChoice: 'none' }), initial)).toBe(true);
    expect(isProviderDraftDirty(providerDraft({
      requestIdentityChoice: 'custom_overrides',
      requestIdentityOverridesJson: '{"client":{"user_agent":"host"}}',
    }), initial)).toBe(true);
    const modelEdited = providerDraft();
    modelEdited.models[0]!.requestIdentityChoice = 'kimi_code';
    expect(isProviderDraftDirty(modelEdited, initial)).toBe(true);
    expect(isProviderDraftDirty(providerDraft(), initial)).toBe(false);
  });
});

describe('provider templates, chips, and dirty tracking', () => {
  it('falls back to a generic template for wire types without a card', () => {
    expect(providerTemplateFor('anthropic').defaultContextSize).toBe(200000);
    expect(providerTemplateFor('kimi').baseUrl).toContain('moonshot');
    expect(providerTemplateFor('vertexai').baseUrl).toBe('');
    expect(providerTemplateFor('vertexai').defaultContextSize).toBe(128000);
  });

  it('normalizes chip lists: trim, drop empties, dedupe in order', () => {
    expect(normalizeTags([' reasoning ', '', 'vision', 'reasoning', '  '])).toEqual(['reasoning', 'vision']);
    expect(normalizeTags([])).toEqual([]);
  });

  it('tracks dirty state across every draft field, including chip edits', () => {
    const initial = providerDraft();
    expect(isProviderDraftDirty(providerDraft(), initial)).toBe(false);
    expect(isProviderDraftDirty(providerDraft({ baseUrl: 'https://other.test/v1' }), initial)).toBe(true);
    expect(isProviderDraftDirty(providerDraft({ apiKey: 'sk-new' }), initial)).toBe(true);
    expect(isProviderDraftDirty(providerDraft({ clearApiKey: true }), initial)).toBe(true);
    const capsEdited = providerDraft();
    capsEdited.models[0]!.capabilities = ['reasoning', 'vision'];
    expect(isProviderDraftDirty(capsEdited, initial)).toBe(true);
    const effortsReordered = providerDraft();
    effortsReordered.models[0]!.supportEfforts = ['high', 'low'];
    expect(isProviderDraftDirty(effortsReordered, initial)).toBe(true);
    const modelRemoved = providerDraft({ models: [] });
    expect(isProviderDraftDirty(modelRemoved, initial)).toBe(true);
  });
});

describe('model capability defaults', () => {
  /**
   * The default exists for a model nothing has been decided about. It is not a
   * correction: a model whose capabilities were explicitly configured to
   * something narrower keeps exactly that, including an empty list, which is a
   * decision and must survive a round trip rather than being re-defaulted.
   */
  const catalogModel = (capabilities: string[] | undefined) => ({
    id: 'kimi-code/kimi-k2',
    provider_id: 'kimi-code',
    remote_id: 'kimi-k2',
    max_context_size: 200_000,
    support_efforts: [],
    capabilities,
  }) as unknown as Parameters<typeof providerModelDraftFromCatalog>[0];

  it('defaults a model that carries no capabilities at all', () => {
    expect(providerModelDraftFromCatalog(catalogModel(undefined)).capabilities)
      .toEqual([...DEFAULT_MODEL_CAPABILITIES]);
    expect(DEFAULT_MODEL_CAPABILITIES).toContain('thinking');
    expect(DEFAULT_MODEL_CAPABILITIES).toContain('tool_use');
  });

  it('keeps an explicitly empty capability list, which is a decision', () => {
    expect(providerModelDraftFromCatalog(catalogModel([])).capabilities).toEqual([]);
  });

  it('keeps a narrower explicit list without adding to it', () => {
    expect(providerModelDraftFromCatalog(catalogModel(['image_in'])).capabilities)
      .toEqual(['image_in']);
  });

  it('lets a saved empty list round-trip instead of being re-defaulted', () => {
    const draft = providerModelDraftFromCatalog(catalogModel([]));
    // Reading the model back gives an empty list, not the default; and an
    // unchanged draft produces no patch at all, so nothing re-adds the default
    // on save. Clearing a non-empty stored list is still an explicit `[]`.
    const emptied = providerModelDraftFromCatalog(catalogModel(['thinking', 'tool_use']));
    expect(modelPatchBody(draft, emptied)).toEqual({ capabilities: [] });
  });
});

describe('remote /models probe', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('builds the models URL and per-protocol auth headers', () => {
    expect(remoteModelsUrl('https://api.example.test/v1/')).toBe('https://api.example.test/v1/models');
    expect(remoteModelsHeaders('openai', 'sk-1')['Authorization']).toBe('Bearer sk-1');
    expect(remoteModelsHeaders('kimi', ' ')['Authorization']).toBeUndefined();
    const anthropic = remoteModelsHeaders('anthropic', 'key-9');
    expect(anthropic['x-api-key']).toBe('key-9');
    expect(anthropic['anthropic-version']).toBe('2023-06-01');
    expect(anthropic['Authorization']).toBeUndefined();
  });

  it('parses openai, anthropic, and google listing shapes', () => {
    expect(parseRemoteModels({ object: 'list', data: [{ id: 'gpt-a' }, { id: 'gpt-a' }, { id: ' ' }, 'gpt-b', 42] }))
      .toEqual(['gpt-a', 'gpt-b']);
    expect(parseRemoteModels({ data: [{ id: 'claude-a', display_name: 'Claude A' }] })).toEqual(['claude-a']);
    expect(parseRemoteModels({ models: [{ name: 'models/gemini-a' }, { name: 'gemini-b' }] }))
      .toEqual(['gemini-a', 'gemini-b']);
    expect(() => parseRemoteModels({ items: [] })).toThrow(/model listing/);
    expect(() => parseRemoteModels(null)).toThrow(/model listing/);
  });

  it('maps fetched ids to drafts with the protocol default context size', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.example.test/v1/models');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('key-9');
      return new Response(JSON.stringify({ data: [{ id: 'claude-a' }, { id: 'claude-b' }] }), { status: 200 });
    }));
    const models = await fetchRemoteModels({ type: 'anthropic', baseUrl: 'https://api.example.test/v1', apiKey: 'key-9' });
    expect(models.map((model) => model.remoteId)).toEqual(['claude-a', 'claude-b']);
    expect(models[0]?.maxContextSize).toBe(200000);
    expect(models[0]?.id).toBe('');
    expect(models[0]?.capabilities).toEqual([]);
  });

  it('rejects control characters before fetch and hides echoed credentials in failures', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchRemoteModels({ type: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'secret\nsecond' }))
      .rejects.toThrow(/line breaks|control characters/);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('secret-echo-value', { status: 401 }));
    const rejected = await fetchRemoteModels({ type: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'secret-echo-value' }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toMatch(/credentials were rejected \(HTTP 401\)/);
    expect((rejected as Error).cause).toEqual(new Error('HTTP 401'));
    fetchMock.mockRejectedValueOnce(new TypeError('transport echoed secret-echo-value'));
    const network = await fetchRemoteModels({ type: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'secret-echo-value' }).catch((error: unknown) => error);
    expect(network).toBeInstanceOf(Error);
    expect((network as Error).message).toMatch(/network or browser CORS/);
    expect(((network as Error).cause as Error).name).toBe('TypeError');
    expect(String(network) + String((network as Error).cause)).not.toContain('secret-echo-value');
  });

  it('rejects bad input and upstream failures with localized or HTTP errors', async () => {
    await expect(fetchRemoteModels({ type: 'openai', baseUrl: ' ', apiKey: '' }))
      .rejects.toThrow(/Fill in the Base URL/);
    await expect(fetchRemoteModels({ type: 'openai', baseUrl: 'not a url', apiKey: '' }))
      .rejects.toThrow(/absolute URL/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    await expect(fetchRemoteModels({ type: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: '' }))
      .rejects.toThrow(/did not return any models/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"nope"}', { status: 401 })));
    await expect(fetchRemoteModels({ type: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'bad' }))
      .rejects.toThrow(/credentials were rejected \(HTTP 401\)/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    await expect(fetchRemoteModels({ type: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'bad' }))
      .rejects.toThrow(/endpoint was not found \(HTTP 404\)/);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('request aborted', 'AbortError'); }));
    const timeout = await fetchRemoteModels({ type: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'bad' }).catch((error: unknown) => error);
    expect((timeout as Error).message).toMatch(/timed out after 15000ms/);
    expect(((timeout as Error).cause as Error).name).toBe('AbortError');
  });
});

function registeredBuiltinFlags(): { id: string; defaultEnabled: boolean; owner: string }[] {
  const root = new URL('../../../../', import.meta.url);
  const flags: { id: string; defaultEnabled: boolean; owner: string }[] = [];
  for (const owner of globSync('packages/{agent-core-v2,kap-server}/src/**/*.ts', { cwd: fileURLToPath(root) })) {
    const source = readFileSync(new URL(owner.replaceAll('\\', '/'), root), 'utf8');
    if (!source.includes('registerFlagDefinition')) continue;
    const file = ts.createSourceFile(owner, source, ts.ScriptTarget.Latest, true);
    const variables = new Map<string, ts.Expression>();
    const registrations = new Set<string>(['registerFlagDefinition']);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        variables.set(node.name.text, node.initializer);
      }
      if (ts.isImportSpecifier(node) && node.propertyName?.text === 'registerFlagDefinition') registrations.add(node.name.text);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
    const resolve = (expression: ts.Expression | undefined): ts.Expression | undefined => {
      if (expression === undefined) return undefined;
      if (ts.isIdentifier(expression)) {
        const value = variables.get(expression.text);
        return value === expression ? undefined : resolve(value);
      }
      if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression)) return resolve(expression.expression);
      return expression;
    };
    for (const call of calls.filter((node) => registrations.has((node.expression as ts.Identifier).text))) {
      const definition = resolve(call.arguments[0]);
      if (definition === undefined || !ts.isObjectLiteralExpression(definition)) throw new Error(`Cannot inspect flag registration in ${owner}`);
      const property = (name: string) => resolve(definition.properties.find((node): node is ts.PropertyAssignment =>
        ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === name)?.initializer);
      const id = property('id');
      const defaultEnabled = property('default');
      if (id === undefined || !ts.isStringLiteral(id) || defaultEnabled === undefined ||
        (defaultEnabled.kind !== ts.SyntaxKind.TrueKeyword && defaultEnabled.kind !== ts.SyntaxKind.FalseKeyword)) throw new Error(`Cannot inspect flag id/default in ${owner}`);
      flags.push({ id: id.text, defaultEnabled: defaultEnabled.kind === ts.SyntaxKind.TrueKeyword, owner });
    }
  }
  return flags;
}

describe('experimental flag homes', () => {
  it('covers every distributed builtin registration with bilingual copy and a default-on capability', () => {
    const flags = registeredBuiltinFlags();
    expect(flags.length).toBeGreaterThan(0);
    expect(new Set(flags.map((flag) => flag.id)).size).toBe(flags.length);
    expect(EXPERIMENTAL_FLAG_HOMES.map((home) => home.id).toSorted()).toEqual(flags.map((flag) => flag.id).toSorted());
    for (const flag of flags) {
      const home = experimentalFlagHome(flag.id)!;
      expect(flag.defaultEnabled, `${flag.id} in ${flag.owner}: default off needs an explicit human requirement`).toBe(true);
      for (const locale of ['en', 'zh'] as const) {
        for (const key of [home.labelKey, home.descriptionKey]) {
          expect(Object.hasOwn(locale === 'en' ? en : zh, key), `${locale}: ${flag.id} ${key}`).toBe(true);
          const text = translate(locale, key);
          expect(text, `${locale}: ${flag.id}`).not.toBe(key);
          expect(text.trim(), `${locale}: ${flag.id}`).not.toBe('');
          expect(text).not.toBe(translate(locale, 'st.exp.unknown.name'));
          expect(text).not.toBe(translate(locale, 'st.exp.unknown.desc'));
        }
      }
    }
  });

  it('describes indexing and Recipes without promising replay, role permissions or a fixed build time', () => {
    for (const locale of ['en', 'zh'] as const) {
      const search = translate(locale, 'st.exp.desktopSearch.desc');
      expect(search).toContain('2 GiB');
      expect(search).not.toMatch(/20[–-]30/);
      expect(translate(locale, 'st.exp.readModel.name')).toBe(locale === 'en' ? 'Session list index' : '会话列表索引');
      expect(translate(locale, 'st.exp.readModel.desc')).not.toMatch(/replay|回放/);
      expect(translate(locale, 'st.exp.recipes.desc')).toContain(locale === 'en' ? 'model prompts and parameters' : '模型提示与参数');
      expect(translate(locale, 'st.exp.recipes.desc')).toContain(locale === 'en' ? 'confirmation once during installation' : '安装时确认一次');
    }
  });

  it('homes each flag on a real settings page, with the owners the IA asked for', () => {
    const sections = new Set(SETTINGS_SECTIONS.map((section) => section.id));
    for (const home of EXPERIMENTAL_FLAG_HOMES) {
      expect(sections.has(home.section), home.id).toBe(true);
      expect(home.section, home.id).not.toBe('labs');
    }
    expect(new Set(EXPERIMENTAL_FLAG_HOMES.map((home) => home.id)).size).toBe(EXPERIMENTAL_FLAG_HOMES.length);
    expect(experimentalSectionForFlag('agent-profile-routes')).toBe('agents');
    expect(experimentalSectionForFlag('external_delegation_mcp')).toBe('extensions');
    expect(experimentalSectionForFlag('subagent_release_idle')).toBe('agents');
    expect(experimentalSectionForFlag('some_vendor_flag')).toBe('developer');
  });

  it('localizes local session continuation in Sessions while keeping the unknown fallback', () => {
    expect(experimentalFlagHome('usage_export')).toBeUndefined();
    expect(experimentalFlagHome('plugin_import')).toBeUndefined();
    expect(experimentalSectionForFlag('plugin_import')).toBe(EXPERIMENTAL_FALLBACK_SECTION);
    const home = experimentalFlagHome('local_session_resume')!;
    expect(home.section).toBe('sessions');
    expect(home.effect).toBe('now');
    expect(translate('en', home.labelKey)).toBe('Continue local external sessions');
    expect(translate('en', home.descriptionKey)).toBe('Continue existing Claude Code and Codex sessions on this machine.');
    expect(translate('zh', home.labelKey)).toBe('接续本机外部会话');
    expect(translate('zh', home.descriptionKey)).toBe('接续本机已有的 Claude Code 和 Codex 会话。');
    expect(experimentalFlagHome('some_vendor_flag')).toBeUndefined();
  });
});

describe('settings search index', () => {
  const t = (key: I18nKey): string => translate('en', key);
  const labels = { general: 'General', ai: 'Models & providers' };

  it('matches card titles, section labels, and hint keywords', () => {
    const index = buildSettingsSearchIndex(labels, t);
    expect(index.length).toBeGreaterThan(10);
    expect(searchSettings(index, 'language')[0]?.cardId).toBe('st-card-language');
    expect(searchSettings(index, 'Models').some((hit) => hit.section === 'ai')).toBe(true);
    expect(searchSettings(index, 'experimental feature').some((hit) => hit.cardId === 'st-card-labs')).toBe(true);
    expect(searchSettings(index, 'Task board').some((hit) => hit.cardId === 'st-card-agent-board')).toBe(false);
    expect(searchSettings(index, 'plan mode').some((hit) => hit.section === 'sessions' && hit.cardId === 'st-card-defaults')).toBe(true);
    expect(searchSettings(index, 'session titles').some((hit) => hit.section === 'sessions' && hit.cardId === 'st-card-session-title')).toBe(true);
    expect(searchSettings(index, 'permission mode').some((hit) => hit.section === 'permissions' && hit.cardId === 'st-card-permission-defaults')).toBe(true);
    // A flag is found on its feature page's Experimental rows, not only in Labs.
    expect(searchSettings(index, 'task_wait').some((hit) => hit.section === 'sessions' && hit.cardId === 'st-card-exp-sessions')).toBe(true);
    expect(searchSettings(index, 'local_session_resume').some((hit) => hit.section === 'sessions' && hit.cardId === 'st-card-exp-sessions')).toBe(true);
    expect(searchSettings(index, 'Continue local external sessions').some((hit) => hit.cardId === 'st-card-exp-sessions')).toBe(true);
    const chinese = buildSettingsSearchIndex({}, (key) => translate('zh', key));
    expect(searchSettings(chinese, '接续本机外部会话').some((hit) => hit.section === 'sessions' && hit.cardId === 'st-card-exp-sessions')).toBe(true);
    expect(searchSettings(index, 'usage_export')).toEqual([]);
    expect(searchSettings(index, 'release idle subagents').some((hit) => hit.section === 'agents' && hit.cardId === 'st-card-exp-agents')).toBe(true);
    expect(searchSettings(index, 'desktop_search').find((hit) => hit.cardId === 'st-card-exp-search')?.tab).toBe('advanced');
    expect(searchSettings(index, 'AgentNotify')[0]?.cardId).toBe('st-card-agent-messaging');
    expect(searchSettings(index, 'denied subagent models').some((hit) => hit.cardId === 'st-card-subagents')).toBe(true);
    expect(searchSettings(index, 'pinned model alias').some((hit) => hit.cardId === 'st-card-main-agents')).toBe(true);
    expect(searchSettings(index, 'Agents').some((hit) => hit.cardId === 'st-card-main-agents')).toBe(true);
    expect(searchSettings(index, t('st.spaces.ownChoices')).some((hit) => hit.cardId === 'st-card-space-overrides')).toBe(true);
    expect(searchSettings(index, 'subagent')[0]?.section).toBe('agents');
    expect(searchSettings(index, '  ')).toEqual([]);
    expect(searchSettings(index, 'zzzz-no-such-setting')).toEqual([]);
  });

  it('points every indexed card at a real section', () => {
    const sections = new Set(SETTINGS_SECTIONS.map((section) => section.id));
    for (const entry of SETTINGS_SEARCH_SPEC) {
      expect(sections.has(entry.section)).toBe(true);
    }
    expect(new Set(SETTINGS_SEARCH_SPEC.map((entry) => entry.cardId)).size)
      .toBe(SETTINGS_SEARCH_SPEC.length);
  });

  it('assigns every ai-entry card to the tab that mounts it', () => {
    const aiEntries = SETTINGS_SEARCH_SPEC.filter((entry) => entry.section === 'ai');
    expect(aiEntries.length).toBeGreaterThan(0);
    for (const entry of aiEntries) {
      expect(entry.tab, entry.cardId).toBeDefined();
      expect(entry.tab).toBe(aiTabForCard(entry.cardId));
    }
    // Every tab owns at least one searchable card; no orphan tabs.
    for (const tab of AI_SETTINGS_TABS) {
      expect(aiEntries.some((entry) => entry.tab === tab), tab).toBe(true);
    }
  });

  it('assigns every search-entry card to the tab that mounts it', () => {
    const searchEntries = SETTINGS_SEARCH_SPEC.filter((entry) => entry.section === 'search');
    expect(searchEntries.length).toBeGreaterThan(0);
    // A hit without the tab lands on the default sub-page and flashes a card
    // the page keeps hidden, so every one of these targets must carry its tab.
    for (const entry of searchEntries) {
      expect(entry.tab, entry.cardId).toBeDefined();
      expect(entry.tab).toBe(searchTabForCard(entry.cardId));
    }
    for (const tab of SEARCH_SETTINGS_TABS) {
      expect(searchEntries.some((entry) => entry.tab === tab), tab).toBe(true);
    }
    expect(searchTabForCard('st-card-search-index')).toBe('advanced');
    expect(searchTabForCard('st-card-search-unknown')).toBeUndefined();
  });

  it('assigns every access-from-elsewhere card to the tab that mounts it', () => {
    const entries = SETTINGS_SEARCH_SPEC.filter((entry) => entry.section === 'connection-services');
    for (const entry of entries) {
      expect(entry.tab, entry.cardId).toBeDefined();
      expect(entry.tab).toBe(connectionServicesTabForCard(entry.cardId));
    }
    for (const tab of CONNECTION_SERVICES_SETTINGS_TABS) {
      expect(entries.some((entry) => entry.tab === tab), tab).toBe(true);
    }
    expect(resolveSettingsRoute('external-clients', '')).toMatchObject({ section: 'connection-services', tab: 'clients' });
    expect(resolveSettingsRoute('connection', '#st-card-conn-external'))
      .toEqual({ status: 'ok', section: 'connection-services', cardId: 'st-card-conn-external', tab: 'web' });
  });

  it('assigns every sessions-entry card to the tab that mounts it', () => {
    const sessionsEntries = SETTINGS_SEARCH_SPEC.filter((entry) => entry.section === 'sessions');
    for (const entry of sessionsEntries) {
      expect(entry.tab, entry.cardId).toBeDefined();
      expect(entry.tab).toBe(sessionsTabForCard(entry.cardId));
    }
    for (const tab of SESSIONS_SETTINGS_TABS) {
      expect(sessionsEntries.some((entry) => entry.tab === tab), tab).toBe(true);
    }
    expect(resolveSettingsRoute('tasks', '')).toMatchObject({ section: 'sessions', tab: 'runtime' });
    expect(resolveSettingsRoute('sessions', '#st-card-import-history'))
      .toEqual({ status: 'ok', section: 'sessions', cardId: 'st-card-import-history', tab: 'conversations' });
  });

  it('assigns every connection-entry card to the tab that mounts it', () => {
    const connectionEntries = SETTINGS_SEARCH_SPEC.filter((entry) => entry.section === 'connection');
    expect(connectionEntries.length).toBeGreaterThan(0);
    // Same rule as the ai/search tabs: a hit without its tab lands on the
    // default sub-page and flashes a card the page keeps hidden.
    for (const entry of connectionEntries) {
      expect(entry.tab, entry.cardId).toBeDefined();
      expect(entry.tab).toBe(connectionTabForCard(entry.cardId));
    }
    for (const tab of CONNECTION_SETTINGS_TABS) {
      expect(connectionEntries.some((entry) => entry.tab === tab), tab).toBe(true);
    }
    // The Cloudflare card moved to connection-services; the leaf has one
    // sub-page again, and a bare `?tab=external` bookmark follows the card
    // (the GUI redirects it to the card's new home).
    expect(connectionTabForCard('st-card-conn-external')).toBeUndefined();
    expect(connectionTabForCard('st-card-conn-unknown')).toBeUndefined();
  });

  it('resolves every indexed target back to its own section and card anchor', () => {
    for (const entry of SETTINGS_SEARCH_SPEC) {
      const resolved = resolveSettingsRoute(entry.section, `#${entry.cardId}`);
      expect(resolved.status, entry.cardId).toBe('ok');
      if (resolved.status !== 'ok') continue;
      // A target that resolves elsewhere is a broken link: the page would
      // render another section (or the unknown-setting page) under this hit.
      expect(resolved.section, entry.cardId).toBe(entry.section);
      expect(resolved.cardId, entry.cardId).toBe(entry.cardId);
    }
  });
});

describe('settings nav groups (IA purpose)', () => {
  it('lists seven purpose groups with dedicated pages and knows which pages stay on this device', () => {
    const groups = SETTINGS_NAV_TREE.filter((node) => node.kind === 'group');
    expect(groups.map((group) => group.id))
      .toEqual(['device', 'models-agents', 'sessions-work', 'capabilities', 'rules', 'connection', 'advanced']);
    expect(groups.every((group) => group.sections.length > 0)).toBe(true);
    expect(SETTINGS_NAV_TREE.every((node) => node.kind === 'group')).toBe(true);
    expect(settingsSectionIsDeviceOnly('appearance')).toBe(true);
    expect(settingsSectionSupportsSpace('appearance')).toBe(true);
    expect(settingsSectionSupportsSpace('general')).toBe(true);
    expect(settingsSectionIsDeviceOnly('permissions')).toBe(false);
    expect(settingsSectionIsDeviceOnly('nope')).toBe(false);
  });

  it('places each of the 20 dedicated leaves once across the seven groups', () => {
    const placed = SETTINGS_NAV_TREE.flatMap((node) => node.kind === 'group' ? node.sections : [node.section]);
    expect(placed).toHaveLength(20);
    expect(new Set(placed).size).toBe(20);
    expect(new Set(placed)).toEqual(new Set(SETTINGS_SECTIONS.map((section) => section.id)));
    const sectionsOf = (id: string) => (SETTINGS_NAV_TREE.find((node) => node.kind === 'group' && node.id === id) as { sections: readonly string[] }).sections;
    expect(sectionsOf('device')).toEqual(['general', 'appearance', 'shortcuts', 'notifications']);
    expect(sectionsOf('models-agents')).toEqual(['ai', 'agents']);
    expect(sectionsOf('sessions-work')).toEqual(['sessions', 'workspaces', 'memory']);
    expect(sectionsOf('capabilities')).toEqual(['extensions', 'search', 'browser-control', 'hooks']);
    expect(sectionsOf('rules')).toEqual(['permissions']);
    expect(sectionsOf('connection')).toEqual(['connection', 'spaces', 'ssh', 'connection-services']);
    expect(sectionsOf('advanced')).toEqual(['about', 'developer']);
    expect(resolveSettingsRoute('external-clients', '')).toMatchObject({ section: 'connection-services' });
    // Legacy routes resolve to their canonical merged leaf instead of landing on "unknown setting".
    expect(resolveSettingsRoute('extensions', '')).toMatchObject({ section: 'extensions' });
    expect(resolveSettingsRoute('skills', '')).toMatchObject({ section: 'extensions', tab: 'skills' });
    expect(resolveSettingsRoute('mcp', '')).toMatchObject({ section: 'extensions', tab: 'mcp' });
    expect(resolveSettingsRoute('plugins', '')).toMatchObject({ section: 'extensions', tab: 'plugins' });
    expect(resolveSettingsRoute('identity', '')).toMatchObject({ section: 'ai', tab: 'identity' });
    expect(resolveSettingsRoute('subagents', '')).toMatchObject({ section: 'agents', tab: 'dispatch' });
    expect(resolveSettingsRoute('tasks', '')).toMatchObject({ section: 'sessions' });
    expect(resolveSettingsRoute('computer-control', '')).toMatchObject({ section: 'browser-control', tab: 'computer' });
    expect(resolveSettingsRoute('labs', '')).toMatchObject({ section: 'developer', cardId: 'st-card-labs' });
    expect(resolveSettingsRoute('environment-tools', '')).toMatchObject({ section: 'search' });
    expect(resolveSettingsRoute('remote', '')).toMatchObject({ section: 'connection' });
    expect(resolveSettingsRoute('system', '')).toMatchObject({ section: 'developer' });
    expect(settingsGroupForSection('external-clients')).toBeUndefined();
    expect(settingsGroupForSection('workspaces')?.id).toBe('sessions-work');
    expect(settingsGroupForSection('spaces')?.id).toBe('connection');
    expect(placed.at(-1)).toBe('developer');
    for (const retired of ['runtime', 'experimental', 'capabilities', 'advanced', 'automation', 'communication', 'identity', 'subagents', 'tasks', 'skills', 'mcp', 'plugins', 'computer-control', 'labs']) {
      expect(settingsGroupForSection(retired), retired).toBeUndefined();
    }
  });

  it('gives a page an intro only when it says more than a card title on that page', () => {
    const t = (key: I18nKey): string => translate('en', key);
    const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((word) => word.length > 2);
    for (const section of SETTINGS_SECTIONS) {
      const key = SETTINGS_SECTION_META[section.id]?.purposeKey;
      if (key === undefined) continue;
      const intro = new Set(words(t(key)));
      for (const entry of SETTINGS_SEARCH_SPEC.filter((item) => item.section === section.id)) {
        const title = words(t(entry.titleKey));
        // An intro that is a card title plus at most one word restates that card
        // ("Server-wide MCP timeouts." over the "MCP timeouts" card).
        const extra = [...intro].filter((word) => !title.includes(word));
        expect(title.length > 0 && extra.length <= 1, `${section.id} vs ${entry.cardId}`).toBe(false);
      }
    }
    expect(SETTINGS_SECTION_META['mcp']?.purposeKey).toBeUndefined();
  });

  it('declares every scope a page actually writes', () => {
    for (const section of SETTINGS_SECTIONS) {
      const meta = SETTINGS_SECTION_META[section.id];
      expect(meta, section.id).toBeDefined();
      expect(meta!.scopes.length).toBeGreaterThan(0);
    }
    expect(SETTINGS_SECTION_META['general']?.scopes).toEqual(['app', 'space', 'server']);
    expect(SETTINGS_SECTION_META['appearance']?.scopes).toEqual(['app', 'space']);
    expect(SETTINGS_SECTION_META['skills']?.scopes).toEqual(['server', 'workspace']);
    expect(SETTINGS_SECTION_META['mcp']?.scopes).toEqual(['server', 'workspace']);
    expect(SETTINGS_SECTION_META['agents']?.scopes).toEqual(['server', 'workspace']);
    expect(SETTINGS_SECTION_META['permissions']?.scopes).toEqual(['server']);
    expect(SETTINGS_SECTION_META['labs']?.scopes).toEqual(['server']);
    expect(SETTINGS_SECTION_META['runtime']).toBeUndefined();
    expect(SETTINGS_SECTION_META['advanced']).toBeUndefined();
  });
});

describe('installed-plugin settings pages', () => {
  it('addresses one plugin\'s own page inside the plugins section', () => {
    // A copy of this link, a refresh, and the browser's back button all have to
    // land on the same plugin, so the id travels in the query of one section.
    expect(pluginSettingsPath('kiki-writing'))
      .toBe('/settings/plugins?plugin=kiki-writing');
    expect(resolveSettingsRoute('plugins', '')).toMatchObject({ status: 'ok', section: 'extensions', tab: 'plugins' });
    expect(pluginSettingsIdFromQuery('?plugin=kiki-writing')).toBe('kiki-writing');
    expect(installedPluginsPath()).toBe('/settings/plugins');
  });

  it('round-trips an id that needs escaping and treats an empty one as the list', () => {
    const odd = 'vendor/plugin one';
    expect(pluginSettingsIdFromQuery(pluginSettingsPath(odd))).toBe(odd);
    // A link built from an unset id resolves to the list, not to a dead page.
    expect(pluginSettingsIdFromQuery('?plugin=')).toBeNull();
    expect(pluginSettingsIdFromQuery('')).toBeNull();
    expect(pluginSettingsIdFromQuery('?server=https%3A%2F%2Fexample.test')).toBeNull();
  });

  it('follows the WebBridge readiness card to the browser page it moved to', () => {
    expect(resolveSettingsRoute('plugins', '#st-card-webbridge'))
      .toMatchObject({ status: 'ok', section: 'browser-control', cardId: 'st-card-webbridge' });
    expect(settingsSectionForCard('st-card-webbridge')).toBe('browser-control');
  });
});

describe('appearance leaf', () => {
  it('owns the appearance cards and keeps the old General anchor working', () => {
    expect(resolveSettingsRoute('general', '#st-card-appearance'))
      .toMatchObject({ status: 'ok', section: 'appearance', cardId: 'st-card-appearance' });
    expect(resolveSettingsRoute(undefined, '#st-card-appearance'))
      .toMatchObject({ status: 'ok', section: 'appearance' });
    expect(resolveSettingsRoute('theme', '')).toMatchObject({ status: 'ok', section: 'appearance' });
    expect(resolveSettingsRoute('skins', '')).toMatchObject({ status: 'ok', section: 'appearance' });
    // Queued-message timing is a device preference; it moved to General.
    expect(resolveSettingsRoute('communication', '#st-card-append-timing'))
      .toMatchObject({ status: 'ok', section: 'general', cardId: 'st-card-append-timing' });
    expect(resolveSettingsRoute(undefined, '#st-card-append-timing'))
      .toMatchObject({ status: 'ok', section: 'general' });
  });

  it('finds appearance settings by everyday words in both locales', () => {
    const en = buildSettingsSearchIndex({}, (key) => translate('en', key));
    const zh = buildSettingsSearchIndex({}, (key) => translate('zh', key));
    for (const [index, query, card] of [
      [en, 'dark mode', 'st-card-appearance'],
      [en, 'serif', 'st-card-appearance-type'],
      [en, 'reduce motion', 'st-card-appearance-layout'],
      [zh, '皮肤', 'st-card-appearance'],
      [zh, '动效', 'st-card-appearance-layout'],
    ] as const) {
      expect(searchSettings(index, query).some((hit) => hit.cardId === card), `${query}`).toBe(true);
    }
  });

  it('normalizes the stored motion and prose preferences', () => {
    localStorage.setItem('kiki.settings', JSON.stringify({ motion: 'wild', proseFont: 'comic' }));
    expect(readSettings().motion).toBe('system');
    expect(readSettings().proseFont).toBe('serif');
    localStorage.setItem('kiki.settings', JSON.stringify({ motion: 'reduce', proseFont: 'sans' }));
    expect(readSettings().motion).toBe('reduce');
    expect(readSettings().proseFont).toBe('sans');
    localStorage.removeItem('kiki.settings');
  });
});

describe('settings search breadcrumbs and synonyms', () => {
  const t = (key: I18nKey): string => translate('en', key);
  const tZh = (key: I18nKey): string => translate('zh', key);

  it('carries the visual group into grouped hits for the group › leaf › card breadcrumb', () => {
    const index = buildSettingsSearchIndex({ general: 'General' }, t);
    const models = index.find((entry) => entry.cardId === 'st-card-providers');
    expect(models?.groupLabel).toBe('Models & agents');
    const about = index.find((entry) => entry.cardId === 'st-card-about');
    expect(about?.groupLabel).toBe('Advanced');
    expect(index.every((entry) => entry.groupLabel !== '')).toBe(true);
    expect(searchSettings(index, 'Models & agents').some((hit) => hit.section === 'ai')).toBe(true);
  });

  it.each([
    ['能力', 'st-card-caps'],
    ['供应商', 'st-card-providers'],
    ['提供商', 'st-card-auth'],
    ['模型目录', 'st-card-providers'],
    ['模型目录刷新', 'st-card-catalog-refresh'],
    // The fold-steps switch moved from its own timeline card into the
    // interface-behaviour card; the legacy terms keep finding it.
    ['transcript', 'st-card-ui-behavior'],
    ['timeline', 'st-card-ui-behavior'],
    ['Profiles', 'st-card-main-agents'],
    ['子 Agent', 'st-card-subagents'],
  ])('matches the legacy/synonym term %s in English', (term, cardId) => {
    const index = buildSettingsSearchIndex({}, t);
    expect(searchSettings(index, term).some((hit) => hit.cardId === cardId)).toBe(true);
  });

  it.each([
    ['能力', 'st-card-caps'],
    ['供应商', 'st-card-providers'],
    ['model catalog', 'st-card-providers'],
    ['catalog refresh', 'st-card-catalog-refresh'],
    ['会话记录', 'st-card-ui-behavior'],
  ])('matches the legacy/synonym term %s in Chinese', (term, cardId) => {
    const index = buildSettingsSearchIndex({}, tZh);
    expect(searchSettings(index, term).some((hit) => hit.cardId === cardId)).toBe(true);
  });

  it('finds the profile editor that owns subagent policies in both locales', () => {
    for (const [translateKey, queries] of [[t, ['profiles', 'subagent', 'pinned model alias']], [tZh, ['profile', '子智能体', '固定模型别名']]] as const) {
      const index = buildSettingsSearchIndex({}, translateKey);
      for (const query of queries) {
        const hit = searchSettings(index, query).find((entry) => entry.cardId === 'st-card-main-agents');
        expect(hit, query).toMatchObject({ section: 'agents', cardId: 'st-card-main-agents' });
        expect(resolveSettingsRoute(hit?.section, `#${hit?.cardId}`), query)
          .toMatchObject({ status: 'ok', section: 'agents', cardId: 'st-card-main-agents' });
      }
    }
  });

  it('points the catalog-refresh hit at the providers tab so the card is mounted on arrival', () => {
    const index = buildSettingsSearchIndex({}, t);
    const hit = searchSettings(index, 'Get models')
      .find((entry) => entry.cardId === 'st-card-catalog-refresh');
    expect(hit).toMatchObject({ section: 'ai', tab: 'providers' });
  });

  it('finds model editing on the providers tab, where every model is edited', () => {
    const index = buildSettingsSearchIndex({}, t);
    const hit = searchSettings(index, '模型编辑').find((entry) => entry.cardId === 'st-card-providers');
    expect(hit).toMatchObject({ section: 'ai', tab: 'providers' });
    expect(index.some((entry) => entry.tab === ('models' as never))).toBe(false);
  });
});

describe('settings route resolver', () => {
  it('lands bare /settings on the default page', () => {
    expect(resolveSettingsRoute(undefined, '')).toEqual({ status: 'ok', section: 'general', cardId: undefined });
    expect(resolveSettingsRoute('', '')).toEqual({ status: 'ok', section: 'general', cardId: undefined });
  });

  it('passes known sections through and keeps a local card hash', () => {
    expect(resolveSettingsRoute('ai', '#st-card-models'))
      .toEqual({ status: 'ok', section: 'ai', cardId: 'st-card-providers', tab: 'providers' });
    expect(resolveSettingsRoute('ai', ''))
      .toEqual({ status: 'ok', section: 'ai', cardId: undefined, tab: undefined });
    expect(resolveSettingsRoute('about', ''))
      .toEqual({ status: 'ok', section: 'about', cardId: undefined });
  });

  it('redirects the legacy models/providers sections to the merged ai entry with their tab', () => {
    expect(resolveSettingsRoute('models', ''))
      .toEqual({ status: 'ok', section: 'ai', cardId: undefined, tab: 'providers' });
    expect(resolveSettingsRoute('providers', ''))
      .toEqual({ status: 'ok', section: 'ai', cardId: undefined, tab: 'providers' });
    expect(resolveSettingsRoute('models', '#st-card-request-identity'))
      .toEqual({ status: 'ok', section: 'ai', cardId: 'st-card-request-identity', tab: 'identity' });
    expect(resolveSettingsRoute('models', '#st-card-thinking'))
      .toEqual({ status: 'ok', section: 'ai', cardId: 'st-card-thinking', tab: 'defaults' });
    expect(resolveSettingsRoute('providers', '#st-card-auth'))
      .toEqual({ status: 'ok', section: 'ai', cardId: 'st-card-auth', tab: 'providers' });
  });

  it('redirects the retired experimental page and keeps feature card owners precise', () => {
    expect(resolveSettingsRoute('experimental', ''))
      .toEqual({ status: 'ok', section: 'developer', cardId: 'st-card-labs', tab: undefined });
    expect(resolveSettingsRoute('experimental', '#st-card-experimental'))
      .toEqual({ status: 'ok', section: 'developer', cardId: 'st-card-labs', tab: undefined });
    // A retired multi-flag card lands on the Labs index; a single-flag card on its row's page.
    expect(resolveSettingsRoute('agents', '#st-card-tool-experiments'))
      .toEqual({ status: 'ok', section: 'developer', cardId: 'st-card-labs', tab: undefined });
    for (const [card, section] of [
      ['st-card-agent-profile-routes', 'agents'],
      ['st-card-mcp-delegation', 'extensions'],
      ['st-card-subagent-release-idle', 'agents'],
      ['st-card-task-board', 'sessions'],
      ['st-card-performance-storage', 'developer'],
    ] as const) {
      expect(resolveSettingsRoute('labs', `#${card}`), card)
        .toEqual({ status: 'ok', section, cardId: `st-card-exp-${section}`, tab: section === 'sessions' ? 'runtime' : undefined });
    }
    // New row anchors on tabbed pages switch to the tab that mounts them.
    expect(resolveSettingsRoute('search', '#st-card-exp-search'))
      .toEqual({ status: 'ok', section: 'search', cardId: 'st-card-exp-search', tab: 'advanced' });
    expect(resolveSettingsRoute('ai', '#st-card-exp-ai'))
      .toEqual({ status: 'ok', section: 'ai', cardId: 'st-card-exp-ai', tab: 'defaults' });
    expect(resolveSettingsRoute('browser-control', '#st-card-exp-browser-control'))
      .toEqual({ status: 'ok', section: 'browser-control', cardId: 'st-card-exp-browser-control', tab: 'browser' });
    expect(resolveSettingsRoute('general', '#st-card-defaults'))
      .toEqual({ status: 'ok', section: 'sessions', cardId: 'st-card-defaults', tab: 'behavior' });
  });

  it('redirects the leaves retired by IA v2 to their new owners', () => {
    expect(resolveSettingsRoute('advanced', '')).toEqual({ status: 'ok', section: 'developer', cardId: undefined, tab: undefined });
    expect(resolveSettingsRoute('advanced', '#st-card-advanced'))
      .toEqual({ status: 'ok', section: 'developer', cardId: 'st-card-advanced', tab: undefined });
    expect(resolveSettingsRoute('automation', '')).toEqual({ status: 'ok', section: 'permissions', cardId: undefined, tab: undefined });
    expect(resolveSettingsRoute('automation', '#st-card-hooks'))
      .toEqual({ status: 'ok', section: 'hooks', cardId: 'st-card-hooks', tab: undefined });
    expect(resolveSettingsRoute('communication', '')).toEqual({ status: 'ok', section: 'sessions', cardId: undefined, tab: 'behavior' });
    expect(resolveSettingsRoute('communication', '#st-card-token-counting'))
      .toEqual({ status: 'ok', section: 'ai', cardId: 'st-card-token-counting', tab: 'defaults' });
    // Cards the Developer page used to hold land on their owning pages.
    expect(resolveSettingsRoute('advanced', '#st-card-retry'))
      .toEqual({ status: 'ok', section: 'ai', cardId: 'st-card-retry', tab: 'defaults' });
    expect(resolveSettingsRoute('advanced', '#st-card-resource-limits'))
      .toEqual({ status: 'ok', section: 'sessions', cardId: 'st-card-resource-limits', tab: 'runtime' });
    expect(resolveSettingsRoute('advanced', '#st-card-session-residency'))
      .toEqual({ status: 'ok', section: 'sessions', cardId: 'st-card-session-residency', tab: 'runtime' });
    for (const card of ['st-card-thread-communication', 'st-card-notify-parent', 'st-card-communication']) {
      expect(resolveSettingsRoute('communication', `#${card}`), card)
        .toEqual({ status: 'ok', section: 'sessions', cardId: 'st-card-agent-messaging', tab: 'behavior' });
    }
    // Permission defaults and the reviewer left the Models & providers tab.
    expect(resolveSettingsRoute('ai', '#st-card-permission-defaults'))
      .toEqual({ status: 'ok', section: 'permissions', cardId: 'st-card-permission-defaults', tab: undefined });
    expect(resolveSettingsRoute('ai', '#st-card-reviewer'))
      .toEqual({ status: 'ok', section: 'permissions', cardId: 'st-card-reviewer', tab: undefined });
    expect(resolveSettingsRoute('general', '#st-card-session-title'))
      .toEqual({ status: 'ok', section: 'sessions', cardId: 'st-card-session-title', tab: 'conversations' });
  });

  it('follows a card hash whose content moved to another section', () => {
    // A bookmark written before a content move: section says general, card
    // says the card now lives under extensions (mcp tab) — the precise half wins.
    expect(resolveSettingsRoute('general', '#st-card-mcp'))
      .toEqual({ status: 'ok', section: 'extensions', cardId: 'st-card-mcp', tab: 'mcp' });
    expect(resolveSettingsRoute('retired-section', '#st-card-workspaces'))
      .toEqual({ status: 'ok', section: 'workspaces', cardId: 'st-card-workspaces', tab: undefined });
    expect(resolveSettingsRoute('retired-section', '#st-card-models'))
      .toEqual({ status: 'ok', section: 'ai', cardId: 'st-card-providers', tab: 'providers' });
    // The catalog-refresh controls moved out of the agents sidecar onto the
    // models tab of the merged ai entry; old sidecar deep links follow them.
    expect(resolveSettingsRoute('agents', '#st-card-catalog-refresh'))
      .toEqual({ status: 'ok', section: 'ai', cardId: 'st-card-catalog-refresh', tab: 'providers' });
  });

  it('redirects the retired capabilities section and its card deep links (redesign §10.3)', () => {
    // Bare /settings/capabilities lands on extensions?tab=skills.
    expect(resolveSettingsRoute('capabilities', ''))
      .toEqual({ status: 'ok', section: 'extensions', cardId: undefined, tab: 'skills' });
    // A precise card hash still follows the card across the split.
    expect(resolveSettingsRoute('capabilities', '#st-card-mcp'))
      .toEqual({ status: 'ok', section: 'extensions', cardId: 'st-card-mcp', tab: 'mcp' });
    expect(resolveSettingsRoute('capabilities', '#st-card-tools'))
      .toEqual({ status: 'ok', section: 'permissions', cardId: 'st-card-tools', tab: undefined });
    expect(resolveSettingsRoute('capabilities', '#st-card-caps'))
      .toEqual({ status: 'ok', section: 'extensions', cardId: 'st-card-caps', tab: 'skills' });
    // The duplicate timeout card was removed; legacy links land on its editor.
    expect(resolveSettingsRoute('agents', '#st-card-sidecar'))
      .toEqual({ status: 'ok', section: 'agents', cardId: 'st-card-subagent-limits', tab: 'dispatch' });
    expect(resolveSettingsRoute('retired-section', '#st-card-sidecar'))
      .toEqual({ status: 'ok', section: 'agents', cardId: 'st-card-subagent-limits', tab: 'dispatch' });
    expect(resolveSettingsRoute('subagents', '#st-card-subagent-timeout'))
      .toEqual({ status: 'ok', section: 'agents', cardId: 'st-card-subagent-limits', tab: 'dispatch' });
  });

  it('redirects the retired runtime page to sessions and keeps dissolved card links precise', () => {
    expect(resolveSettingsRoute('runtime', ''))
      .toEqual({ status: 'ok', section: 'sessions', cardId: undefined, tab: 'runtime' });
    expect(resolveSettingsRoute('runtime', '#st-card-runtime'))
      .toEqual({ status: 'ok', section: 'sessions', cardId: 'st-card-task-policy', tab: 'runtime' });
    expect(resolveSettingsRoute('retired-section', '#st-card-runtime'))
      .toEqual({ status: 'ok', section: 'sessions', cardId: 'st-card-task-policy', tab: 'runtime' });
    expect(resolveSettingsRoute('runtime', '#st-card-cron'))
      .toEqual({ status: 'ok', section: 'developer', cardId: 'st-card-cron', tab: undefined });
    expect(resolveSettingsRoute('runtime', '#st-card-communication'))
      .toEqual({ status: 'ok', section: 'sessions', cardId: 'st-card-agent-messaging', tab: 'behavior' });
    expect(resolveSettingsRoute('runtime', '#st-card-resource-limits'))
      .toEqual({ status: 'ok', section: 'sessions', cardId: 'st-card-resource-limits', tab: 'runtime' });
    expect(resolveSettingsRoute('runtime', '#st-card-agent-runtime'))
      .toEqual({ status: 'ok', section: 'agents', cardId: 'st-card-agent-runtime', tab: 'profiles' });
  });

  it('flags genuinely unknown sections instead of silently falling back to general', () => {
    expect(resolveSettingsRoute('nonsense', '')).toEqual({ status: 'unknown', section: 'nonsense', cardId: undefined });
    expect(resolveSettingsRoute('nonsense', '#st-card-not-real')).toEqual({ status: 'unknown', section: 'nonsense', cardId: 'st-card-not-real' });
    expect(resolveSettingsRoute('nonsense', '#other-anchor')).toEqual({ status: 'unknown', section: 'nonsense', cardId: undefined });
  });

  it('knows the canonical owner of every indexed card', () => {
    expect(settingsSectionForCard('st-card-mcp')).toBe('extensions');
    expect(settingsSectionForCard('st-card-language')).toBe('general');
    expect(settingsSectionForCard('st-card-task-policy')).toBe('sessions');
    // Dissolved cards leave the spec to their LEGACY_CARD_ALIASES entry.
    expect(settingsSectionForCard('st-card-sidecar')).toBeUndefined();
    expect(settingsSectionForCard('st-card-runtime')).toBeUndefined();
    expect(settingsSectionForCard('st-card-nowhere')).toBeUndefined();
  });
});

describe('hooks and MCP timeout patches (batch 3 split)', () => {
  it('validates the supported hook config fields without running commands', () => {
    expect(parseHooksJson('[]')).toEqual([]);
    const hook = { event: 'PreToolUse', command: 'echo example', matcher: '^Read$', timeout: 600 };
    expect(parseHooksJson(JSON.stringify([hook]))).toEqual([hook]);
    for (const invalid of [null, {}, { ...hook, event: 'Unknown' }, { ...hook, command: '' }, { ...hook, matcher: '[' }, { ...hook, matcher: 1 }, { ...hook, timeout: 0 }, { ...hook, timeout: 601 }, { ...hook, timeout: 1.5 }, { ...hook, enabled: false }, { ...hook, cwd: '/tmp' }, { ...hook, env: {} }]) {
      expect(() => parseHooksJson(JSON.stringify([invalid]))).toThrowError();
    }
    expect(() => parseHooksJson('{not json')).toThrowError();
    expect(() => parseHooksJson('{"hooks":[]}')).toThrowError();
  });

  it('parses and patches both hooks config shapes without losing declared values', () => {
    const legacy = [{ event: 'PreToolUse', command: 'echo example', matcher: '^Read$', timeout: 600 }];
    const hooks = {
      schemaVersion: 2, enabled: false, disabled: ['project.reminder'], files: ['hooks/example.toml'], legacy,
      rules: [
        { id: 'reminder', event: 'step.before', priority: -10, enabled: true,
          match: { models: ['example/model'], profiles: ['example'], routes: ['native'], executors: ['native'], agentRoles: ['root'], tools: ['Read'], statuses: ['success'], sources: ['user'], outcomes: ['completed'] },
          cadence: { everyCompletedSteps: 3, counterScope: 'turn', partitionBy: 'model' }, action: { type: 'inject', textFile: 'guidance/example.txt' } },
        { id: 'audit', event: 'turn.after', priority: 200, enabled: false, match: {}, action: { type: 'observe' } },
        { id: 'greeting', event: 'prompt.submit', priority: 100, enabled: true, match: {}, action: { type: 'inject', text: 'Example guidance' } },
      ],
    };
    for (const value of [legacy, hooks]) {
      const parsed = parseHooksConfigJson(JSON.stringify(value));
      expect(parsed).toEqual(value);
      expect(hooksConfigPatch(parsed)).toEqual({ hooks: value });
      expect(parseHooksConfigJson(JSON.stringify(hooksConfigPatch(parsed).hooks))).toEqual(value);
    }
    expect(parseHooksConfigJson('{"schemaVersion":2}')).toEqual({ schemaVersion: 2, enabled: true, disabled: [], files: [], rules: [], legacy: [] });
    for (const invalid of [null, {}, { ...hooks, files: [''] }, { ...hooks, schemaVersion: 1 }, { ...hooks, rules: [{ id: 'unsupported', event: 'step.before', action: { type: 'command', command: 'echo example' } }] }]) {
      expect(() => parseHooksConfigJson(JSON.stringify(invalid))).toThrowError();
      expect(() => hooksConfigPatch(invalid)).toThrowError();
    }
    expect(() => parseHooksConfigJson('{not json')).toThrowError();
  });

  it('scopes the MCP timeout patch to the mcp replace-domain', () => {
    expect(mcpTimeoutsPatch('60000', '')).toEqual({
      mcp: { startup_timeout_ms: 60_000, tool_timeout_ms: undefined },
      replace_domains: ['mcp'],
    });
    expect(mcpTimeoutsPatch('', '30000')).toEqual({
      mcp: { startup_timeout_ms: undefined, tool_timeout_ms: 30_000 },
      replace_domains: ['mcp'],
    });
    expect(() => mcpTimeoutsPatch('abc', '')).toThrowError();
    expect(() => mcpTimeoutsPatch('0', '')).toThrowError();
  });

  it('scopes the marketplace URL patch to the plugins replace-domain', () => {
    expect(marketplaceUrlPatch(' https://example.test/marketplace.json ')).toEqual({
      plugins: { marketplace_url: 'https://example.test/marketplace.json' },
      replace_domains: ['plugins'],
    });
    expect(marketplaceUrlPatch('   ')).toEqual({
      plugins: { marketplace_url: undefined },
      replace_domains: ['plugins'],
    });
  });

  it('merges only the title model and explicitly clears an empty model', () => {
    expect(sessionTitleModelPatch(' kimi-for-coding ')).toEqual({ session_title: { model: 'kimi-for-coding' } });
    expect(sessionTitleModelPatch('   ')).toEqual({ session_title: { model: null } });
  });

  it('preserves the complete title prompt and deletes the override for default or blank', () => {
    const prompt = '  标题要求\n保留 {content} 和 ${name}\n  ';
    expect(sessionTitlePromptPatch(prompt)).toEqual({ session_title: { prompt } });
    expect(sessionTitlePromptPatch(null)).toEqual({ session_title: { prompt: null } });
    expect(sessionTitlePromptPatch(' \n\t ')).toEqual({ session_title: { prompt: null } });
  });

  it('persists the selected title moments, including the manual-only empty set', () => {
    expect(sessionTitleSettingsPatch(' model ', ['first_user_message', 'context_compacted'])).toEqual({
      session_title: { model: 'model', triggers: ['first_user_message', 'context_compacted'] },
    });
    expect(sessionTitleSettingsPatch(' ', [])).toEqual({ session_title: { model: null, triggers: [] } });
    expect(runtimeConfigDraftFromConfig({ session_title: { model: 'model' } }).sessionTitleTriggers).toEqual(['first_turn_completed']);
    expect(runtimeConfigDraftFromConfig({ session_title: { model: 'model', triggers: [] } }).sessionTitleTriggers).toEqual([]);
  });

  it('projects the pinned title model out of the config echo', () => {
    expect(runtimeConfigDraftFromConfig({ session_title: { model: 'kimi-for-coding' } }).sessionTitleModel).toBe(
      'kimi-for-coding',
    );
    expect(runtimeConfigDraftFromConfig({}).sessionTitleModel).toBe('');
  });

  it('scopes the tool policy patch to the tools replace-domain', () => {
    const patch = toolPolicyPatch({ toolsEnabled: ['Read'], toolsDisabled: ['Bash'] });
    expect(patch).toEqual({
      tools: { enabled: ['Read'], disabled: ['Bash'] },
      replace_domains: ['tools'],
    });
    expect(toolPolicyDraftFromConfig({ providers: {}, tools: { enabled: ['Read'] } })).toEqual({
      toolsEnabled: ['Read'],
      toolsDisabled: [],
    });
  });

  it('keeps every split-leaf patch inside its own domains', () => {
    const engineDraft = runtimeConfigDraftFromConfig({ providers: {} });
    const taskPatch = taskRuntimePatch(engineDraft.task);
    const resourcePatch = resourceLimitPatch(engineDraft);
    const threadPatch = threadCommunicationPatch(engineDraft.threadCommunicationEnabled);
    const tokenPatch = tokenCountingPatch(engineDraft.tokenCountingStrategy);
    const notifyPatch = agentNotifyParentPatch(engineDraft.agentsNotifyParent);
    const identityPatch = agentIdentityPatch(engineDraft);
    const toolsPatch = toolPolicyPatch({ toolsEnabled: [], toolsDisabled: [] });
    const mcpPatch = mcpTimeoutsPatch('60000', '');
    for (const patch of [taskPatch, resourcePatch, threadPatch, tokenPatch, notifyPatch, identityPatch]) {
      expect(Object.keys(patch)).not.toEqual(expect.arrayContaining(['mcp', 'tools']));
      expect(patch.replace_domains).not.toEqual(expect.arrayContaining(['mcp', 'tools']));
    }
    expect(Object.keys(taskPatch).toSorted()).toEqual(['replace_domains', 'task']);
    expect(Object.keys(resourcePatch).toSorted()).toEqual(['image', 'replace_domains', 'workspace_instance']);
    expect(Object.keys(threadPatch).toSorted()).toEqual(['replace_domains', 'thread_communication']);
    expect(Object.keys(tokenPatch).toSorted()).toEqual(['replace_domains', 'token_counting']);
    expect(Object.keys(notifyPatch).toSorted()).toEqual(['agents']);
    expect(Object.keys(identityPatch).toSorted()).toEqual(['disabled_named_profiles', 'extra_agent_dirs', 'identity', 'replace_domains']);
    expect(Object.keys(toolsPatch).toSorted()).toEqual(['replace_domains', 'tools']);
    expect(Object.keys(mcpPatch).toSorted()).toEqual(['mcp', 'replace_domains']);
  });

  it('two leaves saving from divergent echoes never roll each other back', () => {
    // The advanced leaf holds echo A (stale tools policy), the automation leaf
    // holds echo B (stale engine values). Because each save only replaces its
    // own domains, applying both patches in sequence keeps every leaf's newest
    // values no matter how stale the other leaf's draft was.
    const resourceSave = resourceLimitPatch(runtimeConfigDraftFromConfig({
      providers: {},
      workspace_instance: { idleTtlMs: 60_000 },
      tools: { enabled: ['Read'], disabled: [] },
      mcp: { startupTimeoutMs: 10_000 },
    }));
    const toolsSave = toolPolicyPatch(toolPolicyDraftFromConfig({
      providers: {},
      workspace_instance: { idleTtlMs: 999 },
      tools: { enabled: ['Bash'], disabled: ['Read'] },
    }));
    const apply = (state: Record<string, unknown>, patch: { replace_domains?: string[] } & Record<string, unknown>) => {
      const next = { ...state };
      for (const domain of patch.replace_domains ?? []) next[domain] = patch[domain];
      return next;
    };
    const server: Record<string, unknown> = {
      workspace_instance: 'stale',
      tools: 'policy-from-B',
      mcp: 'mcp-from-C',
    };
    const afterResource = apply(server, resourceSave as never);
    expect(afterResource['tools']).toBe('policy-from-B');
    expect(afterResource['mcp']).toBe('mcp-from-C');
    const afterBoth = apply(afterResource, toolsSave as never);
    expect(afterBoth['tools']).toEqual({ enabled: ['Bash'], disabled: ['Read'] });
    expect(afterBoth['workspace_instance']).toEqual(resourceSave.workspace_instance);
    expect(afterBoth['mcp']).toBe('mcp-from-C');
  });
});

describe('composer send shortcut and live settings', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it('sends on Enter unless cmd-enter is selected', () => {
    expect(isComposerSendKey({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false }, 'enter')).toBe(true);
    expect(isComposerSendKey({ key: 'Enter', shiftKey: true, metaKey: false, ctrlKey: false }, 'enter')).toBe(false);
    expect(isComposerSendKey({ key: 'Enter', shiftKey: false, metaKey: true, ctrlKey: false }, 'enter')).toBe(false);
    expect(isComposerSendKey({ key: 'Enter', shiftKey: false, metaKey: true, ctrlKey: false }, 'cmd-enter')).toBe(true);
    expect(isComposerSendKey({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: true }, 'cmd-enter')).toBe(true);
    expect(isComposerSendKey({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false }, 'cmd-enter')).toBe(false);
  });

  it('maps Enter presses to send / send-now / newline under both shortcuts', () => {
    const key = (mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
      key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, ...mods,
    });
    expect(composerEnterAction(key(), 'enter')).toBe('send');
    expect(composerEnterAction(key({ ctrlKey: true }), 'enter')).toBe('send-now');
    expect(composerEnterAction(key({ metaKey: true }), 'enter')).toBe('send-now');
    expect(composerEnterAction(key({ shiftKey: true }), 'enter')).toBe('newline');
    expect(composerEnterAction(key({ altKey: true }), 'enter')).toBe('newline');
    expect(composerEnterAction(key(), 'cmd-enter')).toBe('newline');
    expect(composerEnterAction(key({ ctrlKey: true }), 'cmd-enter')).toBe('send');
    expect(composerEnterAction(key({ ctrlKey: true, shiftKey: true }), 'cmd-enter')).toBe('send-now');
    expect(composerEnterAction({ ...key(), key: 'a' }, 'enter')).toBe('none');
  });

  it('never sends on an Enter that commits an IME composition', () => {
    const base = { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false };
    expect(composerEnterAction({ ...base, isComposing: true }, 'enter')).toBe('none');
    expect(composerEnterAction({ ...base, keyCode: 229 }, 'enter')).toBe('none');
    expect(composerEnterAction({ ...base, ctrlKey: true, isComposing: true }, 'cmd-enter')).toBe('none');
    expect(isComposerSendKey({ ...base, isComposing: true } as typeof base, 'enter')).toBe(false);
  });

  it('defaults to Enter-sends when nothing is stored', () => {
    localStorage.removeItem('kiki.settings');
    expect(readSettings().sendShortcut).toBe('enter');
  });

  it('keeps an explicitly stored shortcut across the default change', () => {
    // Saved before Enter became the default: an explicit choice is never migrated away.
    localStorage.setItem('kiki.settings', JSON.stringify({ sendShortcut: 'cmd-enter' }));
    expect(readSettings().sendShortcut).toBe('cmd-enter');
    localStorage.setItem('kiki.settings', JSON.stringify({ sendShortcut: 'enter' }));
    expect(readSettings().sendShortcut).toBe('enter');
    // Other stored fields without a shortcut pick up the new default.
    localStorage.setItem('kiki.settings', JSON.stringify({ draftPersistence: false }));
    expect(readSettings().sendShortcut).toBe('enter');
  });

  it('notifies subscribers as soon as sendShortcut is written', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeSettings(() => {
      seen.push(settingsSnapshot().sendShortcut);
    });
    writeSettings({ sendShortcut: 'cmd-enter' });
    expect(readSettings().sendShortcut).toBe('cmd-enter');
    expect(settingsSnapshot()).toBe(settingsSnapshot());
    expect(seen).toEqual(['cmd-enter']);
    unsubscribe();
    writeSettings({ sendShortcut: 'enter' });
    expect(seen).toEqual(['cmd-enter']);
  });

  it('serves a stable server snapshot for useSyncExternalStore', () => {
    expect(settingsServerSnapshot()).toBe(settingsServerSnapshot());
    expect(settingsServerSnapshot().sendShortcut).toBe('enter');
  });

  it('refreshes the snapshot from a cross-document storage event', () => {
    const listeners = new Set<(event: StorageEvent) => void>();
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === 'storage') listeners.add(listener);
      },
      removeEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === 'storage') listeners.delete(listener);
      },
    });
    writeSettings({ sendShortcut: 'enter' });
    const seen: string[] = [];
    const unsubscribe = subscribeSettings(() => {
      seen.push(settingsSnapshot().sendShortcut);
    });
    expect(listeners.size).toBe(1);
    localStorage.setItem('kiki.settings', JSON.stringify({ sendShortcut: 'cmd-enter' }));
    expect(settingsSnapshot().sendShortcut).toBe('enter');
    for (const listener of listeners) {
      listener({ key: 'kiki.settings', storageArea: localStorage } as StorageEvent);
    }
    expect(settingsSnapshot().sendShortcut).toBe('cmd-enter');
    expect(seen).toEqual(['cmd-enter']);
    for (const listener of listeners) {
      listener({ key: 'kiki.other', storageArea: localStorage } as StorageEvent);
    }
    expect(seen).toEqual(['cmd-enter']);
    unsubscribe();
    expect(listeners.size).toBe(0);
    vi.unstubAllGlobals();
  });
});

describe('draft persistence gate', () => {
  beforeEach(() => {
    resetDraftMemoryForTests();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
    writeSettings({ draftPersistence: true });
  });

  it('keeps in-memory drafts when persistence is off and does not write disk', () => {
    writeDraft('s1', 'keep me');
    expect(readDraft('s1')).toBe('keep me');
    flushDrafts();
    expect(localStorage.getItem('kiki.drafts')).toContain('keep me');
    writeSettings({ draftPersistence: false });
    clearStoredDrafts();
    expect(localStorage.getItem('kiki.drafts')).toBeNull();
    expect(readDraft('s1')).toBe('keep me');
    writeDraft('s1', 'still here');
    expect(readDraft('s1')).toBe('still here');
    expect(localStorage.getItem('kiki.drafts')).toBeNull();
    writeSettings({ draftPersistence: true });
    writeDraft('s1', 'now persisted');
    flushDrafts();
    expect(localStorage.getItem('kiki.drafts')).toContain('now persisted');
  });

  it('does not restore disk drafts after a fresh process when persistence is off', () => {
    writeDraft('s1', 'on disk');
    writeSettings({ draftPersistence: false });
    clearStoredDrafts();
    localStorage.setItem('kiki.drafts', JSON.stringify({ s1: 'stale disk' }));
    resetDraftMemoryForTests();
    expect(readDraft('s1')).toBe('');
    expect(localStorage.getItem('kiki.drafts')).toContain('stale disk');
  });
});

describe('default model inheritance', () => {
  it('never treats a local default as an implicit session override', () => {
    expect(resolveSessionModelOverride(undefined)).toBeUndefined();
    expect(resolveSessionModelOverride('kimi/k2')).toBe('kimi/k2');
    expect(resolveEffectiveModel(undefined, undefined, 'server/default')).toBe('server/default');
    expect(resolveEffectiveModel(undefined, 'session/bound', 'server/default')).toBe('session/bound');
    expect(resolveEffectiveModel('picked/model', 'session/bound', 'server/default')).toBe('picked/model');
    expect(resolveModelSource(undefined, undefined)).toBe('server-default');
    expect(resolveModelSource(undefined, 'session/bound')).toBe('session');
    expect(resolveModelSource('picked/model', 'session/bound')).toBe('override');
    // Server default outranks the local mirror — the mirror is an echo of the
    // same server field and must not shadow the fresher value.
    expect(resolveModelSource(undefined, undefined, 'local/k2', 'server/default')).toBe('server-default');
    expect(resolveModelSource(undefined, undefined, 'local/k2', undefined)).toBe('local-default');
    expect(resolveModelSource(undefined, undefined, undefined, 'server/default')).toBe('server-default');
  });
});

describe('millisecond humanizing', () => {
  it('picks the largest readable unit with at most two decimals', () => {
    expect(humanizeMs(500)).toEqual({ value: 500, unit: 'ms' });
    expect(humanizeMs(45_000)).toEqual({ value: 45, unit: 'seconds' });
    expect(humanizeMs(90_000)).toEqual({ value: 1.5, unit: 'minutes' });
    expect(humanizeMs(7_200_000)).toEqual({ value: 2, unit: 'hours' });
    expect(humanizeMs(86_400_000)).toEqual({ value: 24, unit: 'hours' });
  });

  it('chooses the largest exactly-dividing unit for the unit selector', () => {
    expect(msUnitFor(7_200_000)).toBe('hours');
    expect(msUnitFor(90_000)).toBe('seconds');
    expect(msUnitFor(60_000)).toBe('minutes');
    expect(msUnitFor(1_500)).toBe('ms');
    expect(msUnitFor(0)).toBe('ms');
  });
});

describe('restart requirement pub/sub', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it('notifies subscribers and serves a stable cached snapshot', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeRestartRequirement(() => {
      seen.push(restartRequirementSnapshot().required);
    });
    markRestartRequired(['subagent']);
    expect(restartRequirementSnapshot()).toBe(restartRequirementSnapshot());
    clearRestartRequirement();
    expect(seen).toEqual([true, false]);
    unsubscribe();
    markRestartRequired(['agents']);
    expect(seen).toEqual([true, false]);
    clearRestartRequirement();
  });
});

describe('MCP settings draft projection', () => {
  it('builds a strict stdio config from line-oriented args and env fields', () => {
    expect(mcpConfigFromDraft({
      name: 'local',
      transport: 'stdio',
      command: ' node ',
      args: '-y\nserver.js',
      env: 'TOKEN=value\nEMPTY=',
      url: '',
      headers: 'Authorization=unused',
      bearerTokenEnvVar: 'UNUSED_ENV',
    })).toEqual({
      enabled: undefined,
      startupTimeoutMs: undefined,
      toolTimeoutMs: undefined,
      enabledTools: undefined,
      disabledTools: undefined,
      transport: 'stdio',
      command: 'node',
      args: ['-y', 'server.js'],
      env: { TOKEN: 'value', EMPTY: '' },
    });
  });

  it('rejects malformed environment lines before the client write', () => {
    expect(() => mcpConfigFromDraft({
      name: 'local',
      transport: 'stdio',
      command: 'node',
      args: '',
      env: 'TOKEN',
      url: '',
      headers: '',
      bearerTokenEnvVar: '',
    })).toThrow('st.mcp.envInvalid');
  });

  const remote = {
    name: 'remote',
    config: {
      transport: 'http' as const,
      url: 'https://old.example.test/mcp',
      headers: { Authorization: 'Bearer old=token', 'X-Team': 'alpha' },
      auth: 'oauth' as const,
      bearerTokenEnvVar: 'MCP_TOKEN',
    },
    source: 'global' as const,
    origin: '/tmp/fixture-mcp.json',
    mutable: true,
  };
  const remoteDraft = {
    original: remote,
    name: 'remote',
    transport: 'http' as const,
    command: '',
    args: '',
    env: '',
    url: remote.config.url,
    headers: 'Authorization=Bearer new=token\nX-Team=alpha',
    bearerTokenEnvVar: 'MCP_TOKEN',
    auth: 'oauth' as const,
  };

  it('keeps the explicit env reference until cleared or replaced, without inheriting deleted headers', () => {
    expect(mcpConfigFromDraft(remoteDraft)).toMatchObject({
      headers: { Authorization: 'Bearer new=token', 'X-Team': 'alpha' },
      bearerTokenEnvVar: 'MCP_TOKEN', auth: 'oauth',
    });
    expect(mcpConfigFromDraft({ ...remoteDraft, bearerTokenEnvVar: 'OTHER_TOKEN', headers: 'X-Team=beta' })).toMatchObject({
      headers: { 'X-Team': 'beta' }, bearerTokenEnvVar: 'OTHER_TOKEN',
    });
    expect(mcpConfigFromDraft({ ...remoteDraft, headers: '' })).toMatchObject({
      headers: undefined, bearerTokenEnvVar: 'MCP_TOKEN',
    });
    expect(mcpConfigFromDraft({ ...remoteDraft, bearerTokenEnvVar: '', headers: 'Authorization=Bearer manual=now' })).toMatchObject({
      headers: { Authorization: 'Bearer manual=now' }, bearerTokenEnvVar: undefined, auth: 'oauth',
    });
    expect(mcpConfigFromDraft({ ...remoteDraft, bearerTokenEnvVar: '', headers: '' })).toMatchObject({
      headers: undefined, bearerTokenEnvVar: undefined, auth: 'oauth',
    });
  });

  it('does not silently restore env or OAuth after a target change and return', () => {
    const changed = { ...remoteDraft, url: 'https://new.example.test/mcp', bearerTokenEnvVar: '', headers: '', auth: undefined };
    expect(mcpConfigFromDraft(changed)).toMatchObject({
      transport: 'http', headers: undefined, bearerTokenEnvVar: undefined, auth: undefined,
    });
    expect(mcpConfigFromDraft({ ...changed, url: remote.config.url, transport: 'sse', headers: 'Authorization=Bearer sse' })).toMatchObject({
      transport: 'sse', headers: { Authorization: 'Bearer sse' }, bearerTokenEnvVar: undefined, auth: undefined,
    });
    expect(mcpConfigFromDraft({ ...changed, url: remote.config.url })).toMatchObject({
      headers: undefined, bearerTokenEnvVar: undefined, auth: undefined,
    });
  });

  it('never inherits read-only values and rejects invalid or case-insensitive duplicate headers', () => {
    const readOnly = { ...remote, mutable: false, source: 'plugin' as const };
    expect(mcpConfigFromDraft({ ...remoteDraft, original: readOnly, bearerTokenEnvVar: '', headers: '' })).toMatchObject({
      auth: undefined, bearerTokenEnvVar: undefined, headers: undefined,
    });
    expect(() => mcpConfigFromDraft({ ...remoteDraft, headers: 'Bad Name=secret' })).toThrow('st.mcp.headersInvalid');
    expect(() => mcpConfigFromDraft({ ...remoteDraft, headers: 'Incomplete' })).toThrow('st.mcp.headersInvalid');
    expect(() => mcpConfigFromDraft({ ...remoteDraft, headers: 'Authorization=one\naUTHORIZATION=two' })).toThrow('st.mcp.headersDuplicate');
    expect(mcpConfigFromDraft({ ...remoteDraft, bearerTokenEnvVar: '', headers: 'X-Note=value=with: colon / and spaces\nEmpty=' })).toMatchObject({
      headers: { 'X-Note': 'value=with: colon / and spaces', Empty: '' },
    });
  });
});

describe('computer-use preference settings', () => {
  it('defaults older servers to avoid and saves or removes a typed soft preference', () => {
    expect(computerControlPreference({})).toBe('avoid');
    expect(computerControlPreference({ computer_control: { usagePreference: 'prefer', usagePreferenceSource: 'home', appliesOn: 'next-model-request' } })).toBe('prefer');
    for (const preference of ['avoid', 'prefer', null] as const) {
      const patch = computerControlPreferencePatch(preference);
      expect(patchConfigRequestSchema.parse(patch)).toEqual({ computer_control: { usage_preference: preference } });
    }
  });

  it('determines computer control enabled and tool policy denial correctly', () => {
    expect(isComputerControlEnabled({})).toBe(true);
    expect(isComputerControlEnabled({ computer_control: { enabled: true } })).toBe(true);
    expect(isComputerControlEnabled({ computer_control: { enabled: false } })).toBe(false);
    expect(computerControlEnabledPatch(true)).toEqual({ computer_control: { enabled: true } });
    expect(computerControlEnabledPatch(null)).toEqual({ computer_control: { enabled: null } });
    expect(isComputerToolPolicyDenied({})).toBe(false);
    expect(isComputerToolPolicyDenied({ tools: { disabled: ['mcp__kiki-computer__*'] } })).toBe(true);
    expect(isComputerToolPolicyDenied({ tools: { disallowed_tools: ['kiki-computer'] } })).toBe(true);
    expect(isComputerToolPolicyDenied({ tools: { disabled: ['Bash'] } })).toBe(false);
    expect(isComputerToolPolicyPartiallyDenied({ tools: { disabled: ['mcp__kiki-computer__click'] } })).toBe(true);
    expect(isComputerToolPolicyDenied({ tools: { disabled: ['mcp__kiki-computer__click'] } })).toBe(false);
    expect(computerControlConnection({})).toBeUndefined();
    expect(computerControlConnectionPatch('kiki-windows-mcp')).toEqual({ computer_control: { connection: 'kiki-windows-mcp' } });
    expect(computerControlConnectionPatch(null)).toEqual({ computer_control: { connection: null } });
    expect(isComputerToolPolicyDenied({ tools: { disabled: ['mcp__kiki-windows-mcp__*'] } })).toBe(false);
    expect(isComputerToolPolicyDenied({ tools: { disabled: ['mcp__kiki-windows-mcp__*'] } }, 'kiki-windows-mcp')).toBe(true);
    expect(isComputerToolPolicyPartiallyDenied({ tools: { disabled: ['mcp__kiki-computer__click'] } }, 'kiki-windows-mcp')).toBe(false);
    expect(isComputerToolPolicyDenied({ tools: { disabled: ['mcp__kiki-windows-mcp__Click'] } }, 'kiki-windows-mcp')).toBe(false);
  });

  it('leads the computer page with the first gate, and calls ready only what is verified', () => {
    const installed = { state: 'ready' as const, installing: false };
    const base = { enabled: true, toolPolicyDenied: false, executor: installed, hasConnection: true, activeConnectionReady: true };
    expect(computerControlVerdict(base)).toEqual({ kind: 'ready', tone: 'ok' });
    expect(computerControlVerdict({ ...base, enabled: false }).kind).toBe('off');
    expect(computerControlVerdict({ ...base, enabled: false, executor: { state: 'not_installed', installing: false } }).kind).toBe('off');
    expect(computerControlVerdict({ ...base, enabled: false, hostLocked: true })).toEqual({ kind: 'host_locked', tone: 'off' });
    expect(computerControlVerdict({ ...base, unresolved: true }).tone).toBe('unknown');
    expect(computerControlVerdict({ ...base, toolPolicyDenied: true }).kind).toBe('tool_denied');
    expect(computerControlVerdict({ ...base, executor: 'checking' })).toEqual({ kind: 'checking', tone: 'unknown' });
    expect(computerControlVerdict({ ...base, executor: 'unknown' })).toEqual({ kind: 'unknown', tone: 'unknown' });
    expect(computerControlVerdict({ ...base, executor: { state: 'not_installed', installing: true } }).kind).toBe('installing');
    expect(computerControlVerdict({ ...base, executor: { state: 'not_installed', installing: false } }).kind).toBe('not_installed');
    expect(computerControlVerdict({ ...base, executor: { state: 'partial', installing: false } }).kind).toBe('partial');
    expect(computerControlVerdict({ ...base, executor: { state: 'unsupported', installing: false } }).kind).toBe('unsupported');
    expect(computerControlVerdict({ ...base, hasConnection: false }).kind).toBe('no_connection');
    expect(computerControlVerdict({ ...base, activeConnectionReady: false }).kind).toBe('connection_not_ready');
    // External executors (such as Windows-MCP) do not require the bundled CUA capability to be installed,
    // and missing or non-ready connections never report ready.
    expect(computerControlVerdict({ ...base, executor: 'external' })).toEqual({ kind: 'ready', tone: 'ok' });
    expect(computerControlVerdict({ ...base, executor: 'external', hasConnection: false })).toEqual({ kind: 'no_connection', tone: 'attention' });
    expect(computerControlVerdict({ ...base, executor: 'external', activeConnectionReady: false })).toEqual({ kind: 'connection_not_ready', tone: 'attention' });
  });
});

describe('browser-control settings helpers', () => {
  it('marks the browser runtime gate as live for existing sessions', () => {
    expect(experimentalFlagHome('native_browser')?.effect).toBe('now');
  });

  it('reads browser control enabled state from config or experimental flag and creates patch', () => {
    expect(isBrowserControlEnabled({})).toBe(true);
    expect(isBrowserControlEnabled({ browser_control: { enabled: true } })).toBe(true);
    expect(isBrowserControlEnabled({ browser_control: { enabled: false } })).toBe(false);
    expect(isBrowserControlEnabled({ experimental: { native_browser: true } })).toBe(true);
    expect(isBrowserControlEnabled({ experimental: { native_browser: false } })).toBe(false);
    expect(browserControlEnabledPatch(true)).toEqual({
      browser_control: { enabled: true },
    });
    expect(browserControlEnabledPatch(null)).toEqual({
      browser_control: { enabled: null },
    });
  });

  it('detects when browser tools are explicitly denied and distinguishes partial denials', () => {
    expect(isBrowserToolPolicyDenied({})).toBe(false);
    expect(isBrowserToolPolicyPartiallyDenied({})).toBe(false);

    // Partial deny: only BrowserConnections disabled
    expect(isBrowserToolPolicyDenied({ tools: { disabled: ['BrowserConnections'] } })).toBe(false);
    expect(isBrowserToolPolicyPartiallyDenied({ tools: { disabled: ['BrowserConnections'] } })).toBe(true);

    // Partial deny: only BrowserTabs disabled in disallowed_tools (second list merged)
    expect(isBrowserToolPolicyDenied({ tools: { disabled: [], disallowed_tools: ['BrowserTabs'] } })).toBe(false);
    expect(isBrowserToolPolicyPartiallyDenied({ tools: { disabled: [], disallowed_tools: ['BrowserTabs'] } })).toBe(true);

    // Full group deny: both BrowserConnections and BrowserTabs disabled
    expect(isBrowserToolPolicyDenied({ tools: { disabled: ['BrowserConnections', 'BrowserTabs'] } })).toBe(true);
    expect(isBrowserToolPolicyPartiallyDenied({ tools: { disabled: ['BrowserConnections', 'BrowserTabs'] } })).toBe(false);

    // Full group deny: browser wildcard or group
    expect(isBrowserToolPolicyDenied({ tools: { disallowed_tools: ['browser'] } })).toBe(true);
    expect(isBrowserToolPolicyDenied({ tools: { disabled: ['browser__*'] } })).toBe(true);

    expect(isBrowserToolPolicyDenied({ tools: { disabled: ['Bash'] } })).toBe(false);
    expect(isBrowserToolPolicyPartiallyDenied({ tools: { disabled: ['Bash'] } })).toBe(false);
  });

  it('calculates effective allowed browser count considering allowlist and enabled flag', () => {
    const connections = [
      { id: 'b1', enabled: true },
      { id: 'b2', enabled: true },
      { id: 'b3', enabled: false },
    ];

    // Unconfigured: follows enabled !== false
    expect(effectiveAllowedBrowserCount(connections, false, undefined)).toBe(2);

    // Configured empty set: 0 allowed
    expect(effectiveAllowedBrowserCount(connections, true, [])).toBe(0);

    // Configured with allowed list: intersection with enabled
    expect(effectiveAllowedBrowserCount(connections, true, ['b1', 'b3'])).toBe(1);
    expect(isBrowserConnectionEffectiveAllowed(connections[0]!, true, ['b1'])).toBe(true);
    expect(isBrowserConnectionEffectiveAllowed(connections[1]!, true, ['b1'])).toBe(false);
    expect(isBrowserConnectionEffectiveAllowed(connections[2]!, true, ['b3'])).toBe(false);

    const cdp = { id: 'cdp', enabled: true, type: 'agent-browser-cdp' };
    expect(effectiveAllowedBrowserCount([cdp], true, ['cdp'], ['independent-browser'])).toBe(0);
    expect(effectiveAllowedBrowserCount([cdp], true, ['cdp'], ['kimi-webbridge'])).toBe(1);
    expect(isBrowserConnectionEffectiveAllowed({ id: 'kimi-webbridge', enabled: true }, true, ['kimi-webbridge'], ['kimi-webbridge'])).toBe(false);
  });

  it('attributes the bridge source the way the server does, and keeps the other switches apart', () => {
    // The public type belongs to the bridge whatever its id is.
    expect(browserSourceOfConnectionType('kimi-webbridge', 'daily-edge')).toBe('kimi-webbridge');
    expect(browserSourceOfConnectionType('webbridge-command', 'daily-edge')).toBe('kimi-webbridge');
    // A record still stored as CDP under the preset id runs over the bridge, so
    // classifying it by type first would report it allowed while the server refuses it.
    expect(browserSourceOfConnectionType('agent-browser-cdp', 'kimi-webbridge')).toBe('kimi-webbridge');
    expect(browserSourceOfConnectionType('agent-browser-cdp', 'edge-kimi')).toBe('independent-browser');
    expect(browserSourceOfConnectionType('agent-browser-profile', 'research')).toBe('independent-browser');
    expect(browserSourceOfConnectionType('codex-extension', 'codex-browser')).toBe('codex-browser');
    expect(browserSourceOfConnectionType('ego-lite', 'ego-lite')).toBe('ego-lite');
    expect(browserSourceOfConnectionType(undefined, 'unsaved')).toBeUndefined();

    const bridge = { id: 'daily-edge', enabled: true, type: 'kimi-webbridge' };
    const legacyBridge = { id: 'kimi-webbridge', enabled: true, type: 'agent-browser-cdp' };
    const cdp = { id: 'preview', enabled: true, type: 'agent-browser-cdp' };
    const profile = { id: 'research', enabled: true, type: 'agent-browser-profile' };
    // Switching the bridge source off reaches both stored forms and nothing else.
    expect(isBrowserConnectionEffectiveAllowed(bridge, false, undefined, ['kimi-webbridge'])).toBe(false);
    expect(isBrowserConnectionEffectiveAllowed(legacyBridge, false, undefined, ['kimi-webbridge'])).toBe(false);
    expect(isBrowserConnectionEffectiveAllowed(cdp, false, undefined, ['kimi-webbridge'])).toBe(true);
    expect(isBrowserConnectionEffectiveAllowed(profile, false, undefined, ['kimi-webbridge'])).toBe(true);
    // The independent switch is the one that covers those two, and only them.
    expect(isBrowserConnectionEffectiveAllowed(cdp, false, undefined, ['independent-browser'])).toBe(false);
    expect(isBrowserConnectionEffectiveAllowed(profile, false, undefined, ['independent-browser'])).toBe(false);
    expect(isBrowserConnectionEffectiveAllowed(bridge, false, undefined, ['independent-browser'])).toBe(true);
    // An explicit off switch wins over an allowlist that still names the connection.
    expect(isBrowserConnectionEffectiveAllowed(bridge, true, ['daily-edge'], ['kimi-webbridge'])).toBe(false);
    expect(isBrowserConnectionEffectiveAllowed(bridge, true, ['daily-edge'])).toBe(true);
    expect(isBrowserConnectionEffectiveAllowed(bridge, true, ['other'])).toBe(false);
    // Explicitly disabled stays disabled with no source switch and no saved set.
    expect(isBrowserConnectionEffectiveAllowed({ ...bridge, enabled: false }, false, undefined)).toBe(false);
    // An allowlist that names only the legacy row still reaches it through the bridge source.
    expect(effectiveAllowedBrowserCount([legacyBridge, cdp], true, ['kimi-webbridge'], undefined)).toBe(1);
  });

  it('leads with the first configuration gate and never counts allowed as connected', () => {
    const rows = [
      { id: 'research', enabled: true, type: 'agent-browser-profile' },
      { id: 'edge', enabled: true, type: 'kimi-webbridge' },
      { id: 'legacy', enabled: false, type: 'agent-browser-profile' },
    ];
    const base = { enabled: true, toolPolicyDenied: false, connections: rows, allowedBrowsersConfigured: false };
    expect(browserControlVerdict(base)).toEqual({ kind: 'allowed', tone: 'ok', allowedCount: 2, defaultBrowser: undefined });
    // Off keeps the stored choices: the count is still reported, the verdict is off.
    expect(browserControlVerdict({ ...base, enabled: false })).toMatchObject({ kind: 'off', tone: 'off', allowedCount: 2 });
    expect(browserControlVerdict({ ...base, enabled: false, hostLocked: true }).kind).toBe('host_locked');
    expect(browserControlVerdict({ ...base, unresolved: true }).kind).toBe('unresolved');
    expect(browserControlVerdict({ ...base, toolPolicyDenied: true }).kind).toBe('tool_denied');
    expect(browserControlVerdict({ ...base, connections: undefined })).toMatchObject({ kind: 'unknown', tone: 'unknown' });
    expect(browserControlVerdict({ ...base, connections: [] }).kind).toBe('no_connections');
    expect(browserControlVerdict({ ...base, allowedBrowsersConfigured: true, allowedBrowsers: [] }).kind).toBe('none_allowed');
    // A source switched off removes only its own connections.
    expect(browserControlVerdict({ ...base, disabledSources: ['kimi-webbridge'] })).toMatchObject({ kind: 'allowed', allowedCount: 1 });
    // The default is its own fact: being the default never makes a connection allowed.
    expect(browserControlVerdict({ ...base, defaultBrowser: 'legacy' })).toMatchObject({ kind: 'default_not_allowed', defaultBrowser: 'legacy' });
    expect(browserControlVerdict({ ...base, defaultBrowser: 'gone' }).kind).toBe('default_not_allowed');
    expect(browserControlVerdict({ ...base, defaultBrowser: 'edge', disabledSources: ['kimi-webbridge'] }).kind).toBe('default_not_allowed');
    expect(browserControlVerdict({ ...base, defaultBrowser: 'research' })).toMatchObject({ kind: 'allowed', defaultBrowser: 'research' });
    expect(browserControlVerdict({ ...base, defaultBrowser: '' }).defaultBrowser).toBeUndefined();
  });
});

describe('memory advisor settings', () => {
  const status = (state: string, extra: Record<string, unknown> = {}) => ({ state, consent_required: false, logical_calls: 0, requests: 0, retries: 0, displaced_ids: [], unjudged_count: 0, ...extra }) as never;
  const config = (extra: Record<string, unknown> = {}) => ({ mode: 'rank', egress_ack: [], ...extra }) as never;

  it('reads its ranges from the protocol schema and validates against them', () => {
    expect(MEMORY_ADVISOR_RANGES.timeout_ms).toEqual({ min: 100, max: 60_000, fallback: 6_000 });
    expect(MEMORY_ADVISOR_RANGES.max_calls_per_turn).toEqual({ min: 1, max: 10, fallback: 3 });
    expect(parseMemoryAdvisorNumber('timeout_ms', '99')).toBeNull();
    expect(parseMemoryAdvisorNumber('timeout_ms', '6000')).toBe(6000);
    expect(parseMemoryAdvisorNumber('candidate_chars', '1.5')).toBeNull();
  });

  it('shows the first-step wait the source protocol uses until the user sets one', () => {
    expect(memoryAdvisorNumberValue('first_step_wait_ms', config(), status('ready', { first_step_wait_default_ms: 3000 }))).toEqual({ value: 3000, fallback: 3000, explicit: false });
    expect(memoryAdvisorNumberValue('first_step_wait_ms', config(), status('ready', { protocol: 'chat_json' }))).toEqual({ value: 1500, fallback: 1500, explicit: false });
    expect(memoryAdvisorNumberValue('first_step_wait_ms', config({ first_step_wait_ms: 1500 }), status('ready', { first_step_wait_default_ms: 3000 }))).toEqual({ value: 1500, fallback: 3000, explicit: true });
    expect(memoryAdvisorNumberValue('timeout_ms', config(), undefined)).toEqual({ value: 6000, fallback: 6000, explicit: false });
  });

  it('switches with the mode alone and treats a missing block as available but waiting', () => {
    expect(memoryAdvisorModePatch(false)).toEqual({ advisor: { mode: 'off' } });
    expect(memoryAdvisorModePatch(true, config({ mode: 'off' }))).toEqual({ advisor: { mode: 'rank' } });
    expect(memoryAdvisorModePatch(true, config({ mode: 'select' }))).toEqual({ advisor: { mode: 'select' } });
    expect(memoryAdvisorOn(undefined)).toBe(true);
    expect(memoryAdvisorOn(config({ mode: 'off' }))).toBe(false);
    expect(memoryAdvisorView(undefined, status('unconfigured')).kind).toBe('unconfigured');
  });

  it('separates off, missing model, failure and running', () => {
    const selector = { protocol: 'chat_json', model: 'judge' };
    expect(memoryAdvisorView(config({ mode: 'off', selector }), status('off')).kind).toBe('off');
    expect(memoryAdvisorView(config({ selector }), status('failed', { reason: 'consent_required', consent_required: true })).kind).toBe('problem');
    const failed = memoryAdvisorView(config({ selector }), status('failed', { reason: 'auth' }));
    expect(failed).toMatchObject({ kind: 'problem', tone: 'danger', reasonKey: 'memory.advisor.reason.auth' });
    expect(memoryAdvisorView(config({ selector }), status('selected')).stateKey).toBe('memory.advisor.state.selected');
  });

  it('keeps a non-chat endpoint on the model provider origin', () => {
    expect(memoryAdvisorEndpointIssue('https://api.example.test/v1/rerank', 'https://api.example.test/v1')).toBeNull();
    expect(memoryAdvisorEndpointIssue('https://other.example.test/score', 'https://api.example.test/v1')).toEqual({ kind: 'origin', origin: 'https://api.example.test' });
    expect(memoryAdvisorEndpointIssue('not a url', 'https://api.example.test')).toEqual({ kind: 'invalid' });
    expect(memoryAdvisorEndpointIssue('https://api.example.test/x', undefined)).toEqual({ kind: 'no_provider_url' });
    expect(memoryAdvisorEndpointIssue('https://user:pw@api.example.test/x', 'https://api.example.test')).toEqual({ kind: 'invalid' });
    expect(memoryAdvisorSelectorFromDraft({ protocol: 'chat_json', model: ' judge ', endpoint: 'ignored' })).toEqual({ protocol: 'chat_json', model: 'judge' });
    expect(memoryAdvisorSelectorFromDraft({ protocol: 'pair_score', model: 'judge', endpoint: '' })).toBeNull();
  });

  it('checks the endpoint against the model override before the provider address', () => {
    const provider = { base_url: 'https://api.example.test/v1' };
    const effective = memoryAdvisorModelBaseUrl({ base_url: 'https://judge.example.test/v1' }, provider);
    expect(effective).toBe('https://judge.example.test/v1');
    expect(memoryAdvisorEndpointIssue('https://judge.example.test/v1/rerank', effective)).toBeNull();
    expect(memoryAdvisorEndpointIssue('https://api.example.test/v1/rerank', effective)).toEqual({ kind: 'origin', origin: 'https://judge.example.test' });
    expect(memoryAdvisorModelBaseUrl({}, provider)).toBe('https://api.example.test/v1');
    expect(memoryAdvisorModelBaseUrl({ base_url: ' ' }, undefined, 'https://env.example.test')).toBe('https://env.example.test');
    expect(memoryAdvisorModelBaseUrl(undefined, undefined)).toBeUndefined();
    expect(memoryAdvisorModelBaseUrl({ effective_base_url: 'https://vendor.example.test/v1', base_url: 'https://stale.example.test' }, provider, 'https://status.example.test')).toBe('https://vendor.example.test/v1');
  });

});
