import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agentIdentityPatch,
  appendExtraSkillDirs,
  AI_SETTINGS_TABS,
  aiTabForCard,
  buildSettingsSearchIndex,
  clearRestartRequirement,
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
  parseRemoteModels,
  providerDraftFromCatalog,
  providerDefaultRow,
  providerCreateBody,
  providerPatchBody,
  modelPatchBody,
  modelCreateBody,
  providerTemplateFor,
  isComposerSendKey,
  isDefaultAppendTiming,
  readDesktopPrefs,
  readRestartRequirement,
  readSettings,
  requestIdentityLayerDraftFromPolicy,
  requestIdentityPolicyFromDraft,
  resourceLimitPatch,
  sessionTitleModelPatch,
  remoteModelsHeaders,
  remoteModelsUrl,
  resolveEffectiveModel,
  resolveModelSource,
  resolveSessionModelOverride,
  resolveSettingsRoute,
  restartRequirementSnapshot,
  runtimeConfigDraftFromConfig,
  searchSettings,
  SEARCH_SETTINGS_TABS,
  searchTabForCard,
  serverFileSettingsFromConfig,
  serverFileSettingsPatch,
  SETTINGS_SEARCH_SPEC,
  SETTINGS_SECTIONS,
  SETTINGS_NAV_TREE,
  SETTINGS_SECTION_META,
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
import { clearStoredDrafts, readDraft, resetDraftMemoryForTests, writeDraft } from '../composer/drafts';
import { translate, type I18nKey } from '../i18n/locale';
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
    expect(readSettings().defaultPermissionMode).toBe('manual');
    expect(readSettings().requestTimeoutSeconds).toBe(30);
    expect(readSettings().subagentPanelOpenMode).toBe('tab');
    expect(readSettings().defaultAppendTiming).toBe('agent_idle');
    expect(readDesktopPrefs()).toEqual({
      notifications: false,
      closeToTray: true,
      updateChannel: 'stable',
      autoUpdate: 'notify',
      compatibility: {
        homeKind: 'kimi',
        customHome: undefined,
      },
    });

    localStorage.setItem('kiki.desktopPrefs', '{not-json');
    expect(readDesktopPrefs().closeToTray).toBe(true);
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
    expect(parseExperimentalFlags('{"search_worker":true}')).toEqual({ search_worker: true });
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
    expect(() => resourceLimitPatch(draft)).toThrow(/image\.max_edge_px/);
    draft.imageMaxEdgePx = '';
    // The mcp domain upper bound is enforced by its own leaf's patch helper.
    expect(() => mcpTimeoutsPatch('2147483648', '')).toThrow(/mcp\.startup_timeout_ms/);
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
    })).toThrow(/supported leaf/);
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
    await expect(fetchRemoteModels({ type: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'secret-echo-value' }))
      .rejects.toThrow(/^HTTP 401$/);
    fetchMock.mockRejectedValueOnce(new Error('transport echoed secret-echo-value'));
    await expect(fetchRemoteModels({ type: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'secret-echo-value' }))
      .rejects.toThrow(/^Model probe failed\. Check the endpoint and credentials\.$/);
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
      .rejects.toThrow(/HTTP 401/);
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
    expect(searchSettings(index, 'experimental feature').some((hit) => hit.cardId === 'st-card-performance-storage')).toBe(true);
    expect(searchSettings(index, 'Task board').some((hit) => hit.section === 'tasks' && hit.cardId === 'st-card-task-board')).toBe(true);
    expect(searchSettings(index, 'plan mode').some((hit) => hit.section === 'tasks' && hit.cardId === 'st-card-defaults')).toBe(true);
    expect(searchSettings(index, 'conversation titles').some((hit) => hit.section === 'general' && hit.cardId === 'st-card-session-title')).toBe(true);
    expect(searchSettings(index, 'denied subagent models').some((hit) => hit.cardId === 'st-card-subagents')).toBe(true);
    expect(searchSettings(index, 'pinned model alias').some((hit) => hit.cardId === 'st-card-subagent-profiles')).toBe(true);
    expect(searchSettings(index, 'Main agents').some((hit) => hit.cardId === 'st-card-main-agents')).toBe(true);
    expect(searchSettings(index, 'subagent')[0]?.section).toBe('subagents');
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

