import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProtocolAdapterRegistry } from '@kiki/agent-core-v2/kosong/provider/protocolAdapterRegistry';
import type { ProtocolAdapterConfig } from '@kiki/agent-core-v2/kosong/protocol/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKimiConfigRpc, createKimiHarness, ErrorCodes, KimiError } from '#/index';

import { parseConfigString, readConfigFile, resolveModelAlias, writeConfigFile } from '#/config';
import { TEST_IDENTITY } from './test-identity';

// node-sdk/agent-core normalize paths to forward slashes (pathe). Mirror that
// in path assertions so they hold on Windows, where node:path produces
// backslashes.
const toPosix = (p: string): string => p.replaceAll('\\', '/');

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-config-'));
  tempDirs.push(dir);
  return dir;
}

const COMPLETE_TOML = `
default_model = "kimi-for-coding"
default_permission_mode = "auto"
skip_afk_prompt_injection = false
default_plan_mode = false
default_editor = ""
theme = "dark"
show_thinking_stream = true
merge_all_available_skills = true
extra_skill_dirs = ["~/team-skills", ".agents/team-skills"]

[providers.kimi-for-coding]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "sk-xxx"
custom_headers = { "X-Custom-Header" = "value" }

[providers.kimi-for-coding.env]
GOOGLE_CLOUD_PROJECT = "project-1"

[models.kimi-for-coding]
provider = "kimi-for-coding"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = ["image_in", "thinking", "video_in"]
display_name = "Kimi for Coding"

[loop_control]
max_retries_per_step = 3
max_ralph_iterations = 0
reserved_context_size = 50000
compaction_trigger_ratio = 0.85
compaction_soft_context_size = 256000

[background]
max_running_tasks = 4
keep_alive_on_exit = false
kill_grace_period_ms = 2000
print_wait_ceiling_s = 3600

[nb_search.provider_instances."exa.team"]
provider_id = "exa"
enabled = true
credential_slot_id = "exa.team"
options = {}

[nb_search.credential_slots."exa.team"]
provider_id = "exa"
env = "TEAM_EXA_API_KEY"

[nb_search.lanes."team.search"]
provider_instance_id = "exa.team"
operation_id = "search"
latency = "fast"
cost = "cheap"

[nb_search.defaults]
search_lane = "team.search"

[nb_search.execution]
search_timeout_ms = 15000
fetch_timeout_ms = 20000

[notifications]
claim_stale_after_ms = 15000

[thinking]
enabled = true
effort = "high"
`;

const LOCAL_RELOAD_TOML = `
default_model = "reload-test-model"

[providers.local]
type = "openai"
base_url = "http://127.0.0.1:9/v1"
api_key = "YOUR_API_KEY"

[models.reload-test-model]
provider = "local"
model = "reload-test-model"
max_context_size = 200000
`;

