// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLastSessionId, writeLastSessionId } from '@kiki/session-core/settings';
import { configureSpaceStorage } from '../lib/spaceStorage';
import { readSpaceViewRoute, writeSpaceViewRoute } from '../lib/spaceViewState';
import { API_CODES, ApiError } from '../lib/client';
import { SpaceViewMemory, SpaceViewState } from './SpaceViewState';

const getSession = vi.fn();
const getRoom = vi.fn();
const host = { kind: 'tauri' };
const scope = { id: 'local' };
let navigateRoute: NavigateFunction;
vi.mock('../host', () => ({ useHost: () => host }));
vi.mock('../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../state/connection', () => ({
  useConnection: () => ({ scopeId: scope.id, client: { getSession, klient: { rest: { rooms: { get: getRoom } } } } }),
}));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
const mounted = vi.fn();
function TargetPage() {
  useEffect(() => { mounted(); }, []);
  return <div data-target>Target page</div>;
}
function Location() {
  const location = useLocation();
  navigateRoute = useNavigate();
  return <output data-state={JSON.stringify(location.state)}>{location.pathname}{location.search}{location.hash}</output>;
}
async function flush() {
  await act(async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render(route: string, state?: Record<string, unknown>) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[state === undefined ? route : { pathname: route, state }]}>
          <Location />
          <SpaceViewMemory />
          <Routes>
            <Route path="/new" element={<div data-home>Home</div>} />
            <Route path="/usage" element={<div>Usage</div>} />
            <Route path="*" element={<SpaceViewState><TargetPage /></SpaceViewState>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  getSession.mockReset();
  getRoom.mockReset();
  mounted.mockClear();
  configureSpaceStorage(null);
  localStorage.clear();
  sessionStorage.clear();
  host.kind = 'tauri';
  scope.id = 'local';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  queryClient.clear();
  container.remove();
  configureSpaceStorage(null);
  vi.unstubAllGlobals();
});

