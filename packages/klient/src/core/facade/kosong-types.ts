/**
 * Public input types for the merged `global.kosong` facade — the shapes
 * callers use to add providers and models. These are facade-level
 * abstractions; the implementation maps them to the underlying
 * `providerService`/`modelService` wire formats.
 */

import type { Message, StreamedMessagePart } from '@moonshot-ai/agent-core-v2/kosong/contract/message';
import type { Tool } from '@moonshot-ai/agent-core-v2/kosong/contract/tool';
import type { TokenUsage } from '@moonshot-ai/agent-core-v2/kosong/contract/usage';
import type { ResponseFormat } from '@moonshot-ai/agent-core-v2/kosong/contract/provider';

export type RequestAttribution = 'codex' | 'kimi' | 'kiki' | 'none';

export type RequestIdentityPolicy = {
  preset: 'codex_compatible' | 'grok_build_compatible' | 'kiki' | 'none';
  overrides?: {
    lineage?: {
      format?: 'codex' | 'grok_build' | 'kiki' | 'none';
      sessionScope?: 'shared_session' | 'agent_session' | 'none';
      threadIdentity?: 'agent' | 'none';
      parentThread?: 'immediate_agent' | 'none';
      subagentMarker?: 'enabled' | 'none';
      turnAncestry?: 'spawn_context' | 'none';
    };
    client?: {
      installationIdentity?: 'persistent_local' | 'none';
      originator?:
        | { mode: 'none' }
        | { mode: 'codex_default' }
        | { mode: 'custom'; value: string };
      userAgent?: 'codex' | 'grok_build' | 'host' | 'none';
    };
    request?: {
      logicalId?: 'turn' | 'none';
      turnIndex?: 'agent_session' | 'none';
    };
    cache?: {
      source?: 'session' | 'none';
      responses?: 'prompt_cache_key' | 'none';
      messages?: 'metadata_user_id' | 'none';
    };
    responsesMetadata?: 'codex' | 'none';
  };
};

// ---------------------------------------------------------------------------
// Provider auth
// ---------------------------------------------------------------------------

/** How the provider authenticates — API key or managed OAuth. */
export type ProviderAuth =
  | { method: 'api-key'; apiKey: string }
  | { method: 'oauth' };

// ---------------------------------------------------------------------------
// Provider / model inputs
// ---------------------------------------------------------------------------

/** Named provider configuration passed to `kosong.addProvider(id, config)`. */
export interface ProviderInput {
  type: string;
  baseUrl?: string;
  auth: ProviderAuth;
  defaultModel?: string;
  requestIdentity?: RequestIdentityPolicy;
  /** @deprecated Use requestIdentity. */
  requestAttribution?: RequestAttribution;
  /** @deprecated Use requestIdentity.overrides.client.originator. */
  requestOriginator?: string;
}

/**
 * Anonymous (single-model) provider input — all connectivity details inline.
 * Passed as a single object to `kosong.addProvider(config)`.
 */
export interface AnonymousProviderInput {
  /** Used as the model identifier in the model registry. */
  id: string;
  /** Wire model name sent to the provider. */
  model: string;
  /** Protocol identifier (`'openai'`, `'anthropic'`, …). */
  protocol: string;
  baseUrl: string;
  auth: ProviderAuth;
  displayName?: string;
  maxContextSize?: number;
  capabilities?: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// Generate (streaming)
// ---------------------------------------------------------------------------

export interface GenerateInput {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly Tool[];
  readonly responseFormat?: ResponseFormat;
}

export interface GenerateParams {
  readonly cacheKey?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly thinkingEffort?: string;
  readonly maxCompletionTokens?: number;
}

export type GenerateEvent =
  | { readonly type: 'part'; readonly part: StreamedMessagePart }
  | { readonly type: 'usage'; readonly usage: TokenUsage; readonly model?: string }
  | { readonly type: 'finish'; readonly message: Message; readonly finishReason?: string; readonly id?: string }
  | { readonly type: 'timing'; readonly firstTokenLatencyMs: number; readonly streamDurationMs: number; readonly [key: string]: unknown };
