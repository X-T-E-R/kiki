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
  it('records componentStack and route path into sessionStorage on React 185 failure', async () => {
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
    } catch {
      // ignore
    }

    expect(setItemSpy).toHaveBeenCalledWith(
      'kiki.lastRenderFailure',
      expect.stringContaining('185'),
    );

    const callArg = setItemSpy.mock.calls.find((call) => call[0] === 'kiki.lastRenderFailure')?.[1];
    expect(callArg).toBeDefined();
    const parsed = JSON.parse(callArg!);
    expect(parsed.path).toBeDefined();
    expect(parsed.componentStack).toContain('Bomb');
    expect(parsed.message).toContain('185');

    consoleErrorSpy.mockRestore();
    setItemSpy.mockRestore();
    root.unmount();
    container.remove();
  });
});
