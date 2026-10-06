import { describe, expect, it, vi } from 'vitest';
import { TestInstantiationService } from '#/_base/di/test';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { IConfigService } from '#/app/config/config';
import { IRequestGovernance } from '#/app/requestGovernance/requestGovernance';
import { RequestGovernanceService } from '#/app/requestGovernance/requestGovernanceService';
import { StubConfigService } from '../stubs';
import type OpenAI from 'openai';
import { OpenAIResponsesChatProvider } from '#/kosong/provider/bases/openai/openai-responses';
import { OpenAILegacyChatProvider } from '#/kosong/provider/bases/openai/openai-legacy';

import { isError2 } from '#/_base/errors/errors';
import { APIStatusError, createAbortError } from '#/kosong/contract/errors';
import type { Message, StreamedMessagePart } from '#/kosong/contract/message';
import type {
  ChatProvider,
  GenerateOptions,
  StreamedMessage,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import { emptyUsage, type TokenUsage } from '#/kosong/contract/usage';
import { ProtocolErrors } from '#/kosong/protocol/errors';
import type { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import type { Model } from '#/kosong/model/catalog';
import type { ModelRequestEvent, ModelRequestInput, ModelRequestParams } from '#/kosong/model/modelRequester';
import { effectiveMaxCompletionTokens } from '#/kosong/model/modelRequester';
import { buildStreamTiming, ModelRequesterImpl as ProductionModelRequester } from '#/kosong/model/modelRequesterImpl';

class ModelRequesterImpl extends ProductionModelRequester {
  override request(input: ModelRequestInput, signal?: AbortSignal, params?: ModelRequestParams): AsyncIterable<ModelRequestEvent> {
    return super.request(input, signal, { ...params, attribution: params?.attribution ?? {
      logicalRequestId: 'fixture-request', sessionId: 'fixture-session', agentId: 'main', purpose: 'test', waitBudget: { waitedMs: 0 },
    } });
  }
}

class FakeChatProvider implements ChatProvider {
  readonly name = 'fake-base';
  readonly modelName = 'fake-model';
  readonly thinkingEffort = null;

  uploadVideo?: ChatProvider['uploadVideo'];

  readonly calls: Array<{
    systemPrompt: string;
    tools: Tool[];
    history: unknown;
    options?: GenerateOptions;
  }> = [];

  handler: (callIndex: number) => Promise<StreamedMessage> = () =>
    Promise.resolve(streamOf([{ type: 'text', text: 'hello' }]));

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    this.calls.push({ systemPrompt, tools, history, options });
    options?.onRequestStart?.();
    options?.onRequestSent?.();
    const stream = await this.handler(this.calls.length - 1);
    return stream;
  }
}

function streamOf(
  parts: readonly StreamedMessagePart[],
  options: {
    readonly usage?: TokenUsage;
    readonly finishReason?: StreamedMessage['finishReason'];
    readonly rawFinishReason?: string | null;
    readonly id?: string | null;
    readonly traceId?: string | null;
  } = {},
): StreamedMessage {
  return {
    id: options.id ?? 'msg-1',
    usage: options.usage ?? emptyUsage(),
    finishReason: options.finishReason ?? 'completed',
    rawFinishReason: options.rawFinishReason ?? 'stop',
    traceId: options.traceId ?? null,
    async *[Symbol.asyncIterator]() {
      for (const part of parts) {
        yield part;
      }
    },
  };
}

function registryReturning(provider: ChatProvider): IProtocolAdapterRegistry {
  return {
    _serviceBrand: undefined,
    supportedProtocols: () => [],
    resolveAdapterIdentity: () => {
      throw new Error('not needed');
    },
    resolveProviderBaseId: () => {
      throw new Error('not needed');
    },
    resolveCapability: () => {
      throw new Error('not needed');
    },
    createChatProvider: () => provider,
  } as unknown as IProtocolAdapterRegistry;
}

function modelWith(authProvider: Model['authProvider']): Model {
  return {
    id: 'm1',
    name: 'fake-model',
    aliases: [],
    protocol: 'openai',
    headers: {},
    capabilities: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 128000,
    },
    maxContextSize: 128000,
    alwaysThinking: false,
    providerType: 'fake',
    providerName: 'fake',
    imagePolicy: {
      acceptedTypes: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
      convertUnsupported: 'off',
    },
    authProvider,
  };
}

