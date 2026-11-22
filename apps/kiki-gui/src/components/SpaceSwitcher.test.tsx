// @vitest-environment jsdom

/**
 * Two-Tier SpaceScopeControl + SpaceSwitchSheet tests:
 *   - Window identity = local Kiki home (`Main space` or a local subspace).
 *   - Paired remote computers = pure 0ms sidebar view filters (`layoutPrefs.spaceScope`),
 *     never hijacking the root window connection or displaying `Another space`.
 *   - Subtraction-first popover: zero `⌃⌥` badges, zero `Ctrl+Alt+0..9` hijack,
 *     zero `Open window` inline text, zero defensive boundary prose, and metadata
 *     strictly in `title` / `aria-label`.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureSpaceStorage } from '@kiki/session-core/storage';
import { readLayoutPreferences, resetLayoutPreferencesForTests, writeDesktopPrefs, writeLayoutPreferences } from '@kiki/session-core/settings';

import { I18nProvider } from '../i18n';
import { PhoneRemoteSpaceLine } from './PageChrome';
import { SpaceSwitcher } from './SpaceSwitcher';
import { useConnection } from '../state/connection';
import { resetLaunchWindowMode, useSpaces } from '../lib/spaces';
import { registerScopeNavigation } from '../lib/navScope';

const list = vi.fn();
const defaultClient = { klient: { rest: { homes: { list } } } };
const host = {
  kind: 'tauri' as 'tauri' | 'browser',
  spaceStatuses: vi.fn(),
  openSpace: vi.fn(async (): Promise<void> => undefined),
  openDesktopLogDirectory: vi.fn(async (): Promise<void> => undefined),
};
const navigate = vi.fn();

const connection = vi.hoisted(() => ({
  sshLabel: null as string | null,
  connectionId: null as string | null,
  connectionSource: null as string | null,
  spaceKey: 'main' as string,
  localSpaceKey: 'main' as string,
  localScopeId: 'local' as string,
  wsStatus: 'open' as 'open' | 'connecting' | 'closed',
  wsBannerSuppressed: false,
  meta: { server_home_id: 'local-home-uuid' } as { server_home_id?: string },
  activateLocal: vi.fn(),
  restoreLocal: vi.fn<(...args: [AbortSignal?]) => Promise<void>>(),
  order: [] as string[],
  client: null as { klient: { rest: { homes: { list: unknown }; connections?: unknown } }; baseUrl?: string } | null,
  localClient: undefined as { klient: { rest: { homes: { list: unknown }; connections?: unknown } }; baseUrl?: string } | null | undefined,
  pendingAction: null as (() => void | Promise<void>) | null,
  guardActions: false,
}));

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

vi.mock('../state/connection', () => {
  const read = () => ({
    client: connection.client ?? defaultClient,
    localClient: connection.localClient === undefined ? defaultClient : connection.localClient,
    sshLabel: connection.sshLabel,
    connectionId: connection.connectionId,
    connectionSource: connection.connectionSource,
    spaceKey: connection.spaceKey,
    localSpaceKey: connection.localSpaceKey,
    localScopeId: connection.localScopeId,
    wsStatus: connection.wsStatus,
    wsBannerSuppressed: connection.wsBannerSuppressed,
    meta: connection.meta,
    activateLocal: connection.activateLocal,
    restoreLocal: connection.restoreLocal,
    scopeAdapter: {
      prepare: async (scope: { homeId: string; scopeId: string }, signal: AbortSignal) => ({
        scope,
        validate: async () => { signal.throwIfAborted(); },
        commit: async () => { signal.throwIfAborted(); connection.activateLocal(); },
        dispose: async () => {},
      }),
    },
  });
  return {
    useConnection: read,
    useOptionalConnection: read,
  };
});
vi.mock('../host', () => ({ useHost: () => host }));
vi.mock('./dirtyGuard', () => ({
  useGuardedNavigate: () => navigate,
  useDirtyGuard: () => ({
    runAction: (action: () => void | Promise<void>, target?: string) => {
      const execute = () => {
        const result = action();
        const go = () => { if (target !== undefined) navigate(target); };
        if (result !== undefined) return result.then(go);
        go();
      };
      if (connection.guardActions) connection.pendingAction = execute;
      else return execute();
    },
  }),
}));

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
const roots: Root[] = [];
beforeAll(() => { vi.stubGlobal('navigator', { language: 'en-US' }); env.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { env.IS_REACT_ACT_ENVIRONMENT = false; vi.unstubAllGlobals(); });
beforeEach(() => {
  list.mockReset();
  localStorage.removeItem('kiki.layout');
  resetLayoutPreferencesForTests();
  resetLaunchWindowMode();
  writeDesktopPrefs({ windowMode: 'windows' });
  host.openSpace.mockReset().mockResolvedValue(undefined);
  navigate.mockClear();
  connection.sshLabel = null;
  connection.connectionId = null;
  connection.connectionSource = null;
  connection.spaceKey = 'main';
  connection.localSpaceKey = 'main';
  connection.localScopeId = 'local';
  connection.wsStatus = 'open';
  connection.wsBannerSuppressed = false;
  connection.meta = { server_home_id: 'local-home-uuid' };
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

const TWO = {
  items: [
    { id: 'main', name: 'Main space', path: 'C:/k', primary: true },
    { id: 'h-a', name: 'ACME', color: '#295c58', path: 'D:/a', primary: false },
    { id: 'h-b', name: 'Paper', path: 'D:/b', primary: false },
  ],
};

describe('SpaceSwitcher (Two-Tier subtraction-first)', () => {
  it('renders only the clean kiki. wordmark at rest in default single-computer main space and keeps the menu free of defensive prose', async () => {
    list.mockResolvedValue({ items: [TWO.items[0]] });
    await render();
    const trigger = document.querySelector<HTMLButtonElement>('[data-space-switcher="main"]');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.textContent).toBe('kiki');
    expect(trigger?.querySelector('[data-space-dot]')).toBeNull();
    expect(trigger?.querySelector('[data-space-switcher-name]')).toBeNull();
    expect(trigger?.querySelector('[data-space-switcher-subtitle]')).toBeNull();
    expect(document.querySelector('[data-space-scope-clear]')).toBeNull();

    await act(async () => { trigger!.click(); });
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    const menu = document.querySelector('[data-space-switcher-menu]')!;
    expect(menu.textContent).not.toContain('⌃⌥');
    expect(menu.textContent).not.toContain('Another space');
    expect(menu.textContent).not.toContain('Open window');
    expect(document.querySelector('[data-space-single-hint]')).toBeNull();
    expect(document.querySelector('[data-space-browser-hint]')).toBeNull();
    expect(document.querySelector('[data-space-new-entry]')).toBeNull();
    expect(document.querySelector('[data-space-pair-entry]')?.textContent).toContain('Pair a computer');
    expect(document.querySelector('[data-space-manage]')?.textContent).toContain('Spaces & pairing');
  });

  it('still offers retry and management when the server cannot list local spaces', async () => {
    list.mockRejectedValue(new Error('404'));
    await render();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
    expect(document.querySelector('[data-space-local-error]')?.textContent).toContain('Couldn\u2019t read this list.');
    expect(document.querySelector('[data-space-manage]')).not.toBeNull();
  });

  it('shows local Spaces group with pending badge pill and quiet running dot in switch mode without verbose labels', async () => {
    writeDesktopPrefs({ windowMode: 'switch' });
    const scopeNavigate = vi.fn(async () => undefined);
    const unregister = registerScopeNavigation(scopeNavigate);
    try {
      list.mockResolvedValue(TWO);
      await render();
      expect(document.querySelector('[data-space-switcher-pending]')?.textContent).toBe('2');
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
      expect(document.querySelector('[data-space-group-spaces]')?.textContent).toBe('Spaces');
      expect(document.querySelector('[data-space-switch-item="main"]')?.getAttribute('data-space-state')).toBe('current');
      expect(document.querySelector('[data-space-switch-item="h-a"]')?.getAttribute('data-space-state')).toBe('hot');
      expect(document.querySelector('[data-space-switch-item="h-a"] [data-space-local-pending="2"]')?.textContent).toBe('2');
      expect(document.querySelector('[data-space-switch-item="h-b"]')?.getAttribute('data-space-state')).toBe('cold');
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switch-item="h-b"]')!.click(); });
      expect(scopeNavigate).toHaveBeenCalledExactlyOnceWith({ homeId: 'h-b', scopeId: 'local', inPlace: true });
      expect(host.openSpace).not.toHaveBeenCalled();
    } finally { unregister(); }
  });

  it('does NOT hijack Ctrl+Alt+0..9 keyboard shortcuts (preserving AltGr and UU Remote)', async () => {
    configureSpaceStorage({ homeId: 'h-a', name: 'ACME', color: '#295c58' });
    list.mockResolvedValue(TWO);
    await render();
    const trigger = document.querySelector<HTMLButtonElement>('[data-space-switcher="h-a"]')!;
    expect(trigger.querySelector('[data-space-switcher-name]')?.textContent).toBe('ACME');
    expect(trigger.querySelector('[data-space-dot]')).not.toBeNull();
    expect(trigger.getAttribute('aria-label')).toContain('kiki · ACME');

    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', ctrlKey: true, altKey: true })); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit0', ctrlKey: true, altKey: true })); });
    expect(host.openSpace).not.toHaveBeenCalled();
  });

  it('uses pure 0ms sidebar filter for paired remote computers without calling requestScopeNavigation or mutating root connection', async () => {
    const macId = '11111111-1111-4111-8111-111111111111';
    const gpuId = '22222222-2222-4222-8222-222222222222';
    const selfLoopId = '33333333-3333-4333-8333-333333333333';
    const connectionsList = vi.fn().mockResolvedValue([
      {
        id: macId,
        label: 'MacBook Air',
        endpoint: 'http://192.0.2.10:59001',
        target: { homeId: 'mac-home', hostId: 'host-mac', protocol: 1 },
        credentialRef: macId,
        enabled: true,
        purposes: ['gui'],
        backgroundSummary: true,
        state: 'online',
        activeLeases: 0,
        rttMs: 38,
        summary: {
          value: { online: true, busy_sessions: 1, needs_you_sessions: 2, revision: 'r1', as_of: Date.now(), platform: 'darwin' },
          lastSeen: Date.now(),
          stale: false,
        },
      },
      {
        id: gpuId,
        label: 'Dorm 3090',
        endpoint: 'http://192.0.2.11:59001',
        target: { homeId: 'gpu-home', hostId: 'host-gpu', protocol: 1 },
        credentialRef: gpuId,
        enabled: true,
        purposes: ['gui'],
        backgroundSummary: true,
        state: 'offline',
        activeLeases: 0,
        rttMs: 10,
        summary: {
          value: { online: false, busy_sessions: 0, needs_you_sessions: 0, revision: 'r1', as_of: Date.now() - 120_000, platform: 'win32' },
          lastSeen: Date.now() - 120_000,
          stale: true,
        },
      },
      // Self-loop record pointing back to this local server_home_id must be filtered out!
      {
        id: selfLoopId,
        label: 'Self Loopback',
        endpoint: 'http://127.0.0.1:58627',
        target: { homeId: 'local-home-uuid', hostId: 'host-self', protocol: 1 },
        credentialRef: selfLoopId,
        enabled: true,
        purposes: ['gui'],
        backgroundSummary: true,
        state: 'online',
        activeLeases: 0,
      },
    ]);
    list.mockResolvedValue(TWO);
    const localWithConnections = {
      baseUrl: 'http://127.0.0.1:58627',
      klient: { rest: { homes: { list }, connections: { list: connectionsList } } },
    };
    connection.client = localWithConnections;
    connection.localClient = localWithConnections;

    const scopeNavigate = vi.fn(async () => undefined);
    const unregister = registerScopeNavigation(scopeNavigate);
    try {
      await render();
      // Default scope shows quiet `All computers` capsule + degraded dot (Dorm 3090 offline).
      expect(document.querySelector('[data-space-scope-pill="all"]')?.textContent).toContain('All computers');
      expect(document.querySelector('[data-space-scope-degraded]')).not.toBeNull();
      expect(document.querySelector('[data-space-scope-clear]')).toBeNull();

      const callsBeforeOpen = connectionsList.mock.calls.length;
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
      await act(async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(connectionsList.mock.calls.length).toBeGreaterThan(callsBeforeOpen);

      const menu = document.querySelector('[data-space-switcher-menu]')!;
      // Zero clutter / zero shortcuts / zero defensive prose / zero self-loop.
      expect(menu.textContent).not.toContain('⌃⌥');
      expect(menu.textContent).not.toContain('Another space');
      expect(menu.textContent).not.toContain('Open window');
      expect(menu.textContent).not.toContain('Current');
      expect(menu.textContent).not.toContain('Self Loopback');
      expect(document.querySelector(`[data-space-remote-item="${selfLoopId}"]`)).toBeNull();

      // Single-line remote row: label + needs-you pill; telemetry strictly in `title`.
      const macRow = document.querySelector<HTMLButtonElement>(`[data-space-remote-item="${macId}"]`)!;
      expect(macRow.textContent).toBe('MacBook Air2');
      expect(macRow.getAttribute('title')).toContain('macOS');
      expect(macRow.getAttribute('title')).toContain('38 ms');
      expect(macRow.querySelector('[data-space-remote-needs="2"]')).not.toBeNull();

      const gpuRow = document.querySelector<HTMLButtonElement>(`[data-space-remote-item="${gpuId}"]`)!;
      expect(gpuRow.textContent).toBe('Dorm 3090');
      expect(gpuRow.getAttribute('title')).toContain('Offline');

      // Clicking MacBook Air updates layoutPrefs.spaceScope in 0ms without scope navigation!
      await act(async () => { macRow.click(); });
      expect(readLayoutPreferences().spaceScope).toBe(`remote:${macId}`);
      expect(scopeNavigate).not.toHaveBeenCalled();
      expect(document.querySelector('[data-space-switcher-menu]')).toBeNull();
      expect(document.querySelector('[data-space-switcher-name]')?.textContent).toBe('MacBook Air');
      expect(document.querySelector('[data-space-scope-clear]')).toBeNull();

      // Reopen and switch to This computer -> 0ms filter.
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-computer-local]')!.click(); });
      expect(readLayoutPreferences().spaceScope).toBe('local:main');
      expect(document.querySelector('[data-space-switcher-name]')?.textContent).toBe('This computer');

      // Reopen and switch back to All computers -> 0ms filter.
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-scope-all]')!.click(); });
      expect(readLayoutPreferences().spaceScope).toBe('all');
      expect(scopeNavigate).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('keeps SSH remote back-to-local action and local space switching intact', async () => {
    connection.sshLabel = 'dev-server-gpu';
    list.mockResolvedValue(TWO);
    await render();
    const trigger = document.querySelector<HTMLElement>('[data-space-remote]');
    expect(trigger).not.toBeNull();
    expect(trigger?.querySelector('[data-space-switcher-name]')?.textContent).toBe('dev-server-gpu');
    expect(trigger?.querySelector('[data-space-switcher-subtitle]')?.textContent).toBe('Connected');

    await act(async () => { (trigger as HTMLButtonElement).click(); });
    expect(document.querySelector('[data-space-back-local]')?.textContent).toContain('Back to Main space');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-back-local]')!.click(); });
    expect(connection.activateLocal).toHaveBeenCalledTimes(1);
  });

  it('keeps windows mode quiet (icon-only open window) and uses openSpace for another local space', async () => {
    writeDesktopPrefs({ windowMode: 'windows' });
    list.mockResolvedValue(TWO);
    await render();
    expect(document.querySelector('[data-space-switcher-pending]')).toBeNull();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
    const acmeRow = document.querySelector<HTMLButtonElement>('[data-space-switch-item="h-a"]')!;
    expect(acmeRow.textContent).not.toContain('Open window');
    expect(acmeRow.getAttribute('title')).toContain('Open window');
    await act(async () => { acmeRow.click(); });
    expect(host.openSpace).toHaveBeenCalledExactlyOnceWith('h-a');
    expect(connection.activateLocal).not.toHaveBeenCalled();
  });

  it('renders inline recovery for paused/broken remote pairings and local space start failure', async () => {
    const connPaused = '55555555-5555-4555-8555-555555555555';
    const connIdentity = '44444444-4444-4444-8444-444444444444';
    const connNotApproved = '33333333-3333-4333-8333-333333333333';
    const setEnabled = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const records = [
      { id: connPaused, label: 'Epsilon Node', endpoint: 'http://127.0.0.1:59001', target: { homeId: connPaused, hostId: 'h1', protocol: 1 }, credentialRef: connPaused, enabled: false, purposes: ['gui'], backgroundSummary: true, state: 'disabled', activeLeases: 0 },
      { id: connIdentity, label: 'Delta Host', endpoint: 'http://127.0.0.1:59001', target: { homeId: connIdentity, hostId: 'h2', protocol: 1 }, credentialRef: connIdentity, enabled: true, purposes: ['gui'], backgroundSummary: true, state: 'identity_changed', activeLeases: 0 },
      { id: connNotApproved, label: 'Gamma Bench', endpoint: 'http://127.0.0.1:59001', target: { homeId: connNotApproved, hostId: 'h3', protocol: 1 }, credentialRef: connNotApproved, enabled: true, purposes: ['gui'], backgroundSummary: true, state: 'authentication_required', activeLeases: 0 },
    ];
    list.mockResolvedValue(TWO);
    connection.localClient = {
      baseUrl: 'http://127.0.0.1:58627',
      klient: { rest: { homes: { list }, connections: { list: vi.fn(async () => records), setEnabled, remove } } },
    };
    await render();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });

    await act(async () => { document.querySelector<HTMLButtonElement>(`[data-space-remote-item="${connIdentity}"]`)!.click(); });
    expect(document.querySelector('[data-space-row-failure="remote-identity-changed"]')?.textContent).toContain('Identity changed');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-row-action="remove"]')!.click(); });
    expect(remove).toHaveBeenCalledWith(connIdentity);

    await act(async () => { document.querySelector<HTMLButtonElement>(`[data-space-remote-item="${connPaused}"]`)!.click(); });
    expect(document.querySelector('[data-space-row-failure="remote-paused"]')?.textContent).toContain('Paused');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-row-action="turn-on"]')!.click(); });
    expect(setEnabled).toHaveBeenCalledWith(connPaused, true);
    expect(readLayoutPreferences().spaceScope).toBe(`remote:${connPaused}`);

    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
    host.openSpace.mockRejectedValueOnce(new Error('spawn failed'));
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switch-item="h-a"]')!.click(); });
    expect(document.querySelector('[data-space-row-failure="local-start"]')?.textContent).toContain('Couldn\u2019t start ACME');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-row-action="view-log"]')!.click(); });
    expect(host.openDesktopLogDirectory).toHaveBeenCalledTimes(1);
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
  });

  it('opens the unified 1-stop PairSheet from Pair a computer…', async () => {
    const localIdentity = { homeId: '11bb22cc-33dd-4ee5-8ff6-0011223344aa', hostId: 'this-machine', protocol: 1 as const };
    const tlsFingerprint = '0123456789abcdef'.repeat(4);
    const inbound = vi.fn().mockResolvedValue({ enabled: false, configuredEnabled: false, identity: localIdentity, grants: [] });
    const createPairCode = vi.fn().mockResolvedValue({
      code: 'K9F2-7X4M',
      expiresAt: Date.now() + 600_000,
      target: localIdentity,
      tlsFingerprint,
      suggestedEndpoints: ['http://192.168.10.20:58627'],
    });
    list.mockResolvedValue({ items: [TWO.items[0]] });
    connection.localClient = {
      klient: { rest: { homes: { list }, connections: { list: vi.fn().mockResolvedValue([]), pair: vi.fn(), inbound, createPairCode } } },
    };
    await render();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-pair-entry]')!.click(); });
    expect(document.querySelector('[data-pair-sheet="outbound"]')).not.toBeNull();
  });

  it('renders a bottom ActionSheet in phone touch mode', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(pointer: coarse) and (max-width: 639px)' || query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    host.kind = 'browser';
    list.mockResolvedValue(TWO);
    try {
      await render();
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
      expect(document.querySelector('.kiki-space-switch-sheet')).not.toBeNull();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('never exposes raw remote: keys or UUIDs in PhoneRemoteSpaceLine', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(pointer: coarse) and (max-width: 639px)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    try {
      const remoteConnId = '33333333-3333-4333-8333-333333333333';
      connection.connectionId = remoteConnId;
      connection.spaceKey = `remote:${remoteConnId}`;
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <I18nProvider>
              <PhoneRemoteSpaceLine />
            </I18nProvider>
          </QueryClientProvider>,
        );
      });
      await act(async () => { for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
      const line = container.querySelector('[data-phone-space-line]');
      expect(line?.textContent).not.toContain('remote:');
      expect(line?.textContent).not.toContain(remoteConnId);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
