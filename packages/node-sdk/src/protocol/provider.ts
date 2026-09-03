import type { ModelCapability, ProviderRequestAuth } from '@moonshot-ai/agent-core-v2';

import type { ModelAlias, ProviderType } from '#/config';
import type { Logger } from '#/logging';

export interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean }): Promise<string>;
}

export interface RuntimeProviderConfig {
  readonly type: ProviderType;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly stream?: boolean;
  readonly defaultHeaders?: Record<string, string>;
  readonly generationKwargs?: Record<string, unknown>;
}

export interface ResolvedRuntimeProvider {
  readonly providerName: string;
  readonly provider: RuntimeProviderConfig;
  readonly modelCapabilities: ModelCapability;
  /** Declared 'always_thinking' capability — the model cannot disable thinking. */
  readonly alwaysThinking?: boolean;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly maxOutputSize?: number;
  /** Configured provider wire type (`provider.type`), before any model-level protocol override. */
  readonly type: ProviderType;
  /** Model-level protocol override (`alias.protocol`); when set, takes precedence over `type` for transport selection. */
  readonly protocol: ModelAlias['protocol'];
}

type AuthorizedRequest = <T>(request: (auth: ProviderRequestAuth) => Promise<T>) => Promise<T>;

/**
 * A model provider a host can hand the SDK: it resolves a model name to the
 * transport config plus, optionally, the authorization wrapper each request
 * runs inside.
 */
export interface ModelProvider {
  readonly defaultModel?: string;
  resolveProviderConfig(model: string): ResolvedRuntimeProvider;
  resolveAuth?(model: string, options?: { readonly log?: Logger }): AuthorizedRequest | undefined;
}