const staticAuth = (apiKey?: string): Model['authProvider'] => ({
  canRefresh: false,
  getAuth: () =>
    Promise.resolve(apiKey === undefined ? undefined : { apiKey }),
});

async function collect(stream: AsyncIterable<ModelRequestEvent>): Promise<ModelRequestEvent[]> {
  const events: ModelRequestEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const INPUT = { systemPrompt: 'sys', tools: [], messages: [] };

describe('ModelRequesterImpl request execution', () => {
  it.each(['openai', 'openai_responses'] as const)('omits speculative %s output fields and preserves real ceilings on the wire', async (protocol) => {
    const payloads: Record<string, unknown>[] = [];
    const client = {
      chat: { completions: { create: (params: Record<string, unknown>) => {
        payloads.push(params);
        return { withResponse: async () => ({
          response: new Response(),
          data: { id: 'chat-1', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
        }) };
      } } },
      responses: { create: async (params: Record<string, unknown>) => {
        payloads.push(params);
        return { async *[Symbol.asyncIterator]() {
          yield { type: 'response.output_text.delta', delta: 'ok' };
          yield { type: 'response.completed', response: { id: 'response-1', status: 'completed', output: [] } };
        } };
      } },
    } as unknown as OpenAI;
    const provider = protocol === 'openai'
      ? new OpenAILegacyChatProvider({ apiKey: '', model: 'example-model', stream: false, clientFactory: () => client })
      : new OpenAIResponsesChatProvider({ apiKey: '', model: 'example-model', clientFactory: () => client });
    const model = { ...modelWith(staticAuth()), protocol };
    const requester = new ModelRequesterImpl(model, registryReturning(provider));
    await collect(requester.request(INPUT));
    await collect(new ModelRequesterImpl({ ...model, maxContextSize: 0 }, registryReturning(provider)).request(INPUT));
    await collect(requester.request(INPUT, undefined, { maxCompletionTokens: 600 }));
    await collect(new ModelRequesterImpl({ ...model, maxOutputSize: 800 }, registryReturning(provider)).request(INPUT));
    await collect(requester.request(INPUT, undefined, { usedContextTokens: 127500, usedContextTokensTrusted: true }));
    await collect(requester.request(INPUT, undefined, { usedContextTokens: 127500, usedContextTokensTrusted: false }));
    await collect(requester.request(INPUT, undefined, { maxContextTokens: 900, usedContextTokens: 700, usedContextTokensTrusted: true }));
    const largeWindow = { ...model, maxContextSize: 300000 };
    await collect(new ModelRequesterImpl(largeWindow, registryReturning(provider)).request(INPUT, undefined, { maxCompletionTokens: 200000 }));
    await collect(new ModelRequesterImpl({ ...largeWindow, maxOutputSize: 150000 }, registryReturning(provider)).request(INPUT, undefined, { maxCompletionTokens: 200000 }));
    await collect(new ModelRequesterImpl(largeWindow, registryReturning(provider)).request(INPUT, undefined, {
      maxCompletionTokens: 200000, usedContextTokens: 250000, usedContextTokensTrusted: true,
    }));
    const field = protocol === 'openai' ? 'max_tokens' : 'max_output_tokens';
    expect(payloads.map((payload) => payload[field])).toEqual([undefined, undefined, 600, 800, 500, undefined, 200, 200000, 150000, 50000]);
    for (const index of [0, 1, 5]) {
      expect(payloads[index]).not.toHaveProperty('max_tokens');
      expect(payloads[index]).not.toHaveProperty('max_completion_tokens');
      expect(payloads[index]).not.toHaveProperty('max_output_tokens');
    }
  });
  it('uses model tier as a default beneath resolved request overrides without leaking to another model', async () => {
    const provider = new FakeChatProvider();
    const model = modelWith(staticAuth());
    const priority = new ModelRequesterImpl({ ...model, serviceTier: 'priority' }, registryReturning(provider));
    await collect(priority.request(INPUT, undefined, { serviceTier: 'flex', requestParams: { service_tier: 'default' } }));
    await collect(priority.request(INPUT));
    const ordinary = new ModelRequesterImpl(model, registryReturning(provider));
    await collect(ordinary.request(INPUT));
    await collect(ordinary.request(INPUT, undefined, { serviceTier: 'flex' }));
    expect(provider.calls.map((call) => call.options?.serviceTier)).toEqual(['flex', 'priority', undefined, 'flex']);
  });

  it('applies configured zero, API default, false extras and output preference to direct and profiled requests', async () => {
    const provider = new FakeChatProvider();
    const requester = new ModelRequesterImpl({
      ...modelWith(staticAuth()), maxCompletionTokens: 16384, maxOutputSize: 32768,
      requestParams: { temperature: 0.7, top_p: 0.8, feature_enabled: false },
      generationParameters: { temperature: 0, topP: { kind: 'api_default' }, maxCompletionTokens: 16384 },
    }, registryReturning(provider));
    await collect(requester.request(INPUT));
    await collect(requester.request(INPUT, undefined, { maxCompletionTokens: 12000, usedContextTokens: 118000 }));
    expect(provider.calls[0]?.options).toMatchObject({
      sampling: { temperature: 0, topP: undefined }, maxCompletionTokens: 16384,
      requestParams: { feature_enabled: false, temperature: 0.7 },
    });
    expect(provider.calls[0]?.options?.requestParams).not.toHaveProperty('top_p');
    expect(provider.calls[1]?.options?.maxCompletionTokens).toBe(10000);
    await collect(requester.request(INPUT, undefined, { requestParams: { top_p: 0.3 } }));
    expect(provider.calls[2]?.options?.requestParams?.['top_p']).toBe(0.3);
    await expect(collect(requester.request(INPUT, undefined, { usedContextTokens: 128000 })))
      .rejects.toThrow('no remaining context');
    expect(provider.calls).toHaveLength(3);
  });

  it('does not turn an unconfigured output preference into the full context size', async () => {
    const provider = new FakeChatProvider();
    const requester = new ModelRequesterImpl(modelWith(staticAuth()), registryReturning(provider));
    await collect(requester.request(INPUT));
    expect(provider.calls[0]?.options?.maxCompletionTokens).toBeUndefined();
    await collect(requester.request(INPUT, undefined, { usedContextTokens: 0 }));
    expect(provider.calls[1]?.options?.maxCompletionTokens).toBeUndefined();
    await collect(requester.request(INPUT, undefined, { maxContextTokens: 20000, usedContextTokens: 18000 }));
    expect(provider.calls[2]?.options?.maxCompletionTokens).toBe(2000);
  });

  it('lets unknown windows and unverified estimates reach the provider but rejects a measured full window', async () => {
    const provider = new FakeChatProvider();
    const requester = new ModelRequesterImpl(modelWith(staticAuth()), registryReturning(provider));
    await collect(requester.request(INPUT, undefined, {
      maxContextTokens: 0, usedContextTokens: 20, maxCompletionTokens: 500,
    }));
    expect(provider.calls[0]?.options?.maxCompletionTokens).toBe(500);

    await collect(requester.request(INPUT, undefined, {
      maxContextTokens: 2000, usedContextTokens: 21000,
      usedContextTokensTrusted: false, maxCompletionTokens: 500,
    }));
    expect(provider.calls[1]?.options?.maxCompletionTokens).toBe(500);
    expect(provider.calls[1]?.options?.usedContextTokens).toBeUndefined();
    expect(provider.calls[1]?.options?.maxContextTokens).toBe(2000);

    await expect(collect(requester.request(INPUT, undefined, {
      maxContextTokens: 2000, usedContextTokens: 2000,
      usedContextTokensTrusted: true, maxCompletionTokens: 500,
    }))).rejects.toThrow('no remaining context');
    expect(provider.calls).toHaveLength(2);
  });

  it('sends resolved sampling and tier while clamping the final Responses output to remaining context', async () => {
    let payload: unknown;
    const provider = new OpenAIResponsesChatProvider({
      apiKey: '', model: 'example-model', baseUrl: 'https://example.test/v1',
      clientFactory: () => ({ responses: { create: async (params: unknown) => {
        payload = params;
        return { async *[Symbol.asyncIterator]() {
          yield { type: 'response.output_text.delta', delta: 'ok' };
          yield { type: 'response.completed', response: { id: 'response-1', status: 'completed', output: [] } };
        } };
      } } }) as unknown as OpenAI,
    });
    const requester = new ModelRequesterImpl({ ...modelWith(staticAuth()), serviceTier: 'priority' }, registryReturning(provider));
    await collect(requester.request(INPUT, undefined, {
      serviceTier: 'flex', sampling: { temperature: 0.4, topP: 0.8 },
      maxCompletionTokens: 500, maxContextTokens: 1200, usedContextTokens: 1000,
      requestParams: { temperature: 0.9, max_output_tokens: 999999, seed: 42 },
    }));
    expect(payload).toMatchObject({
      model: 'example-model', service_tier: 'flex', temperature: 0.4, top_p: 0.8,
      max_output_tokens: 200, seed: 42,
    });
  });

  it('shapes ChatGPT Codex Responses requests without carrying public API output limits', async () => {
    const payloads: Record<string, unknown>[] = [];
    const provider = new OpenAIResponsesChatProvider({
      apiKey: '', model: 'gpt-5.5', baseUrl: 'https://chatgpt.com/backend-api/codex',
      clientFactory: () => ({ responses: { create: async (params: unknown) => {
        payloads.push(params as Record<string, unknown>);
        return { async *[Symbol.asyncIterator]() {
          yield { type: 'response.output_text.delta', delta: 'ok' };
          yield { type: 'response.completed', response: { id: 'response-1', status: 'completed', output: [] } };
        } };
      } } }) as unknown as OpenAI,
    });
    const requester = new ModelRequesterImpl(modelWith(staticAuth('test-token')), registryReturning(provider));
    await collect(requester.request(INPUT, undefined, { maxCompletionTokens: 512 }));
    expect(payloads[0]).toMatchObject({
      model: 'gpt-5.5', instructions: 'sys', text: { verbosity: 'low' },
      include: ['reasoning.encrypted_content'], tool_choice: 'auto', parallel_tool_calls: true,
      store: false, stream: true,
    });
    expect(payloads[0]).not.toHaveProperty('max_output_tokens');
    expect(payloads[0]).not.toHaveProperty('tools');
    await collect(requester.request({ ...INPUT, tools: [{ name: 'probe', description: 'Probe', parameters: {} }] }));
    expect(payloads[1]?.['tools']).toEqual([{
      type: 'function', name: 'probe', description: 'Probe', parameters: {}, strict: false,
    }]);
  });

  it('passes configured static keys through the normal auth path', async () => {
    const provider = new FakeChatProvider();
    const requester = new ModelRequesterImpl(modelWith(staticAuth('sk-old')), registryReturning(provider));
    await collect(requester.request(INPUT));
    expect(provider.calls[0]?.options?.auth).toEqual({ apiKey: 'sk-old' });
  });

  it('maps ModelRequestParams onto GenerateOptions 1:1', async () => {
    const provider = new FakeChatProvider();
    const requester = new ModelRequesterImpl(modelWith(staticAuth('sk-1')), registryReturning(provider));
    const signal = AbortSignal.timeout(1000);

    await collect(
      requester.request(
        { ...INPUT, responseFormat: { type: 'json_object' } },
        signal,
        {
          cacheKey: 'session-1',
          serviceTier: 'priority',
          headers: {
            'x-kiki-session-id': 'session-1',
            'x-kiki-agent-id': 'agent-1',
          },
          requestParams: {
            seed: 42,
            enabled: true,
            'X-Kiki-Agent-Id': 'spoofed-agent',
          },
          sampling: { temperature: 0.5, topP: 0.9 },
          thinkingEffort: 'high',
          thinkingKeep: 'all',
          maxCompletionTokens: 1024,
          usedContextTokens: 5000,
          maxContextTokens: 128000,
          requestIdentity: {
            responsesClientMetadata: { turn_id: '00000000-0000-7000-8000-000000000004' },
          },
        },
      ),
    );

    expect(provider.calls).toHaveLength(1);
    const options = provider.calls[0]!.options;
    expect(options?.signal?.aborted).toBe(signal.aborted);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.auth).toEqual({ apiKey: 'sk-1' });
    expect(options?.cacheKey).toBe('session-1');
    expect(options?.serviceTier).toBe('priority');
    expect(options?.headers).toEqual({
      'x-kiki-session-id': 'session-1',
      'x-kiki-agent-id': 'agent-1',
    });
    expect(options?.requestParams).toEqual({ seed: 42, enabled: true });
    expect(options?.sampling).toEqual({ temperature: 0.5, topP: 0.9 });
    expect(options?.thinking).toEqual({ effort: 'high', keep: 'all' });
    expect(options?.maxCompletionTokens).toBe(1024);
    expect(options?.usedContextTokens).toBe(5000);
    expect(options?.maxContextTokens).toBe(128000);
    expect(options?.responseFormat).toEqual({ type: 'json_object' });
    expect(options?.requestIdentity?.responsesClientMetadata).toEqual({
      turn_id: '00000000-0000-7000-8000-000000000004',
    });
  });

  it('omits the thinking intent when no effort is requested', async () => {
    const provider = new FakeChatProvider();
    const requester = new ModelRequesterImpl(modelWith(staticAuth()), registryReturning(provider));
    await collect(requester.request(INPUT));
    expect(provider.calls[0]?.options?.thinking).toBeUndefined();
    expect(provider.calls[0]?.options?.auth).toBeUndefined();
  });

  it('streams part, usage, finish, and timing events', async () => {
    const provider = new FakeChatProvider();
    provider.handler = () =>
      Promise.resolve(
        streamOf([{ type: 'text', text: 'hi' }], {
          usage: { ...emptyUsage(), output: 7 },
          id: 'msg-42',
          traceId: 'trace-1',
        }),
      );
    const traceIds: Array<string | null> = [];
    const requester = new ModelRequesterImpl(modelWith(staticAuth()), registryReturning(provider));
    const events = await collect(
      requester.request(INPUT, undefined, { onTraceId: (id) => traceIds.push(id) }),
    );

    const types = events.map((e) => e.type);
    expect(types).toEqual(['part', 'usage', 'finish', 'timing']);
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ usage: { output: 7 }, model: 'fake-model' });
    const finish = events.find((e) => e.type === 'finish');
    expect(finish).toMatchObject({ id: 'msg-42', traceId: 'trace-1', providerFinishReason: 'completed' });
    const timing = events.find((e) => e.type === 'timing');
    expect(timing).toMatchObject({
      requestBuildMs: expect.any(Number),
      serverDecodeMs: expect.any(Number),
      clientConsumeMs: expect.any(Number),
    });
    expect(traceIds).toEqual(['trace-1']);
  });

  it('replays once after a forced token refresh on 401', async () => {
    const provider = new FakeChatProvider();
    provider.handler = (callIndex) =>
      callIndex === 0
        ? Promise.reject(new APIStatusError(401, 'unauthorized'))
        : Promise.resolve(streamOf([{ type: 'text', text: 'ok' }]));
    const authCalls: Array<{ force?: boolean }> = [];
    const requester = new ModelRequesterImpl(
      modelWith({
        canRefresh: true,
        getAuth: (options) => {
          authCalls.push(options ?? {});
          return Promise.resolve({ apiKey: authCalls.length === 1 ? 'tok-1' : 'tok-2' });
        },
      }),
      registryReturning(provider),
    );

    const identity = {
      responsesClientMetadata: { turn_id: '00000000-0000-7000-8000-000000000004' },
    };
    const params = {
      cacheKey: '00000000-0000-4000-8000-000000000002',
      headers: { 'x-grok-req-id': '00000000-0000-4000-8000-000000000004' },
      requestIdentity: identity,
    };
    const events = await collect(requester.request(INPUT, undefined, params));
    expect(events.some((e) => e.type === 'finish')).toBe(true);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.options?.auth).toEqual({ apiKey: 'tok-1' });
    expect(provider.calls[1]?.options?.auth).toEqual({ apiKey: 'tok-2' });
    expect(provider.calls[0]?.options?.requestIdentity).toBe(identity);
    expect(provider.calls[1]?.options?.requestIdentity).toBe(identity);
    expect(provider.calls[0]?.options?.headers).toEqual(provider.calls[1]?.options?.headers);
    expect(provider.calls[0]?.options?.cacheKey).toBe(provider.calls[1]?.options?.cacheKey);
    expect(authCalls).toEqual([{}, { force: true }]);
  });

  it('surfaces a replay-surviving 401 as provider.auth_error', async () => {
    const provider = new FakeChatProvider();
    provider.handler = () => Promise.reject(new APIStatusError(401, 'account rejected'));
    const requester = new ModelRequesterImpl(
      modelWith({
        canRefresh: true,
        getAuth: () => Promise.resolve({ apiKey: 'tok' }),
      }),
      registryReturning(provider),
    );

    const failure = await collect(requester.request(INPUT)).catch((error: unknown) => error);
    expect(isError2(failure)).toBe(true);
    expect((failure as { code: string }).code).toBe(ProtocolErrors.codes.PROVIDER_AUTH_ERROR);
    expect((failure as Error).message).toContain('account rejected');
    expect(provider.calls).toHaveLength(2);
  });

  it('does not replay 401s against a non-refreshable auth provider', async () => {
    const provider = new FakeChatProvider();
    provider.handler = () => Promise.reject(new APIStatusError(401, 'bad key'));
    const requester = new ModelRequesterImpl(
      modelWith(staticAuth('sk-bad')),
      registryReturning(provider),
    );

    const failure = await collect(requester.request(INPUT)).catch((error: unknown) => error);
    expect((failure as { code: string }).code).toBe(ProtocolErrors.codes.PROVIDER_AUTH_ERROR);
    expect(provider.calls).toHaveLength(1);
  });

  it('translates other provider failures and rethrows aborts untouched', async () => {
    const provider = new FakeChatProvider();
    provider.handler = () => Promise.reject(new APIStatusError(500, 'boom'));
    const requester = new ModelRequesterImpl(modelWith(staticAuth()), registryReturning(provider));
    const failure = await collect(requester.request(INPUT)).catch((error: unknown) => error);
    expect((failure as { code: string }).code).toBe(ProtocolErrors.codes.PROVIDER_API_ERROR);

    const abort = createAbortError();
    provider.handler = () => Promise.reject(abort);
    const aborted = await collect(requester.request(INPUT)).catch((error: unknown) => error);
    expect(aborted).toBe(abort);
  });

  it('uploadVideo presence is the capability declaration', async () => {
    const provider = new FakeChatProvider();
    const requester = new ModelRequesterImpl(
      modelWith(staticAuth('sk-1')),
      registryReturning(provider),
    );
    await expect(requester.uploadVideo('file-id')).rejects.toThrow(/does not support video upload/);

    const uploadCalls: Array<GenerateOptions | undefined> = [];
    provider.uploadVideo = (_input, options) => {
      uploadCalls.push(options);
      return Promise.resolve({ type: 'video_url', videoUrl: { url: 'https://cdn.example.test/v.mp4' } });
    };
    const part = await requester.uploadVideo('file-id');
    expect(part).toEqual({ type: 'video_url', videoUrl: { url: 'https://cdn.example.test/v.mp4' } });
    expect(uploadCalls[0]?.auth).toEqual({ apiKey: 'sk-1' });
  });
});

