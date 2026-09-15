import { describe, expect, it, vi } from 'vitest';

import {
  PLUGIN_RELEASE_LOOKUP_TIMEOUT_MS,
  nonemptyMarketplaceSource,
  resolvePluginMarketplaceSource,
  withLatestVersions,
  type PluginMarketplace,
} from '#/app/plugin/marketplace';

describe('plugin marketplace source', () => {
  it('treats blank and whitespace-only values as unconfigured', () => {
    expect(nonemptyMarketplaceSource(undefined)).toBeUndefined();
    expect(nonemptyMarketplaceSource('')).toBeUndefined();
    expect(nonemptyMarketplaceSource('   ')).toBeUndefined();
    expect(nonemptyMarketplaceSource(' https://example.test/marketplace.json ')).toBe(
      'https://example.test/marketplace.json',
    );
  });

  it('prefers the server option, then env, then config.toml', () => {
    expect(
      resolvePluginMarketplaceSource({
        optionUrl: 'https://option.test/m.json',
        envUrl: 'https://env.test/m.json',
        configUrl: 'https://config.test/m.json',
      }),
    ).toBe('https://option.test/m.json');
    expect(
      resolvePluginMarketplaceSource({
        envUrl: 'https://env.test/m.json',
        configUrl: 'https://config.test/m.json',
      }),
    ).toBe('https://env.test/m.json');
    expect(resolvePluginMarketplaceSource({ configUrl: '~/catalog.json' })).toBe('~/catalog.json');
    expect(resolvePluginMarketplaceSource({})).toBeUndefined();
    expect(
      resolvePluginMarketplaceSource({
        optionUrl: '  ',
        envUrl: '',
        configUrl: undefined,
      }),
    ).toBeUndefined();
  });
});

describe('plugin marketplace version lookup', () => {
  function catalog(...source: readonly string[]): PluginMarketplace {
    return {
      source: 'https://example.test/marketplace.json',
      plugins: source.map((entry, index) => ({
        id: `p${String(index)}`,
        displayName: `Plugin ${String(index)}`,
        source: entry,
      })),
    };
  }

  function neverSettlingFetch(): { impl: typeof fetch; calls: () => number } {
    let calls = 0;
    const impl = ((_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject((init.signal as AbortSignal).reason);
        });
      });
    }) as unknown as typeof fetch;
    return { impl, calls: () => calls };
  }

  it('aborts a stalled releases/latest lookup at the configured bound', async () => {
    const { impl, calls } = neverSettlingFetch();
    const started = Date.now();
    const resolved = await withLatestVersions(
      catalog('https://github.com/owner/bare', 'https://example.test/pinned.zip'),
      impl,
      25,
    );
    expect(calls()).toBe(1);
    expect(resolved.plugins[0]?.version).toBeUndefined();
    expect(resolved.plugins[1]?.version).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('bounds every default lookup within the platform-scale window', () => {
    expect(PLUGIN_RELEASE_LOOKUP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PLUGIN_RELEASE_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('skips the lookup entirely for entries that already pin a version', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    const resolved = await withLatestVersions(
      { source: 's', plugins: [{ id: 'p0', displayName: 'P', source: 'x', version: '1.2.3' }] },
      fetchImpl,
    );
    expect(resolved.plugins[0]?.version).toBe('1.2.3');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
