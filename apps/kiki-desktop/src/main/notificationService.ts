import { EventEmitter } from 'node:events';
import type {
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
}

interface TrackedNotification {
  readonly handle: NativeNotificationHandle;
  readonly deliveryId?: string;
  readonly scopeKey: string;
  readonly sessionIds: ReadonlySet<string>;
}

function makeScopeKey(homeId?: string, scopeId?: string): string {
  return `${homeId ?? 'main'}::${scopeId ?? 'default'}`;
}

export class NotificationService extends EventEmitter {
  private nextNavigationSeq = 1;
  private pendingIntent: NotificationNavigationIntent | { readonly connectionId: string } | null = null;
  private readonly active = new Set<TrackedNotification>();
  private readonly unreadByScope = new Map<string, number>();

  constructor(private readonly deps: NotificationServiceDeps) {
    super();
  }

  setPendingRemoteConnectionIntent(connectionId: string): void {
    this.pendingIntent = { connectionId };
  }

  onClick(listener: (intent: NotificationNavigationIntent) => void): () => void {
    this.on('click', listener);
    return () => {
      this.off('click', listener);
    };
  }

  async send(options: HostNotification): Promise<void> {
    if (!this.deps.isSupported()) return;

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
      scopeKey,
      sessionIds: new Set(options.sessionIds ?? []),
    };
    this.active.add(tracked);

    handle.on('close', () => {
      this.active.delete(tracked);
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
        this.emit('click', intent);
      }
    });

    handle.show();
  }

  acknowledge(sessionId: string, scope: NavScopeIdentity, deliveryId?: string): void {
    const scopeKey = makeScopeKey(scope.homeId, scope.scopeId);
    for (const entry of this.active) {
      const matchesDelivery = deliveryId !== undefined && entry.deliveryId === deliveryId;
      const matchesSession = entry.scopeKey === scopeKey && entry.sessionIds.has(sessionId);
      if (matchesDelivery || matchesSession) {
        this.active.delete(entry);
        try {
          entry.handle.close();
        } catch {
          // Ignore already-closed OS notification.
        }
      }
    }
  }

  takeNavigationIntent(): NotificationNavigationIntent | { readonly connectionId: string } | null {
    const current = this.pendingIntent;
    this.pendingIntent = null;
    return current;
  }

  ackNavigationIntent(navigationId: string): boolean {
    if (
      this.pendingIntent !== null &&
      'navigationId' in this.pendingIntent &&
      this.pendingIntent.navigationId === navigationId
    ) {
      this.pendingIntent = null;
      return true;
    }
    return false;
  }

  setUnreadBadge(count: number, homeId?: string, scopeId?: string): number {
    const clamped = Math.max(0, Math.min(0xffffffff, Math.trunc(count)));
    const key = makeScopeKey(homeId, scopeId);
    if (clamped === 0) {
      this.unreadByScope.delete(key);
    } else {
      this.unreadByScope.set(key, clamped);
    }
    let total = 0;
    for (const value of this.unreadByScope.values()) total += value;
    this.deps.setOsBadgeCount?.(total);
    return total;
  }

  activeCount(): number {
    return this.active.size;
  }
}
