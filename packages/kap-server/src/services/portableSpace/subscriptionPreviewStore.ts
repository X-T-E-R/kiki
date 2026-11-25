import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  PORTABLE_SPACE_PREVIEW_TTL_MS,
  type PortableSpaceEndpoint,
  type PortableSpaceExcludedItem,
  type PortableSpaceFormat,
  type PortableSpaceImpact,
  type PortableSpaceSecretMode,
  type PortableSpaceSubscribePreviewManifest,
  type PortableSpaceSubscriptionSelection,
  type PortableSpaceSyncPolicy,
  type PortableSubscriptionScope,
} from '@kiki/protocol';
import { portablePreviewExpired, portableValidationError } from './subscriptionErrors';
import type { SelectableEntity } from './subscriptionScopes';
import type { PortableSpaceTree, SpaceUnit, Units } from './treeProjection';

const MAX_ACTIVE_SNAPSHOTS_PER_HOME = 8;
const MAX_TOTAL_RETAINED_BYTES = 128 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 30_000;

export type PreviewOperationKind = 'new_subscribe' | 'source_update' | 'remove_source';

export interface PreviewSnapshotBase {
  readonly token: string;
  readonly kind: PreviewOperationKind;
  readonly homeKey: string;
  readonly targetSpaceId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly retainedBytes: number;
  readonly targetRevision: string;
  readonly catalogRevision: string;
  readonly orderRevision: string;
  readonly sourceId?: string;
  readonly sourceRevision?: string;
  inFlight: boolean;
  consumed: boolean;
}

export interface SubscribePreviewSnapshot extends PreviewSnapshotBase {
  readonly kind: 'new_subscribe' | 'source_update';
  readonly endpoint: Extract<PortableSpaceEndpoint, { kind: 'url' | 'archive' }>;
  readonly format: PortableSpaceFormat;
  readonly secretMode: PortableSpaceSecretMode;
  readonly encryptionMode: PortableSpaceTree['encryptionMode'];
  readonly overlay: boolean;
  readonly requiresInteractiveUnlock: boolean;
  readonly allowedPolicies: readonly PortableSpaceSyncPolicy[];
  readonly suggestedLabel: string;
  readonly displayOrigin: string;
  readonly etag?: string;
  readonly finalOrigin?: string;
  readonly packDigest: string;
  readonly units: Units;
  readonly excluded: readonly PortableSpaceExcludedItem[];
  readonly entities: readonly SelectableEntity[];
  readonly entityIdByMemberUnitId: ReadonlyMap<string, string>;
  readonly consumerItemIdsByCredential: ReadonlyMap<string, readonly string[]>;
  readonly manifest: PortableSpaceSubscribePreviewManifest;
  readonly presentScopes: readonly PortableSubscriptionScope[];
  readonly reviewedImpact?: {
    readonly selection: PortableSpaceSubscriptionSelection;
    readonly cleanupDeselected: boolean;
    readonly impact: PortableSpaceImpact;
    readonly impactDigest: string;
  };
}

export interface RemovePreviewSnapshot extends PreviewSnapshotBase {
  readonly kind: 'remove_source';
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly managedCount: number;
  readonly impact: PortableSpaceImpact;
  readonly impactDigest: string;
}

export type StoredPreviewSnapshot = SubscribePreviewSnapshot | RemovePreviewSnapshot;

export type SnapshotForOperation<K extends PreviewOperationKind> = K extends 'remove_source'
  ? RemovePreviewSnapshot
  : SubscribePreviewSnapshot;

function estimateUnitBytes(unit: SpaceUnit): number {
  if (Buffer.isBuffer(unit.value)) return unit.value.byteLength + unit.path.length * 2 + 128;
  return Buffer.byteLength(JSON.stringify(unit.value), 'utf8') + unit.path.length * 2 + 128;
}

/** Estimates the retained memory footprint of a sanitized preview unit map plus manifest. */
export function estimateSnapshotBytes(units: Units, extraBytes = 0): number {
  let total = extraBytes;
  for (const unit of units.values()) total += estimateUnitBytes(unit);
  return total;
}

