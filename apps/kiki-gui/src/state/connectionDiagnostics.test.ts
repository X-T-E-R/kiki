// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_ENTRIES,
  TIMER_GAP_MS,
  connectionLog,
  formatConnectionLog,
  recordConnectionEvent,
  resetConnectionLog,
  watchPageLifecycle,
} from './connectionDiagnostics';

afterEach(() => {
  resetConnectionLog();
  vi.useRealTimers();
});

describe('connection log', () => {
  it('keeps the newest entries within its bound', () => {
    for (let index = 0; index < MAX_ENTRIES + 25; index += 1) recordConnectionEvent({ kind: 'retry', attempt: index, delayMs: 500 }, index);
    const log = connectionLog();
    expect(log).toHaveLength(MAX_ENTRIES);
    expect(log[0]).toMatchObject({ attempt: 25 });
    expect(log.at(-1)).toMatchObject({ attempt: MAX_ENTRIES + 24 });
  });

  it('formats one line per entry and leaves out absent fields', () => {
    recordConnectionEvent({ kind: 'close', cause: 'server', code: 1006, wasClean: false, heartbeatMs: 10_000 }, Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(formatConnectionLog(connectionLog())).toBe('2026-01-02T03:04:05.000Z close cause="server" code=1006 wasClean=false heartbeatMs=10000');
  });

  it('records a paused-timer gap and page visibility while watched', () => {
    vi.useFakeTimers();
    const stop = watchPageLifecycle();
    // A hidden window whose timers were held for 40 s: one late tick.
    vi.setSystemTime(Date.now() + 40_000);
    vi.advanceTimersByTime(1_000);
    document.dispatchEvent(new Event('visibilitychange'));
    stop();
    const kinds = connectionLog().map((entry) => entry.kind);
    expect(kinds).toEqual(['timer_gap', 'visibility']);
    const gap = connectionLog()[0] as { gapMs: number };
    expect(gap.gapMs).toBeGreaterThanOrEqual(TIMER_GAP_MS);
    // Stopped: nothing more is recorded.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(connectionLog()).toHaveLength(2);
  });
});
