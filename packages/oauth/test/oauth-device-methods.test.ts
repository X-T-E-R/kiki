import { describe, expect, it, vi } from 'vitest';

import {
  createGitHubCopilotMethod,
  createOpenAICodexMethod,
  githubCopilotBaseUrlFromToken,
  isDeviceOAuthMethod,
  OAUTH_METHODS,
  OAuthDeviceMethods,
  oauthMethodFor,
  openaiCodexAccountId,
  parseGitHubCopilotModels,
  applyOAuthMethodConfig,
  clearOAuthMethodConfig,
  type ManagedKimiConfigShape,
  type TokenInfo,
  type TokenStorage,
} from '../src';

class MemoryTokenStorage implements TokenStorage {
  readonly tokens = new Map<string, TokenInfo>();
  async load(name: string): Promise<TokenInfo | undefined> {
    return this.tokens.get(name);
  }
  async save(name: string, token: TokenInfo): Promise<void> {
    this.tokens.set(name, token);
  }
  async remove(name: string): Promise<void> {
    this.tokens.delete(name);
  }
  async list(): Promise<string[]> {
    return [...this.tokens.keys()];
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`;
}

type Route = (url: string, init: RequestInit | undefined) => Response;

function fakeFetch(routes: Record<string, Route>): typeof fetch & ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (route === undefined) throw new Error(`unexpected fetch ${url}`);
    return route[1](url, init);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('OAuth method registry', () => {
  it('lists Kimi Code as one of several methods', () => {
    expect(OAUTH_METHODS.map((method) => method.id)).toEqual([
      'kimi-code',
      'github-copilot',
      'openai-codex',
    ]);
    expect(oauthMethodFor('managed:github-copilot')?.id).toBe('github-copilot');
    expect(isDeviceOAuthMethod('kimi-code')).toBe(false);
    expect(isDeviceOAuthMethod('managed:openai-codex')).toBe(true);
  });
});

describe('GitHub Copilot method', () => {
  const copilotToken = 'tid=1;exp=2;proxy-ep=proxy.business.githubcopilot.com;sku=x';

  it('derives the API host from the Copilot token', () => {
    expect(githubCopilotBaseUrlFromToken(copilotToken)).toBe('https://api.business.githubcopilot.com');
    expect(githubCopilotBaseUrlFromToken('opaque')).toBe('https://api.individual.githubcopilot.com');
    expect(githubCopilotBaseUrlFromToken('proxy-ep=evil.example.com')).toBe('https://api.individual.githubcopilot.com');
    expect(githubCopilotBaseUrlFromToken('proxy-ep=proxy.business.githubcopilot.com@evil.example.com'))
      .toBe('https://api.individual.githubcopilot.com');
  });

  it('runs the device flow and exchanges the GitHub token for a Copilot token', async () => {
    const fetchImpl = fakeFetch({
      'https://github.com/login/device/code': () =>
        json({
          device_code: 'dev-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          interval: 5,
          expires_in: 900,
        }),
      'https://github.com/login/oauth/access_token': () => json({ access_token: 'gho_example' }),
      'https://api.github.com/copilot_internal/v2/token': (_url, init) => {
        expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer gho_example');
        return json({ token: copilotToken, expires_at: Math.floor(Date.now() / 1000) + 1800 });
      },
    });
    const method = createGitHubCopilotMethod(fetchImpl);
    const device = await method.requestDevice();
    expect(device).toMatchObject({ userCode: 'ABCD-1234', deviceCode: 'dev-1', interval: 5 });
    const polled = await method.pollDevice(device.deviceCode);
    expect(polled.kind).toBe('success');
    if (polled.kind !== 'success') return;
    expect(polled.token.accessToken).toBe(copilotToken);
    expect(polled.token.refreshToken).toBe('gho_example');
    expect(method.baseUrlFor(polled.token.accessToken)).toBe('https://api.business.githubcopilot.com');
    expect(method.requestHeaders(copilotToken)['Copilot-Integration-Id']).toBe('vscode-chat');
  });

  it('maps pending and denial poll results', async () => {
    let answer: Record<string, unknown> = { error: 'authorization_pending' };
    const method = createGitHubCopilotMethod(
      fakeFetch({ 'https://github.com/login/oauth/access_token': () => json(answer) }),
    );
    expect(await method.pollDevice('dev')).toMatchObject({ kind: 'pending', errorCode: 'authorization_pending' });
    answer = { error: 'slow_down' };
    expect(await method.pollDevice('dev')).toMatchObject({ kind: 'pending', errorCode: 'slow_down' });
    answer = { error: 'access_denied' };
    expect((await method.pollDevice('dev')).kind).toBe('denied');
    answer = { error: 'expired_token' };
    expect((await method.pollDevice('dev')).kind).toBe('expired');
  });

  it('rejects a non-http verification URI', async () => {
    const method = createGitHubCopilotMethod(
      fakeFetch({
        'https://github.com/login/device/code': () =>
          json({ device_code: 'd', user_code: 'u', verification_uri: 'file:///etc/passwd', expires_in: 900 }),
      }),
    );
    await expect(method.requestDevice()).rejects.toThrow(/http/);
  });

  it('keeps picker-enabled tool-capable chat models only', () => {
    const models = parseGitHubCopilotModels([
      {
        id: 'gpt-4.1',
        name: 'GPT-4.1',
        model_picker_enabled: true,
        capabilities: {
          type: 'chat',
          limits: { max_context_window_tokens: 128000 },
          supports: { tool_calls: true, vision: true },
        },
        supported_endpoints: ['/chat/completions'],
      },
      {
        id: 'o-responses',
        model_picker_enabled: true,
        capabilities: { supports: { tool_calls: true, reasoning_effort: ['low', 'high'] } },
        supported_endpoints: ['/responses'],
      },
      { id: 'hidden', model_picker_enabled: false, capabilities: {} },
      { id: 'no-tools', model_picker_enabled: true, capabilities: { supports: { tool_calls: false } } },
      { id: 'embed', model_picker_enabled: true, capabilities: { type: 'embeddings' } },
    ]);
    expect(models.map((model) => model.id)).toEqual(['gpt-4.1', 'o-responses']);
    expect(models[0]).toMatchObject({ contextLength: 128000, capabilities: ['tool_use', 'image_in'] });
    expect(models[1]).toMatchObject({
      protocol: 'openai_responses',
      capabilities: ['tool_use', 'thinking'],
      supportEfforts: ['low', 'high'],
    });
  });

  it('falls back to enabled policies only for Individual accounts with no picker entries', () => {
    const items = [
      { id: 'enabled', model_picker_enabled: false, policy: { state: 'enabled' }, capabilities: { type: 'chat', supports: { tool_calls: true } } },
      { id: 'disabled', model_picker_enabled: false, policy: { state: 'disabled' }, capabilities: { type: 'chat' } },
    ];
    expect(parseGitHubCopilotModels(items).map((model) => model.id)).toEqual([]);
    expect(parseGitHubCopilotModels(items, true).map((model) => model.id)).toEqual(['enabled']);
  });
});

describe('ChatGPT (Codex) method', () => {
  const access = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_example' } });

  it('extracts the account id claim', () => {
    expect(openaiCodexAccountId(access)).toBe('acct_example');
    expect(openaiCodexAccountId('not-a-jwt')).toBeUndefined();
  });

  it('polls the device auth and exchanges the authorization code', async () => {
    let authorized = false;
    const fetchImpl = fakeFetch({
      'https://auth.openai.com/api/accounts/deviceauth/usercode': () =>
        json({ device_auth_id: 'dev-auth', user_code: 'WXYZ-9876', interval: '3' }),
      'https://auth.openai.com/api/accounts/deviceauth/token': (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ device_auth_id: 'dev-auth', user_code: 'WXYZ-9876' });
        return authorized
          ? json({ authorization_code: 'code-1', code_verifier: 'verifier-1' })
          : json({ error: { code: 'deviceauth_authorization_pending' } }, 400);
      },
      'https://auth.openai.com/oauth/token': (_url, init) => {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code_verifier')).toBe('verifier-1');
        return json({ access_token: access, refresh_token: 'rt-1', expires_in: 3600 });
      },
    });
    const method = createOpenAICodexMethod(fetchImpl);
    const device = await method.requestDevice();
    expect(device).toMatchObject({
      userCode: 'WXYZ-9876',
      interval: 3,
      verificationUri: 'https://auth.openai.com/codex/device',
    });
    expect(await method.pollDevice(device.deviceCode)).toMatchObject({ kind: 'pending' });
    authorized = true;
    const polled = await method.pollDevice(device.deviceCode);
    expect(polled.kind).toBe('success');
    if (polled.kind === 'success') expect(polled.token.refreshToken).toBe('rt-1');
    expect(method.requestHeaders(access)['chatgpt-account-id']).toBe('acct_example');
    expect(method.baseUrlFor(access)).toBe('https://chatgpt.com/backend-api/codex');
  });

  it('treats a rejected refresh as unauthorized', async () => {
    const method = createOpenAICodexMethod(
      fakeFetch({ 'https://auth.openai.com/oauth/token': () => json({ error: 'invalid_grant' }, 400) }),
    );
    await expect(method.refresh('rt-dead')).rejects.toMatchObject({ name: 'OAuthUnauthorizedError' });
  });

  it('refreshes a rotating ChatGPT token using the refresh-token grant', async () => {
    const fetchImpl = fakeFetch({
      'https://auth.openai.com/oauth/token': (_url, init) => {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('refresh_token')).toBe('rt-old');
        return json({ access_token: access, refresh_token: 'rt-new', expires_in: 3600 });
      },
    });
    const token = await createOpenAICodexMethod(fetchImpl).refresh('rt-old');
    expect(token).toMatchObject({ accessToken: access, refreshToken: 'rt-new', expiresIn: 3600 });
  });

  it('ships a static model catalog', async () => {
    const models = await createOpenAICodexMethod(fakeFetch({})).listModels(access);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.contextLength > 0)).toBe(true);
  });
});

describe('OAuthDeviceMethods token lifecycle', () => {
  it('stores the token under the method name and refreshes through the method', async () => {
    const storage = new MemoryTokenStorage();
    let refreshCalls = 0;
    const nowSeconds = 1_000_000;
    const fetchImpl = fakeFetch({
      'https://github.com/login/device/code': () =>
        json({ device_code: 'dev', user_code: 'CODE', verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 900 }),
      'https://github.com/login/oauth/access_token': () => json({ access_token: 'gho_example' }),
      'https://api.github.com/copilot_internal/v2/token': () => {
        refreshCalls += 1;
        return json({ token: `copilot-${refreshCalls}`, expires_at: nowSeconds + 1800 });
      },
    });
    const methods = new OAuthDeviceMethods({
      homeDir: '/unused',
      storage,
      fetchImpl,
      now: () => nowSeconds,
      sleep: async () => {},
      disableCrossProcessLock: true,
    });
    const onDeviceCode = vi.fn();
    expect(await methods.login('github-copilot', { onDeviceCode })).toBe('copilot-1');
    expect(onDeviceCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'CODE' }));
    expect(storage.tokens.get('github-copilot')?.refreshToken).toBe('gho_example');
    expect(await methods.getCachedAccessToken('managed:github-copilot')).toBe('copilot-1');

    expect(await methods.tokenProvider('github-copilot').getAccessToken({ force: true })).toBe('copilot-2');
    await methods.logout('github-copilot');
    expect(storage.tokens.has('github-copilot')).toBe(false);
  });

  it('refuses Kimi Code, which keeps its own toolkit', () => {
    const methods = new OAuthDeviceMethods({ homeDir: '/unused', storage: new MemoryTokenStorage() });
    expect(() => methods.method('kimi-code')).toThrow(/no device sign-in/);
  });
});

describe('applyOAuthMethodConfig', () => {
  const method = oauthMethodFor('github-copilot')!;
  const models = [
    { id: 'gpt-4.1', contextLength: 128000, capabilities: ['tool_use'] },
    { id: 'o-resp', contextLength: 200000, capabilities: ['tool_use'], protocol: 'openai_responses' as const },
  ];

  it('writes the provider and aliases and seeds a default only when none exists', () => {
    const config: ManagedKimiConfigShape = {
      providers: { mine: { type: 'openai', apiKey: 'sk-example' } },
      models: { 'mine/gpt': { provider: 'mine', model: 'gpt', maxContextSize: 1000 } },
      defaultModel: 'mine/gpt',
    };
    const result = applyOAuthMethodConfig(config, method, {
      baseUrl: 'https://api.individual.githubcopilot.com',
      headers: { 'Copilot-Integration-Id': 'vscode-chat' },
      models,
    });
    expect(result).toMatchObject({ added: 2, removed: 0, defaultModel: 'mine/gpt' });
    expect(config.providers['managed:github-copilot']).toMatchObject({
      type: 'openai',
      oauth: { storage: 'file', key: 'oauth/github-copilot' },
      customHeaders: { 'Copilot-Integration-Id': 'vscode-chat' },
      modelSource: 'static',
    });
    expect(config.models?.['github-copilot/o-resp']).toMatchObject({ protocol: 'openai_responses' });
    expect(config.models?.['github-copilot/gpt-4.1']?.['protocol']).toBeUndefined();

    const empty: ManagedKimiConfigShape = { providers: {} };
    applyOAuthMethodConfig(empty, method, { baseUrl: 'https://x.example.test', models });
    expect(empty.defaultModel).toBe('github-copilot/gpt-4.1');
  });

  it('drops aliases upstream stopped listing and clears everything on sign-out', () => {
    const config: ManagedKimiConfigShape = { providers: {} };
    applyOAuthMethodConfig(config, method, { baseUrl: 'https://x.example.test', models });
    const second = applyOAuthMethodConfig(config, method, { baseUrl: 'https://x.example.test', models: models.slice(1) });
    expect(second).toMatchObject({ added: 0, removed: 1 });
    expect(config.defaultModel).toBe('github-copilot/o-resp');
    config.models!['my-copilot-alias'] = { provider: method.providerName, model: 'o-resp', maxContextSize: 200000 };
    const cleared = clearOAuthMethodConfig(config, method);
    expect(cleared).toMatchObject({ removedProvider: true, removedModels: ['github-copilot/o-resp'], defaultModelCleared: true });
    expect(config.models?.['my-copilot-alias']).toBeDefined();
    expect(config.defaultModel).toBeUndefined();
  });
});
