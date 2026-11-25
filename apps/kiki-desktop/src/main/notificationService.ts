import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from '@kiki/kaos/atomic-fs';
import { combineSpaceAttentionTotal } from '#/main/spaceBadge';
import type {
  DesktopSpaceStatus,
  HostNotification,
  NavScopeIdentity,
  NotificationNavigationIntent,
} from '#/shared/types';

export interface NativeNotificationHandle {
  show(): void;
  close(): void;
  on(event: 'click' | 'close', listener: () => void): unknown;
}

export interface NotificationServiceDeps {
  readonly isSupported: () => boolean;
  readonly createNotification: (options: {
    readonly title: string;
    readonly body?: string;
    readonly tag?: string;
  }) => NativeNotificationHandle;
  readonly onActivateWindow: () => Promise<void> | void;
  readonly setOsBadgeCount?: (total: number) => void;
  readonly setOverlayBadgeCount?: (total: number) => void;
  readonly registryPath?: string;
}

interface TrackedNotification {
  readonly handle?: NativeNotificationHandle;
  readonly deliveryId?: string;
  readonly tag?: string;
  readonly scopeKey: string;
  readonly sessionIds: ReadonlySet<string>;
  readonly route?: string;
  readonly homeId?: string;
  readonly scope?: NavScopeIdentity;
}

interface PersistedRegistryShape {
  readonly nextNavigationSeq?: number;
  readonly pendingIntent?: NotificationNavigationIntent | { readonly connectionId: string } | null;
  readonly active?: ReadonlyArray<{
    readonly deliveryId?: string;
    readonly tag?: string;
    readonly scopeKey: string;
    readonly sessionIds: readonly string[];
    readonly route?: string;
    readonly homeId?: string;
    readonly scope?: NavScopeIdentity;
  }>;
}

function makeScopeKey(homeId?: string, scopeId?: string): string {
  return `${homeId ?? 'main'}::${scopeId ?? 'default'}`;
}

export class NotificationService extends EventEmitter {
  private nextNavigationSeq = 1;
  private pendingIntent: NotificationNavigationIntent | { readonly connectionId: string } | null = null;
  private readonly active = new Set<TrackedNotification>();
  private readonly unreadByScope = new Map<
    string,
    { readonly count: number; readonly sessionIds: ReadonlySet<string> }
  >();
  private backgroundStatuses: readonly DesktopSpaceStatus[] = [];
  private persistChain: Promise<void> = Promise.resolve();
  private lastReportedBadgeTotal = -1;

  constructor(private readonly deps: NotificationServiceDeps) {
    super();
  }

  async restoreFromDisk(): Promise<void> {
    if (this.deps.registryPath === undefined) return;
    try {
      const raw = JSON.parse(await readFile(this.deps.registryPath, 'utf8')) as PersistedRegistryShape;
      if (typeof raw.nextNavigationSeq === 'number' && Number.isInteger(raw.nextNavigationSeq) && raw.nextNavigationSeq > this.nextNavigationSeq) {
        this.nextNavigationSeq = raw.nextNavigationSeq;
      }
      if (this.pendingIntent === null && raw.pendingIntent !== undefined && raw.pendingIntent !== null) {
        this.pendingIntent = raw.pendingIntent;
      }
      for (const item of raw.active ?? []) {
        this.active.add({
          deliveryId: item.deliveryId,
          tag: item.tag,
          scopeKey: item.scopeKey,
          sessionIds: new Set(item.sessionIds),
          route: item.route,
          homeId: item.homeId,
          scope: item.scope,
        });
      }
    } catch {
      // Ignore missing or unreadable persisted notification registry.
    }
  }

  private schedulePersist(): void {
    const registryPath = this.deps.registryPath;
    if (registryPath === undefined) return;
    const snapshot: PersistedRegistryShape = {
      nextNavigationSeq: this.nextNavigationSeq,
      pendingIntent: this.pendingIntent,
      active: [...this.active].map((entry) => ({
        ...(entry.deliveryId !== undefined ? { deliveryId: entry.deliveryId } : {}),
        ...(entry.tag !== undefined ? { tag: entry.tag } : {}),
        scopeKey: entry.scopeKey,
        sessionIds: [...entry.sessionIds],
        ...(entry.route !== undefined ? { route: entry.route } : {}),
        ...(entry.homeId !== undefined ? { homeId: entry.homeId } : {}),
        ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
      })),
    };
    this.persistChain = this.persistChain
      .then(() => atomicWriteJson(registryPath, snapshot, { preserveDestinationOnError: true }))
      .catch(() => undefined);
  }

  setPendingRemoteConnectionIntent(connectionId: string): void {
    this.pendingIntent = { connectionId };
    this.schedulePersist();
  }

  onClick(listener: (intent: NotificationNavigationIntent) => void): () => void {
    this.on('click', listener);
    return () => {
      this.off('click', listener);
    };
  }

