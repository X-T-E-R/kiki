import { describe, expect, it } from 'vitest';

import { getNativeCacheBase } from '#/native/native-assets';

describe('getNativeCacheBase precedence', () => {
  const baseOptions = { homeDir: '/home/u' };

  it('uses KIKI_CACHE_DIR when set (highest precedence)', () => {
    const got = getNativeCacheBase({
      ...baseOptions,
      env: { KIKI_CACHE_DIR: '/custom/cache' },
    });
    expect(got).toBe('/custom/cache');
  });

  it('ignores KIMI_CODE_HOME (no longer affects native cache)', () => {
    const got = getNativeCacheBase({
      ...baseOptions,
      env: { KIMI_CODE_HOME: '/legacy' },
      platform: 'darwin',
    });
    expect(got).toBe('/home/u/Library/Caches/kimi-code');
  });

  it('uses platform default on macOS when no env set', () => {
    const got = getNativeCacheBase({
      ...baseOptions,
      env: {},
      platform: 'darwin',
    });
    expect(got).toBe('/home/u/Library/Caches/kimi-code');
  });

  it('uses XDG_CACHE_HOME on Linux when set', () => {
    const got = getNativeCacheBase({
      ...baseOptions,
      env: { XDG_CACHE_HOME: '/xdg' },
      platform: 'linux',
    });
    expect(got).toBe('/xdg/kimi-code');
  });

  it('uses LOCALAPPDATA on Windows when set', () => {
    const got = getNativeCacheBase({
      ...baseOptions,
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      platform: 'win32',
    });
    expect(got).toBe('C:\\Users\\u\\AppData\\Local\\kimi-code');
  });
});
