import { describe, expect, it } from 'vitest';
import { connectOriginalOAuthRequestSchema, originalOAuthProbeSchema } from '../rest/oauth';

describe('original OAuth source contracts', () => {
  it('accepts Kimi credential-slot connections without inventing an account identity', () => {
    expect(connectOriginalOAuthRequestSchema.parse({ provider: 'kimi-code' })).toEqual({ provider: 'kimi-code' });
    expect(originalOAuthProbeSchema.parse({ provider: 'kimi-code', home_dir: '/example/kimi', storage_backend: 'keyring',
      state: 'ready', account: { state: 'unknown' }, can_connect: true }).can_connect).toBe(true);
  });

  it.each(['openai-codex', 'grok-build'])('still requires confirmation of the %s account', (provider) => {
    expect(connectOriginalOAuthRequestSchema.safeParse({ provider }).success).toBe(false);
    expect(connectOriginalOAuthRequestSchema.safeParse({ provider, expected_account_id: 'account-example' }).success).toBe(true);
  });
});
