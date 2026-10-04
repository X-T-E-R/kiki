import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { INbSearchService, type Scope } from '@kiki/agent-core-v2';
import { nbSearchKeyUsageViewSchema } from '@kiki/protocol';
import { registerNbSearchRoutes } from '../src/routes/nbSearch';

describe('nb-search usage REST contract', () => {
  it('does not poll on registration; validates explicit request bodies and gives a safe failure for unavailable usage', async () => {
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
    const view = { provider_instance_id: 'account-two', provider_id: 'exa', balance_supported: false, keys: [{ key_index: 1, state: 'unknown' }] };
    const keyUsage = vi.fn(async () => view);
    const scope = { accessor: { get: (token: unknown) => { expect(token).toBe(INbSearchService); return { keyUsage }; } } } as unknown as Scope;
    registerNbSearchRoutes(app, scope);
    expect(keyUsage).not.toHaveBeenCalled();
    try {
      const response = await app.inject({ method: 'POST', url: '/nb-search/keys/usage', payload: { instance_id: 'account-two' } });
      expect(response.statusCode).toBe(200);
      expect(response.json().code).toBe(0);
      expect(nbSearchKeyUsageViewSchema.parse(response.json().data)).toEqual(view);
      expect(keyUsage).toHaveBeenCalledWith('account-two', false);
      const invalid = await app.inject({ method: 'POST', url: '/nb-search/keys/usage', payload: { instance_id: 'account-two', refresh: true, secret: 'fixture-key' } });
      expect(invalid.statusCode).toBe(400);
      expect(keyUsage).toHaveBeenCalledTimes(1);
      keyUsage.mockRejectedValueOnce(new Error('fixture-private-error'));
      const failure = await app.inject({ method: 'POST', url: '/nb-search/keys/usage', payload: { instance_id: 'account-two', refresh: true } });
      expect(failure.json().code).not.toBe(0);
      expect(failure.body).not.toContain('fixture-private-error');
    } finally { await app.close(); }
  });
});
