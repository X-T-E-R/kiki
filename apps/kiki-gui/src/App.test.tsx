import { QueryClient } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SESSION_FIRST_PAGE_POLL_INTERVAL_MS, isEditableTarget } from './App';
import { retryRootReadModelDelay, retryRootReadModelQuery } from './lib/readModelRetry';
import { resolveFallbackPhase } from './components/ConversationShell';
import { ApiError } from './lib/client';
import { shouldGuardNavigation } from './components/dirtyGuard';
import { handleGlobalConnectionFrame, refreshSessionAttention } from './state/connection';

// App pulls the whole route tree; only the SessionView branch needs xterm
// (no `self` under node) and none of it is under test here.
vi.mock('./components/SessionView', () => ({ SessionRouteView: () => null }));

/**
 * `isEditableTarget` decides which global shortcuts yield to the focused
 * input surface (Ctrl+Tab session hopping) and which stay app-wide. Node has
 * no DOM classes, so the test stubs the minimum set the helper consults.
 */
const eventTargetStub = {
  addEventListener: () => {},
  dispatchEvent: () => false,
  removeEventListener: () => {},
};

class FakeInput implements EventTarget {
  readonly addEventListener = eventTargetStub.addEventListener;
  readonly dispatchEvent = eventTargetStub.dispatchEvent;
  readonly removeEventListener = eventTargetStub.removeEventListener;
}
class FakeTextArea extends FakeInput {}
class FakeSelect extends FakeInput {}
class FakeElement implements EventTarget {
  readonly addEventListener = eventTargetStub.addEventListener;
  readonly dispatchEvent = eventTargetStub.dispatchEvent;
  readonly removeEventListener = eventTargetStub.removeEventListener;
  isContentEditable = false;
}
class FakeEditableDiv extends FakeElement {
  override isContentEditable = true;
}
class FakePlainDiv extends FakeElement {}

beforeAll(() => {
  vi.stubGlobal('HTMLInputElement', FakeInput);
  vi.stubGlobal('HTMLTextAreaElement', FakeTextArea);
  vi.stubGlobal('HTMLSelectElement', FakeSelect);
  vi.stubGlobal('HTMLElement', FakeElement);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('isEditableTarget', () => {
  it('recognizes every editable focus surface', () => {
    expect(isEditableTarget(new FakeInput())).toBe(true);
    expect(isEditableTarget(new FakeTextArea())).toBe(true);
    expect(isEditableTarget(new FakeSelect())).toBe(true);
    expect(isEditableTarget(new FakeEditableDiv())).toBe(true);
  });

  it('lets plain surfaces through so global shortcuts keep working', () => {
    expect(isEditableTarget(new FakePlainDiv())).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({ ...eventTargetStub })).toBe(false);
  });
});

describe('session first-page polling', () => {
  it('spaces first-page refreshes to a 15-second visible interval', () => {
    expect(SESSION_FIRST_PAGE_POLL_INTERVAL_MS).toBe(15_000);
  });
});

describe('root read-model query retry', () => {
  it('recovers a query after a long initial index build', async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    let attempts = 0;
    try {
      const result = client.fetchQuery({
        queryKey: ['long-index-build'],
        queryFn: () => {
          attempts += 1;
          if (attempts <= 10) throw new ApiError({ code: 40939, msg: 'session index is building', data: null });
          return ['ready'];
        },
        retry: retryRootReadModelQuery,
        retryDelay: retryRootReadModelDelay,
      });
      await vi.advanceTimersByTimeAsync(35_000);
      expect(await result).toEqual(['ready']);
      expect(attempts).toBe(11);
    } finally {
      client.clear();
      vi.useRealTimers();
    }
  });

  it('waits while the server reports building without an arbitrary retry-count gate', () => {
    const building = new ApiError({ code: 40939, msg: 'session index is building', data: null });
    expect(retryRootReadModelQuery(0, building)).toBe(true);
    expect(retryRootReadModelQuery(5, building)).toBe(true);
    expect(retryRootReadModelQuery(1_000, building)).toBe(true);
    expect([0, 1, 2, 3, 4, 5, 1_000].map(retryRootReadModelDelay)).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
    expect(
      retryRootReadModelQuery(
        0,
        new ApiError({ code: 50001, msg: 'internal error', data: null }),
      ),
    ).toBe(false);
    expect(retryRootReadModelQuery(0, new Error('network failed'))).toBe(false);
  });
});

