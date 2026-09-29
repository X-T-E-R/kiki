// @vitest-environment jsdom

/**
 * Sidebar space switcher (§6.4, §9.4): hidden for a single-home user, lists
 * current / running / not started with other spaces' pending counts, enters a
 * space through the desktop, and Ctrl+Alt+N picks the Nth space.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureSpaceStorage } from '@kiki/session-core/storage';

import { I18nProvider } from '../i18n';
import { SpaceSwitcher } from './SpaceSwitcher';

const list = vi.fn();
const host = { kind: 'tauri' as const, spaceStatuses: vi.fn(), openSpace: vi.fn(async () => undefined) };
const navigate = vi.fn();

vi.mock('../state/connection', () => ({ useConnection: () => ({ client: { klient: { rest: { homes: { list } } } } }) }));
vi.mock('../host', () => ({ useHost: () => host }));
vi.mock('./dirtyGuard', () => ({ useGuardedNavigate: () => navigate }));

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
const roots: Root[] = [];
beforeAll(() => { vi.stubGlobal('navigator', { language: 'en-US' }); env.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { env.IS_REACT_ACT_ENVIRONMENT = false; vi.unstubAllGlobals(); });
beforeEach(() => {
  list.mockReset();
  host.openSpace.mockClear();
  navigate.mockClear();
  host.spaceStatuses.mockReset().mockResolvedValue([
    { homeId: 'main', active: true, hot: true, pendingCount: 0, busyCount: 0 },
    { homeId: 'h-a', active: false, hot: true, pendingCount: 2, busyCount: 1 },
  ]);
});
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  document.body.innerHTML = '';
  configureSpaceStorage(null);
});

async function render() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider><SpaceSwitcher /></I18nProvider></QueryClientProvider>);
  });
  await act(async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

const TWO = { items: [
  { id: 'main', name: 'Main space', path: 'C:/k', primary: true },
  { id: 'h-a', name: 'ACME', color: '#0f766e', path: 'D:/a', primary: false },
  { id: 'h-b', name: 'Paper', path: 'D:/b', primary: false },
] };

describe('SpaceSwitcher', () => {
  it('renders nothing while the main space is the only one', async () => {
    list.mockResolvedValue({ items: [TWO.items[0]] });
    const container = await render();
    expect(container.innerHTML).toBe('');
  });

  it('shows other spaces’ pending count and per-space state', async () => {
    list.mockResolvedValue(TWO);
    await render();
    expect(document.querySelector('[data-space-switcher-pending]')?.textContent).toBe('2');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
    expect(document.querySelector('[data-space-switch-item="main"]')?.getAttribute('data-space-state')).toBe('current');
    expect(document.querySelector('[data-space-switch-item="h-a"]')?.getAttribute('data-space-state')).toBe('hot');
    expect(document.querySelector('[data-space-switch-item="h-b"]')?.getAttribute('data-space-state')).toBe('cold');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switch-item="h-b"]')!.click(); });
    expect(host.openSpace).toHaveBeenCalledWith('h-b');
  });

  it('names the current space inside one and jumps with Ctrl+Alt+1', async () => {
    configureSpaceStorage({ homeId: 'h-a', name: 'ACME', color: '#0f766e' });
    list.mockResolvedValue(TWO);
    await render();
    expect(document.querySelector('[data-space-switcher]')?.textContent).toContain('ACME');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', ctrlKey: true, altKey: true })); });
    expect(host.openSpace).toHaveBeenCalledWith('main');
  });
});
