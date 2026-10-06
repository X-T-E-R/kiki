import { KIMI_CODE_PROVIDER_NAME } from '@kiki/oauth';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createScopedTestHost } from '#/_base/di/test';
import { isError2 } from '#/_base/errors/errors';
import { ILogService } from '#/_base/log/log';
import { IOAuthService } from '#/app/auth/auth';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ConfigRegistry } from '#/app/config/configService';
import { IEventService } from '#/app/event/event';
import { IProviderDiscoveryService } from '#/app/kosongConfig/discovery';
import '#/app/kosongConfig/discoveryService';
import { IKosongConfigService } from '#/app/kosongConfig/kosongConfig';
import '#/app/kosongConfig/kosongConfigService';
import '#/kosong/model/errors';
import { IModelService } from '#/kosong/model/model';
import '#/kosong/model/modelService';
import { IProviderService } from '#/kosong/provider/provider';
import '#/kosong/provider/providerService';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';

import { StubConfigService, stubOAuthService, stubTokenProvider } from '../../kosong/stubs';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubAgentIdentity } from '../agentIdentity/stubs';

function stubEvents(): IEventService & { published: Array<{ type: string; payload: unknown }> } {
  const published: Array<{ type: string; payload: unknown }> = [];
  return {
    published,
    _serviceBrand: undefined,
    onDidPublish: () => ({ dispose: () => {} }),
    publish: (event: { type: string; payload: unknown }) => { published.push(event); },
    subscribe: () => ({ dispose: () => {} }),
  } as unknown as IEventService & { published: Array<{ type: string; payload: unknown }> };
}

function stubLogService(): ILogService {
  return {
    _serviceBrand: undefined,
    level: 'debug',
    setLevel: () => {},
    flush: async () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => { throw new Error('child logger not used'); },
  };
}

async function createHost(
  sections: Record<string, unknown> = {},
  oauth: IOAuthService = stubOAuthService(),
) {
  const config = new StubConfigService(sections);
  const events = stubEvents();
  const host = createScopedTestHost([
    [IConfigService, config],
    [IOAuthService, oauth],
    [IEventService, events],
    [ILogService, stubLogService()],
    [IBootstrapService, stubBootstrap('/tmp/kimi-home', {}, { requestHeaders: { 'User-Agent': 'kimi-test/1.0' } })],
    [IAgentIdentity, stubAgentIdentity({ hostRequestHeaders: { 'User-Agent': 'kimi-test/1.0' } })],
  ]);
  const providers = host.app.accessor.get(IProviderService);
  const models = host.app.accessor.get(IModelService);
  await host.app.accessor.get(IKosongConfigService).ready;
  return { host, config, events, providers, models, discovery: host.app.accessor.get(IProviderDiscoveryService) };
}

const connection = { type: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'sk-example-key' };
const sections = {
  providers: { gateway: connection },
  models: {
    'gateway/fast': { provider: 'gateway', model: 'remote-existing', maxContextSize: 1000, displayName: 'My alias' },
  },
  defaultModel: 'gateway/fast',
  thinking: { enabled: true },
};

