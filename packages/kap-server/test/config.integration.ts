import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configResponseSchema, type ConfigResponse } from '../src/protocol/rest-config';
import { ErrorCode } from '../src/protocol/error-codes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('server-v2 /api/v1/config', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-config-'));
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      home = undefined;
    }
  });

  async function boot(toml?: string): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    }
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function getConfig(): Promise<ConfigResponse> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<ConfigResponse>;
    expect(body.code).toBe(0);
    return configResponseSchema.parse(body.data);
  }

  async function patchConfig(patch: Record<string, unknown>): Promise<ConfigResponse> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<ConfigResponse>;
    expect(body.code).toBe(0);
    return configResponseSchema.parse(body.data);
  }

  it('GET echoes default_permission_mode and derives yolo = false', async () => {
    await boot('default_permission_mode = "auto"\n');
    const cfg = await getConfig();
    expect(cfg.default_permission_mode).toBe('auto');
    expect(cfg.yolo).toBe(false);
  });

  it('POST { yolo: true } sets default_permission_mode = yolo and echoes yolo = true', async () => {
    await boot();
    const cfg = await patchConfig({ yolo: true });
    expect(cfg.default_permission_mode).toBe('yolo');
    expect(cfg.yolo).toBe(true);

    const after = await getConfig();
    expect(after.default_permission_mode).toBe('yolo');
    expect(after.yolo).toBe(true);
  });

  it('POST { default_permission_mode: auto } writes the canonical field and derives yolo = false', async () => {
    await boot();
    const cfg = await patchConfig({ default_permission_mode: 'auto' });
    expect(cfg.default_permission_mode).toBe('auto');
    expect(cfg.yolo).toBe(false);

    const after = await getConfig();
    expect(after.default_permission_mode).toBe('auto');
    expect(after.yolo).toBe(false);
  });

  it('reads and patches the global plan gate configuration', async () => {
    await boot('[plan]\ngate = "free"\nenter_approval_timeout_ms = 60000\n');
    expect((await getConfig()).plan).toEqual({
      gate: 'free',
      enterApprovalTimeoutMs: 60_000,
    });

    const patched = await patchConfig({
      plan: { gate: 'gated', enter_approval_timeout_ms: 5000 },
    });
    expect(patched.plan).toEqual({
      gate: 'gated',
      enterApprovalTimeoutMs: 5000,
    });
    expect(await readFile(join(home as string, 'config.toml'), 'utf-8')).toContain(
      'enter_approval_timeout_ms = 5000',
    );
  });

  it('GET omits request_identity when no global layer is authored', async () => {
    await boot();
    expect(await getConfig()).not.toHaveProperty('request_identity');
  });

  it('GET returns the sparse authored global request_identity without expansion', async () => {
    await boot([
      '[request_identity.overrides.client]',
      'user_agent = "host"',
      '',
    ].join('\n'));

    expect((await getConfig()).request_identity).toEqual({
      overrides: { client: { user_agent: 'host' } },
    });
  });

  it('PATCH replaces, preserves on omission, and clears the authored global request_identity', async () => {
    await boot();
    const first = await patchConfig({
      request_identity: { overrides: { client: { user_agent: 'host' } } },
      replace_domains: ['request_identity'],
    });
    expect(first.request_identity).toEqual({
      overrides: { client: { user_agent: 'host' } },
    });

    const omitted = await patchConfig({ telemetry: true });
    expect(omitted.request_identity).toEqual(first.request_identity);

    const replaced = await patchConfig({
      request_identity: { overrides: { cache: { responses: 'none' } } },
    });
    expect(replaced.request_identity).toEqual({
      overrides: { cache: { responses: 'none' } },
    });

    const persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(persisted).toContain('[request_identity.overrides.cache]');
    expect(persisted).not.toContain('user_agent');

    const cleared = await patchConfig({ request_identity: null });
    expect(cleared).not.toHaveProperty('request_identity');
    expect(await getConfig()).not.toHaveProperty('request_identity');
    expect(await readFile(join(home as string, 'config.toml'), 'utf-8')).not.toContain(
      '[request_identity',
    );
  });

  it('rejects empty authored global request_identity layers', async () => {
    await boot();
    for (const request_identity of [{}, { overrides: {} }, { overrides: { client: {} } }]) {
      const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request_identity }),
      });
      const body = (await res.json()) as Envelope<null>;
      expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
    }
  });

  it('POST persists GUI server settings through the config service without dropping other domains', async () => {
    await boot([
      'telemetry = true',
      '',
      '[providers.example]',
      'type = "openai"',
      'api_key = "secret-kept"',
      '',
    ].join('\n'));

    const cfg = await patchConfig({
      subagent: { timeout_ms: 60_000, deny_models: ['example/blocked'] },
      agents: { enabled: false },
      builtin_product_skills: false,
      model_catalog: { refresh_interval_ms: 300_000, refresh_on_start: true },
    });

    expect(cfg.subagent).toEqual({ timeoutMs: 60_000, denyModels: ['example/blocked'] });
    expect(cfg.agents).toEqual({ enabled: false });
    expect(cfg.builtin_product_skills).toBe(false);
    expect(cfg.model_catalog).toEqual({ refreshIntervalMs: 300_000, refreshOnStart: true });

    const persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(persisted).toContain('api_key = "secret-kept"');
    expect(persisted).toContain('timeout_ms = 60000');
    expect(persisted).toContain('refresh_interval_ms = 300000');
  });

  it('round-trips every persistable GUI runtime domain through config.toml', async () => {
    await boot();

    await patchConfig({
      thread_communication: { enabled: true },
      token_counting: { strategy: 'measured' },
      workspace_instance: { idle_ttl_ms: 12_345 },
      image: { max_edge_px: 1_024, read_byte_budget: 2_000_000 },
      task: {
        max_running_tasks: 3,
        keep_alive_on_exit: true,
        bash_auto_background_on_timeout: true,
        bash_task_timeout_s: 45,
        kill_grace_period_ms: 2_500,
        print_wait_ceiling_s: 30,
        print_background_mode: 'drain',
        print_max_turns: 12,
      },
      identity: { name: 'Example Agent', slug: 'example-agent' },
      extra_agent_dirs: ['/tmp/example-agents', '/tmp/team-agents'],
      disabled_builtin_profiles: ['researcher', 'reviewer'],
      disabled_named_profiles: ['reviewer'],
      mcp: { startup_timeout_ms: 5_000, tool_timeout_ms: 6_000 },
      tools: { enabled: ['Read', 'Write'], disabled: ['Bash'] },
      replace_domains: [
        'thread_communication',
        'token_counting',
        'workspace_instance',
        'image',
        'task',
        'identity',
        'extra_agent_dirs',
        'disabled_builtin_profiles',
        'disabled_named_profiles',
        'mcp',
        'tools',
      ],
    });

    await server?.close();
    server = undefined;
    await boot();

    const after = await getConfig();
    expect(after.thread_communication).toEqual({ enabled: true });
    expect(after.token_counting).toEqual({ strategy: 'measured' });
    expect(after.workspace_instance).toEqual({ idleTtlMs: 12_345 });
    expect(after.image).toEqual({ maxEdgePx: 1_024, readByteBudget: 2_000_000 });
    expect(after.task).toEqual({
      maxRunningTasks: 3,
      keepAliveOnExit: true,
      bashAutoBackgroundOnTimeout: true,
      bashTaskTimeoutS: 45,
      killGracePeriodMs: 2_500,
      printWaitCeilingS: 30,
      printBackgroundMode: 'drain',
      printMaxTurns: 12,
    });
    expect(after.identity).toEqual({ name: 'Example Agent', slug: 'example-agent' });
    expect(after.extra_agent_dirs).toEqual(['/tmp/example-agents', '/tmp/team-agents']);
    expect(after.disabled_builtin_profiles).toEqual(['researcher', 'reviewer']);
    expect(after.disabled_named_profiles).toEqual(['reviewer']);
    expect(after.mcp).toEqual({ startupTimeoutMs: 5_000, toolTimeoutMs: 6_000 });
    expect(after.tools).toEqual({ enabled: ['Read', 'Write'], disabled: ['Bash'] });

    const persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(persisted).toContain('[thread_communication]');
    expect(persisted).toContain('idle_ttl_ms = 12345');
    expect(persisted).toContain('read_byte_budget = 2000000');
    expect(persisted).toContain('print_background_mode = "drain"');
    expect(persisted).toContain('startup_timeout_ms = 5000');
  });

  it('replace_domains removes omitted runtime fields and clears list domains', async () => {
    await boot([
      'extra_agent_dirs = ["/tmp/example-agents", "/tmp/old-agents"]',
      'disabled_builtin_profiles = ["researcher", "reviewer"]',
      'disabled_named_profiles = ["reviewer"]',
      '',
      '[thread_communication]',
      'enabled = true',
      '',
      '[token_counting]',
      'strategy = "measured"',
      '',
      '[workspace_instance]',
      'idle_ttl_ms = 12345',
      '',
      '[image]',
      'max_edge_px = 1024',
      'read_byte_budget = 2000000',
      '',
      '[task]',
      'max_running_tasks = 3',
      'keep_alive_on_exit = true',
      'print_background_mode = "drain"',
      'print_max_turns = 12',
      '',
      '[identity]',
      'name = "Old Agent"',
      'slug = "old-agent"',
      '',
      '[mcp]',
      'startup_timeout_ms = 5000',
      'tool_timeout_ms = 6000',
      '',
      '[tools]',
      'enabled = ["Read", "Write"]',
      'disabled = ["Bash"]',
      '',
    ].join('\n'));

    const after = await patchConfig({
      thread_communication: { enabled: false },
      token_counting: { strategy: 'estimated' },
      workspace_instance: {},
      image: { max_edge_px: 2_048 },
      task: { keep_alive_on_exit: false, print_background_mode: 'exit' },
      identity: { name: 'Example Agent' },
      extra_agent_dirs: ['/tmp/example-agents'],
      disabled_builtin_profiles: [],
      disabled_named_profiles: [],
      mcp: { tool_timeout_ms: 7_000 },
      tools: { enabled: ['Write'] },
      replace_domains: [
        'thread_communication',
        'token_counting',
        'workspace_instance',
        'image',
        'task',
        'identity',
        'extra_agent_dirs',
        'disabled_builtin_profiles',
        'disabled_named_profiles',
        'mcp',
        'tools',
      ],
    });

    expect(after.thread_communication).toEqual({ enabled: false });
    expect(after.token_counting).toEqual({ strategy: 'estimated' });
    expect(after.workspace_instance).toEqual({});
    expect(after.image).toEqual({ maxEdgePx: 2_048 });
    expect(after.task).toEqual({ keepAliveOnExit: false, printBackgroundMode: 'exit' });
    expect(after.identity).toEqual({ name: 'Example Agent' });
    expect(after.extra_agent_dirs).toEqual(['/tmp/example-agents']);
    expect(after.disabled_builtin_profiles).toEqual([]);
    expect(after.disabled_named_profiles).toEqual([]);
    expect(after.mcp).toEqual({ toolTimeoutMs: 7_000 });
    expect(after.tools).toEqual({ enabled: ['Write'] });

    const persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(persisted).not.toContain('read_byte_budget');
    expect(persisted).not.toContain('max_running_tasks');
    expect(persisted).not.toContain('print_max_turns');
    expect(persisted).not.toContain('slug =');
    expect(persisted).not.toContain('startup_timeout_ms');
    expect(persisted).not.toContain('disabled = ["Bash"]');
    expect(persisted).not.toContain('/tmp/old-agents');
    expect(persisted).not.toContain('"researcher"');
  });

  it('PATCH a disabled list domain without replace_domains replaces the array atomically', async () => {
    await boot([
      'disabled_builtin_profiles = ["coder"]',
      'disabled_named_profiles = ["critic"]',
      '',
    ].join('\n'));

    const first = await patchConfig({ disabled_builtin_profiles: ['explore', 'agent'] });
    expect(first.disabled_builtin_profiles).toEqual(['explore', 'agent']);
    expect(first.disabled_named_profiles).toEqual(['critic']);

    const second = await patchConfig({ disabled_builtin_profiles: ['agent'] });
    expect(second.disabled_builtin_profiles).toEqual(['agent']);

    const after = await getConfig();
    expect(after.disabled_builtin_profiles).toEqual(['agent']);
    expect(after.disabled_named_profiles).toEqual(['critic']);

    const persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(persisted).toContain('"agent"');
    expect(persisted).toContain('"critic"');
    expect(persisted).not.toContain('"coder"');
    expect(persisted).not.toContain('"explore"');
  });

  it('validates every runtime domain with the core schemas and rejects unknown top-level fields', async () => {
    await boot();

    const invalidPatches: Record<string, unknown>[] = [
      { thread_communication: { enabled: 'yes' } },
      { token_counting: { strategy: 'approximate' } },
      { plan: { enter_approval_timeout_ms: 4999 } },
      { workspace_instance: { idle_ttl_ms: -1 } },
      { image: { max_edge_px: 0 } },
      { task: { max_running_tasks: 0 } },
      { identity: { name: 42 } },
      { extra_agent_dirs: [42] },
      { disabled_builtin_profiles: [42] },
      { disabled_named_profiles: [42] },
      { mcp: { startup_timeout_ms: 0 } },
      { tools: { enabled: [42] } },
      { unknown_runtime_domain: { enabled: true } },
    ];

    for (const patch of invalidPatches) {
      const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<null>;
      expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
    }
  });

  it('keeps cron operational settings non-writable through POST /config', async () => {
    await boot();

    for (const patch of [
      { cron: { disabled: true } },
      { replace_domains: ['cron'] },
    ]) {
      const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<null>;
      expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
    }

    const after = await getConfig();
    expect(after.cron).toEqual({
      debug: false,
      noJitter: false,
      noStale: false,
      disabled: false,
      manualTick: false,
    });
  });

  it('serializes concurrent config patches so disjoint fields do not overwrite each other', async () => {
    await boot('[agents]\nenabled = true\n');

    await Promise.all([
      patchConfig({ agents: { enabled: false } }),
      patchConfig({ model_catalog: { refresh_on_start: true } }),
      patchConfig({ subagent: { deny_models: ['provider/blocked'] } }),
    ]);

    const after = await getConfig();
    expect(after.agents).toEqual({ enabled: false });
    expect(after.subagent?.denyModels).toEqual(['provider/blocked']);
    expect(after.model_catalog?.refreshOnStart).toBe(true);
  });

  it('replace_domains lets GUI list editors delete pool and experimental map entries', async () => {
    await boot([
      '[subagent]',
      'deny_models = ["provider/blocked", "provider/old"]',
      '',
      '[experimental]',
      'alpha = true',
      'beta = false',
      '',
    ].join('\n'));

    const after = await patchConfig({
      subagent: { deny_models: ['provider/blocked'] },
      experimental: { alpha: false },
      replace_domains: ['experimental'],
    });

    expect(after.subagent?.denyModels).toEqual(['provider/blocked']);
    expect(after.experimental).toEqual({ alpha: false });
  });

  it('POST { providers } converts fields of a provider id colliding with a map-valued key', async () => {
    await boot();
    await patchConfig({
      providers: {
        models: { type: 'openai', base_url: 'https://example.test', api_key: 'sk-test' },
      },
    });

    const after = await getConfig();
    expect(after.providers['models']).toMatchObject({
      type: 'openai',
      base_url: 'https://example.test',
      has_api_key: true,
    });
  });
});
