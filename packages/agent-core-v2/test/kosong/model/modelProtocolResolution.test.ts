import '#/app/requestGovernance/requestGovernanceService';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createScopedTestHost } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { RecipeModelSettingsSchema, applyRecipeModelSettings } from '#/app/recipes/recipeModelSettings';
import { HostRequestHeadersAdapter } from '#/app/kosongConfig/hostRequestHeadersAdapter';
import type { ChatProviderError } from '#/kosong/contract/errors';
import '#/kosong/provider/bases/google-genai/index';
import '#/kosong/provider/bases/openai/index';
import '#/kosong/provider/protocolAdapterRegistry';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';
import { IProviderService, type ProvidersSection } from '#/kosong/provider/provider';
import '#/kosong/provider/providerService';
import { IModelCatalog } from '#/kosong/model/catalog';
import { ModelCatalog } from '#/kosong/model/catalogService';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IModelService, type ModelRecord, type ModelsSection } from '#/kosong/model/model';
import '#/kosong/model/modelService';
import { explainModelAuthOrigin, explainModelEndpointOrigin } from '#/kosong/model/modelAuth';
import { IModelOAuthTokens } from '#/kosong/model/modelOAuth';
import { applyModelSettings } from '#/kosong/model/modelSettings';

import { stubAgentIdentity } from '../../app/agentIdentity/stubs';
import { stubBootstrap } from '../../app/bootstrap/stubs';
import { StubConfigService, stubModelOAuthTokens } from '../stubs';

const HOST_HEADERS = { 'User-Agent': 'kimi-test/1.0' };

function createHost(sections: Record<string, unknown>) {
  const config = new StubConfigService(sections);
  const host = createScopedTestHost([
    [IConfigService, config],
    [IModelOAuthTokens, stubModelOAuthTokens()],
    [IHostRequestHeaders, new HostRequestHeadersAdapter(
      stubBootstrap('/home', {}, { requestHeaders: HOST_HEADERS }),
      stubAgentIdentity({ hostRequestHeaders: HOST_HEADERS }),
    )],
  ]);
  host.app.accessor.get(IProviderService).loadAll(
    (sections['providers'] ?? {}) as ProvidersSection,
    sections['defaultProvider'] as string | undefined,
  );
  host.app.accessor.get(IModelService).loadAll(
    (sections['models'] ?? {}) as ModelsSection,
    sections['defaultModel'] as string | undefined,
  );
  return { host, catalog: host.app.accessor.get(IModelCatalog) as ModelCatalog };
}

const gatewayProvider = {
  type: 'openai',
  apiKey: 'fixture-gateway-key',
  baseUrl: 'https://provider.example.test/v1',
};
const gatewayModel: ModelRecord = {
  provider: 'edge',
  model: 'gemini-example',
  protocol: 'google-genai',
  baseUrl: 'https://model.example.test/gemini',
  maxContextSize: 8192,
};

function gatewayHost() {
  return createHost({
    providers: { edge: gatewayProvider },
    models: { gemini: gatewayModel, chat: { provider: 'edge', model: 'chat-example', maxContextSize: 8192 } },
  });
}

