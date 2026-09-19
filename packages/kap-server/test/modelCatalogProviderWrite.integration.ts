import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: Array<{ path: string; message: string }> | Record<string, unknown>;
}

const DEFAULTED_TOML = [
  'default_provider = "openai"',
  'default_model = "gpt4o"',
  '',
  '[providers.kimi]',
  'type = "kimi"',
  'api_key = "sk-test"',
  '',
  '[providers.openai]',
  'type = "openai"',
  'api_key = "sk-openai"',
  '',
  '[models.k2]',
  'provider = "kimi"',
  'model = "kimi-k2"',
  'max_context_size = 131072',
  '',
  '[models.gpt4o]',
  'provider = "openai"',
  'model = "gpt-4o"',
  'max_context_size = 128000',
  '',
].join('\n');

const KEEP_DEFAULT_TOML = DEFAULTED_TOML.replace('default_provider = "openai"\n', '').replace(
  'default_model = "gpt4o"',
  'default_model = "k2"',
);

const DANGLING_DEFAULT_TOML = [
  'default_model = "gone"',
  '',
  '[providers.kimi]',
  'type = "kimi"',
  'api_key = "sk-test"',
  '',
].join('\n');

const MANAGED_TOML = [
  '[providers."managed:kimi-code"]',
  'type = "kimi"',
  'api_key = ""',
  'base_url = "https://api.example.test/v1"',
  'oauth = { storage = "file", key = "oauth/kimi-code" }',
  '',
  '[models."managed:kimi-code/kimi-k2"]',
  'provider = "managed:kimi-code"',
  'model = "kimi-k2"',
  'max_context_size = 131072',
  '',
].join('\n');

const REAL_MANAGED_TOML = [
  'default_model = "kimi-code/kimi-k2"',
  '',
  '[providers."managed:kimi-code"]',
  'type = "kimi"',
  'api_key = ""',
  'base_url = "https://api.kimi.example/v1"',
  'oauth = { storage = "file", key = "oauth/kimi-code" }',
  '',
  '[models."kimi-code/kimi-k2"]',
  'provider = "managed:kimi-code"',
  'model = "kimi-k2"',
  'max_context_size = 262144',
  'capabilities = ["thinking"]',
  'protocol = "anthropic"',
  'beta_api = true',
  'adaptive_thinking = true',
  'display_name = "Kimi K2"',
  '',
  '[models."kimi-code/kimi-k2-thinking"]',
  'provider = "managed:kimi-code"',
  'model = "kimi-k2-thinking"',
  'max_context_size = 262144',
  'capabilities = ["thinking", "always_thinking"]',
  'protocol = "anthropic"',
  'beta_api = true',
  'adaptive_thinking = true',
  '',
].join('\n');

const ALIAS_TOML = [
  'default_model = "fast"',
  '',
  '[providers.edge]',
  'type = "openai"',
  'api_key = "sk-edge"',
  'base_url = "https://edge.example.test/v1"',
  '',
  '[models.fast]',
  'provider = "edge"',
  'model = "vendor/model:v1"',
  'max_context_size = 200000',
  'display_name = "Fast"',
  '',
  '[models.daily]',
  'provider = "edge"',
  'model = "vendor/model:v1"',
  'max_context_size = 200000',
  'display_name = "Daily"',
  '',
].join('\n');

const ALIAS_COLLISION_TOML = [
  '[providers.edge]',
  'type = "openai"',
  'api_key = "sk-edge"',
  'base_url = "https://edge.example.test/v1"',
  '',
  '[models."my-openai/gpt-4.1"]',
  'provider = "edge"',
  'model = "vendor/model:v1"',
  'max_context_size = 200000',
  'display_name = "Edge GPT wrapper"',
  '',
].join('\n');

const CREATE_BODY = {
  id: 'my-openai',
  type: 'openai',
  api_key: 'sk-test-openai',
  base_url: 'https://api.openai.example/v1',
  default_model: 'gpt-4.1',
  models: [
    {
      remote_id: 'gpt-4.1',
      max_context_size: 1047576,
      display_name: 'GPT-4.1',
      capabilities: ['vision'],
      max_output_size: 32768,
    },
    { remote_id: 'gpt-4o-mini', max_context_size: 128000 },
  ],
} as const;

