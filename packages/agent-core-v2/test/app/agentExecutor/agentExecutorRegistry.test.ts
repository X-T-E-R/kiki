import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  IAgentExecutorRegistry,
  registerAgentExecutorProvider,
} from '#/app/agentExecutor/agentExecutor';
import {
  AgentExecutorRegistryService,
  descriptorRevisionFromConfig,
} from '#/app/agentExecutor/agentExecutorRegistryService';
import { compareExecutorBinaryCandidates } from '#/app/agentExecutor/binaryDiscovery';
import { BUILTIN_AGENT_EXECUTORS } from '#/app/agentExecutor/builtinDescriptorData';
import { resolvePromptDelivery } from '#/app/agentExecutor/capabilities';
import {
  AGENT_EXECUTORS_SECTION,
  AgentExecutorsConfigSchema,
  agentExecutorsFromToml,
  agentExecutorsToToml,
} from '#/app/agentExecutor/configSection';
import {
  AGENT_EXECUTOR_OVERRIDES_SECTION,
  AgentExecutorOverrideSchema,
  AgentExecutorOverridesSchema,
  agentExecutorOverridesFromToml,
  agentExecutorOverridesToToml,
  executorProcessEnv,
} from '#/app/agentExecutor/executorOverrides';
import type { IDisposable } from '#/_base/di/lifecycle';

const processService = { _serviceBrand: undefined } as unknown as IHostProcessService;
const fs = { _serviceBrand: undefined } as unknown as IHostFileSystem;
const bootstrap = { _serviceBrand: undefined } as unknown as IBootstrapService;

function configWith(value: unknown): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: Event.None as IConfigService['onDidChangeConfiguration'],
    onDidSectionChange: Event.None as IConfigService['onDidSectionChange'],
    onDidChangeDiagnostics: Event.None as IConfigService['onDidChangeDiagnostics'],
    get: <T>(domain: string) => domain === AGENT_EXECUTORS_SECTION ? value as T : undefined as T,
    inspect: () => ({
      value: undefined,
      defaultValue: undefined,
      userValue: undefined,
      memoryValue: undefined,
    }),
    getAll: () => ({}),
    origins: () => ({}),
    removeOverride: async () => {},
    set: async () => {},
    replace: async () => {},
    replaceSections: async () => {},
    reload: async () => {},
    applyModelGenerationMigration: async () => { throw new Error('Migration is not available in configWith'); },
    restoreModelGenerationMigration: async () => { throw new Error('Migration is not available in configWith'); },
    diagnostics: () => [],
  };
}

