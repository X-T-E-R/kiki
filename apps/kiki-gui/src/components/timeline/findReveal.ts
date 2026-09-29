/**
 * Find reveal — the disclosures a find step asks to open.
 *
 * Rows keep their own open state (a thinking line, a tool call, a read run);
 * landing a match inside one must open it without lifting every row's state
 * into the Transcript. Each Transcript owns one store; a row subscribes to
 * its own id only, so a find step re-renders just the rows it opens. Opened
 * rows stay open after the reader moves on — closing text under them would
 * move the page they are reading.
 */

import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';

export interface FindRevealStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly has: (id: string) => boolean;
  /** Replace the set of ids to force open. */
  readonly set: (ids: readonly string[]) => void;
}

export function createFindRevealStore(): FindRevealStore {
  let ids: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    has: (id) => ids.has(id),
    set: (next) => {
      ids = new Set(next);
      for (const listener of listeners) listener();
    },
  };
}

const EMPTY_STORE: FindRevealStore = {
  subscribe: () => () => {},
  has: () => false,
  set: () => {},
};

export const FindRevealContext = createContext<FindRevealStore>(EMPTY_STORE);

/** True while a find step asks this row to be open. */
export function useFindForced(id: string | undefined): boolean {
  const store = useContext(FindRevealContext);
  return useSyncExternalStore(
    store.subscribe,
    () => id !== undefined && store.has(id),
    () => false,
  );
}

/** Open a row's own disclosure when a find step lands inside it. */
export function useFindReveal(id: string | undefined, open: boolean, setOpen: (open: boolean) => void): void {
  const forced = useFindForced(id);
  useEffect(() => {
    if (forced && !open) setOpen(true);
  }, [forced, open, setOpen]);
}