describe('settings nav groups (redesign batch 1)', () => {
  it('matches the adjudicated topology: six groups plus an ungrouped About leaf', () => {
    const groups = SETTINGS_NAV_TREE.filter((node) => node.kind === 'group');
    const leaves = SETTINGS_NAV_TREE.filter((node) => node.kind === 'leaf');
    expect(groups.map((group) => group.id))
      .toEqual(['app', 'ai', 'agents', 'extensions', 'system', 'advanced']);
    // Batch 3 filled the last empty group: every group now owns leaves.
    expect(groups.every((group) => group.sections.length > 0)).toBe(true);
    // "About & updates" is a clickable leaf outside all groups, not a group.
    expect(leaves.map((leaf) => leaf.section)).toEqual(['about']);
    expect(settingsGroupForSection('about')).toBeUndefined();
  });

  it('places every section exactly once, high-frequency first', () => {
    const placed = SETTINGS_NAV_TREE.flatMap((node) => node.kind === 'group' ? node.sections : [node.section]);
    expect([...placed].toSorted()).toEqual(SETTINGS_SECTIONS.map((section) => section.id).toSorted());
    expect(new Set(placed).size).toBe(placed.length);
    expect(SETTINGS_NAV_TREE[0]).toMatchObject({ kind: 'group', id: 'app' });
    expect(SETTINGS_NAV_TREE.at(-1)).toEqual({ kind: 'leaf', section: 'about' });
    expect(settingsGroupForSection('ai')?.id).toBe('ai');
    // The Plan & tasks leaf owns plan defaults, the task board, and the task
    // policy/cron cards from the retired runtime leaf; the remaining engine
    // knobs live under Data & advanced, identity under Agents.
    expect(settingsGroupForSection('skills')?.id).toBe('extensions');
    expect(settingsGroupForSection('mcp')?.id).toBe('extensions');
    expect(settingsGroupForSection('plugins')?.id).toBe('extensions');
    expect(settingsGroupForSection('automation')?.id).toBe('extensions');
    expect(settingsGroupForSection('tasks')?.id).toBe('extensions');
    expect(settingsGroupForSection('search')?.id).toBe('extensions');
    expect(settingsGroupForSection('subagents')?.id).toBe('agents');
    expect(settingsGroupForSection('runtime')).toBeUndefined();
    expect(settingsGroupForSection('experimental')).toBeUndefined();
    expect(settingsGroupForSection('advanced')?.id).toBe('advanced');
    expect(settingsGroupForSection('workspaces')?.id).toBe('system');
    expect(settingsGroupForSection('connection')?.id).toBe('system');
    expect(settingsGroupForSection('capabilities')).toBeUndefined();
    expect(settingsGroupForSection('nope')).toBeUndefined();
  });

  it('declares every scope a page actually writes after the content split', () => {
    for (const section of SETTINGS_SECTIONS) {
      const meta = SETTINGS_SECTION_META[section.id];
      expect(meta, section.id).toBeDefined();
      expect(meta!.scopes.length).toBeGreaterThan(0);
      for (const scope of meta!.scopes) {
        expect(['app', 'server', 'workspace']).toContain(scope);
      }
    }
    // General mixes device prefs with server-side session defaults; Skills
    // and MCP mix server config with per-workspace targets; Agents and
    // Subagents mix server-wide governance with workspace-sourced profiles.
    expect(SETTINGS_SECTION_META['general']?.scopes).toEqual(['app', 'server']);
    expect(SETTINGS_SECTION_META['skills']?.scopes).toEqual(['server', 'workspace']);
    expect(SETTINGS_SECTION_META['mcp']?.scopes).toEqual(['server', 'workspace']);
    expect(SETTINGS_SECTION_META['plugins']?.scopes).toEqual(['server']);
    expect(SETTINGS_SECTION_META['agents']?.scopes).toEqual(['server', 'workspace']);
    expect(SETTINGS_SECTION_META['subagents']?.scopes).toEqual(['server', 'workspace']);
    expect(SETTINGS_SECTION_META['ai']?.scopes).toEqual(['server']);
    expect(SETTINGS_SECTION_META['runtime']).toBeUndefined();
    expect(SETTINGS_SECTION_META['automation']?.scopes).toEqual(['server']);
    expect(SETTINGS_SECTION_META['search']?.scopes).toEqual(['server']);
    expect(SETTINGS_SECTION_META['tasks']?.scopes).toEqual(['server']);
    expect(SETTINGS_SECTION_META['advanced']?.scopes).toEqual(['server']);
  });
});

