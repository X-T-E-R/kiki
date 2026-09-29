// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DONE_WINDOW_MS,
  lifeOf,
  motionPreference,
  prefersReducedMotion,
  resetMarkLives,
  staggerStyle,
  useLifeChanged,
  type LifeState,
} from './motion';
import { handoffMode, runNewSessionHandoff } from './newSessionHandoff';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Mounts a probe reading useLifeChanged; returns render/unmount + the last value. */
function probe(markId: string) {
  const host = document.createElement('div');
  const root = createRoot(host);
  const seen: { value?: boolean } = {};
  function Probe({ life }: { life: LifeState | undefined }) {
    seen.value = useLifeChanged(markId, life);
    return null;
  }
  return {
    render: (life: LifeState | undefined) => { act(() => { root.render(createElement(Probe, { life })); }); return seen.value; },
    unmount: () => { act(() => { root.unmount(); }); },
  };
}

const NOW = Date.parse('2026-09-06T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('lifeOf', () => {
  it('ranks a pending interaction above running work', () => {
    expect(lifeOf({ busy: true, pending_interaction: 'approval' }, NOW)).toBe('waiting');
    expect(lifeOf({ busy: false, pending_interaction: 'question' }, NOW)).toBe('waiting');
  });

  it('reads busy sessions as working', () => {
    expect(lifeOf({ busy: true, pending_interaction: 'none' }, NOW)).toBe('working');
  });

  it('keeps a completed turn "done" only inside the window', () => {
    expect(lifeOf({ busy: false, last_turn_reason: 'completed', updated_at: ago(60_000) }, NOW)).toBe('done');
    expect(lifeOf({ busy: false, last_turn_reason: 'completed', updated_at: ago(DONE_WINDOW_MS + 1) }, NOW)).toBe('idle');
  });

  it('marks failed and cancelled turns without motion', () => {
    expect(lifeOf({ busy: false, last_turn_reason: 'failed' }, NOW)).toBe('failed');
    expect(lifeOf({ busy: false, last_turn_reason: 'cancelled' }, NOW)).toBe('failed');
  });

  it('tolerates sparse session records', () => {
    expect(lifeOf({ busy: false }, NOW)).toBe('idle');
    expect(lifeOf({ busy: false, last_turn_reason: 'completed', updated_at: 'not a date' }, NOW)).toBe('idle');
  });
});

describe('staggerStyle', () => {
  it('caps the stagger index', () => {
    expect(staggerStyle(2)).toEqual({ '--kiki-i': 2 });
    expect(staggerStyle(40)).toEqual({ '--kiki-i': 8 });
  });
});

describe('motion preference', () => {
  afterEach(() => {
    delete document.documentElement.dataset['kikiMotion'];
  });

  it('reads data-kiki-motion and lets it override the OS setting', () => {
    expect(motionPreference()).toBe('system');
    document.documentElement.dataset['kikiMotion'] = 'reduce';
    expect(motionPreference()).toBe('reduce');
    expect(prefersReducedMotion()).toBe(true);
    document.documentElement.dataset['kikiMotion'] = 'full';
    expect(prefersReducedMotion()).toBe(false);
    document.documentElement.dataset['kikiMotion'] = 'bogus';
    expect(motionPreference()).toBe('system');
  });
});

describe('useLifeChanged', () => {
  afterEach(() => {
    resetMarkLives();
  });

  it('reports a flip, and never on a remount into the same state', () => {
    const first = probe('m');
    expect(first.render('working')).toBe(false);
    expect(first.render('done')).toBe(true);
    first.unmount();
    // A list re-mount (regroup, refresh) sees the remembered done: no replay.
    const second = probe('m');
    expect(second.render('done')).toBe(false);
    second.unmount();
  });

  it('does not count the first known state after an unknown one as a change', () => {
    const hook = probe('n');
    hook.render(undefined);
    expect(hook.render('done')).toBe(false);
    hook.unmount();
  });
});

describe('runNewSessionHandoff', () => {
  // A loose view of document so the test can install and remove the API.
  type VtDoc = { startViewTransition?: unknown };
  afterEach(() => {
    delete document.documentElement.dataset['kikiMotion'];
    delete (document as unknown as VtDoc).startViewTransition;
    delete document.documentElement.dataset['kikiHandoff'];
  });

  it('switches straight to the session under reduced motion', () => {
    document.documentElement.dataset['kikiMotion'] = 'reduce';
    const startViewTransition = vi.fn();
    (document as unknown as VtDoc).startViewTransition = startViewTransition;
    const navigate = vi.fn();
    expect(handoffMode()).toBe('instant');
    runNewSessionHandoff({ text: 'hi', navigate });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.dataset['kikiHandoff'] !== undefined).toBe(false);
  });

  it('falls back to a fade where View Transitions are missing, navigating at once', () => {
    document.documentElement.dataset['kikiMotion'] = 'full';
    const navigate = vi.fn();
    expect(handoffMode()).toBe('fade');
    runNewSessionHandoff({ text: 'hi', navigate });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset['kikiHandoff']).toBe('fade');
  });

  it('navigates inside the View Transition update, synchronously, exactly once', () => {
    document.documentElement.dataset['kikiMotion'] = 'full';
    const navigate = vi.fn();
    let finish!: () => void;
    (document as unknown as VtDoc).startViewTransition = (update: () => unknown) => {
      void update();
      return { ready: Promise.resolve(), finished: new Promise<void>((resolve) => { finish = resolve; }) };
    };
    runNewSessionHandoff({ text: 'hi', navigate });
    // No await: the create is already done and the route must not wait on motion.
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset['kikiHandoff']).toBe('morph');
    finish();
  });

  it('still navigates when the browser refuses to start a transition', () => {
    document.documentElement.dataset['kikiMotion'] = 'full';
    (document as unknown as VtDoc).startViewTransition = () => { throw new Error('InvalidStateError'); };
    const navigate = vi.fn();
    runNewSessionHandoff({ text: 'hi', navigate });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset['kikiHandoff'] !== undefined).toBe(false);
  });
});
