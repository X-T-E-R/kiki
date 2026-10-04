import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { UNSAFE_LocationContext } from 'react-router-dom';

import { getVisitForLocation, getNavHistoryRevision, subscribeNavHistory } from './navHistory';
import { getReadingSnapshot, registerNavSnapshotCapture, saveReadingSnapshot } from './navViewState';

/**
 * Never attach a destination's state to the previous visit during Router's
 * render. Surfaces that legitimately render without a Router (host tests, an
 * embedded workspace) have no visit, so they simply get no snapshot.
 */
export function useNavVisitId(): string | null {
  const location = useContext(UNSAFE_LocationContext)?.location;
  useSyncExternalStore(subscribeNavHistory, getNavHistoryRevision, getNavHistoryRevision);
  return location === undefined ? null : getVisitForLocation(location)?.visitId ?? null;
}

export interface NavSnapshotAdapter<T> {
  readonly capture: () => T;
  readonly restore: (snapshot: T, signal: AbortSignal) => void | Promise<void>;
  readonly ready?: boolean;
  readonly onRestoreError?: (error: unknown) => void;
}

/** Adapters own geometry and render readiness; the store owns visit identity only. */
export function useNavSnapshotAdapter<T>(key: string, adapter: NavSnapshotAdapter<T>): {
  visitId: string | null;
  snapshot: T | undefined;
  hasSnapshot: boolean;
  /** Retry the same saved snapshot; a failed restore never authorizes capture. */
  retryRestore: () => void;
} {
  const visitId = useNavVisitId();
  const snapshot = visitId === null ? undefined : getReadingSnapshot<T>(visitId, key);
  const adapterRef = useRef(adapter);
  const restoredRef = useRef<string | null>(null);
  const restoringRef = useRef(false);
  const [retry, setRetry] = useState(0);
  const retryRestore = useCallback(() => { setRetry((value) => value + 1); }, []);
  useLayoutEffect(() => { adapterRef.current = adapter; });
  useEffect(() => {
    if (visitId === null || adapter.ready === false) return;
    const identity = `${visitId}\0${key}`;
    if (restoredRef.current === identity) return;
    if (snapshot === undefined) { restoredRef.current = identity; return; }
    const controller = new AbortController();
    const currentAdapter = adapterRef.current;
    restoringRef.current = true;
    Promise.resolve().then(() => {
      if (!controller.signal.aborted) return currentAdapter.restore(snapshot, controller.signal);
    }).then(() => {
      if (!controller.signal.aborted) {
        restoredRef.current = identity;
        restoringRef.current = false;
      }
    }, (error: unknown) => {
      // Keep the original snapshot if restore throws; the surface owns retry/error copy.
      if (!controller.signal.aborted) currentAdapter.onRestoreError?.(error);
    });
    return () => { controller.abort(); restoringRef.current = false; };
  }, [visitId, key, adapter.ready, retry]);
  useLayoutEffect(() => {
    if (visitId === null || adapter.ready === false) return;
    const capture = () => {
      if (restoringRef.current || (snapshot !== undefined && restoredRef.current !== `${visitId}\0${key}`)) return;
      saveReadingSnapshot(visitId, key, adapterRef.current.capture());
    };
    const unregister = registerNavSnapshotCapture(visitId, capture);
    return () => {
      capture();
      unregister();
    };
  }, [visitId, key, adapter.ready]);
  return { visitId, snapshot, hasSnapshot: snapshot !== undefined, retryRestore };
}