describe('settings search breadcrumbs and synonyms', () => {
  const t = (key: I18nKey): string => translate('en', key);
  const tZh = (key: I18nKey): string => translate('zh', key);

  it('carries the visual group into grouped hits for the group › leaf › card breadcrumb', () => {
    const index = buildSettingsSearchIndex({ general: 'General' }, t);
    const models = index.find((entry) => entry.cardId === 'st-card-models');
    expect(models?.groupLabel).toBe('AI configuration');
    // About is an ungrouped top-level leaf: its hits have no group crumb.
    const about = index.find((entry) => entry.cardId === 'st-card-about');
    expect(about?.groupLabel).toBe('');
    expect(index.filter((entry) => entry.section !== 'about').every((entry) => entry.groupLabel !== '')).toBe(true);
    // Group labels are indexed too, so "AI configuration" finds its leaves.
    expect(searchSettings(index, 'AI configuration').some((hit) => hit.section === 'ai')).toBe(true);
  });

  it.each([
    ['能力', 'st-card-caps'],
    ['供应商', 'st-card-providers'],
    ['提供商', 'st-card-auth'],
    ['模型目录', 'st-card-models'],
    ['模型目录刷新', 'st-card-catalog-refresh'],
    ['Profiles', 'st-card-subagent-profiles'],
    ['子 Agent', 'st-card-subagents'],
  ])('matches the legacy/synonym term %s in English', (term, cardId) => {
    const index = buildSettingsSearchIndex({}, t);
    expect(searchSettings(index, term).some((hit) => hit.cardId === cardId)).toBe(true);
  });

  it.each([
    ['能力', 'st-card-caps'],
    ['供应商', 'st-card-providers'],
    ['model catalog', 'st-card-models'],
    ['catalog refresh', 'st-card-catalog-refresh'],
  ])('matches the legacy/synonym term %s in Chinese', (term, cardId) => {
    const index = buildSettingsSearchIndex({}, tZh);
    expect(searchSettings(index, term).some((hit) => hit.cardId === cardId)).toBe(true);
  });

  it('finds dispatch-policy defaults and opens the subagent settings card in both locales', () => {
    for (const [translateKey, query] of [[t, 'dispatch policy'], [tZh, '派遣策略']] as const) {
      const index = buildSettingsSearchIndex({}, translateKey);
      expect(searchSettings(index, query).find((hit) => hit.cardId === 'st-card-subagent-dispatch-policies'))
        .toMatchObject({ section: 'subagents', cardId: 'st-card-subagent-dispatch-policies' });
    }
  });

  it('points the catalog-refresh hit at the models tab so the card is mounted on arrival', () => {
    const index = buildSettingsSearchIndex({}, t);
    const hit = searchSettings(index, 'Get models')
      .find((entry) => entry.cardId === 'st-card-catalog-refresh');
    expect(hit).toMatchObject({ section: 'ai', tab: 'models' });
  });
});

