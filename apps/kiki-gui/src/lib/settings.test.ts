import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendExtraSkillDirs,
  buildSettingsSearchIndex,
  CAPABILITY_GROUPS,
  capabilityGroupForCard,
  clearRestartRequirement,
  fetchRemoteModels,
  humanizeMs,
  acknowledgeRestartRequirement,
  isProviderDraftDirty,
  isRestartRequirementAcknowledged,
  markRestartRequired,
  msUnitFor,
  normalizeTags,
  parseAdvancedServerConfig,
  parseExperimentalFlags,
  parseRemoteModels,
  providerDraftFromCatalog,
  providerTemplateFor,
  isComposerSendKey,
  readDesktopPrefs,
  readRestartRequirement,
  readSettings,
  remoteModelsHeaders,
  remoteModelsUrl,
  replaceProvider,
  resolveEffectiveModel,
  resolveModelSource,
  resolveSessionModelOverride,
  restartRequirementSnapshot,
  runtimeConfigDraftFromConfig,
  runtimeConfigPatch,
  searchSettings,
  serverFileSettingsFromConfig,
  serverFileSettingsPatch,
  SETTINGS_SEARCH_SPEC,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeRestartRequirement,
  subscribeSettings,
  validateDesktopConfigDraft,
  validateProviderDraft,
  validateServerDefaults,
  writeDesktopPrefs,
  writeSettings,
  type ProviderDraft,
} from './settings';
import { clearStoredDrafts, readDraft, resetDraftMemoryForTests, writeDraft } from './drafts';
import { translate, type I18nKey } from '../i18n/locale';
import { mcpConfigFromDraft, parseNamedAgentTools } from '../components/SettingsPage';

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
  defaultModel: 'chat',
  apiKey: '',
  clearApiKey: false,
  requestIdentityChoice: 'auto',
  requestIdentityOverridesJson: '',
  models: [
    {
      model: 'chat',
      maxContextSize: 128000,
      displayName: 'Example Chat',
      capabilities: ['reasoning'],
      supportEfforts: ['low', 'high'],
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
    expect(readDesktopPrefs().closeToTray).toBe(true);

    localStorage.setItem('kiki.settings', JSON.stringify({ sendShortcut: 'invalid', defaultPermissionMode: 'root' }));
    localStorage.setItem('kiki.desktopPrefs', JSON.stringify({ notifications: false }));
    expect(readSettings().sendShortcut).toBe('enter');
    expect(readSettings().defaultPermissionMode).toBe('manual');
    expect(readDesktopPrefs()).toEqual({
      notifications: false,
      closeToTray: true,
      compatibility: {
        homeKind: 'kimi',
        customHome: undefined,
      },
    });

    localStorage.setItem('kiki.desktopPrefs', '{not-json');
    expect(readDesktopPrefs().closeToTray).toBe(true);
  });

  it('preserves an explicitly persisted quit choice', () => {
    writeDesktopPrefs({ closeToTray: false });
    expect(readDesktopPrefs().closeToTray).toBe(false);
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
    let second = markRestartRequired(['telemetry']);
    while (second.changedAt === first.changedAt) second = markRestartRequired(['mcp']);
    expect(isRestartRequirementAcknowledged(second)).toBe(false);
    clearRestartRequirement();
  });

  it('rejects invalid server, desktop, provider, and experiment values before writes', () => {
    expect(validateServerDefaults('root')?.key).toBe('val.permissionMode');
    expect(validateServerDefaults('auto')).toBeNull();
    expect(validateDesktopConfigDraft({
      subagentDefaultModel: ' example/chat',
      subagentDefaultEffort: 'high',
      subagentTimeoutMs: 60_000,
      defaultSubagentModel: '',
      defaultSubagentReasoningEffort: '',
      modelCatalogRefreshIntervalMs: 0,
    })?.key).toBe('val.spacesSubagentModel');
    expect(validateDesktopConfigDraft({
      subagentDefaultModel: 'example/chat',
      subagentDefaultEffort: 'high',
      subagentTimeoutMs: 86_400_001,
      defaultSubagentModel: '',
      defaultSubagentReasoningEffort: '',
      modelCatalogRefreshIntervalMs: 0,
    })?.key).toBe('val.timeoutMax');
    expect(validateProviderDraft(providerDraft({ baseUrl: 'file:///secret' }))?.key).toBe('val.baseUrlHttp');
    expect(validateProviderDraft(providerDraft({ apiKey: 'bad\nkey' }))?.key).toBe('val.apiKeyLineBreaks');
    expect(() => parseExperimentalFlags('{"flag":"yes"}')).toThrow('true or false');
    expect(parseExperimentalFlags('{"search_worker":true}')).toEqual({ search_worker: true });
    expect(() => parseAdvancedServerConfig('{"hooks":{}}')).toThrow('JSON array');
    expect(() => parseAdvancedServerConfig('{"unknown":true}')).toThrow('Unsupported');
    expect(parseAdvancedServerConfig('{"hooks":[],"background":{"max":2}}')).toEqual({
      permission: undefined,
      hooks: [],
      services: undefined,
      loop_control: undefined,
      background: { max: 2 },
    });
  });

  it('maps server-file settings to and from the kap-server config API shape', () => {
    const settings = serverFileSettingsFromConfig({
      providers: {},
      subagent: { defaultModel: 'example/worker', defaultEffort: 'high', timeoutMs: 60_000 },
      agents: {
        enabled: false,
        defaultSubagentModel: 'example/collaborator',
        defaultSubagentReasoningEffort: 'medium',
      },
      builtin_product_skills: false,
      model_catalog: { refreshIntervalMs: 300_000, refreshOnStart: true },
    });

    expect(serverFileSettingsPatch(settings)).toEqual({
      subagent: {
        default_model: 'example/worker',
        default_effort: 'high',
        timeout_ms: 60_000,
      },
      agents: {
        enabled: false,
        default_subagent_model: 'example/collaborator',
        default_subagent_reasoning_effort: 'medium',
      },
      builtin_product_skills: false,
      model_catalog: { refresh_interval_ms: 300_000, refresh_on_start: true },
    });
  });

  it('maps every runtime config domain from GET projection to a replacement patch', () => {
    const draft = runtimeConfigDraftFromConfig({
      providers: {},
      cron: { debug: true, noJitter: true, noStale: false, disabled: false, manualTick: true, clock: 'utc', pollIntervalMs: null },
      thread_communication: { enabled: true },
      token_counting: { strategy: 'measured' },
      workspace_instance: { idleTtlMs: 120_000 },
      image: { maxEdgePx: 2048, readByteBudget: 4_000_000 },
      task: { maxRunningTasks: 4, keepAliveOnExit: true, printBackgroundMode: 'drain' },
      identity: { name: 'Example Agent', slug: 'example-agent' },
      extra_agent_dirs: ['C:\\agents'],
      disabled_builtin_profiles: ['reviewer'],
      mcp: { startupTimeoutMs: 30_000, toolTimeoutMs: 60_000 },
      tools: { enabled: ['Read'], disabled: ['Bash'] },
    });
    draft.extraAgentDirs.push(' C:\\agents ', 'D:\\agents');
    draft.disabledBuiltinProfiles = [];

    const patch = runtimeConfigPatch(draft);
    // cron is env-driven and never persisted — absent from both the patch and replace_domains.
    expect(patch.cron).toBeUndefined();
    expect(patch.workspace_instance).toEqual({ idle_ttl_ms: 120_000 });
    expect(patch.image).toEqual({ max_edge_px: 2048, read_byte_budget: 4_000_000 });
    expect(patch.task).toEqual(expect.objectContaining({ max_running_tasks: 4, keep_alive_on_exit: true, print_background_mode: 'drain' }));
    expect(patch.extra_agent_dirs).toEqual(['C:\\agents', 'D:\\agents']);
    expect(patch.disabled_builtin_profiles).toEqual([]);
    expect(patch.tools).toEqual({ enabled: ['Read'], disabled: ['Bash'] });
    expect(patch.replace_domains).toEqual(expect.arrayContaining([
      'thread_communication', 'token_counting', 'workspace_instance', 'image', 'task',
      'identity', 'extra_agent_dirs', 'disabled_builtin_profiles', 'mcp', 'tools',
    ]));
    expect(patch.replace_domains).not.toContain('cron');
  });

  it('rejects invalid runtime integers before config writes', () => {
    const draft = runtimeConfigDraftFromConfig({ providers: {} });
    draft.imageMaxEdgePx = '0';
    expect(() => runtimeConfigPatch(draft)).toThrow(/image\.max_edge_px/);
    draft.imageMaxEdgePx = '';
    draft.mcpStartupTimeoutMs = '2147483648';
    expect(() => runtimeConfigPatch(draft)).toThrow(/mcp\.startup_timeout_ms/);
  });

  it('emits only fields changed from the last server echo', () => {
    const baseline = serverFileSettingsFromConfig({
      providers: {},
      subagent: { timeoutMs: 60_000 },
      agents: { enabled: true },
      builtin_product_skills: true,
      model_catalog: { refreshIntervalMs: 0, refreshOnStart: false },
    });
    const first = structuredClone(baseline);
    first.agents.enabled = false;
    const second = structuredClone(baseline);
    second.modelCatalog.refreshOnStart = true;

    expect(serverFileSettingsPatch(first, baseline)).toEqual({
      subagent: undefined,
      agents: {
        enabled: false,
        default_subagent_model: undefined,
        default_subagent_reasoning_effort: undefined,
      },
      builtin_product_skills: undefined,
      model_catalog: undefined,
    });
    expect(serverFileSettingsPatch(second, baseline)).toEqual({
      subagent: undefined,
      agents: undefined,
      builtin_product_skills: undefined,
      model_catalog: { refresh_interval_ms: undefined, refresh_on_start: true },
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

  it('builds an editable provider draft without ever reading an existing secret', () => {
    const draft = providerDraftFromCatalog(
      {
        id: 'example',
        type: 'openai',
        base_url: 'https://api.example.test/v1',
        default_model: 'example/chat',
        request_identity: { preset: 'kimi_code' },
        has_api_key: true,
        status: 'connected',
        models: ['example/chat'],
      },
      [{
        provider: 'example',
        model: 'example/chat',
        display_name: 'Example Chat',
        max_context_size: 128000,
        capabilities: ['reasoning'],
        support_efforts: ['high'],
      }],
    );
    expect(draft?.apiKey).toBe('');
    expect(draft?.defaultModel).toBe('chat');
    expect(draft?.models[0]?.model).toBe('chat');
    expect(draft?.requestIdentityChoice).toBe('kimi_code');
  });

  it('round-trips authored request identity presets and advanced overrides', async () => {
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
      [{ provider: 'example', model: 'example/chat', max_context_size: 128000 }],
    );
    expect(draft?.requestIdentityChoice).toBe('codex_compatible');
    expect(JSON.parse(draft?.requestIdentityOverridesJson ?? '')).toEqual({
      client: { user_agent: 'codex' },
    });

    let body: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: { provider: { id: 'example', type: 'openai_responses', has_api_key: true, status: 'connected' } },
      }));
    }));
    await replaceProvider(
      { url: 'http://127.0.0.1:8080', token: 'token' },
      'example',
      draft!,
    );
    expect(body?.['request_identity']).toEqual({
      preset: 'codex_compatible',
      overrides: { client: { user_agent: 'codex' } },
    });
  });

  it('rejects malformed advanced request identity JSON without saving', () => {
    expect(
      validateProviderDraft(
        providerDraft({
          requestIdentityChoice: 'grok_build_compatible',
          requestIdentityOverridesJson: '{',
        }),
      )?.key,
    ).toBe('val.providerRequestIdentity');
  });

  it('uses the provider PUT wire and omits a blank write-once secret', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      // The client always sends a JSON string body; JSON.parse stringifies its
      // argument anyway, so dropping String() is behavior-identical here.
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(init?.method).toBe('PUT');
      expect(body['api_key']).toBeUndefined();
      expect(body['models']).toEqual([
        expect.objectContaining({ model: 'chat', max_context_size: 128000 }),
      ]);
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: {
          provider: {
            id: 'example',
            type: 'openai',
            has_api_key: true,
            status: 'connected',
            models: ['example/chat'],
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const saved = await replaceProvider(
      { url: 'http://127.0.0.1:8080', token: 'token' },
      'example',
      providerDraft(),
    );
    expect(saved.id).toBe('example');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sends an explicit empty API key only when the user chooses clear', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body['api_key']).toBe('');
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: { provider: { id: 'example', type: 'openai', has_api_key: false, status: 'unconfigured' } },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await replaceProvider(
      { url: 'http://127.0.0.1:8080', token: 'token' },
      'example',
      providerDraft({ clearApiKey: true }),
    );
  });

  it('serializes request identity presets and resets edit forms to auto with null', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: { provider: { id: 'example', type: 'openai', has_api_key: false, status: 'unconfigured' } },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const connection = { url: 'http://127.0.0.1:8080', token: 'token' };
    await replaceProvider(connection, 'example', providerDraft({ requestIdentityChoice: 'codex_compatible' }));
    await replaceProvider(connection, 'example', providerDraft({ requestIdentityChoice: 'kimi_code' }));
    await replaceProvider(connection, 'example', providerDraft());

    expect(bodies[0]?.['request_identity']).toEqual({ preset: 'codex_compatible' });
    expect(bodies[1]?.['request_identity']).toEqual({ preset: 'kimi_code' });
    expect(bodies[2]?.['request_identity']).toBeNull();
  });

  it('tracks request identity edits as dirty', () => {
    const initial = providerDraft();
    expect(isProviderDraftDirty(providerDraft({ requestIdentityChoice: 'none' }), initial)).toBe(true);
    expect(isProviderDraftDirty(providerDraft({ requestIdentityOverridesJson: '{"client":{"userAgent":"host"}}' }), initial)).toBe(true);
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
    expect(models.map((model) => model.model)).toEqual(['claude-a', 'claude-b']);
    expect(models[0]?.maxContextSize).toBe(200000);
    expect(models[0]?.capabilities).toEqual([]);
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
  const labels = { general: 'General', models: 'Models' };

  it('matches card titles, section labels, and hint keywords', () => {
    const index = buildSettingsSearchIndex(labels, t);
    expect(index.length).toBeGreaterThan(10);
    expect(searchSettings(index, 'language')[0]?.cardId).toBe('st-card-language');
    expect(searchSettings(index, 'Models').some((hit) => hit.section === 'models')).toBe(true);
    expect(searchSettings(index, 'experimental feature').some((hit) => hit.cardId === 'st-card-experimental')).toBe(true);
    expect(searchSettings(index, 'hard allowlist').some((hit) => hit.cardId === 'st-card-subagents')).toBe(true);
    expect(searchSettings(index, 'pinned model alias').some((hit) => hit.cardId === 'st-card-subagent-profiles')).toBe(true);
    expect(searchSettings(index, 'Main agents').some((hit) => hit.cardId === 'st-card-main-agents')).toBe(true);
    expect(searchSettings(index, 'subagent')[0]?.section).toBe('agents');
    expect(searchSettings(index, '  ')).toEqual([]);
    expect(searchSettings(index, 'zzzz-no-such-setting')).toEqual([]);
  });
});

