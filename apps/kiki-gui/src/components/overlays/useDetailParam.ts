/**
 * The open detail of a list page, held in one query parameter
 * (`?agent=lead`, `?model=kimi-code/kimi-k2`), so a detail is a link: search
 * hits, back/forward and a reload all land on it.
 *
 * Every change goes through the app's guarded navigator, so an unsaved
 * editor (anything reporting through `useDirtyReporter`) gets the one shared
 * "discard changes?" prompt on switch, close and browser back. Callers never
 * add a confirm of their own.
 *
 * History shape: opening from the list pushes one entry; switching between
 * details replaces it; closing pops it when this page pushed it (so browser
 * Back and the Back button agree) and otherwise replaces.
 */

import { useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';

import { prefersReducedMotion } from '../../lib/motion';
import { useGuardedNavigate } from '../dirtyGuard';

const OPENED_STATE = 'kikiDetailOpened';

export interface DetailParam {
  /** The raw parameter value, or null when the list is shown. */
  readonly selected: string | null;
  readonly open: (key: string) => void;
  readonly close: () => void;
}

function withParam(search: string, param: string, value: string | null): string {
  const params = new URLSearchParams(search);
  if (value === null) params.delete(param);
  else params.set(param, value);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export function useDetailParam(param: string): DetailParam {
  const location = useLocation();
  const navigate = useGuardedNavigate();
  const selected = useMemo(() => new URLSearchParams(location.search).get(param), [location.search, param]);
  const pushedHere = (location.state as Record<string, unknown> | null)?.[OPENED_STATE] === param;

  const open = useCallback((key: string) => {
    if (key === selected) return;
    const to = { pathname: location.pathname, search: withParam(location.search, param, key), hash: '' };
    // A View Transition when the engine has one; React Router skips it
    // silently elsewhere (older WebKit), so this stays an enhancement.
    const viewTransition = !prefersReducedMotion();
    if (selected === null) void navigate(to, { state: { [OPENED_STATE]: param }, viewTransition });
    else void navigate(to, { replace: true, state: location.state, viewTransition });
  }, [selected, location.pathname, location.search, location.state, param, navigate]);

  const close = useCallback(() => {
    if (selected === null) return;
    const viewTransition = !prefersReducedMotion();
    if (pushedHere) { void navigate(-1); return; }
    void navigate({ pathname: location.pathname, search: withParam(location.search, param, null), hash: '' }, { replace: true, viewTransition });
  }, [selected, pushedHere, location.pathname, location.search, param, navigate]);

  return { selected, open, close };
}
