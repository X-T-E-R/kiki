import type {
  PluginLlmStreamEvent,
  PluginLlmStreamRequest,
  PluginWireContentPart,
  PluginWireFailure,
  PluginWireGenerationOptions,
  PluginWireMessage,
  PluginWireStreamPart,
  PluginWireTool,
  PluginWireToolCall,
  PluginWireUsage,
} from '@kiki/protocol';
import { abortError } from '#/_base/utils/abort';
import {
  ambiguousRequestDelivery,
  APIConnectionError,
  APIContextOverflowError,
  APIProviderOverloadedError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIRequestTooLargeError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  noteExecutedRequestDelivery,
  noteExplicitUpstreamRetryDenial,
  PROVIDER_FILTERED_ERROR_CODE,
} from '#/kosong/contract/errors';
import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '#/kosong/contract/message';
import type { ChatProvider, FinishReason, GenerateOptions, StreamedMessage } from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';

export interface PluginLlmStreamExecutor {
  stream(request: PluginLlmStreamRequest, signal?: AbortSignal): AsyncIterable<PluginLlmStreamEvent>;
}

function toWireTool(tool: Tool): PluginWireTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.deferred === true ? { defer_loading: true } : {}),
  };
}

function toWireContentPart(part: ContentPart): PluginWireContentPart {
  switch (part.type) {
    case 'text':
      return {
        type: 'text',
        text: part.text,
        ...(part.presentation !== undefined ? { presentation: part.presentation } : {}),
        ...(part.attachment !== undefined ? { attachment: part.attachment } : {}),
        ...(part.resourceLink !== undefined ? { resourceLink: part.resourceLink } : {}),
      };
    case 'think':
      return {
        type: 'think',
        think: part.think,
        ...(part.encrypted !== undefined ? { encrypted: part.encrypted } : {}),
        ...(part.redacted !== undefined ? { redacted: part.redacted } : {}),
        ...(part.reasoningKey !== undefined ? { reasoningKey: part.reasoningKey } : {}),
        ...(part.reasoningDetails !== undefined ? { reasoningDetails: [...part.reasoningDetails] } : {}),
        ...(part.hidden !== undefined ? { hidden: part.hidden } : {}),
        ...(part.reasoningOrigin !== undefined ? { reasoningOrigin: part.reasoningOrigin } : {}),
      };
    case 'image_url':
      return {
        type: 'image_url',
        imageUrl: {
          url: part.imageUrl.url,
          ...(part.imageUrl.id !== undefined ? { id: part.imageUrl.id } : {}),
          ...(part.imageUrl.name !== undefined ? { name: part.imageUrl.name } : {}),
          ...(part.imageUrl.mimeType !== undefined ? { mimeType: part.imageUrl.mimeType } : {}),
          ...(part.imageUrl.size !== undefined ? { size: part.imageUrl.size } : {}),
        },
      };
    case 'audio_url':
      return {
        type: 'audio_url',
        audioUrl: {
          url: part.audioUrl.url,
          ...(part.audioUrl.id !== undefined ? { id: part.audioUrl.id } : {}),
          ...(part.audioUrl.name !== undefined ? { name: part.audioUrl.name } : {}),
          ...(part.audioUrl.mimeType !== undefined ? { mimeType: part.audioUrl.mimeType } : {}),
          ...(part.audioUrl.size !== undefined ? { size: part.audioUrl.size } : {}),
        },
      };
    case 'video_url':
      return {
        type: 'video_url',
        videoUrl: {
          url: part.videoUrl.url,
          ...(part.videoUrl.id !== undefined ? { id: part.videoUrl.id } : {}),
          ...(part.videoUrl.name !== undefined ? { name: part.videoUrl.name } : {}),
          ...(part.videoUrl.mimeType !== undefined ? { mimeType: part.videoUrl.mimeType } : {}),
          ...(part.videoUrl.size !== undefined ? { size: part.videoUrl.size } : {}),
        },
      };
  }
}

