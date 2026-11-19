import { createHash } from 'node:crypto';

import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';

export const MESSAGE_THREADS_BETA = 'message-threads-2026-08-12';

const DEFAULT_MAX_THREAD_ENTRIES = 10_000;
const DEFAULT_MAX_UNSUPPORTED_TARGETS = 256;
const DEFAULT_UNSUPPORTED_TTL_MS = 10 * 60 * 1000;

const REPLAY_THREAD_ERROR_CODES: ReadonlySet<string> = new Set([
  'thread_not_found',
  'thread_already_continued',
  'thread_continue_in_flight',
  'thread_fingerprint_mismatch',
]);

const UNFINISHED_STOP_REASONS: ReadonlySet<string> = new Set(['pause_turn', 'compaction']);

const CACHE_CONTROL_NESTED_KEYS = [
  'content',
  'source',
  'tool',
  'definition',
  'tool_references',
] as const;

export type AnthropicThreadParam =
  | { readonly type: 'create' }
  | { readonly type: 'continue'; readonly previous_message_id: string };

export interface AnthropicThreadEntry {
  readonly responseId: string;
  readonly prefixCount: number;
  readonly prefixHash: string;
  readonly fixedHash: string;
  readonly createBetas: readonly string[];
  readonly replacesLostThread: boolean;
  readonly unfinishedTurn: boolean;
}

export interface PrepareAnthropicThreadInput {
  readonly scopeKey: string;
  readonly baseBody: Readonly<Record<string, unknown>>;
  readonly messages: readonly MessageParam[];
  readonly baseBetas: readonly string[];
  readonly fixedHash: string;
}

export interface PreparedAnthropicThreadRequest {
  readonly kind: 'create' | 'continue';
  readonly scopeKey: string;
  readonly body: Record<string, unknown>;
  readonly betas: readonly string[];
  readonly replacesLostThread: boolean;
  readonly fixedHash: string;
  readonly fullMessages: readonly MessageParam[];
}

export interface PreparedUnthreadedAnthropicRequest {
  readonly kind: 'unthreaded';
  readonly body: Record<string, unknown>;
  readonly betas: readonly string[];
}

export interface AnthropicThreadErrorClassification {
  readonly kind: 'replay' | 'unsupported' | 'passthrough';
  readonly errorCode?: string;
}

