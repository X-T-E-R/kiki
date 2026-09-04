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
});