describe('model protocol resolution', () => {
  it('uses the explicit model protocol, model endpoint, and provider account together', async () => {
    const { host, catalog } = gatewayHost();
    try {
      const view = catalog.inspect('gemini');
      expect(view.resolved.protocol).toBe('google-genai');
      expect(view.resolved.protocolSource).toBe('model');
      expect(view.sources['resolved.protocol']?.detail).toBe('model.protocol');
      expect(view.resolved.baseUrl).toBe('https://model.example.test/gemini');
      expect(view.sources['resolved.baseUrl']?.detail).toBe('model.baseUrl');
      expect(view.resolved.auth.kind).toBe('apiKey');
      expect(view.sources['resolved.auth']?.detail).toBe("provider 'edge' apiKey");
      expect(explainModelEndpointOrigin(gatewayModel, gatewayProvider)).toEqual({
        source: 'model',
        baseUrl: 'https://model.example.test/gemini',
      });
      expect(explainModelAuthOrigin(gatewayModel, gatewayProvider)).toEqual({ source: 'provider' });
      const listed = (await catalog.listModels()).find((item) => item.id === 'gemini');
      expect(listed).toMatchObject({
        effective_protocol: 'google-genai',
        protocol_source: 'model',
        endpoint_source: 'model',
        auth_source: 'provider',
      });
      expect(listed).not.toHaveProperty('endpoint_env');
      expect(listed).not.toHaveProperty('auth_env');
      expect(JSON.stringify(listed)).not.toContain('fixture-gateway-key');
      expect(JSON.stringify(listed)).not.toContain('https://');
      expect(view.resolved.providerType).toBe('openai');
      expect(catalog.get('gemini').protocol).toBe('google-genai');
      expect(catalog.getRequester('gemini').model.protocol).toBe('google-genai');
      expect(catalog.getRequester('gemini').model.baseUrl).toBe('https://model.example.test/gemini');
    } finally { void host.dispose(); }
  });

  it('keeps a model endpoint when the model does not set a protocol', () => {
    const { host, catalog } = createHost({
      providers: { edge: gatewayProvider },
      models: {
        located: { provider: 'edge', model: 'chat-example', baseUrl: 'https://model.example.test/v1', maxContextSize: 8192 },
      },
    });
    try {
      const view = catalog.inspect('located');
      expect(view.resolved.protocol).toBe('openai');
      expect(view.resolved.protocolSource).toBe('provider');
      expect(view.resolved.baseUrl).toBe('https://model.example.test/v1');
      expect(view.resolved.baseUrl).not.toBe(gatewayProvider.baseUrl);
      expect(view.sources['resolved.baseUrl']?.detail).toBe('model.baseUrl');
      expect(explainModelEndpointOrigin(
        { baseUrl: 'https://model.example.test/v1' },
        gatewayProvider,
      )).toEqual({ source: 'model', baseUrl: 'https://model.example.test/v1' });
      expect(view.resolved.auth.kind).toBe('apiKey');
      expect(view.sources['resolved.auth']?.detail).toBe("provider 'edge' apiKey");
    } finally { void host.dispose(); }
  });

  it('inherits a provider wire and a vendor base without replacing an explicit sibling', () => {
    const { host, catalog } = createHost({
      providers: {
        edge: gatewayProvider,
        kimi: { type: 'kimi', apiKey: 'fixture-kimi-key' },
      },
      models: {
        chat: { provider: 'edge', model: 'chat-example', maxContextSize: 8192 },
        gemini: gatewayModel,
        kimi: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 8192 },
      },
    });
    try {
      expect(catalog.inspect('chat').resolved).toMatchObject({ protocol: 'openai', protocolSource: 'provider' });
      expect(catalog.inspect('chat').sources['resolved.protocol']?.detail).toContain('provider type');
      expect(catalog.inspect('gemini').resolved).toMatchObject({ protocol: 'google-genai', protocolSource: 'model' });
      expect(catalog.inspect('kimi').resolved).toMatchObject({ protocol: 'openai', protocolSource: 'vendor' });
      expect(catalog.inspect('kimi').sources['resolved.protocol']?.detail).toContain('baseProtocol');
      const connection = catalog.getConnectionRequester('edge', 'remote-name', 8192);
      expect(connection.model.protocol).toBe('openai');
      expect(connection.model.baseUrl).toBe('https://provider.example.test/v1');
    } finally { void host.dispose(); }
  });

  it('keeps the provider oauth account when the wire protocol differs', () => {
    const { host, catalog } = createHost({
      providers: {
        edge: { type: 'openai', baseUrl: 'https://provider.example.test/v1', oauth: { storage: 'file', key: 'edge-account' } },
      },
      models: { gemini: { ...gatewayModel } },
    });
    try {
      const view = catalog.inspect('gemini');
      expect(view.resolved.protocol).toBe('google-genai');
      expect(view.resolved.protocolSource).toBe('model');
      expect(view.resolved.baseUrl).toBe('https://model.example.test/gemini');
      expect(view.resolved.auth).toEqual({ kind: 'oauth', oauthProviderKey: 'edge' });
      expect(explainModelAuthOrigin(gatewayModel, { type: 'openai', oauth: { storage: 'file', key: 'edge-account' } })).toEqual({ source: 'provider' });
      expect(view.sources['resolved.auth']?.detail).toBe("provider 'edge' oauth");
    } finally { void host.dispose(); }
  });

  it('looks up the provider account env key, not the wire protocol vendor key', () => {
    const { host, catalog } = createHost({
      providers: {
        edge: {
          type: 'openai',
          baseUrl: 'https://provider.example.test/v1',
          env: { OPENAI_API_KEY: 'fixture-openai-env', GOOGLE_API_KEY: 'fixture-google-env' },
        },
      },
      models: { gemini: { ...gatewayModel } },
    });
    try {
      const view = catalog.inspect('gemini');
      expect(view.resolved.protocolSource).toBe('model');
      expect(view.resolved.auth.kind).toBe('apiKey');
      expect(view.sources['resolved.auth']?.detail).toContain('OPENAI_API_KEY');
      expect(view.sources['resolved.auth']?.detail).not.toContain('GOOGLE_API_KEY');
      const origin = explainModelAuthOrigin(gatewayModel, {
        type: 'openai',
        env: { OPENAI_API_KEY: 'fixture-openai-env', GOOGLE_API_KEY: 'fixture-google-env' },
      });
      expect(origin).toEqual({ source: 'env', envName: 'OPENAI_API_KEY' });
      expect(JSON.stringify(origin)).not.toContain('fixture-openai-env');
      expect(JSON.stringify(origin)).not.toContain('fixture-google-env');
    } finally { void host.dispose(); }
  });

  it('keeps an explicit route under a legal recipe and records a raw routing overlay', () => {
    const { host, catalog } = gatewayHost();
    try {
      const legal = catalog.get('gemini', { displayName: 'Recipe label' });
      expect(legal.protocol).toBe('google-genai');
      expect(legal.baseUrl).toBe('https://model.example.test/gemini');
      expect(legal.displayName).toBe('Recipe label');
      expect(applyRecipeModelSettings(gatewayModel, { displayName: 'Recipe label' }).protocol).toBe('google-genai');
      expect(RecipeModelSettingsSchema.safeParse({ protocol: 'openai', baseUrl: 'https://other.example.test', provider: 'other' }).success).toBe(false);

      const overlaid = applyModelSettings(gatewayModel, { protocol: 'openai', baseUrl: 'https://other.example.test', provider: 'other' });
      expect(gatewayModel.protocol).toBe('google-genai');
      expect(overlaid.protocol).toBe('openai');
      expect(overlaid.baseUrl).toBe('https://other.example.test');
      expect(overlaid.provider).toBe('other');
      expect(catalog.get('gemini', { protocol: 'openai' }).protocol).toBe('openai');
    } finally { void host.dispose(); }
  });
});

