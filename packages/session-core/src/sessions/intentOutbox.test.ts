import { describe, expect, it, vi } from 'vitest';

import type { SpaceStorage } from '../storage/spaceStorage';
import {
  INTENT_OUTBOX_MAX_BACKOFF_MS,
  INTENT_OUTBOX_MIN_BACKOFF_MS,
  INTENT_OUTBOX_STORAGE_KEY,
  IntentOutbox,
  triageBackoffMs,
  triageSlotKey,
  type TriageIntent,
} from './intentOutbox';

function memoryStorage(): SpaceStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

describe('IntentOutbox (session-list triage mutations)', () => {
  it('coalesces archive/unarchive into one slot and projects IntentOverlay immediately', async () => {
    const storage = memoryStorage();
    let releaseFirst!: () => void;
    const dispatched: TriageIntent[] = [];
    const outbox = new IntentOutbox({
      storage,
      dispatch: async (intent) => {
        dispatched.push(intent);
        if (dispatched.length === 1) {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
      },
    });

    outbox.enqueue({ kind: 'archive', sessionId: 's1' });
    expect(outbox.overlay.archived.get('s1')).toBe(true);
    // Supersede archive while first dispatch is in flight
    outbox.enqueue({ kind: 'unarchive', sessionId: 's1' });
    expect(outbox.size).toBe(1);
    expect(outbox.overlay.archived.get('s1')).toBe(false);

    // Independent slots for read + rename coexist and coalesce per slot
    outbox.enqueue({ kind: 'markRead', sessionId: 's1', readAt: 100 });
    outbox.enqueue({ kind: 'rename', sessionId: 's1', title: 'Draft 1' });
    outbox.enqueue({ kind: 'rename', sessionId: 's1', title: 'Final Title' });
    expect(outbox.size).toBe(3);
    expect(outbox.overlay.read.has('s1')).toBe(true);
    expect(outbox.overlay.titles.get('s1')).toBe('Final Title');
    expect(triageSlotKey({ kind: 'archive', sessionId: 's1' })).toBe(triageSlotKey({ kind: 'unarchive', sessionId: 's1' }));

    releaseFirst();
    await vi.waitFor(() => { expect(outbox.size).toBe(0); });
    expect(dispatched).toEqual([
      { kind: 'archive', sessionId: 's1' },
      { kind: 'unarchive', sessionId: 's1' },
      { kind: 'markRead', sessionId: 's1', readAt: 100 },
      { kind: 'rename', sessionId: 's1', title: 'Final Title' },
    ]);
    expect(storage.data.has(INTENT_OUTBOX_STORAGE_KEY)).toBe(false);
    outbox.dispose();
  });

  it('retries transient failures with 1..30s exponential backoff and drains immediately on kick()', async () => {
    const storage = memoryStorage();
    const delays: number[] = [];
    const scheduled: Array<() => void> = [];
    let shouldFail = true;
    const dispatched: TriageIntent[] = [];

    const outbox = new IntentOutbox({
      storage,
      dispatch: async (intent) => {
        dispatched.push(intent);
        if (shouldFail) throw new Error('offline');
      },
      scheduleTimer: (fn, ms) => {
        delays.push(ms);
        scheduled.push(fn);
        return delays.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    });

    outbox.enqueue({ kind: 'archive', sessionId: 's-offline' });
    await vi.waitFor(() => { expect(delays).toEqual([INTENT_OUTBOX_MIN_BACKOFF_MS]); });

    scheduled.shift()?.();
    await vi.waitFor(() => { expect(delays).toEqual([1_000, 2_000]); });

    scheduled.shift()?.();
    await vi.waitFor(() => { expect(delays).toEqual([1_000, 2_000, 4_000]); });

    // Backoff schedule caps cleanly at 30s
    expect(triageBackoffMs(1)).toBe(1_000);
    expect(triageBackoffMs(5)).toBe(16_000);
    expect(triageBackoffMs(6)).toBe(INTENT_OUTBOX_MAX_BACKOFF_MS);
    expect(triageBackoffMs(20)).toBe(INTENT_OUTBOX_MAX_BACKOFF_MS);

    // Persisted entries survive reload across instances
    const persisted = storage.data.get(INTENT_OUTBOX_STORAGE_KEY);
    expect(persisted).toBeDefined();

    // Online return triggers kick() and drains immediately
    shouldFail = false;
    outbox.kick();
    await vi.waitFor(() => { expect(outbox.size).toBe(0); });
    expect(dispatched).toHaveLength(4);
    outbox.dispose();
  });

  it('restores persisted intents from storage and drops permanent errors without infinite retry', async () => {
    const storage = memoryStorage();
    storage.setItem(INTENT_OUTBOX_STORAGE_KEY, JSON.stringify([
      { slotKey: 'rename|s2', intent: { kind: 'rename', sessionId: 's2', title: 'Renamed' }, revision: 4, createdAt: 10, attempts: 1 },
    ]));
    const dispatched: TriageIntent[] = [];
    const outbox = new IntentOutbox({
      storage,
      dispatch: async (intent) => {
        dispatched.push(intent);
        throw Object.assign(new Error('not found'), { permanent: true });
      },
      isPermanentError: (err) => typeof err === 'object' && err !== null && (err as { permanent?: boolean }).permanent === true,
    });

    expect(outbox.size).toBe(1);
    expect(outbox.overlay.titles.get('s2')).toBe('Renamed');
    outbox.kick();
    await vi.waitFor(() => { expect(outbox.size).toBe(0); });
    expect(dispatched).toHaveLength(1);
    expect(storage.data.has(INTENT_OUTBOX_STORAGE_KEY)).toBe(false);
    outbox.dispose();
  });
});
