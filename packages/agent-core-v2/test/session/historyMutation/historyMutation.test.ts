import { describe, expect, it } from 'vitest';

import { SessionHistoryMutationService } from '#/session/historyMutation/historyMutationService';

describe('SessionHistoryMutationService', () => {
  it('serializes independent admissions in FIFO order', async () => {
    const service = new SessionHistoryMutationService();
    const order: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = service.runAdmission(undefined, async () => {
      order.push('first:start');
      markFirstStarted();
      await firstReady;
      order.push('first:end');
    });
    const second = service.runAdmission(undefined, async () => {
      order.push('second');
    });
    await firstStarted;
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('allows composed undo/prompt admission under the active mutation lease', async () => {
    const service = new SessionHistoryMutationService();
    const lease = await service.acquire();
    try {
      await expect(service.runAdmission(lease, async () => 'admitted')).resolves.toBe('admitted');
    } finally {
      lease.dispose();
    }
  });
});
