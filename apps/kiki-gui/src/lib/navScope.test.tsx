// @vitest-environment jsdom
import { act, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createMemoryRouter, RouterProvider, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaResponse, RoomDocument, Session } from '@kiki/protocol';
import { RPCError } from '@kiki/klient';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { writeDesktopPrefs, type SpaceWindowMode } from '@kiki/session-core/settings';
import { resetLaunchWindowMode } from './spaces';
import { SpaceSwitcher } from '../components/SpaceSwitcher';
import type { HostAdapter, SshResolvedConnection } from '../host';
import type { ConnectionSelection } from '../state/connectionConfig';
import { configureSpaceStorage } from './spaceStorage';
import { API_CODES, ApiError, KikiClient } from './client';
import { createScopeConnectionAdapter, validateScopeRoute } from './navScopeConnection';
import { applyColdNavigationIntent, beginNavWindow, consumeScopeReload, markScopeReload, requestScopeNavigation, ScopeRestoreError, type ScopeConnectionAdapter } from './navScope';
import { canGoBack, clearNavHistory, getCurrentVisit, getVisitForLocation, recordNavigation, type NavScopeIdentity } from './navHistory';
import { readHomeViewRoute, writeSpaceViewRoute } from './spaceViewState';
import { useNavSnapshotAdapter } from './useNavSnapshot';
import { NavScopeBoundary, useScopeRestore, type ScopeRestoreValue } from '../components/NavScopeBoundary';
import { useDirtyGuard, useDirtyGuardState, type DirtyGuardState } from '../components/dirtyGuard';
import { useAwayNotifications } from './useAwayNotifications';

const injected = vi.hoisted(() => ({ connection: undefined as (() => unknown) | undefined, host: undefined as unknown }));
vi.mock('../state/connection', () => ({ useConnection: () => injected.connection!(), useOptionalConnection: () => injected.connection!() }));
vi.mock('../host', () => ({ useHost: () => injected.host }));
vi.mock('../i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key, tp: (key: string) => key }) }));

interface FixtureValue {
  scopeId: string; connectionRef?: string; client: KikiClient; meta: MetaResponse;
  scopeAdapter: ScopeConnectionAdapter; needsScopeReload: boolean;
  localClient: KikiClient; sshLabel: string | null;
  activateLocal(): void;
  restoreLocal(signal?: AbortSignal): Promise<void>;
}
const Context = createContext<FixtureValue | null>(null);
injected.connection = () => useContext(Context);
const token = 'a'.repeat(43);
const endpoints = { a: 'http://127.0.0.1:41001', b: 'http://127.0.0.1:41002', ssh: 'http://127.0.0.1:41003' };
const profile = { id: 'example', label: 'Example', target: { kind: 'alias' as const, alias: 'example' }, releaseChannel: 'stable' as const, remotePort: 58627, serverHomeId: 'server-ssh' };
const identity = (home: string): MetaResponse => ({ server_home_id: home, server_id: `instance-${home}`, server_version: '0.1.0', dangerous_bypass_auth: false,
  build_id: undefined, build_channel: 'stable', started_at: '2026-10-03T00:00:00Z', open_in_apps: [],
  capabilities: { websocket: true, file_upload: true, fs_query: true, mcp: true, tasks: true } });
const resolved: SshResolvedConnection = { config: { url: endpoints.ssh, token }, tunnelId: 'exact-tunnel', serverHomeId: 'server-ssh',
  serverInstanceId: 'instance-server-ssh', serverVersion: '0.1.0', buildId: null, buildChannel: 'stable' };
let root: Root | undefined;
let container: HTMLDivElement;
let recovery: ScopeRestoreValue | null = null;
let guard: DirtyGuardState | undefined;
let requests: string[];
let nativeHome: string;
let failure: string | null;
let referenceAlive: boolean;
let delay: Promise<void> | null;
let surfaceMounts: number;
let host: HostAdapter;
let adapter: ScopeConnectionAdapter;
let current: { scope: NavScopeIdentity; selection: ConnectionSelection; client: KikiClient };
let reloads: number;
let nativeReloadReference: boolean;
let entityFailures: Map<string, unknown>;
let entityDelays: Map<string, Promise<void>>;
let withSpaceSwitcher = false;
let withAwayNotifications = false;
let withControlledReload = false;
let onReloadRequested: (() => void) | undefined;

function localSelection(home: string): ConnectionSelection {
  return { config: { url: home === 'home-b' ? endpoints.b : endpoints.a, token: 'fixture-local-token' }, persist: false, source: 'desktop', scopeId: 'local' };
}
function newClient(selection: ConnectionSelection): KikiClient {
  const client = new KikiClient({ baseUrl: selection.config.url, token: selection.config.token });
  vi.spyOn(client.klient.rest!.homes, 'list').mockResolvedValue({ items: [
    { id: 'main', name: 'Main', path: 'C:/fixture-a', primary: true },
    { id: 'home-b', name: 'B', path: 'C:/fixture-b', primary: false },
  ] } as never);
  vi.spyOn(client.klient.rest!.rooms, 'get').mockImplementation(async (id) => {
    const key = `${client.baseUrl}/api/rooms/${id}`; requests.push(key);
    await entityDelays.get(key);
    if (entityFailures.has(key)) throw entityFailures.get(key);
    return { id } as RoomDocument;
  });
  return client;
}
function metaFor(client: KikiClient): MetaResponse { return identity(client.baseUrl === endpoints.ssh ? 'server-ssh' : client.baseUrl === endpoints.b ? 'server-b' : 'server-a'); }

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); clearNavHistory();
  window.history.replaceState(null, '', '/new');
  configureSpaceStorage({ homeId: 'home-a' });
  requests = []; nativeHome = 'home-a'; failure = null; referenceAlive = true; delay = null; surfaceMounts = 0; reloads = 0;
  recovery = null; guard = undefined; nativeReloadReference = false; entityFailures = new Map(); entityDelays = new Map();
  withSpaceSwitcher = false; withAwayNotifications = false; withControlledReload = false; onReloadRequested = undefined; resetLaunchWindowMode();
  vi.spyOn(KikiClient.prototype, 'meta').mockImplementation(async function (this: KikiClient) {
    requests.push(`${this.baseUrl}/api/meta`);
    await delay;
    if (failure === 'offline') throw new Error('isolated backend offline');
    if (failure === 'identity-mismatch') return identity('wrong-server');
    return metaFor(this);
  });
  vi.spyOn(KikiClient.prototype, 'getSession').mockImplementation(async function (this: KikiClient, id) {
    const key = `${this.baseUrl}/api/sessions/${id}`; requests.push(key);
    await entityDelays.get(key);
    if (entityFailures.has(key)) throw entityFailures.get(key);
    if (failure === 'entity-offline') throw new Error('isolated entity offline');
    return { id, title: `${this.baseUrl}:${id}` } as Session;
  });
  host = { kind: 'tauri', connection: {
    discover: vi.fn(async () => ({ config: localSelection(nativeHome).config, persist: false })),
    listSshProfiles: vi.fn(async () => failure === 'scope-invalid' ? [] : [profile]),
    prepareSshProfile: vi.fn(async () => {
      if (failure === 'auth-required') throw new ScopeRestoreError('auth-required');
      if (failure === 'native-auth') throw new Error('SSH server rejected the bearer token');
      if (failure === 'native-identity') throw new Error('SSH server home identity does not match');
      return resolved;
    }),
    resumeScopeConnection: vi.fn(async (home, id, tunnel) => {
      if (!referenceAlive || home !== 'home-a' || id !== profile.id || tunnel !== resolved.tunnelId) throw new Error('reference expired');
      return { profile, connection: resolved };
    }),
    commitScopeConnection: vi.fn(async (_home, _id, _tunnel, reload) => { nativeReloadReference = reload; }), disconnectSshProfile: vi.fn(async () => {}),
  }, prepareSpace: vi.fn(async (home) => { nativeHome = home; return { homeId: home }; }),
  switchSpace: vi.fn(async () => {}),
  openSpace: vi.fn(async () => {}),
  spaceStatuses: vi.fn(async () => []),
  onNotificationClick: vi.fn(() => () => {}),
  } as unknown as HostAdapter;
  injected.host = host;
  const selection = localSelection('home-a');
  current = { scope: { homeId: 'home-a', scopeId: 'local', serverHomeId: 'server-a' }, selection, client: newClient(selection) };
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => {
  await act(async () => { root?.unmount(); }); root = undefined;
  container.remove(); configureSpaceStorage(null); vi.restoreAllMocks();
});

