import { APIEmptyResponseError, createAbortError, isAbortError, noteExecutedRequestDelivery, readProviderEventErrorCode } from './errors';
import { attachErrorDetails } from '#/_base/errors/errors';
import { attachStreamDiagnostics, type StreamDiagnostics } from './streamDiagnostics';
import {
  isContentPart,
  isToolCall,
  isToolCallPart,
  isVacuousContentPart,
  mergeInPlace,
  type Message,
  type StreamedMessagePart,
  type ThinkPart,
  type ToolCall,
} from './message';
import type { ChatProvider, FinishReason, GenerateOptions, StreamedMessage } from './provider';
import type { Tool } from './tool';
import type { TokenUsage } from './usage';

type StoredToolCall = Omit<ToolCall, '_streamIndex'>;

export interface GenerateResult {
  readonly id: string | null;
  readonly message: Message;
  readonly usage: TokenUsage | null;
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;
  readonly traceId?: string | null;
  readonly diagnostics?: StreamDiagnostics;
  readonly completionAuthority?: 'normal';
}

export interface GenerateFailureFacts {
  readonly message: Message;
  readonly usage: TokenUsage | null;
}

const THINKING_ONLY_STOP_CODE = 'antigravity_thinking_only';
const generateFailureFacts = new WeakMap<object, GenerateFailureFacts>();
const generateFailureUsage = new WeakMap<object, TokenUsage>();

