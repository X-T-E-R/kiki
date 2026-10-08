/**
 * Dirty-draft guard for settings editors. The app shell owns the dirty set so
 * every in-app navigation path (settings nav, sidebar, switcher, shortcuts)
 * can ask before unmounting an unsaved editor.
 */

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { UNSAFE_DataRouterContext, useNavigate, type NavigateOptions, type To } from 'react-router-dom';

export type GuardedNavigate = (target: To | number, options?: NavigateOptions, onCancel?: () => void) => void | Promise<void>;
export type GuardedAction = (signal: AbortSignal) => void | Promise<void>;

export interface NavigationRedirect { readonly target: To | number; readonly options?: NavigateOptions }
export interface NavigationPreparation {
  needsPreparation(location: { pathname: string; search: string; hash: string; key: string; state: unknown }): boolean;
  prepare(location: { pathname: string; search: string; hash: string; key: string; state: unknown }, signal: AbortSignal): Promise<void | NavigationRedirect>;
}

export interface DirtyGuardState {
  value: DirtyGuardValue;
  navigate: GuardedNavigate;
  pending: boolean;
  confirm: () => void | Promise<void>;
  cancel: () => void;
}
export const DirtyGuardStateContext = createContext<DirtyGuardState | null>(null);

export interface DirtyGuardValue {
  readonly dirty: boolean;
  readonly reportDirty: (id: string, dirty: boolean) => void;
  readonly navigate: GuardedNavigate;
  /** Guard connection/window changes that can unmount every dirty editor. */
  readonly runAction?: (action: GuardedAction, target?: To | number, onCancel?: () => void) => void | Promise<void>;
  /** Prompt before replacing a draft without changing routes (entity/workspace). */
  readonly confirmDiscard?: (id: string, action: () => void, onCancel?: () => void) => void;
}

export const DirtyGuardContext = createContext<DirtyGuardValue | null>(null);