function toWireToolCall(call: ToolCall): PluginWireToolCall {
  return {
    type: 'function',
    id: call.id,
    name: call.name,
    arguments: call.arguments,
    ...(call.extras !== undefined ? { extras: { ...call.extras } } : {}),
    ...(call._streamIndex !== undefined ? { _streamIndex: call._streamIndex } : {}),
  };
}

function toWireMessage(message: Message): PluginWireMessage {
  const rawContent: unknown = message.content;
  const content = typeof rawContent === 'string'
    ? (rawContent.length > 0 ? [{ type: 'text' as const, text: rawContent }] : [])
    : Array.isArray(rawContent)
      ? rawContent.map(toWireContentPart)
      : [];
  const rawToolCalls = message.toolCalls ?? [];
  return {
    role: message.role,
    ...(message.name !== undefined ? { name: message.name } : {}),
    content,
    toolCalls: rawToolCalls.map(toWireToolCall),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.partial !== undefined ? { partial: message.partial } : {}),
    ...(message.tools !== undefined ? { tools: message.tools.map(toWireTool) } : {}),
  };
}

function toWireGenerationOptions(options: GenerateOptions | undefined): PluginWireGenerationOptions {
  if (options === undefined) return {};
  return {
    ...(options.sampling?.temperature !== undefined ? { temperature: options.sampling.temperature } : {}),
    ...(options.sampling?.topP !== undefined ? { topP: options.sampling.topP } : {}),
    ...(options.maxCompletionTokens !== undefined ? { maxCompletionTokens: options.maxCompletionTokens } : {}),
    ...(options.maxContextTokens !== undefined ? { maxContextSize: options.maxContextTokens } : {}),
    ...(options.thinking !== undefined ? { thinking: { effort: options.thinking.effort, ...(options.thinking.keep !== undefined ? { keep: options.thinking.keep } : {}) } } : {}),
    ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
    ...(options.responseFormat !== undefined ? { responseFormat: options.responseFormat } : {}),
    ...(options.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
    ...(options.requestParams !== undefined && Object.keys(options.requestParams).length > 0 ? { requestParams: { ...options.requestParams } } : {}),
    ...(options.threadScopeKey !== undefined ? { threadScopeKey: options.threadScopeKey } : {}),
    ...(options.cacheKey !== undefined ? { promptCacheKey: options.cacheKey } : {}),
  };
}

function fromWirePart(part: PluginWireStreamPart): StreamedMessagePart {
  switch (part.type) {
    case 'text':
      return {
        type: 'text',
        text: part.text,
        ...(part.presentation !== undefined ? { presentation: part.presentation } : {}),
        ...(part.attachment !== undefined ? { attachment: part.attachment } : {}),
        ...(part.resourceLink !== undefined ? { resourceLink: part.resourceLink } : {}),
      };
    case 'think':
      return {
        type: 'think',
        think: part.think,
        ...(part.encrypted !== undefined ? { encrypted: part.encrypted } : {}),
        ...(part.redacted !== undefined ? { redacted: part.redacted } : {}),
        ...(part.reasoningKey !== undefined ? { reasoningKey: part.reasoningKey } : {}),
        ...(part.reasoningDetails !== undefined ? { reasoningDetails: [...part.reasoningDetails] } : {}),
        ...(part.hidden !== undefined ? { hidden: part.hidden } : {}),
        ...(part.reasoningOrigin !== undefined ? { reasoningOrigin: part.reasoningOrigin } : {}),
      };
    case 'image_url':
      return { type: 'image_url', imageUrl: { ...part.imageUrl } };
    case 'audio_url':
      return { type: 'audio_url', audioUrl: { ...part.audioUrl } };
    case 'video_url':
      return { type: 'video_url', videoUrl: { ...part.videoUrl } };
    case 'function':
      return {
        type: 'function',
        id: part.id,
        name: part.name,
        arguments: part.arguments,
        ...(part.extras !== undefined ? { extras: { ...part.extras } } : {}),
        ...(part._streamIndex !== undefined ? { _streamIndex: part._streamIndex } : {}),
      };
    case 'tool_call_part':
      return {
        type: 'tool_call_part',
        argumentsPart: part.argumentsPart,
        ...(part.index !== undefined ? { index: part.index } : {}),
      };
  }
}

function fromWireUsage(usage: PluginWireUsage | null | undefined): TokenUsage | null {
  if (usage === null || usage === undefined) return null;
  return {
    inputOther: usage.inputOther,
    output: usage.output,
    inputCacheRead: usage.inputCacheRead ?? 0,
    inputCacheCreation: usage.inputCacheCreation ?? 0,
  };
}

/** Reconstructs a canonical Kosong error instance from a validated plugin wire failure. */
export function reconstructPluginWireFailure(
  failure: PluginWireFailure,
  observedOutput: boolean,
): Error {
  let error: Error;
  switch (failure.kind) {
    case 'cancelled':
      return abortError(failure.message || 'Plugin LLM request cancelled');
    case 'connection':
      error = new APIConnectionError(failure.message);
      break;
    case 'timeout':
      error = new APITimeoutError(failure.message);
      break;
    case 'auth':
      error = new APIStatusError(
        failure.status ?? 401,
        failure.message,
        failure.requestId ?? null,
        failure.retryAfterMs ?? null,
        failure.traceId ?? null,
      );
      break;
    case 'rate_limit':
      error = new APIProviderRateLimitError(
        failure.message,
        failure.requestId ?? null,
        failure.retryAfterMs ?? null,
        failure.traceId ?? null,
      );
      break;
    case 'quota_exhausted':
      error = new APIProviderQuotaExhaustedError(
        failure.message,
        failure.requestId ?? null,
        failure.retryAfterMs ?? null,
        failure.traceId ?? null,
      );
      break;
    case 'overloaded':
      error = new APIProviderOverloadedError(
        failure.status ?? 529,
        failure.message,
        failure.requestId ?? null,
        failure.retryAfterMs ?? null,
        failure.traceId ?? null,
      );
      break;
    case 'context_overflow':
      error = new APIContextOverflowError(
        failure.status ?? 400,
        failure.message,
        failure.requestId ?? null,
        failure.retryAfterMs ?? null,
        failure.traceId ?? null,
      );
      break;
    case 'request_too_large':
      error = new APIRequestTooLargeError(
        failure.status ?? 413,
        failure.message,
        failure.requestId ?? null,
        failure.retryAfterMs ?? null,
        failure.traceId ?? null,
      );
      break;
    case 'http':
      error = new APIStatusError(
        failure.status ?? 500,
        failure.message,
        failure.requestId ?? null,
        failure.retryAfterMs ?? null,
        failure.traceId ?? null,
      );
      break;
    case 'filtered':
      error = new ChatProviderError(failure.message, PROVIDER_FILTERED_ERROR_CODE, {
        details: {
          statusCode: failure.status,
          requestId: failure.requestId ?? null,
          traceId: failure.traceId ?? null,
        },
      });
      break;
    case 'invalid_stream':
      error = new ChatProviderError(failure.message);
      break;
  }
  if (failure.retryable === false) {
    noteExplicitUpstreamRetryDenial(error, { retryable: false });
  }
  if (observedOutput) {
    noteExecutedRequestDelivery(error);
  } else if (
    failure.requestDispatched === true &&
    (failure.kind === 'connection' || failure.kind === 'timeout' || failure.kind === 'invalid_stream')
  ) {
    error = ambiguousRequestDelivery(error);
  }
  return error;
}

/** Creates a Kosong ChatProvider backed by a pinned plugin LLM stream executor. */
export function createPluginLlmChatProvider(args: {
  readonly providerId: string;
  readonly modelId: string;
  readonly wireModel: string;
  readonly executor: PluginLlmStreamExecutor;
}): ChatProvider {
  return {
    name: args.providerId,
    modelName: args.wireModel,
    thinkingEffort: null,
    async generate(
      systemPrompt: string,
      tools: Tool[],
      history: Message[],
      options?: GenerateOptions,
    ): Promise<StreamedMessage> {
      const request: PluginLlmStreamRequest = {
        providerId: args.providerId,
        modelId: args.modelId,
        wireModel: args.wireModel,
        systemPrompt,
        tools: tools.map(toWireTool),
        history: history.map(toWireMessage),
        options: toWireGenerationOptions(options),
      };
      const controller = new AbortController();
      const combinedSignal = options?.signal === undefined
        ? controller.signal
        : AbortSignal.any([options.signal, controller.signal]);
      let id: string | null = null;
      let usage: TokenUsage | null = null;
      let finishReason: FinishReason | null = null;
      let rawFinishReason: string | null = null;
      let traceId: string | null | undefined;
      let thinkingOnlyRecoveryBlocked: boolean | undefined;
      let observedOutput = false;
      let seenToolCall = false;
      const seenToolIndexes = new Set<number | string>();
      const source = args.executor.stream(request, combinedSignal);
      const stream: StreamedMessage = {
        get id() { return id; },
        get usage() { return usage; },
        get finishReason() { return finishReason; },
        get rawFinishReason() { return rawFinishReason; },
        get traceId() { return traceId; },
        get thinkingOnlyRecoveryBlocked() { return thinkingOnlyRecoveryBlocked; },
        cancel() {
          controller.abort(abortError('Plugin LLM stream cancelled'));
        },
        async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
          let terminalReceived = false;
          try {
            for await (const event of source) {
              if (event.type === 'sent') {
                options?.onRequestSent?.();
                continue;
              }
              if (event.type === 'part') {
                const part = fromWirePart(event.part);
                if (part.type === 'function') {
                  seenToolCall = true;
                  if (part._streamIndex !== undefined) seenToolIndexes.add(part._streamIndex);
                } else if (part.type === 'tool_call_part') {
                  if (part.index !== undefined ? !seenToolIndexes.has(part.index) : !seenToolCall) {
                    throw reconstructPluginWireFailure(
                      { kind: 'invalid_stream', message: 'Plugin emitted tool_call_part without an associated tool call', retryable: false },
                      observedOutput,
                    );
                  }
                }
                observedOutput = true;
                yield part;
                continue;
              }
              if (event.type === 'finish') {
                terminalReceived = true;
                id = event.result.id;
                usage = fromWireUsage(event.result.usage);
                finishReason = event.result.finishReason;
                rawFinishReason = event.result.rawFinishReason;
                traceId = event.result.traceId;
                thinkingOnlyRecoveryBlocked = event.result.thinkingOnlyRecoveryBlocked;
                if (traceId !== undefined) options?.onTraceId?.(traceId);
                return;
              }
              if (event.type === 'error') {
                terminalReceived = true;
                if (event.usage !== undefined) usage = fromWireUsage(event.usage);
                if (event.failure.traceId !== undefined) {
                  traceId = event.failure.traceId;
                  options?.onTraceId?.(traceId);
                }
                throw reconstructPluginWireFailure(event.failure, observedOutput);
              }
            }
            if (!terminalReceived) {
              throw reconstructPluginWireFailure(
                { kind: 'invalid_stream', message: 'Plugin LLM stream ended without a terminal event', requestDispatched: true, retryable: false },
                observedOutput,
              );
            }
          } catch (error) {
            if (combinedSignal.aborted) {
              throw combinedSignal.reason instanceof Error ? combinedSignal.reason : abortError('Plugin LLM stream cancelled');
            }
            throw error;
          } finally {
            controller.abort();
          }
        },
      };
      return stream;
    },
  };
}