describe('effectiveMaxCompletionTokens', () => {
  it('reads the folded budget back from the params', () => {
    expect(effectiveMaxCompletionTokens(undefined)).toBeUndefined();
    expect(effectiveMaxCompletionTokens({})).toBeUndefined();
    expect(effectiveMaxCompletionTokens({ maxCompletionTokens: 512 })).toBe(512);
  });
});

describe('buildStreamTiming', () => {
  it('returns base TTFT and stream duration only', () => {
    expect(buildStreamTiming(100, undefined, 250, 400, undefined)).toEqual({
      firstTokenLatencyMs: 150,
      streamDurationMs: 150,
    });
  });

  it('splits TTFT across the request-sent boundary', () => {
    expect(buildStreamTiming(100, 180, 250, 400, undefined)).toEqual({
      firstTokenLatencyMs: 150,
      streamDurationMs: 150,
      requestBuildMs: 80,
      serverFirstTokenMs: 70,
    });
  });

  it('adds decode stats when present', () => {
    expect(
      buildStreamTiming(100, 120, 250, 400, { serverDecodeMs: 90, clientConsumeMs: 60 }),
    ).toEqual({
      firstTokenLatencyMs: 150,
      streamDurationMs: 150,
      requestBuildMs: 20,
      serverFirstTokenMs: 130,
      serverDecodeMs: 90,
      clientConsumeMs: 60,
    });
  });
});