interface CurrentRoute {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

/** Resolve the route shape used to avoid prompting for a no-op navigation. */
export function navigationTargetKey(current: CurrentRoute, target: To | number): string {
  if (typeof target === 'number') return `delta:${target}`;
  if (typeof target === 'string') return target;
  return `${target.pathname ?? current.pathname}${target.search ?? ''}${target.hash ?? ''}`;
}

export function shouldGuardNavigation(
  current: CurrentRoute,
  target: To | number,
  dirty: boolean,
): boolean {
  if (!dirty) return false;
  if (typeof target === 'number') return target !== 0;
  return navigationTargetKey(current, target) !== `${current.pathname}${current.search}${current.hash}`;
}

/** One confirmation seat for route, editor and connection/window changes. */
export function useDirtyGuardState(currentRoute: CurrentRoute, rawNavigate: GuardedNavigate, preparation?: NavigationPreparation): DirtyGuardState {
  const inherited = useContext(DirtyGuardStateContext);
  const router = useContext(UNSAFE_DataRouterContext)?.router;
  const activeRouter = inherited === null ? router : undefined;
  const preparationRef = useRef(preparation);
  preparationRef.current = preparation;
  const blockerKey = useId();
  const [dirtyIds, setDirtyIds] = useState<readonly string[]>([]);
  const dirtyIdsRef = useRef(dirtyIds);
  dirtyIdsRef.current = dirtyIds;
  useLayoutEffect(() => {
    if (!activeRouter) return;
    activeRouter.getBlocker(blockerKey, ({ currentLocation, nextLocation, historyAction }) =>
      preparationRef.current?.needsPreparation(nextLocation) === true ||
      (dirtyIdsRef.current.length > 0 && (
        (historyAction === 'POP' && currentLocation.key !== nextLocation.key) ||
        shouldGuardNavigation(currentLocation, nextLocation, true))));
    return () => { activeRouter.deleteBlocker(blockerKey); };
  }, [activeRouter, blockerKey]);
  const subscribe = useCallback((listener: () => void) => activeRouter?.subscribe(() => { listener(); }) ?? (() => {}), [activeRouter]);
  const getBlocker = useCallback(() => activeRouter?.state.blockers.get(blockerKey) ?? null, [activeRouter, blockerKey]);
  const blocker = useSyncExternalStore(subscribe, getBlocker, getBlocker);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef<{ id: string | null; action: () => void | Promise<void>; onCancel?: () => void } | null>(null);
  const pendingCancelRef = useRef<(() => void) | undefined>(undefined);
  const generationRef = useRef(0);
  const activeActionRef = useRef<AbortController | null>(null);
  const cancel = useCallback(() => {
    generationRef.current += 1;
    activeActionRef.current?.abort();
    activeActionRef.current = null;
    const leave = pendingRef.current;
    pendingRef.current = null;
    setPending(false);
    leave?.onCancel?.();
    const onCancel = pendingCancelRef.current;
    pendingCancelRef.current = undefined;
    onCancel?.();
    const currentBlocker = getBlocker();
    if (currentBlocker?.state === 'blocked') currentBlocker.reset();
  }, [getBlocker]);
  useEffect(() => () => { activeActionRef.current?.abort(); }, []);
  useEffect(() => {
    if (blocker?.state !== 'blocked') return;
    // A browser transition replaces an older action in the same confirmation seat.
    generationRef.current += 1;
    activeActionRef.current?.abort();
    activeActionRef.current = null;
    const leave = pendingRef.current;
    pendingRef.current = null;
    setPending(false);
    leave?.onCancel?.();
  }, [blocker]);
  const reportDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyIds((current) => {
      if (current.includes(id) === dirty) return current;
      return dirty ? [...current, id] : current.filter((entry) => entry !== id);
    });
  }, []);
  const request = useCallback(<R extends void | Promise<void>,>(guarded: boolean, id: string | null, action: () => R, onCancel?: () => void): Promise<void> | R | undefined => {
    cancel();
    if (guarded) {
      // A caller that asked to watch the queued transition gets a promise that
      // settles when the action runs or the seat is cancelled. Without that
      // request the queue stays fire-and-forget: awaiting a seat nobody has
      // confirmed yet is not a promise the guard makes.
      if (onCancel === undefined) {
        pendingRef.current = { id, action };
        setPending(true);
        return undefined;
      }
      return new Promise<void>((resolve, reject) => {
        pendingRef.current = {
          id,
          action: () => {
            try {
              const res = action();
              if (res instanceof Promise) {
                return res.then((val) => { resolve(val); }, (err) => { reject(err); throw err; });
              }
              resolve();
              return res;
            } catch (err) {
              reject(err);
              throw err;
            }
          },
          onCancel: () => {
            onCancel();
            resolve();
          },
        };
        setPending(true);
      });
    }
    else return action();
  }, [cancel]);
  const navigate = useCallback<GuardedNavigate>((target, options, onCancel) => {
    if (router) {
      cancel();
      pendingCancelRef.current = onCancel;
      return rawNavigate(target, options);
    }
    else return request(shouldGuardNavigation(currentRoute, target, dirtyIds.length > 0), null, () => rawNavigate(target, options), onCancel);
  }, [router, cancel, currentRoute, dirtyIds.length, rawNavigate, request]);
  const confirmDiscard = useCallback((id: string, action: () => void, onCancel?: () => void) => {
    request(dirtyIds.includes(id), id, action, onCancel);
  }, [dirtyIds, request]);
  const runAction = useCallback((action: GuardedAction, target?: To | number, onCancel?: () => void) => {
    return request(dirtyIds.length > 0, null, () => {
      const generation = generationRef.current;
      const controller = new AbortController();
      activeActionRef.current = controller;
      const finish = () => { if (activeActionRef.current === controller) activeActionRef.current = null; };
      const navigateAfterAction = () => {
        if (target === undefined || generation !== generationRef.current) return;
        // Only successful actions may discard before the router transition.
        // Update the ref too: browser delta transitions check it asynchronously.
        if (router) { dirtyIdsRef.current = []; setDirtyIds([]); }
        return rawNavigate(target);
      };
      try {
        const result = action(controller.signal);
        if (result !== undefined) return result.then(navigateAfterAction).finally(finish);
        const navResult = navigateAfterAction();
        finish();
        return navResult;
      } catch (error) { finish(); throw error; }
    }, onCancel);
  }, [router, dirtyIds.length, rawNavigate, request]);
  const confirm = useCallback(() => {
    pendingCancelRef.current = undefined;
    const currentBlocker = getBlocker();
    if (currentBlocker?.state === 'blocked') {
      const controller = new AbortController();
      activeActionRef.current?.abort();
      activeActionRef.current = controller;
      const proceed = (redirect?: void | NavigationRedirect) => {
        if (controller.signal.aborted || getBlocker() !== currentBlocker) return;
        dirtyIdsRef.current = [];
        setDirtyIds([]);
        if (redirect === undefined) currentBlocker.proceed();
        else {
          currentBlocker.reset();
          if (redirect.target !== 0) rawNavigate(redirect.target, redirect.options);
        }
      };
      if (preparationRef.current?.needsPreparation(currentBlocker.location)) {
        return preparationRef.current.prepare(currentBlocker.location, controller.signal).then(proceed, () => {});
      }
      proceed();
      return;
    }
    const leave = pendingRef.current;
    if (leave === null) return;
    pendingRef.current = null;
    cancel();
    const generation = generationRef.current;
    const result = leave.action();
    const clearDiscarded = () => {
      if (generation !== generationRef.current) return;
      setDirtyIds((current) => leave.id === null ? [] : current.filter((id) => id !== leave.id));
    };
    if (result !== undefined) return result.then(clearDiscarded);
    clearDiscarded();
  }, [cancel, getBlocker, rawNavigate]);
  useEffect(() => {
    if (blocker?.state === 'blocked' && dirtyIdsRef.current.length === 0 &&
        preparationRef.current?.needsPreparation(blocker.location)) void Promise.resolve(confirm()).catch(() => {});
  }, [blocker, confirm]);
  const value = useMemo<DirtyGuardValue>(() => ({ dirty: dirtyIds.length > 0, reportDirty, navigate, confirmDiscard, runAction }),
    [dirtyIds.length, reportDirty, navigate, confirmDiscard, runAction]);
  return inherited ?? { value, navigate, pending: pending || (blocker?.state === 'blocked' && dirtyIds.length > 0), confirm, cancel };
}

/** Use the app-wide guarded navigator, with router navigation as a safe fallback. */
export function useGuardedNavigate(): GuardedNavigate {
  const fallback = useNavigate();
  const context = useContext(DirtyGuardContext);
  return context?.navigate ?? ((target, options, onCancel) => {
    if (typeof target === 'number') void fallback(target);
    else void fallback(target, options);
  });
}

export function useDirtyGuard(): DirtyGuardValue | null {
  return useContext(DirtyGuardContext);
}

/** Report this editor's dirty state while mounted; cleans up on unmount. */
export function useDirtyReporter(id: string, dirty: boolean): void {
  const reportDirty = useContext(DirtyGuardContext)?.reportDirty;
  useEffect(() => {
    reportDirty?.(id, dirty);
    return () => { reportDirty?.(id, false); };
  }, [reportDirty, id, dirty]);
}