function Fixture({ children }: { children: ReactNode }) {
  const [value, setValue] = useState(() => ({ scopeId: current.scope.scopeId, connectionRef: current.scope.connectionRef,
    client: current.client, meta: metaFor(current.client) }));
  const [needsScopeReload, setNeedsScopeReload] = useState(false);
  const currentRef = useRef(current); currentRef.current = current;
  adapter = useMemo(() => createScopeConnectionAdapter({ host,
    active: () => currentRef.current,
    local: () => {
      const selection = localSelection(currentRef.current.scope.homeId);
      return { selection, client: currentRef.current.scope.scopeId === 'local' ? currentRef.current.client : newClient(selection) };
    },
    createClient: newClient,
    commit: (selection, client, meta) => {
      current = { scope: { homeId: nativeHome, scopeId: selection.scopeId ?? 'local', serverHomeId: meta.server_home_id,
        connectionRef: selection.source === 'ssh' ? selection.tunnelId : undefined }, selection, client };
      setValue({ scopeId: current.scope.scopeId, connectionRef: current.scope.connectionRef, client, meta });
    },
    reload: () => {
      reloads += 1;
      if (withControlledReload) {
        // Production first requests a reload while the source scope is still
        // active. Flush that real intermediate render before Router commit.
        flushSync(() => { setNeedsScopeReload(true); });
        onReloadRequested?.();
        return;
      }
      // The host seam simulates the verified desktop rediscovery after controlled
      // reload; serialization/window boundaries are independently checked below.
      const ssh = nativeReloadReference;
      nativeReloadReference = false;
      const selection: ConnectionSelection = ssh ? { ...resolved, config: resolved.config, persist: false, source: 'ssh', scopeId: `ssh:${profile.id}`, profile,
        tunnelId: resolved.tunnelId } : localSelection(nativeHome);
      const client = newClient(selection); const meta = metaFor(client);
      current = { scope: { homeId: nativeHome, scopeId: selection.scopeId ?? 'local', serverHomeId: meta.server_home_id,
        connectionRef: ssh ? resolved.tunnelId : undefined }, selection, client };
      configureSpaceStorage({ homeId: nativeHome });
      setValue({ scopeId: current.scope.scopeId, connectionRef: current.scope.connectionRef, client, meta });
    },
  }), []);
  const queryClient = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), []);
  const context: FixtureValue = { ...value, scopeAdapter: adapter, needsScopeReload,
    localClient: value.client, sshLabel: value.scopeId.startsWith('ssh:') ? 'Remote' : null,
    activateLocal: () => { void requestScopeNavigation({ scopeId: 'local' }).catch(() => {}); },
    restoreLocal: async (signal = new AbortController().signal) => {
      const prepared = await adapter.prepare({ homeId: current.scope.homeId, scopeId: 'local' }, signal);
      try { await prepared.commit(); } catch (error) { await prepared.dispose(); throw error; }
    },
  };
  return <Context.Provider value={context}><QueryClientProvider client={queryClient}><NavScopeBoundary>{children}</NavScopeBoundary></QueryClientProvider></Context.Provider>;
}
function ShellNotificationListener() {
  useAwayNotifications({ host, sessions: [], listSessions: async () => [] });
  return null;
}
function Surface() {
  const connection = useContext(Context)!;
  const location = useLocation(); const action = useNavigationType();
  recovery = useScopeRestore();
  guard = useDirtyGuardState(location, () => {});
  const dirty = useDirtyGuard();
  const [buffer, setBuffer] = useState('source-buffer');
  const [anchor, setAnchor] = useState('initial-anchor');
  const anchorRef = useRef(anchor); anchorRef.current = anchor;
  useLayoutEffect(() => {
    recordNavigation({ location, scope: current.scope, action });
  }, [location, action, connection.scopeId]);
  useNavSnapshotAdapter('timeline:["shared","main"]', {
    capture: () => ({ anchor: { key: anchorRef.current, offset: 12, atEnd: false }, openFolds: [] }),
    restore: (snapshot: { anchor: { key: string } }) => { setAnchor(snapshot.anchor.key); },
  });
  useEffect(() => { surfaceMounts += 1; }, []);
  useEffect(() => {
    const id = /^\/s\/([^/]+)/.exec(location.pathname)?.[1];
    if (id) void connection.client.getSession(id).catch(() => {});
  }, [connection.client, location.pathname]);
  return <div data-surface data-scope={connection.scopeId} data-anchor={anchor}>
    <input data-buffer value={buffer} onChange={(event) => { setBuffer(event.target.value); }} />
    <button data-read onClick={() => { setAnchor('old-source-anchor'); }}>Read old</button>
    <button data-dirty onClick={() => { dirty?.reportDirty('editor', true); }}>Dirty</button>
    {withSpaceSwitcher ? <SpaceSwitcher /> : null}
    {withAwayNotifications ? <ShellNotificationListener /> : null}
  </div>;
}
async function mount(initial = '/s/shared') {
  root = createRoot(container);
  const router = createMemoryRouter([{ path: '*', element: <Fixture><Surface /></Fixture> }], { initialEntries: [initial] });
  await act(async () => { root!.render(<RouterProvider router={router} />); });
  return router;
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
function sessionRequests() { return requests.filter((request) => request.includes('/sessions/')); }

 describe('N3 Router and actual scope connection adapter', () => {
  it.each(['/settings/spaces', '/new'])('controlled reload from %s waits for the target Router scope and route, keeping the accepted identity', async (initial) => {
    withControlledReload = true;
    const router = await mount(initial);
    const sourceKey = router.state.location.key;
    const sourceVisit = getCurrentVisit()!.visitId;
    const sourceElement = container.querySelector('[data-surface]');
    let beforeCommit: { key: string; visit: string | undefined; switches: number; element: Element | null } | undefined;
    const switched: { key: string; route: string; homeId: string | undefined; serverHomeId: string | undefined }[] = [];
    onReloadRequested = () => {
      beforeCommit = { key: router.state.location.key, visit: getCurrentVisit()?.visitId,
        switches: vi.mocked(host.switchSpace!).mock.calls.length, element: container.querySelector('[data-surface]') };
    };
    vi.mocked(host.switchSpace!).mockImplementation(async () => {
      switched.push({ key: router.state.location.key, route: router.state.location.pathname,
        homeId: router.state.location.state?.kikiNav?.scope?.homeId, serverHomeId: getCurrentVisit()?.scope.serverHomeId });
    });
    await act(async () => { await requestScopeNavigation({ homeId: 'home-b', route: '/new' }); });
    await flush();
    expect(beforeCommit).toEqual({ key: sourceKey, visit: sourceVisit, switches: 0, element: sourceElement });
    expect(host.prepareSpace).toHaveBeenCalledExactlyOnceWith('home-b');
    expect(host.switchSpace).toHaveBeenCalledExactlyOnceWith('home-b');
    expect(router.state.location.key).not.toBe(sourceKey);
    expect(switched).toEqual([{ key: router.state.location.key, route: '/new', homeId: 'home-b', serverHomeId: 'server-b' }]);
    expect(JSON.parse(sessionStorage.getItem('kiki.navScopeHandoff.v1')!)).toEqual({
      route: '/new', key: router.state.location.key, scope: { homeId: 'home-b', scopeId: 'local', serverHomeId: 'server-b' },
    });
    expect(current.scope.homeId).toBe('home-a'); // The target is not mounted before actual desktop reload.
    expect(container.querySelector('[data-surface]')).toBeNull();
    expect(sessionRequests()).toEqual([]);
  });

  it('A/B identical IDs never reach the other endpoint; Back restores the original A visit, not A-last-view', async () => {
    const router = await mount();
    const sourceVisit = getCurrentVisit()!.visitId;
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-read]')!.click(); });
    localStorage.setItem('kiki.space.home-b.kiki.viewRoute', JSON.stringify({ local: '/usage?range=week' }));
    writeSpaceViewRoute('/s/newer-a');
    await act(async () => { await requestScopeNavigation({ homeId: 'home-b' }); });
    await flush();
    expect(router.state.location.pathname).toBe('/usage'); expect(router.state.location.search).toBe('?range=week');
    await act(async () => { await router.navigate('/s/shared'); });
    await act(async () => { await router.navigate(-1); });
    await act(async () => { await router.navigate(-1); }); await flush();
    expect(router.state.location.pathname).toBe('/s/shared');
    expect(current.scope.homeId).toBe('home-a'); expect(getCurrentVisit()!.visitId).toBe(sourceVisit);
    expect(container.querySelector('[data-anchor]')?.getAttribute('data-anchor')).toBe('old-source-anchor');
    expect(sessionRequests()).toEqual([`${endpoints.a}/api/sessions/shared`, `${endpoints.b}/api/sessions/shared`, `${endpoints.a}/api/sessions/shared`, `${endpoints.a}/api/sessions/shared`]);
    expect(sessionRequests()).not.toContain(`${endpoints.b}/api/sessions/newer-a`);
    expect(reloads).toBe(2);
  });

  it.each(['offline', 'entity-offline', 'identity-mismatch'])('failed %s traversal keeps Router cursor, scope and the source editor, then retry restores', async (reason) => {
    const router = await mount();
    await act(async () => { await requestScopeNavigation({ homeId: 'home-b', route: '/s/b-only' }); }); await flush();
    const source = router.state.location; const visit = getCurrentVisit()!.visitId;
    const sourceDom = container.querySelector('[data-buffer]'); const mounts = surfaceMounts;
    failure = reason;
    await act(async () => { await router.navigate(-1); }); await flush();
    expect(router.state.location.key).toBe(source.key); expect(getCurrentVisit()!.visitId).toBe(visit);
    expect(current.scope.homeId).toBe('home-b'); expect(nativeHome).toBe('home-b');
    expect(container.querySelector('[data-buffer]')).toBe(sourceDom); expect(surfaceMounts).toBe(mounts);
    expect(recovery!.state.phase).toBe('failed');
    expect(sessionRequests()).not.toContain(`${endpoints.b}/api/sessions/shared`);
    failure = null;
    await act(async () => { recovery!.retry(); }); await flush();
    expect(router.state.location.pathname).toBe('/s/shared'); expect(current.scope.homeId).toBe('home-a');
  });

  it('dirty scope action waits for the same confirmation seat; cancel never stages or remounts source', async () => {
    const router = await mount();
    const input = container.querySelector('[data-buffer]');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-dirty]')!.click(); });
    await act(async () => { await requestScopeNavigation({ homeId: 'home-b' }); });
    expect(guard!.pending).toBe(true); expect(host.prepareSpace).not.toHaveBeenCalled();
    await act(async () => { guard!.cancel(); });
    expect(router.state.location.pathname).toBe('/s/shared'); expect(container.querySelector('[data-buffer]')).toBe(input);
    expect(guard!.value.dirty).toBe(true);
    await act(async () => { await requestScopeNavigation({ homeId: 'home-b' }); await guard!.confirm(); }); await flush();
    expect(current.scope.homeId).toBe('home-b'); expect(router.state.location.pathname).toBe('/new');
  });

  it('cancels a delayed staged handshake without committing the traversal or querying a wrong entity', async () => {
    const router = await mount();
    await act(async () => { await requestScopeNavigation({ homeId: 'home-b', route: '/usage' }); });
    let release!: () => void; delay = new Promise<void>((resolve) => { release = resolve; });
    const before = router.state.location.key;
    await act(async () => { await router.navigate(-1); });
    await act(async () => { recovery!.cancel(); release(); }); await flush();
    expect(router.state.location.key).toBe(before); expect(current.scope.homeId).toBe('home-b'); expect(nativeHome).toBe('home-b');
    expect(sessionRequests()).not.toContain(`${endpoints.b}/api/sessions/shared`);
    expect(canGoBack()).toBe(true);
  });

  it('A-SSH → B-local → Back reuses only the exact live native reference, with no new token handoff', async () => {
    const router = await mount();
    await act(async () => { await requestScopeNavigation({ scopeId: 'ssh:example', route: '/s/shared', token }); }); await flush();
    const sshVisit = getCurrentVisit()!.visitId;
    await act(async () => { await requestScopeNavigation({ homeId: 'home-b', route: '/usage' }); }); await flush();
    await act(async () => { await router.navigate(-1); }); await flush();
    expect(current.scope).toMatchObject({ homeId: 'home-a', scopeId: 'ssh:example', connectionRef: 'exact-tunnel' });
    expect(getCurrentVisit()!.visitId).toBe(sshVisit);
    expect(host.connection.prepareSshProfile).toHaveBeenCalledTimes(1);
    expect(host.connection.resumeScopeConnection).toHaveBeenCalledWith('home-a', 'example', 'exact-tunnel');
    expect(sessionStorage.getItem('kiki.navHistory.v1')).not.toContain(token);
    expect(sessionRequests()).not.toContain(`${endpoints.b}/api/sessions/shared`);
  });

  it.each(['auth-required', 'scope-invalid'])('expired SSH reference/profile remains %s without committing Back; explicit retry can recover', async (reason) => {
    const router = await mount();
    await act(async () => { await requestScopeNavigation({ scopeId: 'ssh:example', route: '/s/shared', token }); });
    await act(async () => { await requestScopeNavigation({ scopeId: 'local', route: '/usage' }); }); await flush();
    const before = router.state.location.key;
    referenceAlive = false; failure = reason === 'scope-invalid' ? reason : null;
    await act(async () => { await router.navigate(-1); }); await flush();
    expect(router.state.location.key).toBe(before); expect(recovery!.state).toMatchObject({ phase: 'failed', reason });
    expect(host.connection.prepareSshProfile).toHaveBeenCalledTimes(1);
    failure = null;
    await act(async () => { recovery!.retry(token); }); await flush();
    expect(current.scope.scopeId).toBe('ssh:example'); expect(router.state.location.pathname).toBe('/s/shared');
  });

  it('checks room existence through the verified client facade and distinguishes missing from offline', async () => {
    const rooms = current.client.klient.rest!.rooms;
    const get = vi.spyOn(rooms, 'get').mockResolvedValue(undefined);
    const signal = new AbortController().signal;
    await expect(validateScopeRoute(current.client, '/rooms/missing', signal)).rejects.toMatchObject({ reason: 'target-missing' });
    expect(get).toHaveBeenCalledWith('missing');
    get.mockRejectedValue(new Error('backend offline'));
    await expect(validateScopeRoute(current.client, '/r/missing', signal)).rejects.toThrow('backend offline');
  });

  it.each([['native-auth', 'auth-required'], ['native-identity', 'identity-mismatch']])('classifies %s handshake rejection before any target entity request', async (nativeFailure, reason) => {
    const router = await mount(); const before = router.state.location.key;
    const source = container.querySelector('[data-buffer]'); const priorRequests = sessionRequests();
    failure = nativeFailure;
    await act(async () => { await expect(requestScopeNavigation({ scopeId: 'ssh:example', route: '/s/shared', token })).rejects.toBeInstanceOf(ScopeRestoreError); });
    expect(recovery!.state).toMatchObject({ phase: 'failed', reason });
    expect(router.state.location.key).toBe(before); expect(current.scope.scopeId).toBe('local');
    expect(container.querySelector('[data-buffer]')).toBe(source); expect(sessionRequests()).toEqual(priorRequests);
    await act(async () => { recovery!.cancel(); });
    expect(recovery!.state.phase).toBe('idle'); expect(container.querySelector('[data-buffer]')).toBe(source);
  });

  it('whole shell notification listeners gate home intent before entities and preserve undefined-home navigation', async () => {
    type Click = Parameters<NonNullable<HostAdapter['onNotificationClick']>>[0];
    const listeners = new Set<Click>();
    vi.mocked(host.onNotificationClick!).mockImplementation((callback) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    });
    withAwayNotifications = true;
    const router = await mount('/s/source-a');
    expect(listeners.size).toBe(1);
    const sourceKey = router.state.location.key;
    const sourceRequests = sessionRequests();
    let release!: () => void;
    delay = new Promise<void>((done) => { release = done; });
    await act(async () => { for (const callback of [...listeners]) callback('/s/notified', 'home-b'); });
    await flush();
    expect(host.prepareSpace).toHaveBeenCalledExactlyOnceWith('home-b');
    expect(sessionRequests()).toEqual(sourceRequests);
    expect(router.state.location.key).toBe(sourceKey);
    await act(async () => { release(); }); await flush();
    expect(current.scope.homeId).toBe('home-b');
    expect(router.state.location.pathname).toBe('/s/notified');
    expect(sessionRequests()).not.toContain(`${endpoints.a}/api/sessions/notified`);
    expect(sessionRequests()).toContain(`${endpoints.b}/api/sessions/notified`);
    const preparedCount = vi.mocked(host.prepareSpace!).mock.calls.length;
    const beforeSameHome = sessionRequests().length;
    await act(async () => { for (const callback of [...listeners]) callback('/s/same-home'); }); await flush();
    expect(router.state.location.pathname).toBe('/s/same-home');
    expect(current.scope.homeId).toBe('home-b');
    expect(vi.mocked(host.prepareSpace!).mock.calls.length).toBe(preparedCount);
    expect(sessionRequests().slice(beforeSameHome)).toEqual([
      `${endpoints.b}/api/sessions/same-home`, `${endpoints.b}/api/sessions/same-home`,
    ]);
  });

  it('keeps a missing notification explicit and recoverable instead of falling back to the current session', async () => {
    const router = await mount('/s/source');
    const source = getCurrentVisit()!.visitId;
    entityFailures.set(`${endpoints.a}/api/sessions/deleted`, new ApiError({ code: API_CODES.SESSION_NOT_FOUND, msg: 'session.not_found', data: null }));
    const click = vi.mocked(host.onNotificationClick!).mock.calls[0]![0];
    await act(async () => { click('/s/deleted', 'home-a', current.scope); }); await flush();
    expect(router.state.location.pathname).toBe('/s/source');
    expect(recovery?.state).toMatchObject({ phase: 'failed', reason: 'target-missing', target: { route: '/s/deleted' } });
    expect(getCurrentVisit()!.visitId).toBe(source);
    await act(async () => { recovery!.cancel(); });
    expect(router.state.location.pathname).toBe('/s/source');
  });

  it('checks the captured server identity even for an identical local home and session id', async () => {
    const router = await mount('/s/shared');
    const click = vi.mocked(host.onNotificationClick!).mock.calls[0]![0];
    const before = sessionRequests().length;
    await act(async () => { click('/s/shared', 'home-a', { ...current.scope, serverHomeId: 'old-server' }); }); await flush();
    expect(recovery?.state).toMatchObject({ phase: 'failed', reason: 'identity-mismatch' });
    expect(router.state.location.pathname).toBe('/s/shared');
    expect(sessionRequests()).toHaveLength(before);
  });

  it('serializes cancelled cross-home rollback before accepting a newer notification', async () => {
    const router = await mount('/s/source');
    const click = vi.mocked(host.onNotificationClick!).mock.calls[0]![0];
    let release!: () => void;
    delay = new Promise<void>((done) => { release = done; });
    await act(async () => { click('/s/old', 'home-b'); }); await flush();
    await act(async () => { click('/s/latest', 'home-a', { homeId: 'home-a', scopeId: 'local', serverHomeId: 'server-a' }); });
    await act(async () => { release(); }); await flush();
    expect(nativeHome).toBe('home-a');
    expect(router.state.location.pathname).toBe('/s/latest');
    expect(sessionRequests()).not.toContain(`${endpoints.b}/api/sessions/old`);
    expect(sessionRequests()).not.toContain(`${endpoints.b}/api/sessions/latest`);
    expect(sessionRequests()).toContain(`${endpoints.a}/api/sessions/latest`);
  });

  it('reuses an active remote connection without reopening, rebinding or losing the child/frame route', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const selection = localSelection('home-a');
    current = { scope: { homeId: `remote:${id}`, scopeId: `remote:${id}`, serverHomeId: 'server-ssh', connectionRef: id },
      selection, client: newClient({ ...selection, config: { url: endpoints.ssh, token } }) };
    configureSpaceStorage({ homeId: current.scope.homeId });
    const agents = vi.fn(async () => ({ child: {} }));
    vi.spyOn(current.client.klient, 'session').mockReturnValue({ agents } as never);
    const router = await mount('/s/source');
    const click = vi.mocked(host.onNotificationClick!).mock.calls[0]![0];
    await act(async () => { click('/s/shared/agent/child?turn=t4', current.scope.homeId, current.scope); }); await flush();
    expect(router.state.location.pathname).toBe('/s/shared/agent/child');
    expect(router.state.location.search).toBe('?turn=t4');
    expect(current.scope.scopeId).toBe(`remote:${id}`);
    expect(agents).toHaveBeenCalledTimes(1);
    expect(host.prepareSpace).not.toHaveBeenCalled();
    expect(host.connection.prepareSshProfile).not.toHaveBeenCalled();
    expect(reloads).toBe(0);
    expect(sessionRequests()).not.toContain(`${endpoints.a}/api/sessions/shared`);
  });

  it('does not downgrade a deleted child route to its main agent', async () => {
    vi.spyOn(current.client.klient, 'session').mockReturnValue({ agents: async () => ({}) } as never);
    await expect(validateScopeRoute(current.client, '/s/shared/agent/deleted?turn=t3', new AbortController().signal))
      .rejects.toMatchObject({ reason: 'target-missing' });
  });

  it('a live click supersedes a still-validating cold intent before its old target mounts', async () => {
    let release!: () => void;
    entityDelays.set(`${endpoints.b}/api/sessions/boot-old`, new Promise<void>((resolve) => { release = resolve; }));
    applyColdNavigationIntent({ route: '/s/boot-old', homeId: 'home-b' }, 'home-a');
    root = createRoot(container);
    const router = createMemoryRouter([{ path: '*', element: <Fixture><Surface /></Fixture> }], { initialEntries: [{ pathname: '/s/boot-old', key: window.history.state.key, state: window.history.state.usr }] });
    await act(async () => { root!.render(<RouterProvider router={router} />); }); await flush();
    expect(surfaceMounts).toBe(0);
    const click = vi.mocked(host.onNotificationClick!).mock.calls[0]![0];
    await act(async () => { click('/s/live-new', 'home-a', { homeId: 'home-a', scopeId: 'local', serverHomeId: 'server-a' }); });
    await act(async () => { release(); }); await flush();
    expect(router.state.location.pathname).toBe('/s/live-new');
    expect(current.scope.homeId).toBe('home-a');
    expect(nativeHome).toBe('home-a');
    expect(sessionRequests()).not.toContain(`${endpoints.a}/api/sessions/boot-old`);
    expect(sessionRequests()).not.toContain(`${endpoints.b}/api/sessions/live-new`);
  });

  it('cold same-home notification verifies before mounting, without inventing a return visit', async () => {
    entityFailures.set(`${endpoints.a}/api/sessions/deleted`, new ApiError({ code: API_CODES.SESSION_NOT_FOUND, msg: 'session.not_found', data: null }));
    expect(applyColdNavigationIntent({ route: '/s/deleted', scope: current.scope }, 'home-a')).toBe(true);
    root = createRoot(container);
    const cold = createMemoryRouter([{ path: '*', element: <Fixture><Surface /></Fixture> }], { initialEntries: [{ pathname: '/s/deleted', key: window.history.state.key, state: window.history.state.usr }] });
    await act(async () => { root!.render(<RouterProvider router={cold} />); }); await flush();
    expect(surfaceMounts).toBe(0);
    expect(container.textContent).not.toBe('');
    expect(canGoBack()).toBe(false);
    expect(sessionRequests()).toEqual([`${endpoints.a}/api/sessions/deleted`]);
  });

  it('cross-home hot notification retains its source and cold notification has no invented source', async () => {
    const router = await mount(); const source = getCurrentVisit()!.visitId;
    const click = vi.mocked(host.onNotificationClick!).mock.calls[0]![0];
    await act(async () => { click('/activity', 'home-b'); }); await flush();
    expect(canGoBack()).toBe(true);
    await act(async () => { await router.navigate(-1); }); await flush();
    expect(getCurrentVisit()!.visitId).toBe(source);
    await act(async () => { root!.unmount(); }); root = undefined;
    clearNavHistory(); current = { scope: { homeId: 'home-a', scopeId: 'local' }, selection: localSelection('home-a'), client: newClient(localSelection('home-a')) };
    configureSpaceStorage({ homeId: 'home-a' }); nativeHome = 'home-a';
    expect(applyColdNavigationIntent({ route: '/activity', homeId: 'home-b' }, 'home-a')).toBe(true);
    root = createRoot(container);
    const cold = createMemoryRouter([{ path: '*', element: <Fixture><Surface /></Fixture> }], { initialEntries: [{ pathname: '/activity', key: window.history.state.key, state: window.history.state.usr }] });
    await act(async () => { root!.render(<RouterProvider router={cold} />); }); await flush();
    expect(current.scope.homeId).toBe('home-b'); expect(canGoBack()).toBe(false);
  });
});

 describe('reload and window/run identity', () => {
  it('keeps bounded reading snapshots on controlled reload but not across a new native launch or another window', async () => {
    const router = await mount(); const source = getCurrentVisit()!.visitId;
    await act(async () => { await router.navigate('/usage'); });
    const location = router.state.location;
    window.history.replaceState({ key: location.key, idx: 1, usr: { kikiNav: { visitId: getCurrentVisit()!.visitId, scope: current.scope } } }, '', '/usage');
    markScopeReload(current.scope, '/usage', location.key);
    expect(consumeScopeReload('home-a')).toBe(true); expect(consumeScopeReload('home-a')).toBe(false);
    await act(async () => { root!.unmount(); }); root = undefined;
    const saved = sessionStorage.getItem('kiki.navHistory.v1')!;
    vi.resetModules();
    const hydrated = await import('./navHistory');
    expect(hydrated.getVisitForLocation(location)?.visitId).toBe(getCurrentVisit()!.visitId);
    hydrated.recordNavigation({ location, scope: current.scope, action: 'POP' });
    expect(hydrated.getBackEntry()?.visitId).toBe(source);
    beginNavWindow(true, true); expect(sessionStorage.getItem('kiki.navHistory.v1')).toBe(saved);
    beginNavWindow(false, false); expect(canGoBack()).toBe(false); expect(sessionStorage.getItem('kiki.navHistory.v1')).toBeNull();
    // A separate window starts with its own sessionStorage; even an inherited
    // URL/key cannot invent an earlier visit when the native run is new.
    recordNavigation({ location, scope: { homeId: 'home-b', scopeId: 'local' }, action: 'POP' });
    expect(canGoBack()).toBe(false); expect(readHomeViewRoute('home-a')).toBeUndefined();
  });

  it('serializes only nonsecret scope identity in visits, snapshots and reload handoff, including hydrated input', async () => {
    const scope = { homeId: 'home-a', scopeId: 'ssh:example', serverHomeId: 'server-ssh', connectionRef: 'exact-tunnel', token };
    const location = { pathname: '/usage', search: '', hash: '', key: 'whitelist' };
    const entry = recordNavigation({ location, scope });
    const history = await import('./navHistory');
    history.saveSnapshot(entry.visitId, { scope });
    markScopeReload(scope, '/usage', location.key);
    expect(sessionStorage.getItem('kiki.navHistory.v1')).not.toContain(token);
    expect(sessionStorage.getItem('kiki.navScopeHandoff.v1')).not.toContain(token);
    sessionStorage.setItem('kiki.navHistory.v1', JSON.stringify({ version: 1, entries: [{ ...entry, scope }], currentIndex: 0,
      snapshots: [{ ...entry, scope, timestamp: 1 }] }));
    vi.resetModules();
    const hydrated = await import('./navHistory');
    expect(hydrated.getVisitForLocation(location)?.scope).not.toHaveProperty('token');
    expect(hydrated.getSnapshot(entry.visitId)?.scope).not.toHaveProperty('token');
    expect(sessionStorage.getItem('kiki.navHistory.v1')).not.toContain(token);
  });

  it('rejects a foreign reload handoff and credential-bearing cold intent', () => {
    window.history.replaceState({ key: 'window-a' }, '', '/usage');
    markScopeReload({ homeId: 'home-a', scopeId: 'local' }, '/usage', 'window-a');
    expect(consumeScopeReload('home-b')).toBe(false);
    expect(applyColdNavigationIntent({ route: '/s/shared?token=private' }, 'home-a')).toBe(false);
    expect(applyColdNavigationIntent({ route: '//example.test/s/shared' }, 'home-a')).toBe(false);
  });
});


