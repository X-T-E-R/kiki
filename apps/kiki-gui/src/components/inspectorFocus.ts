/**
 * Inspector focus — which agent the session inspector (right rail) describes.
 *
 * Rules, in one place so they stay stable:
 *
 * - PIN (switches the inspector): a primary-button pointerdown or a keyboard
 *   focus landing on an agent surface. The nearest agent surface around the
 *   target wins:
 *     1. a subagent card in any timeline (`[data-subagent-id]`)
 *     2. a subagent node in the inspector's tree (`[data-session-rail] [data-agent-id]`)
 *     3. an embedded agent pane — a preview panel tab (`panel:<id>`) or an
 *        agent workspace root (`[data-agent-workspace-target]`)
 *     4. anywhere else in the conversation column (header, transcript,
 *        composer) → the main agent
 *   Everything else — the inspector's own content, file previews, menus and
 *   dialogs portaled to <body> — leaves the pin where it is.
 * - PEEK (never switches): hovering one of surfaces 1–3 for a short dwell
 *   marks that agent in the inspector's tree. Leaving clears it at once, so
 *   sweeping the pointer across the page can never make the panel flicker.
 *
 * The peek lives in a tiny external store: hover churn re-renders only the
 * tree rows that subscribe to it, never the session view.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

import { MAIN_AGENT_ID } from '@kiki/session-core/session';

const PEEK_DWELL_MS = 180;

const SURFACE_SELECTOR = [
  '[data-subagent-id]',
  '[data-session-rail] [data-agent-id]',
  '[data-preview-tabpanel^="panel:"]',
  '[data-agent-workspace-target]',
  '.conversation-center',
].join(', ');

/**
 * The agent a DOM target belongs to: an agent id, `MAIN_AGENT_ID` for the
 * conversation column, or `null` when the target is not an agent surface.
 */
export function resolveInspectorTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const surface = target.closest(SURFACE_SELECTOR);
  if (surface === null) return null;
  if (!(surface instanceof HTMLElement)) return null;
  const { subagentId, agentId, previewTabpanel, agentWorkspaceTarget } = surface.dataset;
  if (subagentId !== undefined && subagentId !== '') return subagentId;
  if (agentId !== undefined && agentId !== '') return agentId;
  if (previewTabpanel !== undefined && previewTabpanel.startsWith('panel:')) {
    return previewTabpanel.slice('panel:'.length) || null;
  }
  if (agentWorkspaceTarget !== undefined && agentWorkspaceTarget !== '') return agentWorkspaceTarget;
  return MAIN_AGENT_ID;
}

// ---- peek store -----------------------------------------------------------

let peekAgentId: string | undefined;
const peekListeners = new Set<() => void>();

function setPeek(next: string | undefined): void {
  if (next === peekAgentId) return;
  peekAgentId = next;
  for (const listener of peekListeners) listener();
}

function subscribePeek(listener: () => void): () => void {
  peekListeners.add(listener);
  return () => { peekListeners.delete(listener); };
}

/** The agent currently hovered (after the dwell), or undefined. */
export function useInspectorPeek(): string | undefined {
  return useSyncExternalStore(subscribePeek, () => peekAgentId, () => undefined);
}

// ---- tracker --------------------------------------------------------------

/**
 * Install the document-level pin/peek listeners for one session view.
 * `onPin` receives `undefined` for the main agent. `isKnown` filters ids the
 * current agent forest cannot resolve (stale cards, foreign sessions).
 */
export function useInspectorFocusTracking({
  onPin,
  isKnown,
}: {
  onPin: (agentId: string | undefined) => void;
  isKnown: (agentId: string) => boolean;
}): void {
  const onPinRef = useRef(onPin);
  onPinRef.current = onPin;
  const isKnownRef = useRef(isKnown);
  isKnownRef.current = isKnown;

  useEffect(() => {
    let dwell: ReturnType<typeof setTimeout> | undefined;
    let pending: string | undefined;

    const pin = (target: EventTarget | null) => {
      const agentId = resolveInspectorTarget(target);
      if (agentId === null) return;
      if (agentId === MAIN_AGENT_ID) {
        onPinRef.current(undefined);
        return;
      }
      if (isKnownRef.current(agentId)) onPinRef.current(agentId);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      pin(event.target);
    };
    const onFocusIn = (event: FocusEvent) => { pin(event.target); };
    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const agentId = resolveInspectorTarget(event.target);
      const next = agentId === null || agentId === MAIN_AGENT_ID || !isKnownRef.current(agentId)
        ? undefined
        : agentId;
      if (next === pending) return;
      pending = next;
      if (dwell !== undefined) clearTimeout(dwell);
      dwell = undefined;
      if (next === undefined) {
        setPeek(undefined);
        return;
      }
      dwell = setTimeout(() => { setPeek(next); }, PEEK_DWELL_MS);
    };
    const onLeaveWindow = () => {
      pending = undefined;
      if (dwell !== undefined) clearTimeout(dwell);
      setPeek(undefined);
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('pointerover', onPointerOver, true);
    document.documentElement.addEventListener('pointerleave', onLeaveWindow);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('pointerover', onPointerOver, true);
      document.documentElement.removeEventListener('pointerleave', onLeaveWindow);
      if (dwell !== undefined) clearTimeout(dwell);
      setPeek(undefined);
    };
  }, []);
}