describe('AgentExecutorRegistryService', () => {
  let services: TestInstantiationService;
  let provider: IDisposable | undefined;

  beforeEach(() => {
    services = new TestInstantiationService();
    services.set(IHostProcessService, processService);
    services.set(IHostFileSystem, fs);
    services.set(IBootstrapService, bootstrap);
    services.set(IAtomicTomlDocumentStore, { _serviceBrand: undefined,
      get: async () => undefined } as unknown as IAtomicTomlDocumentStore);
  });

  afterEach(async () => {
    await provider?.dispose();
    provider = undefined;
    await services.dispose();
  });

  it('normalizes the native executor when no descriptor is configured', () => {
    services.set(IConfigService, configWith({}));
    services.set(
      IAgentExecutorRegistry,
      new SyncDescriptor(AgentExecutorRegistryService),
    );

    expect(services.get(IAgentExecutorRegistry).resolve()).toMatchObject({
      descriptor: { id: 'native', protocol: 'native', revision: 'native' },
      options: {},
    });
  });

  it('admits the six verified ACP command descriptors and excludes unsafe install families', () => {
    expect(AgentExecutorsConfigSchema.safeParse(BUILTIN_AGENT_EXECUTORS).success).toBe(true);
    expect(['openclaw-acp', 'cline-acp', 'codebuddy-acp', 'pi-acp', 'deepseek-acp', 'qoder-acp']
      .every((id) => BUILTIN_AGENT_EXECUTORS[id]?.protocol === 'acp-v1')).toBe(true);
    expect(BUILTIN_AGENT_EXECUTORS['openclaw-acp']?.supportsMcp).toBe(false);
    expect(BUILTIN_AGENT_EXECUTORS['pi-acp']?.supportsMcp).toBe(false);
    expect(BUILTIN_AGENT_EXECUTORS['qoder-acp']?.command).toBe('qodercli');
    expect(BUILTIN_AGENT_EXECUTORS['hermes-acp']).toBeUndefined();
    expect(BUILTIN_AGENT_EXECUTORS['antigravity-acp']).toMatchObject({
      protocol: 'acp-v1', homeEnv: 'GEMINI_HOME', args: process.platform === 'linux' ? ['--uid='] : [],
      sources: expect.arrayContaining([{ id: 'env', kind: 'env', name: 'ANTIGRAVITY_ACP_PATH' }]),
    });
    expect(BUILTIN_AGENT_EXECUTORS['antigravity-acp']?.sources).not.toContainEqual(expect.objectContaining({ command: 'antigravity' }));
  });

  it('rejects unknown executor ids instead of falling back to native', () => {
    services.set(IConfigService, configWith({}));
    services.set(
      IAgentExecutorRegistry,
      new SyncDescriptor(AgentExecutorRegistryService),
    );

    expect(() => services.get(IAgentExecutorRegistry).resolve('typo')).toThrow(
      /Unknown agent executor "typo"/,
    );
  });

  it('derives a stable one-way revision without exposing descriptor environment values', () => {
    const secret = 'sentinel-super-secret-token';
    const first = new AgentExecutorRegistryService(configWith({
      secure: {
        protocol: 'acp-v1',
        command: 'secure-agent',
        args: ['stdio'],
        env: { TOKEN: secret, REGION: 'test' },
      },
    }), processService, fs, bootstrap).get('secure')!;
    const reordered = new AgentExecutorRegistryService(configWith({
      secure: {
        protocol: 'acp-v1',
        command: 'secure-agent',
        args: ['stdio'],
        env: { REGION: 'test', TOKEN: secret },
      },
    }), processService, fs, bootstrap).get('secure')!;

    expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(first.revision).toBe(reordered.revision);
    expect(JSON.stringify({ revision: first.revision })).not.toContain(secret);
  });

  it('exposes negotiated capabilities only for the matching executor revision and binary version', () => {
    let command = 'test-acp';
    const config = { ...configWith({}), get: <T>(domain: string) => domain === AGENT_EXECUTORS_SECTION ? ({ test: {
      protocol: 'acp-v1', command, args: [],
    } }) as T : undefined as T };
    const registry = new AgentExecutorRegistryService(config, processService, fs, bootstrap);
    registry.recordNegotiated('test', '1.0', { models: ['one'], resume: true });
    expect(registry.negotiated('test', '1.0')).toEqual({ models: ['one'], resume: true });
    expect(registry.negotiated('test', '2.0')).toBeUndefined();
    expect(registry.lastNegotiated('test')).toEqual({ models: ['one'], resume: true });
    command = 'replacement-acp';
    expect(registry.negotiated('test', '1.0')).toBeUndefined();
    expect(registry.lastNegotiated('test')).toBeUndefined();
  });

  it('treats a declared revision as a salt instead of replacing the descriptor digest', () => {
    const descriptor = (args: readonly string[]) => new AgentExecutorRegistryService(configWith({
      secure: {
        protocol: 'acp-v1',
        command: 'secure-agent',
        args,
        env: { REGION: 'test' },
        revision: 'r1',
      },
    }), processService, fs, bootstrap).get('secure')!;

    expect(descriptor(['stdio']).revision).not.toBe(descriptor(['serve']).revision);
  });

  it('delegates closed option validation to the protocol provider', () => {
    provider = registerAgentExecutorProvider({
      id: 'fake-acp',
      protocol: 'acp-v1',
      validateOptions: (value) => {
        const options = value as Readonly<Record<string, unknown>>;
        for (const key of Object.keys(options)) {
          if (key !== 'mode') throw new Error(`Unknown executor option "${key}"`);
        }
        return options as Readonly<Record<string, string | number | boolean>>;
      },
      validateBinding: (binding) => ({ ok: true, binding }),
      create: () => {
        throw new Error('not used');
      },
    });
    services.set(IConfigService, configWith({
      'fake-acp': {
        protocol: 'acp-v1',
        command: 'fake',
        args: [],
      },
    }));
    services.set(
      IAgentExecutorRegistry,
      new SyncDescriptor(AgentExecutorRegistryService),
    );
    const registry = services.get(IAgentExecutorRegistry);

    expect(registry.resolve('fake-acp', { mode: 'default' }).options).toEqual({
      mode: 'default',
    });
    expect(() => registry.resolve('fake-acp', { typo: true })).toThrow(
      /Unknown executor option "typo"/,
    );
  });

  it('returns a diagnostic when the executor protocol has no provider', () => {
    services.set(IConfigService, configWith({
      missing: {
        protocol: 'missing-v1',
        command: 'missing',
        args: [],
      },
    }));
    services.set(
      IAgentExecutorRegistry,
      new SyncDescriptor(AgentExecutorRegistryService),
    );

    expect(services.get(IAgentExecutorRegistry).validateBinding(
      'missing',
      {},
      { modelAlias: 'external-model', thinkingEffort: 'xhigh' },
    )).toEqual({
      ok: false,
      diagnostic:
        'External executor "missing" is unsupported because protocol "missing-v1" has no registered provider',
    });
  });

  it('rejects an empty provider binding result', () => {
    provider = registerAgentExecutorProvider({
      id: 'empty-provider',
      protocol: 'empty-v1',
      validateOptions: () => ({}),
      validateBinding: () => ({ ok: true, binding: {} }),
      create: () => {
        throw new Error('not used');
      },
    });
    services.set(IConfigService, configWith({
      empty: { protocol: 'empty-v1', command: 'empty', args: [] },
    }));
    services.set(
      IAgentExecutorRegistry,
      new SyncDescriptor(AgentExecutorRegistryService),
    );

    expect(services.get(IAgentExecutorRegistry).validateBinding(
      'empty',
      {},
      { modelAlias: 'external-model', thinkingEffort: 'xhigh' },
    )).toEqual({
      ok: false,
      diagnostic: 'External executor "empty" returned an empty modelAlias binding',
    });
  });

  it('preserves a provider diagnostic', () => {
    provider = registerAgentExecutorProvider({
      id: 'diagnostic-provider',
      protocol: 'diagnostic-v1',
      validateOptions: () => ({}),
      validateBinding: () => ({ ok: false, diagnostic: 'xhigh is unsupported' }),
      create: () => {
        throw new Error('not used');
      },
    });
    services.set(IConfigService, configWith({
      diagnostic: { protocol: 'diagnostic-v1', command: 'diagnostic', args: [] },
    }));
    services.set(
      IAgentExecutorRegistry,
      new SyncDescriptor(AgentExecutorRegistryService),
    );

    expect(services.get(IAgentExecutorRegistry).validateBinding(
      'diagnostic',
      {},
      { modelAlias: 'external-model', thinkingEffort: 'xhigh' },
    )).toEqual({ ok: false, diagnostic: 'xhigh is unsupported' });
  });

  it('accepts an explicit provider identity binding', () => {
    provider = registerAgentExecutorProvider({
      id: 'identity-provider',
      protocol: 'identity-v1',
      validateOptions: () => ({}),
      validateBinding: (binding) => ({ ok: true, binding }),
      create: () => {
        throw new Error('not used');
      },
    });
    services.set(IConfigService, configWith({
      identity: { protocol: 'identity-v1', command: 'identity', args: [] },
    }));
    services.set(
      IAgentExecutorRegistry,
      new SyncDescriptor(AgentExecutorRegistryService),
    );
    const binding = { modelAlias: 'external-model', thinkingEffort: 'xhigh' };

    expect(services.get(IAgentExecutorRegistry).validateBinding(
      'identity',
      {},
      binding,
    )).toMatchObject({ ok: true, binding,
      fields: { tools: { state: 'ignored' }, model_alias: { state: 'mapped' } }, advisories: [] });
    expect(services.get(IAgentExecutorRegistry).validateBinding(
      'identity', {}, { ...binding, explicitFields: ['tools', 'auto_compact'] },
    )).toMatchObject({ ok: true, advisories: [
      { code: 'executor_field_ignored', field: 'tools' },
      { code: 'executor_field_ignored', field: 'auto_compact' },
    ] });
  });

  it('uses only provider-declared external binding normalization', () => {
    provider = registerAgentExecutorProvider({
      id: 'fake-acp',
      protocol: 'acp-v1',
      validateOptions: () => ({}),
      validateBinding: (binding) => ({
        ok: true,
        binding: {
          modelAlias: `${binding.modelAlias}-canonical`,
          thinkingEffort: binding.thinkingEffort,
        },
      }),
      create: () => {
        throw new Error('not used');
      },
    });
    services.set(IConfigService, configWith({
      'fake-acp': {
        protocol: 'acp-v1',
        command: 'fake',
        args: [],
      },
    }));
    services.set(
      IAgentExecutorRegistry,
      new SyncDescriptor(AgentExecutorRegistryService),
    );

    expect(services.get(IAgentExecutorRegistry).validateBinding(
      'fake-acp',
      {},
      { modelAlias: 'external-model', thinkingEffort: 'xhigh' },
    )).toMatchObject({
      ok: true,
      binding: {
        modelAlias: 'external-model-canonical',
        thinkingEffort: 'xhigh',
      },
      fields: { model_alias: { state: 'mapped' } },
      advisories: [],
    });
  });

  it('parses trusted snake-case descriptors and rejects unknown descriptor keys', () => {
    const parsed = AgentExecutorsConfigSchema.parse(
      agentExecutorsFromToml({
        cursor: {
          protocol: 'acp-v1',
          command: 'cursor-agent',
          args: ['acp'],
          env: { CURSOR_CONFIG_DIR: 'C:/cursor' },
          startup_timeout_ms: 70_000,
          model_binding: 'argv',
          model_args: ['--model', '{model}'],
          permission_mode_mapping: {
            config_id: 'auto_approve',
            manual: false,
            auto: false,
            yolo: true,
          },
          revision: 'r1',
        },
      }),
    );

    expect(parsed['cursor']).toMatchObject({
      protocol: 'acp-v1',
      command: 'cursor-agent',
      args: ['acp'],
      env: { CURSOR_CONFIG_DIR: 'C:/cursor' },
      startupTimeoutMs: 70_000,
      modelBinding: 'argv',
      modelArgs: ['--model', '{model}'],
      permissionModeMapping: {
        configId: 'auto_approve',
        manual: false,
        auto: false,
        yolo: true,
      },
      revision: 'r1',
    });
    expect(() => AgentExecutorsConfigSchema.parse({
      cursor: {
        protocol: 'acp-v1',
        command: 'cursor-agent',
        args: [],
        shell: true,
      },
    })).toThrow();
  });

  it('round-trips nested permission settings and diagnostic declarations', () => {
    const parsed = AgentExecutorsConfigSchema.parse(agentExecutorsFromToml({
      custom: { protocol: 'acp-v1', command: 'custom-agent',
        permission: { via: 'config_option', config_id: 'mode', manual: 'ask', auto: 'auto', yolo: 'all',
          trust_engine_settings: true },
        diagnostics: [{ kind: 'message', severity: 'info', message: 'Check config' }],
      },
    }));
    expect(parsed['custom']?.permission).toMatchObject({ configId: 'mode', trustEngineSettings: true });
    expect(agentExecutorsToToml(parsed)).toMatchObject({ custom: {
      permission: { config_id: 'mode', trust_engine_settings: true },
      diagnostics: [{ kind: 'message', severity: 'info', message: 'Check config' }],
    } });
  });

  it('validates and round-trips agent executor launch overrides', () => {
    const toml = {
      'codex-acp': {
        bin_path: 'C:/tools/codex.exe',
        home_dir: 'C:/codex-home',
        env: { CODEX_TOKEN: 'fixture-token' },
        args: ['--profile', 'fixture'],
        defaults: { model_alias: 'vendor-model', thinking_effort: 'high', permission_mode: 'auto', kiki_context: [], allow_kiki_subagents: false },
      },
    };
    const runtime = AgentExecutorOverridesSchema.parse(agentExecutorOverridesFromToml(toml));

    expect(runtime).toEqual({
      'codex-acp': {
        binPath: 'C:/tools/codex.exe',
        homeDir: 'C:/codex-home',
        env: { CODEX_TOKEN: 'fixture-token' },
        args: ['--profile', 'fixture'],
        defaults: { model_alias: 'vendor-model', thinking_effort: 'high', permission_mode: 'auto', kiki_context: [], allow_kiki_subagents: false },
      },
    });
    expect(agentExecutorOverridesToToml(runtime)).toEqual(toml);
    expect(AgentExecutorOverrideSchema.safeParse({ binPath: 'x', unsupported: true }).success).toBe(false);
    expect(AgentExecutorOverridesSchema.safeParse({ 'codex-acp': { env: { TOKEN: 1 } } }).success).toBe(false);
  });

  it('removes null harness defaults while preserving explicit empty and false settings', async () => {
    const { ConfigRegistry } = await import('#/app/config/configService');
    const registry = new ConfigRegistry();
    try {
      const base = { 'example-acp': { binPath: 'fixture', defaults: { model_alias: 'old-model', thinking_effort: 'high',
        kiki_context: ['memory'], allow_kiki_subagents: true } } };
      const merged = registry.validate(AGENT_EXECUTOR_OVERRIDES_SECTION, registry.merge(AGENT_EXECUTOR_OVERRIDES_SECTION, base,
        { 'example-acp': { defaults: { model_alias: null, thinking_effort: null, kiki_context: [], allow_kiki_subagents: false } } }));
      expect(merged).toEqual({ 'example-acp': { binPath: 'fixture', defaults: { kiki_context: [], allow_kiki_subagents: false } } });
      expect(registry.validate(AGENT_EXECUTOR_OVERRIDES_SECTION, registry.merge(AGENT_EXECUTOR_OVERRIDES_SECTION, merged,
        { 'example-acp': { defaults: null } }))).toEqual({ 'example-acp': { binPath: 'fixture' } });
    } finally { await registry.dispose(); }
  });

  it('maps an override home and environment into the executor process environment', () => {
    const config = {
      ...configWith({
        custom: {
          protocol: 'acp-v1',
          command: 'custom-agent',
          args: [],
          env: { BASE: 'base' },
          home_env: 'CUSTOM_HOME',
        },
      }),
      get: <T>(domain: string) => domain === AGENT_EXECUTORS_SECTION
        ? ({ custom: {
          protocol: 'acp-v1', command: 'custom-agent', args: [],
          env: { BASE: 'base' }, homeEnv: 'CUSTOM_HOME',
        } }) as T
        : domain === AGENT_EXECUTOR_OVERRIDES_SECTION
          ? ({ custom: {
            homeDir: 'C:/custom-home', env: { BASE: 'override', TOKEN: 'fixture-token' },
          } }) as T
          : undefined as T,
    };
    const descriptor = new AgentExecutorRegistryService(config, processService, fs, bootstrap).get('custom')!;

    expect(executorProcessEnv(descriptor)).toEqual({
      CUSTOM_HOME: 'C:/custom-home',
      BASE: 'override',
      TOKEN: 'fixture-token',
    });
  });

  it('accepts the Claude credential descriptor and round-trips its TOML keys', () => {
    const parsed = AgentExecutorsConfigSchema.parse(agentExecutorsFromToml({
      claude: { protocol: 'acp-v1', command: 'claude-agent-acp',
        auth: { kind: 'claude-credentials', command: 'claude', args: ['auth', 'status', '--json'] },
        login_command: ['claude', 'auth', 'login'],
        api_key_env: 'ANTHROPIC_API_KEY',
      },
    }));

    expect(parsed['claude']).toMatchObject({
      auth: { kind: 'claude-credentials', command: 'claude', args: ['auth', 'status', '--json'] },
      loginCommand: ['claude', 'auth', 'login'],
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    });
    expect(agentExecutorsToToml(parsed)).toMatchObject({ claude: {
      login_command: ['claude', 'auth', 'login'],
      api_key_env: 'ANTHROPIC_API_KEY',
    } });
    expect(() => AgentExecutorsConfigSchema.parse(agentExecutorsFromToml({
      claude: { protocol: 'acp-v1', command: 'claude-agent-acp',
        auth: { kind: 'claude-credentials', command: 'claude' } },
    }))).toThrow();
  });

  it('gates the system prompt override per descriptor without invalidating resumable sessions', () => {
    const parsed = AgentExecutorsConfigSchema.parse(agentExecutorsFromToml({
      optedIn: {
        protocol: 'acp-v1',
        command: 'example-acp',
        profile_delivery: 'system_prompt_override',
      },
    }));
    const config = parsed['optedIn']!;
    expect(config.profileDelivery).toBe('system_prompt_override');
    expect(agentExecutorsToToml(parsed)).toMatchObject({
      optedIn: { profile_delivery: 'system_prompt_override' },
    });
    expect(descriptorRevisionFromConfig(config)).toBe(descriptorRevisionFromConfig({
      ...config,
      profileDelivery: undefined,
    }));
    expect(() => AgentExecutorsConfigSchema.parse(agentExecutorsFromToml({
      unsupported: {
        protocol: 'acp-v1',
        command: 'example-acp',
        profile_delivery: 'unrecognized',
      },
    }))).toThrow();
  });

  it('orders glob candidates by full probe semver and deterministic fallbacks', () => {
    const sorted = (
      candidates: readonly { readonly command: string; readonly output: string }[],
    ) => candidates.toSorted(compareExecutorBinaryCandidates).map((candidate) => candidate.command);

    expect(sorted([
      { command: 'codex-150', output: 'codex-cli 0.150.0' },
      { command: 'codex-151', output: 'codex-cli 0.151.0' },
    ])).toEqual(['codex-150', 'codex-151']);
    expect(sorted([
      { command: 'codex-alpha-12', output: 'codex-cli 0.151.0-alpha.12.2' },
      { command: 'codex-alpha-7', output: 'codex-cli 0.151.0-alpha.7.1' },
    ])).toEqual(['codex-alpha-7', 'codex-alpha-12']);
    expect(sorted([
      {
        command: 'C:/extensions/openai.chatgpt-0.151.0-alpha.12.2/bin/windows-x86_64/codex.exe',
        output: 'unparseable',
      },
      {
        command: 'C:/extensions/openai.chatgpt-0.151.0-alpha.7.1/bin/windows-x86_64/codex.exe',
        output: 'unparseable',
      },
    ])).toEqual([
      'C:/extensions/openai.chatgpt-0.151.0-alpha.7.1/bin/windows-x86_64/codex.exe',
      'C:/extensions/openai.chatgpt-0.151.0-alpha.12.2/bin/windows-x86_64/codex.exe',
    ]);
    expect(sorted([
      {
        command: 'C:/extensions/openai.chatgpt-0.150.0/bin/windows-x86_64/codex.exe',
        output: 'codex-cli 0.150.0',
      },
      {
        command: 'C:/extensions/openai.chatgpt-0.151.0/bin/windows-x86_64/codex.exe',
        output: 'unparseable',
      },
    ])).toEqual([
      'C:/extensions/openai.chatgpt-0.150.0/bin/windows-x86_64/codex.exe',
      'C:/extensions/openai.chatgpt-0.151.0/bin/windows-x86_64/codex.exe',
    ]);
    expect(sorted([
      {
        command: 'C:/Program Files/WindowsApps/OpenAI.Codex_26.825.5331.0_x64__example/app/resources/codex.exe',
        output: 'unparseable',
      },
      {
        command: 'C:/Program Files/WindowsApps/OpenAI.Codex_26.825.4187.0_x64__example/app/resources/codex.exe',
        output: 'unparseable',
      },
    ])).toEqual([
      'C:/Program Files/WindowsApps/OpenAI.Codex_26.825.4187.0_x64__example/app/resources/codex.exe',
      'C:/Program Files/WindowsApps/OpenAI.Codex_26.825.5331.0_x64__example/app/resources/codex.exe',
    ]);
    expect(sorted([
      {
        command: 'C:/b/codex.exe',
        output: 'requires Node 99.0.0\ncodex-cli 0.151.0-alpha.7.1',
      },
      {
        command: 'C:/a/codex.exe',
        output: 'codex-cli 0.151.0-alpha.12.2',
      },
    ])).toEqual(['C:/b/codex.exe', 'C:/a/codex.exe']);
    expect(sorted([
      { command: 'C:/b/codex.exe', output: 'codex-cli 0.151.0' },
      { command: 'C:/a/codex.exe', output: 'codex-cli 0.151.0' },
    ])).toEqual(['C:/a/codex.exe', 'C:/b/codex.exe']);
    expect(sorted([
      { command: 'C:/b/codex.exe', output: 'unknown' },
      { command: 'C:/a/codex.exe', output: 'unknown' },
    ])).toEqual(['C:/a/codex.exe', 'C:/b/codex.exe']);
  });

  it('provides the trusted external harness descriptors by default', () => {
    services.set(IConfigService, configWith({}));
    services.set(
      IAgentExecutorRegistry,
      new SyncDescriptor(AgentExecutorRegistryService),
    );
    const registry = services.get(IAgentExecutorRegistry);

    expect([
      'grok-acp',
      'codex-app-server',
      'codex-acp',
      'cursor-acp',
      'claude-acp',
      'gemini-acp',
      'kimi-acp',
      'opencode-acp',
    ].map((id) => registry.get(id)?.id)).toEqual([
      'grok-acp',
      'codex-app-server',
      'codex-acp',
      'cursor-acp',
      'claude-acp',
      'gemini-acp',
      'kimi-acp',
      'opencode-acp',
    ]);
    expect(registry.list().map((entry) => entry.id)).toEqual(expect.arrayContaining([
      'openclaw-acp', 'cline-acp', 'codebuddy-acp', 'pi-acp', 'deepseek-acp', 'qoder-acp',
    ]));
    expect(resolvePromptDelivery(registry.get('grok-acp')!, { executorPrompt: undefined }))
      .toEqual({ requested: 'replace', actual: 'replace', downgraded: false });
    expect(resolvePromptDelivery(registry.get('claude-acp')!, { executorPrompt: undefined }))
      .toEqual({ requested: 'preamble', actual: 'preamble', downgraded: false });
    expect(resolvePromptDelivery(registry.get('grok-acp')!, { executorPrompt: { include: [], delivery: 'append' } }))
      .toEqual({ requested: 'append', actual: 'preamble', downgraded: true });
    expect(registry.get('grok-acp')).toMatchObject({
      args: ['--no-auto-update', 'agent', 'stdio'],
      startupTimeoutMs: 70_000,
      profileDelivery: 'system_prompt_override',
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(registry.get('codex-acp')).toMatchObject({
      env: { DISABLE_MCP_CONFIG_FILTERING: 'true' },
      startupTimeoutMs: 150_000,
    });
    expect(registry.get('cursor-acp')).toMatchObject({
      args: ['acp'],
      modelBinding: 'argv',
      modelArgs: ['--model', '{model}'],
    });
    expect(registry.get('kimi-acp')?.permissionModeMapping).toEqual({
      configId: 'mode',
      manual: 'default',
      auto: 'auto',
      yolo: 'yolo',
    });
    for (const id of [
      'grok-acp',
      'codex-acp',
      'cursor-acp',
      'claude-acp',
      'gemini-acp',
      'opencode-acp',
    ]) {
      expect(registry.get(id)?.permissionModeMapping).toBeUndefined();
    }
  });
});
