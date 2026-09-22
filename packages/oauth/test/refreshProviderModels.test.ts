import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  refreshProviderModels,
  type ManagedKimiConfigShape,
  type RefreshProviderHost,
} from '../src/index';

function createHost(
  initial: ManagedKimiConfigShape,
  options: { readonly oauthToken?: string } = {},
): {
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
        if (options.oauthToken === undefined) {
          throw new Error('OAuth is not expected outside the managed provider tests.');
        }
        return options.oauthToken;
      },
    },
    config: () => structuredClone(config),
    removeProvider,
    setConfig,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const MANAGED_MODELS_RESPONSE = {
  data: [
    {
      id: 'kimi-k2',
      context_length: 262144,
      supports_reasoning: true,
      display_name: 'Kimi K2',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('refreshProviderModels suggestions', () => {
  it('reports a scoped generic provider catalog as a suggestion and never writes config', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'gpt-new' }, { id: 'gpt-new' }] }),
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
    const before = fixture.config();

    const result = await refreshProviderModels(fixture.host, { providerId: 'gateway' });

    expect(result).toEqual({
      changed: [],
      unchanged: ['gateway'],
      failed: [],
      discovered: [
        {
          providerId: 'gateway',
          fetchedAt: expect.any(Number),
          models: [{ remoteId: 'gpt-new' }],
        },
      ],
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
    expect(fixture.removeProvider).not.toHaveBeenCalled();
    expect(fixture.setConfig).not.toHaveBeenCalled();
    expect(fixture.config()).toEqual(before);
  });

  it('suggests Anthropic models during a full run and keeps another provider failure isolated', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://broken.example.test')) throw new Error('socket closed');
      return jsonResponse({ data: [{ id: 'claude-new' }] });
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
    const before = fixture.config();

    const result = await refreshProviderModels(fixture.host, { scope: 'all' });

    expect(result).toEqual({
      changed: [],
      unchanged: ['claude'],
      failed: [{ provider: 'broken', reason: 'socket closed' }],
      discovered: [
        {
          providerId: 'claude',
          fetchedAt: expect.any(Number),
          models: [{ remoteId: 'claude-new' }],
        },
      ],
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
    expect(fixture.setConfig).not.toHaveBeenCalled();
    expect(fixture.config()).toEqual(before);
  });

  it('reports an empty scoped catalog as an empty suggestion instead of a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [] })));
    const fixture = createHost({
      providers: {
        empty: { type: 'openai', baseUrl: 'https://empty.example.test/v1', apiKey: 'sk-empty' },
      },
      models: {},
    });

    await expect(refreshProviderModels(fixture.host, { providerId: 'empty' })).resolves.toEqual({
      changed: [],
      unchanged: ['empty'],
      failed: [],
      discovered: [{ providerId: 'empty', fetchedAt: expect.any(Number), models: [] }],
    });
    expect(fixture.removeProvider).not.toHaveBeenCalled();
    expect(fixture.setConfig).not.toHaveBeenCalled();
  });

  it('suggests open-platform models without writing the platform config', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: 'kimi-k2-0712-preview',
            context_length: 256000,
            supports_reasoning: true,
            supports_image_in: true,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const fixture = createHost({
      providers: {
        'moonshot-cn': { type: 'kimi', apiKey: 'sk-platform' },
      },
      models: {},
    });
    const before = fixture.config();

    const result = await refreshProviderModels(fixture.host, { providerId: 'moonshot-cn' });

    expect(result.changed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual(['moonshot-cn']);
    expect(result.discovered).toEqual([
      {
        providerId: 'moonshot-cn',
        fetchedAt: expect.any(Number),
        models: [
          {
            remoteId: 'kimi-k2-0712-preview',
            maxContextSize: 256000,
            capabilities: ['thinking', 'image_in', 'tool_use'],
          },
        ],
      },
    ]);
    expect(fixture.setConfig).not.toHaveBeenCalled();
    expect(fixture.config()).toEqual(before);
  });

  it('suggests custom-registry models without applying the registry entry', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        acme: {
          id: 'acme',
          name: 'Acme Registry',
          api: 'https://acme.example.test/v1',
          type: 'openai',
          models: {
            m1: { id: 'm1', name: 'M1', limit: { context: 200000 } },
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const fixture = createHost({
      providers: {
        acme: {
          type: 'openai',
          apiKey: 'sk-acme',
          source: {
            kind: 'apiJson',
            url: 'https://registry.example.test/api.json',
            apiKey: 'sk-registry',
          },
        },
      },
      models: {},
    });
    const before = fixture.config();

    const result = await refreshProviderModels(fixture.host, { scope: 'all' });

    expect(result).toEqual({
      changed: [],
      unchanged: ['acme'],
      failed: [],
      discovered: [
        {
          providerId: 'acme',
          fetchedAt: expect.any(Number),
          models: [
            {
              remoteId: 'm1',
              displayName: 'M1',
              maxContextSize: 200000,
              capabilities: ['tool_use'],
            },
          ],
        },
      ],
    });
    expect(fixture.removeProvider).not.toHaveBeenCalled();
    expect(fixture.setConfig).not.toHaveBeenCalled();
    expect(fixture.config()).toEqual(before);
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

describe('refreshProviderModels managed Kimi Code (OAuth)', () => {
  it('still writes the managed provider models back through the host', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(MANAGED_MODELS_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);
    const fixture = createHost(
      {
        providers: {
          'managed:kimi-code': {
            type: 'kimi',
            baseUrl: 'https://api.kimi.com/coding/v1',
            oauth: { storage: 'file', key: 'oauth/kimi-code' },
          },
        },
        models: {},
      },
      { oauthToken: 'oauth-access-token' },
    );

    const result = await refreshProviderModels(fixture.host, { providerId: 'managed:kimi-code' });

    expect(result.changed).toEqual([
      { providerId: 'managed:kimi-code', providerName: 'Kimi Code', added: 1, removed: 0 },
    ]);
    expect(result.unchanged).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.discovered).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kimi.com/coding/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer oauth-access-token' }),
      }),
    );
    expect(fixture.removeProvider).toHaveBeenCalledWith('managed:kimi-code');
    expect(fixture.setConfig).toHaveBeenCalledTimes(1);
    expect(fixture.config().models?.['kimi-code/kimi-k2']).toMatchObject({
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
    });
  });

  it('keeps unchanged data on disk when the managed catalog is identical', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(MANAGED_MODELS_RESPONSE)));
    const first = createHost(
      {
        providers: {
          'managed:kimi-code': {
            type: 'kimi',
            baseUrl: 'https://api.kimi.com/coding/v1',
            oauth: { storage: 'file', key: 'oauth/kimi-code' },
          },
        },
        models: {},
      },
      { oauthToken: 'oauth-access-token' },
    );
    await refreshProviderModels(first.host, { providerId: 'managed:kimi-code' });
    const persisted = first.config();

    const second = createHost(persisted, { oauthToken: 'oauth-access-token' });
    const result = await refreshProviderModels(second.host, { providerId: 'managed:kimi-code' });

    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual(['managed:kimi-code']);
    expect(second.setConfig).not.toHaveBeenCalled();
    expect(second.removeProvider).not.toHaveBeenCalled();
  });
});

