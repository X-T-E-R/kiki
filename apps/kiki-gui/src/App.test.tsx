import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { isEditableTarget } from './App';

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