describe('offline SDK 429 envelopes', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  async function rejectOnce(catalog: ModelCatalog, id: string): Promise<ChatProviderError> {
    try {
      for await (const event of catalog.getRequester(id).request(
        { systemPrompt: 'System example', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }], toolCalls: [] }] },
        undefined,
        { maxCompletionTokens: 16, attribution: { logicalRequestId: 'fixture-request', sessionId: 'fixture-session', agentId: 'main', purpose: 'test', waitBudget: { waitedMs: 0 } } },
      )) void event;
    } catch (error) {
      return error as ChatProviderError;
    }
    throw new Error('expected the stub to reject');
  }

  it('classifies a native Gemini 429 without another adapter label', async () => {
    const seen: Array<{ hostname: string; pathname: string }> = [];
    vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      seen.push({ hostname: url.hostname, pathname: url.pathname });
      return Promise.resolve(new Response(JSON.stringify({ error: { code: 429, message: 'quota fixture', status: 'RESOURCE_EXHAUSTED' } }), { status: 429, headers: { 'Content-Type': 'application/json' } }));
    });
    const { host, catalog } = createHost({
      providers: { gemini: { type: 'google-genai', apiKey: 'fixture-gemini-key' } },
      models: { native: { provider: 'gemini', model: 'gemini-2.5-flash', protocol: 'google-genai', maxContextSize: 8192 } },
    });
    try {
      const error = await rejectOnce(catalog, 'native');
      expect(seen[0]).toEqual({ hostname: 'generativelanguage.googleapis.com', pathname: '/v1beta/models/gemini-2.5-flash:streamGenerateContent' });
      expect(error).toMatchObject({ statusCode: 429, code: 'provider.rate_limit' });
      expect(error.message).not.toContain('Anthropic error:');
      expect(error.message).not.toContain('GoogleGenAI error:');
      expect(error.message).toContain('quota fixture');
    } finally { await host.dispose(); }
  });

  it('classifies an axon-style Responses 429 without another adapter label', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      seen.push(request.url);
      return Promise.resolve(new Response(JSON.stringify({ error: { message: 'quota fixture', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'Content-Type': 'application/json' } }));
    });
    const { host, catalog } = createHost({
      providers: { axon: { type: 'openai_responses', apiKey: 'fixture-axon-key', baseUrl: 'https://axon.example.test/v1' } },
      models: { flash: { provider: 'axon', model: 'example-responses', maxContextSize: 8192 } },
    });
    try {
      const error = await rejectOnce(catalog, 'flash');
      expect(seen[0]).toBe('https://axon.example.test/v1/responses');
      expect(error).toMatchObject({ statusCode: 429, code: 'provider.rate_limit' });
      expect(error.message).not.toContain('Anthropic error:');
      expect(error.message).not.toContain('GoogleGenAI error:');
      expect(error.message).toContain('quota fixture');
    } finally { await host.dispose(); }
  });
});
