import { readdirSync, readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendExtraSkillDirs,
  AI_SETTINGS_TABS,
  aiTabForCard,
  buildSettingsSearchIndex,
  clearRestartRequirement,
  createProvider,
  fetchRemoteModels,
  humanizeMs,
  acknowledgeRestartRequirement,
  isProviderDraftDirty,
  isRestartRequirementAcknowledged,
  markRestartRequired,
  mcpTimeoutsPatch,
  msUnitFor,
  normalizeTags,
  parseAdvancedServerConfig,
  parseExperimentalFlags,
  parseHooksJson,
  parseRemoteModels,
  providerDraftFromCatalog,
  providerTemplateFor,
  isComposerSendKey,
  readDesktopPrefs,
  readRestartRequirement,
  readSettings,
  requestIdentityLayerDraftFromPolicy,
  requestIdentityPolicyFromDraft,
  remoteModelsHeaders,
  remoteModelsUrl,
  replaceProvider,
  resolveEffectiveModel,
  resolveModelSource,
  resolveSessionModelOverride,
  resolveSettingsRoute,
  restartRequirementSnapshot,
  runtimeConfigDraftFromConfig,
  runtimeConfigPatch,
  searchSettings,
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
  toolPolicyDraftFromConfig,
  toolPolicyPatch,
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
  requestIdentityChoice: 'inherit',
  requestIdentityOverridesJson: '',
  models: [
    {
      model: 'chat',
      maxContextSize: 128000,
      displayName: 'Example Chat',
      capabilities: ['reasoning'],
      supportEfforts: ['low', 'high'],
      requestIdentityChoice: 'inherit',
      requestIdentityOverridesJson: '',
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
      updateChannel: 'stable',
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
      modelCatalogRefreshIntervalMs: 0,
    })).toBeNull();
    expect(validateDesktopConfigDraft({
      subagentTimeoutMs: 86_400_001,
      modelCatalogRefreshIntervalMs: 0,
    })?.key).toBe('val.timeoutMax');
    expect(validateProviderDraft(providerDraft({ baseUrl: 'file:///secret' }))?.key).toBe('val.baseUrlHttp');
    expect(validateProviderDraft(providerDraft({ apiKey: 'bad\nkey' }))?.key).toBe('val.apiKeyLineBreaks');
    expect(() => parseExperimentalFlags('{"flag":"yes"}')).toThrow('true or false');
    expect(parseExperimentalFlags('{"search_worker":true}')).toEqual({ search_worker: true });
    expect(() => parseAdvancedServerConfig('{"hooks":{}}')).toThrow('Unsupported');
    expect(() => parseAdvancedServerConfig('{"unknown":true}')).toThrow('Unsupported');
    // Hooks left the advanced editor in the batch-3 split: they only enter
    // through the Automation leaf's parseHooksJson, so a pasted hooks key is
    // rejected as an unsupported field like any other unknown domain.
    expect(() => parseAdvancedServerConfig('{"hooks":[],"background":{"max":2}}')).toThrow('Unsupported');
    expect(parseAdvancedServerConfig('{"background":{"max":2}}')).toEqual({
      permission: undefined,
      services: undefined,
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
      model_catalog: { refreshIntervalMs: 300_000, refreshOnStart: true },
    });

    expect(serverFileSettingsPatch(settings)).toEqual({
      subagent: { timeout_ms: 60_000 },
      agents: { enabled: false },
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
    // mcp and tools belong to other leaves — the runtime patch neither sends
    // nor replaces them, so a stale runtime draft can never roll them back.
    expect(patch.mcp).toBeUndefined();
    expect(patch.tools).toBeUndefined();
    expect(patch.replace_domains).toEqual(expect.arrayContaining([
      'thread_communication', 'token_counting', 'workspace_instance', 'image', 'task',
      'identity', 'extra_agent_dirs', 'disabled_builtin_profiles',
    ]));
    expect(patch.replace_domains).not.toContain('cron');
    expect(patch.replace_domains).not.toContain('mcp');
    expect(patch.replace_domains).not.toContain('tools');
  });

  it('projects malformed config roots and lists to safe canonical defaults', () => {
    expect(runtimeConfigDraftFromConfig(null)).toMatchObject({
      extraAgentDirs: [],
      disabledBuiltinProfiles: [],
    });
    expect(toolPolicyDraftFromConfig(null)).toEqual({ toolsEnabled: [], toolsDisabled: [] });
    expect(serverFileSettingsFromConfig('not-a-config')).toMatchObject({
      subagent: { timeoutMs: 7_200_000 },
      agents: { enabled: true },
    });

    expect(() => runtimeConfigDraftFromConfig({
      extra_agent_dirs: { path: 'C:/agents' },
      disabled_builtin_profiles: 42,
      tools: { enabled: 'Read', disabled: { Bash: true } },
    })).not.toThrow();
    const draft = runtimeConfigDraftFromConfig({
      extra_agent_dirs: { path: 'C:/agents' },
      disabled_builtin_profiles: 'reviewer',
      tools: { enabled: 'Read', disabled: { Bash: true } },
    });
    expect(draft.extraAgentDirs).toEqual([]);
    expect(draft.disabledBuiltinProfiles).toEqual(['reviewer']);
    const policy = toolPolicyDraftFromConfig({ tools: { enabled: 'Read', disabled: { Bash: true } } });
    expect(policy.toolsEnabled).toEqual(['Read']);
    expect(policy.toolsDisabled).toEqual([]);
  });

  it('rejects invalid runtime integers before config writes', () => {
    const draft = runtimeConfigDraftFromConfig({ providers: {} });
    draft.imageMaxEdgePx = '0';
    expect(() => runtimeConfigPatch(draft)).toThrow(/image\.max_edge_px/);
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
      model_catalog: { refreshIntervalMs: 0, refreshOnStart: false },
    });
    const first = structuredClone(baseline);
    first.agents.enabled = false;
    const second = structuredClone(baseline);
    second.modelCatalog.refreshOnStart = true;

    expect(serverFileSettingsPatch(first, baseline)).toEqual({
      subagent: undefined,
      agents: { enabled: false },
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
        request_identity: { overrides: { client: { user_agent: 'host' } } },
      }],
    );
    expect(draft?.apiKey).toBe('');
    expect(draft?.defaultModel).toBe('chat');
    expect(draft?.models[0]?.model).toBe('chat');
    expect(draft?.requestIdentityChoice).toBe('kimi_code');
    expect(draft?.models[0]?.requestIdentityChoice).toBe('custom_overrides');
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
      [{
        provider: 'example',
        model: 'example/chat',
        max_context_size: 128000,
        request_identity: { overrides: { request: { logical_id: 'turn' } } },
      }],
    );
    expect(draft?.requestIdentityChoice).toBe('codex_compatible');
    expect(draft?.models[0]?.requestIdentityChoice).toBe('custom_overrides');
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
    expect(body?.['models']).toEqual([
      expect.objectContaining({
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

  it('uses the provider PUT wire and omits a blank write-once secret', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      // The client always sends a JSON string body; JSON.parse stringifies its
      // argument anyway, so dropping String() is behavior-identical here.
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(init?.method).toBe('PUT');
      expect(body['api_key']).toBeUndefined();
      expect(body['models']).toEqual([
        expect.objectContaining({
          model: 'chat',
          max_context_size: 128000,
          request_identity: null,
        }),
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

  it('managed-style save: id/type unchanged, secret untouched, non-credential fields on the wire', async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: { provider: { id: 'example', type: 'openai', has_api_key: true, status: 'connected' } },
      }));
    }));
    // The managed editor locks id/protocol and hides the credential surface,
    // so the draft it saves always has the unchanged id and a blank key.
    await replaceProvider(
      { url: 'http://127.0.0.1:8080', token: 'token' },
      'example',
      providerDraft({
        id: 'example',
        baseUrl: 'https://api.example.test/v2',
        requestIdentityChoice: 'none',
      }),
    );
    expect(body?.['new_id']).toBeUndefined();
    expect(body?.['api_key']).toBeUndefined();
    expect(body?.['type']).toBe('openai');
    expect(body?.['base_url']).toBe('https://api.example.test/v2');
    expect(body?.['request_identity']).toEqual({ preset: 'none' });
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

  it('serializes provider and model authored layers without inventing presets', async () => {
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
    const custom = providerDraft({
      requestIdentityChoice: 'custom_overrides',
      requestIdentityOverridesJson: '{"client":{"user_agent":"host"}}',
    });
    custom.models[0] = {
      ...custom.models[0]!,
      requestIdentityChoice: 'none',
      requestIdentityOverridesJson: '{"request":{"logical_id":"turn"}}',
    };
    await replaceProvider(connection, 'example', custom);
    await replaceProvider(connection, 'example', providerDraft());

    expect(bodies[0]?.['request_identity']).toEqual({
      overrides: { client: { user_agent: 'host' } },
    });
    expect(bodies[0]?.['models']).toEqual([
      expect.objectContaining({
        request_identity: {
          preset: 'none',
          overrides: { request: { logical_id: 'turn' } },
        },
      }),
    ]);
    expect(bodies[1]?.['request_identity']).toBeNull();
    expect(bodies[1]?.['models']).toEqual([
      expect.objectContaining({ request_identity: null }),
    ]);
  });

  it('omits inherited provider and model layers when creating', async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: { id: 'example', type: 'openai', has_api_key: false, status: 'unconfigured' },
      }));
    }));
    await createProvider(
      { url: 'http://127.0.0.1:8080', token: 'token' },
      providerDraft(),
    );
    expect(body?.['request_identity']).toBeUndefined();
    expect(body?.['models']).toEqual([
      expect.not.objectContaining({ request_identity: expect.anything() }),
    ]);
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
  const labels = { general: 'General', ai: 'Models & providers' };

  it('matches card titles, section labels, and hint keywords', () => {
    const index = buildSettingsSearchIndex(labels, t);
    expect(index.length).toBeGreaterThan(10);
    expect(searchSettings(index, 'language')[0]?.cardId).toBe('st-card-language');
    expect(searchSettings(index, 'Models').some((hit) => hit.section === 'ai')).toBe(true);
    expect(searchSettings(index, 'experimental feature').some((hit) => hit.cardId === 'st-card-experimental')).toBe(true);
    expect(searchSettings(index, 'denied subagent models').some((hit) => hit.cardId === 'st-card-subagents')).toBe(true);
    expect(searchSettings(index, 'pinned model alias').some((hit) => hit.cardId === 'st-card-subagent-profiles')).toBe(true);
    expect(searchSettings(index, 'Main agents').some((hit) => hit.cardId === 'st-card-main-agents')).toBe(true);
    expect(searchSettings(index, 'Import model configuration').some((hit) => hit.cardId === 'st-card-compatibility-home')).toBe(true);
    expect(searchSettings(index, 'subagent')[0]?.section).toBe('subagents');
    expect(searchSettings(index, '  ')).toEqual([]);
    expect(searchSettings(index, 'zzzz-no-such-setting')).toEqual([]);
  });

  // Search is the shortest path to a setting (Ctrl+, and the quick switcher
  // both run this index), so an unindexed card is unreachable by name. The
  // rendered components are the oracle: read the ids they actually mount,
  // including the editors SettingsPage delegates whole sections to. Section
  // components live under components/settings/, so the scan recurses.
  it('indexes every card the settings page renders', () => {
    const dir = new URL('../components/', import.meta.url);
    const rendered = new Set(
      readdirSync(dir, { recursive: true })
        .map((name) => String(name).replaceAll('\\', '/'))
        .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
        .flatMap((name) => [
          ...readFileSync(new URL(name, dir), 'utf8')
            .matchAll(/id="(st-card-[a-z0-9-]+)"/g),
        ])
        .map((match) => match[1]!),
    );
    expect(rendered.size).toBeGreaterThan(10);
    const indexed = new Set(SETTINGS_SEARCH_SPEC.map((entry) => entry.cardId));
    expect([...rendered].filter((id) => !indexed.has(id))).toEqual([]);
    expect([...indexed].filter((id) => !rendered.has(id))).toEqual([]);
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
    // Batch 3 split: the capabilities leaf dissolved into skills / mcp /
    // automation under extensions; runtime moved to system; the advanced
    // tails fill "Data & advanced".
    expect(settingsGroupForSection('skills')?.id).toBe('extensions');
    expect(settingsGroupForSection('mcp')?.id).toBe('extensions');
    expect(settingsGroupForSection('plugins')?.id).toBe('extensions');
    expect(settingsGroupForSection('automation')?.id).toBe('extensions');
    expect(settingsGroupForSection('subagents')?.id).toBe('agents');
    expect(settingsGroupForSection('runtime')?.id).toBe('system');
    expect(settingsGroupForSection('experimental')?.id).toBe('advanced');
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
    expect(SETTINGS_SECTION_META['runtime']?.scopes).toEqual(['server']);
    expect(SETTINGS_SECTION_META['automation']?.scopes).toEqual(['server']);
    expect(SETTINGS_SECTION_META['experimental']?.scopes).toEqual(['server']);
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

  it('points the catalog-refresh hit at the models tab so the card is mounted on arrival', () => {
    const index = buildSettingsSearchIndex({}, t);
    const hit = searchSettings(index, 'Catalog refresh interval')
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

  it('flags genuinely unknown sections instead of silently falling back to general', () => {
    expect(resolveSettingsRoute('nonsense', '')).toEqual({ status: 'unknown', section: 'nonsense', cardId: undefined });
    expect(resolveSettingsRoute('nonsense', '#st-card-not-real')).toEqual({ status: 'unknown', section: 'nonsense', cardId: 'st-card-not-real' });
    expect(resolveSettingsRoute('nonsense', '#other-anchor')).toEqual({ status: 'unknown', section: 'nonsense', cardId: undefined });
  });

  it('knows the canonical owner of every indexed card', () => {
    expect(settingsSectionForCard('st-card-mcp')).toBe('mcp');
    expect(settingsSectionForCard('st-card-language')).toBe('general');
    // Dissolved cards leave the spec to their LEGACY_CARD_ALIASES entry.
    expect(settingsSectionForCard('st-card-sidecar')).toBeUndefined();
    expect(settingsSectionForCard('st-card-nowhere')).toBeUndefined();
  });
});

describe('hooks and MCP timeout patches (batch 3 split)', () => {
  it('parses the hooks editor draft as a JSON array only', () => {
    expect(parseHooksJson('[]')).toEqual([]);
    expect(parseHooksJson('[{"event":"PreToolUse"}]')).toEqual([{ event: 'PreToolUse' }]);
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
    const runtimePatch = runtimeConfigPatch(runtimeConfigDraftFromConfig({ providers: {} }));
    const toolsPatch = toolPolicyPatch({ toolsEnabled: [], toolsDisabled: [] });
    const mcpPatch = mcpTimeoutsPatch('60000', '');
    expect(Object.keys(runtimePatch)).not.toEqual(expect.arrayContaining(['mcp', 'tools']));
    expect(Object.keys(toolsPatch).toSorted()).toEqual(['replace_domains', 'tools']);
    expect(Object.keys(mcpPatch).toSorted()).toEqual(['mcp', 'replace_domains']);
    expect(runtimePatch.replace_domains).not.toEqual(expect.arrayContaining(['mcp', 'tools']));
  });

  it('two leaves saving from divergent echoes never roll each other back', () => {
    // The runtime leaf holds echo A (stale tools policy), the automation leaf
    // holds echo B (stale runtime values). Because each save only replaces its
    // own domains, applying both patches in sequence keeps every leaf's newest
    // values no matter how stale the other leaf's draft was.
    const runtimeSave = runtimeConfigPatch(runtimeConfigDraftFromConfig({
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
    const afterRuntime = apply(server, runtimeSave as never);
    expect(afterRuntime['tools']).toBe('policy-from-B');
    expect(afterRuntime['mcp']).toBe('mcp-from-C');
    const afterBoth = apply(afterRuntime, toolsSave as never);
    expect(afterBoth['tools']).toEqual({ enabled: ['Bash'], disabled: ['Read'] });
    expect(afterBoth['workspace_instance']).toEqual(runtimeSave.workspace_instance);
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
