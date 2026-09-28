/**
 * Shared shapes for account sign-in methods (OAuth). Kimi Code is one method
 * among several; the device-flow ports (`github-copilot.ts`,
 * `openai-codex.ts`) implement {@link OAuthDeviceMethod} and plug into
 * `OAuthManager` through its injectable request/poll/refresh hooks, so token
 * storage, locking and refresh coalescing stay the same for every method.
 */

import type { DevicePollResult } from './oauth';
import type { DeviceAuthorization, TokenInfo } from './types';

export type OAuthMethodId = 'kimi-code' | 'github-copilot' | 'openai-codex';

/** Wire protocol a provisioned provider (or one of its models) speaks. */
export type OAuthMethodProtocol = 'openai' | 'openai_responses' | 'anthropic';

/** One model a signed-in account can use. */
export interface OAuthMethodModel {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly contextLength: number;
  readonly capabilities: readonly string[];
  readonly supportEfforts?: readonly string[] | undefined;
  readonly defaultEffort?: string | undefined;
  /** Per-model wire protocol when it differs from the method's default. */
  readonly protocol?: OAuthMethodProtocol | undefined;
}

export interface OAuthMethodDescriptor {
  readonly id: OAuthMethodId;
  /** Product name shown on the sign-in control. */
  readonly label: string;
  /** Provider id the method provisions in config. */
  readonly providerName: string;
  /** Wire protocol written as the provisioned provider's `type`. */
  readonly protocol: OAuthMethodProtocol;
  readonly defaultBaseUrl: string;
  /** `oauth.key` written into the provider config (`oauth/<storage name>`). */
  readonly oauthKey: string;
  /** Prefix of the model aliases the method owns (`<prefix>/<model>`). */
  readonly aliasPrefix: string;
}

/**
 * The device-flow implementation behind a non-Kimi method. Every network call
 * goes through the injected `fetch`, so tests never touch the network.
 */
export interface OAuthDeviceMethod extends OAuthMethodDescriptor {
  requestDevice(): Promise<DeviceAuthorization>;
  /** Poll with the `deviceCode` the matching {@link requestDevice} returned. */
  pollDevice(deviceCode: string): Promise<DevicePollResult>;
  refresh(refreshToken: string): Promise<TokenInfo>;
  /** Base URL for inference, possibly derived from the access token. */
  baseUrlFor(accessToken: string): string;
  /** Per-request headers derived from the access token. */
  requestHeaders(accessToken: string): Record<string, string>;
  listModels(accessToken: string): Promise<readonly OAuthMethodModel[]>;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1] ?? '', 'base64url').toString('utf-8');
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Reject non-http(s) verification URIs before a host opens them. */
export function assertWebUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label} must be an http(s) URL`);
  }
  return parsed.href;
}
