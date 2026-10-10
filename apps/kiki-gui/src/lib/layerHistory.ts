/**
 * Browser-back integration for full-screen transient layers on touch devices
 * (the phone session drawer, bottom sheets): while a layer is open it owns
 * exactly one history entry, so the phone's back closes the top layer before
 * it touches route navigation.
 *
 * The pushed entry carries the current entry's `usr` state untouched plus a
 * `kikiLayer` marker. Because `usr.kikiNav.visitId` still matches the visit
 * underneath, react-router's POP handling stays on the same location and
 * navHistory never records a phantom visit for a layer.
 *
 * Contract:
 * - Opening pushes one entry per layer; layers nest as a stack and back peels
 *   the top one.
 * - Closing through any in-app path (✕, backdrop, Esc, route change) consumes
 *   the entry again via history.back() when it is still current. An entry
 *   buried under a later route push (e.g. the user picked a session inside
 *   the drawer) is left alone: back then returns to the route the layer sat
 *   on, which is the navigation the user expects.
 * - Deep links and reloads never resurrect a layer; entries are runtime-only
 *   and the stack is in-memory.
 */
import { useEffect, useRef } from 'react';

interface LayerEntry {
  readonly id: string;
  readonly onClose: () => void;
}

const stack: LayerEntry[] = [];
let listenerArmed = false;
let consumingOwnEntry = false;

function currentLayerId(): string | undefined {
  const state: unknown = window.history.state;
  if (typeof state !== 'object' || state === null) return undefined;
  const usr = (state as { usr?: unknown }).usr;
  if (typeof usr !== 'object' || usr === null) return undefined;
  const marker = (usr as { kikiLayer?: unknown }).kikiLayer;
  return typeof marker === 'string' ? marker : undefined;
}

function onPopState(): void {
  if (consumingOwnEntry) {
    consumingOwnEntry = false;
    return;
  }
  const top = stack[stack.length - 1];
  if (top === undefined) return;
  if (currentLayerId() === top.id) return;
  stack.pop();
  top.onClose();
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
    const entry: LayerEntry = { id, onClose: () => closeRef.current() };
    stack.push(entry);
    const state: unknown = window.history.state;
    const base = typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : {};
    const usr =
      typeof (base as { usr?: unknown }).usr === 'object' && (base as { usr?: unknown }).usr !== null
        ? ((base as { usr: Record<string, unknown> }).usr)
        : {};
    window.history.pushState({ ...base, usr: { ...usr, kikiLayer: id } }, '');
    return () => {
      const index = stack.indexOf(entry);
      if (index === -1) return;
      stack.splice(index, 1);
      const wasTop = index === stack.length;
      if (wasTop && currentLayerId() === id) {
        consumingOwnEntry = true;
        window.history.back();
      }
    };
  }, [id, open]);
}