describe('space view route validation', () => {
  it.each(['/s/deleted', '/s/deleted/tasks?filter=running'])('falls back from %s without mounting the missing session or tasks page', async (route) => {
    writeLastSessionId('deleted');
    writeSpaceViewRoute(route);
    getSession.mockRejectedValue(new ApiError({ code: API_CODES.SESSION_NOT_FOUND, msg: 'session.not_found', data: null }));
    await render(route);
    expect(container.querySelector('output')?.textContent).toBe('/new');
    expect(container.querySelector('[data-home]')).not.toBeNull();
    expect(mounted).not.toHaveBeenCalled();
    expect(readLastSessionId()).toBeUndefined();
    expect(readSpaceViewRoute()).toBe('/new');
  });

  it('waits for the target server rather than interpreting sidebar pagination as missing', async () => {
    let settle!: (session: unknown) => void;
    getSession.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    await render('/s/older-session?agent=main#turn');
    expect(mounted).not.toHaveBeenCalled();
    expect(readSpaceViewRoute()).toBeUndefined();
    await act(async () => { settle({ id: 'older-session' }); });
    await flush();
    expect(mounted).toHaveBeenCalledOnce();
    expect(readSpaceViewRoute()).toBe('/s/older-session?agent=main#turn');
  });

  it.each(['/rooms/deleted', '/r/deleted'])('falls back from a deleted room link %s', async (route) => {
    getRoom.mockResolvedValue(undefined);
    await render(route);
    expect(container.querySelector('output')?.textContent).toBe('/new');
    expect(mounted).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('does not silently discard a saved route for a transient connection error', async () => {
    writeSpaceViewRoute('/s/existing');
    getSession.mockRejectedValue(new Error('network unavailable'));
    await render('/s/existing');
    expect(container.querySelector('output')?.textContent).toBe('/s/existing');
    expect(readSpaceViewRoute()).toBe('/s/existing');
    expect(mounted).toHaveBeenCalledOnce();
  });

  it('validates a stale cached success again before mounting', async () => {
    queryClient.setQueryData(['space-view-target', 'local', 'session', 'deleted'], true);
    getSession.mockRejectedValue(new ApiError({ code: API_CODES.SESSION_NOT_FOUND, msg: 'session.not_found', data: null }));
    await render('/s/deleted');
    expect(mounted).not.toHaveBeenCalled();
    expect(container.querySelector('output')?.textContent).toBe('/new');
  });

  it.each([{}, { initialPrompt: 'Continue' }, { initialSkill: { name: 'inspect', args: '' } }])(
    'admits a just-created target once and consumes only its creation fact (%j)', async (handoff) => {
      queryClient.setQueryData(['space-view-target', 'local', 'session', 'created'], true);
      let settle!: (session: unknown) => void;
      getSession.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
      await render('/usage');
      await act(async () => { await navigateRoute('/s/created', { state: { ...handoff, createdSession: { id: 'created', scopeId: 'local' } } }); });
      await flush();
      expect(mounted).toHaveBeenCalledOnce();
      expect(JSON.parse(container.querySelector('output')!.getAttribute('data-state')!)).toEqual(handoff);
      const node = container.querySelector('[data-target]');
      await act(async () => { settle({ id: 'created' }); });
      await flush();
      expect(container.querySelector('[data-target]')).toBe(node);
      expect(mounted).toHaveBeenCalledOnce();
      await act(async () => { await navigateRoute('/usage'); });
      expect(container.querySelector('[data-target]')).toBeNull();
      getSession.mockImplementation(() => new Promise(() => {}));
      await act(async () => { await navigateRoute(-1); });
      await flush();
      expect(container.querySelector('[data-target]')).toBeNull();
      expect(mounted).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { id: 'created', scopeId: 'other-space' },
    { id: 'other-session', scopeId: 'local' },
  ])('does not admit a creation from a different target (%j)', async (createdSession) => {
    queryClient.setQueryData(['space-view-target', 'local', 'session', 'created'], true);
    getSession.mockImplementation(() => new Promise(() => {}));
    await render('/s/created', { createdSession });
    expect(mounted).not.toHaveBeenCalled();
  });

  it('keeps an admitted target mounted during refresh but still exits on a definite deletion', async () => {
    getSession.mockResolvedValue({ id: 'existing' });
    await render('/s/existing');
    const node = container.querySelector('[data-target]');
    expect(mounted).toHaveBeenCalledOnce();
    let fail!: (error: Error) => void;
    getSession.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    await act(async () => { void queryClient.invalidateQueries({ queryKey: ['space-view-target'] }); });
    await flush();
    expect(container.querySelector('[data-target]')).toBe(node);
    expect(mounted).toHaveBeenCalledOnce();
    await act(async () => { fail(new ApiError({ code: API_CODES.SESSION_NOT_FOUND, msg: 'session.not_found', data: null })); });
    await flush();
    expect(container.querySelector('output')?.textContent).toBe('/new');
    expect(container.querySelector('[data-target]')).toBeNull();
  });

  it('does not carry an admitted target across a scope switch', async () => {
    getSession.mockResolvedValue({ id: 'existing' });
    await render('/s/existing');
    expect(mounted).toHaveBeenCalledOnce();
    scope.id = 'other-space';
    getSession.mockImplementation(() => new Promise(() => {}));
    await render('/s/existing');
    expect(container.querySelector('[data-target]')).toBeNull();
    expect(mounted).toHaveBeenCalledOnce();
  });

  it('persists id-free pages in the active space without probing a session', async () => {
    configureSpaceStorage({ homeId: 'space-b' });
    await render('/usage?range=month#cost');
    expect(readSpaceViewRoute()).toBe('/usage?range=month#cost');
    expect(getSession).not.toHaveBeenCalled();
    configureSpaceStorage(null);
    expect(readSpaceViewRoute()).toBeUndefined();
  });

  it('keeps browser routes safe without enabling desktop route restoration', async () => {
    host.kind = 'browser';
    getSession.mockRejectedValue(new ApiError({ code: API_CODES.SESSION_NOT_FOUND, msg: 'session.not_found', data: null }));
    await render('/s/foreign');
    expect(container.querySelector('output')?.textContent).toBe('/new');
    expect(readSpaceViewRoute()).toBeUndefined();
  });
});
