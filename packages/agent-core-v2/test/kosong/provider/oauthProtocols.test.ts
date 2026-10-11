import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalOriginalOAuthService, OAuthDeviceMethods, applyOAuthMethodConfig, createOAuthDeviceMethod, type ManagedKimiConfigShape, type TokenInfo, type TokenStorage } from '@kiki/oauth';

import { OpenAILegacyChatProvider } from '#/kosong/provider/bases/openai/openai-legacy';
import { createScopedTestHost } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { IModelCatalog } from '#/kosong/model/catalog';
import '#/kosong/model/catalogService';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IModelOAuthTokens } from '#/kosong/model/modelOAuth';
import { IRequestAdmission } from '#/kosong/model/requestAdmission';
import { IModelService, type ModelsSection } from '#/kosong/model/model';
import '#/kosong/model/modelService';
import { IProviderService, type ProvidersSection } from '#/kosong/provider/provider';
import '#/kosong/provider/providerService';
import '#/kosong/provider/protocolAdapterRegistry';
import '#/kosong/provider/bases/openai/index';
import '#/kosong/provider/bases/anthropic/index';
import { defaultOAuthRequestIdentity, resolveRequestIdentityLayers, type RequestIdentityPolicy } from '#/kosong/requestIdentity/requestIdentityPolicy';
import { projectRequestIdentity } from '#/kosong/requestIdentity/requestIdentityProjector';
import { builtinRequestIdentityProfile, renderRequestIdentityProfile, REQUEST_IDENTITY_TRACK_SEEDS } from '#/kosong/requestIdentity/requestIdentityProfile';
import { StubConfigService } from '../stubs';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function jwt(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function storage(): TokenStorage {
  const tokens = new Map<string, TokenInfo>();
  return {
    load: async (name) => tokens.get(name), save: async (name, token) => { tokens.set(name, token); },
    remove: async (name) => { tokens.delete(name); }, list: async () => [...tokens.keys()],
  };
}

async function requestFromConfig(
  config: ManagedKimiConfigShape,
  getAccessToken: IModelOAuthTokens['getAccessToken'],
  options: { global?: RequestIdentityPolicy; headers?: Record<string, string> } = {},
) {
  const sections = { ...config, requestIdentity: options.global };
  const host = createScopedTestHost([
    [IConfigService, new StubConfigService(sections)],
    [IModelOAuthTokens, { _serviceBrand: undefined, hasCachedAccessToken: async () => true, getAccessToken }],
    [IHostRequestHeaders, { headers: {}, thirdPartyHeaders: {} }],
    [IRequestAdmission, { _serviceBrand: undefined, acquire: async () => ({ release: () => {} }) }],
  ]);
  try {
    host.app.accessor.get(IProviderService).loadAll(config.providers as ProvidersSection, undefined);
    host.app.accessor.get(IModelService).loadAll(config.models as ModelsSection, config.defaultModel);
    const modelId = Object.keys(config.models ?? {})[0]!;
    const requester = host.app.accessor.get(IModelCatalog).getRequester(modelId);
    const provider = (config.providers as ProvidersSection)[requester.model.providerName];
    const policy = resolveRequestIdentityLayers(defaultOAuthRequestIdentity(provider), options.global, provider?.requestIdentity);
    const profile = builtinRequestIdentityProfile(policy.profile);
    const rendered = profile === undefined ? undefined : renderRequestIdentityProfile(profile,
      REQUEST_IDENTITY_TRACK_SEEDS.find((seed) => seed.id === profile.track)?.builtin,
      { kikiVersion: '1.0.0', model: requester.model.name, platform: 'linux', arch: 'x64', osRelease: '6.1' });
    const projection = projectRequestIdentity({
      policy, protocol: requester.model.protocol, model: requester.model.name,
      rawSessionId: 'session-example', rawAgentId: 'agent-example', isKimiProvider: false,
      snapshot: { installationId: 'installation-example', sharedSessionId: 'session-example',
        agentSessionId: 'agent-session-example', threadId: 'thread-example', windowId: 'window-example',
        logicalId: 'turn-example', turnIndex: 1, setTurnState: () => {} },
      runtimeVersion: '1.0.0', platform: 'linux', arch: 'x64', profile: rendered,
    });
    const events = [];
    for await (const event of requester.request({ systemPrompt: 'System example', tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }], toolCalls: [] }] }, undefined, {
      attribution: { sessionId: 'session-example', agentId: 'agent-example', logicalRequestId: 'turn-example', purpose: 'test', waitBudget: { waitedMs: 0 } },
      headers: { ...projection.headers, ...options.headers }, cacheKey: projection.cacheKey, requestIdentity: projection.wire,
    })) events.push(event);
    return events;
  } finally { await host.dispose(); }
}

