// @vitest-environment jsdom

import { act, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { clearNavHistory, recordNavigation, canGoBack, getBackEntry, getCurrentVisit, saveUiSnapshot, getUiSnapshot } from '../lib/navHistory';
import { NavBackButton, NavHistoryBridge } from './NavBackButton';
import { DirtyGuardContext, useDirtyGuardState, type GuardedNavigate } from './dirtyGuard';

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];

function mountRoot(container: HTMLDivElement): Root {
  const root = createRoot(container);
  roots.push(root);
  return root;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearNavHistory();
  localStorage.setItem('kiki.locale', 'en');
});

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  localStorage.removeItem('kiki.locale');
});

describe('NavBackButton N1 integration', () => {
  it('does not render on cold deep links (no fake back)', () => {
    const container = document.createElement('div');
    containers.push(container);
    document.body.appendChild(container);

    // Initial cold navigation
    recordNavigation({
      location: { pathname: '/usage', search: '', hash: '', key: 'cold1' },
      scope: { homeId: 'main', scopeId: 'local' },
      label: 'Usage',
    });

    const root = mountRoot(container);
    act(() => {
      root.render(
        <I18nProvider>
          <MemoryRouter initialEntries={['/usage']}>
            <NavBackButton />
          </MemoryRouter>
        </I18nProvider>,
      );
    });

    expect(canGoBack()).toBe(false);
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders and displays correct label when navigated from settings to usage', () => {
    const container = document.createElement('div');
    containers.push(container);
    document.body.appendChild(container);

    // Step 1: Visit Settings
    recordNavigation({
      location: { pathname: '/settings', search: '', hash: '', key: 'k1' },
      scope: { homeId: 'main', scopeId: 'local' },
      label: 'Settings',
      action: 'PUSH',
    });

    // Step 2: Visit Usage from Settings
    recordNavigation({
      location: { pathname: '/usage', search: '', hash: '', key: 'k2' },
      scope: { homeId: 'main', scopeId: 'local' },
      label: 'Usage',
      action: 'PUSH',
    });

    expect(canGoBack()).toBe(true);
    const back = getBackEntry();
    expect(back?.pathname).toBe('/settings');
    expect(back?.label).toBe('Settings');

    const root = mountRoot(container);
    act(() => {
      root.render(
        <I18nProvider>
          <MemoryRouter initialEntries={['/settings', '/usage']} initialIndex={1}>
            <NavBackButton />
          </MemoryRouter>
        </I18nProvider>,
      );
    });

    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-label')).toContain('Settings');
  });

  it('preserves and restores snapshot metadata across visits', () => {
    const entry1 = recordNavigation({
      location: { pathname: '/settings/ai', search: '?tab=models', hash: '', key: 's1' },
      scope: { homeId: 'main', scopeId: 'local' },
      label: 'Settings · AI',
      action: 'PUSH',
    });

    saveUiSnapshot(entry1.visitId, { scrollTop: 420, activeTab: 'models' });

    const entry2 = recordNavigation({
      location: { pathname: '/usage', search: '?dimension=session', hash: '', key: 's2' },
      scope: { homeId: 'main', scopeId: 'local' },
      label: 'Usage',
      action: 'PUSH',
    });

    saveUiSnapshot(entry2.visitId, { selectedBucketKey: 'bucket-2026-10-03' });

    const snap1 = getUiSnapshot<{ scrollTop: number; activeTab: string }>(entry1.visitId);
    expect(snap1?.scrollTop).toBe(420);
    expect(snap1?.activeTab).toBe('models');

    const snap2 = getUiSnapshot<{ selectedBucketKey: string }>(entry2.visitId);
    expect(snap2?.selectedBucketKey).toBe('bucket-2026-10-03');
  });

  it('triggers dirtyGuard when back button is clicked while dirty', () => {
    const container = document.createElement('div');
    containers.push(container);
    document.body.appendChild(container);

    recordNavigation({
      location: { pathname: '/settings', search: '', hash: '', key: 'k1' },
      scope: { homeId: 'main', scopeId: 'local' },
      label: 'Settings',
      action: 'PUSH',
    });
    recordNavigation({
      location: { pathname: '/settings/ai', search: '', hash: '', key: 'k2' },
      scope: { homeId: 'main', scopeId: 'local' },
      label: 'AI Settings',
      action: 'PUSH',
    });

    const guardedNavMock = vi.fn();
    const dirtyGuardValue = {
      dirty: true,
      reportDirty: vi.fn(),
      navigate: guardedNavMock,
    };

    const root = mountRoot(container);
    act(() => {
      root.render(
        <I18nProvider>
          <DirtyGuardContext.Provider value={dirtyGuardValue}>
            <MemoryRouter initialEntries={['/settings', '/settings/ai']} initialIndex={1}>
              <NavBackButton />
            </MemoryRouter>
          </DirtyGuardContext.Provider>
        </I18nProvider>,
      );
    });

    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    act(() => {
      button?.click();
    });

    expect(guardedNavMock).toHaveBeenCalledWith(-1);
  });
});

