// @vitest-environment jsdom

/**
 * Entering a remote Kiki as a space in switch mode: the one transition that
 * cannot commit in place. The window's own home never changes, so the entry is
 * carried across a reload by a credential-free handoff, and the reload only
 * fires once the Router has committed the target scope.
 *
 * These are the states the browser walk was stuck in: the surface said
 * "verifying" and never moved on, because the reload gate waited for a Router
 * commit that a same-route scope switch never produced.
 */

import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTION_PROTOCOL, type RemoteConnection } from '@kiki/protocol';
import { writeDesktopPrefs } from '@kiki/session-core/settings';
import { NavScopeBoundary } from '../components/NavScopeBoundary';
import { useDirtyGuardState, type DirtyGuardState } from '../components/dirtyGuard';
import type { HostAdapter } from '../host';
import type { ConnectionSelection } from '../state/connectionConfig';
import { createRemoteSpaceClient, KikiClient } from './client';
import { clearNavHistory, getCurrentVisit, recordNavigation, type NavScopeIdentity } from './navHistory';
import { requestScopeNavigation } from './navScope';
import { createScopeConnectionAdapter } from './navScopeConnection';
import { resetLaunchWindowMode } from './spaces';
import { configureSpaceStorage } from './spaceStorage';

const CONNECTION = '22222222-2222-4222-8222-222222222222';
const REMOTE_HOME = '33333333-3333-4333-8333-333333333333';
const scope = { homeId: `remote:${CONNECTION}`, scopeId: `remote:${CONNECTION}` };

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  commit: vi.fn(),
  dispose: vi.fn(),
  reload: false,
  hostSwitch: vi.fn(),
  takenOver: false,
}));
/** Set once the boundary has committed, so the page stops re-recording. */
function guardTakenOver(): boolean { return mocks.takenOver; }
vi.mock('../host', () => {
  const host = { kind: 'tauri', connection: {}, switchSpace: mocks.hostSwitch };
  return { useHost: () => host };
});
const connection = {
  spaceKey: 'main', scopeId: 'local', connectionId: null as string | null, meta: { server_home_id: 'source-home' },
  get needsScopeReload() { return mocks.reload; },
  scopeAdapter: { prepare: mocks.prepare },
};
vi.mock('../state/connection', () => ({ useConnection: () => connection }));
vi.mock('../i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));

let root: Root | undefined;
let container: HTMLDivElement;
let guard: DirtyGuardState;
let router: ReturnType<typeof createMemoryRouter>;

function Source() {
  const location = useLocation();
  const action = useNavigationType();
  guard = useDirtyGuardState(location, () => {});
  useLayoutEffect(() => {
    // The same rule App.tsx uses: a remote space's home is its own scope key,
    // a local one is the active space's home. It stops once the boundary has
    // taken over, because in the real app that page is gone by then.
    if (guardTakenOver()) return;
    const home = connection.scopeId.startsWith('remote:') ? connection.scopeId : 'main';
    recordNavigation({
      location, action,
      scope: { homeId: home, scopeId: connection.scopeId, serverHomeId: connection.meta.server_home_id,
        connectionRef: connection.connectionId ?? undefined },
    });
  }, [location, action]);
  return <div data-source>source</div>;
}

async function mount() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  router = createMemoryRouter(
    [{ path: '*', element: <NavScopeBoundary><Source /></NavScopeBoundary> }],
    { initialEntries: ['/new'] },
  );
  await act(async () => { root!.render(<RouterProvider router={router} />); });
}

/** A real remote prepare: it verifies the target home, then commits and asks for the reload. */
function preparedRemote() {
  return {
    scope: { ...scope, serverHomeId: REMOTE_HOME, connectionRef: CONNECTION },
    validate: vi.fn(async () => {}),
    commit: () => { mocks.commit(); mocks.reload = true; },
    dispose: () => { mocks.dispose(); },
  };
}

