/**
 * Session plugin-panel preview bridge — connects chrome rendered outside a
 * session's `<MediaPreviewProvider>` (`<Sidebar>` in `App.tsx`, or route
 * transitions landing on `/s/:id`) to the resident `PreviewWorkspace` inside
 * the active conversation.
 *
 * Mirrors `timelineLocate.ts` and `requestPluginPromptInsert`:
 * - A session-level `MediaPreviewProvider` docked in `ConversationShell`
 *   registers its `openPluginPanel` handler and publishes its currently
 *   focused plugin panel key (`<pluginId>:<panelId>`) for `Sidebar` active-row
 *   highlighting via `useSyncExternalStore`.
 * - Callers on another route (`/new`, `/discover`, `/capabilities`) with a
 *   reachable session id can queue a pending open request before navigating to
 *   `/s/:id`; the mounting session `MediaPreviewProvider` drains it once
 *   mounted.
 */

import { useSyncExternalStore } from 'react';

export interface SessionPluginPanelOpenRequest {
  readonly pluginId: string;
  readonly panelId: string;
  readonly title?: string;
}

export interface SessionPluginPanelSnapshot {
  readonly sessionId: string | undefined;
  /** `<pluginId>:<panelId>` when a plugin tab is active in an expanded preview workspace. */
  readonly activePluginPanelKey: string | undefined;
}

interface RegisteredOpener {
  readonly token: symbol;
  readonly sessionId: string;
  readonly agentId: string;
  open: (request: SessionPluginPanelOpenRequest) => void;
  activePluginPanelKey: string | undefined;
}

interface QueuedRequest extends SessionPluginPanelOpenRequest {
  readonly targetSessionId?: string;
  readonly expiresAt: number;
}

const QUEUE_TTL_MS = 10_000;
const EMPTY_SNAPSHOT: SessionPluginPanelSnapshot = {
  sessionId: undefined,
  activePluginPanelKey: undefined,
};

const openers: RegisteredOpener[] = [];
const listeners = new Set<() => void>();
let queuedRequest: QueuedRequest | null = null;
let currentSnapshot: SessionPluginPanelSnapshot = EMPTY_SNAPSHOT;

function primaryOpener(targetSessionId?: string): RegisteredOpener | undefined {
  for (let index = openers.length - 1; index >= 0; index -= 1) {
    const candidate = openers[index]!;
    if (
      candidate.agentId === 'main' &&
      (targetSessionId === undefined || candidate.sessionId === targetSessionId)
    ) {
      return candidate;
    }
  }
  for (let index = openers.length - 1; index >= 0; index -= 1) {
    const candidate = openers[index]!;
    if (targetSessionId === undefined || candidate.sessionId === targetSessionId) {
      return candidate;
    }
  }
  return undefined;
}

function recomputeSnapshot(): void {
  const opener = primaryOpener();
  const nextSessionId = opener?.sessionId;
  const nextActiveKey = opener?.activePluginPanelKey;
  if (
    currentSnapshot.sessionId === nextSessionId &&
    currentSnapshot.activePluginPanelKey === nextActiveKey
  ) {
    return;
  }
  currentSnapshot = {
    sessionId: nextSessionId,
    activePluginPanelKey: nextActiveKey,
  };
  for (const listener of listeners) listener();
}

function drainQueuedForOpener(entry: RegisteredOpener): void {
  if (queuedRequest === null) return;
  if (Date.now() > queuedRequest.expiresAt) {
    queuedRequest = null;
    return;
  }
  if (
    queuedRequest.targetSessionId !== undefined &&
    queuedRequest.targetSessionId !== entry.sessionId
  ) {
    return;
  }
  const pending = queuedRequest;
  queuedRequest = null;
  entry.open({
    pluginId: pending.pluginId,
    panelId: pending.panelId,
    title: pending.title,
  });
}

export function registerSessionPluginPanelOpener(options: {
  readonly sessionId: string;
  readonly agentId?: string;
  readonly open: (request: SessionPluginPanelOpenRequest) => void;
  readonly activePluginPanelKey?: string;
}): {
  readonly update: (patch: {
    readonly open: (request: SessionPluginPanelOpenRequest) => void;
    readonly activePluginPanelKey?: string;
  }) => void;
  readonly unregister: () => void;
} {
  const entry: RegisteredOpener = {
    token: Symbol('session-plugin-panel-opener'),
    sessionId: options.sessionId,
    agentId: options.agentId ?? 'main',
    open: options.open,
    activePluginPanelKey: options.activePluginPanelKey,
  };
  openers.push(entry);
  recomputeSnapshot();
  if (entry.agentId === 'main') {
    drainQueuedForOpener(entry);
  }
  return {
    update: (patch) => {
      entry.open = patch.open;
      entry.activePluginPanelKey = patch.activePluginPanelKey;
      recomputeSnapshot();
    },
    unregister: () => {
      const index = openers.findIndex((item) => item.token === entry.token);
      if (index !== -1) {
        openers.splice(index, 1);
        recomputeSnapshot();
      }
    },
  };
}

/**
 * Attempt to open a plugin panel directly in a mounted session `PreviewWorkspace`.
 * Returns `true` when handled immediately in-session, `false` when no matching
 * session preview workspace is currently mounted.
 */
export function requestSessionPluginPanelOpen(
  request: SessionPluginPanelOpenRequest,
  targetSessionId?: string,
): boolean {
  const opener = primaryOpener(targetSessionId);
  if (opener === undefined) return false;
  opener.open(request);
  return true;
}

/**
 * Queue a plugin panel to open as soon as the target session's `PreviewWorkspace`
 * mounts (e.g. when navigating from `/new` or `/capabilities` to `/s/:id`).
 */
export function queueSessionPluginPanelOpen(
  request: SessionPluginPanelOpenRequest,
  targetSessionId?: string,
): void {
  if (requestSessionPluginPanelOpen(request, targetSessionId)) {
    queuedRequest = null;
    return;
  }
  queuedRequest = {
    ...request,
    targetSessionId,
    expiresAt: Date.now() + QUEUE_TTL_MS,
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SessionPluginPanelSnapshot {
  return currentSnapshot;
}

export function useSessionPluginPanelSnapshot(): SessionPluginPanelSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT);
}

/** Test-only reset for isolated unit specs. */
export function resetSessionPluginPanelOpenersForTests(): void {
  openers.length = 0;
  queuedRequest = null;
  currentSnapshot = EMPTY_SNAPSHOT;
  for (const listener of listeners) listener();
}