describe('ModelRequesterImpl attempt admission', () => {
  it('releases each attempt once before tool work and reacquires OAuth replay with the same logical identity', async () => {
    const provider = new FakeChatProvider();
    provider.handler = async (index) => {
      if (index === 0) throw new APIStatusError(401, 'expired');
      return streamOf([{ type: 'text', text: 'ready for tools' }]);
    };
    const attempts: import('#/kosong/model/requestAdmission').RequestAttempt[] = [];
    const release = vi.fn();
    const requester = new ModelRequesterImpl(modelWith({ canRefresh: true, getAuth: async () => ({ apiKey: 'example-key' }) }), registryReturning(provider), {
      acquire: async (attempt) => { attempts.push(attempt); return { release }; },
    });
    await collect(requester.request(INPUT));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.logicalRequestId).toBe(attempts[1]!.logicalRequestId);
    expect(attempts[0]!.attemptId).not.toBe(attempts[1]!.attemptId);
    expect(release).toHaveBeenCalledTimes(2);
    const tool = vi.fn(() => expect(release).toHaveBeenCalledTimes(2));
    tool();
  });

  it.each(['end', 'error', 'abort', 'consumer-return'] as const)('holds the permit through controlled stream cleanup: %s', async (outcome) => {
    const provider = new FakeChatProvider();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    let started!: () => void;
    const streaming = new Promise<void>((resolve) => { started = resolve; });
    let cleaned = false;
    provider.handler = async () => ({
      ...streamOf([]),
      async *[Symbol.asyncIterator]() {
        try {
          yield { type: 'text' as const, text: 'partial' };
          started();
          const signal = provider.calls[0]!.options!.signal!;
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
            void held.then(resolve);
          });
          if (outcome === 'error') throw new APIStatusError(500, 'failed');
        } finally { cleaned = true; }
      },
    });
    const release = vi.fn(() => expect(cleaned).toBe(true));
    const acquire = vi.fn(async () => ({ release }));
    const requester = new ModelRequesterImpl(modelWith(staticAuth()), registryReturning(provider), { acquire });
    const controller = new AbortController();
    if (outcome === 'consumer-return') {
      const iterator = requester.request(INPUT, controller.signal)[Symbol.asyncIterator]();
      await iterator.next(); await streaming;
      expect(release).not.toHaveBeenCalled();
      await iterator.return!();
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
    } else {
      const result = collect(requester.request(INPUT, controller.signal));
      const expected = outcome === 'end' ? expect(result).resolves.toBeDefined() : expect(result).rejects.toBeDefined();
      await streaming;
      expect(release).not.toHaveBeenCalled();
      if (outcome === 'abort') controller.abort(); else finish();
      await expected;
    }
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('checks cancellation after admission before invoking a provider', async () => {
    const provider = new FakeChatProvider();
    const controller = new AbortController();
    const release = vi.fn();
    const requester = new ModelRequesterImpl(modelWith(staticAuth()), registryReturning(provider), {
      acquire: async () => { controller.abort(); return { release }; },
    });
    await expect(collect(requester.request(INPUT, controller.signal))).rejects.toBeDefined();
    expect(provider.calls).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
  });
});


