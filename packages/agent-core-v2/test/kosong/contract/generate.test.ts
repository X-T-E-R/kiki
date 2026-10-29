import { describe, expect, it, vi } from 'vitest';

import { APIEmptyResponseError, ChatProviderError, isRetryableGenerateError, markProviderEventError } from '#/kosong/contract/errors';
import { generate, readGenerateFailureFacts, readGenerateFailureUsage, type GenerateResult } from '#/kosong/contract/generate';
import type { Message, StreamedMessagePart, ToolCall } from '#/kosong/contract/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  StreamedMessage,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';

const USAGE: TokenUsage = { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 1 };

function promiseGate<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeStreamedMessage implements StreamedMessage {
  readonly id: string | null = 'gen-1';
  readonly usage: TokenUsage | null = USAGE;
  readonly finishReason: FinishReason | null = 'completed';
  readonly rawFinishReason: string | null = 'stop';
  readonly traceId?: string | null;
  cancelCalls = 0;

  constructor(
    private readonly parts: readonly StreamedMessagePart[],
    init: {
      readonly traceId?: string | null;
      readonly onBeforeYield?: (index: number) => void;
    } = {},
  ) {
    this.traceId = init.traceId;
    this.onBeforeYield = init.onBeforeYield;
  }

  private readonly onBeforeYield?: (index: number) => void;

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    for (const [index, part] of this.parts.entries()) {
      this.onBeforeYield?.(index);
      yield part;
    }
  }

  cancel(): void {
    this.cancelCalls++;
  }
}

interface FakeProvider {
  readonly provider: ChatProvider;
  readonly generateSpy: ReturnType<typeof vi.fn>;
}

function createFakeProvider(stream: StreamedMessage): FakeProvider {
  const generateSpy = vi.fn(
    async (
      _systemPrompt: string,
      _tools: Tool[],
      _history: Message[],
      _options?: GenerateOptions,
    ): Promise<StreamedMessage> => stream,
  );
  const provider: ChatProvider = {
    name: 'fake',
    modelName: 'fake-model',
    thinkingEffort: null,
    generate: generateSpy,
  };
  return { provider, generateSpy };
}

const SYSTEM_PROMPT = 'You are a test.';
const NO_TOOLS: Tool[] = [];
const HISTORY: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
];