describe('refreshProviderModels credential safety', () => {
  it('rejects a credential with an internal newline before any request or header exists', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const apiKey = 'sk-live\n-abcdefgh';
    const fixture = createHost({
      providers: {
        gateway: { type: 'openai', baseUrl: 'https://gateway.example.test/v1', apiKey },
      },
      models: {},
    });

    const result = await refreshProviderModels(fixture.host, { providerId: 'gateway' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.changed).toEqual([]);
    expect(result.discovered).toBeUndefined();
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toContain('control characters');
    expect(JSON.stringify(result)).not.toContain('sk-live');
    expect(JSON.stringify(result)).not.toContain('abcdefgh');
  });

  it('redacts a credential the provider echoes back in its error body', async () => {
    const apiKey = 'sk-gateway-9f3c1d7e';
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            message:
              `The API key ${apiKey} is invalid. Authorization: Bearer ${apiKey}`,
          },
        },
        401,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const fixture = createHost({
      providers: {
        gateway: { type: 'openai', baseUrl: 'https://gateway.example.test/v1', apiKey },
      },
      models: {},
    });

    const result = await refreshProviderModels(fixture.host, { providerId: 'gateway' });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toContain('[redacted]');
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it('redacts a managed OAuth token the provider echoes back', async () => {
    const token = 'oauth-token-4d1f8a2b';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { message: `expired token ${token}` } }, 401),
      ),
    );
    const fixture = createHost(
      {
        providers: {
          'managed:kimi-code': {
            type: 'kimi',
            baseUrl: 'https://api.kimi.com/coding/v1',
            oauth: { storage: 'file', key: 'oauth/kimi-code' },
          },
        },
        models: {},
      },
      { oauthToken: token },
    );

    const result = await refreshProviderModels(fixture.host, { providerId: 'managed:kimi-code' });

    expect(result.changed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toContain('rejected OAuth credentials');
    expect(JSON.stringify(result)).not.toContain(token);
  });
});
