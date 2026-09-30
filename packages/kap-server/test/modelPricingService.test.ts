import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IBootstrapService, ILogService, IConfigService, ModelRecord } from '@kiki/agent-core-v2';
import { TomlAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';

import {
  ModelPriceCatalog,
  ModelPricingService,
  drainModelPricingDisposals,
  validatePriceCatalogText,
} from '../src/pricing/modelPricingService';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kap-model-pricing-'));
  dirs.push(dir);
  return dir;
}

function price(input = 0.001, output = 0.002) {
  return {
    input_cost_per_token: input,
    output_cost_per_token: output,
    cache_read_input_token_cost: input / 10,
    cache_creation_input_token_cost: input * 1.25,
  };
}

function fixture(extra: Record<string, unknown> = {}, padding = 0): string {
  const catalog: Record<string, unknown> = {
    'gpt-5': price(),
    'claude-sonnet-4-5': price(),
    ...extra,
  };
  for (let index = 0; index < padding; index += 1) {
    catalog[`padding-${index}`] = price();
  }
  return JSON.stringify(catalog);
}

function createService(options: ConstructorParameters<typeof ModelPricingService>[4], models: Record<string, ModelRecord> = {}, home = tempDir()) {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as ILogService;
  const documents = new TomlAtomicDocumentStore(new FileStorageService(home));
  const config = { ready: Promise.resolve(), get: () => models } as unknown as IConfigService;
  const service = new ModelPricingService(
    { homeDir: home } as IBootstrapService,
    log,
    documents,
    config,
    { scheduleRefresh: false, minimumKeys: 2, ...options },
  );
  return { service, log, home };
}

