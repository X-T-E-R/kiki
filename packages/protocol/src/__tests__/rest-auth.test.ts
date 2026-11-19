import { describe, expect, it } from 'vitest';

import { authSummarySchema, managedProviderStatusSchema, type AuthSummary } from '../rest/auth';
import { connectOriginalOAuthRequestSchema, originalOAuthProbeSchema } from '../rest/oauth';

describe('authSummarySchema', () => {
  const emptyState: AuthSummary = {
    ready: false,
    providers_count: 0,
    default_model: null,
    managed_provider: null,
  };

  const readyState: AuthSummary = {
    ready: true,
    providers_count: 1,
    default_model: 'kimi-k2',
    managed_provider: { name: 'kimi-code-oauth', status: 'authenticated' },
  };

  it.each([
    ['unprovisioned', emptyState],
    ['ready with managed provider', readyState],
  ] as const)('round-trips %s state', (_label, state) => {
    expect(authSummarySchema.parse(state)).toEqual(state);
  });

  it.each(['authenticated', 'expired', 'revoked', 'unauthenticated'] as const)(
    'accepts managed_provider.status = %s',
    (status) => {
      expect(managedProviderStatusSchema.parse(status)).toBe(status);
    },
  );

  it.each([
    ['unknown managed_provider.status', { ...readyState, managed_provider: { name: 'kimi-code-oauth', status: 'pending' } }],
    ['missing ready', (({ ready: _, ...rest }) => rest)(emptyState)],
    ['missing providers_count', (({ providers_count: _, ...rest }) => rest)(emptyState)],
    ['missing default_model', (({ default_model: _, ...rest }) => rest)(emptyState)],
    ['missing managed_provider', (({ managed_provider: _, ...rest }) => rest)(emptyState)],
    ['negative providers_count', { ...emptyState, providers_count: -1 }],
    ['empty managed_provider.name', { ...readyState, managed_provider: { name: '', status: 'authenticated' as const } }],
  ] as const)('rejects %s', (_label, payload) => {
    expect(authSummarySchema.safeParse(payload).success).toBe(false);
  });
});

describe('original OAuth source contracts', () => {
  it('accepts Kimi credential-slot connections without inventing an account identity', () => {
    expect(connectOriginalOAuthRequestSchema.parse({ provider: 'kimi-code' })).toEqual({ provider: 'kimi-code' });
    expect(
      originalOAuthProbeSchema.parse({
        provider: 'kimi-code',
        home_dir: '/example/kimi',
        storage_backend: 'keyring',
        state: 'ready',
        account: { state: 'unknown' },
        can_connect: true,
      }).can_connect,
    ).toBe(true);
  });

  it.each(['openai-codex', 'grok-build'] as const)(
    'requires confirmation of the %s account',
    (provider) => {
      expect(connectOriginalOAuthRequestSchema.safeParse({ provider }).success).toBe(false);
      expect(connectOriginalOAuthRequestSchema.safeParse({ provider, expected_account_id: 'account-example' }).success).toBe(true);
    },
  );
});
