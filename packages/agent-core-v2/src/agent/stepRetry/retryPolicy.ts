import { MAX_RETRY_AFTER_MS, readRetryAfterMs, retryBackoffDelay } from '#/_base/utils/retry';
import { APIStatusError, isRetryableGenerateError, requestDeliveryProvenance } from '#/kosong/contract/errors';
import { attachErrorDetails, unwrapErrorCause } from '#/errors';

import type { RetryConfig, RetryPolicy } from './configSection';

export interface RetryErrorIdentity {
  readonly name: string;
  readonly code?: string;
}

export interface RetryBindingIdentity {
  readonly model?: string;
  readonly provider?: string;
}

export interface RetryAfterExceeded {
  readonly retryAfterMs: number;
  readonly maxRetryAfterMs: number;
}

export interface RetryPolicyDecision {
  readonly retry: boolean;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
  readonly retryAfterExceeded?: RetryAfterExceeded;
}

type RetryBindingSource = RetryBindingIdentity | (() => RetryBindingIdentity | undefined) | undefined;

export function isValidRetryPattern(pattern: string): boolean {
  return compileRetryPattern(pattern) !== undefined;
}

export function retryErrorIdentity(error: unknown): RetryErrorIdentity {
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: retryErrorCode(error),
  };
}

export function findRetryPolicy(
  policies: readonly RetryPolicy[] | undefined,
  error: unknown,
  binding: RetryBindingSource = {},
): RetryPolicy | undefined {
  if (policies === undefined || policies.length === 0) return undefined;
  const identity = retryErrorIdentity(error);
  for (const policy of policies) {
    const pattern = compileRetryPattern(policy.match);
    if (pattern === undefined) continue;
    if (
      !pattern.test(identity.name) &&
      (identity.code === undefined || !pattern.test(identity.code))
    ) continue;
    if (policy.models !== undefined || policy.providers !== undefined) {
      if (typeof binding === 'function') binding = binding();
      if (!matchesSelector(policy.models, binding?.model)) continue;
      if (!matchesSelector(policy.providers, binding?.provider)) continue;
    }
    return policy;
  }
  return undefined;
}

export function check429RetryAfterExceeded(
  error: unknown,
  config?: RetryConfig,
  policy?: RetryPolicy,
): RetryAfterExceeded | undefined {
  const raw = unwrapErrorCause(error);
  if (!is429StatusError(raw)) return undefined;
  const retryAfterMs = readRetryAfterMs(raw);
  if (retryAfterMs === null) return undefined;
  const maxRetryAfterMs = policy?.maxRetryAfterMs ?? config?.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;
  if (retryAfterMs > maxRetryAfterMs) {
    return { retryAfterMs, maxRetryAfterMs };
  }
  return undefined;
}

export function noteRetryAfterExceeded(error: unknown, exceeded: RetryAfterExceeded): void {
  const details = {
    retry_after_exceeded: true,
    retry_after_ms: exceeded.retryAfterMs,
    max_retry_after_ms: exceeded.maxRetryAfterMs,
  };
  attachErrorDetails(error, details);
  const raw = unwrapErrorCause(error);
  if (raw !== error) attachErrorDetails(raw, details);
}

export function resolveRetryPolicy(
  config: RetryConfig | undefined,
  error: unknown,
  binding: RetryBindingSource = {},
): RetryPolicyDecision {
  if (!isRetryableGenerateError(error)) return { retry: false };
  const raw = unwrapErrorCause(error);
  const policy = findRetryPolicy(config?.policies, raw, binding);
  if (policy?.retry === false) return { retry: false };
  const retryAfterExceeded = check429RetryAfterExceeded(raw, config, policy);
  if (retryAfterExceeded !== undefined) {
    return { retry: false, retryAfterExceeded };
  }
  return {
    retry: true,
    maxAttempts: policy?.maxAttempts,
    backoffMs: policy?.backoff,
  };
}

export function resolveRetryDelay(
  error: unknown,
  attemptIndex: number,
  backoffMs?: number,
  baseDelayMs = 2_000,
): number {
  const raw = unwrapErrorCause(error);
  const retryAfterMs = readRetryAfterMs(raw);
  if (backoffMs !== undefined) return retryAfterMs ?? backoffMs;
  const gatewayUnavailable = raw instanceof APIStatusError &&
    (raw.statusCode === 502 || raw.statusCode === 503 || raw.statusCode === 504) &&
    requestDeliveryProvenance(error) !== 'executed';
  const exponentialDelayMs = retryBackoffDelay(attemptIndex, gatewayUnavailable ? Math.max(baseDelayMs, 2_000) : baseDelayMs);
  return gatewayUnavailable ? Math.max(retryAfterMs ?? 0, exponentialDelayMs) : retryAfterMs ?? exponentialDelayMs;
}

function retryErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function matchesSelector(selector: readonly string[] | undefined, value: string | undefined): boolean {
  return selector === undefined || (value !== undefined && selector.includes(value));
}

function is429StatusError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { statusCode?: unknown }).statusCode === 429) return true;
  const details = (error as { details?: unknown }).details;
  if (details !== null && typeof details === 'object') {
    const record = details as Record<string, unknown>;
    if (record['statusCode'] === 429 || record['upstreamStatus'] === 429) return true;
  }
  return false;
}

function compileRetryPattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}
