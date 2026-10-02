// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLastSessionId, writeLastSessionId } from '@kiki/session-core/settings';
import { configureSpaceStorage } from '../lib/spaceStorage';
import { readSpaceViewRoute, writeSpaceViewRoute } from '../lib/spaceViewState';
import { API_CODES, ApiError } from '../lib/client';
import { SpaceViewMemory, SpaceViewState } from './SpaceViewState';

const getSession = vi.fn();
const getRoom = vi.fn();
const host = { kind: 'tauri' };
vi.mock('../host', () => ({ useHost: () => host }));
vi.mock('../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../state/connection', () => ({
  useConnection: () => ({ scopeId: 'local', client: { getSession, klient: { rest: { rooms: { get: getRoom } } } } }),
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
  return <output>{location.pathname}{location.search}{location.hash}</output>;
}
async function flush() {
  await act(async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render(route: string) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>
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