afterEach(async () => {
  await drainModelPricingDisposals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe('ModelPriceCatalog', () => {
  const catalog = new ModelPriceCatalog({
    exact: price(1, 2),
    'anthropic/prefixed': price(2, 3),
    canonical: { ...price(3, 4), aliases: ['friendly'] },
    'OpenAI/Case.Model-V1': price(4, 5),
    'xai/grok-4.6': price(6, 7),
    'deepseek/deepseek-v4-pro': price(7, 8),
    'model-2024': price(8, 9),
    'azure_ai/FW-Kimi-K3': price(9, 10),
    'dashscope/kimi-k2.7-code': {
      input_cost_per_token: 0.95e-6,
      output_cost_per_token: 4e-6,
      cache_read_input_token_cost: 0.19e-6,
    },
    'dashscope/qwen3-max': { max_input_tokens: 262_144 },
    fallback_generalizations: {
      rules: [
        {
          name: 'future-family',
          pattern: '^future-model-',
          model_info: price(5, 6),
        },
      ],
    },
  });

  it('resolves exact, provider-prefix, alias, family, and normalized matches in order', () => {
    expect(catalog.resolve('exact')).toMatchObject({ catalogModel: 'exact', strategy: 'exact' });
    expect(catalog.resolve('prefixed')).toMatchObject({
      catalogModel: 'anthropic/prefixed',
      strategy: 'provider-prefix',
    });
    expect(catalog.resolve('friendly')).toMatchObject({
      catalogModel: 'canonical',
      strategy: 'alias',
    });
    expect(catalog.resolve('future-model-9')).toMatchObject({
      catalogModel: 'future-family',
      strategy: 'family-regex',
    });
    expect(catalog.resolve('openai/case-model.v1')).toMatchObject({
      catalogModel: 'OpenAI/Case.Model-V1',
      strategy: 'normalized',
    });
  });

  it('resolves gateway-prefixed and date-pinned model ids through the full chain', () => {
    expect(catalog.resolve('axon-message/grok-4.6')).toMatchObject({
      requestedModel: 'axon-message/grok-4.6',
      catalogModel: 'xai/grok-4.6',
      strategy: 'provider-prefix',
    });
    expect(catalog.resolve('deepseek-v4-pro-0813')).toMatchObject({
      requestedModel: 'deepseek-v4-pro-0813',
      catalogModel: 'deepseek/deepseek-v4-pro',
      strategy: 'provider-prefix',
    });
    expect(catalog.resolve('gateway/friendly')).toMatchObject({
      catalogModel: 'canonical',
      strategy: 'alias',
    });
    expect(catalog.resolve('gateway/future-model-9')).toMatchObject({
      catalogModel: 'future-family',
      strategy: 'family-regex',
    });
    expect(catalog.resolve('gateway/openai/case-model.v1')).toMatchObject({
      catalogModel: 'OpenAI/Case.Model-V1',
      strategy: 'normalized',
    });
    expect(catalog.resolve('model-2024')).toMatchObject({
      catalogModel: 'model-2024',
      strategy: 'exact',
    });
  });

  it('keeps unpriced and unmapped models unknown instead of treating them as free', () => {
    expect(catalog.calculate('dashscope/qwen3-max', { inputOther: 10 })).toBeUndefined();
    expect(catalog.calculate('missing', { inputOther: 10 })).toBeUndefined();
    expect(catalog.calculate('kimi-code/kimi-deep-coder', { inputOther: 10 })).toBeUndefined();
    expect(catalog.calculate('kimi-code/not-a-real-model', { inputOther: 10 })).toBeUndefined();
  });

  it('resolves kimi-code internal aliases through the local override table', () => {
    expect(catalog.resolve('kimi-code/k3')).toMatchObject({
      requestedModel: 'kimi-code/k3',
      strategy: 'override',
      prices: {
        inputCostPerToken: 3e-6,
        outputCostPerToken: 15e-6,
        cacheReadInputTokenCost: 0.3e-6,
      },
    });
    expect(catalog.resolve('kimi-code/k3-256k')).toMatchObject({
      strategy: 'override',
      prices: { inputCostPerToken: 3e-6, outputCostPerToken: 15e-6 },
    });
    expect(catalog.resolve('kimi-code/kimi-for-coding')).toMatchObject({
      catalogModel: 'dashscope/kimi-k2.7-code',
      strategy: 'override-alias',
    });
  });

  it('prices kimi-code overrides through calculate and keeps premium aliases priced', () => {
    const k3 = catalog.calculate('kimi-code/k3', {
      inputOther: 2,
      output: 1,
      inputCacheRead: 10,
    });
    expect(k3).toBe(2 * 3e-6 + 1 * 15e-6 + 10 * 0.3e-6);

    const kfc = catalog.calculate('kimi-code/kimi-for-coding', { inputOther: 1 });
    expect(kfc).toBe(0.95e-6);

    const highspeed = catalog.calculate('kimi-code/kimi-for-coding-highspeed', {
      inputOther: 1,
    });
    expect(highspeed).toBe(1.9e-6);
  });

  it('prices all four token components in USD per token', () => {
    expect(
      catalog.calculate('exact', {
        inputOther: 2,
        output: 3,
        inputCacheRead: 4,
        inputCacheCreation: 5,
      }),
    ).toBe(2 * 1 + 3 * 2 + 4 * 0.1 + 5 * 1.25);
  });
});

describe('catalog validation and refresh fallback', () => {
  it('rejects invalid samples and sudden key/byte shrinkage', () => {
    expect(() => validatePriceCatalogText('{}', { minimumKeys: 2 })).toThrow(/only 0 keys/);
    const baseline = validatePriceCatalogText(fixture({}, 8), { minimumKeys: 2 }).stats;
    expect(() =>
      validatePriceCatalogText(fixture({}, 2), { minimumKeys: 2, baseline }),
    ).toThrow(/shrank unexpectedly/);
  });

  it('loads a valid cache first and falls back to vendored when the cache is bad', () => {
    const dir = tempDir();
    const vendoredPath = join(dir, 'vendored.json');
    const cachePath = join(dir, 'cache.json');
    writeFileSync(vendoredPath, fixture({ vendored: price() }));
    writeFileSync(cachePath, '{bad json');

    const { service } = createService({ vendoredPath, cachePath });
    expect(service.status()).toMatchObject({ source: 'vendored', keys: 3 });
    expect(service.resolve('vendored')).toBeDefined();
    service.dispose();
  });

  it('tries the mirror after a shrunken primary and atomically activates the valid refresh', async () => {
    const dir = tempDir();
    const vendoredPath = join(dir, 'vendored.json');
    const cachePath = join(dir, 'cache.json');
    writeFileSync(vendoredPath, fixture({ old: price() }, 8));
    const refreshed = fixture({ fresh: price() }, 9);
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      return new Response(href.includes('primary') ? fixture({}, 1) : refreshed);
    }) as typeof fetch;

    const { service } = createService({
      vendoredPath,
      cachePath,
      refreshUrls: ['https://primary.example/prices', 'https://mirror.example/prices'],
      fetcher,
    });
    await expect(service.refreshNow()).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(service.status()).toMatchObject({ source: 'refresh', keys: 12 });
    expect(service.resolve('fresh')).toBeDefined();
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toHaveProperty('fresh');
    service.dispose();
  });

  it('keeps the previous cache bytes and catalog when every refresh is invalid', async () => {
    const dir = tempDir();
    const vendoredPath = join(dir, 'vendored.json');
    const cachePath = join(dir, 'cache.json');
    const cached = fixture({ cached: price() }, 4);
    writeFileSync(vendoredPath, cached);
    writeFileSync(cachePath, cached);
    const fetcher = vi.fn(async () => new Response('{bad json')) as typeof fetch;

    const { service } = createService({
      vendoredPath,
      cachePath,
      refreshUrls: ['https://primary.example/prices', 'https://mirror.example/prices'],
      fetcher,
    });
    await expect(service.refreshNow()).resolves.toBe(false);
    expect(readFileSync(cachePath, 'utf8')).toBe(cached);
    expect(service.status()).toMatchObject({ source: 'cache' });
    expect(service.resolve('cached')).toBeDefined();
    service.dispose();
  });
});

