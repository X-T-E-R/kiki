import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IConfigService,
  IKosongConfigService,
  IModelCatalog,
  IOAuthService,
  IProviderDiscoveryService,
  type IModelCatalog as IModelCatalogType,
  type IOAuthService as IOAuthServiceType,
  type IProviderDiscoveryService as IProviderDiscoveryServiceType,
  type ScopeSeed,
} from '@kiki/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerModelCatalogRoutes } from '../src/routes/modelCatalog';
import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

const CATALOG_TOML = [
  'default_model = "k2"',
  '',
  '[providers.kimi]',
  'type = "kimi"',
  'api_key = "sk-test"',
  'base_url = "https://api.example.test/v1"',
  '',
  '[providers.kimi.request_identity.overrides.client]',
  'user_agent = "host"',
  '',
  '[providers.openai]',
  'type = "openai"',
  '',
  '[models.k2]',
  'provider = "kimi"',
  'model = "kimi-k2"',
  'max_context_size = 131072',
  'display_name = "Kimi K2"',
  'capabilities = ["thinking"]',
  '',
  '[models.k2.request_identity.overrides.request]',
  'logical_id = "none"',
  '',
  '[models.turbo]',
  'provider = "kimi"',
  'model = "kimi-turbo"',
  'max_context_size = 32768',
  'display_name = "Kimi Turbo"',
  '',
  '[models.gpt4o]',
  'provider = "openai"',
  'model = "gpt-4o"',
  'max_context_size = 128000',
  '',
].join('\n');

