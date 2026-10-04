// @vitest-environment jsdom

/**
 * Sidebar space switcher (§6.4, §9.4): the wordmark is always the menu
 * button (single-home users find New space… there), it lists
 * current / running / not started with other spaces' pending counts, enters a
 * space through the desktop, and Ctrl+Alt+N picks the Nth space.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureSpaceStorage } from '@kiki/session-core/storage';
import { writeDesktopPrefs } from '@kiki/session-core/settings';

import { I18nProvider } from '../i18n';
import { SpaceSwitcher } from './SpaceSwitcher';
import { useConnection } from '../state/connection';
import { resetLaunchWindowMode, useSpaces } from '../lib/spaces';
import { registerScopeNavigation } from '../lib/navScope';

const list = vi.fn();
const defaultClient = { klient: { rest: { homes: { list } } } };
const host = { kind: 'tauri' as 'tauri' | 'browser', spaceStatuses: vi.fn(), openSpace: vi.fn(async (): Promise<void> => undefined) };
const navigate = vi.fn();
/** Remote (SSH) connection state, toggleable per test. */
const connection = vi.hoisted(() => ({
  sshLabel: null as string | null,
  activateLocal: vi.fn(),
  restoreLocal: vi.fn<(...args: [AbortSignal?]) => Promise<void>>(),
  order: [] as string[],
  /** The client the current connection serves; `null` is the default client. */
  client: null as { klient: { rest: { homes: { list: unknown } } } } | null,
  localClient: undefined as { klient: { rest: { homes: { list: unknown } } } } | null | undefined,
  pendingAction: null as (() => void | Promise<void>) | null,
  guardActions: false,
}));

/** Independent home directories; `h-shared` collides across hosts with different semantics. */
const REMOTE_HOMES = {
  items: [
    { id: 'main', name: 'Main space', path: '/srv/kiki', primary: true },
    { id: 'h-remote-only', name: 'Remote ACME', path: '/srv/acme', primary: false },
    { id: 'h-shared', name: 'Remote Paper', path: '/srv/paper', primary: false },
  ],
};
const LOCAL_HOMES = {
  items: [
    { id: 'main', name: 'Main space', path: 'C:/kiki', primary: true },
    { id: 'h-local-only', name: 'Local GPU', path: 'D:/gpu', primary: false },
    { id: 'h-shared', name: 'Local Paper', path: 'E:/paper', primary: false },
  ],
};

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    client: connection.client ?? defaultClient,
    localClient: connection.localClient === undefined ? defaultClient : connection.localClient,
    sshLabel: connection.sshLabel,
    activateLocal: connection.activateLocal,
    restoreLocal: connection.restoreLocal,
    scopeAdapter: { prepare: async (scope: { homeId: string; scopeId: string }, signal: AbortSignal) => ({
      scope,
      validate: async () => { signal.throwIfAborted(); },
      commit: async () => { signal.throwIfAborted(); connection.activateLocal(); },
      dispose: async () => {},
    }) },
  }),
}));
vi.mock('../host', () => ({ useHost: () => host }));
vi.mock('./dirtyGuard', () => ({
  useGuardedNavigate: () => navigate,
  useDirtyGuard: () => ({ runAction: (action: () => void | Promise<void>, target?: string) => {
    const execute = () => {
      const result = action();
      const go = () => { if (target !== undefined) navigate(target); };
      if (result !== undefined) return result.then(go);
      go();
    };
    if (connection.guardActions) connection.pendingAction = execute;
    else return execute();
  } }),
}));

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
const roots: Root[] = [];
beforeAll(() => { vi.stubGlobal('navigator', { language: 'en-US' }); env.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { env.IS_REACT_ACT_ENVIRONMENT = false; vi.unstubAllGlobals(); });
beforeEach(() => {
  list.mockReset();
  resetLaunchWindowMode();
  // Native directory/SSH controls exercise the windows branch; the real
  // single-seat switch-mode consumer is covered with NavScopeBoundary.
  writeDesktopPrefs({ windowMode: 'windows' });
  host.openSpace.mockReset().mockResolvedValue(undefined);
  navigate.mockClear();
  connection.sshLabel = null;
  connection.activateLocal.mockReset();
  connection.restoreLocal.mockReset().mockImplementation(async () => { connection.activateLocal(); });
  connection.order.length = 0;
  connection.client = null;
  connection.localClient = undefined;
  connection.guardActions = false;
  connection.pendingAction = null;
  host.kind = 'tauri';
  host.spaceStatuses.mockReset().mockResolvedValue([
    { homeId: 'main', active: true, hot: true, pendingCount: 0, busyCount: 0 },
    { homeId: 'h-a', active: false, hot: true, pendingCount: 2, busyCount: 1 },
  ]);
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.innerHTML = '';
  configureSpaceStorage(null);
});

function DomainQuery() {
  const { client } = useConnection();
  const spaces = useSpaces(client);
  return <span data-domain-query>{spaces.data?.map((space) => space.name).join(',') ?? 'pending'}</span>;
}

async function render(domainQuery = false) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rerender = async () => {
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><I18nProvider><SpaceSwitcher />{domainQuery ? <DomainQuery /> : null}</I18nProvider></QueryClientProvider>);
    });
    await act(async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  await rerender();
  return { container, rerender, queryClient };
}