function catalogResponse(...ids: string[]): Response {
  return Response.json({ data: ids.map((id) => ({ id })) });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('manual provider discovery', () => {
  it('uses a persisted provider key for user-directed refresh and probe', async () => {
    const fetchMock = vi.fn(async () => catalogResponse('remote-new'));
    vi.stubGlobal('fetch', fetchMock);
    const { host, discovery } = await createHost(sections);
    try {
      await discovery.refreshProviderModels({ providerId: 'gateway' });
      await discovery.probeProviderModels({ type: 'openai', base_url: connection.baseUrl, api_key: connection.apiKey });
      expect(fetchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${connection.apiKey}` }),
      }));
    } finally { await host.dispose(); }
  });

  it('uses a persisted Google key through the normal discovery probe path', async () => {
    const fetchMock = vi.fn(async () => catalogResponse('gemini-1'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = {
      type: 'google-genai',
      baseUrl: 'https://generativelanguage.example.test/v1',
      apiKey: 'sk-google-persisted',
    };
    const { host, discovery } = await createHost({ ...sections, providers: { gateway: provider } });
    try {
      await discovery.probeProviderModels({ type: 'google-genai', base_url: provider.baseUrl, api_key: provider.apiKey });
      expect(fetchMock).toHaveBeenCalled();
    } finally { await host.dispose(); }
  });

  it('does not fetch on construction or read and returns a defensive copy of unconfigured suggestions', async () => {
    const fetchMock = vi.fn(async () => catalogResponse('remote-existing', 'remote-new'));
    vi.stubGlobal('fetch', fetchMock);
    const { host, discovery, config, events, models } = await createHost(sections);
    const writes = vi.spyOn(config, 'replaceSections');
    try {
      expect(await discovery.listDiscoveredModels()).toEqual({ items: [] });
      expect(fetchMock).not.toHaveBeenCalled();
      const result = await discovery.refreshProviderModels({ providerId: 'gateway', apiKey: 'sk-draft-copy' });
      expect(result.changed).toEqual([]);
      expect(result.unchanged).toEqual(['gateway']);
      expect(result.failed).toEqual([]);
      expect(result.discovered).toEqual([expect.objectContaining({
        provider_id: 'gateway', fetched_at: expect.any(Number), attempted_at: expect.any(Number),
        models: [{ remote_id: 'remote-new' }],
      })]);
      expect(writes).not.toHaveBeenCalled();
      expect(models.list()).toEqual(sections.models);
      expect(config.get('defaultModel')).toBe('gateway/fast');
      expect(config.get('thinking')).toEqual({ enabled: true });
      expect(events.published).toEqual([expect.objectContaining({ type: 'event.model_catalog.changed' })]);
      const list = await discovery.listDiscoveredModels();
      list.items[0]!.models.length = 0;
      expect((await discovery.listDiscoveredModels()).items[0]?.models).toEqual([{ remote_id: 'remote-new' }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await host.dispose(); }
  });

  it('uses a request-only draft key for the targeted fetch without replacing the stored key', async () => {
    const fetchMock = vi.fn(async () => catalogResponse('remote-new'));
    vi.stubGlobal('fetch', fetchMock);
    const { host, discovery, config } = await createHost(sections);
    const writes = vi.spyOn(config, 'replaceSections');
    try {
      const result = await discovery.refreshProviderModels({ providerId: 'gateway', apiKey: 'sk-draft' });
      expect(result.discovered?.[0]?.models).toEqual([{ remote_id: 'remote-new' }]);
      expect(fetchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-draft' }),
      }));
      expect(config.get('providers')).toEqual(sections.providers);
      expect(writes).not.toHaveBeenCalled();
      expect((await discovery.listDiscoveredModels()).items[0]?.models).toEqual([{ remote_id: 'remote-new' }]);
    } finally { await host.dispose(); }
  });

  it('redacts a failed draft-key probe and leaves the stored key untouched', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { message: 'invalid key sk-draft' } }, { status: 401 }))
      .mockResolvedValueOnce(catalogResponse('remote-new'));
    vi.stubGlobal('fetch', fetchMock);
    const { host, discovery, config } = await createHost(sections);
    try {
      const failed = await discovery.refreshProviderModels({ providerId: 'gateway', apiKey: 'sk-draft' });
      expect(failed.failed).toHaveLength(1);
      expect(JSON.stringify(failed)).not.toContain('sk-draft');
      expect(config.get('providers')).toEqual(sections.providers);
      await discovery.refreshProviderModels({ providerId: 'gateway', apiKey: 'sk-draft-retry' });
      expect(fetchMock).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-draft-retry' }),
      }));
    } finally { await host.dispose(); }
  });

  it('filters saved remote IDs independently of aliases, and forgets suggestions on a new app instance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalogResponse('remote-new')));
    const first = await createHost(sections);
    try {
      await first.discovery.refreshProviderModels({ providerId: 'gateway', apiKey: 'sk-draft-copy' });
      await first.config.replaceSections({ models: { ...sections.models, custom: { provider: 'gateway', model: 'remote-new' } } });
      expect((await first.discovery.listDiscoveredModels()).items[0]?.models).toEqual([]);
      const second = await createHost(sections);
      try { expect(await second.discovery.listDiscoveredModels()).toEqual({ items: [] }); }
      finally { await second.host.dispose(); }
    } finally { await first.host.dispose(); }
  });

  it('keeps the last successful suggestions with a failed-attempt status then clears them on an empty success', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(catalogResponse('remote-new'))
      .mockResolvedValueOnce(Response.json({ error: { message: 'invalid key: sk-draft-copy' } }, { status: 401 }))
      .mockResolvedValueOnce(catalogResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { host, discovery } = await createHost(sections);
    try {
      await discovery.refreshProviderModels({ providerId: 'gateway', apiKey: 'sk-draft-copy' });
      const before = (await discovery.listDiscoveredModels()).items[0]!;
      const failed = await discovery.refreshProviderModels({ providerId: 'gateway', apiKey: 'sk-draft-copy' });
      expect(failed.failed[0]?.reason).not.toContain('sk-draft-copy');
      expect((await discovery.listDiscoveredModels()).items[0]).toMatchObject({
        fetched_at: before.fetched_at, failure_reason: expect.any(String), models: [{ remote_id: 'remote-new' }],
      });
      await discovery.refreshProviderModels({ providerId: 'gateway', apiKey: 'sk-draft-copy' });
      expect((await discovery.listDiscoveredModels()).items[0]).toMatchObject({ models: [] });
      expect((await discovery.listDiscoveredModels()).items[0]).not.toHaveProperty('failure_reason');
    } finally { await host.dispose(); }
  });

  it('discards stale results when the connection changes while a fetch is pending without overwriting concurrent edits', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal('fetch', fetchMock);
    const { host, discovery, config, models } = await createHost(sections);
    try {
      const refresh = discovery.refreshProviderModels({ providerId: 'gateway', apiKey: 'sk-draft-copy' });
      await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledOnce(); });
      await config.replaceSections({
        providers: { gateway: { ...connection, apiKey: 'sk-replacement' } },
        models: { ...sections.models, concurrent: { provider: 'gateway', model: 'manual' } },
      });
      release(catalogResponse('remote-new'));
      const result = await refresh;
      expect(result.discovered).toEqual([]);
      expect(await discovery.listDiscoveredModels()).toEqual({ items: [] });
      expect(models.list()['concurrent']).toEqual({ provider: 'gateway', model: 'manual' });
      expect(config.get('providers')).toEqual({ gateway: { ...connection, apiKey: 'sk-replacement' } });
    } finally { await host.dispose(); }
  });

  it.each([
    { gateway: { ...connection, modelSource: 'static' } },
    {},
  ])('invalidates saved discoveries after changing or removing the provider', async (providers) => {
    vi.stubGlobal('fetch', vi.fn(async () => catalogResponse('remote-new')));
    const { host, discovery, config } = await createHost(sections);
    try {
      await discovery.refreshProviderModels({ providerId: 'gateway', apiKey: 'sk-draft-copy' });
      await config.replaceSections({ providers });
      expect(await discovery.listDiscoveredModels()).toEqual({ items: [] });
    } finally { await host.dispose(); }
  });

  it('records a first failure without pretending a successful fetch occurred', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { host, discovery } = await createHost({ providers: { plain: { type: 'openai' } } });
    try {
      const result = await discovery.refreshProviderModels({ providerId: 'plain' });
      expect(result.failed).toHaveLength(1);
      expect((await discovery.listDiscoveredModels()).items).toEqual([{
        provider_id: 'plain', fetched_at: null, attempted_at: expect.any(Number),
        failure_reason: result.failed[0]!.reason, models: [],
      }]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await host.dispose(); }
  });

  it('never fetches static providers and rejects unknown provider IDs', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { host, discovery, events } = await createHost({ providers: { gateway: { ...connection, modelSource: 'static' } } });
    try {
      expect(await discovery.refreshProviderModels({ providerId: 'gateway' })).toEqual({ changed: [], unchanged: ['gateway'], failed: [] });
      expect(await discovery.refreshProviderModels()).toEqual({ changed: [], unchanged: [], failed: [] });
      await expect(discovery.refreshProviderModels({ providerId: 'missing' })).rejects.toSatisfy(
        (error) => isError2(error) && error.code === 'provider.not_found',
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(events.published).toEqual([]);
    } finally { await host.dispose(); }
  });

  it('rejects a persisted sibling registry key before grouped retry candidates can fetch', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).not.toMatchObject({ Authorization: expect.any(String) });
      return Response.json({ error: 'invalid fixture' }, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const registryUrl = 'https://registry.example.test/api.json';
    const providers = {
      gateway: { type: 'openai', source: { kind: 'apiJson', url: registryUrl, apiKey: '' } },
      sibling: { type: 'openai', source: { kind: 'apiJson', url: registryUrl, apiKey: 'sk-sibling-fixture' } },
    };
    const { host, discovery } = await createHost({ ...sections, providers });
    try {
      const result = await discovery.refreshProviderModels({ providerId: 'gateway' });
      expect(result.failed).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { await host.dispose(); }
  });

  it('suggests custom-registry entries without importing providers or writing config', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      gateway: { id: 'gateway', name: 'Example', api: 'https://changed.example.test', type: 'openai', models: { m1: { id: 'm1', name: 'M1' } } },
      other: { id: 'other', name: 'Other', api: 'https://other.example.test', type: 'openai', models: { m2: { id: 'm2' } } },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const providers = {
      gateway: {
        type: connection.type,
        baseUrl: connection.baseUrl,
        source: { kind: 'apiJson', url: 'https://registry.example.test/api.json', apiKey: '' },
      },
    };
    const { host, discovery, config } = await createHost({ ...sections, providers });
    const writes = vi.spyOn(config, 'replaceSections');
    try {
      const result = await discovery.refreshProviderModels();
      expect(result.changed).toEqual([]);
      expect(result.discovered).toEqual([expect.objectContaining({ provider_id: 'gateway', models: [expect.objectContaining({ remote_id: 'm1' })] })]);
      expect(writes).not.toHaveBeenCalled();
      expect(config.get('providers')).toEqual(providers);
      expect(fetchMock).toHaveBeenCalledWith('https://registry.example.test/api.json', expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': 'kimi-test/1.0' }) }));
    } finally { await host.dispose(); }
  });

  it('treats managed-endpoint API-key providers as user-owned suggestions', async () => {
    const baseUrl = 'https://api.managed.example.test/coding/v1';
    vi.stubEnv('KIKI_CODE_BASE_URL', baseUrl);
    const fetchMock = vi.fn(async () => Response.json({ data: [{ id: 'kimi-next', context_length: 262144 }] }));
    vi.stubGlobal('fetch', fetchMock);
    const { host, discovery, config } = await createHost({ ...sections, providers: { gateway: { type: 'kimi', baseUrl, apiKey: 'sk-distributed' } } });
    const writes = vi.spyOn(config, 'replaceSections');
    try {
      const result = await discovery.refreshProviderModels({ providerId: 'gateway', apiKey: 'sk-distributed-draft' });
      expect(result.changed).toEqual([]);
      expect(result.discovered?.[0]?.models).toEqual([expect.objectContaining({ remote_id: 'kimi-next', max_context_size: 262144 })]);
      expect(fetchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-distributed-draft' }),
      }));
      expect(writes).not.toHaveBeenCalled();
      expect(config.get('defaultModel')).toBe('gateway/fast');
      expect(config.get('models')).toEqual(sections.models);
    } finally { await host.dispose(); }
  });

  it('retains managed OAuth write-back and serializes explicit fetches', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return Response.json({ data: [{ id: 'kimi-k2', context_length: 131072 }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { host, discovery, config, models } = await createHost({
      providers: {
        [KIMI_CODE_PROVIDER_NAME]: { type: 'kimi', baseUrl: 'https://api.example.test/v1', oauth: { storage: 'file', key: 'oauth/kimi-code' } },
        gateway: { type: 'openai', baseUrl: 'https://gateway.example.test/v1', apiKey: 'sk-static-sibling' },
      },
      models: {},
    }, stubOAuthService(stubTokenProvider(['access-token'])));
    const writes = vi.spyOn(config, 'replaceSections');
    try {
      const [first] = await Promise.all([
        discovery.refreshProviderModels({ scope: 'oauth' }),
        discovery.refreshProviderModels({ scope: 'oauth' }),
      ]);
      expect(first.changed).toHaveLength(1);
      expect(first.discovered).toBeUndefined();
      expect(models.list()['kimi-code/kimi-k2']).toBeDefined();
      expect(writes).toHaveBeenCalledTimes(1);
      expect(maxInFlight).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { await host.dispose(); }
  });
});

describe('catalog scheduling retirement', () => {
  it('does not register an automatic refresh configuration section', () => {
    expect(new ConfigRegistry().getSection('modelCatalog')).toBeUndefined();
  });
});
