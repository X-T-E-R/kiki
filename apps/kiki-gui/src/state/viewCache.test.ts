import { describe, expect, it, vi } from 'vitest';

import { createViewState, type SessionController } from '@kiki/session-core/session';

import { LiveControllerRegistry, VIEW_CACHE_MAX_BYTES, VIEW_CACHE_MAX_PARKED } from './connection';

type FakeState = ReturnType<typeof createViewState>;

interface FakeController {
  readonly controller: SessionController;
  setState(patch: Partial<FakeState>): void;
  readonly open: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly suspend: ReturnType<typeof vi.fn>;
  readonly resume: ReturnType<typeof vi.fn>;
}

function fake(sessionId: string, bytes = 1024, patch: Partial<FakeState> = {}): FakeController {
  let state: FakeState = { ...createViewState(sessionId), loaded: true, ...patch };
  let suspended = false;
  const listeners = new Set<() => void>();
  const open = vi.fn(async () => {});
  const close = vi.fn();
  const suspend = vi.fn(() => { suspended = true; });
  const resume = vi.fn(async () => { suspended = false; });
  const controller = {
    sessionId,
    open,
    close,
    suspend,
    resume,
    get suspended() { return suspended; },
    residentBytes: () => bytes,
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } as unknown as SessionController;
  return {
    controller,
    setState: (next) => {
      state = { ...state, ...next };
      for (const listener of [...listeners]) listener();
    },
    open, close, suspend, resume,
  };
}

function clock() {
  let now = 0;
  const timers: { at: number; callback: () => void; handle: number }[] = [];
  let handle = 0;
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => {
      handle += 1;
      timers.push({ at: now + ms, callback, handle });
      return handle;
    },
    clearTimer: (id: unknown) => {
      const index = timers.findIndex((timer) => timer.handle === id);
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((entry) => entry.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.callback();
      }
    },
  };
}

