import { Disposable } from '#/_base/di/lifecycle';
import { Error2, ErrorCodes } from '#/errors';

import {
  type ISwarmConcurrencyRegistry,
  type SwarmConcurrencyLease,
} from './swarmConcurrencyRegistry';

const DEFAULT_GLOBAL_MAX_CONCURRENCY = 32;
const AGENT_SWARM_GLOBAL_MAX_CONCURRENCY_ENV =
  'KIMI_CODE_AGENT_SWARM_GLOBAL_MAX_CONCURRENCY';

class SwarmConcurrencyLeaseImpl implements SwarmConcurrencyLease {
  acquired = 0;
  waiting = false;
  notified = false;
  disposed = false;

  constructor(
    readonly maxConcurrency: number,
    readonly onPermitAvailable: () => void,
    private readonly registry: SwarmConcurrencyRegistry,
  ) {}

  tryAcquire(): boolean {
    return this.registry.tryAcquire(this);
  }

  release(): void {
    this.registry.release(this);
  }

  dispose(): void {
    this.registry.disposeLease(this);
  }
}

export class SwarmConcurrencyRegistry
  extends Disposable
  implements ISwarmConcurrencyRegistry
{
  declare readonly _serviceBrand: undefined;

  private readonly budget: number;
  private readonly leases = new Set<SwarmConcurrencyLeaseImpl>();
  private readonly waiters: SwarmConcurrencyLeaseImpl[] = [];
  private inFlight = 0;
  private notifying: SwarmConcurrencyLeaseImpl | undefined;

  constructor(
    env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    super();
    this.budget = resolveSwarmGlobalMaxConcurrency(env);
  }

  createLease(
    maxConcurrency: number,
    onPermitAvailable: () => void,
  ): SwarmConcurrencyLease {
    const lease = new SwarmConcurrencyLeaseImpl(
      maxConcurrency,
      onPermitAvailable,
      this,
    );
    this.leases.add(lease);
    return lease;
  }

  tryAcquire(lease: SwarmConcurrencyLeaseImpl): boolean {
    if (lease.disposed || lease.acquired >= lease.maxConcurrency) return false;

    if (lease.notified) {
      lease.notified = false;
      if (this.inFlight < this.budget) {
        this.grant(lease);
        return true;
      }
    }

    if (
      this.inFlight >= this.budget ||
      this.waiters.length > 0 ||
      (this.notifying !== undefined && this.notifying !== lease)
    ) {
      this.enqueue(lease);
      return false;
    }

    this.grant(lease);
    return true;
  }

  release(lease: SwarmConcurrencyLeaseImpl): void {
    if (lease.disposed || lease.acquired === 0) return;
    lease.acquired -= 1;
    this.inFlight -= 1;
    this.notifyNextWaiter();
  }

  disposeLease(lease: SwarmConcurrencyLeaseImpl): void {
    if (lease.disposed) return;
    lease.disposed = true;
    this.removeWaiter(lease);
    this.leases.delete(lease);
    this.inFlight -= lease.acquired;
    lease.acquired = 0;
    this.notifyNextWaiter();
  }

  override dispose(): void {
    for (const lease of [...this.leases]) lease.dispose();
    super.dispose();
  }

  private grant(lease: SwarmConcurrencyLeaseImpl): void {
    lease.waiting = false;
    lease.acquired += 1;
    this.inFlight += 1;
  }

  private enqueue(lease: SwarmConcurrencyLeaseImpl): void {
    if (lease.waiting || lease.disposed || lease.acquired >= lease.maxConcurrency) return;
    lease.waiting = true;
    this.waiters.push(lease);
  }

  private removeWaiter(lease: SwarmConcurrencyLeaseImpl): void {
    if (!lease.waiting) return;
    lease.waiting = false;
    const index = this.waiters.indexOf(lease);
    if (index !== -1) this.waiters.splice(index, 1);
  }

  private notifyNextWaiter(): void {
    if (this.notifying !== undefined || this.inFlight >= this.budget) return;

    let lease = this.waiters.shift();
    while (lease !== undefined && lease.disposed) {
      lease = this.waiters.shift();
    }
    if (lease === undefined) return;

    lease.waiting = false;
    this.notifying = lease;
    queueMicrotask(() => {
      try {
        if (!lease.disposed) {
          lease.notified = true;
          lease.onPermitAvailable();
        }
      } finally {
        lease.notified = false;
        if (this.notifying === lease) this.notifying = undefined;
        this.notifyNextWaiter();
      }
    });
  }
}

export function resolveSwarmGlobalMaxConcurrency(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[AGENT_SWARM_GLOBAL_MAX_CONCURRENCY_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_GLOBAL_MAX_CONCURRENCY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `${AGENT_SWARM_GLOBAL_MAX_CONCURRENCY_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`,
      { details: { value: raw } },
    );
  }
  return value;
}
