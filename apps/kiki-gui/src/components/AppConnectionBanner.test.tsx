// @vitest-environment jsdom

/**
 * The app-level connection banner announces a lost/regained socket as one
 * polite status (a discrete event the user did not trigger), keeps the manual
 * reconnect only while closed, and disappears entirely while connected.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { AppConnectionBanner } from './AppConnectionBanner';

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  for (const host of hosts.splice(0)) host.remove();
});

async function mount(wsStatus: 'connecting' | 'open' | 'closed', onReconnect = vi.fn()) {
  const container = document.createElement('div');
  document.body.append(container);
  hosts.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <I18nProvider>
        <AppConnectionBanner wsStatus={wsStatus} onReconnect={onReconnect} />
      </I18nProvider>,
    );
  });
  return { container, onReconnect };
}

describe('AppConnectionBanner', () => {
  it('announces a lost connection as a polite status with the reconnect action', async () => {
    const onReconnect = vi.fn();
    const { container } = await mount('closed', onReconnect);
    const banner = container.querySelector('[data-app-banner]');
    expect(banner?.getAttribute('role')).toBe('status');
    // role=status implies polite + atomic; writing aria-live here too would
    // only be a second, conflicting declaration.
    expect(banner?.getAttribute('aria-live')).toBeNull();
    expect(banner?.textContent).toContain('Disconnected from the server.');
    const button = container.querySelector<HTMLButtonElement>('button');
    expect(button?.textContent).toBe('Reconnect now');
    await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('keeps the same status role while reconnecting, without the manual action', async () => {
    const { container } = await mount('connecting');
    const banner = container.querySelector('[data-app-banner]');
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.textContent).toContain('Connection lost — reconnecting…');
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders nothing while connected', async () => {
    const { container } = await mount('open');
    expect(container.querySelector('[data-app-banner]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
