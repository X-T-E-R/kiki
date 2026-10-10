import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { activeSpace } from '../lib/spaceStorage';
import { createVisitId, getCurrentVisit, getPreviousVisit, getVisitDelta, getVisitForLocation, isCrossScopeNavigation, markVisitMissing, recordNavigation, type NavScopeIdentity } from '../lib/navHistory';
import { captureVisitSnapshots } from '../lib/navViewState';
import { readHomeViewRoute } from '../lib/spaceViewState';
import { openRemoteScopeWindow } from '../lib/navScopeConnection';
import { launchWindowMode } from '../lib/spaces';
import { readDesktopPrefs } from '@kiki/session-core/settings';
import { destinationForLocation, isScopeEntityRoute, markScopeReload, prepareScopeDestination, registerScopeNavigation, requestScopeNavigation, ScopeRestoreError, type ScopeDestination, type ScopeLocation, type ScopeRestoreState } from '../lib/navScope';
import { useHost } from '../host';
import { useConnection } from '../state/connection';
import { DirtyGuardContext, DirtyGuardStateContext, useDirtyGuardState, type GuardedNavigate, type NavigationRedirect } from './dirtyGuard';
import { NavScopeRecovery } from './NavScopeRecovery';

export interface ScopeRestoreValue {
  readonly state: ScopeRestoreState;
  retry(token?: string): void;
  cancel(): void;
}
const ScopeRestoreContext = createContext<ScopeRestoreValue | null>(null);
export function useScopeRestore(): ScopeRestoreValue | null { return useContext(ScopeRestoreContext); }