const scope = { homeId: 'main', scopeId: 'local' };

function RestoredVisit() {
  const location = useLocation();
  const [restored, setRestored] = useState<string | null>(null);
  useEffect(() => { setRestored(getCurrentVisit()?.pathname ?? null); }, [location.key]);
  return <span data-restored>{restored}</span>;
}

function RouterGuardHarness({ action, actionTarget = '/usage' }: { action?: (signal: AbortSignal) => void | Promise<void>; actionTarget?: string | number }) {
  const [error, setError] = useState('');
  const location = useLocation();
  const navType = useNavigationType();
  const rawNavigate = useNavigate();
  const performNavigation = useCallback<GuardedNavigate>((target, options) => {
    if (typeof target === 'number') void rawNavigate(target);
    else void rawNavigate(target, options);
  }, [rawNavigate]);
  const guard = useDirtyGuardState(location, performNavigation);
  useLayoutEffect(() => { recordNavigation({ location, action: navType, scope }); }, [location, navType]);
  return (
    <DirtyGuardContext.Provider value={guard.value}>
      <NavHistoryBridge>
        <NavBackButton />
        <RestoredVisit />
        <button data-push onClick={() => { guard.navigate('/settings/developer'); }}>Developer</button>
        <button data-dirty onClick={() => { guard.value.reportDirty('editor', true); }}>Edit</button>
        <button data-action onClick={() => { if (action) void guard.value.runAction?.(action, actionTarget); }}>Switch</button>
        <output data-action-error>{error}</output><output data-dirty-state>{String(guard.value.dirty)}</output>
        <input data-action-draft defaultValue="unsaved action draft" />
        {guard.pending ? <div role="alertdialog">
          <button data-cancel onClick={guard.cancel}>Stay</button>
          <button data-confirm onClick={() => { void Promise.resolve().then(guard.confirm).catch((error: unknown) => { setError(String(error)); }); }}>Leave</button>
        </div> : null}
      </NavHistoryBridge>
    </DirtyGuardContext.Provider>
  );
}

function testContainer(): HTMLDivElement {
  const container = document.createElement('div');
  containers.push(container);
  document.body.appendChild(container);
  return container;
}

function click(container: HTMLDivElement, selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  button!.click();
}

describe('N1 reactive history and data-router guard regressions', () => {
  it('removes a subscribed bridge back arrow when POP reaches the first visit', () => {
    const first = recordNavigation({ location: { pathname: '/settings/general', key: 'a', search: '', hash: '' }, scope });
    recordNavigation({ location: { pathname: '/usage', key: 'b', search: '', hash: '' }, scope });
    const container = testContainer();
    const root = mountRoot(container);
    act(() => { root.render(<I18nProvider><MemoryRouter><NavHistoryBridge><NavBackButton /></NavHistoryBridge></MemoryRouter></I18nProvider>); });
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Back to Settings');
    // No location render is supplied: the store notification alone must update.
    act(() => { recordNavigation({ location: first, scope, action: 'POP' }); });
    expect(canGoBack()).toBe(false);
    expect(container.querySelector('button')).toBeNull();
  });

  it('localizes a source entry recorded in English for the current Chinese locale', () => {
    recordNavigation({ location: { pathname: '/settings/general', key: 'a', search: '', hash: '' }, scope, label: 'Settings' });
    recordNavigation({ location: { pathname: '/usage', key: 'b', search: '', hash: '' }, scope });
    localStorage.setItem('kiki.locale', 'zh');
    const container = testContainer();
    const root = mountRoot(container);
    act(() => { root.render(<I18nProvider><MemoryRouter><NavBackButton /></MemoryRouter></I18nProvider>); });
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('返回到 设置');
  });

  it('restores the target before child effects and cancels/proceeds an unwrapped POP', async () => {
    const container = testContainer();
    const root = mountRoot(container);
    const router = createMemoryRouter([{ path: '*', element: <RouterGuardHarness /> }], { initialEntries: ['/settings/general'] });
    await act(async () => { root.render(<I18nProvider><RouterProvider router={router} /></I18nProvider>); });
    expect(container.querySelector('[data-restored]')?.textContent).toBe('/settings/general');
    await act(async () => { click(container, '[data-push]'); });
    expect(container.querySelector('[data-restored]')?.textContent).toBe('/settings/developer');
    act(() => { click(container, '[data-dirty]'); });
    const visitBefore = getCurrentVisit();
    const stateBefore = sessionStorage.getItem('kiki.navHistory.v1');
    // Unwrapped router traversal models browser Back, not the guarded arrow.
    await act(async () => { await router.navigate(-1); });
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(router.state.location.pathname).toBe('/settings/developer');
    expect(getCurrentVisit()).toEqual(visitBefore);
    act(() => { click(container, '[data-cancel]'); });
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(router.state.location.pathname).toBe('/settings/developer');
    expect(sessionStorage.getItem('kiki.navHistory.v1')).toBe(stateBefore);
    await act(async () => { await router.navigate(-1); });
    await act(async () => { click(container, '[data-confirm]'); });
    expect(router.state.location.pathname).toBe('/settings/general');
    expect(container.querySelector('[data-restored]')?.textContent).toBe('/settings/general');
    expect(container.querySelector('button[aria-label^="Back"]')).toBeNull();
    router.dispose();
  });

  it('runs a guarded async action once and navigates without a second dirty prompt', async () => {
    const action = vi.fn(async () => {});
    const container = testContainer();
    const root = mountRoot(container);
    const router = createMemoryRouter([{ path: '*', element: <RouterGuardHarness action={action} /> }], { initialEntries: ['/settings/general'] });
    await act(async () => { root.render(<I18nProvider><RouterProvider router={router} /></I18nProvider>); });
    act(() => { click(container, '[data-dirty]'); });
    act(() => { click(container, '[data-action]'); });
    expect(action).not.toHaveBeenCalled();
    await act(async () => { click(container, '[data-confirm]'); });
    expect(action).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe('/usage');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    router.dispose();
  });
});

