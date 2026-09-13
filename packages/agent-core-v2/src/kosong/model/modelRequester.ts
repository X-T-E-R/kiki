/**
 * `kosong/model` domain — the `ModelRequester` contract: per-turn input,
 * streamed events, and the per-turn intent carrier `ModelRequestParams`.
 *
 * `ModelRequestParams` is how every per-turn intent reaches the wire: prompt-cache
 * key, service tier, transport headers, additional request params, sampling
 * overrides, thinking effort/keep, and the completion-token budget (with its
 * window-clamp companions).
 * It is deliberately dialect-free — each wire dialect encodes (or silently drops)
 * an intent in its own hooks. The requester maps the params onto `GenerateOptions`,
 * with the configured model service tier supplying a fallback for the request tier.
 * Typed fields are resolved before `requestParams`, whose entries only fill
 * keys the dialect has not already produced.
 */

import type { Message, StreamedMessagePart, VideoURLPart } from '#/kosong/contract/message';
import type {
  FinishReason,
  ResponseFormat,
  RequestParams,
  SamplingOptions,
  ServiceTier,
  ThinkingEffort,
  RequestIdentityWireOptions,
  VideoUploadInput,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';

import type { Model } from './catalog';

export interface ModelRequestInput {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly responseFormat?: ResponseFormat;
}

export interface ModelRequestTiming {
  readonly firstTokenLatencyMs: number;
  readonly streamDurationMs: number;
  readonly requestBuildMs?: number;
  readonly serverFirstTokenMs?: number;
  readonly serverDecodeMs?: number;
  readonly clientConsumeMs?: number;
}

export type ModelRequestEvent =
  | { readonly type: 'part'; readonly part: StreamedMessagePart }
  | { readonly type: 'usage'; readonly usage: TokenUsage; readonly model?: string }
  | {
      readonly type: 'finish';
      readonly message: Message;
      readonly providerFinishReason?: FinishReason;
      readonly rawFinishReason?: string;
      readonly id?: string;
      readonly traceId?: string;
    }
  | ({ readonly type: 'timing' } & ModelRequestTiming);

export interface ModelRequestParams {
  readonly cacheKey?: string;
  readonly serviceTier?: ServiceTier;
  readonly headers?: Readonly<Record<string, string>>;
  readonly requestParams?: RequestParams;
  readonly sampling?: SamplingOptions;
  readonly thinkingEffort?: ThinkingEffort;
  readonly thinkingKeep?: string;
  readonly maxCompletionTokens?: number;
  readonly usedContextTokens?: number;
  readonly maxContextTokens?: number;
  readonly onTraceId?: (traceId: string | null) => void;
  readonly requestIdentity?: RequestIdentityWireOptions;
}

export interface ModelRequester {
  readonly model: Model;

  request(
    input: ModelRequestInput,
    signal?: AbortSignal,
    params?: ModelRequestParams,
  ): AsyncIterable<ModelRequestEvent>;

  uploadVideo?(
    input: string | VideoUploadInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<VideoURLPart>;
}

export function effectiveMaxCompletionTokens(params?: ModelRequestParams): number | undefined {
  return params?.maxCompletionTokens;
}

export function stripKikiReservedRequestParams(
  params: RequestParams | undefined,
): RequestParams | undefined {
  if (params === undefined) return undefined;
  const entries = Object.entries(params).filter(([key]) => !key.toLowerCase().startsWith('x-kiki-'));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
