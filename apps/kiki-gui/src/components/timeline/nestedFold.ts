/**
 * Which nested subagents (a subagent's own subagents, and deeper) start
 * folded in this timeline view.
 *
 * A nested agent that had already finished when the view first saw it folds
 * to its one-line summary; one that is running, waiting on the user, or
 * failed never folds, and one that finishes while the view is open stays as
 * it was until the view is left. A click opens a folded one for the rest of
 * the view. The store lives as long as one timeline view (Transcript is keyed
 * per session and agent), so the main timeline and each subagent tab apply
 * the same rule on their own.
 */

import { createContext, useContext, useSyncExternalStore } from 'react';

/** Settled at first sight: these fold. Failures stay open so they are read. */
const FOLDS_AT_OPEN = new Set(['completed', 'cancelled']);

export class NestedFoldStore {
  private readonly firstSeen = new Map<string, string>();
  private readonly opened = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  /** Record initial history; a resumed run stays expanded even after settling again. */
  see(agentId: string, status: string): void {
    if (!this.firstSeen.has(agentId) || !FOLDS_AT_OPEN.has(status)) this.firstSeen.set(agentId, status);
  }

  folded(agentId: string, status: string): boolean {
    if (this.opened.has(agentId)) return false;
    // Only a still-settled agent folds: one that was resumed reads as live.
    if (!FOLDS_AT_OPEN.has(status)) return false;
    return FOLDS_AT_OPEN.has(this.firstSeen.get(agentId) ?? status);
  }

  open(agentId: string): void {
    if (this.opened.has(agentId)) return;
    this.opened.add(agentId);
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  snapshot = (): number => this.version;
}

export const NestedFoldContext = createContext<NestedFoldStore | null>(null);

/**
 * Whether this nested agent renders folded in the current view, and the
 * action that opens it. Outside a view (no provider) nothing folds.
 */
export function useNestedFold(agentId: string, status: string, nested: boolean): { folded: boolean; open: () => void } {
  const store = useContext(NestedFoldContext);
  useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.snapshot ?? zero, zero);
  if (store === null || !nested) return { folded: false, open: noop };
  store.see(agentId, status);
  return { folded: store.folded(agentId, status), open: () => { store.open(agentId); } };
}

const noop = (): void => {};
const zero = (): number => 0;
const noopSubscribe = (): (() => void) => noop;
