import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { isEditableTarget, retryRootReadModelQuery } from './App';
import { resolveFallbackPhase } from './components/ConversationShell';
import { ApiError } from './lib/client';
import { shouldGuardNavigation } from './components/dirtyGuard';
import { handleGlobalConnectionFrame } from './state/connection';

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

describe('root read-model query retry', () => {
  it('keeps loading only while the session index is building', () => {
    expect(
      retryRootReadModelQuery(
        4,
        new ApiError({ code: 40939, msg: 'session index is building', data: null }),
      ),
    ).toBe(true);
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

describe('conversation shell fallback phase', () => {
  it('opens /new as the hero and a session route as settling until its seat registers', () => {
    expect(resolveFallbackPhase(true)).toBe('hero');
    expect(resolveFallbackPhase(false)).toBe('settling');
  });
});

describe('connection-level model catalog refresh', () => {
  it('invalidates only the models and providers queries for the global event', () => {
    const queryClient = { invalidateQueries: vi.fn(async () => undefined) };

    expect(handleGlobalConnectionFrame({ type: 'event.model_catalog.changed' }, queryClient)).toBe(
      true,
    );
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
    expect(queryClient.invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: ['models'] });
    expect(queryClient.invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: ['providers'] });
  });

  it('does not handle session frames', () => {
    const queryClient = { invalidateQueries: vi.fn(async () => undefined) };

    expect(handleGlobalConnectionFrame({ type: 'turn.ended' }, queryClient)).toBe(false);
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });
});
