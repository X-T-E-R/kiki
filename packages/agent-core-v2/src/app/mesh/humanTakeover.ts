import type {
  HumanTakeoverConflict,
  HumanTakeoverHolder,
  HumanTakeoverLease,
  MeshStaleEpochConflict,
} from '@kiki/protocol';

/** Error raised with HTTP 409 semantics when automated input collides with an active human takeover lease. */
export class HumanControllingError extends Error {
  readonly status = 409 as const;
  readonly code = 'human_controlling' as const;
  readonly targetId: string;
  readonly holder = 'human' as const;
  readonly epoch: number;
  readonly expiresAt: number;

  constructor(lease: Pick<HumanTakeoverLease, 'targetId' | 'expiresAt' | 'epoch'>) {
    super(`Target '${lease.targetId}' is currently controlled by human until ${new Date(lease.expiresAt).toISOString()}`);
    this.name = 'HumanControllingError';
    this.targetId = lease.targetId;
    this.epoch = lease.epoch ?? 0;
    this.expiresAt = lease.expiresAt;
  }

  toConflictPayload(): HumanTakeoverConflict {
    return {
      error: 'human_controlling',
      targetId: this.targetId,
      holder: 'human',
      epoch: this.epoch,
      expiresAt: this.expiresAt,
    };
  }
}

/** Error raised with HTTP 409 semantics when a lease or target operation carries a stale fencing epoch. */
export class StaleEpochError extends Error {
  readonly status = 409 as const;
  readonly code = 'stale_epoch' as const;

  constructor(
    readonly targetId: string,
    readonly expectedEpoch: number,
    readonly currentEpoch: number,
  ) {
    super(`Stale fencing epoch for '${targetId}': expected ${expectedEpoch}, current ${currentEpoch}`);
    this.name = 'StaleEpochError';
  }

  toConflictPayload(): MeshStaleEpochConflict {
    return {
      error: 'stale_epoch',
      targetId: this.targetId,
      expectedEpoch: this.expectedEpoch,
      currentEpoch: this.currentEpoch,
    };
  }
}

/** Manages per-target human vs orchestrator takeover leases with monotonic fencing epochs so automated writes yield to human control. */
export class HumanTakeoverManager {
  private readonly leases = new Map<string, HumanTakeoverLease>();
  private readonly epochs = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  currentEpoch(targetId: string): number {
    this.inspect(targetId);
    return this.epochs.get(targetId) ?? 0;
  }

  acquire(
    targetId: string,
    holder: HumanTakeoverHolder,
    ttlMs = 300_000,
    reason?: string,
    options?: { readonly expectedEpoch?: number; readonly overrideHumanLease?: boolean },
  ): HumanTakeoverLease {
    const existing = this.inspect(targetId);
    const currentEpoch = this.epochs.get(targetId) ?? 0;
    if (options?.expectedEpoch !== undefined && currentEpoch !== options.expectedEpoch) {
      throw new StaleEpochError(targetId, options.expectedEpoch, currentEpoch);
    }
    if (
      existing !== undefined &&
      existing.holder === 'human' &&
      holder === 'orchestrator' &&
      options?.overrideHumanLease !== true
    ) {
      throw new HumanControllingError(existing);
    }
    const acquiredAt = this.now();
    const clampedTtl = Math.max(1000, Math.min(86_400_000, Math.floor(ttlMs)));
    const nextEpoch = currentEpoch + 1;
    this.epochs.set(targetId, nextEpoch);
    const lease: HumanTakeoverLease = {
      targetId,
      holder,
      epoch: nextEpoch,
      acquiredAt,
      expiresAt: acquiredAt + clampedTtl,
      ...(reason === undefined ? {} : { reason }),
    };
    this.leases.set(targetId, lease);
    return lease;
  }

  renew(
    targetId: string,
    holder: HumanTakeoverHolder,
    ttlMs = 300_000,
    expectedEpoch?: number,
  ): HumanTakeoverLease | undefined {
    const existing = this.inspect(targetId);
    const currentEpoch = this.epochs.get(targetId) ?? 0;
    if (expectedEpoch !== undefined && currentEpoch !== expectedEpoch) {
      throw new StaleEpochError(targetId, expectedEpoch, currentEpoch);
    }
    if (existing === undefined || existing.holder !== holder) return undefined;
    const clampedTtl = Math.max(1000, Math.min(86_400_000, Math.floor(ttlMs)));
    const renewed: HumanTakeoverLease = {
      ...existing,
      expiresAt: this.now() + clampedTtl,
    };
    this.leases.set(targetId, renewed);
    return renewed;
  }

  release(targetId: string, holder?: HumanTakeoverHolder, expectedEpoch?: number): boolean {
    const current = this.inspect(targetId);
    const currentEpoch = this.epochs.get(targetId) ?? 0;
    if (expectedEpoch !== undefined && currentEpoch !== expectedEpoch) {
      throw new StaleEpochError(targetId, expectedEpoch, currentEpoch);
    }
    if (current === undefined) return false;
    if (holder !== undefined && current.holder !== holder) return false;
    this.leases.delete(targetId);
    this.epochs.set(targetId, currentEpoch + 1);
    return true;
  }

  inspect(targetId: string): HumanTakeoverLease | undefined {
    const lease = this.leases.get(targetId);
    if (lease === undefined) return undefined;
    if (lease.expiresAt <= this.now()) {
      this.leases.delete(targetId);
      return undefined;
    }
    return lease;
  }

  listActive(): readonly HumanTakeoverLease[] {
    const currentNow = this.now();
    const active: HumanTakeoverLease[] = [];
    for (const [targetId, lease] of this.leases) {
      if (lease.expiresAt <= currentNow) {
        this.leases.delete(targetId);
        continue;
      }
      active.push(lease);
    }
    return active.toSorted((a, b) => a.targetId.localeCompare(b.targetId));
  }

  assertWritable(
    targetId: string,
    options?: { readonly overrideHumanLease?: boolean; readonly expectedEpoch?: number },
  ): void {
    const lease = this.inspect(targetId);
    const currentEpoch = this.epochs.get(targetId) ?? 0;
    if (options?.expectedEpoch !== undefined && currentEpoch !== options.expectedEpoch) {
      throw new StaleEpochError(targetId, options.expectedEpoch, currentEpoch);
    }
    if (lease === undefined) return;
    if (lease.holder === 'human' && options?.overrideHumanLease !== true) {
      throw new HumanControllingError(lease);
    }
  }
}
