import type { DesktopNativePrefs } from '@kiki/session-core/settings';

import { desktopPluginFocus } from '../lib/pluginFocus';
import type {
  DesktopWindowMode,
  HostPluginFocusIntent,
  HostSubscribeIntent,
  LocalConnection,
} from './host';

export function normalizeHostPath(path: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

export function clampUnreadBadgeCount(count: number): number {
  return Math.max(0, Math.min(0xffffffff, Math.trunc(count)));
}

export function normalizeDesktopPrefsPatch(prefs: Partial<DesktopNativePrefs>): Partial<DesktopNativePrefs> {
  // JSON drops undefined keys; an explicitly cleared record must reach native.
  return Object.hasOwn(prefs, 'updateState') && prefs.updateState === undefined
    ? { ...prefs, updateState: {} }
    : prefs;
}

export function parseDesktopWindowMode(value: unknown): DesktopWindowMode | null {
  if (typeof value !== 'object' || value === null) return null;
  const mode = value as { presetId?: unknown; windowId?: unknown };
  if (typeof mode.presetId !== 'string' || typeof mode.windowId !== 'string') return null;
  return { presetId: mode.presetId, windowId: mode.windowId };
}

export function parsePluginFocusIntent(value: unknown): HostPluginFocusIntent | null {
  return desktopPluginFocus(value) ?? null;
}

export function parseSubscribeIntentPayload(value: unknown): HostSubscribeIntent | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || record['id'].trim() === '') return null;
  if (typeof record['url'] !== 'string' || record['url'].trim() === '') return null;
  const mode = record['mode'];
  const parsedMode = mode === 'auto' || mode === 'manual' || mode === 'once' ? mode : undefined;
  const name = typeof record['name'] === 'string' && record['name'].trim() !== '' ? record['name'].trim() : undefined;
  return {
    id: record['id'],
    url: record['url'].trim(),
    ...(name !== undefined ? { name } : {}),
    ...(parsedMode !== undefined ? { mode: parsedMode } : {}),
  };
}

export interface DesktopConnectionCoordinator<T extends LocalConnection | null> {
  discover(): Promise<T>;
  cancelStartup(): Promise<void>;
  setWorkspaceScope(scope: 'local' | 'ssh'): void;
  requireLocalWorkspace(): void;
}

export function createDesktopConnectionCoordinator<T extends LocalConnection | null>(deps: {
  readonly discoverOnce: () => Promise<T>;
  readonly cancelOnce: () => Promise<void>;
  readonly onScopeChange?: (scope: 'local' | 'ssh') => void;
}): DesktopConnectionCoordinator<T> {
  let discovery: Promise<T> | null = null;
  let cancellation: Promise<void> | null = null;
  let remoteWorkspaceActive = false;

  return {
    async discover(): Promise<T> {
      if (cancellation !== null) await cancellation;
      if (discovery === null) {
        const flight = deps.discoverOnce();
        discovery = flight;
        const release = () => {
          if (discovery === flight) discovery = null;
        };
        void flight.then(release, release);
      }
      return discovery;
    },
    async cancelStartup(): Promise<void> {
      if (cancellation !== null) return cancellation;
      const pending = discovery;
      const active = deps.cancelOnce().then(async () => {
        await pending?.catch(() => undefined);
      });
      cancellation = active;
      try {
        await active;
      } finally {
        if (cancellation === active) cancellation = null;
      }
    },
    setWorkspaceScope(scope: 'local' | 'ssh'): void {
      remoteWorkspaceActive = scope === 'ssh';
      deps.onScopeChange?.(scope);
    },
    requireLocalWorkspace(): void {
      if (remoteWorkspaceActive) {
        throw new Error('This is an SSH workspace. Use a remote server operation, not a local file or directory action.');
      }
    },
  };
}

export interface SubscribeIntentController {
  peekSubscribeIntent(): Promise<HostSubscribeIntent | null>;
  ackSubscribeIntent(id: string): Promise<boolean>;
  onSubscribeIntent(callback: (intent: HostSubscribeIntent) => void): () => void;
  onSubscribeUrl(callback: (url: string) => void): () => void;
}