const surface = () => container.querySelector('.absolute.inset-0.z-50');
const surfaceTitle = () => surface()?.querySelector('h1')?.textContent ?? null;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  clearNavHistory();
  configureSpaceStorage(null);
  resetLaunchWindowMode();
  // Switch mode: the same window changes scope, so the entry is a reload.
  writeDesktopPrefs({ windowMode: 'switch' });
  mocks.prepare.mockReset().mockResolvedValue(preparedRemote());
  mocks.commit.mockReset();
  mocks.dispose.mockReset();
  mocks.hostSwitch.mockReset();
  mocks.reload = false;
  mocks.takenOver = false;
  connection.spaceKey = 'main';
  connection.scopeId = 'local';
  connection.connectionId = null;
  connection.meta = { server_home_id: 'source-home' };
  await mount();
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  router?.dispose();
  container?.remove();
  configureSpaceStorage(null);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('entering a remote space in switch mode', () => {
  it('reaches idle instead of sitting on the verifying surface', async () => {
    await act(async () => { await requestScopeNavigation(scope); });

    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    // The reload is the window's own; a remote space has no local home to switch.
    expect(mocks.hostSwitch).not.toHaveBeenCalled();
    expect(mocks.dispose).not.toHaveBeenCalled();

    // The surface is a placeholder for a window that is about to go away: the
    // reload is what ends it, and the browser never paints past that point.
    // What must not happen is the entry being abandoned or rolled back.
    expect(mocks.reload).toBe(true);
    expect(surfaceTitle()).toBe('nav.scope.verifying.title');
  });

  it('writes the credential-free handoff the reload will read', async () => {
    await act(async () => { await requestScopeNavigation(scope); });
    // The reload itself is the browser's; what this asserts is that the
    // destination survived the commit without a token or an endpoint.
    const before = sessionStorage.getItem('kiki.navScopeHandoff.v1') ?? '';
    expect(before.includes('Bearer')).toBe(false);
    // The handoff is the whole remote entry: a route, a history key and the
    // target scope, and nothing else. A reload that cannot match these on the
    // next boot is the hang this test exists to prevent.
    const raw = sessionStorage.getItem('kiki.navScopeHandoff.v1');
    expect(raw).not.toBeNull();
    const handoff = JSON.parse(raw!) as { scope: { homeId: string }; route: string; key: string };
    expect(handoff.scope.homeId).toBe(scope.homeId);
    expect(handoff.route).toBe('/new');
    expect(handoff.key).toBe(getCurrentVisit()?.key ?? '');
  });
});

/**
 * Leaving a remote space is the same transition backwards: the Router still
 * holds the remote scope until the reload hands the window back to its own
 * home, so waiting for a Router commit here hung the walk the same way the
 * entry did.
 */
/**
 * A window already inside the remote space: the connection is the remote one
 * and the page was reached through it, so leaving is the transition under test.
 * Set before mounting, because the boundary registers its navigation handler
 * against the scope it booted with.
 */
async function mountInsideRemoteSpace() {
  // The shared beforeEach mounts a local window; this scenario needs a window
  // that booted inside the remote space, so that one is replaced.
  await act(async () => { root?.unmount(); });
  router?.dispose();
  container.remove();
  // The history store is module-level; a window that booted somewhere else
  // would otherwise inherit the previous window's visit for the same key.
  clearNavHistory();
  connection.spaceKey = `remote:${CONNECTION}`;
  connection.scopeId = `remote:${CONNECTION}`;
  connection.connectionId = CONNECTION;
  connection.meta = { server_home_id: REMOTE_HOME };
  mocks.reload = false;
  mocks.prepare.mockReset().mockImplementation(async (target) => ({
    scope: { ...target, serverHomeId: 'source-home' },
    validate: vi.fn(async () => {}),
    commit: () => { mocks.commit(); mocks.reload = true; mocks.takenOver = true; },
    dispose: () => { mocks.dispose(); },
  }));
  await mount();
}

describe('leaving a remote space in switch mode', () => {
  it('reloads instead of waiting for a Router commit it will never get', async () => {
    await mountInsideRemoteSpace();
    expect(getCurrentVisit()?.scope.scopeId).toBe(`remote:${CONNECTION}`);

    await act(async () => { await requestScopeNavigation({ homeId: 'main', scopeId: 'local' }); });

    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.reload).toBe(true);
    // A remote space has no local home to switch back to natively.
    expect(mocks.hostSwitch).not.toHaveBeenCalled();
    expect(mocks.dispose).not.toHaveBeenCalled();
  });

  it('hands the next window the local home, not the remote key', async () => {
    await mountInsideRemoteSpace();
    await act(async () => { await requestScopeNavigation({ homeId: 'main', scopeId: 'local' }); });

    const raw = sessionStorage.getItem('kiki.navScopeHandoff.v1');
    expect(raw).not.toBeNull();
    const handoff = JSON.parse(raw!) as { scope: { homeId: string; scopeId: string; serverHomeId?: string } };
    // The next window must boot on the local home, and never on the remote key
    // it is leaving — that mismatch is what made it refuse its own entry.
    expect(handoff.scope.homeId).toBe('main');
    expect(getCurrentVisit()?.scope.homeId).toBe('main');
    expect(handoff.scope.scopeId).toBe('local');
    expect(handoff.scope.serverHomeId).toBe('source-home');
  });
});

