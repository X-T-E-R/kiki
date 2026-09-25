// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, it, expect, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { RelativeTime } from './RelativeTime';

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
beforeAll(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = false; });

it('subscribes old sidebar-style rows only to the minute clock, retaining seconds for recent rows', async () => {
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    const old = new Date(Date.now() - 3_600_000).toISOString();
    await act(async () => {
      root.render(<I18nProvider>{Array.from({ length: 128 }, (_, index) =>
        <RelativeTime key={index} at={old} />)}</I18nProvider>);
    });
    expect(intervals.mock.calls.filter(([, delay]) => delay === 60_000)).toHaveLength(1);
    expect(intervals.mock.calls.filter(([, delay]) => delay === 1_000)).toHaveLength(0);
    await act(async () => {
      root.render(<I18nProvider><RelativeTime at={new Date().toISOString()} /></I18nProvider>);
    });
    expect(intervals.mock.calls.filter(([, delay]) => delay === 1_000)).toHaveLength(1);
  } finally {
    await act(async () => { root.unmount(); });
    intervals.mockRestore();
  }
});
