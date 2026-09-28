// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import {
  aggregateLife,
  DONE_WINDOW_MS,
  lifeOf,
  motionPreference,
  prefersReducedMotion,
  resetMarkLives,
  staggerStyle,
  useLifeChanged,
  type LifeState,
} from './motion';

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

describe('aggregateLife', () => {
  it('surfaces the loudest state', () => {
    expect(aggregateLife(['idle', 'working', 'waiting'])).toBe('waiting');
    expect(aggregateLife(['done', 'working'])).toBe('working');
    expect(aggregateLife(['failed', 'done'])).toBe('done');
    expect(aggregateLife(['failed', 'idle'])).toBe('idle');
    expect(aggregateLife([])).toBe('idle');
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