/** Bounded, fixed-TTL in-memory snapshot store with process-private HMAC keying and single-flight commit guards. */
export class SubscriptionPreviewStore {
  private readonly secretKey = randomBytes(32);
  private readonly snapshots = new Map<string, StoredPreviewSnapshot>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly ttlMs = PORTABLE_SPACE_PREVIEW_TTL_MS) {
    this.sweepTimer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /** Computes a process-private keyed digest so secret hashes cannot be used as an offline oracle. */
  privateDigest(payload: string): string {
    return createHmac('sha256', this.secretKey).update(payload).digest('hex');
  }

  /** Issues an opaque preview token and stores the bounded snapshot with fixed non-sliding TTL. */
  put<T extends StoredPreviewSnapshot>(
    build: (meta: { readonly token: string; readonly createdAt: number; readonly expiresAt: number }) => T,
  ): T {
    const now = Date.now();
    this.sweepExpired(now);
    const token = randomUUID();
    const snapshot = build({ token, createdAt: now, expiresAt: now + this.ttlMs });
    if (snapshot.retainedBytes > MAX_TOTAL_RETAINED_BYTES) {
      throw portableValidationError('Portable Space preview snapshot exceeds maximum retained memory budget');
    }
    this.evictForBudget(snapshot.homeKey, snapshot.retainedBytes);
    this.snapshots.set(token, snapshot);
    return snapshot;
  }

  /** Reads a live, unconsumed, non-expired snapshot without extending its fixed TTL. */
  peek<K extends PreviewOperationKind>(
    token: string,
    kind: K,
    homeKey: string,
  ): SnapshotForOperation<K> {
    const now = Date.now();
    this.sweepExpired(now);
    const entry = this.snapshots.get(token);
    if (entry === undefined || entry.consumed || entry.expiresAt <= now) {
      this.snapshots.delete(token);
      throw portablePreviewExpired();
    }
    if (entry.kind !== kind || entry.homeKey !== homeKey) {
      throw portablePreviewExpired('Preview token does not match this operation or home');
    }
    return entry as SnapshotForOperation<K>;
  }

  /** Updates cached review state on a live snapshot without renewing its expiry. */
  replace<T extends StoredPreviewSnapshot>(snapshot: T): void {
    const existing = this.snapshots.get(snapshot.token);
    if (existing === undefined || existing.consumed || existing.expiresAt <= Date.now()) {
      throw portablePreviewExpired();
    }
    this.snapshots.set(snapshot.token, snapshot);
  }

  /** Acquires single-flight consumption on a preview token; marks consumed on commit or releases on validation/stale error. */
  async withConsumption<K extends PreviewOperationKind, R>(
    token: string,
    kind: K,
    homeKey: string,
    run: (snapshot: SnapshotForOperation<K>) => Promise<R>,
  ): Promise<R> {
    const snapshot = this.peek(token, kind, homeKey);
    if (snapshot.inFlight) {
      throw portablePreviewExpired('Preview token is already being applied by another request');
    }
    snapshot.inFlight = true;
    try {
      const result = await run(snapshot);
      snapshot.consumed = true;
      this.snapshots.delete(token);
      return result;
    } catch (error) {
      snapshot.inFlight = false;
      throw error;
    }
  }

  /** Sweeps expired snapshots even if no new preview requests arrive. */
  sweepExpired(now = Date.now()): void {
    for (const [token, snapshot] of this.snapshots) {
      if (!snapshot.inFlight && (snapshot.consumed || snapshot.expiresAt <= now)) {
        this.snapshots.delete(token);
      }
    }
  }

  /** Releases all retained snapshots and stops the background sweep timer on shutdown. */
  dispose(): void {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.snapshots.clear();
  }

  private evictForBudget(homeKey: string, incomingBytes: number): void {
    const sameHome = [...this.snapshots.values()]
      .filter((entry) => entry.homeKey === homeKey && !entry.inFlight)
      .sort((a, b) => a.createdAt - b.createdAt);
    while (sameHome.length >= MAX_ACTIVE_SNAPSHOTS_PER_HOME) {
      const oldest = sameHome.shift()!;
      this.snapshots.delete(oldest.token);
    }
    let totalBytes = 0;
    for (const entry of this.snapshots.values()) totalBytes += entry.retainedBytes;
    const allEvictable = [...this.snapshots.values()]
      .filter((entry) => !entry.inFlight)
      .sort((a, b) => a.createdAt - b.createdAt);
    while (totalBytes + incomingBytes > MAX_TOTAL_RETAINED_BYTES && allEvictable.length > 0) {
      const oldest = allEvictable.shift()!;
      totalBytes -= oldest.retainedBytes;
      this.snapshots.delete(oldest.token);
    }
    if (totalBytes + incomingBytes > MAX_TOTAL_RETAINED_BYTES) {
      throw portableValidationError('Too many active preview snapshots; retry after pending operations finish');
    }
  }
}
