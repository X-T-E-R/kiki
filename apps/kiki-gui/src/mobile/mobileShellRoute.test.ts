// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  DESKTOP_OVERRIDE_STORAGE_KEY,
  mobileChatPath,
  normalizeDeepLinkRoute,
  shouldUseMobileShell,
} from './mobileShellRoute';

const ANDROID_SHELL_UA = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36 KikiApp/android';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

function at(pathname: string, search = ''): Pick<Location, 'pathname' | 'search'> {
  return { pathname, search };
}

afterEach(() => {
  sessionStorage.removeItem(DESKTOP_OVERRIDE_STORAGE_KEY);
});

describe('normalizeDeepLinkRoute', () => {
  it('maps native notification routes onto the active shell', () => {
    expect(normalizeDeepLinkRoute('/sessions/sess%201', true)).toBe('/m/c/local/sess%201');
    expect(normalizeDeepLinkRoute('/sessions/sess_1?focus=1', false)).toBe('/s/sess_1?focus=1');
  });

  it('lands desktop session and root links inside the mobile shell', () => {
    expect(normalizeDeepLinkRoute('/s/abc', true)).toBe(mobileChatPath('local', 'abc'));
    expect(normalizeDeepLinkRoute('/', true)).toBe('/m/assistant');
    expect(normalizeDeepLinkRoute('', true)).toBe('/m/assistant');
    expect(normalizeDeepLinkRoute('/m/c/remote%3Ax/s1', true)).toBe('/m/c/remote%3Ax/s1');
  });

  it('leaves desktop routes untouched outside the mobile shell', () => {
    expect(normalizeDeepLinkRoute('/s/abc', false)).toBe('/s/abc');
    expect(normalizeDeepLinkRoute('settings', false)).toBe('/settings');
  });
});

describe('shouldUseMobileShell', () => {
  it('always serves /m/* with the mobile shell', () => {
    expect(shouldUseMobileShell(at('/m/chats'), DESKTOP_UA)).toBe(true);
  });

  it('serves the app-shell user agent the mobile shell until the user asks for the workbench', () => {
    expect(shouldUseMobileShell(at('/s/abc'), ANDROID_SHELL_UA)).toBe(true);
    expect(shouldUseMobileShell(at('/s/abc', '?desktop=1'), ANDROID_SHELL_UA)).toBe(false);
    expect(shouldUseMobileShell(at('/s/other'), ANDROID_SHELL_UA)).toBe(false);
    expect(shouldUseMobileShell(at('/s/other', '?mobile=1'), ANDROID_SHELL_UA)).toBe(true);
    expect(shouldUseMobileShell(at('/s/other'), ANDROID_SHELL_UA)).toBe(true);
  });

  it('keeps desktop browsers on the workbench', () => {
    expect(shouldUseMobileShell(at('/s/abc'), DESKTOP_UA)).toBe(false);
  });
});