export interface AnthropicThreadTrackerOptions {
  readonly maxEntries?: number;
  readonly maxUnsupportedTargets?: number;
  readonly unsupportedTtlMs?: number;
  readonly now?: () => number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a shallow-cloned copy of a message or content block with `cache_control` removed
 * from nested block structures without mutating inputs or altering `tool_use.input` payloads.
 */
export function withoutCacheControl<T>(value: T): T {
  if (!isPlainRecord(value)) return value;
  const copy: Record<string, unknown> = { ...value };
  delete copy['cache_control'];
  for (const key of CACHE_CONTROL_NESTED_KEYS) {
    const nested = copy[key];
    if (Array.isArray(nested)) {
      copy[key] = nested.map((item) => withoutCacheControl(item));
    } else if (isPlainRecord(nested)) {
      copy[key] = withoutCacheControl(nested);
    }
  }
  return copy as T;
}

/**
 * Strips stale `cache_control` markers from earlier prefix messages on a `create` or replay
 * request while keeping the newest message's cache marker intact.
 */
export function sanitizeCreateMessagesCacheControl(
  messages: readonly MessageParam[],
): MessageParam[] {
  if (messages.length <= 1) return [...messages];
  const lastIndex = messages.length - 1;
  return messages.map((message, index) =>
    index < lastIndex ? withoutCacheControl(message) : message,
  );
}

/**
 * Computes a stable SHA-256 fingerprint over message prefixes, ignoring transient
 * `cache_control` markers and normalizing string user content to single text blocks.
 */
export function hashThreadMessages(messages: readonly unknown[]): string {
  const normalized = JSON.stringify(messages, (key, value: unknown) => {
    if (key === 'cache_control') return undefined;
    if (key === 'content' && typeof value === 'string') {
      return [{ type: 'text', text: value }];
    }
    return value;
  });
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Computes a stable SHA-256 fingerprint over fixed Anthropic thread settings whose
 * mutation requires starting a fresh thread.
 */
export function hashThreadFixedFields(input: {
  readonly endpoint: string;
  readonly model: string;
  readonly system: unknown;
  readonly tools: unknown;
  readonly toolChoice: unknown;
  readonly thinking: unknown;
  readonly outputConfig: unknown;
  readonly contextManagement: unknown;
  readonly cacheControl: unknown;
  readonly fallbacks: unknown;
  readonly betas: readonly string[];
}): string {
  const sortedBetas = [...new Set(input.betas)].sort();
  const payload = JSON.stringify([
    input.endpoint,
    input.model,
    input.system,
    input.tools,
    input.toolChoice,
    input.thinking,
    input.outputConfig,
    input.contextManagement,
    input.cacheControl,
    input.fallbacks,
    sortedBetas,
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

export function isUnfinishedAnthropicStopReason(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && UNFINISHED_STOP_REASONS.has(raw);
}

export function extractHeaderBetaTokens(
  headers: Readonly<Record<string, string | null | undefined>> | undefined,
): string[] {
  if (headers === undefined) return [];
  const tokens: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'anthropic-beta' || typeof value !== 'string') continue;
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (trimmed.length > 0) tokens.push(trimmed);
    }
  }
  return tokens;
}

export function mergeBetaTokens(...groups: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const token of group) {
      const trimmed = token.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }
  return merged;
}

export function stripBetaToken(betas: readonly string[], token: string): string[] {
  return betas.filter((entry) => entry !== token);
}

export function stripAnthropicBetaHeader(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  let removed = false;
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'anthropic-beta') {
      removed = true;
      continue;
    }
    next[key] = value;
  }
  if (!removed) return { ...headers };
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Extracts Anthropic's structured thread error code (`error.details.error_code` or `error.code`).
 */
export function getAnthropicThreadErrorCode(error: unknown): string | undefined {
  if (!(error instanceof AnthropicAPIError)) return undefined;
  const body = error.error as
    | { error?: { details?: { error_code?: unknown }; code?: unknown } }
    | undefined;
  const detailCode = body?.error?.details?.error_code;
  if (typeof detailCode === 'string' && detailCode.length > 0) return detailCode;
  const flatCode = body?.error?.code;
  if (typeof flatCode === 'string' && flatCode.length > 0) return flatCode;
  return undefined;
}

/**
 * Classifies an Anthropic API rejection on a threaded request as replayable under a new thread,
 * permanently unsupported by the endpoint/request, or a normal error to surface to callers.
 */
export function classifyAnthropicThreadError(error: unknown): AnthropicThreadErrorClassification {
  if (!(error instanceof AnthropicAPIError) || typeof error.status !== 'number') {
    return { kind: 'passthrough' };
  }
  const errorCode = getAnthropicThreadErrorCode(error);
  if (errorCode !== undefined && REPLAY_THREAD_ERROR_CODES.has(errorCode)) {
    return { kind: 'replay', errorCode };
  }
  if (errorCode === 'thread_unsupported_request') {
    return { kind: 'unsupported', errorCode };
  }
  if (errorCode === undefined && (error.status === 400 || error.status === 422)) {
    const body = error.error as { error?: { message?: unknown } } | undefined;
    const nestedMessage = typeof body?.error?.message === 'string' ? body.error.message : '';
    const combined = `${error.message} ${nestedMessage}`;
    if (
      /\bthread\b/iu.test(combined) ||
      /message-threads-2026-08-12/iu.test(combined) ||
      (/anthropic-beta/iu.test(combined) &&
        /invalid|unsupported|unexpected|unknown|unrecognized/iu.test(combined))
    ) {
      return { kind: 'unsupported' };
    }
  }
  return { kind: 'passthrough', errorCode };
}