describe('server-v2 /api model/provider catalog', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-model-catalog-'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      home = undefined;
    }
  });

  async function boot(toml?: string, seeds?: ScopeSeed): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    }
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds,
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

  it('reads referenced complete bodies and explicitly saves inline through REST CAS without changing author files', async () => {
    const { modelEntitySchema } = await import('@kiki/protocol');
    const a = '  author A\n原文\n'; const b = 'author B\n';
    await writeFile(join(home!, 'a.md'), a); await writeFile(join(home!, 'b.md'), b);
    await boot(`${CATALOG_TOML}\n[models.k2.cognition]\noverlay=["a.md","b.md"]\nsteering={text="saved cue"}\nmain="same"\nindependent="off"\n`);
    const path = '/api/models/k2';
    const original = modelEntitySchema.parse((await getJson(path)).body.data);
    expect(original.cognition_bodies?.branches.common.slots.overlay).toMatchObject({ channel: 'cognition_overlay', source: 'files', text: 'author A\n原文\n\nauthor B', files: [{ path: 'a.md', text: a }, { path: 'b.md', text: b }], writable: true, source_read_only: true });
    const patch = async (body: unknown) => {
      const response = await fetch(`${base}${path}`, { method: 'PATCH', headers: authHeaders(server!, { 'content-type': 'application/json' }), body: JSON.stringify(body) } as never);
      return await response.json() as Envelope<unknown>;
    };
    const text = '  user EDIT\n完整多行正文\n';
    const saved = await patch({ base_revision: original.revision, cognition: { ...original.cognition, overlay: { text } } });
    expect(saved.code).toBe(0);
    const edited = modelEntitySchema.parse(saved.data);
    expect(edited.cognition_bodies?.branches.main.slots.overlay).toMatchObject({ source: 'inline', text });
    expect(edited.cognition?.steering).toEqual({ text: 'saved cue' });
    expect(await readFile(join(home!, 'a.md'), 'utf8')).toBe(a); expect(await readFile(join(home!, 'b.md'), 'utf8')).toBe(b);
    const committed = await readFile(join(home!, 'config.toml'), 'utf8');
    expect((await patch({ base_revision: original.revision, cognition: { overlay: { text: 'stale' } } })).code).not.toBe(0);
    expect((await patch({ cognition: { overlay: { text: 'no revision' } } })).code).not.toBe(0);
    expect((await patch({ base_revision: edited.revision, cognition: { overlay: '../outside.md' } })).code).not.toBe(0);
    expect((await patch({ base_revision: edited.revision, cognition: { overlay: { text: 'invalid', file: '/outside' } } })).code).not.toBe(0);
    expect(await readFile(join(home!, 'config.toml'), 'utf8')).toBe(committed);
    await server!.close(); server = undefined; await boot();
    const reloaded = modelEntitySchema.parse((await getJson(path)).body.data);
    expect(reloaded.cognition_bodies?.branches.common.slots.overlay.text).toBe(text);
    expect(reloaded.cognition_bodies?.branches.independent.selection).toBe('off');
    expect(await readFile(join(home!, 'a.md'), 'utf8')).toBe(a);
  });

  it('isolates same-name and same-remote models by full entity id through read, save, runtime cache and restart', async () => {
    await boot(CATALOG_TOML);
    const firstId = 'kimi/shared-model';
    const secondId = 'openai/shared-model';
    for (const [id, provider_id, max_context_size, max_input_size] of [
      [firstId, 'kimi', 400_000, 529_400],
      [secondId, 'openai', 800_000, 600_000],
    ] as const) {
      const created = await postJson<Record<string, unknown>>('/api/models', {
        id, provider_id, remote_id: 'shared-model', display_name: 'Shared Model',
        pricing_model: 'shared-canonical', max_context_size, max_input_size,
      });
      expect(created.body.code).toBe(0);
      expect(created.body.data).toMatchObject({ id, provider_id, max_context_size, max_input_size });
    }
    const firstPath = `/api/models/${encodeURIComponent(firstId)}`;
    const secondPath = `/api/models/${encodeURIComponent(secondId)}`;
    const first = (await getJson<Record<string, unknown>>(firstPath)).body.data;
    const second = (await getJson<Record<string, unknown>>(secondPath)).body.data;
    expect(first).toMatchObject({ id: firstId, max_context_size: 400_000, max_input_size: 529_400 });
    expect(second).toMatchObject({ id: secondId, max_context_size: 800_000, max_input_size: 600_000 });
    expect(typeof first['revision']).toBe('string');
    const catalog = server!.core.accessor.get(IModelCatalog);
    expect(catalog.get(firstId)).toMatchObject({ id: firstId, maxContextSize: 400_000, maxInputSize: 400_000 });
    expect(catalog.get(secondId)).toMatchObject({ id: secondId, maxContextSize: 800_000, maxInputSize: 600_000 });
    expect(catalog.get(firstId)).not.toBe(catalog.get(secondId));
    const response = await fetch(`${base}${firstPath}`, {
      method: 'PATCH',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ base_revision: first['revision'], max_context_size: 300_000, auto_compact: 200_000 }),
    } as never);
    const saved = await response.json() as Envelope<Record<string, unknown>>;
    expect(saved.code).toBe(0);
    expect(saved.data).toMatchObject({ id: firstId, max_context_size: 300_000, max_input_size: 529_400, auto_compact: 200_000 });
    expect((await getJson<Record<string, unknown>>(firstPath)).body.data).toEqual(saved.data);
    expect((await getJson<Record<string, unknown>>(secondPath)).body.data).toEqual(second);
    expect(catalog.get(firstId)).toMatchObject({ id: firstId, maxContextSize: 300_000, maxInputSize: 300_000, autoCompact: 200_000 });
    expect(catalog.get(secondId)).toMatchObject({ id: secondId, maxContextSize: 800_000, maxInputSize: 600_000, autoCompact: undefined });
    await server!.close();
    server = undefined;
    await boot();
    expect((await getJson<Record<string, unknown>>(firstPath)).body.data).toMatchObject({ id: firstId, max_context_size: 300_000, max_input_size: 529_400, auto_compact: 200_000 });
    expect((await getJson<Record<string, unknown>>(secondPath)).body.data).toEqual(second);
  });

  it('creates, projects, persists and explicitly clears the pricing model independently of the wire id', async () => {
    await boot(CATALOG_TOML);
    const created = await postJson('/api/models', { id: 'priced-alias', provider_id: 'kimi',
      remote_id: 'remote-new', max_context_size: 128000, pricing_model: 'canonical-price' });
    expect(created.body.code).toBe(0);
    expect(created.body.data).toMatchObject({ remote_id: 'remote-new', pricing_model: 'canonical-price' });
    expect((await getJson('/api/models/priced-alias')).body.data).toMatchObject({ pricing_model: 'canonical-price' });
    expect(await readFile(join(home!, 'config.toml'), 'utf8')).toContain('pricing_model = "canonical-price"');
    const cleared = await fetch(`${base}/api/models/priced-alias`, { method: 'PATCH',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ pricing_model: null }),
    } as never);
    const response = await cleared.json() as Envelope<Record<string, unknown>>;
    expect(response.code).toBe(0);
    expect(response.data['pricing_model']).toBeUndefined();
    expect(response.data['remote_id']).toBe('remote-new');
  });

  it('waits for Kosong hydration before listing models and providers', async () => {
    let hydrated = false;
    let releaseHydration!: () => void;
    const hydration = new Promise<void>((resolve) => {
      releaseHydration = () => {
        hydrated = true;
        resolve();
      };
    });
    const models = [{ provider: 'kimi', model: 'k2' }];
    const providers = [{ id: 'kimi', type: 'kimi' }];
    const catalog = {
      _serviceBrand: undefined,
      get: () => undefined,
      getRequester: () => undefined,
      inspect: () => undefined,
      ping: async () => undefined,
      findByName: () => [],
      listModels: vi.fn(async () => (hydrated ? models : [])),
      listProviders: vi.fn(async () => (hydrated ? providers : [])),
      getProvider: async () => undefined,
      setDefaultModel: async () => undefined,
    } as unknown as IModelCatalogType;
    const config = { ready: Promise.resolve() };
    const kosongConfig = { ready: hydration };
    const core = {
      accessor: {
        get(token: unknown): unknown {
          if (token === IConfigService) return config;
          if (token === IKosongConfigService) return kosongConfig;
          if (token === IModelCatalog) return catalog;
          throw new Error('unexpected service');
        },
      },
    };
    type RouteHandler = (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void;
    const handlers = new Map<string, RouteHandler>();
    const app = {
      get(path: string, _options: unknown, handler: RouteHandler): void {
        handlers.set(`GET ${path}`, handler);
      },
      post(): void {},
      patch(): void {},
      delete(): void {},
    };
    registerModelCatalogRoutes(app, core as never);

    const modelsReply = { send: vi.fn() };
    const providersReply = { send: vi.fn() };
    const modelsRequest = handlers.get('GET /models');
    const providersRequest = handlers.get('GET /providers');
    if (modelsRequest === undefined || providersRequest === undefined) {
      throw new Error('catalog list routes were not registered');
    }
    let modelsSettled = false;
    let providersSettled = false;
    const modelsPending = Promise.resolve(
      modelsRequest({ id: 'models', params: {} }, modelsReply),
    ).then(() => {
      modelsSettled = true;
    });
    const providersPending = Promise.resolve(
      providersRequest({ id: 'providers', params: {} }, providersReply),
    ).then(() => {
      providersSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(modelsSettled).toBe(false);
    expect(providersSettled).toBe(false);
    expect(catalog.listModels).not.toHaveBeenCalled();
    expect(catalog.listProviders).not.toHaveBeenCalled();

    releaseHydration();
    await Promise.all([modelsPending, providersPending]);
    expect(catalog.listModels).toHaveBeenCalledOnce();
    expect(catalog.listProviders).toHaveBeenCalledOnce();
    expect(modelsReply.send).toHaveBeenCalledWith({
      code: 0,
      msg: 'success',
      data: { items: models },
      request_id: 'models',
    });
    expect(providersReply.send).toHaveBeenCalledWith({
      code: 0,
      msg: 'success',
      data: { items: providers },
      request_id: 'providers',
    });
  });

  it('tests a saved provider and reads only the latest sanitized persisted result', async () => {
    await boot(CATALOG_TOML);
    const ping = vi.spyOn(server!.core.accessor.get(IModelCatalog), 'ping').mockResolvedValue({
      ok: false, durationMs: 11, errorCode: 'provider.auth', httpStatus: 401,
      error: 'sk-sensitive leaked upstream',
    });
    const first = await getJson<{ items: unknown[] }>('/api/providers:health');
    expect(first.body.data.items).toEqual([]);
    const tested = await postJson<{ provider_id: string; model_id: string; error: string; ok: boolean }>('/api/providers/kimi:test');
    expect(tested.body.code).toBe(0);
    expect(tested.body.data).toMatchObject({ provider_id: 'kimi', model_id: 'k2', ok: false,
      error: 'The test request failed (HTTP 401).' });
    expect(ping).toHaveBeenCalledOnce();
    expect(ping).toHaveBeenCalledWith('k2');
    expect(JSON.stringify(tested.body)).not.toContain('sk-sensitive');
    const latest = await getJson<{ items: unknown[] }>('/api/providers:health');
    expect(latest.body.data.items).toEqual([tested.body.data]);
    await server!.close();
    server = undefined;
    await boot();
    const afterRestart = await getJson<{ items: unknown[] }>('/api/providers:health');
    expect(afterRestart.body.data.items).toEqual([tested.body.data]);
    const rejected = await postJson<unknown>('/api/providers/kimi:test', { api_key: 'sk-request-only' });
    expect(rejected.body.code).toBe(40001);
    expect(ping).toHaveBeenCalledOnce();
  });

  it('lists configured models as selectable aliases', async () => {
    await boot(CATALOG_TOML);
    const { status, body } = await getJson<{ items: unknown[] }>('/api/models');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([
      {
        id: 'k2',
        provider_id: 'kimi',
        remote_id: 'kimi-k2',
        display_name: 'Kimi K2',
        max_context_size: 131072,
        capabilities: ['thinking'],
        effective_capabilities: ['thinking'],
        request_identity: { overrides: { request: { logical_id: 'none' } } },
      },
      {
        id: 'turbo',
        provider_id: 'kimi',
        remote_id: 'kimi-turbo',
        display_name: 'Kimi Turbo',
        max_context_size: 32768,
      },
      {
        id: 'gpt4o',
        provider_id: 'openai',
        remote_id: 'gpt-4o',
        display_name: 'gpt-4o',
        max_context_size: 128000,
        effective_capabilities: ['image_in', 'tool_use'],
      },
    ]);
  });

  it('lists runtime-effective capabilities without changing declared capabilities', async () => {
    await boot([
      '[providers.openai]',
      'type = "openai"',
      '',
      '[models.vision]',
      'provider = "openai"',
      'model = "gpt-4o"',
      'max_context_size = 128000',
      '',
      '[models.text]',
      'provider = "openai"',
      'model = "gpt-3.5-turbo"',
      'max_context_size = 16384',
      'capabilities = ["tool_use"]',
    ].join('\n'));
    const { status, body } = await getJson<{
      items: Array<{
        id: string;
        capabilities?: string[];
        effective_capabilities?: string[];
      }>;
    }>('/api/models');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    const vision = body.data.items.find((item) => item.id === 'vision');
    const text = body.data.items.find((item) => item.id === 'text');
    expect(vision?.capabilities).toBeUndefined();
    expect(vision?.effective_capabilities).toContain('image_in');
    expect(text?.capabilities).toEqual(['tool_use']);
    expect(text?.effective_capabilities).not.toContain('image_in');
  });

  it('lists models without refreshing providers', async () => {
    const refreshProviderModels = vi.fn(async () => ({
      changed: [],
      unchanged: [],
      failed: [],
    }));
    const seeds = [
      [IModelCatalog, catalogStub()],
      [IProviderDiscoveryService, discoveryStub(refreshProviderModels)],
    ] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const { status, body } = await getJson<{ items: unknown[] }>('/api/models');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
    expect(refreshProviderModels).not.toHaveBeenCalled();
  });

  it('lists providers and returns a single provider by id', async () => {
    await boot(CATALOG_TOML);
    const list = await getJson<{ items: unknown[] }>('/api/providers');
    expect(list.body.code).toBe(0);
    expect(list.body.data.items).toEqual([
      {
        id: 'kimi',
        type: 'kimi',
        base_url: 'https://api.example.test/v1',
        default_model: 'k2',
        request_identity: { overrides: { client: { user_agent: 'host' } } },
        has_api_key: true,
        status: 'connected',
        models: ['k2', 'turbo'],
      },
      {
        id: 'openai',
        type: 'openai',
        has_api_key: false,
        status: 'unconfigured',
        models: ['gpt4o'],
      },
    ]);

    const single = await getJson<Record<string, unknown>>('/api/providers/kimi');
    expect(single.body.code).toBe(0);
    expect(single.body.data).toMatchObject({
      id: 'kimi',
      type: 'kimi',
      base_url: 'https://api.example.test/v1',
      default_model: 'k2',
      request_identity: { overrides: { client: { user_agent: 'host' } } },
      has_api_key: true,
      status: 'connected',
      models: ['k2', 'turbo'],
    });
    expect(single.body.data).not.toHaveProperty('api_key');
    expect(JSON.stringify(list.body)).not.toContain('sk-test');
    expect(typeof single.body.data?.['revision']).toBe('string');

    const noKey = await getJson<Record<string, unknown>>('/api/providers/openai');
    expect(noKey.body.code).toBe(0);
    expect(noKey.body.data).not.toHaveProperty('api_key');
  });

  it('returns only the declared environment variable name for env-backed provider keys', async () => {
    await boot([
      '[providers.kimi]',
      'type = "kimi"',
      '',
      '[providers.kimi.env]',
      'KIMI_API_KEY = "sk-env-only"',
    ].join('\n'));
    const single = await getJson<Record<string, unknown>>('/api/providers/kimi');
    expect(single.body.data).toMatchObject({ api_key_env: 'KIMI_API_KEY', has_api_key: true });
    expect(single.body.data).not.toHaveProperty('api_key');
    const config = await getJson<{ providers: Record<string, Record<string, unknown>> }>('/api/config');
    expect(config.body.data.providers['kimi']).toMatchObject({ api_key_env: 'KIMI_API_KEY', has_api_key: true });
    expect(config.body.data.providers['kimi']).not.toHaveProperty('api_key');
  });

  it('reports a declared process environment key as an env source across both read projections', async () => {
    vi.stubEnv('KIMI_API_KEY', 'sk-shell-only');
    await boot('[providers.kimi]\ntype = "kimi"\n');
    const single = await getJson<Record<string, unknown>>('/api/providers/kimi');
    expect(single.body.data).toMatchObject({ api_key_env: 'KIMI_API_KEY', has_api_key: true });
    expect(single.body.data).not.toHaveProperty('api_key');
    const config = await getJson<{ providers: Record<string, Record<string, unknown>> }>('/api/config');
    expect(config.body.data.providers['kimi']).toMatchObject({ api_key_env: 'KIMI_API_KEY', has_api_key: true });
    expect(config.body.data.providers['kimi']).not.toHaveProperty('api_key');
    vi.unstubAllEnvs();
  });

  it('sets the global default model and reflects it in /auth', async () => {
    await boot(CATALOG_TOML);
    const { body } = await postJson<unknown>('/api/models/turbo:set_default', {});
    expect(body.code).toBe(0);
    expect(body.data).toEqual({
      default_model: 'turbo',
      model: {
        id: 'turbo',
        provider_id: 'kimi',
        remote_id: 'kimi-turbo',
        display_name: 'Kimi Turbo',
        max_context_size: 32768,
      },
    });

    const auth = await getJson<{ default_model: string | null }>('/api/auth');
    expect(auth.body.code).toBe(0);
    expect(auth.body.data.default_model).toBe('turbo');
  });

  it('maps unknown provider and model ids to catalog not-found codes', async () => {
    await boot(CATALOG_TOML);
    const provider = await getJson<unknown>('/api/providers/missing');
    expect(provider.body.code).toBe(40412);

    const model = await postJson<unknown>('/api/models/missing:set_default', {});
    expect(model.body.code).toBe(40413);
  });

  it('returns an empty refresh result through the catalog route', async () => {
    await boot(CATALOG_TOML);
    const { status, body } = await postJson<{
      changed: unknown[];
      unchanged: unknown[];
      failed: unknown[];
    }>('/api/providers:refresh_oauth', {});
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ changed: [], unchanged: [], failed: [] });
  });

  it('probes unsaved provider drafts with structured failures and never persists them', async () => {
    await boot(CATALOG_TOML);
    const before = await readFile(join(home!, 'config.toml'), 'utf8');
    const originalFetch = globalThis.fetch;
    const hrefOf = (input: Parameters<typeof fetch>[0]): string =>
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const providerFetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const href = hrefOf(input);
      if (!href.startsWith('https://draft.example.test/')) return originalFetch(input, init);
      expect(href).toBe('https://draft.example.test/v1/models');
      const credential = new Headers(init?.headers).get('Authorization');
      if (credential === 'Bearer draft-success') return Response.json({ data: [{ id: 'new-model' }] });
      if (credential === 'Bearer draft-401') return Response.json({ error: 'draft-401' }, { status: 401 });
      if (credential === 'Bearer draft-404') return new Response('missing', { status: 404 });
      throw new TypeError('draft-network credential echoed');
    });
    vi.stubGlobal('fetch', providerFetch);
    const draft = { type: 'openai', base_url: 'https://draft.example.test/v1', api_key: 'draft-success' };
    const success = await postJson<unknown>('/api/providers:probe', draft);
    expect(success.status).toBe(200);
    expect(success.body.code).toBe(0);
    expect(success.body.data).toEqual({ ok: true, models: ['new-model'] });
    const unauthorized = await postJson<unknown>('/api/providers:probe', { ...draft, api_key: 'draft-401' });
    expect(unauthorized.body.data).toEqual({ ok: false, error: {
      kind: 'unauthorized', status: 401, message: 'Provider rejected the credentials (HTTP 401).',
    } });
    const missing = await postJson<unknown>('/api/providers:probe', { ...draft, api_key: 'draft-404' });
    expect(missing.body.data).toEqual({ ok: false, error: {
      kind: 'endpoint', status: 404, message: 'Provider models endpoint was not found (HTTP 404).',
    } });
    const network = await postJson<unknown>('/api/providers:probe', { ...draft, api_key: 'draft-network' });
    expect(network.body.data).toEqual({ ok: false, error: {
      kind: 'network', message: 'Could not reach the provider endpoint (or the request timed out).',
    } });
    expect(JSON.stringify(network.body)).not.toContain('draft-network');
    expect(JSON.stringify(unauthorized.body)).not.toContain('draft-401');
    expect(await readFile(join(home!, 'config.toml'), 'utf8')).toBe(before);
    expect((await getJson<{ items: unknown[] }>('/api/discovered-models')).body.data.items).toEqual([]);
    expect(providerFetch.mock.calls.filter(([input]) => hrefOf(input).startsWith('https://draft.example.test/'))).toHaveLength(4);
  });

  it('forwards a draft key on single-provider refresh without adding it to collection refresh', async () => {
    const refreshProviderModels = vi.fn(async () => ({ changed: [], unchanged: ['kimi'], failed: [] }));
    const seeds = [[IProviderDiscoveryService, discoveryStub(refreshProviderModels)]] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);
    const result = await postJson<unknown>('/api/providers/kimi:refresh', { api_key: 'sk-draft' });
    expect(result.body.code).toBe(0);
    expect(refreshProviderModels).toHaveBeenCalledWith({ providerId: 'kimi', apiKey: 'sk-draft' });
    const invalid = await postJson<unknown>('/api/providers/kimi:refresh', { api_key: '' });
    expect(invalid.body.code).not.toBe(0);
    expect(refreshProviderModels).toHaveBeenCalledTimes(1);
  });

  it('returns an empty refresh result through the providers:refresh route when no providers are configured', async () => {
    await boot('');
    const { status, body } = await postJson<{
      changed: unknown[];
      unchanged: unknown[];
      failed: unknown[];
    }>('/api/providers:refresh', {});
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ changed: [], unchanged: [], failed: [] });
  });

  function catalogStub(): IModelCatalogType {
    return {
      _serviceBrand: undefined,
      get: () => {
        throw new Error('unused');
      },
      getRequester: () => {
        throw new Error('unused');
      },
      inspect: () => {
        throw new Error('unused');
      },
      ping: async () => {
        throw new Error('unused');
      },
      findByName: () => [],
      listModels: async () => [],
      listProviders: async () => [],
      getProvider: async () => {
        throw new Error('unused');
      },
      setDefaultModel: async () => {
        throw new Error('unused');
      },
    };
  }

  function discoveryStub(
    refreshProviderModels: IProviderDiscoveryServiceType['refreshProviderModels'],
  ): IProviderDiscoveryServiceType {
    return {
      _serviceBrand: undefined,
      refreshProviderModels,
      listDiscoveredModels: async () => ({ items: [] }),
      probeProviderModels: async () => { throw new Error('unused'); },
    };
  }

  function oauthStub(
    refreshOAuthProviderModels: IOAuthServiceType['refreshOAuthProviderModels'],
  ): IOAuthServiceType {
    return {
      _serviceBrand: undefined,
      startLogin: async () => {
        throw new Error('unused');
      },
      getFlow: () => undefined,
      cancelLogin: async () => {
        throw new Error('unused');
      },
      logout: async () => {
        throw new Error('unused');
      },
      status: async () => ({ loggedIn: false }),
      refreshOAuthProviderModels,
      getManagedUsage: async () => ({ kind: 'error' as const, message: 'unused' }),
      getManagedUserInfo: async () => ({ kind: 'error' as const, message: 'unused' }),
      resolveTokenProvider: () => undefined,
      getCachedAccessToken: async () => undefined,
      getRegion: () => 'mainland-cn',
      listMethods: async () => [],
      probeOriginal: async () => { throw new Error('unused'); },
      connectOriginal: async () => { throw new Error('unused'); },
    };
  }

  it('refreshes OAuth provider models through POST /providers:refresh_oauth', async () => {
    const refreshOAuthProviderModels = vi.fn(async () => ({
      changed: [
        { provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 1, removed: 0 },
      ],
      unchanged: [],
      failed: [],
    }));
    const seeds = [[IOAuthService, oauthStub(refreshOAuthProviderModels)]] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const { status, body } = await postJson<{
      changed: unknown[];
      unchanged: unknown[];
      failed: unknown[];
    }>('/api/providers:refresh_oauth', {});

    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({
      changed: [
        { provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 1, removed: 0 },
      ],
      unchanged: [],
      failed: [],
    });
    expect(refreshOAuthProviderModels).toHaveBeenCalledTimes(1);
  });

  it('refreshes all provider models through POST /providers:refresh', async () => {
    const refreshProviderModels = vi.fn(async () => ({
      changed: [
        { provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 2, removed: 1 },
      ],
      unchanged: ['moonshot-cn'],
      failed: [],
    }));
    const seeds = [[IProviderDiscoveryService, discoveryStub(refreshProviderModels)]] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const { status, body } = await postJson('/api/providers:refresh', {});
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(refreshProviderModels).toHaveBeenCalledWith({ scope: 'all' });
  });

  it('refreshes a single provider through POST /providers/{id}:refresh', async () => {
    const refreshProviderModels = vi.fn(async () => ({
      changed: [],
      unchanged: [],
      failed: [],
    }));
    const seeds = [[IProviderDiscoveryService, discoveryStub(refreshProviderModels)]] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const { status, body } = await postJson('/api/providers/managed%3Akimi-code:refresh', {});
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(refreshProviderModels).toHaveBeenCalledWith({ providerId: 'managed:kimi-code' });
  });

  it('rejects unsupported provider actions with 40001', async () => {
    const refreshProviderModels = vi.fn(async () => ({
      changed: [],
      unchanged: [],
      failed: [],
    }));
    const seeds = [[IProviderDiscoveryService, discoveryStub(refreshProviderModels)]] as unknown as ScopeSeed;
    await boot(CATALOG_TOML, seeds);

    const { body } = await postJson('/api/providers/foo:bogus', {});
    expect(body.code).toBe(40001);
    expect(refreshProviderModels).not.toHaveBeenCalled();
  });

  it('keeps manual discoveries off disk until a normal model create and forgets them after restart', async () => {
    const realFetch = globalThis.fetch;
    const upstream = vi.fn(async () => Response.json({ data: [{ id: 'kimi-k2' }, { id: 'remote-new' }] }));
    vi.stubGlobal('fetch', ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://api.example.test/')) return upstream();
      return realFetch(input, init);
    }) as typeof fetch);
    await boot(CATALOG_TOML);
    const before = await readFile(join(home!, 'config.toml'), 'utf8');
    expect((await getJson('/api/discovered-models')).body.data).toEqual({ items: [] });
    await getJson('/api/models');
    await getJson('/api/providers');
    expect(upstream).not.toHaveBeenCalled();

    const refreshed = await postJson<{ changed: unknown[]; discovered: unknown[] }>('/api/providers/kimi:refresh', {});
    expect(refreshed.body.code).toBe(0);
    expect(refreshed.body.data.changed).toEqual([]);
    expect(refreshed.body.data.discovered).toEqual([expect.objectContaining({
      provider_id: 'kimi', fetched_at: expect.any(Number), attempted_at: expect.any(Number),
      models: [{ remote_id: 'remote-new' }],
    })]);
    expect(await readFile(join(home!, 'config.toml'), 'utf8')).toBe(before);
    expect((await getJson<{ items: unknown[] }>('/api/discovered-models')).body.data.items).toEqual(refreshed.body.data.discovered);
    const created = await postJson('/api/models', { id: 'chosen-alias', provider_id: 'kimi', remote_id: 'remote-new', max_context_size: 128000 });
    expect(created.body.code).toBe(0);
    expect(await readFile(join(home!, 'config.toml'), 'utf8')).toContain('chosen-alias');
    expect((await getJson<{ items: Array<{ models: unknown[] }> }>('/api/discovered-models')).body.data.items[0]?.models).toEqual([]);
    await server!.close();
    server = undefined;
    await boot();
    expect((await getJson('/api/discovered-models')).body.data).toEqual({ items: [] });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each(['sk-example-key\\nsecond-line', 'sk-example-key'])('does not serialize credential material in refresh failures (%s)', async (key) => {
    const realFetch = globalThis.fetch;
    const upstream = vi.fn(async () => Response.json({ error: { message: `invalid key: ${key}` } }, { status: 401 }));
    vi.stubGlobal('fetch', ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://api.example.test/')) return upstream();
      return realFetch(input, init);
    }) as typeof fetch);
    await boot(CATALOG_TOML.replace('api_key = "sk-test"', `api_key = ${JSON.stringify(key.replace('\\n', '\n'))}`));
    const result = await postJson<{ failed: Array<{ reason: string }> }>('/api/providers/kimi:refresh', {});
    expect(result.body.code).toBe(0);
    expect(result.body.data.failed).toHaveLength(1);
    expect(JSON.stringify(result.body)).not.toContain('sk-example-key');
    const list = await getJson('/api/discovered-models');
    expect(JSON.stringify(list.body)).not.toContain('sk-example-key');
    if (key.includes('\\n')) expect(upstream).not.toHaveBeenCalled();
  });
});
