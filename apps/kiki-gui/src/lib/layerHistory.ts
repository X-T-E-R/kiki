/**
 * Browser-back integration for full-screen transient layers on touch devices
 * (the phone session drawer, bottom sheets, dialogs): while a layer is open it
 * owns exactly one history entry, so the phone's back closes the top layer
 * before it touches route navigation.
 *
 * The pushed entry carries the current entry's `usr` state untouched plus a
 * `kikiLayer` marker and a per-push `kikiLayerToken`. Because
 * `usr.kikiNav.visitId` still matches the visit underneath, react-router's POP
 * handling stays on the same location and navHistory never records a phantom
 * visit for a layer.
 *
 * Contract:
 * - Opening pushes one entry per layer; layers nest as a stack and back peels
 *   the top one.
 * - Closing through any in-app path (✕, backdrop, Esc, route change) consumes
 *   the entry again when it is still current. An entry buried under a later
 *   route push (e.g. the user picked a session inside the drawer) is left
 *   alone: back then returns to the route the layer sat on, which is the
 *   navigation the user expects.
 * - Deep links and reloads never resurrect a layer; entries are runtime-only,
 *   the stack is in-memory, and tokens carry a per-page-load nonce so an entry
 *   left over from an earlier load never matches a live layer.
 *
 * Layers can close together — a confirmation inside a dialog, a dialog whose
 * drawer closes in the same beat — and React runs their effect cleanups in an
 * order nothing can rely on (child-first on an update, parent-first on an
 * unmount). So a cleanup never navigates by itself: it marks its entry closed
 * and queues one reconcile after the commit, which consumes every closed entry
 * sitting contiguously on top of the history with a single `history.go(-n)`.
 * `history.go` is asynchronous, so while a traversal is in flight
 * (`pendingTraversals`) the history position is unknown: popstates are
 * attributed to it, reconciling waits for it to land, and a layer opened in
 * the meantime pushes its entry only afterwards.
 */
import { useEffect, useRef } from 'react';

interface LayerEntry {
  readonly id: string;
  /** Unique per push; the history entry's `usr.kikiLayerToken`. */
  readonly token: string;
  /**
   * Token of the layer entry this one was pushed directly on top of, or
   * undefined when it sits on a route entry. Only a chain of these links may
   * be consumed in one traversal — a route push in between must survive.
   */
  below: string | undefined;
  readonly onClose: () => void;
  /** False while its push waits for an in-flight traversal to land. */
  pushed: boolean;
  /** Closed in-app; its entry waits for the reconcile to consume it. */
  closed: boolean;
}

const stack: LayerEntry[] = [];
const pageNonce = Math.random().toString(36).slice(2, 10);
let sequence = 0;
let listenerArmed = false;
let pendingTraversals = 0;
let reconcileQueued = false;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function currentToken(): string | undefined {
  const token = asRecord(asRecord(window.history.state)?.['usr'])?.['kikiLayerToken'];
  return typeof token === 'string' ? token : undefined;
}

function pushEntry(entry: LayerEntry): void {
  const base = asRecord(window.history.state) ?? {};
  const usr = asRecord(base['usr']) ?? {};
  const below = usr['kikiLayerToken'];
  entry.below = typeof below === 'string' ? below : undefined;
  window.history.pushState({ ...base, usr: { ...usr, kikiLayer: entry.id, kikiLayerToken: entry.token } }, '');
  entry.pushed = true;
}

function reconcile(): void {
  reconcileQueued = false;
  if (pendingTraversals > 0) return;
  let top = stack.length - 1;
  while (top >= 0 && !stack[top]!.pushed) top -= 1;
  if (top >= 0 && stack[top]!.closed) {
    let bottom = top;
    if (currentToken() === stack[top]!.token) {
      while (bottom > 0 && stack[bottom - 1]!.closed && stack[bottom]!.below === stack[bottom - 1]!.token) bottom -= 1;
      stack.splice(bottom, top - bottom + 1);
      pendingTraversals += 1;
      window.history.go(-(top - bottom + 1));
      // Deferred pushes wait for this traversal's popstate.
      return;
    }
    // Buried under a later route push: leave history alone and forget the
    // closed layers — every one of them sits under that route entry.
    while (bottom > 0 && stack[bottom - 1]!.closed) bottom -= 1;
    stack.splice(bottom, top - bottom + 1);
  }
  for (const entry of stack) if (!entry.pushed && !entry.closed) pushEntry(entry);
}

function queueReconcile(): void {
  if (reconcileQueued) return;
  reconcileQueued = true;
  queueMicrotask(reconcile);
}

function onPopState(): void {
  if (pendingTraversals > 0) {
    pendingTraversals -= 1;
    if (pendingTraversals === 0) reconcile();
    return;
  }
  // The user went back (or forward). Every layer above the entry they landed
  // on is gone; landing on an entry that is not a live layer peels the top one.
  const token = currentToken();
  const landed = token === undefined ? -1 : stack.findIndex((entry) => entry.token === token);
  const dropped = landed === -1 ? stack.splice(-1) : stack.splice(landed + 1);
  for (const entry of dropped.reverse()) if (!entry.closed) entry.onClose();
  // The entry landed on may itself belong to a layer that already closed
  // under the one just peeled; consume it too.
  reconcile();
}

function armListener(): void {
  if (listenerArmed) return;
  listenerArmed = true;
  window.addEventListener('popstate', onPopState);
}

/**
 * While `open` is true, register `id` as the top history layer; the next
 * browser-back closes it via `onClose` instead of navigating. `onClose` must
 * be idempotent — route-change effects may close the same layer in the same
 * beat.
 */
export function useLayerHistory(id: string, open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    armListener();
    sequence += 1;
    const entry: LayerEntry = {
      id,
      token: `${pageNonce}:${sequence}`,
      below: undefined,
      onClose: () => closeRef.current(),
      pushed: false,
      closed: false,
    };
    stack.push(entry);
    if (pendingTraversals === 0) pushEntry(entry);
    return () => {
      const index = stack.indexOf(entry);
      // Already peeled by a back press.
      if (index === -1) return;
      if (!entry.pushed) {
        stack.splice(index, 1);
        return;
      }
      entry.closed = true;
      queueReconcile();
    };
  }, [id, open]);
}
