import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  refreshProviderModels,
  type ManagedKimiConfigShape,
  type RefreshProviderHost,
} from '../src/index';

function createHost(initial: ManagedKimiConfigShape): {
  readonly host: RefreshProviderHost;
  readonly config: () => ManagedKimiConfigShape;
  readonly removeProvider: ReturnType<typeof vi.fn>;
  readonly setConfig: ReturnType<typeof vi.fn>;
} {
  let config = structuredClone(initial);
  const removeProvider = vi.fn(async (providerId: string) => {
    delete config.providers[providerId];
    for (const [alias, raw] of Object.entries(config.models ?? {})) {
      if (raw['provider'] === providerId) delete config.models?.[alias];
    }
    return structuredClone(config);
  });
  const setConfig = vi.fn(async (patch: ManagedKimiConfigShape) => {
    config = structuredClone(patch);
    return structuredClone(config);
  });
  return {
    host: {
      getConfig: async () => structuredClone(config),
      removeProvider,
      setConfig,
      resolveOAuthToken: async () => {
        throw new Error('OAuth is not expected in generic provider tests.');
      },
    },
    config: () => structuredClone(config),
    removeProvider,
    setConfig,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refreshProviderModels generic providers', () => {
  it('refreshes a scoped OpenAI-compatible provider and preserves user aliases', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'gpt-new' }, { id: 'gpt-new' }] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const fixture = createHost({
      providers: {
        gateway: { type: 'openai', baseUrl: 'https://gateway.example.test/v1/', apiKey: 'sk-gateway' },
        untouched: {
          type: 'openai_responses',
          baseUrl: 'https://untouched.example.test/v1',
          apiKey: 'sk-untouched',
        },
      },
      models: {
        'gateway/gpt-old': { provider: 'gateway', model: 'gpt-old', maxContextSize: 128000 },
        'my-gpt': {
          provider: 'gateway',
          model: 'gpt-custom',
          maxContextSize: 64000,
          displayName: 'My GPT',
        },
      },
      defaultModel: 'my-gpt',
      thinking: { enabled: false },
    });

    const result = await refreshProviderModels(fixture.host, { providerId: 'gateway' });

    expect(result).toEqual({
      changed: [{ providerId: 'gateway', providerName: 'gateway', added: 1, removed: 1 }],
      unchanged: [],
      failed: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example.test/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer sk-gateway',
        }),
      }),
    );
    expect(fixture.config()).toMatchObject({
      providers: {
        gateway: { type: 'openai', baseUrl: 'https://gateway.example.test/v1/', apiKey: 'sk-gateway' },
        untouched: {
          type: 'openai_responses',
          baseUrl: 'https://untouched.example.test/v1',
          apiKey: 'sk-untouched',
        },
      },
      models: {
        'gateway/gpt-new': { provider: 'gateway', model: 'gpt-new' },
        'my-gpt': {
          provider: 'gateway',
          model: 'gpt-custom',
          maxContextSize: 64000,
          displayName: 'My GPT',
        },
      },
      defaultModel: 'my-gpt',
      thinking: { enabled: false },
    });
    expect(fixture.config().models?.['gateway/gpt-old']).toBeUndefined();
  });

  it('refreshes Anthropic during a full run and keeps another provider network failure isolated', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://broken.example.test')) throw new Error('socket closed');
      return new Response(JSON.stringify({ data: [{ id: 'claude-new' }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = createHost({
      providers: {
        broken: {
          type: 'openai_responses',
          baseUrl: 'https://broken.example.test/v1',
          apiKey: 'sk-broken',
        },
        claude: {
          type: 'anthropic',
          baseUrl: 'https://claude.example.test/v1',
          env: { ANTHROPIC_API_KEY: 'sk-anthropic-env' },
        },
      },
      models: {},
    });

    const result = await refreshProviderModels(fixture.host, { scope: 'all' });

    expect(result).toEqual({
      changed: [{ providerId: 'claude', providerName: 'claude', added: 1, removed: 0 }],
      unchanged: [],
      failed: [{ provider: 'broken', reason: 'socket closed' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://claude.example.test/v1/models',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': 'sk-anthropic-env',
        },
      }),
    );
    expect(fixture.config().models?.['claude/claude-new']).toEqual({
      provider: 'claude',
      model: 'claude-new',
    });
  });

  it('reports an empty scoped model list as a source failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const fixture = createHost({
      providers: {
        empty: { type: 'openai', baseUrl: 'https://empty.example.test/v1', apiKey: 'sk-empty' },
      },
      models: {},
    });

    await expect(refreshProviderModels(fixture.host, { providerId: 'empty' })).resolves.toEqual({
      changed: [],
      unchanged: [],
      failed: [{ provider: 'empty', reason: 'provider models endpoint returned no models' }],
    });
    expect(fixture.removeProvider).not.toHaveBeenCalled();
    expect(fixture.setConfig).not.toHaveBeenCalled();
  });

  it('distinguishes a configured generic source with no credential', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const fixture = createHost({
      providers: {
        missing: { type: 'openai', baseUrl: 'https://missing.example.test/v1' },
      },
      models: {},
    });

    await expect(refreshProviderModels(fixture.host, { providerId: 'missing' })).resolves.toEqual({
      changed: [],
      unchanged: [],
      failed: [{ provider: 'missing', reason: 'provider model source requires an API key' }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