describe('generate() stream normalization', () => {
  it('merges text and think deltas into single content parts', async () => {
    const stream = new FakeStreamedMessage([
      { type: 'think', think: 'let me ' },
      { type: 'think', think: 'think' },
      { type: 'text', text: 'Hello, ' },
      { type: 'text', text: 'world' },
    ]);
    const { provider } = createFakeProvider(stream);

    const result = await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY);

    expect(result.message.content).toEqual([
      { type: 'think', think: 'let me think' },
      { type: 'text', text: 'Hello, world' },
    ]);
    expect(result.finishReason).toBe('completed');
    expect(result.usage).toBe(USAGE);
    expect(result.id).toBe('gen-1');
  });

  it('keeps a text run merged across a vacuous reasoning part', async () => {
    const stream = new FakeStreamedMessage([
      { type: 'text', text: 'Hello, ' },
      { type: 'think', think: '' },
      { type: 'text', text: 'world' },
    ]);
    const { provider } = createFakeProvider(stream);

    const result = await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY);

    expect(result.message.content).toEqual([{ type: 'text', text: 'Hello, world' }]);
  });

  it('keeps a non-empty reasoning part between text runs', async () => {
    const stream = new FakeStreamedMessage([
      { type: 'text', text: 'Hello, ' },
      { type: 'think', think: 'why' },
      { type: 'text', text: 'world' },
    ]);
    const { provider } = createFakeProvider(stream);

    const result = await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY);

    expect(result.message.content).toEqual([
      { type: 'text', text: 'Hello, ' },
      { type: 'think', think: 'why' },
      { type: 'text', text: 'world' },
    ]);
  });

  it.each([false, true])('merges deferred thinking signatures without losing them before later text (%s)', async (laterText) => {
    const stream = new FakeStreamedMessage([
      { type: 'text', text: 'Answer' },
      { type: 'think', think: '' },
      { type: 'think', think: '', encrypted: 'sig-example' },
      ...(laterText ? [{ type: 'text' as const, text: 'More' }] : []),
    ]);
    const { provider } = createFakeProvider(stream);
    const result = await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY);
    expect(result.message.content).toEqual([
      { type: 'text', text: 'Answer' },
      { type: 'think', think: '', encrypted: 'sig-example' },
      ...(laterText ? [{ type: 'text', text: 'More' }] : []),
    ]);
  });

  it('keeps a trailing vacuous reasoning part in its position', async () => {
    const stream = new FakeStreamedMessage([
      { type: 'text', text: 'Hello' },
      { type: 'think', think: '   ' },
    ]);
    const { provider } = createFakeProvider(stream);

    const result = await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY);

    expect(result.message.content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'think', think: '   ' },
    ]);
  });

  it('keeps a vacuous reasoning part before a tool call', async () => {
    const call: ToolCall = { type: 'function', id: 'call-a', name: 'toolA', arguments: '{}' };
    const stream = new FakeStreamedMessage([
      { type: 'text', text: 'ok' },
      { type: 'think', think: '' },
      call,
    ]);
    const { provider } = createFakeProvider(stream);

    const result = await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY);

    expect(result.message.content).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'think', think: '' },
    ]);
    expect(result.message.toolCalls).toHaveLength(1);
  });

  it('assembles tool calls from streamed argument deltas by stream index', async () => {
    const callA: ToolCall = {
      type: 'function',
      id: 'call-a',
      name: 'toolA',
      arguments: null,
      _streamIndex: 0,
    };
    const callB: ToolCall = {
      type: 'function',
      id: 'call-b',
      name: 'toolB',
      arguments: '{"y":2}',
      _streamIndex: 1,
    };
    const stream = new FakeStreamedMessage([
      callA,
      callB,
      { type: 'tool_call_part', argumentsPart: '{"x":', index: 0 },
      { type: 'tool_call_part', argumentsPart: '1}', index: 0 },
    ]);
    const { provider } = createFakeProvider(stream);

    const result = await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY);

    expect(result.message.toolCalls).toEqual([
      { type: 'function', id: 'call-a', name: 'toolA', arguments: '{"x":1}', extras: undefined },
      { type: 'function', id: 'call-b', name: 'toolB', arguments: '{"y":2}', extras: undefined },
    ]);
  });

  it('hands callbacks deep-copied parts and the final tool calls', async () => {
    const stream = new FakeStreamedMessage([
      { type: 'text', text: 'abc' },
      {
        type: 'function',
        id: 'call-a',
        name: 'toolA',
        arguments: '{}',
      },
    ]);
    const { provider } = createFakeProvider(stream);
    const seenParts: StreamedMessagePart[] = [];
    const seenCalls: ToolCall[] = [];

    const result = await generate(
      provider,
      SYSTEM_PROMPT,
      NO_TOOLS,
      HISTORY,
      {
        onMessagePart: (part) => {
          seenParts.push(structuredClone(part));
          if (part.type === 'text') part.text = 'MUTATED';
        },
        onToolCall: (call) => {
          seenCalls.push(call);
        },
      },
    );

    expect(seenParts).toHaveLength(2);
    expect(result.message.content).toEqual([{ type: 'text', text: 'abc' }]);
    expect(seenCalls).toEqual([
      { type: 'function', id: 'call-a', name: 'toolA', arguments: '{}', extras: undefined },
    ]);
  });

  it('filters deferred tools before calling the provider', async () => {
    const stream = new FakeStreamedMessage([{ type: 'text', text: 'ok' }]);
    const { provider, generateSpy } = createFakeProvider(stream);
    const tools: Tool[] = [
      { name: 'visible', description: 'v', parameters: {} },
      { name: 'hidden', description: 'h', parameters: {}, deferred: true },
    ];

    await generate(provider, SYSTEM_PROMPT, tools, HISTORY);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    const sentTools = generateSpy.mock.calls[0]?.[1] as Tool[];
    expect(sentTools.map((tool) => tool.name)).toEqual(['visible']);
  });

  it.each([{ parts: [] }, { parts: [{ type: 'think' as const, think: 'only thinking' }] }])(
    'accepts explicitly completed output without text or tool calls: $parts',
    async ({ parts }) => {
      const stream = new FakeStreamedMessage(parts);
      const { provider, generateSpy } = createFakeProvider(stream);
      const onStreamEnd = vi.fn();
      const result = await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY, undefined, { onStreamEnd });

      expect(result.message).toEqual({ role: 'assistant', content: parts, toolCalls: [] });
      expect(result.finishReason).toBe('completed');
      expect(result.rawFinishReason).toBe('stop');
      expect(result.usage).toBe(USAGE);
      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(onStreamEnd).toHaveBeenCalledTimes(1);
    },
  );

  it.each([null, 'truncated', 'filtered', 'paused', 'other', 'tool_calls'] as const)(
    'still rejects output without text or tools when completion is %s',
    async (finishReason) => {
      class UncompletedStream extends FakeStreamedMessage {
        override readonly finishReason: FinishReason | null = finishReason;
        override readonly rawFinishReason: string | null = 'completed';
      }
      for (const parts of [[], [{ type: 'think' as const, think: 'only thinking' }]]) {
        const { provider } = createFakeProvider(new UncompletedStream(parts));
        const error = await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(APIEmptyResponseError);
        expect(isRetryableGenerateError(error)).toBe(parts.length === 0 && finishReason !== 'filtered');
      }
    },
  );

  it('returns a CONTINUATION thinking partial instead of treating it as an empty response', async () => {
    class ContinuationStream extends FakeStreamedMessage {
      override readonly finishReason: FinishReason | null = 'other';
      override readonly rawFinishReason: string | null = 'CONTINUATION';
    }
    const parts = [{ type: 'think' as const, think: 'partial thought', encrypted: 'sig-fixture' }];
    const { provider } = createFakeProvider(new ContinuationStream(parts));
    const result = await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY);
    expect(result.finishReason).toBe('other');
    expect(result.rawFinishReason).toBe('CONTINUATION');
    expect(result.message.content).toEqual(parts);
  });

  it('marks a provider-filtered thinking-only response as non-retryable', async () => {
    class FilteredStream extends FakeStreamedMessage {
      override readonly finishReason: FinishReason | null = 'filtered';
      override readonly rawFinishReason: string | null = 'content_filter';
    }
    const stream = new FilteredStream([{ type: 'think', think: 'filtered mid-thought' }]);
    const { provider } = createFakeProvider(stream);

    const caught = await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY).catch(
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(APIEmptyResponseError);
    expect(isRetryableGenerateError(caught)).toBe(false);
  });

  it('forwards the trace id to onTraceId and the result', async () => {
    const stream = new FakeStreamedMessage([{ type: 'text', text: 'ok' }], {
      traceId: 'trace-123',
    });
    const { provider } = createFakeProvider(stream);
    const onTraceId = vi.fn();

    const result: GenerateResult = await generate(
      provider,
      SYSTEM_PROMPT,
      NO_TOOLS,
      HISTORY,
      undefined,
      { onTraceId },
    );

    expect(onTraceId).toHaveBeenCalledWith('trace-123');
    expect(result.traceId).toBe('trace-123');
  });

  it('reports stream timing stats via onStreamEnd', async () => {
    const stream = new FakeStreamedMessage([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
    const { provider } = createFakeProvider(stream);
    const onStreamEnd = vi.fn();

    await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY, undefined, { onStreamEnd });

    expect(onStreamEnd).toHaveBeenCalledTimes(1);
    const stats = onStreamEnd.mock.calls[0]?.[0] as
      | { serverDecodeMs: number; clientConsumeMs: number }
      | undefined;
    expect(stats).toBeDefined();
    expect(stats?.serverDecodeMs).toBeGreaterThanOrEqual(0);
    expect(stats?.clientConsumeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('generate() abort contract', () => {
  it.each(['waiting-for-chunk', 'slow-consumer'] as const)('actively cancels a silent provider while %s', async (phase) => {
    const controller = new AbortController();
    const waiting = promiseGate<void>();
    const closed = promiseGate<void>();
    const consuming = promiseGate<void>();
    const consumerDone = promiseGate<void>();
    const cancel = vi.fn(() => closed.resolve());
    const stream: StreamedMessage & { cancel(): void } = {
      id: null, usage: null, finishReason: null, rawFinishReason: null,
      cancel,
      async *[Symbol.asyncIterator]() {
        if (phase === 'slow-consumer') yield { type: 'text', text: 'partial' };
        waiting.resolve();
        await closed.promise;
      },
    };
    const { provider } = createFakeProvider(stream);
    const result = generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY, {
      onMessagePart: async () => { consuming.resolve(); await consumerDone.promise; },
    }, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await (phase === 'slow-consumer' ? consuming.promise : waiting.promise);
    const startedAt = performance.now();
    controller.abort();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(performance.now() - startedAt).toBeLessThanOrEqual(200);
    consumerDone.resolve();
    await rejected;
    expect(performance.now() - startedAt).toBeLessThanOrEqual(1000);
  });

  it('does not report cancellation complete for a provider that ignores both signal and cancel', async () => {
    const waiting = promiseGate<void>();
    const release = promiseGate<void>();
    const controller = new AbortController();
    let settled = false;
    const stream: StreamedMessage = {
      id: null, usage: null, finishReason: null, rawFinishReason: null,
      [Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
        return { next: async () => { waiting.resolve(); await release.promise; return { done: true, value: undefined }; } };
      },
    };
    const { provider } = createFakeProvider(stream);
    const result = generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY, undefined, { signal: controller.signal });
    void result.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await waiting.promise;
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release.resolve();
    await rejected;
  });

  it('throws the standard abort DOMException when the signal is already aborted', async () => {
    const stream = new FakeStreamedMessage([{ type: 'text', text: 'ok' }]);
    const { provider, generateSpy } = createFakeProvider(stream);
    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY, undefined, {
        signal: controller.signal,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it('cancels the stream and throws the standard abort DOMException on mid-stream abort', async () => {
    const controller = new AbortController();
    const stream = new FakeStreamedMessage(
      [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
      {
        onBeforeYield: (index) => {
          if (index === 1) controller.abort();
        },
      },
    );
    const { provider } = createFakeProvider(stream);

    let caught: unknown;
    try {
      await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY, undefined, {
        signal: controller.signal,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
    expect(stream.cancelCalls).toBeGreaterThan(0);
  });
});

describe('generate() per-turn intent passthrough', () => {
  it('passes the GenerateOptions intent fields through to the provider', async () => {
    const stream = new FakeStreamedMessage([{ type: 'text', text: 'ok' }]);
    const { provider, generateSpy } = createFakeProvider(stream);
    const options: GenerateOptions = {
      cacheKey: 'session-42',
      sampling: { temperature: 0.7, topP: 0.9 },
      thinking: { effort: 'high', keep: 'all' },
      maxCompletionTokens: 4096,
      usedContextTokens: 1000,
      maxContextTokens: 128000,
    };

    await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY, undefined, options);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(generateSpy.mock.calls[0]?.[3]).toBe(options);
  });
});


describe('locally observed thinking-only failure facts', () => {
  it.each(['text', 'tool', 'refusal', 'grounding', 'partial', 'empty', 'wrong-code'] as const)('rejects recovery facts for %s', async mode => {
    const error = markProviderEventError(new ChatProviderError('fixture failure'), mode === 'wrong-code' ? 'antigravity_missing_terminal' : 'antigravity_thinking_only');
    const stream: StreamedMessage = {
      id: null, usage: USAGE, finishReason: mode === 'partial' ? 'truncated' : null, rawFinishReason: null,
      thinkingOnlyRecoveryBlocked: mode === 'refusal' || mode === 'grounding',
      async *[Symbol.asyncIterator]() {
        if (mode !== 'empty') yield { type: 'think', think: 'private thought', encrypted: 'signature-fixture' };
        if (mode === 'text') yield { type: 'text', text: 'body' };
        if (mode === 'tool') yield { type: 'function', id: 'call_fixture', name: 'Lookup', arguments: '{}' };
        throw error;
      },
    };
    const { provider } = createFakeProvider(stream);
    await expect(generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY)).rejects.toBe(error);
    expect(readGenerateFailureFacts(error)).toBeUndefined();
    expect(readGenerateFailureUsage(error)).toBe(USAGE);
  });

  it.each([USAGE, null])('retains known failure usage without granting a blocked thinking-only completion recovery facts', async usage => {
    const stream: StreamedMessage = {
      id: null, usage, finishReason: 'completed', rawFinishReason: 'STOP',
      thinkingOnlyRecoveryBlocked: true,
      async *[Symbol.asyncIterator]() { yield { type: 'think', think: 'private thought', encrypted: 'signature-fixture' }; },
    };
    const { provider } = createFakeProvider(stream);
    const error = await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(APIEmptyResponseError);
    expect(isRetryableGenerateError(error)).toBe(false);
    expect(readGenerateFailureFacts(error)).toBeUndefined();
    expect(readGenerateFailureUsage(error)).toBe(usage ?? undefined);
    expect(JSON.stringify(error)).not.toMatch(/private thought|signature-fixture/);
  });
});
