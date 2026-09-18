import { isRetryableGenerateError } from '#/kosong/contract/errors';

import type { RetryConfig, RetryPolicy } from './configSection';

export interface RetryErrorIdentity {
  readonly name: string;
  readonly code?: string;
}

export interface RetryPolicyDecision {
  readonly retry: boolean;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
}

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
): RetryPolicy | undefined {
  if (policies === undefined || policies.length === 0) return undefined;
  const identity = retryErrorIdentity(error);
  for (const policy of policies) {
    const pattern = compileRetryPattern(policy.match);
    if (pattern === undefined) continue;
    if (pattern.test(identity.name)) return policy;
    if (identity.code !== undefined && pattern.test(identity.code)) return policy;
  }
  return undefined;
}

export function resolveRetryPolicy(
  config: RetryConfig | undefined,
  error: unknown,
): RetryPolicyDecision {
  const policy = findRetryPolicy(config?.policies, error);
  if (policy?.retry === false) return { retry: false };
  return {
    retry: isRetryableGenerateError(error),
    maxAttempts: policy?.maxAttempts,
    backoffMs: policy?.backoff,
  };
}

function retryErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function compileRetryPattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}