describe('server-v2 /api provider write endpoints', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-provider-write-'));
    process.env['KIKI_MODEL_CATALOG_REFRESH_ON_START'] = '0';
    process.env['KIKI_MODEL_CATALOG_REFRESH_INTERVAL_MS'] = '0';
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
    delete process.env['KIKI_MODEL_CATALOG_REFRESH_ON_START'];
    delete process.env['KIKI_MODEL_CATALOG_REFRESH_INTERVAL_MS'];
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

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        body === undefined ? {} : { 'content-type': 'application/json' },
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function patchJson<T>(
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'PATCH',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function deleteJson<T>(
    path: string,
  ): Promise<{ status: number; text: string; body: Envelope<T> | undefined }> {
    const res = await fetch(`${base}${path}`, {
      method: 'DELETE',
      headers: authHeaders(server as RunningServer),
    } as never);
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: text.length === 0 ? undefined : (JSON.parse(text) as Envelope<T>),
    };
  }

  async function readConfigToml(): Promise<Record<string, unknown>> {
    const text = await readFile(join(home as string, 'config.toml'), 'utf-8');
    return parseToml(text) as Record<string, unknown>;
  }

  it('creates a provider with model aliases and persists them to config.toml', async () => {
    await boot();
    const { status, body } = await postJson<unknown>('/api/providers', CREATE_BODY);
    expect(status).toBe(201);
    expect(body.code).toBe(0);
    expect(body.data).toMatchObject({
      id: 'my-openai',
      type: 'openai',
      base_url: 'https://api.openai.example/v1',
      default_model: 'my-openai/gpt-4.1',
      has_api_key: true,
      status: 'connected',
      models: ['my-openai/gpt-4.1', 'my-openai/gpt-4o-mini'],
    });
    expect((body.data as Record<string, unknown>)['revision']).toEqual(expect.any(String));

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toEqual({
      'my-openai': {
        type: 'openai',
        api_key: 'sk-test-openai',
        base_url: 'https://api.openai.example/v1',
        default_model: 'my-openai/gpt-4.1',
      },
    });
    expect(onDisk['models']).toEqual({
      'my-openai/gpt-4.1': {
        provider: 'my-openai',
        model: 'gpt-4.1',
        max_context_size: 1047576,
        display_name: 'GPT-4.1',
        capabilities: ['vision'],
        max_output_size: 32768,
      },
      'my-openai/gpt-4o-mini': {
        provider: 'my-openai',
        model: 'gpt-4o-mini',
        max_context_size: 128000,
      },
    });

    const providers = await getJson<{ items: unknown[] }>('/api/providers');
    expect(providers.body.data.items).toEqual([
      {
        id: 'my-openai',
        type: 'openai',
        base_url: 'https://api.openai.example/v1',
        default_model: 'my-openai/gpt-4.1',
        has_api_key: true,
        status: 'connected',
        models: ['my-openai/gpt-4.1', 'my-openai/gpt-4o-mini'],
      },
    ]);

    const models = await getJson<{ items: unknown[] }>('/api/models');
    expect(models.body.data.items).toEqual([
      {
        id: 'my-openai/gpt-4.1',
        provider_id: 'my-openai',
        remote_id: 'gpt-4.1',
        display_name: 'GPT-4.1',
        max_context_size: 1047576,
        capabilities: ['vision'],
      },
      {
        id: 'my-openai/gpt-4o-mini',
        provider_id: 'my-openai',
        remote_id: 'gpt-4o-mini',
        display_name: 'gpt-4o-mini',
        max_context_size: 128000,
      },
    ]);
  });

  it('creates model request identities and preserves them across sparse patches', async () => {
    await boot();
    const firstIdentity = { overrides: { request: { logical_id: 'none' } } } as const;
    const created = await postJson<unknown>('/api/providers', {
      ...CREATE_BODY,
      models: [
        { ...CREATE_BODY.models[0], request_identity: firstIdentity },
        CREATE_BODY.models[1],
      ],
    });
    expect(created.status).toBe(201);

    expect((await getJson<{ items: Array<Record<string, unknown>> }>('/api/models')).body.data.items)
      .toEqual([
        {
          id: 'my-openai/gpt-4.1',
          provider_id: 'my-openai',
          remote_id: 'gpt-4.1',
          display_name: 'GPT-4.1',
          max_context_size: 1047576,
          capabilities: ['vision'],
          request_identity: firstIdentity,
        },
        {
          id: 'my-openai/gpt-4o-mini',
          provider_id: 'my-openai',
          remote_id: 'gpt-4o-mini',
          display_name: 'gpt-4o-mini',
          max_context_size: 128000,
        },
      ]);

    await patchJson('/api/models/my-openai%2Fgpt-4.1', { display_name: 'Renamed' });
    expect((await readConfigToml())['models']).toMatchObject({
      'my-openai/gpt-4.1': { request_identity: firstIdentity, display_name: 'Renamed' },
    });
  });

  it('clears model request_identity only on explicit null', async () => {
    await boot();
    await postJson('/api/providers', {
      ...CREATE_BODY,
      models: [
        { ...CREATE_BODY.models[0], request_identity: { preset: 'none' } },
        CREATE_BODY.models[1],
      ],
    });

    await patchJson('/api/models/my-openai%2Fgpt-4.1', { request_identity: null });
    const models = (await readConfigToml())['models'] as Record<string, Record<string, unknown>>;
    expect(models['my-openai/gpt-4.1']).not.toHaveProperty('request_identity');
  });

  it('round-trips override-only provider request_identity and preserves it when a patch omits the field', async () => {
    await boot();
    const requestIdentity = {
      overrides: { client: { user_agent: 'host' } },
    } as const;
    const created = await postJson<{ request_identity?: unknown }>('/api/providers', {
      ...CREATE_BODY,
      request_identity: requestIdentity,
    });
    expect(created.body.code).toBe(0);
    expect(created.status).toBe(201);
    expect(created.body.data.request_identity).toEqual(requestIdentity);
    expect((await readConfigToml())['providers']).toMatchObject({
      'my-openai': { request_identity: requestIdentity },
    });

    const patched = await patchJson<{ provider: { request_identity?: unknown } }>(
      '/api/providers/my-openai',
      { base_url: 'https://api.openai.example/v2' },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.data.provider.request_identity).toEqual(requestIdentity);
  });

  it('clears provider request_identity only on explicit null', async () => {
    await boot();
    await postJson('/api/providers', {
      ...CREATE_BODY,
      request_identity: { preset: 'none' },
    });

    const cleared = await patchJson<{ provider: { request_identity?: unknown } }>(
      '/api/providers/my-openai',
      { request_identity: null },
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.provider.request_identity).toBeUndefined();
    const providers = (await readConfigToml())['providers'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(providers['my-openai']).not.toHaveProperty('request_identity');
  });

  it('round-trips image policies and applies sparse leaf clears', async () => {
    await boot();
    const created = await postJson('/api/providers', {
      ...CREATE_BODY,
      images: {
        accepted_types: ['image/jpeg', 'image/png'],
        convert_unsupported: 'auto',
      },
      models: [
        {
          ...CREATE_BODY.models[0],
          images: { accepted_types: ['image/png'], convert_unsupported: 'png' },
        },
        CREATE_BODY.models[1],
      ],
    });
    expect(created.status).toBe(201);

    await patchJson('/api/providers/my-openai', {
      images: { accepted_types: null },
    });
    await patchJson('/api/models/my-openai%2Fgpt-4.1', {
      images: { convert_unsupported: 'off' },
    });

    const config = await readConfigToml();
    expect(config['providers']).toMatchObject({
      'my-openai': { images: { convert_unsupported: 'auto' } },
    });
    expect(config['models']).toMatchObject({
      'my-openai/gpt-4.1': {
        images: { accepted_types: ['image/png'], convert_unsupported: 'off' },
      },
    });
  });

  it('rejects invalid provider and model request_identity layers', async () => {
    await boot();
    for (const body of [
      { ...CREATE_BODY, request_identity: {} },
      { ...CREATE_BODY, request_identity: { preset: 'none', future_root: true } },
      {
        ...CREATE_BODY,
        request_identity: {
          preset: 'none',
          overrides: { request: { future_axis: 'value' } },
        },
      },
      {
        ...CREATE_BODY,
        models: [
          { ...CREATE_BODY.models[0], request_identity: { overrides: {} } },
          CREATE_BODY.models[1],
        ],
      },
    ]) {
      expect((await postJson('/api/providers', body)).body.code).toBe(40001);
    }

    const conflict = await postJson('/api/providers', CREATE_BODY);
    expect(conflict.status).toBe(201);
    for (const patch of [
      { request_identity: {} },
      { request_identity: { preset: 'none', future_root: true } },
    ]) {
      expect((await patchJson('/api/providers/my-openai', patch)).body.code).toBe(40001);
    }
  });

  it('rejects removed attribution fields on both create and provider patch', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const created = await postJson<unknown>('/api/providers', {
      ...CREATE_BODY,
      request_attribution: 'none',
    });
    expect(created.body.code).toBe(40001);
    expect(created.body.data).toBeNull();
    expect(Array.isArray(created.body.details)).toBe(true);

    const patched = await patchJson<unknown>('/api/providers/openai', {
      request_originator: 'my-ide',
    });
    expect(patched.body.code).toBe(40001);
    expect(patched.body.data).toBeNull();
  });

  it('creates a credential-less provider (env-resolved types may omit api_key)', async () => {
    await boot();
    const { status, body } = await postJson<unknown>('/api/providers', {
      id: 'vertex',
      type: 'vertexai',
      models: [{ remote_id: 'gemini-2.5-pro', max_context_size: 1048576 }],
    });
    expect(status).toBe(201);
    expect(body.code).toBe(0);
    expect(body.data).toMatchObject({
      id: 'vertex',
      type: 'vertexai',
      default_model: 'vertex/gemini-2.5-pro',
      has_api_key: false,
      status: 'unconfigured',
      models: ['vertex/gemini-2.5-pro'],
    });
  });

  it('allows saving a connection with zero models', async () => {
    await boot();
    const { status, body } = await postJson<Record<string, unknown>>('/api/providers', {
      id: 'empty-gateway',
      type: 'openai',
      base_url: 'https://gateway.example.test/v1',
    });
    expect(status).toBe(201);
    expect(body.code).toBe(0);
    expect(body.data).toMatchObject({ id: 'empty-gateway', models: [] });

    const onDisk = await readConfigToml();
    expect(onDisk['models']).toBeUndefined();
    expect(onDisk['providers']).toMatchObject({ 'empty-gateway': { type: 'openai' } });
  });

  it('seeds the global default_model on a fresh setup (the provider default wins)', async () => {
    await boot();
    const { status } = await postJson<unknown>('/api/providers', CREATE_BODY);
    expect(status).toBe(201);

    const onDisk = await readConfigToml();
    expect(onDisk['default_model']).toBe('my-openai/gpt-4.1');

    const auth = await getJson<{ ready: boolean; default_model: string | null }>('/api/auth');
    expect(auth.body.data).toMatchObject({ ready: true, default_model: 'my-openai/gpt-4.1' });
  });

  it('seeds the first model when the create body names no provider default', async () => {
    await boot();
    const { status } = await postJson<unknown>('/api/providers', {
      id: 'my-openai',
      type: 'openai',
      api_key: 'sk-test-openai',
      models: [
        { remote_id: 'gpt-4o-mini', max_context_size: 128000 },
        { remote_id: 'gpt-4.1', max_context_size: 1047576 },
      ],
    });
    expect(status).toBe(201);

    const onDisk = await readConfigToml();
    expect(onDisk['default_model']).toBe('my-openai/gpt-4o-mini');
  });

  it('keeps an existing global default_model on create', async () => {
    await boot(DEFAULTED_TOML);
    const { status } = await postJson<unknown>('/api/providers', CREATE_BODY);
    expect(status).toBe(201);

    const onDisk = await readConfigToml();
    expect(onDisk['default_model']).toBe('gpt4o');
  });

  it('leaves even a dangling default_model untouched on create', async () => {
    await boot(DANGLING_DEFAULT_TOML);
    const { status } = await postJson<unknown>('/api/providers', CREATE_BODY);
    expect(status).toBe(201);

    const onDisk = await readConfigToml();
    expect(onDisk['default_model']).toBe('gone');
  });

  it('rejects a duplicate provider id with 40921', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { body } = await postJson<unknown>('/api/providers', {
      ...CREATE_BODY,
      id: 'openai',
    });
    expect(body.code).toBe(40921);
    expect(body.data).toBeNull();

    const providers = await getJson<{ items: Array<{ id: string }> }>('/api/providers');
    expect(providers.body.data.items.map((p) => p.id)).toEqual(['kimi', 'openai']);
  });

  it('rejects a provider create whose model alias already exists, leaving config untouched', async () => {
    await boot(ALIAS_COLLISION_TOML);
    const before = await readFile(join(home as string, 'config.toml'), 'utf-8');

    const { status, body } = await postJson<unknown>('/api/providers', CREATE_BODY);
    expect(status).toBe(200);
    expect(body.code).toBe(40942);
    expect(body.data).toBeNull();

    expect(await readFile(join(home as string, 'config.toml'), 'utf-8')).toBe(before);

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toEqual({
      edge: { type: 'openai', api_key: 'sk-edge', base_url: 'https://edge.example.test/v1' },
    });
    expect(onDisk['models']).toEqual({
      'my-openai/gpt-4.1': {
        provider: 'edge',
        model: 'vendor/model:v1',
        max_context_size: 200000,
        display_name: 'Edge GPT wrapper',
      },
    });
    expect(onDisk['default_model']).toBeUndefined();

    const providers = await getJson<{ items: Array<{ id: string }> }>('/api/providers');
    expect(providers.body.data.items.map((p) => p.id)).toEqual(['edge']);
  });

  it('accepts a Unicode provider id (Chinese + space)', async () => {
    await boot();
    const { status, body } = await postJson<{ id: string }>('/api/providers', {
      ...CREATE_BODY,
      id: '测试 Kimi',
    });
    expect(status).toBe(201);
    expect(body.code).toBe(0);
    expect(body.data.id).toBe('测试 Kimi');

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toMatchObject({ '测试 Kimi': { type: 'openai' } });
    expect(onDisk['models']).toMatchObject({
      '测试 Kimi/gpt-4.1': { provider: '测试 Kimi', model: 'gpt-4.1' },
    });
  });

  it('creates models with support_efforts and adaptive_thinking', async () => {
    await boot();
    const { status } = await postJson<unknown>('/api/providers', {
      ...CREATE_BODY,
      models: [
        {
          remote_id: 'gpt-4.1',
          max_context_size: 1047576,
          support_efforts: ['low', 'max'],
          adaptive_thinking: true,
        },
      ],
    });
    expect(status).toBe(201);

    const onDisk = await readConfigToml();
    expect(onDisk['models']).toMatchObject({
      'my-openai/gpt-4.1': {
        support_efforts: ['low', 'max'],
        adaptive_thinking: true,
      },
    });
  });

  it('rejects invalid create bodies with 40001', async () => {
    await boot();
    const cases: Array<{ name: string; body: unknown; path?: string }> = [
      {
        name: 'id with illegal characters',
        body: { ...CREATE_BODY, id: 'bad!id' },
        path: 'id',
      },
      { name: 'empty type', body: { ...CREATE_BODY, type: '' }, path: 'type' },
      {
        name: 'default_model outside the models list',
        body: { ...CREATE_BODY, default_model: 'gpt-5' },
        path: 'default_model',
      },
      {
        name: 'duplicate remote ids',
        body: {
          ...CREATE_BODY,
          models: [
            { remote_id: 'gpt-4.1', max_context_size: 1047576 },
            { remote_id: 'gpt-4.1', max_context_size: 128000 },
          ],
        },
        path: 'models',
      },
      {
        name: 'unknown field',
        body: { ...CREATE_BODY, models_v2: [] },
        path: '',
      },
    ];
    for (const { name, body, path } of cases) {
      const { body: envelope } = await postJson('/api/providers', body);
      expect(envelope.code, name).toBe(40001);
      expect(envelope.data, name).toBeNull();
      if (path !== undefined) {
        const details = envelope.details;
        expect(Array.isArray(details), name).toBe(true);
        expect(
          (details as Array<{ path: string }>).some((detail) => detail.path === path),
          name,
        ).toBe(true);
      }
    }
  });

  it('deletes a provider and its model aliases, keeping unrelated defaults', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { status, text } = await deleteJson<unknown>('/api/providers/openai');
    expect(status).toBe(204);
    expect(text).toBe('');

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toEqual({ kimi: { type: 'kimi', api_key: 'sk-test' } });
    expect(onDisk['models']).toEqual({
      k2: { provider: 'kimi', model: 'kimi-k2', max_context_size: 131072 },
    });
    expect(onDisk['default_model']).toBe('k2');

    const providers = await getJson<{ items: Array<{ id: string }> }>('/api/providers');
    expect(providers.body.data.items.map((p) => p.id)).toEqual(['kimi']);
    const models = await getJson<{ items: Array<{ id: string }> }>('/api/models');
    expect(models.body.data.items.map((m) => m.id)).toEqual(['k2']);
  });

  it('never touches default_provider/default_model when deleting their owner (204, pointers dangling)', async () => {
    await boot(DEFAULTED_TOML);
    const { status, text } = await deleteJson<unknown>('/api/providers/openai');
    expect(status).toBe(204);
    expect(text).toBe('');

    const onDisk = await readConfigToml();
    expect(onDisk['default_provider']).toBe('openai');
    expect(onDisk['default_model']).toBe('gpt4o');
    expect(onDisk['providers']).toEqual({ kimi: { type: 'kimi', api_key: 'sk-test' } });
    expect(onDisk['models']).toEqual({
      k2: { provider: 'kimi', model: 'kimi-k2', max_context_size: 131072 },
    });
  });

  it('round-trips a created provider: delete removes every trace from config.toml', async () => {
    await boot();
    const created = await postJson<unknown>('/api/providers', CREATE_BODY);
    expect(created.status).toBe(201);

    const { status } = await deleteJson<unknown>('/api/providers/my-openai');
    expect(status).toBe(204);

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toBeUndefined();
    expect(onDisk['models']).toBeUndefined();
    expect(onDisk['default_model']).toBe('my-openai/gpt-4.1');

    const providers = await getJson<{ items: unknown[] }>('/api/providers');
    expect(providers.body.data.items).toEqual([]);
  });

  it('rejects deleting an OAuth-managed provider with 40003 and leaves config unchanged', async () => {
    await boot(MANAGED_TOML);
    const before = await readConfigToml();
    const { body } = await deleteJson<unknown>('/api/providers/managed%3Akimi-code');
    expect(body?.code).toBe(40003);
    expect(body?.msg).toContain('/oauth/logout');
    expect(await readConfigToml()).toEqual(before);

    const providers = await getJson<{ items: Array<{ id: string }> }>('/api/providers');
    expect(providers.body.data.items.map((p) => p.id)).toEqual(['managed:kimi-code']);
  });

  it('maps an unknown provider id to 40412 on delete', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { body } = await deleteJson<unknown>('/api/providers/missing');
    expect(body?.code).toBe(40412);
  });

  it('patches a provider field while keeping the stored api_key and every model untouched', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { status, body } = await patchJson<{
      provider: Record<string, unknown>;
      revision: string;
    }>('/api/providers/openai', {
      base_url: 'https://api.openai.example/v2',
      default_model: 'gpt4o',
    });
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.provider).toEqual({
      id: 'openai',
      type: 'openai',
      base_url: 'https://api.openai.example/v2',
      default_model: 'gpt4o',
      has_api_key: true,
      status: 'connected',
      models: ['gpt4o'],
    });
    expect(typeof body.data.revision).toBe('string');

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toEqual({
      kimi: { type: 'kimi', api_key: 'sk-test' },
      openai: {
        type: 'openai',
        api_key: 'sk-openai',
        base_url: 'https://api.openai.example/v2',
        default_model: 'gpt4o',
      },
    });
    expect(onDisk['models']).toEqual({
      k2: { provider: 'kimi', model: 'kimi-k2', max_context_size: 131072 },
      gpt4o: { provider: 'openai', model: 'gpt-4o', max_context_size: 128000 },
    });
    expect(onDisk['default_model']).toBe('k2');
  });

  it('sets a new api_key when a non-empty one is sent', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { status, body } = await patchJson<{ provider: { has_api_key: boolean } }>(
      '/api/providers/openai',
      { api_key: 'sk-new-openai' },
    );
    expect(status).toBe(200);
    expect(body.data.provider.has_api_key).toBe(true);

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toMatchObject({
      openai: { type: 'openai', api_key: 'sk-new-openai' },
    });
  });

  it('clears the stored api_key when an empty string is sent', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { status, body } = await patchJson<{
      provider: { has_api_key: boolean; status: string };
    }>('/api/providers/openai', { api_key: '' });
    expect(status).toBe(200);
    expect(body.data.provider.has_api_key).toBe(false);
    expect(body.data.provider.status).toBe('unconfigured');

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toMatchObject({ openai: { type: 'openai' } });
    const stored = (onDisk['providers'] as Record<string, Record<string, unknown>>)['openai'];
    expect(stored).not.toHaveProperty('api_key');
  });

  it('preserves hidden and hand-added model fields on a display-name-only patch', async () => {
    const RICH_TOML = [
      '[providers.openai]',
      'type = "openai"',
      'api_key = "sk-openai"',
      '',
      '[models."openai/gpt-4o"]',
      'provider = "openai"',
      'model = "gpt-4o"',
      'max_context_size = 128000',
      'beta_api = true',
      'default_effort = "high"',
      'adaptive_thinking = true',
      'max_output_size = 32768',
      'vendor_specific = "keep-me"',
      '',
    ].join('\n');
    await boot(RICH_TOML);

    const read = await getJson<Record<string, unknown>>('/api/models/openai%2Fgpt-4o');
    expect(read.body.code).toBe(0);
    expect(read.body.data).toMatchObject({
      id: 'openai/gpt-4o',
      provider_id: 'openai',
      remote_id: 'gpt-4o',
      max_context_size: 128000,
      default_effort: 'high',
      adaptive_thinking: true,
      max_output_size: 32768,
    });

    const { status, body } = await patchJson<Record<string, unknown>>(
      '/api/models/openai%2Fgpt-4o',
      { display_name: 'GPT-4o' },
    );
    expect(status).toBe(200);
    expect(body.code).toBe(0);

    const onDisk = await readConfigToml();
    expect(onDisk['models']).toEqual({
      'openai/gpt-4o': {
        provider: 'openai',
        model: 'gpt-4o',
        max_context_size: 128000,
        beta_api: true,
        default_effort: 'high',
        adaptive_thinking: true,
        max_output_size: 32768,
        vendor_specific: 'keep-me',
        display_name: 'GPT-4o',
      },
    });
  });

  it('never touches the default pointer or other models when patching a provider type', async () => {
    await boot(DEFAULTED_TOML);
    const { status, body } = await patchJson<{ provider: Record<string, unknown> }>(
      '/api/providers/openai',
      { type: 'openai_responses' },
    );
    expect(status).toBe(200);
    expect(body.code).toBe(0);

    const onDisk = await readConfigToml();
    expect(onDisk['default_model']).toBe('gpt4o');
    expect(onDisk['default_provider']).toBe('openai');
    expect(onDisk['providers']).toEqual({
      kimi: { type: 'kimi', api_key: 'sk-test' },
      openai: {
        type: 'openai_responses',
        api_key: 'sk-openai',
      },
    });
    expect(onDisk['models']).toEqual({
      k2: { provider: 'kimi', model: 'kimi-k2', max_context_size: 131072 },
      gpt4o: { provider: 'openai', model: 'gpt-4o', max_context_size: 128000 },
    });
  });

  it('rejects invalid provider patches with 40001', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const before = await readConfigToml();
    const cases: Array<{ name: string; body: unknown; path?: string }> = [
      {
        name: 'model list',
        body: { models: [{ remote_id: 'gpt-4.1' }] },
        path: '',
      },
      { name: 'empty default_model', body: { default_model: '' }, path: 'default_model' },
      {
        name: 'default_model owned by another provider',
        body: { default_model: 'k2' },
        path: '',
      },
      { name: 'unknown field', body: { new_id: 'renamed' }, path: '' },
    ];
    for (const { name, body, path } of cases) {
      const { body: envelope } = await patchJson('/api/providers/openai', body);
      expect(envelope.code, name).toBe(40001);
      expect(envelope.data, name).toBeNull();
      if (path !== undefined && path !== '') {
        const details = envelope.details;
        expect(Array.isArray(details), name).toBe(true);
        expect(
          (details as Array<{ path: string }>).some((detail) => detail.path === path),
          name,
        ).toBe(true);
      }
    }

    const placeholder = await patchJson<unknown>('/api/providers/openai', {
      base_url: 'https://${HOST}/v1',
    });
    expect(placeholder.body.code).toBe(40001);
    expect(placeholder.body.msg).toContain('base_url');
    expect(await readConfigToml()).toEqual(before);
  });

  it('patches an OAuth-managed provider while preserving OAuth credentials and models', async () => {
    await boot(MANAGED_TOML);
    const requestIdentity = {
      preset: 'kimi_code',
      overrides: { client: { user_agent: 'kimi_code' } },
    } as const;
    const { status, body } = await patchJson<{ provider: Record<string, unknown> }>(
      '/api/providers/managed%3Akimi-code',
      {
        base_url: 'https://api.changed.example.test/v1',
        default_model: 'managed:kimi-code/kimi-k2',
        request_identity: requestIdentity,
      },
    );
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.provider).toMatchObject({
      id: 'managed:kimi-code',
      type: 'kimi',
      base_url: 'https://api.changed.example.test/v1',
      default_model: 'managed:kimi-code/kimi-k2',
      request_identity: requestIdentity,
      has_api_key: false,
      models: ['managed:kimi-code/kimi-k2'],
    });

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toEqual({
      'managed:kimi-code': {
        type: 'kimi',
        api_key: '',
        base_url: 'https://api.changed.example.test/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
        default_model: 'managed:kimi-code/kimi-k2',
        request_identity: requestIdentity,
      },
    });
    expect(onDisk['models']).toEqual({
      'managed:kimi-code/kimi-k2': {
        provider: 'managed:kimi-code',
        model: 'kimi-k2',
        max_context_size: 131072,
      },
    });

    const fetched = await getJson<{ request_identity?: unknown }>(
      '/api/providers/managed%3Akimi-code',
    );
    expect(fetched.body.data.request_identity).toEqual(requestIdentity);
  });

  it('saves unrelated fields of an unchanged colon provider id', async () => {
    const COLON_TOML = [
      '[providers."edge:gateway"]',
      'type = "openai"',
      'api_key = "sk-edge"',
      'base_url = "https://edge.example.test/v1"',
      '',
    ].join('\n');
    await boot(COLON_TOML);

    const { status, body } = await patchJson<{ provider: Record<string, unknown> }>(
      '/api/providers/edge%3Agateway',
      { base_url: 'https://edge.example.test/v2' },
    );
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.provider).toMatchObject({
      id: 'edge:gateway',
      base_url: 'https://edge.example.test/v2',
    });

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toEqual({
      'edge:gateway': {
        type: 'openai',
        api_key: 'sk-edge',
        base_url: 'https://edge.example.test/v2',
      },
    });
  });

  it('rejects changing an OAuth-managed provider type and leaves config unchanged', async () => {
    await boot(MANAGED_TOML);
    const before = await readConfigToml();
    const { body } = await patchJson<unknown>('/api/providers/managed%3Akimi-code', {
      type: 'openai',
    });
    expect(body.code).toBe(40003);
    expect(body.msg).toContain('/oauth/logout');
    expect(await readConfigToml()).toEqual(before);
  });

  it('rejects writing an OAuth-managed provider api_key and leaves config unchanged', async () => {
    await boot(MANAGED_TOML);
    const before = await readConfigToml();
    const { body } = await patchJson<unknown>('/api/providers/managed%3Akimi-code', {
      api_key: 'replacement-secret',
    });
    expect(body.code).toBe(40003);
    expect(body.msg).toContain('/oauth/logout');
    expect(await readConfigToml()).toEqual(before);
  });

  it('maps an unknown provider id to 40412 on patch', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { body } = await patchJson<unknown>('/api/providers/missing', { type: 'openai' });
    expect(body.code).toBe(40412);
    expect(body.data).toBeNull();
  });

  it('clears provider base_url/default_model with an explicit null', async () => {
    const FULL_TOML = [
      '[providers.openai]',
      'type = "openai"',
      'api_key = "sk-openai"',
      'base_url = "https://api.openai.example/v1"',
      'default_model = "openai/gpt-4.1"',
      'custom_headers = { "X-Org" = "acme" }',
      '',
      '[models."openai/gpt-4.1"]',
      'provider = "openai"',
      'model = "gpt-4.1"',
      'max_context_size = 1047576',
      'display_name = "GPT-4.1"',
      'capabilities = ["tool_use"]',
      '',
    ].join('\n');
    await boot(FULL_TOML);
    const { status } = await patchJson<unknown>('/api/providers/openai', {
      base_url: null,
      default_model: null,
    });
    expect(status).toBe(200);

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toEqual({
      openai: {
        type: 'openai',
        api_key: 'sk-openai',
        custom_headers: { 'X-Org': 'acme' },
      },
    });
    expect(onDisk['models']).toEqual({
      'openai/gpt-4.1': {
        provider: 'openai',
        model: 'gpt-4.1',
        max_context_size: 1047576,
        display_name: 'GPT-4.1',
        capabilities: ['tool_use'],
      },
    });

    const single = await getJson<Record<string, unknown>>('/api/providers/openai');
    expect(single.body.data).not.toHaveProperty('base_url');
    expect(single.body.data).not.toHaveProperty('default_model');
  });

  it('never reveals a stored api_key on provider reads', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const withKey = await getJson<Record<string, unknown>>('/api/providers/openai');
    expect(withKey.body.code).toBe(0);
    expect(withKey.body.data).not.toHaveProperty('api_key');
    expect(withKey.body.data?.['has_api_key']).toBe(true);

    await patchJson<unknown>('/api/providers/openai', { api_key: '' });
    const cleared = await getJson<Record<string, unknown>>('/api/providers/openai');
    expect(cleared.body.data).not.toHaveProperty('api_key');

    const list = await getJson<{ items: Array<Record<string, unknown>> }>('/api/providers');
    for (const item of list.body.data.items) {
      expect(item).not.toHaveProperty('api_key');
    }
  });

  it('rejects a base_url containing an env placeholder with 40001', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const created = await postJson<unknown>('/api/providers', {
      ...CREATE_BODY,
      base_url: 'https://${HOST}/v1',
    });
    expect(created.body.code).toBe(40001);
    expect(created.body.msg).toContain('base_url');

    const patched = await patchJson<unknown>('/api/providers/openai', {
      base_url: 'https://${HOST}/v1',
    });
    expect(patched.body.code).toBe(40001);
    expect(patched.body.msg).toContain('base_url');
  });

  it('trims a padded base_url before persisting', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { status, body } = await postJson<{ base_url?: string }>('/api/providers', {
      ...CREATE_BODY,
      base_url: '  https://api.openai.example/v1  ',
    });
    expect(status).toBe(201);
    expect(body.data.base_url).toBe('https://api.openai.example/v1');

    await patchJson('/api/providers/openai', { base_url: '  https://api.openai.example/v3  ' });
    expect((await readConfigToml())['providers']).toMatchObject({
      openai: { base_url: 'https://api.openai.example/v3' },
    });
  });
});