/** Outside App: no target page, shell query, or session controller mounts under an unverified scope. */
export function NavScopeBoundary({ children }: { readonly children: ReactNode }) {
  const connection = useConnection();
  const host = useHost();
  const location = useLocation();
  const rawNavigate = useNavigate();
  const action = useNavigationType();
  // `spaceKey` is the same home id as the boot-resolved space for a local space,
  // and the connection discriminator (`remote:<connectionId>`) for a remote one:
  // a remote space is not a local home, so it must never be asked of activeSpace().
  const active = useMemo<NavScopeIdentity>(() => ({
    homeId: typeof connection.spaceKey === 'string' && connection.spaceKey !== '' ? connection.spaceKey : activeSpace()?.homeId ?? 'main',
    scopeId: connection.scopeId, serverHomeId: connection.meta.server_home_id, connectionRef: connection.connectionRef,
  }), [connection.spaceKey, connection.scopeId, connection.meta.server_home_id, connection.connectionRef]);
  const [state, setState] = useState<ScopeRestoreState>({ phase: 'idle' });
  const tokenRef = useRef<string | undefined>(undefined);
  const acceptedRef = useRef<ScopeDestination | null>(null);
  const explicitRef = useRef<{ target: ScopeDestination; visitId: string; redirect?: NavigationRedirect } | null>(null);
  const retryRef = useRef<(() => void) | null>(null);
  const bootAttemptRef = useRef<AbortController | null>(null);
  const verifiedBootRef = useRef<string | null>(null);
  const notificationBoot = (location.state as { kikiNav?: { intent?: string } } | null)?.kikiNav?.intent === 'notification';
  const target = destinationForLocation(location, active);
  const safe = !(notificationBoot && verifiedBootRef.current !== location.key) && !isCrossScopeNavigation(active, target.scope) &&
    (target.scope.serverHomeId === undefined || target.scope.serverHomeId === active.serverHomeId);
  const performNavigation = useCallback<GuardedNavigate>((to, options) => {
    const explicit = explicitRef.current;
    if (explicit !== null) {
      explicitRef.current = null;
      if (explicit.redirect !== undefined) {
        if (typeof explicit.redirect.target === 'number') { if (explicit.redirect.target !== 0) void rawNavigate(explicit.redirect.target); }
        else void rawNavigate(explicit.redirect.target, explicit.redirect.options);
      } else void rawNavigate(explicit.target.route, { ...options, state: { kikiNav: { visitId: explicit.visitId, scope: explicit.target.scope } } });
    } else if (typeof to === 'number') void rawNavigate(to);
    else void rawNavigate(to, options);
  }, [rawNavigate]);
  const capture = () => {
    const source = getCurrentVisit();
    if (source !== null) captureVisitSnapshots(source.visitId);
  };
  const preparationTailRef = useRef<Promise<void>>(Promise.resolve());
  const prepare = useCallback(async (next: ScopeDestination, signal: AbortSignal, requestedLocation?: ScopeLocation): Promise<void | NavigationRedirect> => {
    const previous = preparationTailRef.current;
    let release!: () => void;
    preparationTailRef.current = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      signal.throwIfAborted();
      capture();
      const source = getCurrentVisit();
      const assertCurrent = () => {
        signal.throwIfAborted();
        if (source !== null && getVisitDelta(source.visitId, source) !== 0) throw new DOMException('Navigation changed', 'AbortError');
      };
      let candidate = next;
      let candidateVisit = requestedLocation === undefined ? null : getVisitForLocation(requestedLocation);
      let skipped = false;
      let token = tokenRef.current;
      tokenRef.current = undefined;
      for (;;) {
        assertCurrent();
        let prepared;
        try {
          if (candidateVisit?.missing === true) throw new ScopeRestoreError('target-missing');
          prepared = await prepareScopeDestination(candidate, connection.scopeAdapter, signal, setState, token);
        } catch (error) {
          assertCurrent();
          if (!(error instanceof ScopeRestoreError) || error.reason !== 'target-missing' || requestedLocation === undefined ||
              (requestedLocation.state as { kikiNav?: { intent?: string } } | null)?.kikiNav?.intent === 'notification') throw error;
          if (candidateVisit !== null) markVisitMissing(candidateVisit.visitId);
          candidateVisit = candidateVisit === null ? source : getPreviousVisit(candidateVisit.visitId);
          if (candidateVisit === null) {
            // Every checked source was truly deleted. The adapter has rolled back;
            // replace in the already-confirmed source scope, never in an unverified target.
            acceptedRef.current = { scope: active, route: '/new' };
            setState({ phase: 'idle' });
            return { target: '/new', options: { replace: true, state: { kikiNav: { visitId: source?.visitId ?? createVisitId(), scope: active } } } };
          }
          candidate = { scope: candidateVisit.scope, route: `${candidateVisit.pathname}${candidateVisit.search}${candidateVisit.hash}` };
          skipped = true;
          token = undefined;
          continue;
        }
        try {
          assertCurrent();
          acceptedRef.current = { ...candidate, scope: prepared.scope };
          await prepared.commit();
          assertCurrent();
          if (skipped && candidateVisit !== null && source !== null) {
            const delta = getVisitDelta(candidateVisit.visitId, source);
            if (delta === null) throw new DOMException('Navigation changed', 'AbortError');
            setState({ phase: 'idle' });
            return { target: delta };
          }
          return;
        } catch (error) {
          acceptedRef.current = null;
          await prepared.dispose();
          if (!signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
            setState({ phase: 'failed', target: candidate, reason: error instanceof ScopeRestoreError ? error.reason : 'offline' });
          }
          throw error;
        }
      }
    } finally { release(); }
  }, [connection.scopeAdapter, active]);
  const guard = useDirtyGuardState(location, performNavigation, {
    needsPreparation: (next) => {
      const destination = destinationForLocation(next, active);
      const mismatched = isCrossScopeNavigation(active, destination.scope) ||
        (destination.scope.serverHomeId !== undefined && destination.scope.serverHomeId !== active.serverHomeId);
      const visit = getVisitForLocation(next);
      const returningEntity = visit !== null && visit.visitId !== getCurrentVisit()?.visitId && isScopeEntityRoute(destination.route);
      return (mismatched || returningEntity) && !(acceptedRef.current?.route === destination.route &&
        !isCrossScopeNavigation(acceptedRef.current.scope, destination.scope));
    },
    prepare: async (next, signal) => {
      retryRef.current = () => { void Promise.resolve(guard.confirm()).catch(() => {}); };
      return prepare(destinationForLocation(next, active), signal, next);
    },
  });

  useLayoutEffect(() => {
    if (!connection.needsScopeReload || acceptedRef.current === null ||
        acceptedRef.current.route !== `${location.pathname}${location.search}${location.hash}`) return;
    const destination = acceptedRef.current;
    const committedScope = destinationForLocation(location, active).scope;
    // A remote space is carried by this window's own home, not by a Router
    // commit: the Router cannot hold the remote scope before the reload that
    // re-selects it, so waiting for one here would leave the verifying surface
    // up forever. The same is true leaving one — the Router still holds the
    // remote scope until the reload hands the window back to its own home. The
    // verified destination is enough to reload in both directions.
    const remoteEntry = destination.scope.scopeId.startsWith('remote:') || active.scopeId.startsWith('remote:');
    // Identical source/target paths still require the target Router scope.
    if (!remoteEntry && (isCrossScopeNavigation(committedScope, destination.scope) ||
        (committedScope.serverHomeId !== undefined && committedScope.serverHomeId !== destination.scope.serverHomeId))) return;
    // The visit is written in the shape this window will hold *after* the
    // reload: a remote space's home is its own scope key, because a remote
    // Kiki is not a local home. Writing the source home here would leave the
    // next window comparing `main` against `remote:<id>` and refusing its own
    // entry.
    const remoteScopeIdentity = destination.scope.scopeId.startsWith('remote:')
      ? { ...destination.scope, homeId: destination.scope.scopeId }
      : destination.scope;
    recordNavigation({ location, scope: remoteScopeIdentity, action });
    markScopeReload(remoteScopeIdentity, destination.route, location.key);
    // A remote space is carried by this window's own home, so there is no local
    // home to switch: the reload re-selects it from the handoff instead.
    if (remoteEntry) window.location.reload();
    else if (host.switchSpace) void host.switchSpace(destination.scope.homeId).catch(() => {
      setState({ phase: 'failed', target: destination, reason: 'offline' });
    });
    else window.location.reload();
  }, [connection.needsScopeReload, location, action, host, active]);
  useEffect(() => {
    if (safe) {
      // A reload request can render while Router is still on the safe source.
      // Keep its verified destination until the layout commit above consumes it.
      if (connection.needsScopeReload) return;
      acceptedRef.current = null;
      setState({ phase: 'idle' });
      return;
    }
    if (connection.needsScopeReload || acceptedRef.current !== null) return;
    const controller = new AbortController();
    bootAttemptRef.current = controller;
    const run = () => { void prepare(target, controller.signal, location).then((redirect) => {
      if (controller.signal.aborted) return;
      if (redirect === undefined) {
        verifiedBootRef.current = location.key;
        if (!connection.needsScopeReload) setState({ phase: 'idle' });
        return;
      }
      if (typeof redirect.target === 'number') { if (redirect.target !== 0) void rawNavigate(redirect.target); }
      else void rawNavigate(redirect.target, redirect.options);
    }).catch(() => {}); };
    retryRef.current = run;
    run();
    return () => { controller.abort(); bootAttemptRef.current = null; };
  }, [safe, location.key, connection.needsScopeReload, prepare]);

  useEffect(() => registerScopeNavigation(async (request) => {
    const scope = request.scope ?? { homeId: request.homeId ?? active.homeId, scopeId: request.scopeId ?? 'local' };
    if (!isCrossScopeNavigation(active, scope) && request.route === undefined &&
        (scope.serverHomeId === undefined || scope.serverHomeId === active.serverHomeId)) return;
    // Windows mode: a remote space gets its own window, served by this window's
    // own home. Nothing is prepared, staged or navigated here — the new window
    // resolves the connection itself, and a cancelled or failed launch leaves
    // this window's page, draft and visit exactly as they were.
    if (request.route === undefined && host.kind === 'tauri' && scope.scopeId.startsWith('remote:') && host.openRemoteSpace !== undefined &&
        launchWindowMode(readDesktopPrefs().windowMode) === 'windows') {
      const launch = async (signal = new AbortController().signal) => { await openRemoteScopeWindow(host, scope, signal); };
      retryRef.current = () => { void Promise.resolve(guard.value.runAction?.(launch)).catch(() => {}); };
      await guard.value.runAction?.(launch);
      return;
    }
    const next = { scope, route: request.route ?? readHomeViewRoute(scope.homeId, scope.scopeId) ?? '/new' };
    let initialToken = request.token;
    const execute = async (signal: AbortSignal) => {
      tokenRef.current ??= initialToken;
      initialToken = undefined;
      explicitRef.current = null;
      acceptedRef.current = null;
      const redirect = await prepare(next, signal);
      signal.throwIfAborted();
      explicitRef.current = { target: acceptedRef.current ?? next, visitId: createVisitId(), redirect: redirect ?? undefined };
    };
    retryRef.current = () => { void Promise.resolve(guard.value.runAction?.(execute, next.route)).catch(() => {}); };
    await guard.value.runAction?.(execute, next.route);
  }), [active, guard.value.runAction, guard.navigate, prepare]);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => host.onNotificationClick?.((route, homeId, scope) => {
    bootAttemptRef.current?.abort();
    bootAttemptRef.current = null;
    // Old home-only notifications stay local; old route-only notifications belong
    // to this window. New producers carry the complete captured identity.
    const targetScope = scope ?? (homeId === undefined ? activeRef.current : { homeId, scopeId: 'local' });
    void requestScopeNavigation({ scope: targetScope, route }).catch(() => {});
  }), [host]);

  const cancel = useCallback(() => {
    bootAttemptRef.current?.abort();
    guard.cancel();
    acceptedRef.current = null;
    explicitRef.current = null;
    tokenRef.current = undefined;
    retryRef.current = null;
    setState({ phase: 'idle' });
    if (!safe && !connection.needsScopeReload) {
      void rawNavigate('/new', { replace: true, state: { kikiNav: { scope: active } } });
    }
  }, [guard.cancel, safe, connection.needsScopeReload, active, rawNavigate]);
  const retry = useCallback((token?: string) => {
    tokenRef.current = token;
    if (retryRef.current !== null) retryRef.current();
    else void Promise.resolve(guard.confirm()).catch(() => {});
  }, [guard.confirm]);
  const value = { state, retry, cancel };
  return <ScopeRestoreContext.Provider value={value}>
    <DirtyGuardStateContext.Provider value={guard}>
      <DirtyGuardContext.Provider value={guard.value}>
        <div className="relative h-full">
          <div className="h-full" inert={state.phase !== 'idle'}>{safe ? children : null}</div>
          {state.phase !== 'idle' ? <div className="absolute inset-0 z-50 bg-canvas">
            <NavScopeRecovery state={state} retry={retry} cancel={cancel} />
          </div> : null}
        </div>
      </DirtyGuardContext.Provider>
    </DirtyGuardStateContext.Provider>
  </ScopeRestoreContext.Provider>;
}