  async send(options: HostNotification): Promise<void> {
    if (!this.deps.isSupported()) return;

    if (options.tag !== undefined && options.tag !== '') {
      for (const existing of this.active) {
        if (existing.tag === options.tag) {
          this.active.delete(existing);
          try {
            existing.handle?.close();
          } catch {
            // Ignore already-closed OS notification.
          }
        }
      }
    }

    const handle = this.deps.createNotification({
      title: options.title,
      body: options.body,
      tag: options.tag,
    });

    const scopeKey = makeScopeKey(
      options.scope?.homeId ?? options.homeId,
      options.scope?.scopeId ?? options.scopeId,
    );
    const tracked: TrackedNotification = {
      handle,
      deliveryId: options.deliveryId,
      tag: options.tag,
      scopeKey,
      sessionIds: new Set(options.sessionIds ?? []),
      route: options.route,
      homeId: options.scope?.homeId ?? options.homeId,
      scope: options.scope,
    };
    this.active.add(tracked);
    this.schedulePersist();

    handle.on('close', () => {
      if (this.active.delete(tracked)) {
        this.schedulePersist();
      }
    });

    handle.on('click', () => {
      this.active.delete(tracked);
      void this.deps.onActivateWindow();
      if (options.route !== undefined && options.route.trim() !== '') {
        const intent: NotificationNavigationIntent = {
          route: options.route,
          homeId: options.scope?.homeId ?? options.homeId,
          scope: options.scope,
          navigationId: String(this.nextNavigationSeq++),
        };
        this.pendingIntent = intent;
        this.schedulePersist();
        this.emit('click', intent);
      } else {
        this.schedulePersist();
      }
    });

    handle.show();
  }

  acknowledge(sessionId: string, scope: NavScopeIdentity, deliveryId?: string): void {
    const scopeKey = makeScopeKey(scope.homeId, scope.scopeId);
    let mutated = false;
    for (const entry of this.active) {
      const matchesDelivery = deliveryId !== undefined && entry.deliveryId === deliveryId;
      const matchesSession = entry.scopeKey === scopeKey && entry.sessionIds.has(sessionId);
      if (matchesDelivery || matchesSession) {
        this.active.delete(entry);
        mutated = true;
        try {
          entry.handle?.close();
        } catch {
          // Ignore already-closed OS notification.
        }
      }
    }
    if (mutated) this.schedulePersist();
  }

  peekNavigationIntent(): NotificationNavigationIntent | { readonly connectionId: string } | null {
    return this.pendingIntent;
  }

  takeNavigationIntent(): NotificationNavigationIntent | { readonly connectionId: string } | null {
    const current = this.pendingIntent;
    this.pendingIntent = null;
    if (current !== null) this.schedulePersist();
    return current;
  }

  ackNavigationIntent(navigationId: string): boolean {
    if (
      this.pendingIntent !== null &&
      'navigationId' in this.pendingIntent &&
      this.pendingIntent.navigationId === navigationId
    ) {
      this.pendingIntent = null;
      this.schedulePersist();
      return true;
    }
    return false;
  }

  private recomputeAndPublishBadge(force = false): number {
    let scopeUnreadTotal = 0;
    const scopeSessionIds = new Set<string>();
    for (const entry of this.unreadByScope.values()) {
      scopeUnreadTotal += entry.count;
      for (const id of entry.sessionIds) scopeSessionIds.add(id);
    }
    const total = combineSpaceAttentionTotal({
      scopeUnreadTotal,
      scopeSessionIds,
      statuses: this.backgroundStatuses,
    });
    if (force || total !== this.lastReportedBadgeTotal) {
      this.lastReportedBadgeTotal = total;
      this.deps.setOsBadgeCount?.(total);
      this.deps.setOverlayBadgeCount?.(total);
    }
    return total;
  }

  setUnreadBadge(
    count: number,
    homeId?: string,
    scopeId?: string,
    sessionIds?: readonly string[],
  ): number {
    const clamped = Math.max(0, Math.min(0xffffffff, Math.trunc(count)));
    const key = makeScopeKey(homeId, scopeId);
    if (clamped === 0) {
      this.unreadByScope.delete(key);
    } else {
      this.unreadByScope.set(key, {
        count: clamped,
        sessionIds: new Set(sessionIds ?? []),
      });
    }
    return this.recomputeAndPublishBadge(true);
  }

  setBackgroundSpaceStatuses(statuses: readonly DesktopSpaceStatus[]): number {
    this.backgroundStatuses = statuses;
    return this.recomputeAndPublishBadge(false);
  }

  currentBadgeTotal(): number {
    return Math.max(0, this.lastReportedBadgeTotal);
  }

  activeCount(): number {
    return this.active.size;
  }
}