/**
 * Bounded per-conversation LRU tracker and per-target unsupported TTL cache for
 * Anthropic Message Threads (`message-threads-2026-08-12`).
 */
export class AnthropicThreadTracker {
  private readonly entries = new Map<string, AnthropicThreadEntry>();
  private readonly unsupportedTargets = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly maxUnsupportedTargets: number;
  private readonly unsupportedTtlMs: number;
  private readonly now: () => number;

  constructor(options: AnthropicThreadTrackerOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_THREAD_ENTRIES;
    this.maxUnsupportedTargets = options.maxUnsupportedTargets ?? DEFAULT_MAX_UNSUPPORTED_TARGETS;
    this.unsupportedTtlMs = options.unsupportedTtlMs ?? DEFAULT_UNSUPPORTED_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get(scopeKey: string): AnthropicThreadEntry | undefined {
    return this.entries.get(scopeKey);
  }

  commit(scopeKey: string, entry: AnthropicThreadEntry): void {
    this.entries.delete(scopeKey);
    this.entries.set(scopeKey, entry);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  delete(scopeKey: string): void {
    this.entries.delete(scopeKey);
  }

  isTargetUnsupported(targetKey: string): boolean {
    const expiresAt = this.unsupportedTargets.get(targetKey);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.unsupportedTargets.delete(targetKey);
      return false;
    }
    return true;
  }

  markTargetUnsupported(targetKey: string): void {
    this.unsupportedTargets.delete(targetKey);
    this.unsupportedTargets.set(targetKey, this.now() + this.unsupportedTtlMs);
    if (this.unsupportedTargets.size > this.maxUnsupportedTargets) {
      const oldest = this.unsupportedTargets.keys().next().value;
      if (oldest !== undefined) this.unsupportedTargets.delete(oldest);
    }
  }

  prepare(input: PrepareAnthropicThreadInput): PreparedAnthropicThreadRequest {
    const state = this.entries.get(input.scopeKey);
    if (state !== undefined && state.fixedHash === input.fixedHash) {
      const hasDelta = input.messages.length > state.prefixCount;
      const resumesUnfinished =
        state.unfinishedTurn && input.messages.length === state.prefixCount;
      if (
        (hasDelta || resumesUnfinished) &&
        hashThreadMessages(input.messages.slice(0, state.prefixCount)) === state.prefixHash
      ) {
        this.entries.delete(input.scopeKey);
        const { system: _system, tools: _tools, ...rest } = input.baseBody;
        return {
          kind: 'continue',
          scopeKey: input.scopeKey,
          body: {
            ...rest,
            messages: input.messages.slice(state.prefixCount),
            thread: { type: 'continue', previous_message_id: state.responseId },
          },
          betas: [...state.createBetas],
          replacesLostThread: state.replacesLostThread,
          fixedHash: input.fixedHash,
          fullMessages: input.messages,
        };
      }
    }
    return this.buildCreate(input, false);
  }

  buildCreate(
    input: PrepareAnthropicThreadInput,
    replacesLostThread: boolean,
  ): PreparedAnthropicThreadRequest {
    const betas = mergeBetaTokens(input.baseBetas, [MESSAGE_THREADS_BETA]);
    const messages = sanitizeCreateMessagesCacheControl(input.messages);
    return {
      kind: 'create',
      scopeKey: input.scopeKey,
      body: {
        ...input.baseBody,
        messages,
        thread: { type: 'create' },
      },
      betas,
      replacesLostThread,
      fixedHash: input.fixedHash,
      fullMessages: input.messages,
    };
  }

  buildUnthreaded(
    input: Pick<PrepareAnthropicThreadInput, 'baseBody' | 'messages' | 'baseBetas'>,
  ): PreparedUnthreadedAnthropicRequest {
    const { thread: _thread, ...rest } = input.baseBody;
    return {
      kind: 'unthreaded',
      body: {
        ...rest,
        messages: sanitizeCreateMessagesCacheControl(input.messages),
      },
      betas: stripBetaToken(input.baseBetas, MESSAGE_THREADS_BETA),
    };
  }
}
