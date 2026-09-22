import {
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiCodeOAuthKey,
  resolveKimiCodeOAuthRef,
} from '@kiki/oauth';
import type { KimiConfig } from '@kiki/node-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { refreshAllProviderModels, type RefreshProviderHost } from '../../../src/tui/utils/refresh-providers';

function makeRefreshHost(initial: KimiConfig) {
  let current = structuredClone(initial);
  const removeProvider = vi.fn(async () => structuredClone(current));
  const setConfig = vi.fn(async (patch: Partial<KimiConfig>) => {
    current = { ...current, ...patch };
    return structuredClone(current);
  });
  const resolveOAuthToken = vi.fn(async () => 'oauth-access-token');
  const host: RefreshProviderHost = {
    getConfig: async () => structuredClone(current), removeProvider, setConfig, resolveOAuthToken,
    userAgent: 'kiki-test/1.0',
  };
  return { host, current: () => current, removeProvider, setConfig, resolveOAuthToken };
}

function expectNoWrites(fixture: ReturnType<typeof makeRefreshHost>, before: KimiConfig) {
  expect(fixture.removeProvider).not.toHaveBeenCalled();
  expect(fixture.setConfig).not.toHaveBeenCalled();
  expect(fixture.current()).toEqual(before);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('CLI model discovery adapter', () => {
  it('preserves managed OAuth endpoint overrides and token selection', async () => {
    const configuredBaseUrl = 'https://api.configured.example.test/coding/v1';
    const baseUrl = 'https://api.env.example.test/coding/v1';
    const oauthHost = 'https://auth.env.example.test';
    vi.stubEnv('KIKI_CODE_BASE_URL', baseUrl);
    vi.stubEnv('KIKI_CODE_OAUTH_HOST', oauthHost);
    const fixture = makeRefreshHost({
      providers: { [KIMI_CODE_PROVIDER_NAME]: {
        type: 'kimi', baseUrl: configuredBaseUrl, apiKey: '',
        oauth: { storage: 'file', key: resolveKimiCodeOAuthKey({ baseUrl: configuredBaseUrl }) },
      } },
      models: { 'kimi-code/kimi-for-coding': {
        provider: KIMI_CODE_PROVIDER_NAME, model: 'kimi-for-coding', maxContextSize: 262144,
        capabilities: ['thinking', 'tool_use'],
      } },
      defaultModel: 'kimi-code/kimi-for-coding',
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).toBe(`${baseUrl}/models`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer oauth-access-token');
      return Response.json({ data: [{ id: 'kimi-for-coding', context_length: 262144, supports_reasoning: true }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await refreshAllProviderModels(fixture.host);
    expect(result).toEqual({ changed: [], unchanged: [KIMI_CODE_PROVIDER_NAME], failed: [] });
    expect(fixture.resolveOAuthToken).toHaveBeenCalledWith(KIMI_CODE_PROVIDER_NAME, resolveKimiCodeOAuthRef({ baseUrl, oauthHost }));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('limits OAuth scope to the managed catalog and retains its thinking synchronization', async () => {
    const baseUrl = 'https://api.example.test/coding/v1';
    const fixture = makeRefreshHost({
      providers: {
        [KIMI_CODE_PROVIDER_NAME]: { type: 'kimi', baseUrl, apiKey: '', oauth: { storage: 'file', key: resolveKimiCodeOAuthKey({ baseUrl }) } },
        custom: { type: 'openai', baseUrl: 'https://custom.example.test/v1', apiKey: 'custom-key', source: { kind: 'apiJson', url: 'https://registry.example.test/api.json', apiKey: 'registry-key' } },
      },
      models: {
        'kimi-code/reasoner': { provider: KIMI_CODE_PROVIDER_NAME, model: 'reasoner', maxContextSize: 262144, capabilities: ['thinking', 'tool_use'] },
        custom: { provider: 'custom', model: 'm1', maxContextSize: 128000 },
      },
      defaultModel: 'kimi-code/reasoner', thinking: { enabled: false },
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      expect(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).toBe(`${baseUrl}/models`);
      return Response.json({ data: [{ id: 'reasoner', context_length: 262144, supports_reasoning: true, supports_thinking_type: 'only', display_name: 'Fresh Reasoner' }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await refreshAllProviderModels(fixture.host, { scope: 'oauth' });
    expect(result.changed).toEqual([{ providerId: KIMI_CODE_PROVIDER_NAME, providerName: 'Kimi Code', added: 0, removed: 0 }]);
    expect(result.discovered).toBeUndefined();
    expect(result.failed).toEqual([]);
    expect(fixture.current().models?.['kimi-code/reasoner']).toMatchObject({ displayName: 'Fresh Reasoner', capabilities: ['thinking', 'always_thinking', 'tool_use'] });
    expect(fixture.current().models?.['custom']).toEqual({ provider: 'custom', model: 'm1', maxContextSize: 128000 });
    expect(fixture.current().thinking?.enabled).toBe(true);
    expect(fixture.current().defaultModel).toBe('kimi-code/reasoner');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fixture.setConfig).toHaveBeenCalledOnce();
  });

  it('reports registry metadata without importing new providers, deleting missing ones, or touching aliases', async () => {
    const url = 'https://registry.example.test/api.json';
    const source = { kind: 'apiJson' as const, url, apiKey: 'registry-key' };
    const initial: KimiConfig = {
      providers: {
        a: { type: 'openai', baseUrl: 'https://a.example.test/v1', apiKey: 'a-key', source },
        b: { type: 'openai', baseUrl: 'https://b.example.test/v1', apiKey: 'b-key', source },
      },
      models: { 'my-alias': { provider: 'b', model: 'old-model', maxContextSize: 100000, displayName: 'My model' } },
      defaultProvider: 'b', defaultModel: 'my-alias', thinking: { enabled: true },
    };
    const fixture = makeRefreshHost(initial);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).toBe(url);
      expect(new Headers(init?.headers).get('user-agent')).toBe('kiki-test/1.0');
      return Response.json({
        a: { id: 'a', name: 'A', api: 'https://changed.example.test', type: 'anthropic', models: { m1: { id: 'remote-m1', name: 'New model', limit: { context: 262144 }, tool_call: true, reasoning: true, modalities: { input: ['text', 'image', 'video'] } } } },
        new: { id: 'new', name: 'New provider', api: 'https://new.example.test', type: 'openai', models: { m2: { id: 'm2' } } },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await refreshAllProviderModels(fixture.host);
    expect(result.changed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual(['a', 'b']);
    expect(result.discovered).toEqual([
      { providerId: 'a', fetchedAt: expect.any(Number), models: [{ remoteId: 'remote-m1', displayName: 'New model', maxContextSize: 262144, capabilities: ['tool_use', 'thinking', 'image_in', 'video_in'] }] },
      { providerId: 'b', fetchedAt: expect.any(Number), models: [] },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expectNoWrites(fixture, initial);
  });

  it('retries shared registry credentials without replacing provider credentials or sources', async () => {
    const url = 'https://registry.example.test/api.json';
    const initial: KimiConfig = {
      providers: Object.fromEntries(['old', 'new'].map((id) => [id, {
        type: 'openai', baseUrl: `https://${id}.example.test/v1`, apiKey: `${id}-key`,
        source: { kind: 'apiJson', url, apiKey: `${id}-key` },
      }])), models: {},
    };
    const fixture = makeRefreshHost(initial);
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (new Headers(init?.headers).get('authorization') === 'Bearer old-key') return Response.json({ message: 'expired old-key' }, { status: 401 });
      return Response.json({ new: { id: 'new', name: 'New', api: 'https://new.example.test', type: 'openai', models: { m1: { id: 'm1' } } } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await refreshAllProviderModels(fixture.host);
    expect(result.failed).toEqual([]);
    expect(result.discovered?.map((group) => [group.providerId, group.models.map((model) => model.remoteId)])).toEqual([['old', []], ['new', ['m1']]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectNoWrites(fixture, initial);
  });

  it.each(['inline', 'env', 'managed-name', 'trailing-slash', 'empty'] as const)('keeps managed-endpoint API-key %s catalogs as suggestions', async (kind) => {
    const baseUrl = 'https://api.managed.example.test/coding/v1';
    vi.stubEnv('KIKI_CODE_BASE_URL', baseUrl);
    const id = kind === 'managed-name' ? KIMI_CODE_PROVIDER_NAME : 'my-kimi';
    const initial: KimiConfig = {
      providers: { [id]: { type: 'kimi', baseUrl: `${baseUrl}${kind === 'trailing-slash' ? '/' : ''}`, apiKey: kind === 'env' ? '' : 'my-key', env: kind === 'env' ? { KIMI_API_KEY: 'my-key' } : undefined } },
      models: { 'my-alias': { provider: id, model: 'old-model', maxContextSize: 100000, displayName: 'User name' } },
      defaultProvider: id, defaultModel: 'my-alias', thinking: { enabled: false },
    };
    const fixture = makeRefreshHost(initial);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).toBe(`${baseUrl}/models`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer my-key');
      return Response.json({ data: kind === 'empty' ? [] : [{ id: 'remote-new', context_length: 262144, supports_reasoning: true, display_name: 'New model' }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await refreshAllProviderModels(fixture.host);
    expect(result.changed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual([id]);
    expect(result.discovered).toEqual([{ providerId: id, fetchedAt: expect.any(Number), models: kind === 'empty' ? [] : [{ remoteId: 'remote-new', displayName: 'New model', maxContextSize: 262144, capabilities: ['thinking', 'tool_use'] }] }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fixture.resolveOAuthToken).not.toHaveBeenCalled();
    expectNoWrites(fixture, initial);
  });

  it('uses the generic endpoint and respects a single-provider target', async () => {
    const initial: KimiConfig = { providers: {
      gateway: { type: 'kimi', baseUrl: 'https://gateway.example.test/v1', apiKey: 'gateway-key' },
      other: { type: 'openai', baseUrl: 'https://other.example.test/v1', apiKey: 'other-key' },
    }, models: {} };
    const fixture = makeRefreshHost(initial);
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      expect(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).toBe('https://gateway.example.test/v1/models');
      return Response.json({ data: [{ id: 'remote-model' }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await refreshAllProviderModels(fixture.host, { providerId: 'gateway' });
    expect(result.discovered).toEqual([{ providerId: 'gateway', fetchedAt: expect.any(Number), models: [{ remoteId: 'remote-model' }] }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expectNoWrites(fixture, initial);
  });

  it('uses registry provenance ahead of a managed endpoint and sanitizes rejected credentials', async () => {
    const baseUrl = 'https://api.managed.example.test/coding/v1';
    vi.stubEnv('KIKI_CODE_BASE_URL', baseUrl);
    const initial: KimiConfig = { providers: { custom: {
      type: 'kimi', baseUrl, apiKey: 'model-key', source: { kind: 'apiJson', url: 'https://registry.example.test/api.json', apiKey: 'registry-secret-key' },
    } }, models: {} };
    const fixture = makeRefreshHost(initial);
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      expect(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).toBe('https://registry.example.test/api.json');
      return Response.json({ error: { message: 'invalid registry-secret-key' } }, { status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await refreshAllProviderModels(fixture.host);
    expect(result.failed).toEqual([{ provider: 'custom', reason: expect.stringContaining('[redacted]') }]);
    expect(JSON.stringify(result)).not.toContain('registry-secret-key');
    expectNoWrites(fixture, initial);
  });
});