function responseStream(): Response {
  const events = [
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.completed', response: { id: 'response-example', status: 'completed', usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}

beforeEach(() => vi.stubEnv('OPENAI_API_KEY', ''));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('managed OAuth through the real model request consumers', () => {
  it('uses Codex device exchange, rotated bearer and native streaming Responses route', async () => {
    const access = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-example' } });
    const refreshed = jwt({ generation: 2, 'https://api.openai.com/auth': { chatgpt_account_id: 'account-example' } });
    let inferenceRequests = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith('/deviceauth/usercode')) return json({ device_auth_id: 'device-example', user_code: 'CODE-1234', interval: '1' });
      if (request.url.endsWith('/deviceauth/token')) return json({ authorization_code: 'code-example', code_verifier: 'pkce-example' });
      if (request.url === 'https://auth.openai.com/oauth/token') {
        const form = new URLSearchParams(await request.text());
        if (form.get('grant_type') === 'refresh_token') {
          expect(form.get('refresh_token')).toBe('refresh-example');
          return json({ access_token: refreshed, refresh_token: 'rotated-example', expires_in: 3600 });
        }
        expect(form.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
        return json({ access_token: access, refresh_token: 'refresh-example', expires_in: 3600 });
      }
      expect(request.url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(request.headers.get('authorization')).toBe(`Bearer ${refreshed}`);
      expect(request.headers.get('chatgpt-account-id')).toBe('account-example');
      expect(request.headers.get('originator')).toBe('codex_cli_rs');
      expect(request.headers.get('user-agent')).toMatch(/^codex_cli_rs\/0\.159\.2 /);
      expect(request.headers.get('session-id')).toBe('session-example');
      expect(request.headers.get('thread-id')).toBe('thread-example');
      const body = await request.json() as Record<string, unknown>;
      expect(body['client_metadata']).toMatchObject({ session_id: 'session-example', thread_id: 'thread-example', turn_id: 'turn-example' });
      expect(body).toMatchObject({ model: 'gpt-5.5', store: false, stream: true, instructions: 'System example' });
      expect(body['max_output_tokens']).toBeUndefined();
      inferenceRequests += 1;
      return responseStream();
    });
    vi.stubGlobal('fetch', fetchImpl);
    const methods = new OAuthDeviceMethods({ homeDir: '/unused', storage: storage(), fetchImpl, sleep: async () => {}, disableCrossProcessLock: true });
    await methods.login('openai-codex');
    const method = methods.method('openai-codex');
    const config: ManagedKimiConfigShape = { providers: {} };
    applyOAuthMethodConfig(config, method, { baseUrl: method.baseUrlFor(access), headers: method.requestHeaders(access), models: await method.listModels(access) });
    await methods.tokenProvider('openai-codex').getAccessToken({ force: true });
    const events = await requestFromConfig(config, (provider, _ref, options) => methods.tokenProvider(provider).getAccessToken(options));
    expect(events).toContainEqual({ type: 'part', part: { type: 'text', text: 'Hello' } });
    expect(events).toContainEqual(expect.objectContaining({ type: 'finish', providerFinishReason: 'completed' }));
    expect(inferenceRequests).toBe(1);
    await methods.logout('openai-codex');
    await expect(methods.tokenProvider('openai-codex').getAccessToken()).rejects.toMatchObject({ name: 'OAuthUnauthorizedError' });
    expect(inferenceRequests).toBe(1);
  });

  it('sends a Grok account token to the Build proxy and preserves API-key consumer behavior', async () => {
    const access = jwt({ sub: 'user-example', exp: Math.floor(Date.now() / 1000) + 3600 });
    let inferenceRequests = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      if (request.url === 'https://auth.x.ai/oauth2/device/code') return json({ device_code: 'd', user_code: 'CODE-1234', verification_uri: 'https://auth.x.ai/device', interval: 1, expires_in: 300 });
      if (request.url === 'https://auth.x.ai/oauth2/token') return json({ access_token: access, refresh_token: 'refresh-example', expires_in: 3600 });
      if (request.url === 'https://cli-chat-proxy.grok.com/v1/models') {
        expect(request.headers.get('x-xai-token-auth')).toBe('xai-grok-cli');
        return json({ data: [{ model: 'grok-example', api_backend: 'chat_completions', context_window: 256000 }] });
      }
      if (request.url === 'https://api.x.ai/v1/chat/completions') {
        expect(request.headers.get('authorization')).toBe('Bearer YOUR_API_KEY');
        expect(request.headers.has('x-xai-token-auth')).toBe(false);
      } else {
        expect(request.url).toBe('https://cli-chat-proxy.grok.com/v1/chat/completions');
        expect(request.headers.get('authorization')).toBe(`Bearer ${access}`);
        expect(request.headers.get('x-xai-token-auth')).toBe('xai-grok-cli');
        expect(request.headers.get('x-authenticateresponse')).toBe('authenticate-response');
        expect(request.headers.get('x-grok-client-identifier')).toBe('grok-shell');
        expect(request.headers.get('user-agent')).toBe('grok-shell/1.0.44 (linux; x86_64)');
        expect(request.headers.get('x-grok-session-id')).toBe('agent-session-example');
        expect(request.headers.get('x-grok-req-id')).toBe('turn-example');
        expect(request.headers.get('x-grok-turn-idx')).toBe('1');
      }
      const body = await request.json() as Record<string, unknown>;
      expect(body['model']).toBe('grok-example');
      inferenceRequests += 1;
      return new Response(`data: ${JSON.stringify({ id: 'chat-example', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'chat-example', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const methods = new OAuthDeviceMethods({ homeDir: '/unused', storage: storage(), fetchImpl, sleep: async () => {}, disableCrossProcessLock: true });
    await methods.login('grok-build');
    const method = methods.method('grok-build');
    const models = await method.listModels(access);
    expect(models[0]?.id).toBe('grok-example');
    const config: ManagedKimiConfigShape = { providers: {} };
    applyOAuthMethodConfig(config, method, { baseUrl: method.baseUrlFor(access), headers: method.requestHeaders(access), models });
    const events = await requestFromConfig(config, (provider, _ref, options) => methods.tokenProvider(provider).getAccessToken(options));
    expect(events).toContainEqual({ type: 'part', part: { type: 'text', text: 'Hello' } });
    const apiKeyProvider = new OpenAILegacyChatProvider({ model: 'grok-example', baseUrl: 'https://api.x.ai/v1', apiKey: 'YOUR_API_KEY' });
    for await (const _part of await apiKeyProvider.generate('System example', [], [])) {}
    expect(inferenceRequests).toBe(2);
    await methods.logout('grok-build');
    await expect(methods.tokenProvider('grok-build').getAccessToken()).rejects.toMatchObject({ name: 'OAuthUnauthorizedError' });
  });
});


describe('OAuth runtime authentication survives the selected request identity at final SDK fetch', () => {
  it.each([
    ['openai-codex', 'openai_responses'],
    ['grok-build', 'openai'],
    ['grok-build', 'openai_responses'],
    ['grok-build', 'anthropic'],
  ] as const)('uses the same %s/%s consumer for an injected original access token and none identity', async (id, protocol) => {
    const access = jwt({ sub: 'user-example', exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-example' } });
    const method = createOAuthDeviceMethod(id)!;
    const config: ManagedKimiConfigShape = { providers: {} };
    applyOAuthMethodConfig(config, method, { baseUrl: method.baseUrlFor(access), headers: method.requestHeaders(access),
      models: [{ id: 'model-example', protocol, contextLength: 128000, capabilities: ['tool_use'] }] });
    const paths = { openai: '/chat/completions', openai_responses: '/responses', anthropic: '/messages' };
    const sink = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`${method.baseUrlFor(access)}${paths[protocol]}`);
      expect(request.headers.get('authorization')).toBe(`Bearer ${access}`);
      expect(request.headers.has('user-agent')).toBe(false);
      expect(request.headers.has('session-id')).toBe(false);
      expect(request.headers.has('originator')).toBe(false);
      expect(request.headers.has('x-grok-client-identifier')).toBe(false);
      expect(request.headers.has('x-grok-session-id')).toBe(false);
      expect([...request.headers.keys()].some((name) => name.startsWith('x-kiki-'))).toBe(false);
      if (id === 'openai-codex') {
        expect(request.headers.get('chatgpt-account-id')).toBe('account-example');
        expect(request.headers.has('x-xai-token-auth')).toBe(false);
      } else {
        expect(request.headers.get('x-xai-token-auth')).toBe('xai-grok-cli');
        expect(request.headers.get('x-authenticateresponse')).toBe('authenticate-response');
        expect(request.headers.get('x-userid')).toBe('user-example');
        expect(request.headers.get('x-grok-client-version')).toBe('1.0.45');
        expect(request.headers.has('x-api-key')).toBe(false);
      }
      const body = await request.json() as Record<string, unknown>;
      expect(body).toMatchObject({ model: 'model-example', stream: true });
      expect(body['client_metadata']).toBeUndefined();
      expect(body['prompt_cache_key']).toBeUndefined();
      if (protocol === 'openai_responses') return responseStream();
      if (protocol === 'openai') return new Response('data: {"id":"chat-example","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      const events = [
        { type: 'message_start', message: { id: 'message-example', type: 'message', role: 'assistant', model: 'model-example', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', sink);
    const tokenSource = vi.fn(async () => access);
    const headers: Record<string, string> = id === 'openai-codex'
      ? { Authorization: 'Bearer override-example', 'ChatGPT-Account-Id': 'override-account' }
      : { Authorization: 'Bearer override-example', 'X-XAI-Token-Auth': 'override-mode',
        'x-authenticateresponse': 'override-response', 'x-userid': 'override-user' };
    const events = await requestFromConfig(config, tokenSource, { global: { profile: 'none' }, headers });
    expect(events).toContainEqual({ type: 'part', part: { type: 'text', text: 'Hello' } });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(tokenSource).toHaveBeenCalledWith(method.providerName, { storage: 'file', key: method.oauthKey }, { force: false });
  });

  it('preserves an explicitly selected Grok client version rather than imposing a new version gate', async () => {
    const access = jwt({ sub: 'user-example' });
    const method = createOAuthDeviceMethod('grok-build')!;
    const config: ManagedKimiConfigShape = { providers: {} };
    applyOAuthMethodConfig(config, method, { baseUrl: method.baseUrlFor(access), models: [{ id: 'model-example', protocol: 'openai_responses', contextLength: 1000, capabilities: [] }] });
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      expect(request.headers.get('x-grok-client-version')).toBe('custom-release');
      expect(request.headers.get('x-xai-token-auth')).toBe('xai-grok-cli');
      return responseStream();
    });
    await requestFromConfig(config, async () => access, { headers: { 'x-grok-client-version': 'custom-release' } });
  });

  it.each(['none', 'grok_build', 'codex'])('keeps ordinary API-key auth free of OAuth markers under %s identity', async (profile) => {
    const config: ManagedKimiConfigShape = { providers: { api: {
      type: 'openai_responses', baseUrl: 'https://api.example.test/v1', apiKey: 'YOUR_API_KEY',
    } }, models: { example: { provider: 'api', model: 'model-example', maxContextSize: 1000 } } };
    const tokenSource = vi.fn(async () => { throw new Error('API-key requests must not read OAuth'); });
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://api.example.test/v1/responses');
      expect(request.headers.get('authorization')).toBe('Bearer YOUR_API_KEY');
      for (const header of ['chatgpt-account-id', 'x-xai-token-auth', 'x-authenticateresponse', 'x-userid']) {
        expect(request.headers.has(header)).toBe(false);
      }
      return responseStream();
    });
    await requestFromConfig(config, tokenSource, { global: { profile } });
    expect(tokenSource).not.toHaveBeenCalled();
  });
});

describe('original OAuth storage through the SDK request consumer', () => {
  it.each(['openai-codex', 'grok-build'] as const)('renews original %s in place and sends its bound identity through final fetch', async (id) => {
    const root = join(process.cwd(), '.tmp/original-sdk-fixtures');
    await mkdir(root, { recursive: true });
    const home = await mkdtemp(join(root, 'home-'));
    const now = Math.floor(Date.now() / 1000);
    const codex = id === 'openai-codex';
    const account = codex ? 'account-example' : 'team-example';
    const claims = codex ? { sub: 'user-example', 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_user_id: 'user-example' } }
      : { sub: 'user-example', principalType: 'Team', principalId: account };
    const oldToken = jwt({ ...claims, exp: now + 60 });
    const newToken = jwt({ ...claims, exp: now + 3600, generation: 'rotated' });
    const scope = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
    await writeFile(join(home, 'auth.json'), JSON.stringify(codex ? {
      tokens: { access_token: oldToken, refresh_token: 'original-refresh', id_token: jwt({ sub: 'user-example' }), account_id: account },
    } : { [scope]: { key: oldToken, refresh_token: 'original-refresh', auth_mode: 'oidc', user_id: account,
      principal_type: 'Team', principal_id: account, expires_at: new Date((now + 60) * 1000).toISOString(), create_time: new Date(now * 1000).toISOString() } }));
    let grants = 0;
    let inference = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      if (request.url === (codex ? 'https://auth.openai.com/oauth/token' : 'https://auth.x.ai/oauth2/token')) {
        const form = new URLSearchParams(await request.text());
        expect(form.get('grant_type')).toBe('refresh_token');
        expect(form.get('refresh_token')).toBe('original-refresh');
        if (!codex) expect(form.get('principal_id')).toBe(account);
        grants++;
        return json({ access_token: newToken, refresh_token: 'original-rotated', expires_in: 3600 });
      }
      expect(request.url).toBe(codex ? 'https://chatgpt.com/backend-api/codex/responses' : 'https://cli-chat-proxy.grok.com/v1/chat/completions');
      expect(request.headers.get('authorization')).toBe(`Bearer ${newToken}`);
      if (codex) { expect(request.headers.get('chatgpt-account-id')).toBe(account); expect(request.headers.get('originator')).toBe('codex_cli_rs'); }
      else { expect(request.headers.get('x-xai-token-auth')).toBe('xai-grok-cli'); expect(request.headers.get('x-userid')).toBe(account); expect(request.headers.get('x-grok-client-version')).toBeTruthy(); }
      inference++;
      return codex ? responseStream() : new Response(`data: ${JSON.stringify({ id: 'chat-example', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'chat-example', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const originals = new LocalOriginalOAuthService({ keyring: { load: async () => undefined, save: async () => { throw new Error('unexpected keyring write'); } },
      parseConfig: JSON.parse, fetchImpl, env: {} });
    try {
      const source = (await originals.probe(id, home)).sourceRef!;
      const method = createOAuthDeviceMethod(id)!;
      const config: ManagedKimiConfigShape = { providers: {} };
      applyOAuthMethodConfig(config, method, { baseUrl: method.defaultBaseUrl, models: [{ id: codex ? 'gpt-5.5' : 'grok-example', contextLength: 128000, capabilities: ['tool_use'] }] });
      config.providers[method.providerName] = { ...config.providers[method.providerName], oauth: { storage: 'file', key: method.oauthKey, source } };
      const events = await requestFromConfig(config, (_provider, ref, options) => originals.getAccessToken(ref.source!, options));
      expect(events).toContainEqual({ type: 'part', part: { type: 'text', text: 'Hello' } });
      expect(grants).toBe(1); expect(inference).toBe(1);
      const saved = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
      expect(codex ? saved.tokens.refresh_token : saved[scope].refresh_token).toBe('original-rotated');
      expect(await new LocalOriginalOAuthService({ keyring: { load: async () => undefined, save: async () => {} }, parseConfig: JSON.parse, env: {} }).getAccessToken(source)).toBe(newToken);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
