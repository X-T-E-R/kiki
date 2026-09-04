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

export class LeaseRegistry {
  private readonly leases = new Map<string, LeaseEntry>();
  private readonly pendingCleanups = new Map<string, PendingCleanup>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly onSweepError: (error: AggregateError) => void = () => {},
  ) {
    this.sweepTimer = setInterval(() => {
      this.runSweep();
    }, Math.min(ttlMs, 1_000));
    this.sweepTimer.unref();
  }

  renew(leaseId?: string): ServerLease {
    this.runSweep();
    const existing = leaseId === undefined ? undefined : this.leases.get(leaseId);
    const id = existing === undefined ? `lease_${ulid()}` : leaseId!;
    const expiresAt = this.now() + this.ttlMs;
    if (existing === undefined) this.leases.set(id, { expiresAt, resources: new Map() });
    else existing.expiresAt = expiresAt;
    return { leaseId: id, expiresAt };
  }

  isActive(leaseId: string): boolean {
    this.runSweep();
    return this.leases.has(leaseId);
  }

  attach(leaseId: string, resourceId: string, cleanup: () => void): boolean {
    this.runSweep();
    const lease = this.leases.get(leaseId);
    if (lease === undefined) return false;
    lease.resources.set(resourceId, cleanup);
    return true;
  }

  releaseResource(resourceId: string): void {
    const pending = this.pendingCleanups.get(resourceId);
    if (pending !== undefined) {
      this.attemptCleanup(resourceId, pending.cleanup);
      return;
    }
    for (const lease of this.leases.values()) {
      const cleanup = lease.resources.get(resourceId);
      if (cleanup === undefined) continue;
      lease.resources.delete(resourceId);
      this.attemptCleanup(resourceId, cleanup);
      return;
    }
  }

  activeCount(): number {
    this.runSweep();
    return this.leases.size;
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    for (const lease of this.leases.values()) this.cleanupLease(lease);
    this.leases.clear();
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

  private runSweep(): void {
    try {
      this.sweep();
    } catch (error) {
      this.onSweepError(error as AggregateError);
    }
  }

  private sweep(): void {
    const now = this.now();
    const due = [...this.pendingCleanups].filter(([, pending]) => pending.nextAttemptAt <= now);
    const errors: unknown[] = [];
    for (const [leaseId, lease] of this.leases) {
      if (lease.expiresAt > now) continue;
      this.leases.delete(leaseId);
      errors.push(...this.cleanupLease(lease));
    }
    for (const [resourceId, pending] of due) {
      try {
        this.attemptCleanup(resourceId, pending.cleanup);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to clean up lease resources');
  }

  private cleanupLease(lease: LeaseEntry): unknown[] {
    const errors: unknown[] = [];
    for (const [resourceId, cleanup] of lease.resources) {
      lease.resources.delete(resourceId);
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
