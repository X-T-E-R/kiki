import { describe, expect, it } from 'vitest';

import {
  nonemptyMarketplaceSource,
  resolvePluginMarketplaceSource,
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
