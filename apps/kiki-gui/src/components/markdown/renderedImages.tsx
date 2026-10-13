import { createContext, useContext, useId, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';

const EMPTY: readonly string[] = [];

interface Registry {
  replace(id: string, targets: readonly string[]): void;
  remove(id: string): void;
  read(): readonly string[];
  subscribe(listener: () => void): () => void;
}

const RenderedImageContext = createContext<Registry | null>(null);

function subscribeNothing(): () => void {
  return () => {};
}

function readEmpty(): readonly string[] {
  return EMPTY;
}

/**
 * One registry for the markdown already being rendered and the attachment
 * list under it. Image nodes publish the src the production renderer
 * received; the list reads that snapshot. Nothing parses the message again.
 */
export function RenderedImageScope({ children }: { readonly children: ReactNode }) {
  const registry = useMemo<Registry>(() => {
    const slots = new Map<string, readonly string[]>();
    const listeners = new Set<() => void>();
    let snapshot: readonly string[] = EMPTY;
    const rebuild = (): boolean => {
      const next: string[] = [];
      for (const targets of slots.values()) {
        for (const target of targets) next.push(target);
      }
      if (next.length === snapshot.length && next.every((target, index) => target === snapshot[index])) return false;
      snapshot = next.length === 0 ? EMPTY : next;
      return true;
    };
    const notify = () => {
      for (const listener of listeners) listener();
    };
    return {
      replace(id, targets) {
        const previous = slots.get(id);
        if (previous !== undefined && previous.length === targets.length && previous.every((target, index) => target === targets[index])) return;
        slots.set(id, targets);
        if (rebuild()) notify();
      },
      remove(id) {
        if (!slots.delete(id)) return;
        if (rebuild()) notify();
      },
      read: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
  }, []);
  return <RenderedImageContext.Provider value={registry}>{children}</RenderedImageContext.Provider>;
}

export function useRenderedImageTargets(): readonly string[] {
  const registry = useContext(RenderedImageContext);
  return useSyncExternalStore(
    registry === null ? subscribeNothing : registry.subscribe,
    registry === null ? readEmpty : registry.read,
    registry === null ? readEmpty : registry.read,
  );
}

/** Publishes the src this rendered image node actually received. */
export function useRecordRenderedImage(src: string | undefined): void {
  const registry = useContext(RenderedImageContext);
  const id = useId();
  useLayoutEffect(() => {
    if (registry === null) return;
    registry.replace(id, src !== undefined && src !== '' ? [src] : EMPTY);
    return () => { registry.remove(id); };
  }, [registry, id, src]);
}