/**
 * A failed entry is told in the person's terms, end to end: the real adapter
 * reads the broker's refusal and the recovery surface says which one it was.
 * The token field is a promise that a typed token will be used, so it appears
 * only where the adapter really reads one — a hand-entered address — and never
 * for a paired space, whose branch has no use for it.
 */
describe('a failed entry says why', () => {
  const PAIRING = '44444444-4444-4444-8444-444444444444';
  const pairingScope = { homeId: `remote:${PAIRING}`, scopeId: `remote:${PAIRING}` };
  const ADDRESS = 'http://source.example.test';
  const pairing: RemoteConnection = { id: PAIRING, label: 'Example pairing', endpoint: 'https://remote.example.test',
    target: { homeId: REMOTE_HOME, hostId: 'example-host', protocol: CONNECTION_PROTOCOL }, credentialRef: 'example-reference',
    enabled: true, backgroundSummary: false, purposes: ['gui'], state: 'online', activeLeases: 0 };
  const clients: KikiClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.klient.close()));
    localStorage.removeItem('kiki.connection');
    vi.unstubAllGlobals();
  });

  function typeInto(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** The real adapter over a stubbed network, standing in for the window's own. */
  function stubRealAdapter(
    active: NavScopeIdentity,
    answer: (input: RequestInfo | URL, init?: RequestInit) => Response,
    overrides?: {
      source?: ConnectionSelection['source'];
      persist?: boolean;
      local?: { scope: NavScopeIdentity; selection: ConnectionSelection };
    },
  ) {
    const seenHeaders: string[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      const auth = headers.get('authorization');
      if (auth !== null) seenHeaders.push(`${url} -> ${auth}`);
      if (url === `${ADDRESS}/api/remote-connections`) return Response.json({ code: 0, msg: 'success', data: [pairing], request_id: 'example' });
      return answer(input, init);
    }));
    const selection: ConnectionSelection = {
      config: { url: ADDRESS, token: 'example-token' },
      persist: overrides?.persist ?? false,
      source: overrides?.source ?? 'stored',
      scopeId: active.scopeId,
    };
    const client = new KikiClient({ baseUrl: ADDRESS, token: 'example-token' }); clients.push(client);
    const source = { scope: active, selection, client };
    const localSource = overrides?.local !== undefined
      ? (() => {
          const localClient = new KikiClient({ baseUrl: overrides.local.selection.config.url, token: overrides.local.selection.config.token });
          clients.push(localClient);
          return { scope: overrides.local.scope, selection: overrides.local.selection, client: localClient };
        })()
      : source;
    const commit = vi.fn();
    const reload = vi.fn(() => { mocks.reload = true; });
    const adapter = createScopeConnectionAdapter({ host: { connection: {} } as unknown as HostAdapter,
      active: () => source, local: () => localSource, control: () => localSource, commit, reload,
      createClient: (next) => {
        const created = next.source === 'remote'
          ? createRemoteSpaceClient({ endpoint: next.config.url, token: next.config.token, connectionId: next.connectionId! })
          : new KikiClient({ baseUrl: next.config.url, token: next.config.token });
        if (next.source !== 'remote') {
          vi.spyOn(created, 'getSession').mockResolvedValue({ id: 'example-session', work_dir: '/tmp' } as never);
        }
        clients.push(created); return created;
      } });
    mocks.prepare.mockReset().mockImplementation((scope: NavScopeIdentity, signal: AbortSignal, token?: string) => adapter.prepare(scope, signal, token));
    return { seenHeaders, commit, reload };
  }

  it.each([
    { msg: 'inbound_disabled', status: 403, reason: 'remote-closed' },
    { msg: 'connection_paused', status: 409, reason: 'remote-paused' },
    { msg: 'identity_changed', status: 409, reason: 'remote-identity-changed' },
    { msg: 'connection_not_approved', status: 401, reason: 'remote-not-approved' },
  ])('says $msg in its own words and never asks a paired space for a token', async ({ msg, status, reason }) => {
    stubRealAdapter({ homeId: 'main', scopeId: 'local' },
      () => Response.json({ code: 40101, msg, data: null, request_id: 'example' }, { status }));

    await act(async () => { await requestScopeNavigation(pairingScope).catch(() => {}); });

    expect(surface()?.querySelector<HTMLElement>('h1')?.dataset['navScopeFailure']).toBe(reason);
    expect(surfaceTitle()).toBe(`nav.scope.failed.${reason}.title`);
    expect(surface()?.querySelector('input')).toBeNull();
    expect(surfaceTitle()).not.toBe('nav.scope.failed.auth-required.title');
  });

  it('asks for a token when a hand-entered address answers 401, then retries with the typed token and closes recovery', async () => {
    await act(async () => { root?.unmount(); });
    router?.dispose();
    container.remove();
    clearNavHistory();
    const direct = { homeId: 'main', scopeId: `direct:${ADDRESS}` };
    connection.scopeId = direct.scopeId;
    await mount();
    const { seenHeaders, commit } = stubRealAdapter(direct, (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      if (headers.get('authorization') !== 'Bearer fresh-valid-token') {
        return Response.json({ code: 40101, msg: 'auth.invalid_token', data: null, request_id: 'example' }, { status: 401 });
      }
      if (url.endsWith('/api/meta')) {
        return Response.json({ code: 0, msg: 'success', data: { server_home_id: 'source-home' }, request_id: 'example' });
      }
      if (url.endsWith('/api/sessions/example-session')) {
        return Response.json({ code: 0, msg: 'success', data: { id: 'example-session', work_dir: '/tmp' }, request_id: 'example' });
      }
      return Response.json({ code: 0, msg: 'success', data: {}, request_id: 'example' });
    }, { source: 'manual', persist: true });

    await act(async () => { await requestScopeNavigation({ scope: direct, route: '/s/example-session' }).catch(() => {}); });

    expect(surfaceTitle()).toBe('nav.scope.failed.auth-required.title');
    const input = surface()?.querySelector<HTMLInputElement>('input[type="password"]');
    expect(input).not.toBeNull();

    await act(async () => { typeInto(input!, 'fresh-valid-token'); });
    const retryButton = Array.from(surface()?.querySelectorAll('button') ?? []).find((btn) => btn.textContent === 'nav.scope.retry');
    expect(retryButton).toBeDefined();
    await act(async () => { retryButton!.click(); });

    expect(seenHeaders).toContain(`${ADDRESS}/api/meta -> Bearer fresh-valid-token`);
    expect(surface()).toBeNull();
    expect(router.state.location.pathname).toBe('/s/example-session');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('kiki.connection') ?? '{}')).toMatchObject({
      url: ADDRESS,
      token: 'fresh-valid-token',
    });
  });

  it('persists the accepted typed token before reloading when returning from a remote space to a saved hand-entered address', async () => {
    await act(async () => { root?.unmount(); });
    router?.dispose();
    container.remove();
    clearNavHistory();
    localStorage.setItem('kiki.connection', JSON.stringify({ url: ADDRESS, token: 'stale-token' }));
    const direct = { homeId: 'main', scopeId: `direct:${ADDRESS}` };
    const remoteActive = { homeId: `remote:${CONNECTION}`, scopeId: `remote:${CONNECTION}` };
    connection.spaceKey = remoteActive.homeId;
    connection.scopeId = remoteActive.scopeId;
    connection.connectionId = CONNECTION;
    connection.meta = { server_home_id: REMOTE_HOME };
    await mount();

    const localSelection: ConnectionSelection = {
      config: { url: ADDRESS, token: 'stale-token' },
      persist: true,
      source: 'stored',
      scopeId: direct.scopeId,
    };
    const { seenHeaders, reload } = stubRealAdapter(remoteActive, (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      if (headers.get('authorization') !== 'Bearer rotated-token') {
        return Response.json({ code: 40101, msg: 'auth.invalid_token', data: null, request_id: 'example' }, { status: 401 });
      }
      if (url.endsWith('/api/meta')) {
        return Response.json({ code: 0, msg: 'success', data: { server_home_id: 'source-home' }, request_id: 'example' });
      }
      return Response.json({ code: 0, msg: 'success', data: {}, request_id: 'example' });
    }, {
      source: 'remote',
      local: { scope: direct, selection: localSelection },
    });

    await act(async () => { await requestScopeNavigation({ scope: direct, route: '/new' }).catch(() => {}); });
    expect(surfaceTitle()).toBe('nav.scope.failed.auth-required.title');
    const input = surface()?.querySelector<HTMLInputElement>('input[type="password"]');
    expect(input).not.toBeNull();

    await act(async () => { typeInto(input!, 'rotated-token'); });
    const retryButton = Array.from(surface()?.querySelectorAll('button') ?? []).find((btn) => btn.textContent === 'nav.scope.retry');
    await act(async () => { retryButton!.click(); });

    expect(seenHeaders).toContain(`${ADDRESS}/api/meta -> Bearer rotated-token`);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('kiki.connection') ?? '{}')).toEqual({
      url: ADDRESS,
      token: 'rotated-token',
    });
    const handoffRaw = sessionStorage.getItem('kiki.navScopeHandoff.v1') ?? '';
    expect(handoffRaw).not.toContain('rotated-token');
    expect(window.location.href).not.toContain('rotated-token');
  });

  it('keeps auth-required with an empty field and never writes a rejected typed token', async () => {
    await act(async () => { root?.unmount(); });
    router?.dispose();
    container.remove();
    clearNavHistory();
    localStorage.setItem('kiki.connection', JSON.stringify({ url: ADDRESS, token: 'original-saved-token' }));
    const direct = { homeId: 'main', scopeId: `direct:${ADDRESS}` };
    connection.spaceKey = 'main';
    connection.scopeId = direct.scopeId;
    connection.connectionId = null;
    connection.meta = { server_home_id: 'source-home' };
    await mount();
    const { seenHeaders } = stubRealAdapter(direct, () =>
      Response.json({ code: 40101, msg: 'auth.invalid_token', data: null, request_id: 'example' }, { status: 401 }),
      { source: 'stored', persist: true },
    );

    await act(async () => { await requestScopeNavigation({ scope: direct, route: '/s/example-session' }).catch(() => {}); });
    const input = surface()?.querySelector<HTMLInputElement>('input[type="password"]');
    expect(input).not.toBeNull();
    await act(async () => { typeInto(input!, 'wrong-token'); });
    const retryButton = Array.from(surface()?.querySelectorAll('button') ?? []).find((btn) => btn.textContent === 'nav.scope.retry');
    await act(async () => { retryButton!.click(); });

    expect(seenHeaders).toContain(`${ADDRESS}/api/meta -> Bearer wrong-token`);
    expect(surfaceTitle()).toBe('nav.scope.failed.auth-required.title');
    expect(surface()?.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
    expect(JSON.parse(localStorage.getItem('kiki.connection') ?? '{}')).toEqual({
      url: ADDRESS,
      token: 'original-saved-token',
    });
  });

  it.each(['web-cookie', 'app-shell'] as const)('never renders a token input when a %s session answers 401', async (nonTokenSource) => {
    await act(async () => { root?.unmount(); });
    router?.dispose();
    container.remove();
    clearNavHistory();
    const direct = { homeId: 'main', scopeId: `direct:${ADDRESS}` };
    connection.spaceKey = 'main';
    connection.scopeId = direct.scopeId;
    connection.connectionId = null;
    connection.meta = { server_home_id: 'source-home' };
    await mount();
    stubRealAdapter(direct, () =>
      Response.json({ code: 40101, msg: 'auth.invalid_token', data: null, request_id: 'example' }, { status: 401 }),
      { source: nonTokenSource, persist: false },
    );

    await act(async () => { await requestScopeNavigation({ scope: direct, route: '/s/example-session' }).catch(() => {}); });

    expect(surface()?.querySelector<HTMLElement>('h1')?.dataset['navScopeFailure']).toBe('session-expired');
    expect(surfaceTitle()).toBe('nav.scope.failed.session-expired.title');
    expect(surface()?.querySelector('input')).toBeNull();
    const retryButton = Array.from(surface()?.querySelectorAll('button') ?? []).find((btn) => btn.textContent === 'nav.scope.retry');
    expect(retryButton).toBeDefined();
  });
});