describe('confirmed missing navigation', () => {
  const gone = () => new ApiError({ code: API_CODES.SESSION_NOT_FOUND, msg: 'session.not_found', data: null });
  async function threeVisits(crossHome = false, middle = '/s/b') {
    const router = await mount('/s/a'); const first = getCurrentVisit()!;
    if (crossHome) await act(async () => { await requestScopeNavigation({ homeId: 'home-b', route: middle }); });
    else await act(async () => { await router.navigate(middle); });
    await act(async () => { await router.navigate('/s/c'); }); await flush();
    return { router, first, source: router.state.location };
  }

  it.each([false, true])('skips a deleted middle visit to the original A visit (cross-home=%s)', async (crossHome) => {
    const { router, first } = await threeVisits(crossHome);
    const endpoint = crossHome ? endpoints.b : endpoints.a;
    entityFailures.set(`${endpoint}/api/sessions/b`, gone()); requests = [];
    await act(async () => { await router.navigate(-1); }); await flush();
    expect(router.state.location.pathname).toBe('/s/a'); expect(router.state.location.key).toBe(first.key);
    expect(getCurrentVisit()!.visitId).toBe(first.visitId); expect(current.scope.homeId).toBe('home-a');
    expect(recovery!.state.phase).toBe('idle');
    expect(sessionRequests()).toEqual([`${endpoint}/api/sessions/b`, `${endpoints.a}/api/sessions/a`, `${endpoints.a}/api/sessions/a`]);
  });

  it.each([
    ['offline', () => new Error('temporary offline'), 'offline'],
    ['auth', () => new ApiError({ code: API_CODES.UNAUTHORIZED, msg: 'auth.invalid_token', data: null }), 'auth-required'],
    ['non-entity 404', () => new ApiError({ code: API_CODES.PROMPT_NOT_FOUND, msg: 'prompt.not_found', data: null }), 'offline'],
  ] as const)('does not skip %s; keeps the source DOM and retries the original blocked visit', async (_kind, error, reason) => {
    const { router, source } = await threeVisits(true); const input = container.querySelector('[data-buffer]');
    const sourceVisit = getCurrentVisit()!.visitId;
    entityFailures.set(`${endpoints.b}/api/sessions/b`, error()); requests = [];
    await act(async () => { await router.navigate(-1); }); await flush();
    expect(router.state.location.key).toBe(source.key); expect(getCurrentVisit()!.visitId).toBe(sourceVisit);
    expect(container.querySelector('[data-buffer]')).toBe(input); expect(current.scope.homeId).toBe('home-b');
    expect(recovery!.state).toMatchObject({ phase: 'failed', reason });
    expect(sessionRequests()).toEqual([`${endpoints.b}/api/sessions/b`]);
    entityFailures.clear(); await act(async () => { recovery!.retry(); }); await flush();
    expect(router.state.location.pathname).toBe('/s/b');
  });

  it('replaces with /new in the currently confirmed source scope when all earlier sources are deleted', async () => {
    const { router } = await threeVisits(true); const sourceVisit = getCurrentVisit()!.visitId;
    entityFailures.set(`${endpoints.b}/api/sessions/b`, gone()); entityFailures.set(`${endpoints.a}/api/sessions/a`, gone()); requests = [];
    await act(async () => { await router.navigate(-1); }); await flush();
    expect(router.state.historyAction).toBe('REPLACE'); expect(router.state.location.pathname).toBe('/new');
    expect(current.scope.homeId).toBe('home-b'); expect(nativeHome).toBe('home-b');
    expect(getCurrentVisit()!.visitId).toBe(sourceVisit); expect(getCurrentVisit()!.pathname).toBe('/new');
    expect(getCurrentVisit()!.scope.homeId).toBe('home-b'); expect(recovery!.state.phase).toBe('idle');
    expect(canGoBack()).toBe(false);
    expect(sessionRequests()).toEqual([`${endpoints.b}/api/sessions/b`, `${endpoints.a}/api/sessions/a`]);
  });

  it('waits for the existing dirty confirmation, then cancellation of the skipped candidate keeps the original DOM and draft', async () => {
    const { router, source } = await threeVisits(true); const input = container.querySelector('[data-buffer]');
    entityFailures.set(`${endpoints.b}/api/sessions/b`, gone());
    let release!: () => void; entityDelays.set(`${endpoints.a}/api/sessions/a`, new Promise<void>((resolve) => { release = resolve; }));
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-dirty]')!.click(); }); requests = [];
    await act(async () => { await router.navigate(-1); });
    expect(guard!.pending).toBe(true); expect(sessionRequests()).toEqual([]);
    let attempt: void | Promise<void>; await act(async () => { attempt = guard!.confirm(); }); await flush();
    expect(sessionRequests()).toEqual([`${endpoints.b}/api/sessions/b`, `${endpoints.a}/api/sessions/a`]);
    await act(async () => { recovery!.cancel(); release(); await attempt; }); await flush();
    expect(router.state.location.key).toBe(source.key); expect(container.querySelector('[data-buffer]')).toBe(input);
    expect(guard!.value.dirty).toBe(true); expect(current.scope.homeId).toBe('home-b'); expect(nativeHome).toBe('home-b');
    expect(recovery!.state.phase).toBe('idle');
  });

  it('does not use a stale history delta when a new Router location wins during candidate validation', async () => {
    const { router } = await threeVisits(true);
    entityFailures.set(`${endpoints.b}/api/sessions/b`, gone());
    let release!: () => void; entityDelays.set(`${endpoints.a}/api/sessions/a`, new Promise<void>((resolve) => { release = resolve; }));
    await act(async () => { await router.navigate(-1); }); await flush();
    expect(sessionRequests()).toContain(`${endpoints.a}/api/sessions/a`);
    await act(async () => { await router.navigate('/usage'); }); const newer = router.state.location.key;
    await act(async () => { release(); }); await flush();
    expect(router.state.location.pathname).toBe('/usage'); expect(router.state.location.key).toBe(newer);
    expect(current.scope.homeId).toBe('home-b'); expect(nativeHome).toBe('home-b'); expect(recovery!.state.phase).toBe('idle');
  });

  it('recognizes only the actual room missing envelope, not arbitrary invalid requests', async () => {
    const { router, first } = await threeVisits(true, '/rooms/b');
    entityFailures.set(`${endpoints.b}/api/rooms/b`, new RPCError(API_CODES.REQUEST_INVALID, "Room 'b' does not exist.")); requests = [];
    await act(async () => { await router.navigate(-1); }); await flush();
    expect(router.state.location.key).toBe(first.key); expect(router.state.location.pathname).toBe('/s/a');
    expect(requests).toContain(`${endpoints.b}/api/rooms/b`); expect(requests).not.toContain(`${endpoints.a}/api/rooms/b`);
    const rooms = current.client.klient.rest!.rooms;
    vi.mocked(rooms.get).mockRejectedValue(new RPCError(API_CODES.REQUEST_INVALID, 'Room request is malformed.'));
    await expect(validateScopeRoute(current.client, '/rooms/b', new AbortController().signal)).rejects.toThrow('malformed');
  });

  it('does not push a deleted explicit destination when the current source is still valid', async () => {
    const router = await mount('/s/a'); const source = router.state.location; const visit = getCurrentVisit()!.visitId;
    entityFailures.set(`${endpoints.b}/api/sessions/gone`, gone()); requests = [];
    await act(async () => { await requestScopeNavigation({ homeId: 'home-b', route: '/s/gone' }); }); await flush();
    expect(router.state.location.key).toBe(source.key); expect(getCurrentVisit()!.visitId).toBe(visit);
    expect(current.scope.homeId).toBe('home-a'); expect(nativeHome).toBe('home-a'); expect(recovery!.state.phase).toBe('idle');
    expect(canGoBack()).toBe(false); expect(sessionRequests()).toEqual([`${endpoints.b}/api/sessions/gone`, `${endpoints.a}/api/sessions/a`]);
  });

  it('replaces a deleted cold cross-scope destination in the confirmed scope without inventing a source', async () => {
    entityFailures.set(`${endpoints.b}/api/sessions/gone`, gone());
    root = createRoot(container);
    const router = createMemoryRouter([{ path: '*', element: <Fixture><Surface /></Fixture> }], { initialEntries: [{
      pathname: '/s/gone', state: { kikiNav: { scope: { homeId: 'home-b', scopeId: 'local' } } },
    }] });
    await act(async () => { root!.render(<RouterProvider router={router} />); }); await flush();
    expect(router.state.location.pathname).toBe('/new'); expect(router.state.historyAction).toBe('REPLACE');
    expect(current.scope.homeId).toBe('home-a'); expect(nativeHome).toBe('home-a');
    expect(getCurrentVisit()!.scope.homeId).toBe('home-a'); expect(canGoBack()).toBe(false); expect(recovery!.state.phase).toBe('idle');
    expect(sessionRequests()).toEqual([`${endpoints.b}/api/sessions/gone`]);
  });
});


