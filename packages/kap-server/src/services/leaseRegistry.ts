import { ulid } from 'ulid';

export interface ServerLease {
  readonly leaseId: string;
  readonly expiresAt: number;
}

interface LeaseEntry {
  expiresAt: number;
  readonly resources: Map<string, () => void>;
}

interface PendingCleanup {
  readonly cleanup: () => void;
  readonly failures: number;
  readonly nextAttemptAt: number;
}

const CLEANUP_RETRY_BASE_MS = 250;
const CLEANUP_RETRY_MAX_MS = 10_000;
const DEFAULT_MAX_LEASES = 10_000;

export class LeaseRegistry {
  private readonly leases = new Map<string, LeaseEntry>();
  private readonly resourceToLease = new Map<string, string>();
  private readonly pendingCleanups = new Map<string, PendingCleanup>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly onSweepError: (error: AggregateError) => void = () => {},
    private readonly maxLeases = DEFAULT_MAX_LEASES,
  ) {
    this.sweepTimer = setInterval(() => {
      this.runSweep();
    }, Math.min(ttlMs, 1_000));
    this.sweepTimer.unref();
  }

  renew(leaseId?: string): ServerLease {
    const currentNow = this.now();
    let existing = leaseId === undefined ? undefined : this.leases.get(leaseId);
    if (existing !== undefined && existing.expiresAt <= currentNow) {
      this.expireSingle(leaseId!, existing);
      existing = undefined;
    }
    const id = existing === undefined ? `lease_${ulid()}` : leaseId!;
    const expiresAt = currentNow + this.ttlMs;
    if (existing === undefined) {
      if (this.leases.size >= this.maxLeases) {
        this.runSweep();
        if (this.leases.size >= this.maxLeases) {
          throw new Error('Maximum active lease limit reached');
        }
      }
      this.leases.set(id, { expiresAt, resources: new Map() });
    } else {
      existing.expiresAt = expiresAt;
      this.leases.delete(id);
      this.leases.set(id, existing);
    }
    return { leaseId: id, expiresAt };
  }

  isActive(leaseId: string): boolean {
    const lease = this.leases.get(leaseId);
    if (lease === undefined) return false;
    if (lease.expiresAt <= this.now()) {
      this.expireSingle(leaseId, lease);
      return false;
    }
    return true;
  }

  attach(leaseId: string, resourceId: string, cleanup: () => void): boolean {
    const lease = this.leases.get(leaseId);
    if (lease === undefined) return false;
    if (lease.expiresAt <= this.now()) {
      this.expireSingle(leaseId, lease);
      return false;
    }
    const previousOwner = this.resourceToLease.get(resourceId);
    if (previousOwner !== undefined && previousOwner !== leaseId) {
      this.leases.get(previousOwner)?.resources.delete(resourceId);
    }
    lease.resources.set(resourceId, cleanup);
    this.resourceToLease.set(resourceId, leaseId);
    return true;
  }

  releaseResource(resourceId: string): void {
    const pending = this.pendingCleanups.get(resourceId);
    if (pending !== undefined) {
      this.attemptCleanup(resourceId, pending.cleanup);
      return;
    }
    const ownerId = this.resourceToLease.get(resourceId);
    if (ownerId === undefined) return;
    this.resourceToLease.delete(resourceId);
    const lease = this.leases.get(ownerId);
    const cleanup = lease?.resources.get(resourceId);
    if (cleanup === undefined) return;
    lease!.resources.delete(resourceId);
    this.attemptCleanup(resourceId, cleanup);
  }

  activeCount(): number {
    this.runSweep();
    return this.leases.size;
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    for (const lease of this.leases.values()) this.cleanupLease(lease);
    this.leases.clear();
    this.resourceToLease.clear();
    const errors: unknown[] = [];
    const pendingCleanups = new Map(this.pendingCleanups);
    for (const [resourceId, pending] of pendingCleanups) {
      try {
        this.attemptCleanup(resourceId, pending.cleanup);
      } catch (error) {
        errors.push(error);
      }
    }
    this.pendingCleanups.clear();
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to dispose lease resources');
  }

  private expireSingle(leaseId: string, lease: LeaseEntry): void {
    this.leases.delete(leaseId);
    const errors = this.cleanupLease(lease);
    if (errors.length > 0) {
      this.onSweepError(new AggregateError(errors, 'Failed to clean up lease resources'));
    }
  }

  private runSweep(): void {
    try {
      this.sweep();
    } catch (error) {
      this.onSweepError(error as AggregateError);
    }
  }

  private sweep(): void {
    const now = this.now();
    const errors: unknown[] = [];
    for (const [leaseId, lease] of this.leases) {
      if (lease.expiresAt > now) break;
      this.leases.delete(leaseId);
      errors.push(...this.cleanupLease(lease));
    }
    if (this.pendingCleanups.size > 0) {
      const due: Array<[string, PendingCleanup]> = [];
      for (const entry of this.pendingCleanups) {
        if (entry[1].nextAttemptAt <= now) due.push(entry);
      }
      for (const [resourceId, pending] of due) {
        try {
          this.attemptCleanup(resourceId, pending.cleanup);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to clean up lease resources');
  }

  private cleanupLease(lease: LeaseEntry): unknown[] {
    const errors: unknown[] = [];
    for (const [resourceId, cleanup] of lease.resources) {
      lease.resources.delete(resourceId);
      this.resourceToLease.delete(resourceId);
      try {
        this.attemptCleanup(resourceId, cleanup);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private attemptCleanup(resourceId: string, cleanup: () => void): void {
    try {
      cleanup();
      this.pendingCleanups.delete(resourceId);
    } catch (error) {
      const failures = (this.pendingCleanups.get(resourceId)?.failures ?? 0) + 1;
      const retryDelay = Math.min(
        CLEANUP_RETRY_MAX_MS,
        CLEANUP_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 6),
      );
      this.pendingCleanups.set(resourceId, {
        cleanup,
        failures,
        nextAttemptAt: this.now() + retryDelay,
      });
      throw error;
    }
  }
}