describe('app navigation dirty guard', () => {
  const current = { pathname: '/settings/providers', search: '', hash: '' };

  it('guards application-level routes while allowing clean and no-op navigation', () => {
    expect(shouldGuardNavigation(current, '/capabilities', true)).toBe(true);
    expect(shouldGuardNavigation(current, '/s/example', true)).toBe(true);
    expect(shouldGuardNavigation(current, '/settings/providers', true)).toBe(false);
    expect(shouldGuardNavigation(current, '/capabilities', false)).toBe(false);
  });
});

describe('discovery route and dirty guard navigation', () => {
  it('guards transitions to /discover when dirty form is active', () => {
    const current = { pathname: '/settings/providers', search: '', hash: '' };
    expect(shouldGuardNavigation(current, '/discover', true)).toBe(true);
    expect(shouldGuardNavigation(current, '/discover', false)).toBe(false);
  });

  it('preserves discovery state and prevents route advance when dirty guard rejects', async () => {
    const { navigateDiscovery } = await import('@kiki/session-core/discovery');
    const state = {
      version: 1 as const,
      contentVersion: 1,
      lifecycle: 'active' as const,
      route: 'overview' as const,
      station: 'workspace' as const,
      collapsed: false,
      progress: {},
    };
    const context = {
      online: true,
      currentHref: '/new',
      anchors: ['workspace-picker' as const],
    };
    const cancelledPort = {
      navigate: vi.fn(async () => 'cancelled' as const),
    };
    const result = await navigateDiscovery(state, { type: 'next' }, context, cancelledPort);
    expect(result.outcome).toBe('cancelled');
    expect(result.state.station).toBe('workspace');
    expect(cancelledPort.navigate).toHaveBeenCalled();
  });
});

describe('conversation shell fallback phase', () => {
  it('opens /new as the hero and a session route as settling until its seat registers', () => {
    expect(resolveFallbackPhase(true)).toBe('hero');
    expect(resolveFallbackPhase(false)).toBe('settling');
  });
});

describe('connection-level activity refresh', () => {
  it('refreshes sessions, room summaries and the affected activity queries without unrelated session polling', () => {
    const queryClient = { invalidateQueries: vi.fn(async () => undefined) };
    refreshSessionAttention(queryClient, 'example-session');
    expect(queryClient.invalidateQueries.mock.calls).toEqual([
      [{ queryKey: ['sessions'] }],
      [{ queryKey: ['rooms'] }],
      [{ queryKey: ['activity-prompts', 'example-session'] }],
      [{ queryKey: ['activity-tasks', 'example-session'] }],
    ]);
  });
});

describe('connection-level model catalog refresh', () => {
  it('invalidates catalog lists and editor entities without invalidating unrelated queries', () => {
    const queryClient = new QueryClient();
    const catalogKeys = [
      ['models'],
      ['providers'],
      ['model-entity', 'example-model'],
      ['provider-entity', 'example-provider'],
      ['discovered-models'],
    ];
    const unrelatedKeys = [['sessions'], ['rooms'], ['config']];
    for (const queryKey of [...catalogKeys, ...unrelatedKeys]) {
      queryClient.setQueryData(queryKey, {});
    }
    try {
      expect(handleGlobalConnectionFrame({ type: 'event.model_catalog.changed' }, queryClient)).toBe(true);
      for (const queryKey of catalogKeys) {
        expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
      }
      for (const queryKey of unrelatedKeys) {
        expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
      }
    } finally {
      queryClient.clear();
    }
  });

  it('does not handle session frames', () => {
    const queryClient = { invalidateQueries: vi.fn(async () => undefined) };

    expect(handleGlobalConnectionFrame({ type: 'turn.ended' }, queryClient)).toBe(false);
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });
});
