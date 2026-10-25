// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import React from 'react';

import { AppErrorBoundary } from './AppErrorBoundary';
import { I18nProvider } from '../i18n';

function Bomb(): React.ReactElement {
  throw new Error('Minified React error #185; visit https://reactjs.org/docs/error-decoder.html?invariant=185 for the full message');
}

describe('AppErrorBoundary', () => {
  it('records componentStack and exact route with query and hash on React 185 failure', async () => {
    const originalHref = window.location.href;
    const targetRoute = '/s/session-test?filter=active#details';
    window.history.replaceState(null, '', targetRoute);

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider>
            <AppErrorBoundary>
              <Bomb />
            </AppErrorBoundary>
          </I18nProvider>,
        );
      });

      expect(setItemSpy).toHaveBeenCalledWith(
        'kiki.lastRenderFailure',
        expect.stringContaining('185'),
      );

      const callArg = setItemSpy.mock.calls.find((call) => call[0] === 'kiki.lastRenderFailure')?.[1];
      expect(callArg).toBeDefined();
      const parsed = JSON.parse(callArg!);
      expect(parsed.path).toBe(targetRoute);
      expect(parsed.componentStack).toContain('Bomb');
      expect(parsed.message).toContain('185');
    } finally {
      window.history.replaceState(null, '', originalHref);
      consoleErrorSpy.mockRestore();
      setItemSpy.mockRestore();
      root.unmount();
      container.remove();
    }
  });
});