describe('capabilities section grouping', () => {
  it('covers every capabilities search card exactly once, in a known group', () => {
    const capabilitiesCards = SETTINGS_SEARCH_SPEC
      .filter((entry) => entry.section === 'capabilities')
      .map((entry) => entry.cardId);
    const grouped = CAPABILITY_GROUPS.flatMap((group) => group.cardIds);
    expect([...grouped].toSorted()).toEqual([...capabilitiesCards].toSorted());
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(new Set(CAPABILITY_GROUPS.map((group) => group.id)).size).toBe(CAPABILITY_GROUPS.length);
  });

  it('keeps everyday groups open by default and folds the advanced tail', () => {
    expect(capabilityGroupForCard('st-card-caps')?.defaultOpen).toBe(true);
    expect(capabilityGroupForCard('st-card-mcp')?.defaultOpen).toBe(true);
    expect(capabilityGroupForCard('st-card-advanced')?.defaultOpen).toBe(false);
    expect(capabilityGroupForCard('st-card-experimental')?.defaultOpen).toBe(false);
    expect(capabilityGroupForCard('st-card-runtime')?.id).toBe('runtime');
    expect(capabilityGroupForCard('st-card-tools')?.id).toBe('runtime');
    expect(capabilityGroupForCard('st-card-about')).toBeUndefined();
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
      scope: 'project',
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
      scope: 'user',
      transport: 'stdio',
      command: 'node',
      args: '',
      env: 'TOKEN',
      url: '',
    })).toThrow('st.mcp.envInvalid');
  });
});
