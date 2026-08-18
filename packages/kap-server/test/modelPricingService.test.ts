import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IBootstrapService, ILogService } from '@moonshot-ai/agent-core-v2';

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

function createService(options: ConstructorParameters<typeof ModelPricingService>[2]) {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as ILogService;
  const service = new ModelPricingService(
    { homeDir: tempDir() } as IBootstrapService,
    log,
    { scheduleRefresh: false, minimumKeys: 2, ...options },
  );
  return { service, log };
}

afterEach(async () => {
  await drainModelPricingDisposals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ModelPriceCatalog', () => {
  const catalog = new ModelPriceCatalog({
    exact: price(1, 2),
    'anthropic/prefixed': price(2, 3),
    canonical: { ...price(3, 4), aliases: ['friendly'] },
    'OpenAI/Case.Model-V1': price(4, 5),
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

  it('keeps unpriced and unmapped models unknown instead of treating them as free', () => {
    expect(catalog.calculate('dashscope/qwen3-max', { inputOther: 10 })).toBeUndefined();
    expect(catalog.calculate('missing', { inputOther: 10 })).toBeUndefined();
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
