import { ulid } from 'ulid';

export interface ServerLease {
  readonly leaseId: string;
  readonly expiresAt: number;
}

export class LeaseRegistry {
  private readonly leases = new Map<string, number>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  renew(leaseId?: string): ServerLease {
    const id = leaseId ?? `lease_${ulid()}`;
    const expiresAt = this.now() + this.ttlMs;
    this.leases.set(id, expiresAt);
    return { leaseId: id, expiresAt };
  }

  activeCount(): number {
    const now = this.now();
    for (const [leaseId, expiresAt] of this.leases) {
      if (expiresAt <= now) this.leases.delete(leaseId);
    }
    return this.leases.size;
  }
}
