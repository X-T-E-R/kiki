import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createGrokBuildMethod,
  parseGrokBuildModels,
  FileTokenStorage,
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
      'grok-build',
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

  it('keeps an unrotated refresh token and derives lifetime when expires_in is omitted', async () => {
    const token = await createOpenAICodexMethod(fakeFetch({
      'https://auth.openai.com/oauth/token': () => json({ access_token: access }),
    })).refresh('refresh-existing');
    expect(token).toMatchObject({ refreshToken: 'refresh-existing', expiresIn: 3600 });
  });

  it.each(['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'])('marks %s permanent without leaking error detail', async (code) => {
    const method = createOpenAICodexMethod(fakeFetch({
      'https://auth.openai.com/oauth/token': () => json({ error: { code, message: 'private-refresh' } }, 400),
    }));
    await expect(method.refresh('private-refresh')).rejects.toMatchObject({ name: 'OAuthUnauthorizedError' });
    await expect(method.refresh('private-refresh')).rejects.not.toThrow('private-refresh');
  });

  it('rejects empty device identifiers before publishing the login step', async () => {
    const method = createOpenAICodexMethod(fakeFetch({
      'https://auth.openai.com/api/accounts/deviceauth/usercode': () => json({ device_auth_id: '', user_code: '' }),
    }));
    await expect(method.requestDevice()).rejects.toThrow(/missing fields/);
  });

  it('persists independent Codex login and rotation across reopen in its existing Kiki account home', async () => {
    const root = resolve('.tmp/oauth-contract');
    await mkdir(root, { recursive: true });
    const home = await mkdtemp(join(root, 'codex-'));
    try {
      const fetchImpl = fakeFetch({
        'https://auth.openai.com/api/accounts/deviceauth/usercode': () => json({ device_auth_id: 'device-example', user_code: 'CODE-1234', interval: '1' }),
        'https://auth.openai.com/api/accounts/deviceauth/token': () => json({ authorization_code: 'auth-example', code_verifier: 'verifier-example' }),
        'https://auth.openai.com/oauth/token': (_url, init) => {
          const form = new URLSearchParams(String(init?.body));
          return form.get('grant_type') === 'refresh_token'
            ? json({ access_token: access, refresh_token: 'rotated-example', expires_in: 3600 })
            : json({ access_token: access, refresh_token: 'refresh-example', expires_in: 3600 });
        },
      });
      const options = { homeDir: home, fetchImpl, sleep: async () => {} };
      await new OAuthDeviceMethods(options).login('openai-codex');
      const reopened = new OAuthDeviceMethods(options);
      expect(await reopened.connectionState('openai-codex')).toBe('ready');
      await reopened.tokenProvider('openai-codex').getAccessToken({ force: true });
      expect(JSON.parse(await readFile(join(home, 'credentials/openai-codex.json'), 'utf8')).refresh_token).toBe('rotated-example');
      expect(await new OAuthDeviceMethods(options).getCachedAccessToken('openai-codex')).toBe(access);
      await reopened.logout('openai-codex');
      expect(await new OAuthDeviceMethods(options).connectionState('openai-codex')).toBe('signed_out');
    } finally { await rm(home, { recursive: true, force: true }); }
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

  it('reads Copilot identity and an actual quota snapshot without returning credentials', async () => {
    const storage = new MemoryTokenStorage();
    await storage.save('github-copilot', {
      accessToken: 'short-lived', refreshToken: 'gho-private', expiresAt: 9999999999,
      scope: 'read:user', tokenType: 'Bearer', expiresIn: 3600,
    });
    const fetchImpl = fakeFetch({
      'https://api.github.com/user': (_url, init) => {
        expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer gho-private');
        return json({ login: 'octocat', email: 'private@example.com' });
      },
      'https://api.github.com/copilot_internal/user': () => json({
        quota_snapshots: { premium_interactions: {
          entitlement: 300, remaining: 75, percent_remaining: 25,
          reset_date: '2026-10-01T00:00:00Z',
        } },
      }),
    });
    const methods = new OAuthDeviceMethods({ homeDir: '/unused', storage, fetchImpl });
    const details = await methods.getAccountDetails('managed:github-copilot');
    expect(details).toEqual({ accountId: 'octocat', quota: {
      label: 'Premium interactions', remaining: 75, unit: 'count', resetAt: '2026-10-01T00:00:00Z',
    } });
    expect(JSON.stringify(details)).not.toContain('gho-private');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns unknown quota when Copilot reports no usable personal allowance', async () => {
    const storage = new MemoryTokenStorage();
    await storage.save('github-copilot', {
      accessToken: 'short-lived', refreshToken: 'gho-private', expiresAt: 9999999999,
      scope: 'read:user', tokenType: 'Bearer', expiresIn: 3600,
    });
    const fetchImpl = fakeFetch({
      'https://api.github.com/user': () => json({ login: 'octocat' }),
      'https://api.github.com/copilot_internal/user': () => json({
        quota_snapshots: { premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 0 } },
      }),
    });
    const methods = new OAuthDeviceMethods({ homeDir: '/unused', storage, fetchImpl });
    expect(await methods.getAccountDetails('github-copilot')).toEqual({ accountId: 'octocat' });
    expect(await methods.getAccountDetails('openai-codex')).toEqual({});
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

  it.each(['openai-codex', 'grok-build'])('keeps %s identity inheritance and explicit selections on model refresh', (id) => {
    const accountMethod = oauthMethodFor(id)!;
    const config: ManagedKimiConfigShape = { providers: {} };
    const refresh = () => applyOAuthMethodConfig(config, accountMethod, { baseUrl: accountMethod.defaultBaseUrl, models });
    refresh();
    refresh();
    expect(config.providers[accountMethod.providerName]).not.toHaveProperty('requestIdentity');
    config.providers[accountMethod.providerName] = { ...config.providers[accountMethod.providerName], requestIdentity: { profile: 'custom:example' } };
    refresh();
    expect(config.providers[accountMethod.providerName]!['requestIdentity']).toEqual({ profile: 'custom:example' });
    const inherited: Record<string, unknown> = { ...config.providers[accountMethod.providerName] };
    delete inherited['requestIdentity'];
    config.providers[accountMethod.providerName] = inherited;
    refresh();
    expect(config.providers[accountMethod.providerName]).not.toHaveProperty('requestIdentity');
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


describe('Grok Build managed device method', () => {
  const access = jwt({ sub: 'user-example', exp: Math.floor(Date.now() / 1000) + 3600 });
  const responseToken = { access_token: access, refresh_token: 'refresh-example', expires_in: 3600 };
  const catalog = { data: [
    { model: 'grok-example', name: 'Grok Example', contextWindow: 256000, apiBackend: 'responses',
      reasoningEfforts: [{ value: 'high', default: true }, { value: 'xhigh' }] },
  ] };

  it('ports the public device grant and provisions the original Build session protocol', async () => {
    const fetchImpl = fakeFetch({
      'https://auth.x.ai/oauth2/device/code': (_url, init) => {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get('client_id')).toBe('b1a00492-073a-47ea-816f-4c329264a828');
        expect(form.get('scope')).toContain('grok-cli:access');
        expect(form.get('referrer')).toBe('kiki');
        return json({ device_code: 'device-example', user_code: 'ABCD-1234', verification_uri: 'https://auth.x.ai/device', expires_in: 300, interval: 5 });
      },
      'https://auth.x.ai/oauth2/token': (_url, init) => {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
        expect(form.get('device_code')).toBe('device-example');
        return json(responseToken);
      },
      'https://cli-chat-proxy.grok.com/v1/models': (_url, init) => {
        expect(init?.headers).toMatchObject({ Authorization: `Bearer ${access}`, 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-userid': 'user-example' });
        return json(catalog);
      },
    });
    const method = createGrokBuildMethod(fetchImpl);
    const device = await method.requestDevice();
    expect(device).toMatchObject({ userCode: 'ABCD-1234', verificationUriComplete: 'https://auth.x.ai/device', interval: 5 });
    expect(await method.pollDevice(device.deviceCode)).toMatchObject({ kind: 'success', token: { refreshToken: 'refresh-example' } });
    const models = await method.listModels(access);
    expect(models[0]).toMatchObject({ id: 'grok-example', protocol: 'openai_responses', contextLength: 256000, supportEfforts: ['high', 'xhigh'], defaultEffort: 'high' });
    const config: ManagedKimiConfigShape = { providers: { api: { type: 'openai', apiKey: 'YOUR_API_KEY' } }, defaultModel: 'api/existing', models: { 'api/existing': { provider: 'api', model: 'existing' } } };
    applyOAuthMethodConfig(config, method, { baseUrl: method.baseUrlFor(access), headers: method.requestHeaders(access), models });
    expect(config.providers['managed:grok-build']).toMatchObject({ baseUrl: 'https://cli-chat-proxy.grok.com/v1', type: 'openai', oauth: { key: 'oauth/grok-build' }, customHeaders: { 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-authenticateresponse': 'authenticate-response', 'x-grok-client-identifier': 'kiki' } });
    expect(config.models?.['grok-build/grok-example']).toMatchObject({ protocol: 'openai_responses' });
    expect(config.defaultModel).toBe('api/existing');
    expect(JSON.stringify(config)).not.toContain(access);
    expect(JSON.stringify(config)).not.toContain('refresh-example');
    clearOAuthMethodConfig(config, method);
    expect(config.providers['api']).toMatchObject({ apiKey: 'YOUR_API_KEY' });
    expect(config.defaultModel).toBe('api/existing');
  });

  it.each([
    ['authorization_pending', 'pending'], ['slow_down', 'pending'],
    ['access_denied', 'denied'], ['authorization_denied', 'denied'], ['expired_token', 'expired'],
  ])('maps %s without forwarding secret server descriptions', async (error, kind) => {
    const method = createGrokBuildMethod(fakeFetch({ 'https://auth.x.ai/oauth2/token': () => json({ error, error_description: 'private-token' }, 400) }));
    const result = await method.pollDevice('device-example');
    expect(result.kind).toBe(kind);
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('retains an unrotated refresh token and reports invalid_grant as reconnect-required', async () => {
    let rejected = false;
    const method = createGrokBuildMethod(fakeFetch({
      'https://auth.x.ai/oauth2/token': (_url, init) => {
        expect(new URLSearchParams(String(init?.body)).get('refresh_token')).toBe('old-example');
        return rejected ? json({ error: 'invalid_grant', error_description: 'old-example' }, 400) : json({ access_token: access, expires_in: 3600 });
      },
    }));
    expect((await method.refresh('old-example')).refreshToken).toBe('old-example');
    rejected = true;
    await expect(method.refresh('old-example')).rejects.toMatchObject({ name: 'OAuthUnauthorizedError' });
  });

  it('rejects unsafe verification URLs and validates poll bounds', async () => {
    const reply = { device_code: 'd', user_code: 'U-CODE', verification_uri: 'file:///private', interval: 'NaN', expires_in: -2 };
    const method = createGrokBuildMethod(fakeFetch({ 'https://auth.x.ai/oauth2/device/code': () => json(reply) }));
    await expect(method.requestDevice()).rejects.toThrow(/http/);
    reply.verification_uri = 'https://auth.x.ai/device';
    expect(await method.requestDevice()).toMatchObject({ expiresIn: 300, interval: 5 });
    reply.user_code = 'BAD\nCODE';
    await expect(method.requestDevice()).rejects.toThrow(/valid fields/);
  });

  it('uses only supported catalog routes and never forwards server supplied credentials', () => {
    expect(parseGrokBuildModels({ data: [
      { id: 'visible', api_backend: 'chat_completions', context_window: 128000 },
      { id: 'hidden', hidden: true },
      { id: 'remote', base_url: 'https://untrusted.example.test/v1', apiKey: 'private-token' },
      { id: 'unsupported', api_backend: 'custom' },
      { id: 'responses', api_backend: 'responses', capabilities: { reasoning_effort: ['low', 'high'], default_reasoning_effort: 'high' } },
    ] }).map((model) => [model.id, model.protocol, model.defaultEffort])).toEqual([
      ['visible', 'openai', undefined], ['responses', 'openai_responses', 'high'],
    ]);
  });

  it('persists fresh and rotated tokens across reopen, preserves Codex layout, and tombstones revoked refresh', async () => {
    const root = resolve('.tmp/oauth-contract');
    await mkdir(root, { recursive: true });
    const home = await mkdtemp(join(root, 'grok-'));
    try {
      const oldHome = join(home, 'kimi-home');
      const newHome = join(home, 'kiki-home');
      const codexStorage = new FileTokenStorage(join(oldHome, 'credentials'));
      await codexStorage.save('openai-codex', { accessToken: 'old-codex-example', refreshToken: 'old-codex-refresh', expiresAt: 9999999999, expiresIn: 3600, tokenType: 'Bearer', scope: '' });
      let rejected = false;
      let refreshCount = 0;
      const fetchImpl = fakeFetch({
        'https://auth.x.ai/oauth2/device/code': () => json({ device_code: 'd', user_code: 'U-CODE', verification_uri: 'https://auth.x.ai/device', interval: 1, expires_in: 300 }),
        'https://auth.x.ai/oauth2/token': (_url, init) => {
          const form = new URLSearchParams(String(init?.body));
          if (form.get('grant_type') === 'refresh_token') {
            refreshCount += 1;
            expect(form.get('refresh_token')).toBe(refreshCount === 1 ? 'refresh-example' : 'rotated-example');
            return rejected ? json({ error: 'invalid_grant' }, 400) : json({ ...responseToken, refresh_token: 'rotated-example' });
          }
          return json(responseToken);
        },
      });
      const options = { homeDir: oldHome, grokHomeDir: newHome, fetchImpl, sleep: async () => {} };
      const first = new OAuthDeviceMethods(options);
      expect(await first.login('grok-build')).toBe(access);
      expect(await first.getCachedAccessToken('openai-codex')).toBe('old-codex-example');
      const reopened = new OAuthDeviceMethods(options);
      expect(await reopened.connectionState('grok-build')).toBe('ready');
      await Promise.all([reopened.tokenProvider('grok-build').getAccessToken({ force: true }), reopened.tokenProvider('grok-build').getAccessToken({ force: true })]);
      expect(refreshCount).toBe(1);
      const stored = JSON.parse(await readFile(join(newHome, 'credentials/grok-build.json'), 'utf8'));
      expect(stored.refresh_token).toBe('rotated-example');
      expect(await codexStorage.load('grok-build')).toBeUndefined();
      expect(await new FileTokenStorage(join(newHome, 'credentials')).load('openai-codex')).toBeUndefined();
      rejected = true;
      await expect(reopened.tokenProvider('grok-build').getAccessToken({ force: true })).rejects.toMatchObject({ name: 'OAuthUnauthorizedError' });
      const afterReopen = new OAuthDeviceMethods(options);
      expect(await afterReopen.connectionState('grok-build')).toBe('reconnect_required');
      expect(await afterReopen.getCachedAccessToken('grok-build')).toBeUndefined();
      await afterReopen.logout('grok-build');
      expect(await new OAuthDeviceMethods(options).connectionState('grok-build')).toBe('signed_out');
      expect((await codexStorage.load('openai-codex'))?.accessToken).toBe('old-codex-example');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('honors expiry and slow_down without silently requesting another code', async () => {
    let now = 1000;
    const sleeps: number[] = [];
    const storage = new MemoryTokenStorage();
    const fetchImpl = fakeFetch({
      'https://auth.x.ai/oauth2/device/code': () => json({ device_code: 'd', user_code: 'U-CODE', verification_uri: 'https://auth.x.ai/device', interval: 1, expires_in: 4 }),
      'https://auth.x.ai/oauth2/token': () => json({ error: 'slow_down' }, 400),
    });
    const methods = new OAuthDeviceMethods({ homeDir: '/unused', storage, fetchImpl, now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms / 1000; }, disableCrossProcessLock: true });
    await expect(methods.login('grok-build')).rejects.toMatchObject({ name: 'DeviceCodeTimeoutError' });
    expect(sleeps).toEqual([1000, 3000]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(storage.tokens.size).toBe(0);
  });

  it('does not persist a late approved token after cancellation', async () => {
    const controller = new AbortController();
    const storage = new MemoryTokenStorage();
    const fetchImpl = fakeFetch({
      'https://auth.x.ai/oauth2/device/code': () => json({ device_code: 'd', user_code: 'U-CODE', verification_uri: 'https://auth.x.ai/device', interval: 1, expires_in: 300 }),
      'https://auth.x.ai/oauth2/token': () => { controller.abort(); return json(responseToken); },
    });
    const methods = new OAuthDeviceMethods({ homeDir: '/unused', storage, fetchImpl, sleep: async () => {}, disableCrossProcessLock: true });
    await expect(methods.login('grok-build', { signal: controller.signal })).rejects.toThrow(/aborted/);
    expect(storage.tokens.size).toBe(0);
  });
});