describe('server-v2 /api entity-level model editing', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-model-entity-'));
    process.env['KIKI_MODEL_CATALOG_REFRESH_ON_START'] = '0';
    process.env['KIKI_MODEL_CATALOG_REFRESH_INTERVAL_MS'] = '0';
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
    delete process.env['KIKI_MODEL_CATALOG_REFRESH_ON_START'];
    delete process.env['KIKI_MODEL_CATALOG_REFRESH_INTERVAL_MS'];
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

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: authHeaders(
        server as RunningServer,
        body === undefined ? {} : { 'content-type': 'application/json' },
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
    } as never);
    const text = await res.text();
    return {
      status: res.status,
      body: (text.length === 0 ? {} : JSON.parse(text)) as Envelope<T>,
    };
  }

  async function readConfigToml(): Promise<Record<string, unknown>> {
    const text = await readFile(join(home as string, 'config.toml'), 'utf-8');
    return parseToml(text) as Record<string, unknown>;
  }

  it('keeps a local alias and its remote target intact when only the display name changes', async () => {
    await boot(ALIAS_TOML);

    const before = await request<Record<string, unknown>>('GET', '/api/models/fast');
    expect(before.body.code).toBe(0);
    expect(before.body.data).toMatchObject({
      id: 'fast',
      provider_id: 'edge',
      provider_source: 'provider',
      remote_id: 'vendor/model:v1',
      display_name: 'Fast',
      max_context_size: 200000,
      revision: expect.any(String) as unknown as string,
    });

    const patched = await request<Record<string, unknown>>('PATCH', '/api/models/fast', {
      display_name: 'Fast (renamed)',
      base_revision: before.body.data?.['revision'] as string,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({
      id: 'fast',
      provider_id: 'edge',
      remote_id: 'vendor/model:v1',
      display_name: 'Fast (renamed)',
      max_context_size: 200000,
      issues: [],
    });

    const onDisk = await readConfigToml();
    const models = onDisk['models'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(models).toSorted()).toEqual(['daily', 'fast']);
    expect(models['fast']).toEqual({
      provider: 'edge',
      model: 'vendor/model:v1',
      max_context_size: 200000,
      display_name: 'Fast (renamed)',
    });
    expect(models['daily']).toMatchObject({
      provider: 'edge',
      model: 'vendor/model:v1',
      display_name: 'Daily',
    });
    expect(onDisk['default_model']).toBe('fast');

    const list = await request<{ items: Array<Record<string, unknown>> }>('GET', '/api/models');
    expect(list.body.data.items.find((item) => item['id'] === 'fast')).toMatchObject({
      id: 'fast',
      provider_id: 'edge',
      remote_id: 'vendor/model:v1',
    });
  });

  it('round-trips the real managed:kimi-code / kimi-code/... shape without damaging it', async () => {
    await boot(REAL_MANAGED_TOML);
    const before = await readConfigToml();

    const read = await request<Record<string, unknown>>('GET', '/api/models/kimi-code%2Fkimi-k2');
    expect(read.body.code).toBe(0);
    expect(read.body.data).toMatchObject({
      id: 'kimi-code/kimi-k2',
      provider_id: 'managed:kimi-code',
      remote_id: 'kimi-k2',
      display_name: 'Kimi K2',
      max_context_size: 262144,
      protocol: 'anthropic',
      adaptive_thinking: true,
    });

    const patched = await request<Record<string, unknown>>('PATCH', '/api/models/kimi-code%2Fkimi-k2', {
      display_name: 'K2 (mine)',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({
      id: 'kimi-code/kimi-k2',
      provider_id: 'managed:kimi-code',
      remote_id: 'kimi-k2',
      display_name: 'K2 (mine)',
    });

    const after = await readConfigToml();
    expect(after['providers']).toEqual(before['providers']);
    expect(after['default_model']).toBe('kimi-code/kimi-k2');
    const models = after['models'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(models).toSorted()).toEqual([
      'kimi-code/kimi-k2',
      'kimi-code/kimi-k2-thinking',
    ]);
    expect(models['kimi-code/kimi-k2']).toEqual({
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      max_context_size: 262144,
      capabilities: ['thinking'],
      protocol: 'anthropic',
      beta_api: true,
      adaptive_thinking: true,
      display_name: 'K2 (mine)',
    });
    expect(models['kimi-code/kimi-k2-thinking']).toMatchObject({
      provider: 'managed:kimi-code',
      model: 'kimi-k2-thinking',
    });

    const providers = await request<{ items: Array<Record<string, unknown>> }>('GET', '/api/providers');
    const managed = providers.body.data.items.find((item) => item['id'] === 'managed:kimi-code');
    expect(managed).toMatchObject({
      default_model: 'kimi-code/kimi-k2',
      models: ['kimi-code/kimi-k2', 'kimi-code/kimi-k2-thinking'],
    });
  });

  it('saves multiple local aliases of one remote model independently', async () => {
    await boot(ALIAS_TOML);
    const daily = await request<Record<string, unknown>>('GET', '/api/models/daily');
    await request<unknown>('PATCH', '/api/models/daily', {
      display_name: 'Daily driver',
      max_context_size: 100000,
      base_revision: daily.body.data?.['revision'] as string,
    });

    const models = (await readConfigToml())['models'] as Record<string, Record<string, unknown>>;
    expect(models['daily']).toEqual({
      provider: 'edge',
      model: 'vendor/model:v1',
      max_context_size: 100000,
      display_name: 'Daily driver',
    });
    expect(models['fast']).toMatchObject({ max_context_size: 200000, display_name: 'Fast' });

    const list = await request<{ items: Array<Record<string, unknown>> }>('GET', '/api/models');
    expect(
      list.body.data.items
        .filter((item) => item['remote_id'] === 'vendor/model:v1')
        .map((item) => item['id'])
        .toSorted(),
    ).toEqual(['daily', 'fast']);

    const removed = await request<unknown>('DELETE', '/api/models/daily');
    expect(removed.status).toBe(204);
    const after = (await readConfigToml())['models'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(after)).toEqual(['fast']);
    expect(after['fast']).toMatchObject({ model: 'vendor/model:v1' });
  });

  it('creates a new alias with an explicit local id when the suggested alias is taken', async () => {
    await boot(ALIAS_TOML);
    const suggested = await request<Record<string, unknown>>('POST', '/api/models', {
      provider_id: 'edge',
      remote_id: 'vendor/model:v2',
      max_context_size: 100000,
    });
    expect(suggested.status).toBe(201);
    expect(suggested.body.data).toMatchObject({
      id: 'edge/vendor/model:v2',
      provider_id: 'edge',
      remote_id: 'vendor/model:v2',
    });

    const explicit = await request<Record<string, unknown>>('POST', '/api/models', {
      id: 'edge/alt',
      provider_id: 'edge',
      remote_id: 'vendor/model:v3',
      max_context_size: 100000,
    });
    expect(explicit.status).toBe(201);
    expect(explicit.body.data).toMatchObject({ id: 'edge/alt', remote_id: 'vendor/model:v3' });

    const conflict = await request<unknown>('POST', '/api/models', {
      id: 'fast',
      provider_id: 'edge',
      remote_id: 'vendor/model:v9',
      max_context_size: 100000,
    });
    expect(conflict.body.code).toBe(40942);

    const unknownProvider = await request<unknown>('POST', '/api/models', {
      provider_id: 'nope',
      remote_id: 'vendor/model:v9',
    });
    expect(unknownProvider.body.code).toBe(40412);
  });

  it('returns a structured revision conflict instead of overwriting a concurrent edit', async () => {
    await boot(ALIAS_TOML);
    const read = await request<Record<string, unknown>>('GET', '/api/models/fast');
    const revision = read.body.data?.['revision'] as string;

    const first = await request<Record<string, unknown>>('PATCH', '/api/models/fast', {
      display_name: 'first writer',
      base_revision: revision,
    });
    expect(first.status).toBe(200);

    const second = await request<Record<string, unknown>>('PATCH', '/api/models/fast', {
      display_name: 'second writer',
      base_revision: revision,
    });
    expect(second.body.code).toBe(40941);
    expect(second.body.data).toBeNull();
    expect(second.body.details).toMatchObject({
      entity: 'model',
      id: 'fast',
      expected_revision: revision,
      actual_revision: expect.any(String) as unknown as string,
      current: { id: 'fast', display_name: 'first writer' },
    });

    const models = (await readConfigToml())['models'] as Record<string, Record<string, unknown>>;
    expect(models['fast']).toMatchObject({
      display_name: 'first writer',
      max_context_size: 200000,
    });

    const replayed = await request<Record<string, unknown>>('PATCH', '/api/models/fast', {
      display_name: 'first writer',
      base_revision: revision,
    });
    expect(replayed.status).toBe(200);

    const staleProvider = await request<Record<string, unknown>>('PATCH', '/api/providers/edge', {
      base_url: 'https://edge.example.test/v2',
      base_revision: 'not-the-current-revision',
    });
    expect(staleProvider.body.code).toBe(40941);
    expect(staleProvider.body.details).toMatchObject({
      entity: 'provider',
      id: 'edge',
      expected_revision: 'not-the-current-revision',
    });
    const providers = (await readConfigToml())['providers'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(providers['edge']).toMatchObject({ base_url: 'https://edge.example.test/v1' });
  });

  it('reports model issues instead of fabricating a runnable model', async () => {
    const BROKEN_TOML = [
      '[providers.edge]',
      'type = "openai"',
      '',
      '[models."edge/incomplete"]',
      'provider = "edge"',
      'model = "vendor/model:v1"',
      '',
      '[models."edge/ghost"]',
      'provider = "missing"',
      'model = "vendor/model:v1"',
      'max_context_size = 1000',
      '',
    ].join('\n');
    await boot(BROKEN_TOML);

    const incomplete = await request<Record<string, unknown>>('GET', '/api/models/edge%2Fincomplete');
    expect(incomplete.body.data?.['max_context_size']).toBeUndefined();
    expect(incomplete.body.data?.['issues']).toEqual([
      expect.objectContaining({
        code: 'model.max_context_size_missing',
        severity: 'warning',
        path: 'max_context_size',
      }),
    ]);

    const ghost = await request<Record<string, unknown>>('GET', '/api/models/edge%2Fghost');
    expect(ghost.body.data?.['issues']).toEqual([
      expect.objectContaining({ code: 'model.provider_missing', severity: 'error' }),
    ]);

    const missing = await request<unknown>('GET', '/api/models/nope');
    expect(missing.body.code).toBe(40413);

    const unknownPatch = await request<unknown>('PATCH', '/api/models/nope', {
      display_name: 'x',
    });
    expect(unknownPatch.body.code).toBe(40413);

    const unknownDelete = await request<unknown>('DELETE', '/api/models/nope');
    expect(unknownDelete.body.code).toBe(40413);

    const badPatch = await request<unknown>('PATCH', '/api/models/edge%2Fincomplete', {
      max_context_size: 0,
    });
    expect(badPatch.body.code).toBe(40001);
  });

  it('renames the remote target only when explicitly asked and clears fields with null', async () => {
    await boot(ALIAS_TOML);
    const patched = await request<Record<string, unknown>>('PATCH', '/api/models/fast', {
      remote_id: 'vendor/model:v2',
      max_context_size: null,
      capabilities: ['thinking', 'tool_use'],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({
      remote_id: 'vendor/model:v2',
      capabilities: ['thinking', 'tool_use'],
    });
    expect(patched.body.data?.['max_context_size']).toBeUndefined();

    const models = (await readConfigToml())['models'] as Record<string, Record<string, unknown>>;
    expect(models['fast']).toEqual({
      provider: 'edge',
      model: 'vendor/model:v2',
      display_name: 'Fast',
      capabilities: ['thinking', 'tool_use'],
    });
  });
});
