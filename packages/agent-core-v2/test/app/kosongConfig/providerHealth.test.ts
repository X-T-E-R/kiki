import { describe, expect, it } from 'vitest';

import { ProviderHealthService } from '#/app/kosongConfig/providerHealthService';

describe('ProviderHealthService', () => {
  it('runs one real model ping, persists a sanitized result and invalidates on connection edit', async () => {
    const saved = new Map<string, unknown>();
    let revision = 'rev-1';
    const pings: string[] = [];
    const service = new ProviderHealthService(
      { scope: (suffix: string) => suffix } as unknown as ConstructorParameters<typeof ProviderHealthService>[0],
      { ready: Promise.resolve() } as unknown as ConstructorParameters<typeof ProviderHealthService>[1],
      {
        listModels: async () => [{ id: 'one', provider_id: 'other' }, { id: 'two', provider_id: 'example' }],
        ping: async (id: string) => {
          pings.push(id);
          return { ok: false, durationMs: 9, errorCode: 'provider.auth', httpStatus: 401,
            error: 'Upstream echoed sk-super-secret in an error body.' };
        },
      } as unknown as ConstructorParameters<typeof ProviderHealthService>[2],
      { readProvider: async () => ({ revision }) } as unknown as ConstructorParameters<typeof ProviderHealthService>[3],
      {
        get: async (_scope: string, key: string) => saved.get(key),
        set: async (_scope: string, key: string, value: unknown) => { saved.set(key, value); },
      } as unknown as ConstructorParameters<typeof ProviderHealthService>[4],
    );

    const result = await service.test('example');
    expect(pings).toEqual(['two']);
    expect(result).toMatchObject({ provider_id: 'example', model_id: 'two', ok: false,
      duration_ms: 9, error_code: 'provider.auth', http_status: 401 });
    expect(result.error).toBe('The test request failed (HTTP 401).');
    expect(JSON.stringify([...saved.values()])).not.toContain('sk-super-secret');
    await expect(service.latest('example')).resolves.toEqual(result);
    revision = 'rev-2';
    await expect(service.latest('example')).resolves.toBeUndefined();
  });

  it('reports an unconfigured model without probing, and persists a successful small probe', async () => {
    const saved = new Map<string, unknown>();
    let models: Array<{ id: string; provider_id: string }> = [];
    let pingCount = 0;
    const service = new ProviderHealthService(
      { scope: () => 'store' } as unknown as ConstructorParameters<typeof ProviderHealthService>[0],
      { ready: Promise.resolve() } as unknown as ConstructorParameters<typeof ProviderHealthService>[1],
      { listModels: async () => models, ping: async () => {
        pingCount++;
        return { ok: true, durationMs: 12, text: 'pong' };
      } } as unknown as ConstructorParameters<typeof ProviderHealthService>[2],
      { readProvider: async () => ({ revision: 'rev-1' }) } as unknown as ConstructorParameters<typeof ProviderHealthService>[3],
      {
        get: async (_scope: string, key: string) => saved.get(key),
        set: async (_scope: string, key: string, value: unknown) => { saved.set(key, value); },
      } as unknown as ConstructorParameters<typeof ProviderHealthService>[4],
    );
    const noModel = await service.test('example');
    expect(noModel).toMatchObject({ ok: false, error_code: 'model_not_configured' });
    expect(pingCount).toBe(0);
    models = [{ id: 'example/model', provider_id: 'example' }];
    const success = await service.test('example');
    expect(success).toMatchObject({ ok: true, model_id: 'example/model', duration_ms: 12 });
    expect(success).not.toHaveProperty('error');
    expect(pingCount).toBe(1);
    await expect(service.latest('example')).resolves.toEqual(success);
  });
});
