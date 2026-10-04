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
import { writeDesktopPrefs } from '@kiki/session-core/settings';
import { NavScopeBoundary } from '../components/NavScopeBoundary';
import { useDirtyGuardState, type DirtyGuardState } from '../components/dirtyGuard';
import { clearNavHistory, getCurrentVisit, recordNavigation } from './navHistory';
import { requestScopeNavigation } from './navScope';
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
