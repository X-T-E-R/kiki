import { describe, expect, it } from 'vitest';

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
    now = 1700;
    expect(registry.activeCount()).toBe(0);
  });
});
