import '#/app/requestGovernance/requestGovernanceService';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createScopedTestHost } from '#/_base/di/test';
import { isErrorCode } from '#/_base/errors/codes';
import { isError2 } from '#/_base/errors/errors';
import { IConfigService } from '#/app/config/config';
import { ConfigErrors } from '#/app/config/errors';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import type { ChatProvider } from '#/kosong/contract/provider';
import { emptyUsage } from '#/kosong/contract/usage';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import '#/kosong/provider/bases/anthropic/index';
import '#/kosong/provider/bases/google-genai/index';
import '#/kosong/provider/bases/openai/index';
import '#/kosong/provider/protocolAdapterRegistry';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';
import {
  IProviderService,
  type ProviderConfig,
  type ProvidersSection,
} from '#/kosong/provider/provider';
import '#/kosong/provider/providerService';
import {
  globalDefaultForProvider,
  IModelCatalog,
  type Model,
  modelIdsForProvider,
  toProtocolModel,
  toProtocolModelFallback,
  toProtocolProvider,
} from '#/kosong/model/catalog';
import { ModelCatalog } from '#/kosong/model/catalogService';
import '#/kosong/model/modelService';
import '#/kosong/model/errors';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IModelService, type ModelRecord, type ModelsSection } from '#/kosong/model/model';
import { IModelOAuthTokens } from '#/kosong/model/modelOAuth';

import { HostRequestHeadersAdapter } from '#/app/kosongConfig/hostRequestHeadersAdapter';

import { StubConfigService, stubModelOAuthTokens, stubTokenProvider } from '../stubs';
import { stubAgentIdentity } from '../../app/agentIdentity/stubs';
import { stubBootstrap } from '../../app/bootstrap/stubs';

const HOST_HEADERS = { 'User-Agent': 'kimi-test/1.0', 'X-Msh-Device-Id': 'device-1' };

function hostHeadersPort(spec: {
  headers: Record<string, string>;
  identitySlug?: string;
}): IHostRequestHeaders {
  return new HostRequestHeadersAdapter(
    stubBootstrap('/home', {}, { requestHeaders: spec.headers }),
    stubAgentIdentity({ slug: spec.identitySlug, hostRequestHeaders: spec.headers }),
  );
}

function createHost(
  sections: Record<string, unknown> = {},
  oauthTokens: IModelOAuthTokens = stubModelOAuthTokens(),
  hostHeaders: { headers: Record<string, string>; identitySlug?: string } = {
    headers: HOST_HEADERS,
  },
): {
  host: ReturnType<typeof createScopedTestHost>;
  config: StubConfigService;
  catalog: ModelCatalog;
  models: IModelService;
  providers: IProviderService;
} {
  const config = new StubConfigService(sections);
  const host = createScopedTestHost([
    [IConfigService, config],
    [IModelOAuthTokens, oauthTokens],
    [IHostRequestHeaders, hostHeadersPort(hostHeaders)],
  ]);
  const providers = host.app.accessor.get(IProviderService);
  providers.loadAll(
    (sections['providers'] ?? {}) as ProvidersSection,
    sections['defaultProvider'] as string | undefined,
  );
  const models = host.app.accessor.get(IModelService);
  models.loadAll(
    (sections['models'] ?? {}) as ModelsSection,
    sections['defaultModel'] as string | undefined,
  );
  return {
    host,
    config,
    catalog: host.app.accessor.get(IModelCatalog) as ModelCatalog,
    models,
    providers,
  };
}

const kimiSections: Record<string, unknown> = {
  providers: {
    kimi: { type: 'kimi', apiKey: 'sk-test', baseUrl: 'https://api.moonshot.ai/v1' },
  },
  models: {
    k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 262144 },
  },
};

function silentModelWrite(models: IModelService, records: Record<string, ModelRecord>): void {
  (models as unknown as { models: Record<string, ModelRecord> }).models = records;
}

let savedCustomHeaders: string | undefined;

beforeEach(() => {
  savedCustomHeaders = process.env['KIKI_CODE_CUSTOM_HEADERS'];
  delete process.env['KIKI_CODE_CUSTOM_HEADERS'];
});

afterEach(() => {
  if (savedCustomHeaders === undefined) delete process.env['KIKI_CODE_CUSTOM_HEADERS'];
  else process.env['KIKI_CODE_CUSTOM_HEADERS'] = savedCustomHeaders;
});

