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
  it('does not fetch on construction or read and returns a defensive copy of unconfigured suggestions', async () => {
    const fetchMock = vi.fn(async () => catalogResponse('remote-existing', 'remote-new'));
    vi.stubGlobal('fetch', fetchMock);
    const { host, discovery, config, events, models } = await createHost(sections);
    const writes = vi.spyOn(config, 'replaceSections');
    try {
      expect(await discovery.listDiscoveredModels()).toEqual({ items: [] });
      expect(fetchMock).not.toHaveBeenCalled();
      const result = await discovery.refreshProviderModels({ providerId: 'gateway' });
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
    } finally { host.dispose(); }
  });

  it('filters saved remote IDs independently of aliases, and forgets suggestions on a new app instance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalogResponse('remote-new')));
    const first = await createHost(sections);
    try {
      await first.discovery.refreshProviderModels({ providerId: 'gateway' });
      await first.config.replaceSections({ models: { ...sections.models, custom: { provider: 'gateway', model: 'remote-new' } } });
      expect((await first.discovery.listDiscoveredModels()).items[0]?.models).toEqual([]);
      const second = await createHost(sections);
      try { expect(await second.discovery.listDiscoveredModels()).toEqual({ items: [] }); }
      finally { second.host.dispose(); }
    } finally { first.host.dispose(); }
  });

  it('keeps the last successful suggestions with a failed-attempt status then clears them on an empty success', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(catalogResponse('remote-new'))
      .mockResolvedValueOnce(Response.json({ error: { message: 'invalid key: sk-example-key' } }, { status: 401 }))
      .mockResolvedValueOnce(catalogResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { host, discovery } = await createHost(sections);
    try {
      await discovery.refreshProviderModels({ providerId: 'gateway' });
      const before = (await discovery.listDiscoveredModels()).items[0]!;
      const failed = await discovery.refreshProviderModels({ providerId: 'gateway' });
      expect(failed.failed[0]?.reason).not.toContain('sk-example-key');
      expect((await discovery.listDiscoveredModels()).items[0]).toMatchObject({
        fetched_at: before.fetched_at, failure_reason: expect.any(String), models: [{ remote_id: 'remote-new' }],
      });
      await discovery.refreshProviderModels({ providerId: 'gateway' });
      expect((await discovery.listDiscoveredModels()).items[0]).toMatchObject({ models: [] });
      expect((await discovery.listDiscoveredModels()).items[0]).not.toHaveProperty('failure_reason');
    } finally { host.dispose(); }
  });

  it('discards stale results when the connection changes while a fetch is pending without overwriting concurrent edits', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal('fetch', fetchMock);
    const { host, discovery, config, models } = await createHost(sections);
    try {
      const refresh = discovery.refreshProviderModels({ providerId: 'gateway' });
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
    } finally { host.dispose(); }
  });

  it.each([
    { gateway: { ...connection, modelSource: 'static' } },
    {},
  ])('invalidates saved discoveries after changing or removing the provider', async (providers) => {
    vi.stubGlobal('fetch', vi.fn(async () => catalogResponse('remote-new')));
    const { host, discovery, config } = await createHost(sections);
    try {
      await discovery.refreshProviderModels({ providerId: 'gateway' });
      await config.replaceSections({ providers });
      expect(await discovery.listDiscoveredModels()).toEqual({ items: [] });
    } finally { host.dispose(); }
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
    } finally { host.dispose(); }
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
    } finally { host.dispose(); }
  });

  it('suggests custom-registry entries without importing providers or writing config', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      gateway: { id: 'gateway', name: 'Example', api: 'https://changed.example.test', type: 'openai', models: { m1: { id: 'm1', name: 'M1' } } },
      other: { id: 'other', name: 'Other', api: 'https://other.example.test', type: 'openai', models: { m2: { id: 'm2' } } },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const providers = { gateway: { ...connection, source: { kind: 'apiJson', url: 'https://registry.example.test/api.json', apiKey: 'sk-registry' } } };
    const { host, discovery, config } = await createHost({ ...sections, providers });
    const writes = vi.spyOn(config, 'replaceSections');
    try {
      const result = await discovery.refreshProviderModels();
      expect(result.changed).toEqual([]);
      expect(result.discovered).toEqual([expect.objectContaining({ provider_id: 'gateway', models: [expect.objectContaining({ remote_id: 'm1' })] })]);
      expect(writes).not.toHaveBeenCalled();
      expect(config.get('providers')).toEqual(providers);
      expect(fetchMock).toHaveBeenCalledWith('https://registry.example.test/api.json', expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': 'kimi-test/1.0' }) }));
    } finally { host.dispose(); }
  });

  it('treats managed-endpoint API-key providers as user-owned suggestions', async () => {
    const baseUrl = 'https://api.managed.example.test/coding/v1';
    vi.stubEnv('KIKI_CODE_BASE_URL', baseUrl);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'kimi-next', context_length: 262144 }] })));
    const { host, discovery, config } = await createHost({ ...sections, providers: { gateway: { type: 'kimi', baseUrl, apiKey: 'sk-distributed' } } });
    const writes = vi.spyOn(config, 'replaceSections');
    try {
      const result = await discovery.refreshProviderModels();
      expect(result.changed).toEqual([]);
      expect(result.discovered?.[0]?.models).toEqual([expect.objectContaining({ remote_id: 'kimi-next', max_context_size: 262144 })]);
      expect(writes).not.toHaveBeenCalled();
      expect(config.get('defaultModel')).toBe('gateway/fast');
      expect(config.get('models')).toEqual(sections.models);
    } finally { host.dispose(); }
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
      providers: { [KIMI_CODE_PROVIDER_NAME]: { type: 'kimi', baseUrl: 'https://api.example.test/v1', oauth: { storage: 'file', key: 'oauth/kimi-code' } } },
      models: {},
    }, stubOAuthService(stubTokenProvider(['access-token'])));
    const writes = vi.spyOn(config, 'replaceSections');
    try {
      const [first] = await Promise.all([discovery.refreshProviderModels(), discovery.refreshProviderModels()]);
      expect(first.changed).toHaveLength(1);
      expect(first.discovered).toBeUndefined();
      expect(models.list()['kimi-code/kimi-k2']).toBeDefined();
      expect(writes).toHaveBeenCalledTimes(1);
      expect(maxInFlight).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { host.dispose(); }
  });
});

describe('catalog scheduling retirement', () => {
  it('does not register an automatic refresh configuration section', () => {
    expect(new ConfigRegistry().getSection('modelCatalog')).toBeUndefined();
  });
});
