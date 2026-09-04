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

  it('continues an expiry sweep after a resource cleanup throws', async () => {
    vi.useFakeTimers();
    const onSweepError = vi.fn();
    const registry = new LeaseRegistry(100, Date.now, onSweepError);
    const first = registry.renew();
    const second = registry.renew();
    const cleanupError = new Error('cleanup failed');
    const cleanup = vi.fn();
    registry.attach(first.leaseId, 'first', () => {
      throw cleanupError;
    });
    registry.attach(second.leaseId, 'second', cleanup);

    await vi.advanceTimersByTimeAsync(100);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(onSweepError).toHaveBeenCalledOnce();
    expect(onSweepError.mock.calls[0]?.[0]).toBeInstanceOf(AggregateError);
    expect((onSweepError.mock.calls[0]?.[0] as AggregateError).errors).toEqual([cleanupError]);
    expect(registry.activeCount()).toBe(0);
    registry.dispose();
    vi.useRealTimers();
  });

  it('removes a resource even when its explicit cleanup throws', () => {
    const registry = new LeaseRegistry();
    const lease = registry.renew();
    const cleanup = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    registry.attach(lease.leaseId, 'resource', cleanup);

    expect(() => {
      registry.releaseResource('resource');
    }).toThrow('cleanup failed');
    expect(() => {
      registry.releaseResource('resource');
    }).not.toThrow();
    registry.dispose();
  });

  it('aggregates dispose failures while cleaning every resource', () => {
    const registry = new LeaseRegistry();
    const lease = registry.renew();
    const cleanup = vi.fn();
    registry.attach(lease.leaseId, 'first', () => {
      throw new Error('first failed');
    });
    registry.attach(lease.leaseId, 'second', cleanup);
    registry.attach(lease.leaseId, 'third', () => {
      throw new Error('third failed');
    });

    expect(() => {
      registry.dispose();
    }).toThrow(AggregateError);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