describe('user model pricing', () => {
  it('matches canonical ids behind provider and proxy prefixes including Zhipu', () => {
    const catalog = new ModelPriceCatalog({
      'claude-opus-5-5': price(), 'gpt-6-sol': price(), 'gpt-6.1-sol': price(),
      'zai/glm-5.3-flash': price(), 'zhipu/other-model': price(),
    });
    for (const [requested, canonical] of [
      ['anthropic/claude-opus-5-5', 'claude-opus-5-5'],
      ['axon/gpt-6-sol', 'gpt-6-sol'], ['axon/gpt-6.1-sol', 'gpt-6.1-sol'],
      ['z-ai/glm-5.3-flash', 'zai/glm-5.3-flash'], ['other-model', 'zhipu/other-model'],
    ]) expect(catalog.resolve(requested as string)?.catalogModel).toBe(canonical);
    expect(catalog.resolve('axon/unpublished-model')).toBeUndefined();
  });

  it('persists overrides atomically, patches without losing neighbors, restores catalog pricing and reports provenance', async () => {
    const home = tempDir();
    const vendoredPath = join(home, 'vendored.json');
    writeFileSync(vendoredPath, fixture({ canonical: price(1, 2) }));
    const models = { alias: { provider: 'proxy', model: 'remote', pricingModel: 'canonical' } };
    const { service } = createService({ vendoredPath }, models, home);
    expect((await service.getPricing(['alias', 'unknown'])).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'alias', pricing_model: 'canonical', matched_key: 'canonical', source: 'vendored' }),
      expect.objectContaining({ model: 'unknown', matched_key: null, source: 'unknown', prices: null }),
    ]));
    expect(service.calculate('proxy/remote', { inputOther: 3 })).toBe(3);
    const override = { input_cost_per_token: 0.1, output_cost_per_token: 0.2,
      cache_read_input_token_cost: 0.01, cache_creation_input_token_cost: 0.15, currency: 'USD' };
    await Promise.all([
      service.setPricing({ overrides: { alias: override } }),
      service.setPricing({ overrides: { unknown: override } }),
    ]);
    expect((await service.getPricing()).overrides).toEqual({ alias: override, unknown: override });
    expect(service.calculate('alias', { inputOther: 1, output: 1, inputCacheRead: 1, inputCacheCreation: 1 })).toBeCloseTo(0.46);
    const text = readFileSync(join(home, 'model-pricing', 'overrides.toml'), 'utf8');
    expect(text).toContain('currency = "USD"');
    service.dispose();
    const { service: restarted } = createService({ vendoredPath }, models, home);
    expect((await restarted.getPricing()).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'alias', matched_key: 'alias', source: 'override', prices: override }),
    ]));
    expect(restarted.calculate('proxy/remote', { inputOther: 1 })).toBe(0.1);
    expect(restarted.calculate('remote', { inputOther: 1 })).toBe(0.1);
    await restarted.setPricing({ overrides: { alias: null } });
    expect(restarted.calculate('alias', { inputOther: 1 })).toBe(1);
    expect((await restarted.getPricing()).overrides).toEqual({ unknown: override });
    await restarted.setPricing({ overrides: { unknown: { ...override, currency: 'CNY' } } });
    expect(restarted.calculate('unknown', { inputOther: 1 })).toBeUndefined();
    expect((await restarted.getPricing(['unknown'])).items.find((item) => item.model === 'unknown')?.prices?.currency).toBe('CNY');
    await expect(restarted.setPricing({ overrides: { alias: { ...override, input_cost_per_token: -1 } } })).rejects.toThrow();
    restarted.dispose();
  });

  it('reports refreshed/cache catalogs without silently assigning an unrelated model price', async () => {
    const home = tempDir();
    const vendoredPath = join(home, 'vendored.json');
    const cachePath = join(home, 'cache.json');
    writeFileSync(vendoredPath, fixture());
    writeFileSync(cachePath, fixture({ canonical: price() }));
    const { service } = createService({ vendoredPath, cachePath }, { unknown: { pricingModel: 'unpublished' } }, home);
    const response = await service.getPricing(['canonical', 'unknown']);
    expect(response.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'canonical', matched_key: 'canonical', source: 'litellm-cache' }),
      expect.objectContaining({ model: 'unknown', matched_key: null, source: 'unknown' }),
    ]));
    service.dispose();
  });
});
