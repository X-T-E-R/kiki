// @vitest-environment jsdom
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

const id = '11111111-1111-4111-8111-111111111111';
const scope = { homeId: `remote:${id}`, scopeId: `remote:${id}` };
const mocks = vi.hoisted(() => ({ open: vi.fn<(...args: [string]) => Promise<void>>(), prepare: vi.fn() }));
vi.mock('../host', () => { const host = { kind: 'tauri', connection: {}, openRemoteSpace: mocks.open }; return { useHost: () => host }; });
vi.mock('../state/connection', () => {
  const connection = { spaceKey: 'main', scopeId: 'local', connectionId: null, meta: { server_home_id: 'source-home' },
    needsScopeReload: false, scopeAdapter: { prepare: mocks.prepare } };
  return { useConnection: () => connection };
});
vi.mock('../i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));

let root: Root | undefined;
let container: HTMLDivElement;
let guard: DirtyGuardState;
let router: ReturnType<typeof createMemoryRouter>;
function Source() {
  const location = useLocation(); const action = useNavigationType();
  guard = useDirtyGuardState(location, () => {});
  useLayoutEffect(() => { recordNavigation({ location, action, scope: { homeId: 'main', scopeId: 'local', serverHomeId: 'source-home' } }); }, [location, action]);
  return <div data-source><input data-draft defaultValue="source draft" /></div>;
}
async function mount() {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  router = createMemoryRouter([{ path: '*', element: <NavScopeBoundary><Source /></NavScopeBoundary> }], { initialEntries: ['/new'] });
  await act(async () => { root!.render(<RouterProvider router={router} />); });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  clearNavHistory(); configureSpaceStorage(null); resetLaunchWindowMode(); writeDesktopPrefs({ windowMode: 'windows' });
  mocks.open.mockReset().mockResolvedValue(undefined); mocks.prepare.mockReset();
});
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; router?.dispose(); container?.remove(); configureSpaceStorage(null); });

function sourceState() {
  const input = container.querySelector<HTMLInputElement>('[data-draft]')!;
  return { input, source: container.querySelector('[data-source]'), visit: getCurrentVisit(), route: router.state.location };
}
function expectSourceUnchanged(before: ReturnType<typeof sourceState>) {
  expect(container.querySelector('[data-source]')).toBe(before.source);
  expect(container.querySelector('[data-draft]')).toBe(before.input);
  expect(before.input.value).toBe('unsaved source draft');
  expect(getCurrentVisit()?.visitId).toBe(before.visit?.visitId);
  expect(router.state.location).toBe(before.route);
  expect(mocks.prepare).not.toHaveBeenCalled();
}

describe('remote windows-mode guarded entry', () => {
  it('opens a separate window through the Host without a source scope or route commit', async () => {
    await mount(); const before = sourceState(); before.input.value = 'unsaved source draft';
    await act(async () => { await requestScopeNavigation(scope); });
    expect(mocks.open.mock.calls).toEqual([[id]]);
    expectSourceUnchanged(before);
  });

  it('keeps the source DOM, draft and visit when opening the window fails', async () => {
    await mount(); const before = sourceState(); before.input.value = 'unsaved source draft';
    mocks.open.mockRejectedValueOnce(new Error('native window unavailable'));
    await act(async () => { await expect(requestScopeNavigation(scope)).rejects.toThrow('native window unavailable'); });
    expectSourceUnchanged(before);
  });

  it('keeps the source intact when an in-flight open is cancelled before acknowledgement', async () => {
    await mount(); const before = sourceState(); before.input.value = 'unsaved source draft';
    let finish!: () => void;
    mocks.open.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    let pending!: Promise<unknown>;
    await act(async () => { pending = requestScopeNavigation(scope).catch((error: unknown) => error); });
    expect(mocks.open).toHaveBeenCalledOnce();
    await act(async () => { guard.cancel(); finish(); });
    await expect(pending).resolves.toMatchObject({ name: 'AbortError' });
    expectSourceUnchanged(before);
  });

  it('cancels the existing dirty guard before any native open or source commit', async () => {
    await mount(); const before = sourceState(); before.input.value = 'unsaved source draft';
    await act(async () => { guard.value.reportDirty('source-editor', true); });
    await act(async () => { await requestScopeNavigation(scope); });
    expect(guard.pending).toBe(true); expect(mocks.open).not.toHaveBeenCalled();
    await act(async () => { guard.cancel(); });
    expect(guard.pending).toBe(false); expect(mocks.open).not.toHaveBeenCalled();
    expectSourceUnchanged(before);
  });
});