describe('settings route resolver', () => {
  it('lands bare /settings on the default page', () => {
    expect(resolveSettingsRoute(undefined, '')).toEqual({ status: 'ok', section: 'general', cardId: undefined });
    expect(resolveSettingsRoute('', '')).toEqual({ status: 'ok', section: 'general', cardId: undefined });
  });

  it('passes known sections through and keeps a local card hash', () => {
    expect(resolveSettingsRoute('ai', '#st-card-models'))
      .toEqual({ status: 'ok', section: 'ai', cardId: 'st-card-models', tab: 'models' });
    expect(resolveSettingsRoute('ai', ''))
      .toEqual({ status: 'ok', section: 'ai', cardId: undefined, tab: undefined });
    expect(resolveSettingsRoute('about', ''))
      .toEqual({ status: 'ok', section: 'about', cardId: undefined });
  });

  it('redirects the legacy models/providers sections to the merged ai entry with their tab', () => {
    // Redesign §10.3: /settings/models → /settings/ai?tab=models,
    // /settings/providers → /settings/ai?tab=providers; request identity and
    // thinking cards land on the defaults tab regardless of the legacy page.
    expect(resolveSettingsRoute('models', ''))
      .toEqual({ status: 'ok', section: 'ai', cardId: undefined, tab: 'models' });
    expect(resolveSettingsRoute('providers', ''))
      .toEqual({ status: 'ok', section: 'ai', cardId: undefined, tab: 'providers' });
    expect(resolveSettingsRoute('models', '#st-card-request-identity'))
      .toEqual({ status: 'ok', section: 'ai', cardId: 'st-card-request-identity', tab: 'defaults' });
    expect(resolveSettingsRoute('models', '#st-card-thinking'))
      .toEqual({ status: 'ok', section: 'ai', cardId: 'st-card-thinking', tab: 'defaults' });
    expect(resolveSettingsRoute('providers', '#st-card-auth'))
      .toEqual({ status: 'ok', section: 'ai', cardId: 'st-card-auth', tab: 'providers' });
  });

  it('redirects the retired experimental page and keeps feature card owners precise', () => {
    expect(resolveSettingsRoute('experimental', ''))
      .toEqual({ status: 'ok', section: 'advanced', cardId: undefined, tab: undefined });
    expect(resolveSettingsRoute('experimental', '#st-card-experimental'))
      .toEqual({ status: 'ok', section: 'advanced', cardId: 'st-card-performance-storage', tab: undefined });
    expect(resolveSettingsRoute('experimental', '#st-card-tool-experiments'))
      .toEqual({ status: 'ok', section: 'automation', cardId: 'st-card-tool-experiments', tab: undefined });
    expect(resolveSettingsRoute('agents', '#st-card-task-board'))
      .toEqual({ status: 'ok', section: 'tasks', cardId: 'st-card-task-board', tab: undefined });
    expect(resolveSettingsRoute('general', '#st-card-defaults'))
      .toEqual({ status: 'ok', section: 'tasks', cardId: 'st-card-defaults', tab: undefined });
  });

  it('follows a card hash whose content moved to another section', () => {
    // A bookmark written before a content move: section says general, card
    // says the card now lives under mcp — the precise half wins.
    expect(resolveSettingsRoute('general', '#st-card-mcp'))
      .toEqual({ status: 'ok', section: 'mcp', cardId: 'st-card-mcp', tab: undefined });
    expect(resolveSettingsRoute('retired-section', '#st-card-workspaces'))
      .toEqual({ status: 'ok', section: 'workspaces', cardId: 'st-card-workspaces', tab: undefined });
    expect(resolveSettingsRoute('retired-section', '#st-card-models'))
      .toEqual({ status: 'ok', section: 'ai', cardId: 'st-card-models', tab: 'models' });
    // The catalog-refresh controls moved out of the agents sidecar onto the
    // models tab of the merged ai entry; old sidecar deep links follow them.
    expect(resolveSettingsRoute('agents', '#st-card-catalog-refresh'))
      .toEqual({ status: 'ok', section: 'ai', cardId: 'st-card-catalog-refresh', tab: 'models' });
  });

  it('redirects the retired capabilities section and its card deep links (redesign §10.3)', () => {
    // Bare /settings/capabilities lands on skills, the split's primary leaf.
    expect(resolveSettingsRoute('capabilities', ''))
      .toEqual({ status: 'ok', section: 'skills', cardId: undefined, tab: undefined });
    // A precise card hash still follows the card across the split.
    expect(resolveSettingsRoute('capabilities', '#st-card-mcp'))
      .toEqual({ status: 'ok', section: 'mcp', cardId: 'st-card-mcp', tab: undefined });
    expect(resolveSettingsRoute('capabilities', '#st-card-tools'))
      .toEqual({ status: 'ok', section: 'automation', cardId: 'st-card-tools', tab: undefined });
    expect(resolveSettingsRoute('capabilities', '#st-card-caps'))
      .toEqual({ status: 'ok', section: 'skills', cardId: 'st-card-caps', tab: undefined });
    // The dissolved sidecar card has no field-level hash, so its hand-written
    // alias lands on the subagent timeout card (§10.3's adjudicated fallback).
    expect(resolveSettingsRoute('agents', '#st-card-sidecar'))
      .toEqual({ status: 'ok', section: 'subagents', cardId: 'st-card-subagent-timeout', tab: undefined });
    expect(resolveSettingsRoute('retired-section', '#st-card-sidecar'))
      .toEqual({ status: 'ok', section: 'subagents', cardId: 'st-card-subagent-timeout', tab: undefined });
  });

  it('redirects the retired runtime page to tasks and keeps dissolved card links precise', () => {
    // Bare /settings/runtime lands on tasks, where its dominant content (task
    // policy, cron) now lives; the dissolved st-card-runtime hash follows its
    // hand-written alias to the task-policy card.
    expect(resolveSettingsRoute('runtime', ''))
      .toEqual({ status: 'ok', section: 'tasks', cardId: undefined, tab: undefined });
    expect(resolveSettingsRoute('runtime', '#st-card-runtime'))
      .toEqual({ status: 'ok', section: 'tasks', cardId: 'st-card-task-policy', tab: undefined });
    expect(resolveSettingsRoute('retired-section', '#st-card-runtime'))
      .toEqual({ status: 'ok', section: 'tasks', cardId: 'st-card-task-policy', tab: undefined });
    // Cards that moved out of the runtime page resolve to their new owners;
    // the dissolved st-card-communication hash follows its hand-written alias
    // to the communication leaf's thread card.
    expect(resolveSettingsRoute('runtime', '#st-card-cron'))
      .toEqual({ status: 'ok', section: 'tasks', cardId: 'st-card-cron', tab: undefined });
    expect(resolveSettingsRoute('runtime', '#st-card-communication'))
      .toEqual({ status: 'ok', section: 'communication', cardId: 'st-card-thread-communication', tab: undefined });
    expect(resolveSettingsRoute('runtime', '#st-card-resource-limits'))
      .toEqual({ status: 'ok', section: 'advanced', cardId: 'st-card-resource-limits', tab: undefined });
    expect(resolveSettingsRoute('runtime', '#st-card-agent-runtime'))
      .toEqual({ status: 'ok', section: 'agents', cardId: 'st-card-agent-runtime', tab: undefined });
  });

  it('flags genuinely unknown sections instead of silently falling back to general', () => {
    expect(resolveSettingsRoute('nonsense', '')).toEqual({ status: 'unknown', section: 'nonsense', cardId: undefined });
    expect(resolveSettingsRoute('nonsense', '#st-card-not-real')).toEqual({ status: 'unknown', section: 'nonsense', cardId: 'st-card-not-real' });
    expect(resolveSettingsRoute('nonsense', '#other-anchor')).toEqual({ status: 'unknown', section: 'nonsense', cardId: undefined });
  });

  it('knows the canonical owner of every indexed card', () => {
    expect(settingsSectionForCard('st-card-mcp')).toBe('mcp');
    expect(settingsSectionForCard('st-card-language')).toBe('general');
    expect(settingsSectionForCard('st-card-task-policy')).toBe('tasks');
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

  it('scopes the session-title model patch to the session_title replace-domain', () => {
    expect(sessionTitleModelPatch(' kimi-for-coding ')).toEqual({
      session_title: { model: 'kimi-for-coding' },
      replace_domains: ['session_title'],
    });
    expect(sessionTitleModelPatch('   ')).toEqual({
      session_title: { model: undefined },
      replace_domains: ['session_title'],
    });
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
    })).toThrow('st.mcp.envInvalid');
  });
});