export function createSubscribeIntentController(deps: {
  readonly peek: () => Promise<unknown>;
  readonly ack: (id: string) => Promise<boolean>;
  readonly listenIntentWake: (onWake: () => void) => Promise<() => void> | (() => void);
  readonly listenLegacyUrl: (onUrl: (url: string) => void) => Promise<() => void> | (() => void);
}): SubscribeIntentController {
  const pumps = new Set<() => void>();

  async function peekSubscribeIntent(): Promise<HostSubscribeIntent | null> {
    try {
      return parseSubscribeIntentPayload(await deps.peek());
    } catch {
      return null;
    }
  }

  async function ackSubscribeIntent(id: string): Promise<boolean> {
    try {
      const acked = await deps.ack(id);
      if (acked) {
        for (const pump of pumps) pump();
      }
      return acked;
    } catch {
      return false;
    }
  }

  function onSubscribeIntent(callback: (intent: HostSubscribeIntent) => void): () => void {
    let unsubscribed = false;
    let unlisten: (() => void) | undefined;
    let pumping = false;
    let dirty = false;
    let lastDeliveredId: string | undefined;

    const pump = async () => {
      if (unsubscribed) return;
      if (pumping) {
        dirty = true;
        return;
      }
      pumping = true;
      try {
        do {
          dirty = false;
          const head = await peekSubscribeIntent();
          if (unsubscribed || head === null) break;
          if (head.id !== lastDeliveredId) {
            lastDeliveredId = head.id;
            callback(head);
          }
        } while (dirty && !unsubscribed);
      } finally {
        pumping = false;
      }
    };

    const triggerPump = () => {
      void pump();
    };
    pumps.add(triggerPump);

    const attached = deps.listenIntentWake(triggerPump);
    if (typeof attached === 'function') {
      unlisten = attached;
      triggerPump();
    } else {
      void attached.then((fn) => {
        if (unsubscribed) {
          fn();
          return;
        }
        unlisten = fn;
        triggerPump();
      }, () => undefined);
    }

    return () => {
      unsubscribed = true;
      pumps.delete(triggerPump);
      unlisten?.();
    };
  }

  function onSubscribeUrl(callback: (url: string) => void): () => void {
    let unsubscribed = false;
    let legacyUnlisten: (() => void) | undefined;
    const unsubscribeIntent = onSubscribeIntent((intent) => {
      if (unsubscribed) return;
      callback(intent.url);
      void ackSubscribeIntent(intent.id);
    });
    const pending = (globalThis as { __KIKI_SUBSCRIBE_URL__?: unknown }).__KIKI_SUBSCRIBE_URL__;
    if (typeof pending === 'string' && pending.trim() !== '') {
      queueMicrotask(() => {
        if (unsubscribed) return;
        const current = (globalThis as { __KIKI_SUBSCRIBE_URL__?: unknown }).__KIKI_SUBSCRIBE_URL__;
        if (typeof current !== 'string' || current.trim() === '') return;
        delete (globalThis as { __KIKI_SUBSCRIBE_URL__?: unknown }).__KIKI_SUBSCRIBE_URL__;
        callback(current.trim());
      });
    }
    const deliverUrl = (url: string) => {
      if (!unsubscribed && url.trim() !== '') callback(url.trim());
    };
    const attached = deps.listenLegacyUrl(deliverUrl);
    if (typeof attached === 'function') {
      legacyUnlisten = attached;
    } else {
      void attached.then((fn) => {
        if (unsubscribed) fn();
        else legacyUnlisten = fn;
      }, () => undefined);
    }
    return () => {
      unsubscribed = true;
      unsubscribeIntent();
      legacyUnlisten?.();
    };
  }

  return {
    peekSubscribeIntent,
    ackSubscribeIntent,
    onSubscribeIntent,
    onSubscribeUrl,
  };
}
