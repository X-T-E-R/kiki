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
      await rm(home, { recursive: true, force: true });
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
      subagent: { default_model: 'example/worker', default_effort: 'high', timeout_ms: 60_000 },
      agents: {
        enabled: false,
        default_subagent_model: 'example/collaborator',
        default_subagent_reasoning_effort: 'medium',
      },
      builtin_product_skills: false,
      model_catalog: { refresh_interval_ms: 300_000, refresh_on_start: true },
    });

    expect(cfg.subagent).toEqual({
      defaultModel: 'example/worker',
      defaultEffort: 'high',
      timeoutMs: 60_000,
    });
    expect(cfg.agents).toEqual({
      enabled: false,
      defaultSubagentModel: 'example/collaborator',
      defaultSubagentReasoningEffort: 'medium',
    });
    expect(cfg.builtin_product_skills).toBe(false);
    expect(cfg.model_catalog).toEqual({ refreshIntervalMs: 300_000, refreshOnStart: true });

    const persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(persisted).toContain('api_key = "secret-kept"');
    expect(persisted).toContain('default_model = "example/worker"');
    expect(persisted).toContain('refresh_interval_ms = 300000');
  });

  it('serializes concurrent config patches so disjoint fields do not overwrite each other', async () => {
    await boot('[agents]\nenabled = true\n');

    await Promise.all([
      patchConfig({ agents: { enabled: false } }),
      patchConfig({ agents: { default_subagent_model: 'example/collaborator' } }),
      patchConfig({ model_catalog: { refresh_on_start: true } }),
    ]);

    const after = await getConfig();
    expect(after.agents).toEqual({
      enabled: false,
      defaultSubagentModel: 'example/collaborator',
    });
    expect(after.model_catalog?.refreshOnStart).toBe(true);
  });

  it('POST { secondary_model } persists the subagent model pool and GET echoes it', async () => {
    await boot();
    const cfg = await patchConfig({
      secondary_model: {
        default_model: 'provider/fast',
        models: { 'provider/fast': 'fast and cheap' },
      },
    });
    expect(cfg.secondary_model).toMatchObject({ defaultModel: 'provider/fast' });

    const after = await getConfig();
    expect(after.secondary_model).toMatchObject({
      defaultModel: 'provider/fast',
      models: { 'provider/fast': 'fast and cheap' },
    });
  });

  it('POST { secondary_model } preserves pool alias keys containing underscores', async () => {
    await boot();
    await patchConfig({
      secondary_model: { default_model: 'provider/fast_model', models: { 'provider/fast_model': '' } },
    });

    const after = await getConfig();
    expect(after.secondary_model).toMatchObject({
      defaultModel: 'provider/fast_model',
      models: { 'provider/fast_model': '' },
    });
    expect(
      Object.keys((after.secondary_model as { models: Record<string, string> }).models),
    ).not.toContain('provider/fastModel');
  });

  it('replace_domains lets GUI list editors delete pool and experimental map entries', async () => {
    await boot([
      '[subagent]',
      'deny_models = ["provider/blocked", "provider/old"]',
      '',
      '[secondary_model]',
      'default_model = "provider/fast"',
      '',
      '[secondary_model.models]',
      '"provider/fast" = "fast"',
      '"provider/old" = "old"',
      '',
      '[experimental]',
      'alpha = true',
      'beta = false',
      '',
    ].join('\n'));

    const after = await patchConfig({
      subagent: { deny_models: ['provider/blocked'] },
      secondary_model: {
        default_model: 'provider/fast',
        models: { 'provider/fast': 'fast' },
        force: false,
        enforce_pool: true,
      },
      experimental: { alpha: false },
      replace_domains: ['secondary_model', 'experimental'],
    });

    expect(after.subagent?.denyModels).toEqual(['provider/blocked']);
    expect(after.secondary_model).toEqual({
      defaultModel: 'provider/fast',
      models: { 'provider/fast': 'fast' },
      force: false,
      enforcePool: true,
    });
    expect(after.experimental).toEqual({ alpha: false });

    const clearedPool = await patchConfig({
      secondary_model: { default_model: 'provider/fast', force: true, enforce_pool: false },
      replace_domains: ['secondary_model'],
    });
    expect(clearedPool.secondary_model).toEqual({
      defaultModel: 'provider/fast',
      force: true,
      enforcePool: false,
    });
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

  it('session create with a broken subagent model pool fails with VALIDATION_FAILED', async () => {
    await boot(
      '[experimental]\n"secondary-model" = true\n\n[secondary_model.models]\n"provider/fast" = "fast and cheap"\n',
    );
    const res = await authedFetch(server as RunningServer, base, '/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home as string } }),
    });
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(body.msg).toContain('[secondary_model].default_model is required');
  });

  it('session create with a broken subagent model pool succeeds while the experiment is off', async () => {
    await boot('[secondary_model.models]\n"provider/fast" = "fast and cheap"\n');
    const res = await authedFetch(server as RunningServer, base, '/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home as string } }),
    });
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
  });
});
