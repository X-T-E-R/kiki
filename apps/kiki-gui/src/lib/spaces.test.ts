import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureSpaceStorage } from '@kiki/session-core/storage';
import { registerScopeNavigation } from './navScope';

import {
  enterSpace,
  originOf,
  otherSpacesPending,
  spaceOverrides,
  spaceRunState,
  spaceKeys,
  suggestSpacePath,
  type ConfigOrigins,
} from './spaces';

afterEach(() => { configureSpaceStorage(null); });

const ORIGINS: ConfigOrigins = {
  default_model: { '': 'home' },
  fast_model: { '': 'base' },
  session_title: { model: 'home', enabled: 'base' },
  subagent: { timeoutMs: 'env' },
};

describe('config origins', () => {
  it('reads a scalar, a leaf and a table', () => {
    expect(originOf(ORIGINS, 'default_model')).toBe('home');
    expect(originOf(ORIGINS, 'fast_model')).toBe('base');
    expect(originOf(ORIGINS, 'session_title', 'model')).toBe('home');
    // A table asked for whole reads local when any leaf is local.
    expect(originOf(ORIGINS, 'session_title')).toBe('home');
    expect(originOf(ORIGINS, 'subagent', 'defaultModel')).toBeUndefined();
    expect(originOf(undefined, 'default_model')).toBeUndefined();
  });

  it('lists only this space’s own keys, as removeOverride paths', () => {
    expect(spaceOverrides(ORIGINS)).toEqual([
      { domain: 'default_model', keyPath: [], label: 'default_model' },
      { domain: 'session_title', keyPath: ['model'], label: 'session_title.model' },
    ]);
  });
});

describe('space run state', () => {
  const statuses = [
    { homeId: 'main', active: false, hot: true, pendingCount: 1, busyCount: 0 },
    { homeId: 'h-a', active: true, hot: true, pendingCount: 4, busyCount: 1 },
    { homeId: 'h-b', active: false, hot: true, pendingCount: 2, busyCount: 0 },
  ];

  it('treats unlisted slots as cold and sums other spaces’ pending', () => {
    configureSpaceStorage({ homeId: 'h-a', name: 'A' });
    expect(spaceRunState('h-a', statuses)).toBe('current');
    expect(spaceRunState('h-b', statuses)).toBe('hot');
    expect(spaceRunState('h-c', statuses)).toBe('cold');
    expect(otherSpacesPending(statuses)).toBe(3);
  });
});

describe('enterSpace', () => {
  it('keeps native windows open and sends same-window entry to the single scope navigator', async () => {
    const openSpace = vi.fn(async () => undefined);
    const switchSpace = vi.fn(async () => undefined);
    const navigateScope = vi.fn(async () => undefined);
    const unregister = registerScopeNavigation(navigateScope);
    try {
      await enterSpace({ kind: 'tauri', openSpace, switchSpace } as never, 'h-a', 'windows');
      expect(openSpace).toHaveBeenCalledExactlyOnceWith('h-a');
      await enterSpace({ kind: 'tauri', openSpace, switchSpace } as never, 'h-b', 'switch');
      expect(navigateScope).toHaveBeenCalledExactlyOnceWith({ homeId: 'h-b', scopeId: 'local' });
      expect(switchSpace).not.toHaveBeenCalled();
      expect(openSpace).toHaveBeenCalledTimes(1);
      await expect(enterSpace({ kind: 'browser' } as never, 'h-a', 'windows')).rejects.toThrow();
    } finally { unregister(); }
  });
});

it('keys the directory by authenticated client identity, not a tunnel URL or home ID', () => {
  const a = { baseUrl: 'http://127.0.0.1:41001' } as never;
  const b = { baseUrl: 'http://127.0.0.1:41001' } as never;
  expect(spaceKeys.list(a)).toEqual(spaceKeys.list(a));
  expect(spaceKeys.list(a)).not.toEqual(spaceKeys.list(b));
  expect(spaceKeys.list(null)).not.toEqual(spaceKeys.list(a));
  expect(spaceKeys.list(a).slice(0, 1)).toEqual(spaceKeys.all);
});

it('suggests ~/.kiki-spaces/<slug> beside the main home', () => {
  expect(suggestSpacePath('C:\\Users\\me\\.kiki', 'ACME 机密')).toBe('C:\\Users\\me\\.kiki-spaces\\acme-机密');
  expect(suggestSpacePath('/home/me/.kiki/', '  ')).toBe('/home/me/.kiki-spaces/space');
});