describe('real SpaceSwitcher single confirmation consumer', () => {
  it.each(['switch', 'windows'] as const)('dirty %s entry confirms once and cancellation never stages a connection or native window', async (mode: SpaceWindowMode) => {
    withSpaceSwitcher = true;
    writeDesktopPrefs({ windowMode: mode });
    const router = await mount();
    await act(async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
    const source = router.state.location; const input = container.querySelector('[data-buffer]');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-dirty]')!.click(); });
    const enter = async () => {
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switch-item="home-b"]')!.click(); });
    };
    await enter();
    expect(guard!.pending).toBe(true);
    expect(host.prepareSpace).not.toHaveBeenCalled(); expect(host.openSpace).not.toHaveBeenCalled();
    await act(async () => { guard!.cancel(); });
    expect(router.state.location.key).toBe(source.key); expect(container.querySelector('[data-buffer]')).toBe(input);
    expect(guard!.value.dirty).toBe(true);
    await enter();
    await act(async () => { await guard!.confirm(); }); await flush();
    expect(guard!.pending).toBe(false); expect(guard!.value.dirty).toBe(false);
    if (mode === 'switch') {
      expect(host.prepareSpace).toHaveBeenCalledExactlyOnceWith('home-b');
      expect(host.openSpace).not.toHaveBeenCalled(); expect(current.scope.homeId).toBe('home-b');
      expect(router.state.location.pathname).toBe('/new');
    } else {
      expect(host.openSpace).toHaveBeenCalledExactlyOnceWith('home-b');
      expect(host.prepareSpace).not.toHaveBeenCalled(); expect(current.scope.homeId).toBe('home-a');
      expect(router.state.location.key).toBe(source.key);
    }
  });
});