describe('LiveControllerRegistry view cache', () => {
  it('parks a released view and reuses it on the next acquire without reopening', () => {
    const registry = new LiveControllerRegistry();
    const scope = {};
    const a = fake('a');
    const lease = registry.acquire('a', scope, () => a.controller);
    lease.release();
    expect(a.suspend).toHaveBeenCalledTimes(1);
    expect(a.close).not.toHaveBeenCalled();
    expect(registry.parkedCount).toBe(1);
    // Parked views leave the live roster that rails and activity read.
    expect([...registry]).toEqual([]);

    const factory = vi.fn(() => fake('a').controller);
    const again = registry.acquire('a', scope, factory);
    expect(again.controller).toBe(a.controller);
    expect(factory).not.toHaveBeenCalled();
    expect(a.open).toHaveBeenCalledTimes(1);
    expect(a.resume).toHaveBeenCalledTimes(1);
    expect(registry.parkedCount).toBe(0);
    expect([...registry]).toEqual([a.controller]);
    again.release();
  });

  it('keeps a cache-hit lease pending until resume refreshes the shell', async () => {
    const registry = new LiveControllerRegistry();
    const scope = {};
    const view = fake('a');
    registry.acquire('a', scope, () => view.controller).release();
    let resolveResume!: () => void;
    const resume = new Promise<void>((resolve) => { resolveResume = resolve; });
    view.resume.mockImplementation(() => resume);

    const lease = registry.acquire('a', scope, () => view.controller);
    let settled = false;
    void lease.ready.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveResume();
    await lease.ready;
    expect(settled).toBe(true);
    lease.release();
  });

  it('evicts the least recently used suspended view past the count limit', () => {
    const registry = new LiveControllerRegistry();
    const scope = {};
    const views = Array.from({ length: VIEW_CACHE_MAX_PARKED + 1 }, (_, index) => fake(`s${index}`));
    for (const view of views) registry.acquire(view.controller.sessionId, scope, () => view.controller).release();
    expect(registry.parkedCount).toBe(VIEW_CACHE_MAX_PARKED);
    expect(views[0]!.close).toHaveBeenCalledTimes(1);
    for (const view of views.slice(1)) expect(view.close).not.toHaveBeenCalled();
    // Revisiting refreshes recency: s1 survives the next insert, s2 goes.
    registry.acquire('s1', scope, () => fake('s1').controller).release();
    const extra = fake('extra');
    registry.acquire('extra', scope, () => extra.controller).release();
    expect(views[1]!.close).not.toHaveBeenCalled();
    expect(views[2]!.close).toHaveBeenCalledTimes(1);
  });

  it('evicts by resident bytes and never parks a view larger than half the budget', () => {
    const registry = new LiveControllerRegistry();
    const scope = {};
    const huge = fake('huge', VIEW_CACHE_MAX_BYTES);
    registry.acquire('huge', scope, () => huge.controller).release();
    expect(huge.close).toHaveBeenCalledTimes(1);
    expect(registry.parkedCount).toBe(0);

    const third = VIEW_CACHE_MAX_BYTES / 2.5;
    const a = fake('a', third);
    const b = fake('b', third);
    const c = fake('c', third);
    for (const view of [a, b, c]) registry.acquire(view.controller.sessionId, scope, () => view.controller).release();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).not.toHaveBeenCalled();
    expect(c.close).not.toHaveBeenCalled();
  });

  it('keeps running and approval-waiting views subscribed and exempt from eviction', () => {
    const time = clock();
    const registry = new LiveControllerRegistry({ now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, maxParked: 1 });
    const scope = {};
    const running = fake('running', 1024, { busy: true });
    const waiting = fake('waiting', 1024, { pendingInteraction: 'approval' });
    const idle = fake('idle');
    const idle2 = fake('idle2');
    for (const view of [running, waiting, idle, idle2]) {
      registry.acquire(view.controller.sessionId, scope, () => view.controller).release();
    }
    expect(running.suspend).not.toHaveBeenCalled();
    expect(waiting.suspend).not.toHaveBeenCalled();
    expect(running.close).not.toHaveBeenCalled();
    expect(waiting.close).not.toHaveBeenCalled();
    expect(idle.close).toHaveBeenCalledTimes(1);
    time.advance(60 * 60_000);
    expect(running.close).not.toHaveBeenCalled();
    expect(waiting.close).not.toHaveBeenCalled();

    // Once the turn ends the view is suspended and joins the LRU.
    running.setState({ busy: false });
    expect(running.suspend).toHaveBeenCalledTimes(1);
    expect(idle2.close).toHaveBeenCalledTimes(1);
  });

  it('bounds live parked subscriptions by suspending the oldest protected view', () => {
    const registry = new LiveControllerRegistry({ maxLiveParked: 1 });
    const scope = {};
    const first = fake('first', 1024, { busy: true });
    const second = fake('second', 1024, { busy: true });
    registry.acquire('first', scope, () => first.controller).release();
    registry.acquire('second', scope, () => second.controller).release();
    expect(first.suspend).toHaveBeenCalledTimes(1);
    expect(second.suspend).not.toHaveBeenCalled();
    expect(first.close).not.toHaveBeenCalled();
  });

  it('expires suspended views after the TTL', () => {
    const time = clock();
    const registry = new LiveControllerRegistry({ now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, ttlMs: 1000 });
    const a = fake('a');
    registry.acquire('a', {}, () => a.controller).release();
    time.advance(999);
    expect(a.close).not.toHaveBeenCalled();
    time.advance(1);
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(registry.parkedCount).toBe(0);
  });

  it('does not park unloaded or failed views and drops a scope on disconnect', () => {
    const registry = new LiveControllerRegistry();
    const failed = fake('failed', 1024, { loadError: 'session.not_found' });
    const unloaded = fake('unloaded', 1024, { loaded: false });
    registry.acquire('failed', {}, () => failed.controller).release();
    registry.acquire('unloaded', {}, () => unloaded.controller).release();
    expect(failed.close).toHaveBeenCalledTimes(1);
    expect(unloaded.close).toHaveBeenCalledTimes(1);

    const scope = {};
    const other = {};
    const kept = fake('kept');
    const gone = fake('gone');
    registry.acquire('kept', other, () => kept.controller).release();
    registry.acquire('gone', scope, () => gone.controller).release();
    registry.evictScope(scope);
    expect(gone.close).toHaveBeenCalledTimes(1);
    expect(kept.close).not.toHaveBeenCalled();
    // A fresh acquire for the evicted session builds a new controller.
    const replacement = fake('gone');
    expect(registry.acquire('gone', scope, () => replacement.controller).controller).toBe(replacement.controller);
  });
});
