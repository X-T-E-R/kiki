import { describe, expect, it, vi } from 'vitest';

import { LeaseRegistry } from '../src/services/leaseRegistry';

describe('LeaseRegistry', () => {
  it('creates, renews, and expires leases', () => {
    let now = 1000;
    const registry = new LeaseRegistry(500, () => now);
    const created = registry.renew();
    expect(created.leaseId).toMatch(/^lease_/);
    expect(created.expiresAt).toBe(1500);
    expect(registry.activeCount()).toBe(1);

    now = 1200;
    expect(registry.renew(created.leaseId)).toEqual({
      leaseId: created.leaseId,
      expiresAt: 1700,
    });
    now = 1699;
    expect(registry.activeCount()).toBe(1);
    const cleanup = vi.fn();
    expect(registry.attach(created.leaseId, 'session:source', cleanup)).toBe(true);
    now = 1700;
    expect(registry.activeCount()).toBe(0);
    expect(cleanup).toHaveBeenCalledOnce();
    registry.dispose();
  });

  it('automatically releases attached resources when the owner lease expires', async () => {
    vi.useFakeTimers();
    const registry = new LeaseRegistry(100);
    const lease = registry.renew();
    const cleanup = vi.fn();
    registry.attach(lease.leaseId, 'session:source', cleanup);

    await vi.advanceTimersByTimeAsync(100);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(registry.activeCount()).toBe(0);
    expect(registry.renew(lease.leaseId).leaseId).not.toBe(lease.leaseId);
    registry.dispose();
    vi.useRealTimers();
  });

  it('retries failed expiry cleanup on the bounded timer schedule', async () => {
    vi.useFakeTimers();
    try {
      const onSweepError = vi.fn();
      const registry = new LeaseRegistry(100, Date.now, onSweepError);
      const first = registry.renew();
      const second = registry.renew();
      const cleanupError = new Error('cleanup failed');
      const retryingCleanup = vi.fn()
        .mockImplementationOnce(() => {
          throw cleanupError;
        })
        .mockImplementationOnce(() => {});
      const cleanup = vi.fn();
      registry.attach(first.leaseId, 'first', retryingCleanup);
      registry.attach(second.leaseId, 'second', cleanup);

      await vi.advanceTimersByTimeAsync(100);

      expect(retryingCleanup).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(onSweepError).toHaveBeenCalledOnce();
      expect(onSweepError.mock.calls[0]?.[0]).toBeInstanceOf(AggregateError);
      expect((onSweepError.mock.calls[0]?.[0] as AggregateError).errors).toEqual([cleanupError]);
      expect(registry.activeCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(299);
      expect(retryingCleanup).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(retryingCleanup).toHaveBeenCalledTimes(2);
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries pending cleanup on a second explicit release', () => {
    const registry = new LeaseRegistry();
    const lease = registry.renew();
    const cleanup = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('cleanup failed');
      })
      .mockImplementationOnce(() => {});
    registry.attach(lease.leaseId, 'resource', cleanup);

    expect(() => {
      registry.releaseResource('resource');
    }).toThrow('cleanup failed');
    expect(() => {
      registry.releaseResource('resource');
    }).not.toThrow();
    expect(cleanup).toHaveBeenCalledTimes(2);
    registry.dispose();
  });

  it('retries every failed cleanup during dispose and aggregates remaining failures', () => {
    const registry = new LeaseRegistry();
    const lease = registry.renew();
    const first = vi.fn(() => {
      throw new Error('first failed');
    });
    const cleanup = vi.fn();
    const third = vi.fn(() => {
      throw new Error('third failed');
    });
    registry.attach(lease.leaseId, 'first', first);
    registry.attach(lease.leaseId, 'second', cleanup);
    registry.attach(lease.leaseId, 'third', third);

    expect(() => {
      registry.dispose();
    }).toThrow(AggregateError);
    expect(first).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledTimes(2);
  });
});
