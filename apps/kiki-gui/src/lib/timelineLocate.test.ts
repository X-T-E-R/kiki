// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  locateInTimeline,
  registerTimelineLocator,
  resetTimelineLocatorsForTests,
} from './timelineLocate';
import { clearToasts, getToasts } from './toasts';

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
});

afterEach(() => {
  resetTimelineLocatorsForTests();
  clearToasts();
});

describe('locateInTimeline cancellation and toast behavior', () => {
  it('suppresses false turnNotFound toasts when a mounted locator returns cancelled or no-timeline', async () => {
    const unregisterCancelled = registerTimelineLocator('s_cancel', 'main', {
      isVisible: () => true,
      locate: async () => ({ status: 'cancelled' }),
    });
    try {
      const outcome = await locateInTimeline({ kind: 'turn', turnId: 't42' }, { sessionId: 's_cancel' });
      expect(outcome).toEqual({ status: 'cancelled' });
      expect(getToasts()).toEqual([]);
    } finally {
      unregisterCancelled();
    }

    const unregisterAborted = registerTimelineLocator('s_abort', 'main', {
      isVisible: () => true,
      locate: async () => ({ status: 'no-timeline' }),
    });
    try {
      const outcome = await locateInTimeline({ kind: 'turn', turnId: 't42' }, { sessionId: 's_abort' });
      expect(outcome).toEqual({ status: 'no-timeline' });
      expect(getToasts()).toEqual([]);
    } finally {
      unregisterAborted();
    }

    const unregisterThrowAbort = registerTimelineLocator('s_abort_err', 'main', {
      isVisible: () => true,
      locate: async () => { throw new DOMException('Aborted', 'AbortError'); },
    });
    try {
      const outcome = await locateInTimeline({ kind: 'turn', turnId: 't42' }, { sessionId: 's_abort_err' });
      expect(outcome).toEqual({ status: 'cancelled' });
      expect(getToasts()).toEqual([]);
    } finally {
      unregisterThrowAbort();
    }
  });

  it('still emits turnNotFound toast when the locator reports not-found', async () => {
    const unregister = registerTimelineLocator('s_missing', 'main', {
      isVisible: () => true,
      locate: async () => ({ status: 'not-found' }),
    });
    try {
      const outcome = await locateInTimeline({ kind: 'turn', turnId: 't42' }, { sessionId: 's_missing' });
      expect(outcome).toEqual({ status: 'not-found' });
      expect(getToasts().map((toast) => toast.text)).toEqual([
        expect.stringContaining('42'),
      ]);
    } finally {
      unregister();
    }
  });
});
