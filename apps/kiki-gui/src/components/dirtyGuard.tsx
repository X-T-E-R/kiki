/**
 * Dirty-draft guard for provider editors. The app shell owns the dirty set so
 * every in-app navigation path (settings nav, sidebar, switcher, shortcuts)
 * can ask before unmounting an unsaved editor.
 */

import { createContext, useContext, useEffect } from 'react';
import { useNavigate, type NavigateOptions, type To } from 'react-router-dom';

export type GuardedNavigate = (target: To, options?: NavigateOptions) => void;

export interface DirtyGuardValue {
  readonly dirty: boolean;
  readonly reportDirty: (id: string, dirty: boolean) => void;
  readonly navigate: GuardedNavigate;
}

export const DirtyGuardContext = createContext<DirtyGuardValue | null>(null);

interface CurrentRoute {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

/** Resolve the route shape used to avoid prompting for a no-op navigation. */
export function navigationTargetKey(current: CurrentRoute, target: To): string {
  if (typeof target === 'string') return target;
  return `${target.pathname ?? current.pathname}${target.search ?? ''}${target.hash ?? ''}`;
}

export function shouldGuardNavigation(
  current: CurrentRoute,
  target: To,
  dirty: boolean,
): boolean {
  if (!dirty) return false;
  return navigationTargetKey(current, target) !== `${current.pathname}${current.search}${current.hash}`;
}

/** Use the app-wide guarded navigator, with router navigation as a safe fallback. */
export function useGuardedNavigate(): GuardedNavigate {
  const fallback = useNavigate();
  return useContext(DirtyGuardContext)?.navigate ?? fallback;
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