describe('resolveModelAlias', () => {
  it('resolves an ambiguous bare id to the first catalog candidate and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const resolved = resolveModelAlias({
        'beta/fast-model': { provider: 'beta', model: 'fast-model', maxContextSize: 128_000 },
        'alpha/fast-model': { provider: 'alpha', model: 'fast-model', maxContextSize: 128_000 },
      }, 'fast-model');

      expect(resolved?.id).toBe('beta/fast-model');
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain('resolves to "beta/fast-model"');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('SDK config TOML', () => {
  it('round-trips model parameter overrides and preserves wire parameter spelling', async () => {
    const path = join(await makeTempDir(), 'config.toml');
    const text = `
[models.example]
provider = "example"
model = "example-model"
max_context_size = 128000
default_effort = "medium"
[models.example.cognition]
overlay = "cognition/example.md"
overlay_mode = "prepend"
[models.example.overrides]
default_effort = "max"
context_budget = 64000
max_completion_tokens = 4000
service_tier = "flex"
[models.example.overrides.request_params]
temperature = 0.4
top_p = 0.8
`;
    const config = parseConfigString(text);
    expect(config.models?.['example']?.overrides).toEqual({
      defaultEffort: 'max', contextBudget: 64000, maxCompletionTokens: 4000,
      serviceTier: 'flex', requestParams: { temperature: 0.4, top_p: 0.8 },
    });
    await writeConfigFile(path, config);
    expect(readConfigFile(path).models).toEqual(config.models);
    expect(await readFile(path, 'utf8')).toContain('top_p = 0.8');
  });

  it('round-trips the separate nb-search source preference without changing canonical settings', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'config.toml');
    const value = { providers: {}, nbSearchSource: { reuse_local_config: false } };
    await writeConfigFile(path, value);
    expect(readConfigFile(path).nbSearchSource).toEqual({ reuse_local_config: false });
    expect(parseConfigString('[nb_search_source]\nreuse_local_config = true\n').nbSearchSource).toEqual({ reuse_local_config: true });
    expect(await readFile(path, 'utf8')).toContain('reuse_local_config = false');
  });

  it('resolves config paths through the config RPC wrapper', async () => {
    const dir = await makeTempDir();
    const rpc = createKimiConfigRpc();

    await expect(rpc.resolveConfigPath({ homeDir: dir })).resolves.toBe(toPosix(join(dir, 'config.toml')));
  });

  it('returns structured validation issues through the config RPC wrapper', async () => {
    const rpc = createKimiConfigRpc();

    await expect(
      rpc.validateConfigToml({
        text: `
[providers.kimi]
type = "kimi"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = "large"
`,
        filePath: 'broken.toml',
      }),
    ).rejects.toMatchObject({
      details: {
        validationIssues: [
          {
            path: ['models', 'kimi', 'maxContextSize'],
          },
        ],
      },
    });
  });

  it('rejects unknown nb_search providers through config validation', async () => {
    const rpc = createKimiConfigRpc();

    await expect(rpc.validateConfigToml({
      text: `
[nb_search.provider_instances.unknown]
provider_id = "unknown-provider"
enabled = true
options = {}
`,
      filePath: 'unknown-provider.toml',
    })).rejects.toMatchObject({ code: 'config.invalid' } satisfies Partial<KimiError>);
  });

  it('rejects nb_search credential slots bound to a different provider', async () => {
    const rpc = createKimiConfigRpc();

    await expect(rpc.validateConfigToml({
      text: `
[nb_search.provider_instances."exa.team"]
provider_id = "exa"
enabled = true
credential_slot_id = "team"
options = {}

[nb_search.credential_slots.team]
provider_id = "tavily"
env = "TEAM_SEARCH_API_KEY"
`,
      filePath: 'credential-mismatch.toml',
    })).rejects.toMatchObject({ code: 'config.invalid' } satisfies Partial<KimiError>);
  });

  it('accepts a configured provider whose credential environment variable is absent', async () => {
    const rpc = createKimiConfigRpc();

    await expect(rpc.validateConfigToml({
      text: `
[nb_search.credential_slots."exa.default"]
provider_id = "exa"
env = "MISSING_EXA_API_KEY"

[nb_search.defaults]
search_lane = "exa.search"
`,
      filePath: 'missing-credential.toml',
    })).resolves.toBeUndefined();
  });

  it('parses the documented config shape and keeps TUI-only fields in raw', () => {
    const config = parseConfigString(COMPLETE_TOML, 'complete.toml');

    expect(config.defaultModel).toBe('kimi-for-coding');
    expect(config.thinking?.enabled).toBe(true);
    expect(config.thinking?.effort).toBe('high');
    expect(config.defaultPermissionMode).toBe('auto');
    expect(config.defaultPlanMode).toBe(false);
    expect(config.mergeAllAvailableSkills).toBe(true);
    expect(config.extraSkillDirs).toEqual(['~/team-skills', '.agents/team-skills']);

    const provider = config.providers['kimi-for-coding'];
    expect(provider).toMatchObject({
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-xxx',
      customHeaders: { 'X-Custom-Header': 'value' },
      env: { GOOGLE_CLOUD_PROJECT: 'project-1' },
    });

    expect(config.models?.['kimi-for-coding']).toMatchObject({
      provider: 'kimi-for-coding',
      model: 'kimi-for-coding',
      maxContextSize: 262144,
      capabilities: ['image_in', 'thinking', 'video_in'],
      displayName: 'Kimi for Coding',
    });

    expect(config.loopControl).toEqual({
      maxRetriesPerStep: 3,
      maxRalphIterations: 0,
      reservedContextSize: 50000,
      compactionTriggerRatio: 0.85,
      compactionSoftContextSize: 256000,
    });
    expect(config.background).toEqual({
      maxRunningTasks: 4,
      keepAliveOnExit: false,
      killGracePeriodMs: 2000,
      printWaitCeilingS: 3600,
    });
    expect(config.nbSearch?.defaults?.search_lane).toBe('team.search');
    expect(config.nbSearch?.credential_slots?.['exa.team']).toEqual({
      provider_id: 'exa',
      env: 'TEAM_EXA_API_KEY',
    });

    expect('theme' in config).toBe(false);
    expect(config.raw?.['theme']).toBe('dark');
    expect(config.raw?.['skip_afk_prompt_injection']).toBe(false);
    expect(config.raw?.['show_thinking_stream']).toBe(true);
    expect(config.raw?.['notifications']).toEqual({ claim_stale_after_ms: 15000 });
  });

  it('writes typed fields in snake_case and preserves unknown raw sections', async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, 'config.toml');
    const config = parseConfigString(COMPLETE_TOML, configPath);

    await writeConfigFile(configPath, {
      ...config,
      defaultModel: 'kimi-for-coding',
      loopControl: {
        ...config.loopControl,
        maxStepsPerTurn: 42,
        compactionSoftContextSize: 512_000,
      },
    });

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('default_model = "kimi-for-coding"');
    expect(text).toContain('default_permission_mode = "auto"');
    expect(text).toContain('extra_skill_dirs = [ "~/team-skills", ".agents/team-skills" ]');
    expect(text).not.toContain('default_yolo');
    expect(text).toContain('max_steps_per_turn = 42');
    expect(text).toContain('compaction_soft_context_size = 512000');
    expect(text).toContain('display_name = "Kimi for Coding"');
    expect(text).toContain('GOOGLE_CLOUD_PROJECT = "project-1"');
    expect(text).toContain('claim_stale_after_ms = 15000');
    expect(text).toContain('theme = "dark"');

    const reloaded = readConfigFile(configPath);
    expect(reloaded.loopControl).toMatchObject({
      maxStepsPerTurn: 42,
      compactionSoftContextSize: 512_000,
    });
    expect(reloaded.raw?.['theme']).toBe('dark');
  });

  it('accepts camelCase aliases without keeping unknown fields in typed config', () => {
    const config = parseConfigString(`
defaultModel = "camel-model"

[providers.local]
type = "openai"
baseUrl = "https://example.test/v1"
apiKey = "sk-test"
unsupported_provider_field = "raw-only"

[models.camel-model]
provider = "local"
model = "gpt-test"
maxContextSize = 128000
displayName = "Camel Model"
custom_model_field = "raw-only"

[loopControl]
maxStepsPerRun = 7

[background]
maxRunningTasks = 2
`);

    expect(config.defaultModel).toBe('camel-model');
    expect(config.providers['local']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-test',
    });
    expect(config.models?.['camel-model']).toMatchObject({
      maxContextSize: 128000,
      displayName: 'Camel Model',
    });
    expect(config.loopControl?.maxStepsPerTurn).toBe(7);
    expect(config.background?.maxRunningTasks).toBe(2);

    expect('unsupportedProviderField' in config.providers['local']!).toBe(false);
    expect('customModelField' in config.models!['camel-model']!).toBe(false);

    const rawProviders = config.raw?.['providers'] as Record<string, Record<string, unknown>>;
    const rawModels = config.raw?.['models'] as Record<string, Record<string, unknown>>;
    expect(rawProviders['local']?.['unsupported_provider_field']).toBe('raw-only');
    expect(rawModels['camel-model']?.['custom_model_field']).toBe('raw-only');
  });
});