it('limits actual native provider streams from two sessions to two, and never sends cancelled queued requests', async () => {
  const ix = new TestInstantiationService();
  ix.set(IConfigService, new StubConfigService({ requestGovernance: { rules: [{ id: 'cap', maxConcurrent: 2 }] } }));
  ix.set(IRequestGovernance, new SyncDescriptor(RequestGovernanceService));
  const governor = ix.get(IRequestGovernance);
  const provider = new FakeChatProvider();
  let liveStreams = 0;
  let peak = 0;
  let finish!: () => void;
  let held = new Promise<void>((resolve) => { finish = resolve; });
  provider.handler = async () => {
    liveStreams += 1;
    peak = Math.max(peak, liveStreams);
    return { ...streamOf([]), async *[Symbol.asyncIterator]() {
      try {
        await held;
        yield { type: 'text' as const, text: 'complete' };
      } finally { liveStreams -= 1; }
    } };
  };
  const requester = new ModelRequesterImpl(modelWith(staticAuth()), registryReturning(provider), governor);
  const attribution = (sessionId: string) => ({ logicalRequestId: `logical-${sessionId}`, sessionId, agentId: 'main', purpose: 'turn', waitBudget: { waitedMs: 0 } });
  try {
    const work = Array.from({ length: 40 }, (_, index) => collect(requester.request(INPUT, undefined, { attribution: attribution(index % 2 === 0 ? 'session-a' : 'session-b') })));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(provider.calls).toHaveLength(2);
    expect(governor.snapshot()).toMatchObject({ active: 2, queued: 38 });
    const cancelled = new AbortController();
    const result = collect(requester.request(INPUT, cancelled.signal, { attribution: attribution('session-c') }));
    const rejection = expect(result).rejects.toBeDefined();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(governor.snapshot().queued).toBe(39);
    cancelled.abort(); await rejection;
    held = Promise.resolve(); finish();
    await Promise.all(work);
    expect(provider.calls).toHaveLength(40);
    expect(peak).toBe(2);
    expect(liveStreams).toBe(0);
    expect(governor.snapshot()).toMatchObject({ active: 0, queued: 0 });
  } finally { await ix.dispose(); }
});