describe('N1 POP and K02 AbortSignal integration', () => {
  it.each(['throw', 'reject'] as const)('keeps a %s action dirty with no second router prompt or stale replay', async (failure) => {
    const action = vi.fn(() => {
      if (failure === 'throw') throw new Error('Local control failed');
      return Promise.reject(new Error('Local control failed'));
    });
    const container = testContainer();
    const root = mountRoot(container);
    const router = createMemoryRouter([{ path: '*', element: <RouterGuardHarness action={action} /> }], { initialEntries: ['/settings/general'] });
    await act(async () => { root.render(<I18nProvider><RouterProvider router={router} /></I18nProvider>); });
    act(() => { click(container, '[data-dirty]'); });
    act(() => { click(container, '[data-action]'); });
    await act(async () => { click(container, '[data-confirm]'); click(container, '[data-confirm]'); });
    expect(action).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe('/settings/general');
    expect(container.querySelector('[data-action-error]')?.textContent).toContain('Local control failed');
    expect(container.querySelector('[data-dirty-state]')?.textContent).toBe('true');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    act(() => { click(container, '[data-action]'); });
    act(() => { click(container, '[data-cancel]'); });
    expect(action).toHaveBeenCalledTimes(1);
    router.dispose();
  });

  it('cancels an active action when an unwrapped POP replaces its confirmation seat', async () => {
    let resolve!: () => void;
    let signal!: AbortSignal;
    const action = vi.fn((next: AbortSignal) => { signal = next; return new Promise<void>((done) => { resolve = done; }); });
    const container = testContainer();
    const root = mountRoot(container);
    const router = createMemoryRouter([{ path: '*', element: <RouterGuardHarness action={action} /> }], { initialEntries: ['/settings/general'] });
    await act(async () => { root.render(<I18nProvider><RouterProvider router={router} /></I18nProvider>); });
    await act(async () => { click(container, '[data-push]'); });
    act(() => { click(container, '[data-dirty]'); });
    act(() => { click(container, '[data-action]'); });
    await act(async () => { click(container, '[data-confirm]'); click(container, '[data-confirm]'); });
    expect(action).toHaveBeenCalledTimes(1);
    const snapshot = sessionStorage.getItem('kiki.navHistory.v1');
    await act(async () => { await router.navigate(-1); });
    expect(signal.aborted).toBe(true);
    act(() => { click(container, '[data-cancel]'); });
    await act(async () => { resolve(); });
    expect(router.state.location.pathname).toBe('/settings/developer');
    expect(sessionStorage.getItem('kiki.navHistory.v1')).toBe(snapshot);
    expect(container.querySelector<HTMLInputElement>('[data-action-draft]')?.value).toBe('unsaved action draft');
    expect(container.querySelector('[data-dirty-state]')?.textContent).toBe('true');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    router.dispose();
  });

  it('finishes a confirmed async delta action once without prompting again', async () => {
    const action = vi.fn(async () => {});
    const container = testContainer();
    const root = mountRoot(container);
    const router = createMemoryRouter([{ path: '*', element: <RouterGuardHarness action={action} actionTarget={-1} /> }], { initialEntries: ['/settings/general'] });
    await act(async () => { root.render(<I18nProvider><RouterProvider router={router} /></I18nProvider>); });
    await act(async () => { click(container, '[data-push]'); });
    act(() => { click(container, '[data-dirty]'); });
    act(() => { click(container, '[data-action]'); });
    await act(async () => { click(container, '[data-confirm]'); click(container, '[data-confirm]'); });
    expect(action).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe('/settings/general');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    router.dispose();
  });
});