const TWO = { items: [
  { id: 'main', name: 'Main space', path: 'C:/k', primary: true },
  { id: 'h-a', name: 'ACME', color: '#295c58', path: 'D:/a', primary: false },
  { id: 'h-b', name: 'Paper', path: 'D:/b', primary: false },
] };

describe('SpaceSwitcher', () => {
  it('keeps the wordmark a menu button with New space… for a single-home user', async () => {
    list.mockResolvedValue({ items: [TWO.items[0]] });
    await render();
    const trigger = document.querySelector<HTMLButtonElement>('[data-space-switcher="main"]');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.querySelector('[data-space-switcher-name]')).toBeNull();
    await act(async () => { trigger!.click(); });
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-space-single-hint]')).not.toBeNull();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-new-entry]')!.click(); });
    expect(navigate).toHaveBeenCalledWith('/settings/spaces?new=1');
  });

  it('still offers the menu when the server cannot list spaces', async () => {
    list.mockRejectedValue(new Error('404'));
    await render();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
    expect(document.querySelectorAll('[data-space-switch-item]')).toHaveLength(1);
    expect(document.querySelector('[data-space-new-entry]')).not.toBeNull();
    expect(document.querySelector('[data-space-manage]')).not.toBeNull();
  });

  it('shows other spaces’ pending count and per-space state', async () => {
    writeDesktopPrefs({ windowMode: 'switch' });
    const scopeNavigate = vi.fn(async () => undefined);
    const unregister = registerScopeNavigation(scopeNavigate);
    try {
      list.mockResolvedValue(TWO);
      await render();
      expect(document.querySelector('[data-space-switcher-pending]')?.textContent).toBe('2');
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
      expect(document.querySelector('[data-space-switch-item="main"]')?.getAttribute('data-space-state')).toBe('current');
      expect(document.querySelector('[data-space-switch-item="h-a"]')?.getAttribute('data-space-state')).toBe('hot');
      expect(document.querySelector('[data-space-switch-item="h-b"]')?.getAttribute('data-space-state')).toBe('cold');
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switch-item="h-b"]')!.click(); });
      expect(scopeNavigate).toHaveBeenCalledExactlyOnceWith({ homeId: 'h-b', scopeId: 'local' });
      expect(host.openSpace).not.toHaveBeenCalled();
    } finally { unregister(); }
  });

  it('names the current space inside one and jumps with Ctrl+Alt+1', async () => {
    configureSpaceStorage({ homeId: 'h-a', name: 'ACME', color: '#295c58' });
    list.mockResolvedValue(TWO);
    await render();
    const trigger = document.querySelector<HTMLButtonElement>('[data-space-switcher="h-a"]')!;
    expect(trigger.querySelector('[data-space-switcher-name]')?.textContent).toBe('ACME');
    expect(trigger.querySelector('[data-space-dot]')).not.toBeNull();
    expect(trigger.getAttribute('aria-label')).toContain('kiki · ACME');
    await act(async () => { trigger.click(); });
    expect(document.querySelector('[data-space-new-entry]')).toBeNull();
    expect(document.querySelector('[data-space-manage]')).not.toBeNull();
    await act(async () => { trigger.click(); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', ctrlKey: true, altKey: true })); });
    expect(host.openSpace).toHaveBeenCalledWith('main');
  });

  it('shows the remote identity alongside the real local space list', async () => {
    connection.sshLabel = 'dev-server-gpu';
    list.mockResolvedValue(TWO);
    await render();
    const trigger = document.querySelector<HTMLElement>('[data-space-remote]');
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('data-space-switcher')).toBeNull();
    expect(trigger?.querySelector('[data-space-switcher-name]')?.textContent).toBe('dev-server-gpu');
    expect((trigger?.querySelector('[data-space-remote-tag]')?.textContent ?? '').length).toBeGreaterThan(0);
    expect(trigger?.getAttribute('aria-label')).toContain('kiki · dev-server-gpu');

    await act(async () => { (trigger as HTMLButtonElement).click(); });
    expect(document.querySelector('[data-space-remote-note]')?.textContent).toContain('dev-server-gpu');
    expect(document.querySelector('[data-space-back-local]')).not.toBeNull();
    expect(document.querySelector('[data-space-manage]')).not.toBeNull();
    expect(document.querySelectorAll('[data-space-switch-item]')).toHaveLength(3);
    expect(document.querySelector('[aria-current="true"]')).toBeNull();

    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-back-local]')!.click(); });
    expect(connection.activateLocal).toHaveBeenCalledTimes(1);
  });

  it('commits the local environment only after the independent window opens while remote', async () => {
    connection.sshLabel = 'dev-server-gpu';
    connection.activateLocal.mockImplementation(() => { connection.order.push('local'); });
    host.openSpace.mockImplementation(async () => {
      expect(connection.activateLocal).not.toHaveBeenCalled();
      connection.order.push('open');
    });
    configureSpaceStorage({ homeId: 'main', name: 'Main space' });
    list.mockResolvedValue(TWO);
    await render();

    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', ctrlKey: true, altKey: true })); });
    expect(host.openSpace).toHaveBeenCalledWith('h-a');
    expect(connection.order).toEqual(['open', 'local']);
    await act(async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
  });

  // E4b: remote-only IDs and colliding IDs must never masquerade as local spaces.
  it('targets the local homes list when the shortcut returns to local', async () => {
    const remoteList = vi.fn().mockResolvedValue(REMOTE_HOMES);
    const localList = vi.fn().mockResolvedValue(LOCAL_HOMES);
    connection.sshLabel = 'dev-server-gpu';
    connection.client = { klient: { rest: { homes: { list: remoteList } } } };
    connection.localClient = { klient: { rest: { homes: { list: localList } } } };
    connection.activateLocal.mockImplementation(() => {
      connection.order.push('local');
      connection.sshLabel = null;
      connection.client = { klient: { rest: { homes: { list: localList } } } };
    });
    host.openSpace.mockImplementation(async () => { connection.order.push('open'); });
    configureSpaceStorage({ homeId: 'main', name: 'Main space', color: '#295c58' });
    const view = await render();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-remote]')!.click(); });
    const advertised = [...document.querySelectorAll('[data-space-switch-item]')].slice(1).map((item) => item.querySelector('span.flex-1')?.textContent);
    expect(document.querySelector('[data-space-switch-item="h-remote-only"]')).toBeNull();
    expect(document.querySelector('[data-space-switch-item="h-shared"]')?.textContent).not.toContain('Remote Paper');

    const press = async (digit: number) => {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: `Digit${digit}`, ctrlKey: true, altKey: true }));
      });
    };
    await press(2);
    await view.rerender();
    await press(3);
    expect(remoteList).not.toHaveBeenCalled();
    expect(localList).toHaveBeenCalledTimes(1);

    const targets = host.openSpace.mock.calls.map((call) => (call as unknown[])[0]);
    const localFor = targets.map((id) => LOCAL_HOMES.items.find((home) => home.id === id)?.name ?? null);
    expect({ order: connection.order, targets, advertised, localFor }).toEqual({
      order: ['open', 'local', 'open'],
      targets: ['h-local-only', 'h-shared'],
      advertised: ['Local GPU', 'Local Paper'],
      localFor: ['Local GPU', 'Local Paper'],
    });
  });

  it('keeps current-home selection actionable remotely and commits local before management', async () => {
    connection.sshLabel = 'example-remote';
    list.mockResolvedValue(TWO);
    connection.activateLocal.mockImplementation(() => { connection.order.push('local'); });
    host.openSpace.mockImplementation(async () => { connection.order.push('open'); });
    await render();
    const open = async () => act(async () => { document.querySelector<HTMLButtonElement>('[data-space-remote]')!.click(); });
    await open();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switch-item="main"]')!.click(); });
    expect(connection.order).toEqual(['local']);
    expect(host.openSpace).not.toHaveBeenCalled();
    await open();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switch-item="h-b"]')!.click(); });
    expect(connection.order).toEqual(['local', 'open', 'local']);
    await open();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-manage]')!.click(); });
    expect(navigate).toHaveBeenCalledWith('/settings/spaces');
    const managementCall = navigate.mock.calls.findIndex(([target]) => target === '/settings/spaces');
    expect(managementCall).toBeGreaterThanOrEqual(0);
    expect(connection.activateLocal.mock.invocationCallOrder.at(-1)).toBeLessThan(navigate.mock.invocationCallOrder[managementCall]!);
  });

  it('does not guess a main ID while local control is unavailable and resumes after recovery', async () => {
    connection.sshLabel = 'example-remote';
    connection.localClient = null;
    connection.client = { klient: { rest: { homes: { list: vi.fn().mockResolvedValue(REMOTE_HOMES) } } } };
    list.mockResolvedValue(LOCAL_HOMES);
    const view = await render();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-remote]')!.click(); });
    expect(document.querySelector('[data-space-directory-pending]')?.textContent).toContain('Loading');
    expect(document.querySelectorAll('[data-space-switch-item]')).toHaveLength(0);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', ctrlKey: true, altKey: true })); });
    expect(host.openSpace).not.toHaveBeenCalled();
    connection.localClient = defaultClient;
    await view.rerender();
    expect(document.querySelector('[data-space-directory-pending]')).toBeNull();
    expect(document.querySelector('[data-space-switch-item="h-local-only"]')?.textContent).toContain('Local GPU');
  });

  it('isolates local and remote query caches through rapid switches and a late remote response', async () => {
    let finish!: (value: typeof REMOTE_HOMES) => void;
    const remoteList = vi.fn(() => new Promise<typeof REMOTE_HOMES>((resolve) => { finish = resolve; }));
    const remoteClient = { klient: { rest: { homes: { list: remoteList } } } };
    list.mockResolvedValue(LOCAL_HOMES);
    connection.sshLabel = 'example-remote';
    connection.client = remoteClient;
    const view = await render(true);
    connection.client = defaultClient;
    connection.sshLabel = null;
    await view.rerender();
    expect(document.querySelector('[data-domain-query]')?.textContent).toContain('Local GPU');
    await act(async () => { finish(REMOTE_HOMES); });
    await view.rerender();
    expect(document.querySelector('[data-domain-query]')?.textContent).not.toContain('Remote');
    connection.client = remoteClient;
    connection.sshLabel = 'example-remote';
    await view.rerender();
    expect(document.querySelector('[data-domain-query]')?.textContent).toContain('Remote ACME');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-remote]')!.click(); });
    expect(document.querySelector('[data-space-switcher-menu]')?.textContent).toContain('Local GPU');
    expect(document.querySelector('[data-space-switcher-menu]')?.textContent).not.toContain('Remote ACME');
    expect(remoteList).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('does not reuse old local directory data after the control client is replaced', async () => {
    let finish!: (value: typeof LOCAL_HOMES) => void;
    const oldList = vi.fn(() => new Promise<typeof LOCAL_HOMES>((resolve) => { finish = resolve; }));
    connection.localClient = { klient: { rest: { homes: { list: oldList } } } };
    const view = await render();
    list.mockResolvedValue(TWO);
    connection.localClient = defaultClient;
    await view.rerender();
    await act(async () => { finish(LOCAL_HOMES); });
    await view.rerender();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
    expect(document.querySelector('[data-space-switch-item="h-a"]')?.textContent).toContain('ACME');
    expect(document.querySelector('[data-space-switch-item="h-local-only"]')).toBeNull();
  });

  it('never turns browser/extension server homes into local desktop targets', async () => {
    host.kind = 'browser';
    connection.sshLabel = 'example-remote';
    list.mockResolvedValue(REMOTE_HOMES);
    await render();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-remote]')!.click(); });
    expect(document.querySelectorAll('[data-space-switch-item]')).toHaveLength(0);
    expect(list).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', ctrlKey: true, altKey: true })); });
    expect(host.openSpace).not.toHaveBeenCalled();
    expect(connection.activateLocal).not.toHaveBeenCalled();
  });

  it('keeps windows mode status quiet and uses openSpace without changing its local target', async () => {
    writeDesktopPrefs({ windowMode: 'windows' });
    list.mockResolvedValue(TWO);
    await render();
    expect(document.querySelector('[data-space-switcher-pending]')).toBeNull();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
    expect(document.querySelector('[data-space-switch-item="h-a"]')?.textContent).toContain('Open window');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switch-item="h-a"]')!.click(); });
    expect(host.openSpace).toHaveBeenCalledExactlyOnceWith('h-a');
    expect(connection.activateLocal).not.toHaveBeenCalled();
  });

  it('suppresses duplicate opens while entering and allows retry after a failed native open', async () => {
    let fail!: (error: Error) => void;
    host.openSpace.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    list.mockResolvedValue(TWO);
    await render();
    const press = () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', ctrlKey: true, altKey: true }));
    await act(async () => { press(); press(); });
    expect(host.openSpace).toHaveBeenCalledTimes(1);
    await act(async () => { fail(new Error('backend unavailable')); });
    await act(async () => { press(); });
    expect(host.openSpace).toHaveBeenCalledTimes(2);
  });

  it('guards shortcut side effects and rejects a queued target after local client replacement', async () => {
    connection.sshLabel = 'example-remote';
    connection.guardActions = true;
    list.mockResolvedValue(TWO);
    const view = await render();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', ctrlKey: true, altKey: true })); });
    expect(connection.activateLocal).not.toHaveBeenCalled();
    expect(host.openSpace).not.toHaveBeenCalled();
    connection.localClient = { klient: { rest: { homes: { list: vi.fn().mockResolvedValue(LOCAL_HOMES) } } } };
    await view.rerender();
    await act(async () => {
      await expect(Promise.resolve().then(() => connection.pendingAction!())).rejects.toMatchObject({ name: 'AbortError', message: 'Space entry was superseded.' });
    });
    expect(connection.activateLocal).not.toHaveBeenCalled();
    expect(host.openSpace).not.toHaveBeenCalled();
  });
});
