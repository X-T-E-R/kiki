import { ulid } from 'ulid';

export interface ServerLease {
  readonly leaseId: string;
  readonly expiresAt: number;
}

interface LeaseEntry {
  expiresAt: number;
  readonly resources: Map<string, () => void>;
}

export class LeaseRegistry {
  private readonly leases = new Map<string, LeaseEntry>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, Math.min(ttlMs, 1_000));
    this.sweepTimer.unref();
  }

  renew(leaseId?: string): ServerLease {
    this.sweep();
    const existing = leaseId === undefined ? undefined : this.leases.get(leaseId);
    const id = existing === undefined ? `lease_${ulid()}` : leaseId!;
    const expiresAt = this.now() + this.ttlMs;
    if (existing === undefined) this.leases.set(id, { expiresAt, resources: new Map() });
    else existing.expiresAt = expiresAt;
    return { leaseId: id, expiresAt };
  }

  isActive(leaseId: string): boolean {
    this.sweep();
    return this.leases.has(leaseId);
  }

  attach(leaseId: string, resourceId: string, cleanup: () => void): boolean {
    this.sweep();
    const lease = this.leases.get(leaseId);
    if (lease === undefined) return false;
    lease.resources.set(resourceId, cleanup);
    return true;
  }

  releaseResource(resourceId: string): void {
    for (const lease of this.leases.values()) {
      const cleanup = lease.resources.get(resourceId);
      if (cleanup === undefined) continue;
      lease.resources.delete(resourceId);
      cleanup();
      return;
    }
  }

  activeCount(): number {
    this.sweep();
    return this.leases.size;
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    for (const lease of this.leases.values()) this.cleanup(lease);
    this.leases.clear();
  }

  private sweep(): void {
    const now = this.now();
    for (const [leaseId, lease] of this.leases) {
      if (lease.expiresAt > now) continue;
      this.leases.delete(leaseId);
      this.cleanup(lease);
    }
  }

  private cleanup(lease: LeaseEntry): void {
    for (const cleanup of lease.resources.values()) cleanup();
    lease.resources.clear();
  }
}