describe('KimiHarness config API', () => {
  it('loads default config when missing and deep-merges setConfig patches from disk', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');

    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await harness.setConfig({
      providers: {
        'kimi-for-coding': {
          apiKey: 'sk-updated',
        },
      },
      nbSearch: {
        execution: {
          search_timeout_ms: 25_000,
        },
      },
    });

    const config = await harness.getConfig({ reload: true });
    expect(config.providers['kimi-for-coding']).toMatchObject({
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-updated',
      env: { GOOGLE_CLOUD_PROJECT: 'project-1' },
    });
    expect(config.nbSearch?.execution?.search_timeout_ms).toBe(25_000);
    expect(config.raw?.['theme']).toBe('dark');

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('theme = "dark"');
    expect(text).toContain('GOOGLE_CLOUD_PROJECT = "project-1"');
    expect(text).toContain('claim_stale_after_ms = 15000');
  });

  it('does not write invalid config patches', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const before = await readFile(configPath, 'utf-8');

    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    const setInvalidConfig = harness.setConfig({
      providers: {
        bad: {
          type: 'not-a-provider',
        },
      },
    } as never);

    await expect(setInvalidConfig).rejects.toBeInstanceOf(KimiError);
    await expect(setInvalidConfig).rejects.toMatchObject({
      code: 'config.invalid',
    } satisfies Partial<KimiError>);

    await expect(readFile(configPath, 'utf-8')).resolves.toBe(before);
  });

  it('rejects inline nb_search secret options without changing the config file', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const before = await readFile(configPath, 'utf-8');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.setConfig({
      nbSearch: {
        provider_instances: {
          'openai-compatible.default': { options: { api_key: 'secret-value' } },
        },
      },
    })).rejects.toMatchObject({ code: 'config.invalid' } satisfies Partial<KimiError>);

    await expect(readFile(configPath, 'utf-8')).resolves.toBe(before);
    expect(await readFile(configPath, 'utf-8')).not.toContain('secret-value');
  });

  it('validates a local nb_search patch after merging it with the saved config', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const before = await readFile(configPath, 'utf-8');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.setConfig({
      nbSearch: {
        credential_slots: {
          'exa.team': { provider_id: 'tavily', env: 'TEAM_EXA_API_KEY' },
        },
      },
    })).rejects.toMatchObject({ code: 'config.invalid' } satisfies Partial<KimiError>);

    await expect(readFile(configPath, 'utf-8')).resolves.toBe(before);
  });

  it('keeps the original file when direct write validation rejects an unknown provider', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const before = await readFile(configPath, 'utf-8');
    const config = parseConfigString(COMPLETE_TOML, configPath);

    await expect(writeConfigFile(configPath, {
      ...config,
      nbSearch: {
        provider_instances: {
          unknown: { provider_id: 'unknown-provider', enabled: true, options: {} },
        },
      },
    })).rejects.toBeInstanceOf(KimiError);

    await expect(readFile(configPath, 'utf-8')).resolves.toBe(before);
  });

  it('uses default config when the config file is absent', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    // With no file to read there is no `raw` document, and the effective view is
    // exactly the engine's registered section defaults — every domain present,
    // none of them carrying a user value.
    await expect(harness.getConfig()).resolves.toEqual({
      providers: {},
      models: {},
      thinking: {},
      defaultPlanMode: false,
      nbSearchSource: { reuse_local_config: true },
      mergeAllAvailableSkills: true,
      extraSkillDirs: [],
      loopControl: { compactionSoftContextSize: 0 },
      background: {},
      subagent: { timeoutMs: 7_200_000, maxDirectChildren: 16, maxTotalSubagents: 0 },
      mcp: {},
      image: {},
    });
  });

  it('returns experimental feature metadata through the harness', async () => {
    // The master switch off, so every flag reports its own resolution.
    vi.stubEnv('KIKI_EXPERIMENTAL_FLAG', '0');
    // A flag turned on against its default, and one turned off against a
    // default-on flag: both must report `env` as the deciding source.
    vi.stubEnv('KIKI_EXPERIMENTAL_TOOL_SELECT', '1');
    vi.stubEnv('KIKI_EXPERIMENTAL_TASK_WAIT', '0');
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    const features = await harness.getExperimentalFeatures();

    // The registry order is the engine's; the SDK must forward the whole
    // catalog, not a filtered subset. (secondary-model left the registry with
    // the model-inheritance removal.)
    expect(features.map((feature) => feature.id)).toEqual([
      'agent-profile-routes',
      'auto_session_title',
      'task_wait',
      'tool-select',
      'subagent_release_idle',
      'persistence_minidb_readmodel',
      'external_delegation_mcp',
    ]);
    // Every entry carries the full metadata a client needs to render a toggle.
    for (const feature of features) {
      expect(feature).toMatchObject({
        id: expect.any(String),
        title: expect.any(String),
        description: expect.any(String),
        surface: expect.stringMatching(/^(core|cli|both)$/),
        env: expect.stringMatching(/^KIKI_EXPERIMENTAL_[A-Z0-9_]+$/),
        defaultEnabled: expect.any(Boolean),
        enabled: expect.any(Boolean),
        source: expect.stringMatching(/^(default|config|env|master-env)$/),
      });
    }
    expect(features.find((feature) => feature.id === 'tool-select')).toEqual({
      id: 'tool-select',
      title: 'Tool select (progressive tool disclosure)',
      description:
        'Keep MCP tool schemas out of the immutable top-level tools[]; the model loads them on demand via the SelectTools tool. Only takes effect on models whose capability catalog declares dynamically loaded tools.',
      surface: 'core',
      env: 'KIKI_EXPERIMENTAL_TOOL_SELECT',
      defaultEnabled: false,
      enabled: true,
      source: 'env',
    });
    expect(features.find((feature) => feature.id === 'task_wait')).toMatchObject({
      defaultEnabled: true,
      enabled: false,
      source: 'env',
    });
  });

  it('can create the default config scaffold without selecting a model', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await harness.ensureConfigFile();

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('Runtime settings for Kiki.');
    expect(text).not.toMatch(/^default_thinking =/m);
    expect(text).not.toMatch(/^default_model =/m);

    const config = await harness.getConfig({ reload: true });
    expect(config.providers).toEqual({});
    expect(config.defaultModel).toBeUndefined();
    expect(config.thinking?.enabled).toBeUndefined();
  });

  it('reloads an active session without closing the SDK session wrapper', async () => {
    const homeDir = await makeTempDir();
    const workDir = join(homeDir, 'work');
    await mkdir(workDir, { recursive: true });
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    const session = await harness.createSession({
      id: 'session-sdk-reload',
      workDir,
      model: 'kimi-for-coding',
    });

    expect(session.getResumeState()).toBeUndefined();

    const reloaded = await harness.reloadSession({ id: session.id });

    expect(reloaded).toBe(session);
    expect(harness.getSession(session.id)).toBe(session);
    expect(session.getResumeState()?.agents['main']).toBeDefined();
    await expect(session.getStatus()).resolves.toMatchObject({ model: 'kimi-for-coding' });
  });

  it('reloads a cold session through the facade and materializes real state', async () => {
    const homeDir = await makeTempDir();
    const workDir = join(homeDir, 'work');
    await mkdir(workDir, { recursive: true });
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, LOCAL_RELOAD_TOML, 'utf-8');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    const session = await harness.createSession({
      id: 'session-sdk-reload-cold',
      workDir,
      model: 'reload-test-model',
    });

    await session.close();
    expect(harness.getSession(session.id)).toBeUndefined();

    const reloaded = await harness.reloadSession({ id: session.id });

    expect(reloaded).not.toBe(session);
    expect(harness.getSession(session.id)).toBe(reloaded);
    expect(reloaded.getResumeState()?.agents['main']).toBeDefined();
    await expect(reloaded.getStatus()).resolves.toMatchObject({ model: 'reload-test-model' });
  });

  it('returns session.not_found when reloading a missing session', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.reloadSession({ id: 'session-sdk-reload-missing' })).rejects.toMatchObject({
      name: 'KimiError',
      code: ErrorCodes.SESSION_NOT_FOUND,
      details: { sessionId: 'session-sdk-reload-missing' },
    } satisfies Partial<KimiError>);
  });

  it('rejects a busy reload without closing the live session', async () => {
    const homeDir = await makeTempDir();
    const workDir = join(homeDir, 'work');
    await mkdir(workDir, { recursive: true });
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, LOCAL_RELOAD_TOML, 'utf-8');
    let releaseGeneration: (() => void) | undefined;
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const provider = vi
      .spyOn(ProtocolAdapterRegistry.prototype, 'createChatProvider')
      .mockImplementation(
        (config: ProtocolAdapterConfig) =>
          ({
            name: config.providerType ?? 'fake',
            modelName: config.modelName,
            thinkingEffort: null,
            async generate() {
              await generationGate;
              return {
                id: 'reload-busy-response',
                usage: {
                  inputOther: 0,
                  output: 1,
                  inputCacheRead: 0,
                  inputCacheCreation: 0,
                },
                finishReason: 'completed',
                rawFinishReason: 'stop',
                traceId: null,
                async *[Symbol.asyncIterator]() {
                  yield { type: 'text', text: 'reload busy response' };
                },
              };
            },
          }) as ReturnType<ProtocolAdapterRegistry['createChatProvider']>,
      );
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    let stopListening: (() => void) | undefined;
    let prompt: Promise<void> | undefined;

    try {
      const session = await harness.createSession({
        id: 'session-sdk-reload-busy',
        workDir,
        model: 'reload-test-model',
      });
      let startedResolve!: () => void;
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      stopListening = session.onEvent((event) => {
        if (event.type === 'turn.started') startedResolve();
      });
      prompt = session.prompt('hold this turn open');
      await started;

      await expect(harness.reloadSession({ id: session.id })).rejects.toMatchObject({
        name: 'KimiError',
        code: ErrorCodes.TURN_AGENT_BUSY,
      } satisfies Partial<KimiError>);
      expect(session.isClosed).toBe(false);
      expect(harness.getSession(session.id)).toBe(session);
      await expect(session.getStatus()).resolves.toMatchObject({ model: 'reload-test-model' });
    } finally {
      releaseGeneration?.();
      await prompt?.catch(() => undefined);
      stopListening?.();
      provider.mockRestore();
      await harness.close();
    }
  });

  it('forwards forcePluginSessionStartReminder to the active session reload', async () => {
    const homeDir = await makeTempDir();
    const workDir = join(homeDir, 'work');
    await mkdir(workDir, { recursive: true });
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    const session = await harness.createSession({
      id: 'session-sdk-reload-forward',
      workDir,
      model: 'kimi-for-coding',
    });

    const reloadSpy = vi.spyOn(session, 'reloadSession').mockResolvedValue({} as never);

    await harness.reloadSession({ id: session.id, forcePluginSessionStartReminder: true });

    expect(reloadSpy).toHaveBeenCalledWith({ forcePluginSessionStartReminder: true });
  });
});
