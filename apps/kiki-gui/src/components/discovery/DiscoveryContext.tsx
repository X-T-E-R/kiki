/**
 * DiscoveryContext — state and action orchestration for the in-app discovery tour.
 *
 * Backed by packages/session-core/src/discovery contract:
 * - Persists pure progress in device settings via readDiscoveryState / writeDiscoveryState.
 * - Guards route transitions using GuardedNavigate and dirtyGuard.
 * - Supports leave, resume, switch route, skip station, complete.
 * - Ensures cancelled dirtyGuard prompts do not advance station or commit state.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { UNSAFE_DataRouterContext, useLocation } from 'react-router-dom';

import {
  currentDiscoveryScope,
  discoveryView,
  navigateDiscovery,
  readDiscoveryState,
  reduceDiscoveryState,
  tryDiscoveryAction,
  writeDiscoveryState,
  type DiscoveryActionPort,
  type DiscoveryAnchor,
  type DiscoveryContext as CoreDiscoveryContext,
  type DiscoveryEvent,
  type DiscoveryExampleId,
  type DiscoveryNavigationPort,
  type DiscoveryRouteId,
  type DiscoveryState,
  type DiscoveryTryAction,
} from '@kiki/session-core/discovery';
import { appendToDraft, readDraft, writeDraft } from '@kiki/session-core/composer';

function hasRouterErrors(routerState?: { errors?: Record<string, unknown> | null }): boolean {
  if (!routerState || !routerState.errors) return false;
  return Object.keys(routerState.errors).length > 0;
}

import { useConnection } from '../../state/connection';
import { useI18n } from '../../i18n';
import { DirtyGuardContext, useGuardedNavigate } from '../dirtyGuard';

export interface DiscoveryDataState {
  readonly memory?: boolean;
  readonly capabilities?: boolean;
  readonly cron?: boolean;
  readonly board?: boolean;
}

export const ALL_DISCOVERY_ANCHORS: readonly DiscoveryAnchor[] = [
  'workspace-picker',
  'materials',
  'work-mode',
  'agent-panel',
  'send-controls',
  'memory-scope',
  'capability-detail',
  'board-detail',
  'cron-detail',
  'result-detail',
  'usage-filter',
];

export function resolveAnchorElement(id: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector(`[data-anchor="${id}"]`)
    ?? document.querySelector(`[data-discovery-anchor="${id}"]`)
    ?? document.querySelector(`[data-${id}]`)
    ?? document.getElementById(id);
  return el instanceof HTMLElement ? el : null;
}

export function detectActiveAnchors(): readonly DiscoveryAnchor[] {
  if (typeof document === 'undefined') return [];
  return ALL_DISCOVERY_ANCHORS.filter((anchor) => resolveAnchorElement(anchor) !== null);
}

export function detectActiveData(): DiscoveryDataState | undefined {
  if (typeof document === 'undefined') return undefined;
  return {
    cron: document.querySelector('[data-cron-card], [data-cron-item], [data-anchor="cron-detail"]') !== null,
    board: document.querySelector('[data-board-card], [data-task-card], [data-anchor="board-detail"]') !== null,
    capabilities: document.querySelector('[data-capability-card], [data-anchor="capability-detail"]') !== null,
    memory: document.querySelector('[data-memory-card], [data-memory-entry], [data-anchor="memory-scope"]') !== null,
  };
}

export function isLocationCommitted(
  loc: { pathname: string; search?: string; hash?: string },
  destinationHref: string,
): boolean {
  const [targetPathAndQuery = '', targetHash] = destinationHref.split('#');
  const [targetPath = '', targetQuery] = targetPathAndQuery.split('?');

  if (loc.pathname !== targetPath) {
    return false;
  }
  if (targetQuery !== undefined && targetQuery !== '') {
    const locSearch = (loc.search ?? '').replace(/^\?/, '');
    if (locSearch !== targetQuery) {
      return false;
    }
  }
  if (targetHash !== undefined && targetHash !== '') {
    const locHash = (loc.hash ?? '').replace(/^#/, '');
    if (locHash !== targetHash) {
      return false;
    }
  }
  return true;
}

export interface DiscoveryContextValue {
  readonly state: DiscoveryState;
  readonly view: ReturnType<typeof discoveryView>;
  readonly scope: ReturnType<typeof currentDiscoveryScope>;
  readonly startRoute: (routeId: DiscoveryRouteId) => Promise<boolean>;
  readonly nextStation: () => Promise<boolean>;
  readonly previousStation: () => Promise<boolean>;
  readonly skipStation: () => Promise<boolean>;
  readonly leaveDiscovery: () => void;
  readonly resumeDiscovery: () => Promise<boolean>;
  readonly collapseDiscovery: (collapsed: boolean) => void;
  readonly performAction: (actionId: DiscoveryTryAction['id']) => Promise<boolean>;
  readonly showingExample: DiscoveryExampleId | null;
  readonly setShowingExample: (id: DiscoveryExampleId | null) => void;
}

const Context = createContext<DiscoveryContextValue | null>(null);

export function useDiscovery(): DiscoveryContextValue {
  const value = useContext(Context);
  if (value === null) {
    throw new Error('useDiscovery must be used within DiscoveryProvider');
  }
  return value;
}

export function useOptionalDiscovery(): DiscoveryContextValue | null {
  return useContext(Context);
}

export function DiscoveryProvider({
  children,
  activeSessionId,
  isSessionBusy,
  sessionReachable,
  initialState,
  data: dataProp,
  anchors: anchorsProp,
}: {
  readonly children: ReactNode;
  readonly activeSessionId?: string;
  readonly isSessionBusy?: boolean;
  readonly sessionReachable?: boolean;
  readonly initialState?: DiscoveryState;
  readonly data?: DiscoveryDataState;
  readonly anchors?: readonly DiscoveryAnchor[];
}) {
  const connection = useConnection();
  const scopeId = connection?.scopeId ?? 'local';
  const wsStatus = connection?.wsStatus;
  const { t } = useI18n();
  const location = useLocation();
  const guardedNavigate = useGuardedNavigate();
  const dirtyGuard = useContext(DirtyGuardContext);
  const dataRouter = useContext(UNSAFE_DataRouterContext)?.router;
  const unmountedRef = useRef(false);
  const pendingNavigationsRef = useRef<Set<() => void>>(new Set());
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      for (const cancel of pendingNavigationsRef.current) {
        cancel();
      }
      pendingNavigationsRef.current.clear();
    };
  }, []);

  const scope = useMemo(() => currentDiscoveryScope(scopeId), [scopeId]);

  const [state, setState] = useState<DiscoveryState>(() => initialState ?? readDiscoveryState(scope));
  const [showingExample, setShowingExample] = useState<DiscoveryExampleId | null>(null);

  // Sync state if scope switches or initialState changes
  useEffect(() => {
    if (initialState !== undefined) {
      setState(initialState);
    } else {
      setState(readDiscoveryState(scope));
    }
  }, [scope, initialState]);

  const currentHref = `${location.pathname}${location.search}`;

  const draftKey = activeSessionId ?? 'new';
  const currentDraft = readDraft(draftKey);
  const draftEmpty = currentDraft.trim() === '';

  // Reactive capabilities producer:
  // Dynamically tracks mounted DOM anchors and async data updates on actual production pages,
  // including child DOM commit after initial render and async data loading without changing href.
  const [producedAnchors, setProducedAnchors] = useState<readonly DiscoveryAnchor[]>(() => {
    return anchorsProp !== undefined ? anchorsProp : detectActiveAnchors();
  });
  const [producedData, setProducedData] = useState<DiscoveryDataState | undefined>(() => {
    return dataProp !== undefined ? dataProp : detectActiveData();
  });

  const updateCapabilities = useCallback(() => {
    if (anchorsProp === undefined) {
      const nextAnchors = detectActiveAnchors();
      setProducedAnchors((prev) => {
        if (prev.length === nextAnchors.length && prev.every((v, i) => v === nextAnchors[i])) {
          return prev;
        }
        return nextAnchors;
      });
    }
    if (dataProp === undefined) {
      const nextData = detectActiveData();
      setProducedData((prev) => {
        if (
          prev?.cron === nextData?.cron &&
          prev?.board === nextData?.board &&
          prev?.capabilities === nextData?.capabilities &&
          prev?.memory === nextData?.memory
        ) {
          return prev;
        }
        return nextData;
      });
    }
  }, [anchorsProp, dataProp]);

  // Synchronize when test / override props change
  useEffect(() => {
    if (anchorsProp !== undefined) setProducedAnchors(anchorsProp);
  }, [anchorsProp]);
  useEffect(() => {
    if (dataProp !== undefined) setProducedData(dataProp);
  }, [dataProp]);

  // Reactive DOM observation:
  // Re-probe capabilities on route transitions, child DOM commit, and DOM mutations (async data loaded).
  useEffect(() => {
    if (typeof document === 'undefined') return;

    updateCapabilities();

    if (typeof MutationObserver === 'undefined') return;

    let scheduled = false;
    let cancelled = false;
    const observer = new MutationObserver(() => {
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          if (!cancelled && typeof window !== 'undefined' && typeof document !== 'undefined') {
            updateCapabilities();
          }
        });
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-anchor',
        'data-discovery-anchor',
        'data-cron-card',
        'data-cron-item',
        'data-board-card',
        'data-task-card',
        'data-capability-card',
        'data-memory-card',
        'data-memory-entry',
        'id',
        'disabled',
        'aria-disabled',
      ],
    });

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [currentHref, updateCapabilities]);

  const activeAnchors = anchorsProp !== undefined ? anchorsProp : producedAnchors;
  const activeData = dataProp !== undefined ? dataProp : producedData;

  const isOnline = wsStatus === undefined || wsStatus === 'open';

  const coreContext: CoreDiscoveryContext = useMemo(() => ({
    sessionId: activeSessionId,
    sessionReachable: sessionReachable === true,
    online: isOnline,
    currentHref,
    sessionBusy: isSessionBusy,
    draftEmpty,
    anchors: activeAnchors,
    data: activeData,
  }), [activeSessionId, sessionReachable, isOnline, currentHref, isSessionBusy, draftEmpty, activeAnchors, activeData]);

  const view = useMemo(() => discoveryView(state, coreContext), [state, coreContext]);

  const persist = useCallback((nextState: DiscoveryState) => {
    if (unmountedRef.current) return;
    setState(nextState);
    writeDiscoveryState(scope, nextState);
  }, [scope]);

  // Construct DiscoveryNavigationPort that respects dirtyGuard and DataRouter commit
  const navigationPort = useMemo<DiscoveryNavigationPort>(() => ({
    navigate: async (destination, signal) => {
      if (signal?.aborted || unmountedRef.current) return 'cancelled';

      const targetHref = destination.href;
      const currentLoc = dataRouter ? dataRouter.state.location : location;
      const isAlreadyCommitted = isLocationCommitted(currentLoc, targetHref) &&
        (!dataRouter || (dataRouter.state.navigation.state === 'idle' && !hasRouterErrors(dataRouter.state)));

      if (isAlreadyCommitted) {
        return 'committed';
      }

      return new Promise<'committed' | 'cancelled'>((resolve) => {
        let settled = false;
        const done = (outcome: 'committed' | 'cancelled') => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(outcome);
        };

        const cancelCallback = () => {
          done('cancelled');
        };
        pendingNavigationsRef.current.add(cancelCallback);

        const onAbort = () => done('cancelled');
        if (signal) {
          if (signal.aborted) return done('cancelled');
          signal.addEventListener('abort', onAbort, { once: true });
        }

        let unsubscribe: (() => void) | undefined;
        if (dataRouter) {
          unsubscribe = dataRouter.subscribe((state) => {
            if (isLocationCommitted(state.location, targetHref) && state.navigation.state === 'idle') {
              if (hasRouterErrors(state)) {
                done('cancelled');
              } else {
                done('committed');
              }
            }
          });
        }

        const cleanup = () => {
          pendingNavigationsRef.current.delete(cancelCallback);
          signal?.removeEventListener('abort', onAbort);
          unsubscribe?.();
        };

        const navResult = guardedNavigate(targetHref, undefined, () => {
          done('cancelled');
        });

        if (navResult instanceof Promise) {
          navResult
            .then(() => {
              if (dataRouter) {
                if (isLocationCommitted(dataRouter.state.location, targetHref) && dataRouter.state.navigation.state === 'idle') {
                  if (hasRouterErrors(dataRouter.state)) {
                    done('cancelled');
                  } else {
                    done('committed');
                  }
                }
              } else {
                done('committed');
              }
            })
            .catch(() => {
              done('cancelled');
            });
        } else if (!dataRouter && !dirtyGuard?.dirty) {
          done('committed');
        }
      });
    },
  }), [dataRouter, guardedNavigate, location]);

  const dispatchTransition = useCallback(async (event: DiscoveryEvent): Promise<boolean> => {
    const res = await navigateDiscovery(state, event, coreContext, navigationPort);
    if (unmountedRef.current) return false;
    if (res.outcome === 'committed') {
      persist(res.state);
      return true;
    }
    return false;
  }, [state, coreContext, navigationPort, persist]);

  const startRoute = useCallback(async (routeId: DiscoveryRouteId) => {
    return dispatchTransition({ type: 'start', route: routeId });
  }, [dispatchTransition]);

  const nextStation = useCallback(async () => {
    return dispatchTransition({ type: 'next' });
  }, [dispatchTransition]);

  const previousStation = useCallback(async () => {
    return dispatchTransition({ type: 'previous' });
  }, [dispatchTransition]);

  const skipStation = useCallback(async () => {
    return dispatchTransition({ type: 'skip' });
  }, [dispatchTransition]);

  const leaveDiscovery = useCallback(() => {
    const next = reduceDiscoveryState(state, { type: 'leave' });
    persist(next);
  }, [state, persist]);

  const resumeDiscovery = useCallback(async () => {
    return dispatchTransition({ type: 'resume' });
  }, [dispatchTransition]);

  const collapseDiscovery = useCallback((collapsed: boolean) => {
    const next = reduceDiscoveryState(state, { type: 'collapse', collapsed });
    persist(next);
  }, [state, persist]);

  const actionPort = useMemo<DiscoveryActionPort>(() => ({
    perform: async (action, signal) => {
      if (signal?.aborted) return 'cancelled';

      if (action.kind === 'anchor') {
        const anchorEl = resolveAnchorElement(action.id);
        if (!anchorEl) return 'unavailable';
        if (anchorEl.hasAttribute('disabled') || anchorEl.getAttribute('aria-disabled') === 'true') {
          return 'unavailable';
        }
        try {
          anchorEl.focus?.();
          anchorEl.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
          return 'done';
        } catch {
          return 'unavailable';
        }
      }

      if (action.kind === 'draft') {
        const draftTarget = activeSessionId ?? 'new';
        const freshDraft = readDraft(draftTarget);
        if (freshDraft.trim() !== '') return 'cancelled';

        const composer = typeof document !== 'undefined'
          ? document.querySelector<HTMLTextAreaElement>('textarea[data-composer]')
          : null;
        if (composer && composer.value.trim() !== '') return 'cancelled';

        const prompt = t(action.promptKey);
        appendToDraft(draftTarget, prompt);
        composer?.focus();
        return 'done';
      }

      if (action.kind === 'example') {
        setShowingExample(action.id);
        return 'done';
      }

      if (action.kind === 'navigate') {
        const outcome = await navigationPort.navigate({ href: action.href }, signal);
        return outcome === 'committed' ? 'done' : 'cancelled';
      }

      return 'unavailable';
    },
  }), [activeSessionId, t, navigationPort]);

  const performAction = useCallback(async (actionId: DiscoveryTryAction['id']): Promise<boolean> => {
    const next = await tryDiscoveryAction(state, actionId, coreContext, actionPort);
    if (next !== state) {
      persist(next);
      return true;
    }
    return false;
  }, [state, coreContext, actionPort, persist]);

  const value = useMemo<DiscoveryContextValue>(() => ({
    state,
    view,
    scope,
    startRoute,
    nextStation,
    previousStation,
    skipStation,
    leaveDiscovery,
    resumeDiscovery,
    collapseDiscovery,
    performAction,
    showingExample,
    setShowingExample,
  }), [
    state,
    view,
    scope,
    startRoute,
    nextStation,
    previousStation,
    skipStation,
    leaveDiscovery,
    resumeDiscovery,
    collapseDiscovery,
    performAction,
    showingExample,
  ]);

  return (
    <Context.Provider value={value}>
      {children}
    </Context.Provider>
  );
}