/** Provider-reported usage retained on a failed attempt without exposing response content. */
export function readGenerateFailureUsage(error: unknown): TokenUsage | undefined {
  let current = error;
  while (typeof current === 'object' && current !== null) {
    const usage = generateFailureUsage.get(current);
    if (usage !== undefined) return usage;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/** The locally observed message and usage of a stream that already produced output
 *  before its provider reported a clean thinking-only stop. Content stays out of the
 *  error and its payload; only a caller recovering this exact failure may read it. */
export function readGenerateFailureFacts(error: unknown): GenerateFailureFacts | undefined {
  let current = error;
  while (typeof current === 'object' && current !== null) {
    const facts = generateFailureFacts.get(current);
    if (facts !== undefined) return facts;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

export interface GenerateCallbacks {
  onMessagePart?: (part: StreamedMessagePart) => void | Promise<void>;
  onToolCall?: (toolCall: ToolCall) => void | Promise<void>;
}

export async function generate(
  provider: ChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
  callbacks?: GenerateCallbacks,
  options?: GenerateOptions,
): Promise<GenerateResult> {
  const message: Message = { role: 'assistant', content: [], toolCalls: [] };
  let pendingPart: StreamedMessagePart | null = null;
  let deferredThink: ThinkPart | null = null;

  const toolCallIndexMap = new Map<number | string, number>();

  const flushPending = (): void => {
    if (pendingPart !== null) {
      flushPart(message, pendingPart, toolCallIndexMap);
      pendingPart = null;
    }
    if (deferredThink !== null) {
      message.content.push(deferredThink);
      deferredThink = null;
    }
  };

  if (options?.signal?.aborted) {
    throw createAbortError();
  }

  const wireTools = tools.some((tool) => tool.deferred === true)
    ? tools.filter((tool) => tool.deferred !== true)
    : tools;

  options?.onRequestStart?.();
  const stream = await provider.generate(systemPrompt, wireTools, history, options);
  let cancellation: Promise<void> | undefined;
  const onAbort = (): void => {
    cancellation ??= cancelStream(stream);
    void cancellation.catch(() => undefined);
  };
  options?.signal?.addEventListener('abort', onAbort, { once: true });
  if (options?.signal?.aborted) onAbort();
  try {
    if (stream.traceId !== undefined) {
      options?.onTraceId?.(stream.traceId);
    }

    await throwIfAborted(options?.signal);

    let serverDecodeMs = 0;
    let clientConsumeMs = 0;
    let firstPartAt: number | undefined;
    let lastResumeAt = 0;

    for await (const part of stream) {
      const arrivedAt = Date.now();
      if (firstPartAt === undefined) {
        firstPartAt = arrivedAt;
      } else {
        serverDecodeMs += arrivedAt - lastResumeAt;
      }

      try {
        await throwIfAborted(options?.signal);

        if (callbacks?.onMessagePart !== undefined) {
          await callbacks.onMessagePart(deepCopyPart(part));
          await throwIfAborted(options?.signal);
        }

        if (
          isToolCallPart(part) &&
          part.index !== undefined &&
          !isPendingToolCallAtIndex(pendingPart, part.index)
        ) {
          const arrayIdx = toolCallIndexMap.get(part.index);
          if (arrayIdx !== undefined) {
            const target = message.toolCalls[arrayIdx];
            if (target !== undefined && part.argumentsPart !== null) {
              target.arguments =
                target.arguments === null
                  ? part.argumentsPart
                  : target.arguments + part.argumentsPart;
            }
            continue;
          }
        }

        if (part.type === 'text' && deferredThink !== null && isVacuousContentPart(deferredThink)) {
          deferredThink = null;
        }
        if (deferredThink !== null && part.type === 'think' && mergeInPlace(deferredThink, part)) {
          continue;
        }
        if (deferredThink !== null) flushPending();
        if (pendingPart === null) {
          pendingPart = part;
        } else if (pendingPart.type === 'text' && part.type === 'think' && isVacuousContentPart(part)) {
          deferredThink = structuredClone(part);
        } else if (!mergeInPlace(pendingPart, part)) {
          flushPending();
          pendingPart = part;
        }
      } finally {
        lastResumeAt = Date.now();
        clientConsumeMs += lastResumeAt - arrivedAt;
      }
    }

    await throwIfAborted(options?.signal);
    if (firstPartAt !== undefined) {
      serverDecodeMs += Date.now() - lastResumeAt;
    }
    options?.onStreamEnd?.(
      firstPartAt === undefined ? undefined : { serverDecodeMs, clientConsumeMs },
    );

    flushPending();
    const diagnostics = stream.diagnostics;
    const normallyCompleted = stream.finishReason === 'completed' && (
      diagnostics === undefined || (
        diagnostics.endSource === 'terminal' && diagnostics.terminalStatus === 'completed'
      )
    );
    const googleContinuation = stream.rawFinishReason === 'CONTINUATION';
    if (!googleContinuation && !normallyCompleted && message.content.length === 0 && message.toolCalls.length === 0) {
      throw new APIEmptyResponseError(
        'The API returned an empty response (no content, no tool calls).' +
          formatFinishReasonHint(stream) +
          ` Provider: ${provider.name}, model: ${provider.modelName}`,
        {
          finishReason: stream.finishReason,
          rawFinishReason: stream.rawFinishReason,
        },
      );
    }

    const hasThink = message.content.some((p) => p.type === 'think');
    const hasText = message.content.some((p) => p.type === 'text' && p.text.trim().length > 0);
    const hasToolCalls = message.toolCalls.length > 0;

    const blockedThinking = stream.thinkingOnlyRecoveryBlocked === true && message.content.some(part => part.type === 'think' && !isVacuousContentPart(part));
    if (!googleContinuation && (!normallyCompleted || blockedThinking) && hasThink && !hasText && !hasToolCalls) {
      throw new APIEmptyResponseError(
        'The API returned a response containing only thinking content ' +
          'without any text or tool calls. This usually indicates the ' +
          'stream was interrupted or the output token budget was exhausted ' +
          'during reasoning.' +
          formatFinishReasonHint(stream) +
          ` Provider: ${provider.name}, model: ${provider.modelName}`,
        {
          finishReason: stream.finishReason,
          rawFinishReason: stream.rawFinishReason,
        },
      );
    }

    if (callbacks?.onToolCall !== undefined) {
      for (const toolCall of message.toolCalls) {
        await throwIfAborted(options?.signal);
        await callbacks.onToolCall(toolCall);
      }
    }

    await throwIfAborted(options?.signal);
    stream.commitMessage?.(message);

    let result: GenerateResult = {
      id: stream.id,
      message,
      usage: stream.usage,
      finishReason: stream.finishReason,
      rawFinishReason: stream.rawFinishReason,
      completionAuthority: stream.completionAuthority,
    };
    if (stream.diagnostics !== undefined) result = { ...result, diagnostics: stream.diagnostics };
    if (stream.traceId !== undefined) {
      return { ...result, traceId: stream.traceId };
    }
    return result;
  } catch (error) {
    flushPending();
    if (stream.thinkingOnlyRecoveryBlocked === true) attachErrorDetails(error, { retry: false });
    if (typeof error === 'object' && error !== null && stream.usage !== null) generateFailureUsage.set(error, stream.usage);
    recordThinkingOnlyFacts(error, message, stream);
    if (!isAbortError(error) && readGenerateFailureFacts(error) === undefined &&
      (message.toolCalls.length > 0 || message.content.some(part => !isVacuousContentPart(part)))) {
      noteExecutedRequestDelivery(error);
    }
    throw attachStreamDiagnostics(error, stream.diagnostics, isAbortError(error));
  } finally {
    options?.signal?.removeEventListener('abort', onAbort);
    await cancellation;
  }
}

function recordThinkingOnlyFacts(
  error: unknown,
  message: Message,
  stream: StreamedMessage,
): void {
  if (typeof error !== 'object' || error === null) return;
  if (readProviderEventErrorCode(error) !== THINKING_ONLY_STOP_CODE || stream.thinkingOnlyRecoveryBlocked) return;
  if (stream.finishReason !== null && stream.finishReason !== 'completed') return;
  const hasThinking = message.content.some((part) =>
    part.type === 'think' && (part.think.trim().length > 0 || (part.encrypted?.length ?? 0) > 0 || (part.redacted?.length ?? 0) > 0));
  const hasOtherOutput = message.toolCalls.length > 0 ||
    message.content.some((part) => part.type !== 'think' && !isVacuousContentPart(part));
  if (!hasThinking || hasOtherOutput) return;
  generateFailureFacts.set(error, { message, usage: stream.usage });
}

async function cancelStream(stream: StreamedMessage): Promise<void> {
  await stream.cancel?.();
}

async function throwIfAborted(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw createAbortError();
}

function isPendingToolCallAtIndex(
  pending: StreamedMessagePart | null,
  index: number | string,
): pending is ToolCall {
  return pending !== null && isToolCall(pending) && pending._streamIndex === index;
}

function flushPart(
  message: Message,
  part: StreamedMessagePart,
  toolCallIndexMap: Map<number | string, number>,
): void {
  if (isContentPart(part)) {
    message.content.push(part);
    return;
  }
  if (isToolCall(part)) {
    const streamIndex = part._streamIndex;
    const stored: StoredToolCall = {
      type: 'function',
      id: part.id,
      name: part.name,
      arguments: part.arguments,
      extras: part.extras,
    };
    const ordinal = message.toolCalls.length;
    message.toolCalls.push(stored as ToolCall);
    if (streamIndex !== undefined) {
      toolCallIndexMap.set(streamIndex, ordinal);
    }
  }
}

function formatFinishReasonHint(stream: StreamedMessage): string {
  if (stream.finishReason === null && stream.rawFinishReason === null) return '';

  const raw =
    stream.rawFinishReason === null ? '' : `, rawFinishReason=${stream.rawFinishReason}`;
  const filteredHint =
    stream.finishReason === 'filtered'
      ? ' The provider filtered the response before visible output was emitted.'
      : '';

  return ` Provider stop details: finishReason=${stream.finishReason ?? 'unknown'}${raw}.${filteredHint}`;
}

function deepCopyPart(part: StreamedMessagePart): StreamedMessagePart {
  return structuredClone(part);
}