describe('Model assembly (pure data)', () => {
  it('routes sibling model protocol overrides through real SDK payloads, streams and errors without changing the provider', async () => {
    const provider = { type: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key', requestIdentity: { preset: 'none' as const } };
    const common = { provider: 'edge', model: 'gpt-5', maxContextSize: 8192, capabilities: ['thinking', 'tool_use'], supportEfforts: ['high'], adaptiveThinking: true };
    const records: ModelsSection = {
      chat: { ...common }, responses: { ...common, protocol: 'openai_responses' }, messages: { ...common, protocol: 'anthropic' },
    };
    const { host, catalog, models, providers } = createHost({ providers: { edge: provider }, models: records, defaultModel: 'chat', defaultProvider: 'edge' });
    const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
    let fail = false;
    const sse = (events: Array<Record<string, unknown>>) => new Response(events.map((event) => `event: ${event['type'] as string}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    const sink = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      const body = await request.json() as Record<string, unknown>;
      captured.push({ url: request.url, body });
      expect(request.method).toBe('POST');
      expect(request.headers.get(request.url.endsWith('/messages') ? 'x-api-key' : 'authorization')).toBe(request.url.endsWith('/messages') ? 'fixture-key' : 'Bearer fixture-key');
      expect(body).toMatchObject({ model: 'gpt-5', stream: true });
      expect(body['requestIdentity']).toBeUndefined(); expect(body['protocol']).toBeUndefined();
      if (fail) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'This endpoint does not support the selected protocol' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (request.url.endsWith('/chat/completions')) {
        expect(body['messages']).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user' })]));
        expect(body['input']).toBeUndefined();
        expect(body['tools']).toEqual([expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'lookup' }) })]);
        expect(body['reasoning_effort']).toBe('high');
        return new Response('data: {"id":"chat-example","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (request.url.endsWith('/responses')) {
        expect(body['input']).toEqual(expect.any(Array)); expect(body['messages']).toBeUndefined();
        expect(body['tools']).toEqual([expect.objectContaining({ type: 'function', name: 'lookup' })]);
        expect(body['reasoning']).toMatchObject({ effort: 'high' });
        return sse([
          { type: 'response.output_text.delta', delta: 'Hello' },
          { type: 'response.completed', response: { id: 'response-example', status: 'completed', usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
        ]);
      }
      expect(request.url).toBe('https://example.test/v1/messages');
      expect(body['system']).toBeDefined(); expect(body['input']).toBeUndefined();
      expect(body['tools']).toEqual([expect.objectContaining({ name: 'lookup', input_schema: expect.any(Object) })]);
      expect(body['thinking']).toMatchObject({ type: 'adaptive' }); expect(body['output_config']).toMatchObject({ effort: 'high' });
      return sse([
        { type: 'message_start', message: { id: 'message-example', type: 'message', role: 'assistant', model: 'gpt-5', content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]);
    });
    vi.stubGlobal('fetch', sink);
    const request = async (id: string) => {
      const events = [];
      for await (const event of catalog.getRequester(id).request({ systemPrompt: 'System example', tools: [{ name: 'lookup', description: 'Look up a value', parameters: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }], toolCalls: [] }] }, undefined, { thinkingEffort: 'high', maxCompletionTokens: 64, attribution: { logicalRequestId: 'fixture-request', sessionId: 'fixture-session', agentId: 'main', purpose: 'test', waitBudget: { waitedMs: 0 } } })) events.push(event);
      return events;
    };
    try {
      for (const id of ['chat', 'responses', 'messages']) {
        const events = await request(id);
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'part', part: { type: 'text', text: 'Hello' } }),
          expect.objectContaining({ type: 'usage', usage: { inputOther: 3, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } }),
          expect.objectContaining({ type: 'finish', providerFinishReason: 'completed' }),
        ]));
        expect(catalog.get(id).capabilities).toMatchObject({ thinking: true, tool_use: true });
      }
      expect(captured.map((call) => call.url)).toEqual(['https://example.test/v1/chat/completions', 'https://example.test/v1/responses', 'https://example.test/v1/messages']);
      const items = await catalog.listModels();
      expect(items.find((item) => item.id === 'chat')).toMatchObject({ effective_protocol: 'openai' });
      expect(items.find((item) => item.id === 'chat')?.protocol).toBeUndefined();
      expect(items.find((item) => item.id === 'responses')).toMatchObject({ protocol: 'openai_responses', effective_protocol: 'openai_responses' });
      expect(catalog.inspect('responses').resolved.protocol).toBe('openai_responses');
      expect(providers.get('edge')).toEqual(provider); expect(models.getDefaultModel()).toBe('chat');
      fail = true;
      for (const id of ['chat', 'responses', 'messages']) {
        const count = captured.length;
        await expect(request(id)).rejects.toMatchObject({ statusCode: 400 });
        expect(captured.length).toBe(count + 1);
      }
      models.loadAll({ ...records, responses: { ...common } }, 'chat');
      expect(catalog.get('responses').protocol).toBe('openai');
    } finally { vi.unstubAllGlobals(); await host.dispose(); }
  });
  it('projects Kiki question behavior in catalog but never into provider creation or generation requests', async () => {
    const record: ModelRecord = { provider: 'edge', model: 'remote', maxContextSize: 8192, behavior: { askUserQuestionGuard: { enabled: true, maxPerWindow: 4 } }, parameters: { temperature: 0 } };
    const { host, catalog } = createHost({ providers: { edge: { type: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'test-token' } }, models: { fast: record } });
    const generate = vi.fn(async (..._args: unknown[]) => { throw new Error('test sink'); });
    const factory = vi.spyOn(host.app.accessor.get(IProtocolAdapterRegistry), 'createChatProvider').mockReturnValue({ name: 'test', modelName: 'remote', thinkingEffort: null, generate } as unknown as ChatProvider);
    try {
      expect(toProtocolModelFallback('fast', record).behavior).toEqual({ ask_user_question_guard: { enabled: true, max_per_window: 4 } });
      await expect(async () => {
        for await (const event of catalog.getRequester('fast').request({ systemPrompt: '', tools: [], messages: [] }, undefined, { attribution: { logicalRequestId: 'test', purpose: 'connectivity_probe', waitBudget: { waitedMs: 0 } } })) void event;
      }).rejects.toThrow('test sink');
      expect(generate).toHaveBeenCalledOnce();
      expect(JSON.stringify(factory.mock.calls)).not.toMatch(/ask.?user.?question|behavior|maxPerWindow|window_ms/i);
      expect(JSON.stringify(generate.mock.calls)).not.toMatch(/ask.?user.?question|behavior|maxPerWindow|window_ms/i);
    } finally { factory.mockRestore(); await host.dispose(); }
  });
  it('uses an inline configured static key through the normal model request sink', async () => {
    const sections = {
      providers: { gateway: { type: 'openai', baseUrl: 'https://gateway.example.test/v1', apiKey: 'sk-stored' } },
      models: { m1: { provider: 'gateway', model: 'remote', maxContextSize: 4096 } },
    };
    const { host, catalog } = createHost(sections);
    const generate = vi.fn(async (..._args: unknown[]) => { throw new Error('fake network sink'); });
    const factory = vi.spyOn(host.app.accessor.get(IProtocolAdapterRegistry), 'createChatProvider').mockReturnValue({
      name: 'fake', modelName: 'remote', thinkingEffort: null, generate,
    } as unknown as ChatProvider);
    try {
      const requester = catalog.getRequester('m1');
      await expect(async () => {
        for await (const _event of requester.request({ systemPrompt: '', tools: [], messages: [] }, undefined, { attribution: { logicalRequestId: 'probe', purpose: 'connectivity_probe', waitBudget: { waitedMs: 0 } } })) { void _event; }
      }).rejects.toThrow('fake network sink');
      expect(generate).toHaveBeenCalledOnce();
      expect(generate.mock.calls[0]?.[3]).toMatchObject({ auth: { apiKey: 'sk-stored' } });
    } finally { factory.mockRestore(); await host.dispose(); }
  });

  it.each([
    { label: 'explicit runtime variable', provider: { apiKeyEnv: 'EXAMPLE_PROVIDER_KEY' }, model: {}, expected: 'runtime-fixture' },
    { label: 'provider env bag', provider: { apiKeyEnv: 'EXAMPLE_PROVIDER_KEY', env: { EXAMPLE_PROVIDER_KEY: 'bag-fixture' } }, model: {}, expected: 'bag-fixture' },
    { label: 'inline provider precedence', provider: { apiKey: 'inline-fixture', apiKeyEnv: 'EXAMPLE_PROVIDER_KEY' }, model: {}, expected: 'inline-fixture' },
    { label: 'model precedence', provider: { apiKey: 'inline-fixture', apiKeyEnv: 'EXAMPLE_PROVIDER_KEY' }, model: { apiKey: 'model-fixture' }, expected: 'model-fixture' },
  ])('resolves $label through the normal model request sink', async ({ provider, model, expected }) => {
    vi.stubEnv('EXAMPLE_PROVIDER_KEY', 'runtime-fixture');
    const { host, catalog } = createHost({
      providers: { gateway: { type: 'openai', baseUrl: 'https://gateway.example.test/v1', ...provider } },
      models: { m1: { provider: 'gateway', model: 'remote', maxContextSize: 4096, ...model } },
    });
    const generate = vi.fn(async (..._args: unknown[]) => { throw new Error('fake network sink'); });
    const factory = vi.spyOn(host.app.accessor.get(IProtocolAdapterRegistry), 'createChatProvider').mockReturnValue({
      name: 'fake', modelName: 'remote', thinkingEffort: null, generate,
    } as unknown as ChatProvider);
    try {
      await expect(async () => {
        for await (const event of catalog.getRequester('m1').request({ systemPrompt: '', tools: [], messages: [] }, undefined, { attribution: { logicalRequestId: 'fixture', purpose: 'connectivity_probe', waitBudget: { waitedMs: 0 } } })) void event;
      }).rejects.toThrow('fake network sink');
      expect(generate.mock.calls[0]?.[3]).toMatchObject({ auth: { apiKey: expected } });
      const wire = (await catalog.listModels())[0];
      expect(wire).toMatchObject({ auth_source: model.apiKey === undefined ? provider.apiKey === undefined ? 'env' : 'provider' : 'model' });
      expect(JSON.stringify(wire)).not.toContain(expected);
    } finally { factory.mockRestore(); await host.dispose(); vi.unstubAllEnvs(); }
  });

  it('suppresses process environment API keys when composing a model without configured auth', async () => {
    const previous = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-process-env-must-not-leak';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { host, catalog } = createHost({
      providers: { gateway: { type: 'openai', baseUrl: 'https://api.example.test/v1' } },
      models: { m1: { provider: 'gateway', model: 'gpt-4o', maxContextSize: 4096 } },
    });
    try {
      const requester = catalog.getRequester('m1');
      await expect(async () => {
        for await (const _event of requester.request({ systemPrompt: '', tools: [], messages: [] }, undefined, { attribution: { logicalRequestId: 'probe', purpose: 'connectivity_probe', waitBudget: { waitedMs: 0 } } })) { void _event; }
      }).rejects.toThrow(/apiKey is required/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
      vi.unstubAllGlobals();
      if (previous === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previous;
    }
  });

  it('preserves the model service tier in assembly and catalog wire projections', async () => {
    const record: ModelRecord = { provider: 'kimi', model: 'example', maxContextSize: 1000, serviceTier: 'priority' };
    const { host, catalog } = createHost({ ...kimiSections, models: { tiered: record } });
    try {
      expect(catalog.get('tiered').serviceTier).toBe('priority');
      expect(catalog.inspect('tiered').resolved.serviceTier).toBe('priority');
      expect(catalog.inspect('tiered').sources['resolved.serviceTier']).toMatchObject({ kind: 'config' });
      expect(toProtocolModelFallback('tiered', record).service_tier).toBe('priority');
      expect(await catalog.listModels()).toContainEqual(expect.objectContaining({ id: 'tiered', service_tier: 'priority' }));
    } finally {
      await host.dispose();
    }
  });

  it('resolves provider defaults beneath model preferences with traceable per-field sources', async () => {
    const { host, catalog } = createHost({
      providers: { gateway: { type: 'openai', baseUrl: 'https://example.test/v1', defaults: {
        temperature: 0, topP: 0.8, maxCompletionTokens: 8192, thinkingEffort: 'low', serviceTier: 'priority',
      } } },
      models: {
        custom: { provider: 'gateway', model: 'same-remote', maxContextSize: 200000,
          parameters: { maxCompletionTokens: 16384, topP: { kind: 'api_default' }, thinkingEffort: 'high' } },
        inherited: { provider: 'gateway', model: 'same-remote', maxContextSize: 200000 },
      },
    });
    try {
      const custom = catalog.get('custom');
      expect(custom.maxCompletionTokens).toBe(16384);
      expect(custom.generationParameters).toMatchObject({ temperature: 0, topP: { kind: 'api_default' }, thinkingEffort: 'high' });
      expect(custom.preferredThinkingEffort).toBe('high');
      expect(catalog.get('inherited').maxCompletionTokens).toBe(8192);
      expect(catalog.get('inherited').preferredThinkingEffort).toBe('low');
      const inspection = catalog.inspect('custom');
      expect(inspection.resolved.generationParameters).toEqual(custom.generationParameters);
      expect(inspection.sources['resolved.generationParameters.temperature']?.detail).toBe('[providers.*.defaults]');
      expect(inspection.sources['resolved.generationParameters.maxCompletionTokens']?.detail).toBe('[models.*.parameters]');
      expect((await catalog.listProviders())[0]?.defaults?.temperature).toBe(0);
    } finally { await host.dispose(); }
  });

  it('keeps explicit legacy model preferences above new provider defaults until migrated', async () => {
    const { host, catalog } = createHost({
      providers: { gateway: { type: 'openai', baseUrl: 'https://example.test/v1', defaults: {
        temperature: 0.9, topP: 0.8, maxCompletionTokens: 8192,
      } } },
      models: { legacy: { provider: 'gateway', model: 'legacy', maxContextSize: 200000,
        maxCompletionTokens: 4096, requestParams: { temperature: 0.3 },
        overrides: { maxCompletionTokens: 6144, requestParams: { temperature: 0.4 } },
        parameters: { topP: { kind: 'api_default' } },
      } },
    });
    try {
      const model = catalog.get('legacy');
      expect(model.maxCompletionTokens).toBe(6144);
      expect(model.generationParameters?.temperature).toBe(0.4);
      expect(model.generationParameters?.topP).toEqual({ kind: 'api_default' });
      expect(catalog.inspect('legacy').sources['resolved.generationParameters.temperature']?.detail)
        .toBe('[models.*.overrides] legacy generation fields');
    } finally { await host.dispose(); }
  });

  it('drops an old effort invalidated by override support without forgiving a new explicit invalid effort', async () => {
    const { host, catalog } = createHost({
      providers: { gateway: { type: 'openai', baseUrl: 'https://example.test/v1' } },
      models: {
        legacy: { provider: 'gateway', model: 'plain', maxContextSize: 20000,
          capabilities: ['thinking'], defaultEffort: 'high', supportEfforts: ['low', 'high'],
          overrides: { supportEfforts: ['low'] } },
        explicit: { provider: 'gateway', model: 'plain', maxContextSize: 20000,
          capabilities: ['thinking'], defaultEffort: 'high', supportEfforts: ['low', 'high'],
          overrides: { supportEfforts: ['low'] }, parameters: { thinkingEffort: 'high' } },
      },
    });
    try {
      expect(catalog.get('legacy').generationParameters?.thinkingEffort).toBeUndefined();
      expect(catalog.get('legacy').preferredThinkingEffort).toBeUndefined();
      expect(() => catalog.get('explicit')).toThrow('does not support thinking effort');
    } finally { await host.dispose(); }
  });

  it('rejects known unsupported or forced-off thinking preferences but leaves unknown effort claims unverified', async () => {
    const { host, catalog } = createHost({
      providers: { gateway: { type: 'openai', baseUrl: 'https://example.test/v1' } },
      models: {
        forced: { provider: 'gateway', model: 'forced', maxContextSize: 20000,
          capabilities: ['always_thinking'], parameters: { thinkingEffort: 'off' } },
        known: { provider: 'gateway', model: 'known', maxContextSize: 20000,
          capabilities: ['thinking'], supportEfforts: ['low'], parameters: { thinkingEffort: 'high' } },
        unknown: { provider: 'gateway', model: 'unknown', maxContextSize: 20000,
          capabilities: ['thinking'], parameters: { thinkingEffort: 'custom' } },
      },
    });
    try {
      expect(() => catalog.get('forced')).toThrow('requires thinking');
      expect(() => catalog.get('known')).toThrow('does not support thinking effort');
      expect(catalog.get('unknown').preferredThinkingEffort).toBe('custom');
    } finally { await host.dispose(); }
  });

  it('resolves provider image defaults with field-level model overrides', async () => {
    const { host, catalog } = createHost({
      providers: {
        gateway: {
          type: 'openai',
          apiKey: 'sk-test',
          baseUrl: 'https://example.test/v1',
          images: {
            acceptedTypes: ['image/jpeg', 'image/png'],
            convertUnsupported: 'auto',
          },
        },
      },
      models: {
        vision: {
          provider: 'gateway',
          model: 'vision-1',
          maxContextSize: 128000,
          images: { acceptedTypes: ['image/png'] },
        },
      },
    });
    try {
      expect(catalog.get('vision').imagePolicy).toEqual({
        acceptedTypes: new Set(['image/png']),
        convertUnsupported: 'auto',
      });
      expect(catalog.inspect('vision').resolved.imagePolicy).toEqual({
        acceptedTypes: new Set(['image/png']),
        convertUnsupported: 'auto',
      });
    } finally {
      await host.dispose();
    }
  });

  it('rejects a fixed conversion target outside the effective accepted set', async () => {
    const { host, catalog } = createHost({
      providers: {
        gateway: { type: 'openai', apiKey: 'sk-test', baseUrl: 'https://example.test/v1' },
      },
      models: {
        vision: {
          provider: 'gateway',
          model: 'vision-1',
          maxContextSize: 128000,
          images: { acceptedTypes: ['image/jpeg'], convertUnsupported: 'png' },
        },
      },
    });
    try {
      expect(() => catalog.get('vision')).toThrow(/requires image\/png/);
    } finally {
      await host.dispose();
    }
  });

  it('assembles a kimi model: protocol resolves to the vendor base, never a vendor', async () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      const model = catalog.get('k1');
      expect(model.id).toBe('k1');
      expect(model.name).toBe('kimi-k2');
      expect(model.protocol).toBe('openai');
      expect(model.providerType).toBe('kimi');
      expect(model.providerName).toBe('kimi');
      expect(model.baseUrl).toBe('https://api.moonshot.ai/v1');
      expect(model.maxContextSize).toBe(262144);
      expect(model.capabilities.max_context_tokens).toBe(262144);
      expect(model.headers).toMatchObject({
        'User-Agent': 'kimi-test/1.0',
        'X-Msh-Device-Id': 'device-1',
      });
    } finally {
      await host.dispose();
    }
  });

  it('the Model carries no morphs and no request driver — pure data only', async () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      const model: Record<string, unknown> = { ...catalog.get('k1') };
      for (const [key, value] of Object.entries(model)) {
        expect(key.startsWith('with'), `unexpected morph ${key}`).toBe(false);
        expect(typeof value, `field ${key} must be data`).not.toBe('function');
      }
      expect(model['request']).toBeUndefined();
      expect(model['thinkingEffort']).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it('forwards only the User-Agent to vendors without a full hostHeaders declaration', async () => {
    const { host, catalog } = createHost({
      providers: {
        openai: { type: 'openai', apiKey: 'sk-o', baseUrl: 'https://api.openai.com/v1' },
      },
      models: { gpt: { provider: 'openai', model: 'gpt-5', maxContextSize: 128000 } },
    });
    try {
      const model = catalog.get('gpt');
      expect(model.protocol).toBe('openai');
      expect(model.providerType).toBe('openai');
      expect(model.headers).toEqual({ 'User-Agent': 'kimi-test/1.0' });
    } finally {
      await host.dispose();
    }
  });

  describe('custom identity', () => {
    const THIRD_PARTY = {
      providers: {
        openai: { type: 'openai', apiKey: 'sk-o', baseUrl: 'https://api.openai.com/v1' },
      },
      models: { gpt: { provider: 'openai', model: 'gpt-5', maxContextSize: 128000 } },
    };
    const OFFICIAL = {
      providers: { kimi: { type: 'kimi', apiKey: 'sk', baseUrl: 'https://api.example.test/v1' } },
      models: { k2: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 200000 } },
    };

    it('rewrites the User-Agent product token for third-party vendors', async () => {
      const { host, catalog } = createHost(THIRD_PARTY, stubModelOAuthTokens(), {
        headers: HOST_HEADERS,
        identitySlug: 'acme-dev',
      });
      try {
        expect(catalog.get('gpt').headers).toEqual({ 'User-Agent': 'acme-dev/1.0' });
      } finally {
        await host.dispose();
      }
    });

    it('preserves a parenthesized User-Agent suffix while rewriting', async () => {
      const { host, catalog } = createHost(THIRD_PARTY, stubModelOAuthTokens(), {
        headers: { 'User-Agent': 'kimi-test/1.0 (web)' },
        identitySlug: 'acme-dev',
      });
      try {
        expect(catalog.get('gpt').headers).toEqual({ 'User-Agent': 'acme-dev/1.0 (web)' });
      } finally {
        await host.dispose();
      }
    });

    it('leaves full-header vendor requests byte-for-byte unchanged', async () => {
      const { host, catalog } = createHost(OFFICIAL, stubModelOAuthTokens(), {
        headers: HOST_HEADERS,
        identitySlug: 'acme-dev',
      });
      try {
        expect(catalog.get('k2').headers).toEqual(HOST_HEADERS);
      } finally {
        await host.dispose();
      }
    });

    it('changes nothing when no identity is configured', async () => {
      const { host, catalog } = createHost(THIRD_PARTY);
      try {
        expect(catalog.get('gpt').headers).toEqual({ 'User-Agent': 'kimi-test/1.0' });
      } finally {
        await host.dispose();
      }
    });

    it('never synthesizes a User-Agent the host did not provide', async () => {
      const { host, catalog } = createHost(THIRD_PARTY, stubModelOAuthTokens(), {
        headers: {},
        identitySlug: 'acme-dev',
      });
      try {
        expect(catalog.get('gpt').headers).toEqual({});
      } finally {
        await host.dispose();
      }
    });

    it('attributes the User-Agent provenance for a lowercase host spelling', async () => {
      const { host, catalog } = createHost(THIRD_PARTY, stubModelOAuthTokens(), {
        headers: { 'user-agent': 'kimi-test/1.0' },
        identitySlug: 'acme-dev',
      });
      try {
        expect(catalog.get('gpt').headers).toEqual({ 'User-Agent': 'acme-dev/1.0' });
        const view = catalog.inspect('gpt');
        expect(view.sources['resolved.headers.User-Agent']).toMatchObject({
          kind: 'builtin',
          detail: 'host User-Agent, product token from [identity] (acme-dev)',
        });
      } finally {
        await host.dispose();
      }
    });
  });

  it('keeps an explicit foreign protocol for a kimi model (the dialect path)', async () => {
    const { host, catalog } = createHost({
      providers: { kimi: { type: 'kimi', apiKey: 'sk', baseUrl: 'https://api.example.test/v1' } },
      models: {
        k2: { provider: 'kimi', protocol: 'anthropic', model: 'kimi-k2', maxContextSize: 200000 },
      },
    });
    try {
      const model = catalog.get('k2');
      expect(model.protocol).toBe('anthropic');
      expect(model.providerType).toBe('kimi');
      expect(model.baseUrl).toBe('https://api.example.test');
      expect(model.supportEfforts).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it('infers the Anthropic effort profile for non-trait-driven anthropic vendors', async () => {
    const { host, catalog } = createHost({
      providers: { claude: { type: 'anthropic', apiKey: 'sk-a' } },
      models: {
        sonnet: { provider: 'claude', model: 'claude-sonnet-4-5', maxContextSize: 200000 },
      },
    });
    try {
      const model = catalog.get('sonnet');
      expect(model.protocol).toBe('anthropic');
      expect(model.supportEfforts).toEqual(['low', 'medium', 'high']);
      expect(model.defaultEffort).toBe('high');
      expect(model.capabilities.thinking).toBe(true);
    } finally {
      await host.dispose();
    }
  });

  it('resolves provider env-bag credentials and endpoints through the registry', async () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: { type: 'kimi', env: { KIMI_API_KEY: 'env-token', KIMI_BASE_URL: 'https://kimi-env.example.test/v1' } },
        openai: { type: 'openai', env: { OPENAI_API_KEY: 'sk-openai' } },
      },
      models: {
        k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 1000 },
        gpt: { provider: 'openai', protocol: 'openai', model: 'gpt-5', maxContextSize: 1000 },
      },
    });
    try {
      const kimi = catalog.get('k1');
      expect(kimi.baseUrl).toBe('https://kimi-env.example.test/v1');
      await expect(kimi.authProvider.getAuth()).resolves.toEqual({ apiKey: 'env-token' });
    } finally {
      await host.dispose();
    }
  });

  it('passes a declared offEffort through providerOptions for the OpenAI wires', async () => {
    const { host, catalog } = createHost({
      providers: {
        gateway: { type: 'openai', apiKey: 'sk-gw', baseUrl: 'https://gateway.example.test/v1' },
        responses: { type: 'openai_responses', apiKey: 'sk-r' },
      },
      models: {
        grok: {
          provider: 'gateway',
          model: 'grok-4',
          maxContextSize: 256000,
          supportEfforts: ['low', 'medium', 'high'],
          offEffort: 'none',
        },
        grokResponses: {
          provider: 'responses',
          model: 'grok-4',
          maxContextSize: 256000,
          offEffort: 'none',
        },
        plain: { provider: 'gateway', model: 'gpt-4.1', maxContextSize: 1000 },
      },
    });
    try {
      expect(catalog.get('grok').providerOptions).toEqual({ offEffort: 'none' });
      expect(catalog.get('grokResponses').providerOptions).toEqual({ offEffort: 'none' });
      expect(catalog.get('plain').providerOptions).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it('enables google-genai vertex mode through providerOptions when project and location resolve', async () => {
    const { host, catalog } = createHost({
      providers: {
        vertex: {
          type: 'google-genai',
          env: { GOOGLE_CLOUD_PROJECT: 'my-project', GOOGLE_CLOUD_LOCATION: 'us-central1' },
        },
        vertexUrl: {
          type: 'google-genai',
          baseUrl: 'https://us-east4-aiplatform.googleapis.com',
          env: { GOOGLE_CLOUD_PROJECT: 'my-project' },
        },
        plain: { type: 'google-genai', apiKey: 'sk-g' },
      },
      models: {
        v: { provider: 'vertex', model: 'gemini-2.5-flash', maxContextSize: 1000 },
        v2: { provider: 'vertexUrl', model: 'gemini-2.5-flash', maxContextSize: 1000 },
        g: { provider: 'plain', model: 'gemini-2.5-flash', maxContextSize: 1000 },
      },
    });
    try {
      const vertexModel = catalog.get('v');
      expect(vertexModel.protocol).toBe('google-genai');
      expect(vertexModel.providerOptions).toEqual({
        vertexai: true,
        project: 'my-project',
        location: 'us-central1',
      });
      expect(catalog.get('v2').providerOptions).toEqual({
        vertexai: true,
        project: 'my-project',
        location: 'us-east4',
      });
      expect(catalog.get('g').providerOptions).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it('resolves a vertexai provider onto Vertex options without moving a plain Gemini key', async () => {
    const { host, catalog } = createHost({
      providers: {
        keyed: { type: 'vertexai', apiKey: 'vk-local-fixture' },
        project: {
          type: 'vertexai',
          env: { GOOGLE_CLOUD_PROJECT: 'my-project', GOOGLE_CLOUD_LOCATION: 'us-central1' },
        },
        both: {
          type: 'vertexai',
          apiKey: 'vk-local-fixture',
          env: { GOOGLE_CLOUD_PROJECT: 'my-project', GOOGLE_CLOUD_LOCATION: 'us-central1' },
        },
        projectOnly: { type: 'vertexai', env: { GOOGLE_CLOUD_PROJECT: 'example-project' } },
        locationOnly: { type: 'vertexai', env: { GOOGLE_CLOUD_LOCATION: 'global' } },
        gemini: { type: 'google-genai', apiKey: 'gk-local-fixture' },
        geminiProjectOnly: { type: 'google-genai', env: { GOOGLE_CLOUD_PROJECT: 'example-project' } },
      },
      models: {
        keyed: { provider: 'keyed', model: 'gemini-2.5-flash', maxContextSize: 1000 },
        project: { provider: 'project', model: 'gemini-2.5-flash', maxContextSize: 1000 },
        both: { provider: 'both', model: 'gemini-2.5-flash', maxContextSize: 1000 },
        projectOnly: { provider: 'projectOnly', model: 'gemini-2.5-flash', maxContextSize: 1000 },
        locationOnly: { provider: 'locationOnly', model: 'gemini-2.5-flash', maxContextSize: 1000 },
        gemini: { provider: 'gemini', model: 'gemini-2.5-flash', maxContextSize: 1000 },
        geminiProjectOnly: { provider: 'geminiProjectOnly', model: 'gemini-2.5-flash', maxContextSize: 1000 },
      },
    });
    try {
      expect(catalog.get('keyed').protocol).toBe('google-genai');
      expect(catalog.get('keyed').providerType).toBe('vertexai');
      expect(catalog.get('keyed').providerOptions).toEqual({ vertexai: true });
      expect(catalog.get('project').providerOptions).toEqual({
        vertexai: true,
        project: 'my-project',
        location: 'us-central1',
      });
      expect(catalog.get('both').providerOptions).toEqual({
        vertexai: true,
        project: 'my-project',
        location: 'us-central1',
      });
      expect(catalog.get('projectOnly').providerOptions).toEqual({
        vertexai: true,
        project: 'example-project',
      });
      expect(catalog.get('locationOnly').providerOptions).toEqual({
        vertexai: true,
        location: 'global',
      });
      expect(catalog.get('gemini').protocol).toBe('google-genai');
      expect(catalog.get('gemini').providerOptions).toBeUndefined();
      expect(catalog.get('geminiProjectOnly').providerOptions).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it('supports flat models with an inline baseUrl (provider synthesized from the origin)', async () => {
    const { host, catalog } = createHost({
      models: {
        flat: {
          protocol: 'openai',
          name: 'my-model',
          baseUrl: 'https://flat.example.test/v1',
          apiKey: 'sk-flat',
          maxContextSize: 4096,
        },
      },
    });
    try {
      const model = catalog.get('flat');
      expect(model.providerName).toBe('flat.example.test');
      expect(model.providerType).toBe('openai');
      expect(model.baseUrl).toBe('https://flat.example.test/v1');
    } finally {
      await host.dispose();
    }
  });

  it('falls back to defaultProvider when a model names no provider', async () => {
    const { host, catalog } = createHost({
      ...kimiSections,
      defaultProvider: 'kimi',
      models: { inherited: { model: 'kimi-k2', maxContextSize: 1000 } },
    });
    try {
      expect(catalog.get('inherited').providerName).toBe('kimi');
    } finally {
      await host.dispose();
    }
  });

  it('supports unregistered vendors when the model declares the protocol explicitly', async () => {
    const { host, catalog } = createHost({
      providers: {
        mine: { type: 'my-vendor', apiKey: 'sk-m', baseUrl: 'https://vendor.example.test/v1' },
      },
      models: {
        m: { provider: 'mine', protocol: 'openai', model: 'vendor-model', maxContextSize: 1000 },
      },
    });
    try {
      const model = catalog.get('m');
      expect(model.providerType).toBe('my-vendor');
      expect(model.protocol).toBe('openai');
      expect(model.headers).toEqual({ 'User-Agent': 'kimi-test/1.0' });
    } finally {
      await host.dispose();
    }
  });

  it('resolves a bare default model reference to the canonical model id', async () => {
    const canonicalId = 'axon-message/deepseek-v4-flash';
    const { host, catalog, models } = createHost({
      providers: {
        gateway: { type: 'openai', apiKey: 'sk-test', baseUrl: 'https://example.test/v1' },
      },
      defaultModel: 'deepseek-v4-flash',
      models: {
        [canonicalId]: {
          provider: 'gateway',
          model: 'deepseek-v4-flash',
          maxContextSize: 128000,
        },
      },
    });
    try {
      const model = catalog.get(models.getDefaultModel()!);
      expect(model.id).toBe(canonicalId);
      expect(catalog.get(canonicalId)).toBe(model);

      await expect(catalog.setDefaultModel('deepseek-v4-flash')).resolves.toMatchObject({
        default_model: canonicalId,
      });
      expect(models.getDefaultModel()).toBe(canonicalId);
    } finally {
      await host.dispose();
    }
  });

  it('resolves ambiguous bare ids to the first candidate and preserves not-configured errors otherwise', async () => {
    const { host, catalog } = createHost({
      ...kimiSections,
      models: {
        'alpha/shared': { provider: 'kimi', model: 'shared', maxContextSize: 1 },
        'beta/other': { provider: 'kimi', model: 'shared', maxContextSize: 1 },
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(catalog.get('shared').id).toBe('alpha/shared');
      expect(warn).toHaveBeenCalled();
      expect(() => catalog.get('missing')).toThrow(
        'Model "missing" is not configured in config.toml.',
      );
      expect(() => catalog.get('other/shared')).toThrow(
        'Model "other/shared" is not configured in config.toml.',
      );
    } finally {
      warn.mockRestore();
      await host.dispose();
    }
  });

  it('throws config.invalid for unknown models, missing providers, and incomplete records', async () => {
    const expectInvalid = async (sections: Record<string, unknown>, id: string): Promise<void> => {
      const { host, catalog } = createHost(sections);
      try {
        expect(() => catalog.get(id)).toThrowError(
          expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }),
        );
      } finally {
        await host.dispose();
      }
    };
    await expectInvalid(kimiSections, 'nope');
    await expectInvalid({ models: { ghost: { provider: 'missing', model: 'm', maxContextSize: 1 } } }, 'ghost');
    await expectInvalid(
      { models: { noname: { protocol: 'openai', baseUrl: 'https://x.test', maxContextSize: 1 } } },
      'noname',
    );
    await expectInvalid(
      { ...kimiSections, models: { noctx: { provider: 'kimi', model: 'm' } } },
      'noctx',
    );
  });

  it('findByName matches name, model, and aliases', async () => {
    const { host, catalog } = createHost({
      ...kimiSections,
      models: {
        k1: { provider: 'kimi', model: 'kimi-k2', aliases: ['k2-latest'], maxContextSize: 1 },
        k2: { provider: 'kimi', name: 'shared-name', maxContextSize: 1 },
        k3: { provider: 'kimi', model: 'shared-name', maxContextSize: 1 },
      },
    });
    try {
      expect(catalog.findByName('kimi-k2')).toEqual(['k1']);
      expect(catalog.findByName('k2-latest')).toEqual(['k1']);
      expect(catalog.findByName('shared-name')).toEqual(['k2', 'k3']);
      expect(catalog.findByName('unknown')).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it('builds a refreshable OAuth auth provider for oauth-backed models', async () => {
    const tokenProvider = stubTokenProvider(['tok-1']);
    const { host, catalog } = createHost(
      {
        providers: {
          kimi: { type: 'kimi', oauth: { storage: 'file', key: 'kimi' }, baseUrl: 'https://api.moonshot.ai/v1' },
        },
        models: { k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 1 } },
      },
      stubModelOAuthTokens(tokenProvider),
    );
    try {
      const model = catalog.get('k1');
      expect(model.authProvider.canRefresh).toBe(true);
      await expect(model.authProvider.getAuth()).resolves.toEqual({ apiKey: 'tok-1' });
    } finally {
      await host.dispose();
    }
  });

  it('derives the Codex account header anew when its OAuth token rotates', async () => {
    const jwt = (accountId: string) => `header.${Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    })).toString('base64url')}.signature`;
    const tokens = stubTokenProvider([jwt('account-one'), jwt('account-two')]);
    const { host, catalog } = createHost({
      providers: { 'managed:openai-codex': {
        type: 'openai_responses', oauth: { storage: 'file', key: 'oauth/openai-codex' },
        baseUrl: 'https://chatgpt.com/backend-api/codex',
      } },
      models: { codex: { provider: 'managed:openai-codex', model: 'gpt-5.5', maxContextSize: 272000 } },
    }, stubModelOAuthTokens(tokens));
    try {
      const auth = catalog.get('codex').authProvider;
      await expect(auth.getAuth()).resolves.toEqual({
        apiKey: jwt('account-one'), headers: { 'chatgpt-account-id': 'account-one',
          Authorization: `Bearer ${jwt('account-one')}`, originator: 'kiki', 'OpenAI-Beta': 'responses=experimental' },
      });
      await expect(auth.getAuth({ force: true })).resolves.toEqual({
        apiKey: jwt('account-two'), headers: { 'chatgpt-account-id': 'account-two',
          Authorization: `Bearer ${jwt('account-two')}`, originator: 'kiki', 'OpenAI-Beta': 'responses=experimental' },
      });
      expect(tokens.calls).toEqual([{}, { force: true }]);
    } finally {
      await host.dispose();
    }
  });
});

describe('ModelCatalog caching and config-event invalidation', () => {
  it('caches per id; getRequester returns the cached pair', async () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      const model = catalog.get('k1');
      expect(catalog.get('k1')).toBe(model);
      const requester = catalog.getRequester('k1');
      expect(catalog.getRequester('k1')).toBe(requester);
      expect(requester.model).toBe(model);
    } finally {
      await host.dispose();
    }
  });

  it('drops the cache when a watched config section changes', async () => {
    const { host, catalog, models, providers } = createHost(kimiSections);
    try {
      const before = catalog.get('k1');
      await models.set('k1', { provider: 'kimi', model: 'kimi-k2', maxContextSize: 262144, displayName: 'K2' });
      const after = catalog.get('k1');
      expect(after).not.toBe(before);
      expect(after.displayName).toBe('K2');

      await providers.set('kimi', { type: 'kimi', apiKey: 'sk-2', baseUrl: 'https://other.example.test/v1' });
      expect(catalog.get('k1').baseUrl).toBe('https://other.example.test/v1');
    } finally {
      await host.dispose();
    }
  });

  it('refreshes default-provider routing and credentials without drifting explicit bindings', async () => {
    const { host, catalog, providers } = createHost({
      providers: {
        old: { type: 'openai', apiKey: 'old-key', baseUrl: 'https://old.example.test/v1' },
        next: { type: 'openai', apiKey: 'next-key', baseUrl: 'https://next.example.test/v1' },
      },
      defaultProvider: 'old',
      models: {
        implicit: { model: 'remote', maxContextSize: 8192 },
        explicit: { providerId: 'old', model: 'remote', maxContextSize: 8192 },
      },
    });
    try {
      const before = catalog.getRequester('implicit');
      catalog.get('explicit');
      await providers.setDefaultProvider('next');
      const after = catalog.getRequester('implicit');
      expect(after).not.toBe(before);
      expect(after.model).toMatchObject({ providerName: 'next', baseUrl: 'https://next.example.test/v1' });
      expect(await after.model.authProvider.getAuth()).toMatchObject({ apiKey: 'next-key' });
      expect(catalog.get('explicit')).toMatchObject({ providerName: 'old', baseUrl: 'https://old.example.test/v1' });
      expect(await catalog.get('explicit').authProvider.getAuth()).toMatchObject({ apiKey: 'old-key' });
    } finally { await host.dispose(); }
  });

  it('keeps serving the stale Model on a silent registry write until notifyConfigChanged()', async () => {
    const { host, catalog, models } = createHost(kimiSections);
    try {
      const before = catalog.get('k1');

      silentModelWrite(models, {
        k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 262144, displayName: 'silent' },
      });
      expect(catalog.get('k1')).toBe(before);

      catalog.notifyConfigChanged();
      const after = catalog.get('k1');
      expect(after).not.toBe(before);
      expect(after.displayName).toBe('silent');
    } finally {
      await host.dispose();
    }
  });

  it('applies system transport defaults until a provider overrides them and drops the cache on change', async () => {
    const gateway = { type: 'openai', apiKey: 'sk-gateway', baseUrl: 'https://gateway.example.test/v1' };
    const { host, catalog, providers } = createHost({
      providers: { gateway, plain: { type: 'openai', apiKey: 'sk-plain', baseUrl: 'https://plain.example.test/v1' } },
      models: {
        chat: { provider: 'gateway', model: 'remote-chat', maxContextSize: 8192, protocol: 'openai' },
        messages: { provider: 'gateway', model: 'remote-messages', maxContextSize: 8192, protocol: 'anthropic' },
        responses: { provider: 'gateway', model: 'remote-responses', maxContextSize: 8192, protocol: 'openai_responses' },
        plain: { provider: 'plain', model: 'remote-plain', maxContextSize: 8192, protocol: 'openai' },
      },
    });
    const systemCompression = {
      encoding: 'zstd' as const,
      targets: ['https://gateway.example.test/v1'],
      minBytes: 2048,
      dictionary: true,
    };
    const systemSocket = { targets: ['https://gateway.example.test/v1'] };
    try {
      expect(catalog.get('chat').requestCompression).toBeUndefined();
      expect(catalog.get('responses').responsesWebSocket).toBeUndefined();
      const before = catalog.get('chat');
      providers.setTransportDefaults({ requestCompression: systemCompression, responsesWebSocket: systemSocket });
      const inherited = catalog.get('chat');
      expect(inherited).not.toBe(before);
      expect(inherited.requestCompression).toEqual(systemCompression);
      expect(catalog.get('messages').requestCompression).toEqual(systemCompression);
      expect(catalog.get('responses')).toMatchObject({
        requestCompression: systemCompression,
        responsesWebSocket: systemSocket,
      });
      expect(catalog.get('plain').requestCompression).toEqual(systemCompression);

      await providers.set('gateway', { ...gateway, requestCompression: { minBytes: 0 }, responsesWebSocket: { off: true } });
      expect(catalog.get('chat').requestCompression).toEqual({ ...systemCompression, minBytes: 0 });
      expect(catalog.get('responses').responsesWebSocket).toBeUndefined();
      expect(catalog.get('plain').responsesWebSocket).toEqual(systemSocket);

      await providers.set('gateway', { ...gateway, requestCompression: { encoding: 'off' } });
      expect(catalog.get('chat').requestCompression).toEqual({ encoding: 'off' });
      expect(catalog.get('plain').requestCompression).toEqual(systemCompression);

      await providers.set('gateway', gateway);
      expect(catalog.get('chat').requestCompression).toEqual(systemCompression);
      expect(catalog.get('responses').responsesWebSocket).toEqual(systemSocket);

      const stable = catalog.get('chat');
      providers.setTransportDefaults({
        requestCompression: structuredClone(systemCompression),
        responsesWebSocket: structuredClone(systemSocket),
      });
      expect(catalog.get('chat')).toBe(stable);

      providers.setTransportDefaults({});
      expect(catalog.get('chat').requestCompression).toBeUndefined();
      expect(catalog.get('responses').responsesWebSocket).toBeUndefined();
      providers.setTransportDefaults({ requestCompression: { minBytes: 0 } });
      expect(() => catalog.get('chat')).toThrowError(expect.objectContaining({ code: 'config.invalid' }));
    } finally {
      await host.dispose();
    }
  });
});

describe('headers merge order', () => {
  it('lets provider customHeaders win over the host layer', async () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: {
          type: 'kimi',
          apiKey: 'sk',
          baseUrl: 'https://api.moonshot.ai/v1',
          customHeaders: { 'User-Agent': 'custom-ua', 'X-Custom': 'c' },
        },
      },
      models: { k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 1 } },
    });
    try {
      const model: Model = catalog.get('k1');
      expect(model.headers).toEqual({
        'User-Agent': 'custom-ua',
        'X-Msh-Device-Id': 'device-1',
        'X-Custom': 'c',
      });
    } finally {
      await host.dispose();
    }
  });
});

describe('ModelCatalog inspect', () => {
  it('builds the god object with per-field provenance (kimi structured model)', async () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      const view = catalog.inspect('k1');
      expect(view.id).toBe('k1');
      expect(view.provider).toMatchObject({ id: 'kimi', synthesized: false });
      expect(view.provider.definition?.registered).toBe(true);
      expect(view.provider.definition?.baseProtocol).toBe('openai');
      expect(view.resolved.protocol).toBe('openai');
      expect(view.resolved.auth).toEqual({ kind: 'apiKey', apiKey: '••••test' });
      expect(view.sources['resolved.protocol']).toMatchObject({ kind: 'builtin' });
      expect(view.sources['resolved.baseUrl']).toMatchObject({ kind: 'config' });
      expect(view.sources['resolved.auth']).toMatchObject({ kind: 'config' });
      expect(view.sources['provider']).toMatchObject({ kind: 'config' });
      expect(view.sources['model']).toMatchObject({ kind: 'config' });
      expect(view.sources['model.id']).toMatchObject({ kind: 'config' });
      expect(view.sources['resolved.capabilities.max_context_tokens']).toMatchObject({
        kind: 'synthesized',
      });
      expect(view.sources['resolved.capabilities.max_input_tokens']).toMatchObject({
        kind: 'none',
      });
      expect(view.sources['resolved']).toMatchObject({ kind: 'synthesized' });
      expect(view.sources['resolved.capabilities.tool_use']).toMatchObject({ kind: 'none' });
    } finally {
      await host.dispose();
    }
  });

  it('serves the same resolution as get (chain consistency, same cache generation)', async () => {
    const { host, catalog, models } = createHost(kimiSections);
    try {
      const model = catalog.get('k1');
      const view = catalog.inspect('k1');
      const {
        authProvider: _auth,
        id: _id,
        name,
        overrides: _overrides,
        contextBudget: _contextBudget,
        maxCompletionTokens: _maxCompletionTokens,
        requestParams: _requestParams,
        usageParameters: _usageParameters,
        requestCompression: _requestCompression,
        responsesWebSocket: _responsesWebSocket,
        ...rest
      } = model;
      expect(model.usageParameters).toHaveProperty('main.values');
      expect(view.resolved).not.toHaveProperty('usageParameters');
      expect(view.resolved).not.toHaveProperty('requestCompression');
      expect(view.resolved).not.toHaveProperty('responsesWebSocket');
      expect(view.resolved).toMatchObject({ ...rest, wireName: name });
      expect(view.sources['resolved.maxContextSize']).toEqual(view.sources['model.effective.maxContextSize']);
      expect(view.sources['resolved.maxContextSize']).toMatchObject({ kind: 'config' });

      silentModelWrite(models, {
        k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 262144, displayName: 'silent' },
      });
      expect(catalog.inspect('k1')).toEqual(view);
      expect(catalog.inspect('k1').resolved.displayName).toBeUndefined();
      expect(catalog.get('k1')).toBe(model);
      expect(catalog.get('k1').displayName).toBeUndefined();
      catalog.notifyConfigChanged();
      const refreshed = catalog.inspect('k1');
      expect(catalog.get('k1')).not.toBe(model);
      expect(refreshed.resolved.displayName).toBe('silent');
      expect(refreshed.sources['resolved.displayName']).toEqual(refreshed.sources['model.effective.displayName']);
      expect(refreshed.sources['resolved.displayName']).toMatchObject({ kind: 'config' });
    } finally {
      await host.dispose();
    }
  });

  it('attributes profile-filled efforts and capabilities to builtin', async () => {
    const { host, catalog } = createHost({
      providers: { claude: { type: 'anthropic', apiKey: 'sk-a' } },
      models: {
        sonnet: { provider: 'claude', model: 'claude-sonnet-4-5', maxContextSize: 200000 },
      },
    });
    try {
      const view = catalog.inspect('sonnet');
      expect(view.resolved.supportEfforts).toEqual(['low', 'medium', 'high']);
      expect(view.sources['model.effective.supportEfforts']).toMatchObject({
        kind: 'builtin',
        detail: expect.stringContaining('anthropic profile'),
      });
      expect(view.sources['model.effective.defaultEffort']).toMatchObject({ kind: 'builtin' });
      expect(view.sources['resolved.supportEfforts']).toMatchObject({ kind: 'builtin' });
      expect(view.sources['resolved.capabilities.thinking']).toMatchObject({ kind: 'builtin' });
      expect(view.sources['resolved.providerOptions.supportEfforts']).toMatchObject({
        kind: 'builtin',
      });
    } finally {
      await host.dispose();
    }
  });

  it('attributes override fields to the overrides block', async () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: { type: 'kimi', apiKey: 'sk', baseUrl: 'https://api.example.test/v1' },
      },
      models: {
        m: {
          provider: 'kimi',
          model: 'kimi-k2',
          maxContextSize: 100,
          overrides: { maxContextSize: 200 },
        },
      },
    });
    try {
      const view = catalog.inspect('m');
      expect(view.resolved.maxContextSize).toBe(200);
      expect(view.sources['model.effective.maxContextSize']).toMatchObject({ kind: 'override' });
      expect(view.sources['resolved.maxContextSize']).toMatchObject({ kind: 'override' });
      expect(view.sources['model.effective.model']).toMatchObject({ kind: 'config' });
    } finally {
      await host.dispose();
    }
  });

  it('attributes the input cap to config, its clamp, and its absence', async () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: { type: 'kimi', apiKey: 'sk', baseUrl: 'https://api.example.test/v1' },
      },
      models: {
        declared: {
          provider: 'kimi',
          model: 'kimi-k2',
          maxContextSize: 400000,
          maxInputSize: 272000,
        },
        clamped: {
          provider: 'kimi',
          model: 'kimi-k2',
          maxContextSize: 400000,
          maxInputSize: 272000,
          overrides: { maxContextSize: 128000 },
        },
        clampedOverride: {
          provider: 'kimi',
          model: 'kimi-k2',
          maxContextSize: 400000,
          overrides: { maxContextSize: 128000, maxInputSize: 272000 },
        },
        plain: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 100 },
      },
    });
    try {
      const declaredView = catalog.inspect('declared');
      expect(declaredView.resolved.maxInputSize).toBe(272000);
      expect(declaredView.sources['model.effective.maxInputSize']).toMatchObject({ kind: 'config' });
      expect(declaredView.sources['resolved.capabilities.max_input_tokens']).toMatchObject({
        kind: 'config',
      });

      const clampedView = catalog.inspect('clamped');
      expect(clampedView.resolved.maxInputSize).toBe(128000);
      expect(clampedView.sources['model.effective.maxInputSize']).toMatchObject({
        kind: 'synthesized',
        detail: expect.stringContaining('clamped'),
      });
      expect(clampedView.sources['resolved.capabilities.max_input_tokens']).toMatchObject({
        kind: 'synthesized',
      });

      const clampedOverrideView = catalog.inspect('clampedOverride');
      expect(clampedOverrideView.resolved.maxInputSize).toBe(128000);
      expect(clampedOverrideView.sources['model.effective.maxInputSize']).toMatchObject({
        kind: 'synthesized',
        detail: expect.stringContaining('clamped'),
      });
      expect(clampedOverrideView.sources['model.effective.maxInputSize']).not.toMatchObject({
        kind: 'override',
      });
      expect(clampedOverrideView.sources['resolved.maxInputSize']).toMatchObject({
        kind: 'synthesized',
      });

      const plainView = catalog.inspect('plain');
      expect(plainView.sources['resolved.capabilities.max_input_tokens']).toMatchObject({
        kind: 'none',
      });
    } finally {
      await host.dispose();
    }
  });

  it('attributes env-bag credentials and endpoints by env-var name', async () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: {
          type: 'kimi',
          env: { KIMI_API_KEY: 'env-token', KIMI_BASE_URL: 'https://kimi-env.example.test/v1' },
        },
      },
      models: { k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 1000 } },
    });
    try {
      const view = catalog.inspect('k1');
      expect(view.resolved.baseUrl).toBe('https://kimi-env.example.test/v1');
      expect(view.resolved.auth.kind).toBe('apiKey');
      expect(view.sources['resolved.auth']).toMatchObject({
        kind: 'env',
        detail: expect.stringContaining('KIMI_API_KEY'),
      });
      expect(view.sources['resolved.baseUrl']).toMatchObject({
        kind: 'env',
        detail: expect.stringContaining('KIMI_BASE_URL'),
      });
      expect(JSON.stringify(view)).not.toContain('env-token');
    } finally {
      await host.dispose();
    }
  });

  it('attributes the definition defaultBaseUrl to builtin and reports missing credentials', async () => {
    const { host, catalog } = createHost({
      providers: { kimi: { type: 'kimi' } },
      models: { k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 1 } },
    });
    try {
      const view = catalog.inspect('k1');
      expect(view.resolved.baseUrl).toBe('https://api.moonshot.ai/v1');
      expect(view.sources['resolved.baseUrl']).toMatchObject({
        kind: 'builtin',
        detail: expect.stringContaining('defaultBaseUrl'),
      });
      expect(view.resolved.auth).toEqual({ kind: 'none' });
      expect(view.sources['resolved.auth']).toMatchObject({ kind: 'none' });
    } finally {
      await host.dispose();
    }
  });

  it('marks flat-model providers as synthesized', async () => {
    const { host, catalog } = createHost({
      models: {
        flat: {
          protocol: 'openai',
          name: 'my-model',
          baseUrl: 'https://flat.example.test/v1',
          apiKey: 'sk-flat',
          maxContextSize: 4096,
        },
      },
    });
    try {
      const view = catalog.inspect('flat');
      expect(view.provider.synthesized).toBe(true);
      expect(view.provider.id).toBe('flat.example.test');
      expect(view.provider.config).toBeUndefined();
      expect(view.sources['provider']).toMatchObject({ kind: 'synthesized' });
      expect(view.resolved.auth).toEqual({ kind: 'apiKey', apiKey: '••••flat' });
      expect(JSON.stringify(view)).not.toContain('sk-flat');
    } finally {
      await host.dispose();
    }
  });

  it('throws config.invalid for unknown models, same as get', async () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      expect(() => catalog.inspect('nope')).toThrowError(
        expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }),
      );
    } finally {
      await host.dispose();
    }
  });
});

describe('ModelCatalog ping', () => {
  it('returns the streamed text and usage on a live success', async () => {
    const { host, models, providers } = createHost(kimiSections, stubModelOAuthTokens());
    try {
      const fakeProvider: ChatProvider = {
        name: 'fake-base',
        modelName: 'fake-model',
        thinkingEffort: null,
        async generate() {
          return {
            id: 'msg-1',
            usage: emptyUsage(),
            finishReason: 'completed',
            rawFinishReason: 'stop',
            traceId: null,
            async *[Symbol.asyncIterator]() {
              yield { type: 'text', text: 'pong' };
            },
          };
        },
      };
      const registry = {
        _serviceBrand: undefined,
        supportedProtocols: () => [],
        resolveAdapterIdentity: () => {
          throw new Error('not exercised');
        },
        resolveProviderBaseId: () => {
          throw new Error('not exercised');
        },
        resolveCapability: () => UNKNOWN_CAPABILITY,
        explainCapability: () => ({
          capability: UNKNOWN_CAPABILITY,
          source: { kind: 'none' as const },
        }),
        createChatProvider: () => fakeProvider,
      } as unknown as IProtocolAdapterRegistry;
      const catalog = new ModelCatalog(
        providers,
        models,
        stubModelOAuthTokens(),
        registry,
        { headers: {}, thirdPartyHeaders: {} },
        { acquire: async () => ({ release() {} }) },
      );
      const result = await catalog.ping('k1');
      expect(result).toMatchObject({ ok: true, text: 'pong', finishReason: 'completed' });
      expect(result.usage).toEqual(emptyUsage());
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await host.dispose();
    }
  });

  it('returns ok:false with the translated error when the wire fails', async () => {
    const { host, catalog } = createHost({
      models: {
        flat: {
          protocol: 'openai',
          name: 'my-model',
          baseUrl: 'http://127.0.0.1:1/',
          apiKey: 'sk-x',
          maxContextSize: 4096,
        },
      },
    });
    try {
      const result = await catalog.ping('flat');
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      await host.dispose();
    }
  });

  it.each(['api-key', 'newline', 'oauth'] as const)('redacts probe %s and URL/header credentials at the boundary', async (kind) => {
    const apiKey = kind === 'newline' ? 'sk-probe\nsecond-line' : 'sk-probe-example-key';
    const baseUrl = 'https://build:pa55word@gateway.example.test/v1?api_key=qz7bHQ2';
    const { host, catalog } = createHost({
      providers: {
        gateway: {
          type: 'openai', baseUrl,
          apiKey: kind === 'oauth' ? undefined : apiKey,
          oauth: kind === 'oauth' ? { storage: 'file', key: 'oauth/example' } : undefined,
          customHeaders: { 'X-Api-Key': 'header-secret-value' },
        },
      },
      models: { 'probe-model': { provider: 'gateway', model: 'gpt-probe', maxContextSize: 4096 } },
    }, stubModelOAuthTokens(stubTokenProvider([apiKey])));
    const generate = vi.fn(async () => {
      throw new Error(`invalid key: ${apiKey}; cannot reach ${baseUrl}; header-secret-value`);
    });
    const factory = vi.spyOn(host.app.accessor.get(IProtocolAdapterRegistry), 'createChatProvider').mockReturnValue({
      name: 'echoing-provider', modelName: 'gpt-probe', thinkingEffort: null, generate,
    } as unknown as ChatProvider);
    try {
      const result = await catalog.ping('probe-model');
      expect(result.ok).toBe(false);
      for (const secret of ['sk-probe', 'second-line', 'pa55word', 'qz7bHQ2', 'header-secret-value']) {
        expect(JSON.stringify(result)).not.toContain(secret);
      }
      if (kind === 'newline') expect(generate).not.toHaveBeenCalled();
      else expect(result.error).toContain('[redacted]');
    } finally {
      factory.mockRestore();
      await host.dispose();
    }
  });

  it('rejects with config.invalid for unknown models', async () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      await expect(catalog.ping('nope')).rejects.toThrowError(
        expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }),
      );
    } finally {
      await host.dispose();
    }
  });
});

const catalogSections: Record<string, unknown> = {
  providers: {
    kimi: { type: 'kimi', apiKey: 'sk-test', baseUrl: 'https://api.example.test/v1' },
    openai: { type: 'openai' },
  },
  models: {
    k2: {
      provider: 'kimi',
      model: 'kimi-k2',
      maxContextSize: 131072,
      displayName: 'Kimi K2',
      capabilities: ['thinking'],
    },
    turbo: { provider: 'kimi', model: 'kimi-turbo', maxContextSize: 32768, displayName: 'Kimi Turbo' },
    gpt4o: { provider: 'openai', model: 'gpt-4o', maxContextSize: 128000 },
  },
  defaultModel: 'k2',
};

describe('wire projection (pure)', () => {
  it('toProtocolModel projects the materialized Model into the snake_case wire shape', async () => {
    const { host, catalog } = createHost(catalogSections);
    try {
      const record = (catalogSections['models'] as Record<string, ModelRecord>)['k2']!;
      expect(toProtocolModel(catalog.get('k2'), record, 'kimi')).toEqual({
        effective_protocol: 'openai',
        protocol_source: 'vendor',
        endpoint_source: 'vendor',
        auth_source: 'none',
        id: 'k2',
        provider_id: 'kimi',
        remote_id: 'kimi-k2',
        display_name: 'Kimi K2',
        max_context_size: 131072,
        capabilities: ['thinking'],
        effective_capabilities: ['thinking'],
        support_efforts: undefined,
        default_effort: undefined,
        request_identity: undefined,
      });
    } finally {
      await host.dispose();
    }
  });

  it('toProtocolModelFallback projects the raw record', () => {
    const record: ModelRecord = {
      provider: 'kimi',
      model: 'kimi-k2',
      maxContextSize: 131072,
      displayName: 'Kimi K2',
      capabilities: ['thinking'],
    };
    expect(toProtocolModelFallback('k2', record, 'kimi')).toEqual({
      id: 'k2',
      provider_id: 'kimi',
      remote_id: 'kimi-k2',
      display_name: 'Kimi K2',
      max_context_size: 131072,
      capabilities: ['thinking'],
      effective_protocol: 'openai',
      protocol_source: 'vendor',
      endpoint_source: 'vendor',
      auth_source: 'none',
      support_efforts: undefined,
      default_effort: undefined,
      request_identity: undefined,
    });
  });

  it('projects an authored sparse model request identity without expansion', () => {
    const record: ModelRecord = {
      provider: 'kimi',
      model: 'kimi-k2',
      maxContextSize: 131072,
      requestIdentity: { overrides: { client: { userAgent: 'host' } } },
    };
    expect(toProtocolModelFallback('k2', record, 'kimi').request_identity).toEqual({
      overrides: { client: { user_agent: 'host' } },
    });
  });

  it('modelIdsForProvider and globalDefaultForProvider group models by provider', () => {
    const models: Record<string, ModelRecord> = {
      a: { provider: 'p1', model: 'm-a' },
      b: { provider: 'p2', model: 'm-b' },
      c: { providerId: 'p1', model: 'm-c' },
    };
    expect(modelIdsForProvider(models, 'p1')).toEqual(['a']);
    expect(globalDefaultForProvider(models, 'a', 'p1')).toBe('a');
    expect(globalDefaultForProvider(models, 'a', 'p2')).toBeUndefined();
    expect(globalDefaultForProvider(models, undefined, 'p1')).toBeUndefined();
  });

  it('toProtocolProvider prefers the provider default, then the global default', () => {
    const models: Record<string, ModelRecord> = { a: { provider: 'p1', model: 'm-a' } };
    const provider: ProviderConfig = { type: 'openai', baseUrl: 'https://x.test/v1' };
    expect(
      toProtocolProvider('p1', provider, models, 'a', { hasApiKey: true, hasOAuthToken: false }),
    ).toEqual({
      id: 'p1',
      type: 'openai',
      base_url: 'https://x.test/v1',
      default_model: 'a',
      has_api_key: true,
      status: 'connected',
      models: ['a'],
    });
    expect(
      toProtocolProvider('p1', { ...provider, defaultModel: 'own' }, models, 'a', {
        hasApiKey: false,
        hasOAuthToken: false,
      }).default_model,
    ).toBe('own');
    expect(
      toProtocolProvider('p1', { ...provider, type: undefined }, models, undefined, {
        hasApiKey: false,
        hasOAuthToken: false,
      }),
    ).toMatchObject({ type: 'openai', status: 'unconfigured', default_model: undefined });
  });
});

describe('ModelCatalog enumeration', () => {
  it('reads 44 models and 12 connections without serializing cached credential probes', async () => {
    const providers: ProvidersSection = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
      `connection-${index}`, { type: 'openai', baseUrl: 'https://example.test/v1', oauth: { storage: 'file', key: `oauth/${index}` } },
    ]));
    const models: ModelsSection = Object.fromEntries(Array.from({ length: 44 }, (_, index) => [
      `model-${index}`, { provider: `connection-${index % 12}`, model: `remote-${index}`, maxContextSize: 8192 },
    ]));
    const getAccessToken = vi.fn();
    const hasCachedAccessToken = vi.fn(async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return id !== 'connection-5';
    });
    const { host, catalog } = createHost({ providers, models, defaultModel: 'model-0' }, {
      _serviceBrand: undefined, getAccessToken, hasCachedAccessToken,
    });
    try {
      const modelStart = performance.now();
      expect(await catalog.listModels()).toHaveLength(44);
      const modelsMs = performance.now() - modelStart;
      const providersStart = performance.now();
      const items = await catalog.listProviders();
      const providersMs = performance.now() - providersStart;
      process.stdout.write(`${JSON.stringify({ stage: 'configured-catalog-cold', models: 44, providers: items.length, modelsMs, providersMs })}\n`);
      expect(items.map((item) => item.id)).toEqual(Object.keys(providers));
      expect(items[5]).toMatchObject({ id: 'connection-5', status: 'unconfigured', oauth: { signed_in: false } });
      expect(items[6]).toMatchObject({ status: 'connected', oauth: { signed_in: true } });
      expect(getAccessToken).not.toHaveBeenCalled();
      expect(providersMs).toBeLessThan(1000);
      const warmStart = performance.now();
      expect(await catalog.listProviders()).toEqual(items);
      const warmMs = performance.now() - warmStart;
      process.stdout.write(`${JSON.stringify({ stage: 'configured-catalog-warm', models: 44, providers: 12, providersMs: warmMs })}\n`);
      expect(warmMs).toBeLessThan(1000);
      hasCachedAccessToken.mockRejectedValueOnce(new Error('fixture credential read failed'));
      await expect(catalog.listProviders()).rejects.toThrow('fixture credential read failed');
      expect(await catalog.listProviders()).toHaveLength(12);
    } finally { await host.dispose(); }
  });

  it('does not publish empty configured catalogs before local hydration completes', async () => {
    const host = createScopedTestHost([
      [IConfigService, new StubConfigService()],
      [IModelOAuthTokens, stubModelOAuthTokens()],
      [IHostRequestHeaders, hostHeadersPort({ headers: HOST_HEADERS })],
    ]);
    try {
      const catalog = host.app.accessor.get(IModelCatalog);
      let modelsSettled = false;
      let providersSettled = false;
      const models = catalog.listModels().then((items) => { modelsSettled = true; return items; });
      const providers = catalog.listProviders().then((items) => { providersSettled = true; return items; });
      await Promise.resolve();
      expect(modelsSettled).toBe(false);
      expect(providersSettled).toBe(false);
      host.app.accessor.get(IProviderService).loadAll({ example: { type: 'openai' } }, 'example');
      await Promise.resolve();
      expect(modelsSettled).toBe(false);
      expect(providersSettled).toBe(false);
      host.app.accessor.get(IModelService).loadAll({ model: { provider: 'example', model: 'remote', maxContextSize: 8192 } }, 'model');
      expect(await models).toHaveLength(1);
      expect(await providers).toHaveLength(1);
    } finally { await host.dispose(); }
  });

  it('lists configured models as selectable aliases', async () => {
    const { host, catalog } = createHost(catalogSections);
    try {
      await expect(catalog.listModels()).resolves.toEqual([
        {
          id: 'k2',
          effective_protocol: 'openai',
          protocol_source: 'vendor',
          endpoint_source: 'provider',
          auth_source: 'provider',
          provider_id: 'kimi',
          remote_id: 'kimi-k2',
          display_name: 'Kimi K2',
          max_context_size: 131072,
          capabilities: ['thinking'],
          effective_capabilities: ['thinking'],
        },
        {
          id: 'turbo',
          effective_protocol: 'openai',
          protocol_source: 'vendor',
          endpoint_source: 'provider',
          auth_source: 'provider',
          provider_id: 'kimi',
          remote_id: 'kimi-turbo',
          display_name: 'Kimi Turbo',
          max_context_size: 32768,
        },
        {
          id: 'gpt4o',
          effective_protocol: 'openai',
          protocol_source: 'provider',
          endpoint_source: 'none',
          auth_source: 'none',
          provider_id: 'openai',
          remote_id: 'gpt-4o',
          display_name: 'gpt-4o',
          max_context_size: 128000,
          effective_capabilities: ['image_in', 'tool_use'],
        },
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('collapses managed legacy and canonical aliases without hiding distinct sources', async () => {
    const sections: Record<string, unknown> = {
      providers: {
        'managed:kimi-code': {
          type: 'kimi',
          baseUrl: 'https://api.kimi.example/v1',
          oauth: { storage: 'file', key: 'oauth/kimi-code' },
        },
        moonshot: { type: 'kimi', baseUrl: 'https://api.moonshot.example/v1', apiKey: 'test' },
      },
      models: {
        'managed:kimi-code/kimi-k2': {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          displayName: 'Kimi K2',
          maxContextSize: 131072,
        },
        'kimi-code/kimi-k2': {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          displayName: 'Kimi K2',
          maxContextSize: 131072,
        },
        'managed-kimi-alt/kimi-k2': {
          provider: 'managed:kimi-code',
          baseUrl: 'https://alt.kimi.example/v1',
          model: 'kimi-k2',
          displayName: 'Kimi K2',
          maxContextSize: 131072,
        },
        'moonshot/kimi-k2': {
          provider: 'moonshot',
          model: 'kimi-k2',
          displayName: 'Kimi K2',
          maxContextSize: 131072,
        },
      },
      defaultModel: 'kimi-code/kimi-k2',
    };
    const { host, catalog } = createHost(sections);
    try {
      await expect(catalog.listModels()).resolves.toEqual([
        expect.objectContaining({
          id: 'kimi-code/kimi-k2',
          provider_id: 'managed:kimi-code',
          remote_id: 'kimi-k2',
          display_name: 'Kimi K2',
        }),
        expect.objectContaining({
          id: 'managed-kimi-alt/kimi-k2',
          provider_id: 'managed:kimi-code',
          remote_id: 'kimi-k2',
          display_name: 'Kimi K2',
        }),
        expect.objectContaining({
          id: 'moonshot/kimi-k2',
          provider_id: 'moonshot',
          remote_id: 'kimi-k2',
          display_name: 'Kimi K2',
        }),
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('keeps the configured default alias when collapsing managed duplicates', async () => {
    const sections: Record<string, unknown> = {
      providers: {
        'managed:kimi-code': {
          type: 'kimi',
          baseUrl: 'https://api.kimi.example/v1',
          oauth: { storage: 'file', key: 'oauth/kimi-code' },
        },
      },
      models: {
        'kimi-code/kimi-k2': {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 131072,
        },
        'managed:kimi-code/kimi-k2': {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 131072,
        },
      },
      defaultModel: 'managed:kimi-code/kimi-k2',
    };
    const { host, catalog } = createHost(sections);
    try {
      await expect(catalog.listModels()).resolves.toEqual([
        expect.objectContaining({ id: 'managed:kimi-code/kimi-k2' }),
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('projects support_efforts and default_effort from the model config', async () => {
    const sections = structuredClone(catalogSections);
    (sections['models'] as Record<string, ModelRecord>)['k2'] = {
      ...(catalogSections['models'] as Record<string, ModelRecord>)['k2'],
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
    };
    const { host, catalog } = createHost(sections);
    try {
      const [k2] = await catalog.listModels();
      expect(k2).toMatchObject({
        id: 'k2',
        support_efforts: ['low', 'high', 'max'],
        default_effort: 'max',
      });
    } finally {
      await host.dispose();
    }
  });

  it('projects official Anthropic effort metadata inferred from the model name', async () => {
    const sections = structuredClone(catalogSections);
    (sections['providers'] as Record<string, ProviderConfig>)['anthropic'] = { type: 'anthropic' };
    (sections['models'] as Record<string, ModelRecord>)['opus'] = {
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      maxContextSize: 200000,
    };
    const { host, catalog } = createHost(sections);
    try {
      const opus = (await catalog.listModels()).find((model) => model.id === 'opus');
      expect(opus).toMatchObject({
        capabilities: ['thinking'],
        support_efforts: ['low', 'medium', 'high', 'max'],
        default_effort: 'high',
      });
    } finally {
      await host.dispose();
    }
  });

  it('projects latest Opus efforts for unknown Claude-marked Anthropic-compatible models', async () => {
    const sections = structuredClone(catalogSections);
    (sections['providers'] as Record<string, ProviderConfig>)['custom'] = { type: 'anthropic' };
    (sections['models'] as Record<string, ModelRecord>)['compatible'] = {
      provider: 'custom',
      model: 'custom-claude-model',
      maxContextSize: 128000,
    };
    const { host, catalog } = createHost(sections);
    try {
      const compatible = (await catalog.listModels()).find((model) => model.id === 'compatible');
      expect(compatible).toMatchObject({
        capabilities: ['thinking'],
        support_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        default_effort: 'high',
      });
    } finally {
      await host.dispose();
    }
  });

  it('does not project fallback efforts for clearly non-Claude Anthropic-compatible models', async () => {
    const sections = structuredClone(catalogSections);
    (sections['providers'] as Record<string, ProviderConfig>)['custom'] = { type: 'anthropic' };
    (sections['models'] as Record<string, ModelRecord>)['compatible'] = {
      provider: 'custom',
      model: 'compatible-model',
      maxContextSize: 128000,
    };
    const { host, catalog } = createHost(sections);
    try {
      const compatible = (await catalog.listModels()).find((model) => model.id === 'compatible');
      expect(compatible?.capabilities).toBeUndefined();
      expect(compatible?.support_efforts).toBeUndefined();
      expect(compatible?.default_effort).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it('projects latest Opus efforts for a flat providerless Claude-marked Anthropic model', async () => {
    const { host, catalog } = createHost({
      providers: {},
      models: {
        compatible: {
          model: 'custom-claude-model',
          baseUrl: 'https://anthropic.example.test',
          protocol: 'anthropic',
          maxContextSize: 128000,
        },
      },
    });
    try {
      const compatible = (await catalog.listModels()).find((model) => model.id === 'compatible');
      expect(compatible).toMatchObject({
        capabilities: ['thinking'],
        support_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        default_effort: 'high',
      });
    } finally {
      await host.dispose();
    }
  });

  it('does not project fallback efforts for a flat providerless non-Claude Anthropic model', async () => {
    const { host, catalog } = createHost({
      providers: {},
      models: {
        compatible: {
          model: 'compatible-model',
          baseUrl: 'https://anthropic.example.test',
          protocol: 'anthropic',
          maxContextSize: 128000,
        },
      },
    });
    try {
      const compatible = (await catalog.listModels()).find((model) => model.id === 'compatible');
      expect(compatible?.capabilities).toBeUndefined();
      expect(compatible?.support_efforts).toBeUndefined();
      expect(compatible?.default_effort).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it('does not project fallback efforts for unknown Kimi-managed Anthropic models', async () => {
    const sections = structuredClone(catalogSections);
    (sections['models'] as Record<string, ModelRecord>)['compatible'] = {
      provider: 'kimi',
      protocol: 'anthropic',
      model: 'compatible-model',
      maxContextSize: 128000,
    };
    const { host, catalog } = createHost(sections);
    try {
      const compatible = (await catalog.listModels()).find((model) => model.id === 'compatible');
      expect(compatible).toMatchObject({ id: 'compatible', provider_id: 'kimi', remote_id: 'compatible-model' });
      expect(compatible?.capabilities).toBeUndefined();
      expect(compatible?.support_efforts).toBeUndefined();
      expect(compatible?.default_effort).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it('projects effort fields from overrides when present', async () => {
    const sections = structuredClone(catalogSections);
    (sections['models'] as Record<string, ModelRecord>)['k2'] = {
      ...(catalogSections['models'] as Record<string, ModelRecord>)['k2'],
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
      overrides: { supportEfforts: ['low', 'high', 'max'], defaultEffort: 'max' },
    };
    const { host, catalog } = createHost(sections);
    try {
      const [k2] = await catalog.listModels();
      expect(k2).toMatchObject({
        support_efforts: ['low', 'high', 'max'],
        default_effort: 'max',
      });
    } finally {
      await host.dispose();
    }
  });

  it('falls back to the config projection for models that fail materialization', async () => {
    const { host, catalog } = createHost({
      providers: {},
      models: {
        bad: {
          model: 'bad-model',
          baseUrl: 'https://x.test/v1',
          apiKey: 'sk',
          oauth: { storage: 'file', key: 'oauth/bad' },
          maxContextSize: 1000,
          displayName: 'Bad',
        },
      },
    });
    try {
      await expect(catalog.listModels()).resolves.toEqual([
        { id: 'bad', provider_id: '', remote_id: 'bad-model', display_name: 'Bad', max_context_size: 1000, endpoint_source: 'model', auth_source: 'model' },
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('lists providers with per-provider models, default model, and credential state', async () => {
    const { host, catalog } = createHost(catalogSections);
    try {
      await expect(catalog.listProviders()).resolves.toEqual([
        {
          id: 'kimi',
          type: 'kimi',
          base_url: 'https://api.example.test/v1',
          default_model: 'k2',
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
    } finally {
      await host.dispose();
    }
  });

  it('detects env-bag credentials through the vendor endpoint declarations', async () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: { type: 'kimi', env: { KIMI_API_KEY: 'kimi-env-key' } },
        claude: { type: 'anthropic', env: { ANTHROPIC_API_KEY: 'anthropic-env-key' } },
        inline: { type: 'kimi', apiKey: 'sk-inline', env: { KIMI_API_KEY: 'kimi-env-key' } },
        __kimi_env__: { type: 'kimi', apiKey: 'sk-env-overlay' },
        empty: { type: 'openai' },
      },
      models: {},
    });
    try {
      const providers = await catalog.listProviders();
      const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
      expect(byId['kimi']).toMatchObject({ has_api_key: true, api_key_env: 'KIMI_API_KEY', status: 'connected' });
      expect(byId['claude']).toMatchObject({ has_api_key: true, api_key_env: 'ANTHROPIC_API_KEY', status: 'connected' });
      expect(byId['inline']).toMatchObject({ has_api_key: true, status: 'connected' });
      expect(byId['inline']?.api_key).toBeUndefined();
      expect(byId['__kimi_env__']).toMatchObject({ has_api_key: true, api_key_env: 'KIKI_MODEL_API_KEY' });
      expect(byId['empty']).toMatchObject({ has_api_key: false, status: 'unconfigured' });
      for (const id of ['kimi', 'claude', '__kimi_env__']) expect(byId[id]?.api_key).toBeUndefined();
      expect(byId['inline']?.api_key_env).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it('reports only resolved explicit runtime keys as configured and never exposes their values', async () => {
    vi.stubEnv('KIMI_API_KEY', 'undeclared-fixture');
    vi.stubEnv('EXAMPLE_PROVIDER_KEY', 'runtime-fixture');
    vi.stubEnv('EXAMPLE_MISSING_KEY', undefined);
    const { host, catalog } = createHost({
      providers: {
        declared: { type: 'kimi', apiKeyEnv: 'EXAMPLE_PROVIDER_KEY' },
        missing: { type: 'kimi', apiKeyEnv: 'EXAMPLE_MISSING_KEY', env: { KIMI_API_KEY: 'legacy-fixture' } },
        empty: { type: 'kimi', apiKeyEnv: 'EXAMPLE_PROVIDER_KEY', env: { EXAMPLE_PROVIDER_KEY: '' } },
        undeclared: { type: 'kimi' },
      },
      models: {},
    });
    try {
      const byId = Object.fromEntries((await catalog.listProviders()).map((provider) => [provider.id, provider]));
      expect(byId['declared']).toMatchObject({ api_key_env: 'EXAMPLE_PROVIDER_KEY', has_api_key: true, status: 'connected' });
      expect(byId['missing']).toMatchObject({ api_key_env: 'EXAMPLE_MISSING_KEY', has_api_key: false, status: 'unconfigured' });
      expect(byId['empty']).toMatchObject({ api_key_env: 'EXAMPLE_PROVIDER_KEY', has_api_key: false, status: 'unconfigured' });
      expect(byId['undeclared']).toMatchObject({ has_api_key: false, status: 'unconfigured' });
      expect(byId['undeclared']?.api_key_env).toBeUndefined();
      expect(JSON.stringify(byId)).not.toMatch(/runtime-fixture|undeclared-fixture|legacy-fixture/);
    } finally { await host.dispose(); vi.unstubAllEnvs(); }
  });

  it('marks an OAuth provider connected when a cached token exists', async () => {
    const { host, catalog } = createHost(
      {
        providers: { acme: { type: 'kimi', oauth: { storage: 'file', key: 'oauth/acme' } } },
        models: {},
      },
      stubModelOAuthTokens(undefined, 'cached-token'),
    );
    try {
      const [provider] = await catalog.listProviders();
      expect(provider).toMatchObject({ id: 'acme', has_api_key: false, status: 'connected' });
    } finally {
      await host.dispose();
    }
  });

  it('gets a single provider by id and reports provider.not_found for an unknown one', async () => {
    const { host, catalog } = createHost(catalogSections);
    try {
      await expect(catalog.getProvider('kimi')).resolves.toMatchObject({
        id: 'kimi',
        default_model: 'k2',
        models: ['k2', 'turbo'],
      });
      await expect(catalog.getProvider('missing')).rejects.toSatisfy(
        (error) => isError2(error) && error.code === 'provider.not_found',
      );
      expect(isErrorCode('provider.not_found')).toBe(true);
      expect(isErrorCode('model.not_found')).toBe(true);
    } finally {
      await host.dispose();
    }
  });
});

describe('ModelCatalog setDefaultModel', () => {
  it('moves the registry default pointer and returns the wire model', async () => {
    const { host, models, catalog } = createHost(catalogSections);
    try {
      await expect(catalog.setDefaultModel('turbo')).resolves.toEqual({
        default_model: 'turbo',
        model: {
          id: 'turbo',
          effective_protocol: 'openai',
          protocol_source: 'vendor',
          endpoint_source: 'provider',
          auth_source: 'provider',
          provider_id: 'kimi',
          remote_id: 'kimi-turbo',
          display_name: 'Kimi Turbo',
          max_context_size: 32768,
        },
      });
      expect(models.getDefaultModel()).toBe('turbo');
    } finally {
      await host.dispose();
    }
  });

  it('throws model.not_found for an unknown model', async () => {
    const { host, catalog } = createHost(catalogSections);
    try {
      await expect(catalog.setDefaultModel('missing')).rejects.toSatisfy(
        (error) => isError2(error) && error.code === 'model.not_found',
      );
    } finally {
      await host.dispose();
    }
  });

  it('rejects a model that fails materialization', async () => {
    const { host, models, catalog } = createHost({
      providers: {},
      models: {
        bad: {
          model: 'bad-model',
          baseUrl: 'https://x.test/v1',
          apiKey: 'sk',
          oauth: { storage: 'file', key: 'oauth/bad' },
        },
      },
    });
    try {
      await expect(catalog.setDefaultModel('bad')).rejects.toThrow();
      expect(models.getDefaultModel()).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });
});


describe('transient models on configured connections', () => {
  it('uses a connection with no catalog models and preserves its credentials and model registry', async () => {
    const { host, catalog, models } = createHost({ providers: {
      edge: { type: 'openai', apiKey: 'fixture-secret', baseUrl: 'https://example.test/v1' },
    }, models: {} });
    try {
      const requester = catalog.getConnectionRequester('edge', 'remote/custom-model', 65536);
      expect(requester.model).toMatchObject({ name: 'remote/custom-model', providerName: 'edge', protocol: 'openai', maxContextSize: 65536, baseUrl: 'https://example.test/v1' });
      expect(await requester.model.authProvider.getAuth()).toMatchObject({ apiKey: 'fixture-secret' });
      expect(models.list()).toEqual({});
      expect(models.getDefaultModel()).toBeUndefined();
      expect(() => catalog.getConnectionRequester('missing', 'remote/custom-model', 65536)).toThrow('does not exist');
    } finally { await host.dispose(); }
  });
});