it('requires an explicit requester owner at runtime instead of inferring system ownership', () => {
  const requester = new ProductionModelRequester(modelWith(staticAuth()), registryReturning(new FakeChatProvider()));
  const missing = requester.request as unknown as (input: typeof INPUT) => unknown;
  expect(() => missing.call(requester, INPUT)).toThrow(/explicit session or system attribution/);
});

it('queues a session-owned auxiliary model request behind that session main slot', async () => {
  const ix = new TestInstantiationService();
  ix.set(IConfigService, new StubConfigService({ requestGovernance: { rules: [{ id: 'session-cap', scope: 'each_session', maxConcurrent: 1 }] } }));
  ix.set(IRequestGovernance, new SyncDescriptor(RequestGovernanceService));
  const governor = ix.get(IRequestGovernance);
  const provider = new FakeChatProvider();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  provider.handler = async (index) => {
    if (index === 0) await gate;
    return streamOf([{ type: 'text', text: 'done' }]);
  };
  const requester = new ProductionModelRequester(modelWith(staticAuth()), registryReturning(provider), governor);
  const owner = { logicalRequestId: 'main', sessionId: 's1', agentId: 'main', purpose: 'turn', waitBudget: { waitedMs: 0 } };
  try {
    const main = collect(requester.request(INPUT, undefined, { attribution: owner }));
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const auxiliary = collect(requester.request(INPUT, undefined, { attribution: { ...owner, logicalRequestId: 'title', purpose: 'session_title' } }));
    await vi.waitFor(() => expect(governor.snapshot().queued).toBe(1));
    expect(provider.calls).toHaveLength(1);
    release();
    await Promise.all([main, auxiliary]);
    expect(provider.calls).toHaveLength(2);
    expect(governor.snapshot()).toMatchObject({ active: 0, queued: 0 });
  } finally { release(); await ix.dispose(); }
});
