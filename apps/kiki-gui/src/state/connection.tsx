/**
 * Connection context — owns the REST client + the single shared WebSocket for
 * a (server URL, token) pair.
 *
 * Config sources, in priority order:
 *   1. the Tauri-owned desktop backend (memory-only credentials)
 *   2. deep link `?server=&token=` query params (`?url=` is also honored, but
 *      Vite's dev server 403s document requests carrying a `url` query key —
 *      its asset-import convention — so `server` is the dev-safe alias; `url`
 *      still works when the build is served by a plain static host)
 *   3. `#token=` URL fragment (token-only handoff; URL stays as-is)
 *   4. localStorage `kiki.connection` from a previous explicit connect
 * Manual connects persist to localStorage; deep links do too (they are an
 * explicit handoff). `disconnect()` clears storage and returns to the connect
 * screen.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type { Klient, TerminalFacade, TerminalConnectionStatus as WsStatus } from '@kiki/klient';
import type { MetaResponse } from '@kiki/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ConnectScreen, type WebLinkProblem } from '../components/ConnectScreen';
import { useHost } from '../host';
import { translate, type I18nKey, type I18nParams } from '@kiki/session-core/i18n';
import type { SessionController } from '@kiki/session-core/session';
import {
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
} from '@kiki/session-core/settings';
import { isVscodeWebview } from '../host/vscode';
import { useI18n } from '../i18n';
import { ApiError, createRemoteSpaceClient, KikiClient } from '../lib/client';
import { subscribeUsageFreshness } from '../lib/usageFreshness';
import { subscribePluginFreshness } from '../lib/pluginFreshness';
import {
  clearStoredConfig,
  readDeepLinkConfig,
  readStoredConfig,
  scrubConnectionUrl,
  selectInitialConnection,
  writeStoredConfig,
  type ConnectionConfig,
  type ConnectionSelection,
} from './connectionConfig';
import {
  normalizeDesktopFailure,
  type DesktopBootStatus,
  type DesktopFailureInfo,
} from './desktopConnection';
import { watchPageLifecycle } from './connectionDiagnostics';
import { createScopeConnectionAdapter } from '../lib/navScopeConnection';
import { pendingScopeReloadScope, requestScopeNavigation, type ScopeConnectionAdapter } from '../lib/navScope';
import { activeSpace, parseActiveSpacePayload } from '../lib/spaceStorage';
import {
  claimWebCookie as askForWebCookie,
  resetWebAccessBootstrap,
  webAccessBootstrap,
  webEntryProblemFor,
  type WebAccessBootstrap,
} from '../lib/webAccess';

export type { ConnectionConfig } from './connectionConfig';

/**
 * Connect-screen error: client-authored text carries a dictionary key so it
 * re-renders in the active locale; server/envelope text passes through raw.
 */
type ConnectError =
  | { readonly kind: 'key'; readonly key: I18nKey; readonly params?: I18nParams }
  | { readonly kind: 'raw'; readonly text: string };

/** Strip credentials from the address bar once they have been consumed. */
function scrubUrl(): void {
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const scrubbedUrl = scrubConnectionUrl(window.location);
  if (scrubbedUrl !== currentUrl) {
    try {
      window.history.replaceState(window.history.state, '', scrubbedUrl);
    } catch {
      // Connection still succeeds when history mutation is unavailable.
    }
  }
}

export function handleGlobalConnectionFrame(
  frame: { readonly type: string },
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
): boolean {
  if (frame.type !== 'event.model_catalog.changed') return false;
  void queryClient.invalidateQueries({ queryKey: ['models'] });
  void queryClient.invalidateQueries({ queryKey: ['providers'] });
  void queryClient.invalidateQueries({ queryKey: ['model-entity'] });
  void queryClient.invalidateQueries({ queryKey: ['provider-entity'] });
  void queryClient.invalidateQueries({ queryKey: ['discovered-models'] });
  return true;
}

export function refreshSessionAttention(queryClient: Pick<QueryClient, 'invalidateQueries'>, sessionId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  void queryClient.invalidateQueries({ queryKey: ['rooms'] });
  void queryClient.invalidateQueries({ queryKey: ['activity-prompts', sessionId] });
  void queryClient.invalidateQueries({ queryKey: ['activity-tasks', sessionId] });
}

interface ConnectionValue {
  readonly connectionId: string | null;
  /**
   * Which kind of connection this window is holding. `connectionId` names a
   * remote space and is null for everything local, so a surface that needs to
   * tell "a browser signed in through a web link" from "the owner on this
   * machine" has to read this, not that.
   */
  readonly connectionSource: ConnectionSelection['source'] | null;
  readonly spaceKey: string;
  readonly scopeId: string;
  readonly connectionRef?: string;
  readonly sshLabel: string | null;
  readonly activateSshProfile: (id: string, token: string) => Promise<void>;
  readonly activateLocal: () => void;
  readonly restoreLocal: (signal?: AbortSignal) => Promise<void>;
  readonly scopeAdapter: ScopeConnectionAdapter;
  readonly needsScopeReload: boolean;
  readonly config: ConnectionConfig;
  readonly client: KikiClient;
  /** Desktop control connection, retained independently of the active SSH session. */
  readonly localClient: KikiClient | null;
  readonly klient: Klient;
  readonly socket: TerminalFacade;
  readonly meta: MetaResponse;
  readonly wsStatus: WsStatus;
  readonly disconnect: () => void;
  /**
   * Point the app at another (server, token) pair from inside a connected
   * session — the settings connection editor's path. Persists like a manual
   * connect; a failed /meta lands on the connect screen with the error.
   */
  readonly applyConnection: (next: ConnectionConfig) => void;
}

export interface ControllerLease {
  readonly controller: SessionController;
  /** Initial open has settled; failures remain in the controller's load state. */
  readonly ready: Promise<void>;
  /** Idempotent; the last lease closes and unregisters its controller. */
  release(): void;
}

export interface ControllerRegistry {
  add(controller: SessionController): void;
  delete(controller: SessionController): void;
  /**
   * Share by connection identity (e.g. KikiClient) and session; factory returns a fresh, unopened controller.
   * Lease ownership is separate from legacy add/delete; never borrow an externally owned controller.
   */
  acquire(sessionId: string, connectionScope: object, createController: () => SessionController): ControllerLease;
  [Symbol.iterator](): Iterator<SessionController>;
  subscribe(listener: () => void): () => void;
  snapshot(): number;
}

interface RetainedController {
  readonly controller: SessionController;
  ready: Promise<void>;
  references: number;
  readonly sessions: Map<string, RetainedController>;
  readonly sessionId: string;
  /** Set while no consumer holds a lease and the view is kept for a quick return. */
  parked?: ParkedView;
}

interface ParkedView {
  readonly at: number;
  readonly bytes: number;
  readonly unsubscribe: () => void;
}

/**
 * Session view cache bounds. After the windowed reset (20 turns, 64 of each
 * global entity, truncated bodies) the largest fixture's reset is ~0.95 MB of
 * JSON; its retained store with a couple of older pages is a few MB. Three
 * parked views inside 64 MiB leaves room for older-history pages without
 * letting a background tab grow the renderer heap unbounded, and matches the
 * budget in the session-switch analysis.
 */
export const VIEW_CACHE_MAX_PARKED = 3;
export const VIEW_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** A single view larger than this is never parked: it would evict everything else. */
export const VIEW_CACHE_MAX_ENTRY_BYTES = VIEW_CACHE_MAX_BYTES / 2;
export const VIEW_CACHE_TTL_MS = 5 * 60_000;
/**
 * Parked views that are running or waiting on the user keep their live
 * subscription so the work stays observable; past this many, the oldest is
 * suspended (kept, not evicted) so subscriptions stay bounded.
 */
export const VIEW_CACHE_MAX_LIVE_PARKED = 4;

export interface ViewCacheOptions {
  readonly maxParked?: number;
  readonly maxBytes?: number;
  readonly maxEntryBytes?: number;
  readonly ttlMs?: number;
  readonly maxLiveParked?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** A parked view that must not be evicted: work is running or waiting on the user. */
export function isProtectedView(controller: SessionController): boolean {
  const state = controller.getState();
  return state.busy || state.pendingInteraction !== 'none' ||
    state.tasks.some((task) => task.status === 'running');
}

function isParkable(controller: SessionController): boolean {
  const state = controller.getState();
  return state.loaded && state.loadError === undefined &&
    !(state.resyncFailed && state.resyncError?.retryable === false);
}

export class LiveControllerRegistry implements ControllerRegistry {
  private readonly controllers = new Set<SessionController>();
  private readonly retained = new WeakMap<object, Map<string, RetainedController>>();
  /** Parked entries in park order (oldest first); strong refs across scopes. */
  private readonly parked = new Map<RetainedController, object>();
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private readonly limits: Required<Pick<ViewCacheOptions, 'maxParked' | 'maxBytes' | 'maxEntryBytes' | 'ttlMs' | 'maxLiveParked'>>;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private ttlTimer: unknown = null;

  constructor(options: ViewCacheOptions = {}) {
    this.limits = {
      maxParked: options.maxParked ?? VIEW_CACHE_MAX_PARKED,
      maxBytes: options.maxBytes ?? VIEW_CACHE_MAX_BYTES,
      maxEntryBytes: options.maxEntryBytes ?? VIEW_CACHE_MAX_ENTRY_BYTES,
      ttlMs: options.ttlMs ?? VIEW_CACHE_TTL_MS,
      maxLiveParked: options.maxLiveParked ?? VIEW_CACHE_MAX_LIVE_PARKED,
    };
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); });
  }

  acquire(sessionId: string, connectionScope: object, createController: () => SessionController): ControllerLease {
    let sessions = this.retained.get(connectionScope);
    if (sessions === undefined) {
      sessions = new Map();
      this.retained.set(connectionScope, sessions);
    }
    let entry = sessions.get(sessionId);
    if (entry === undefined) {
      const controller = createController();
      if (controller.sessionId !== sessionId || this.controllers.has(controller)) {
        throw new Error('Controller factory must return a fresh controller for the requested session');
      }
      entry = { controller, ready: controller.open(), references: 1, sessions, sessionId };
      sessions.set(sessionId, entry);
      this.add(controller);
    } else if (entry.parked !== undefined) {
      // Cache hit: the retained view repaints now and catches up behind it.
      this.unpark(entry);
      entry.references = 1;
      entry.ready = Promise.resolve();
      entry.controller.resume();
      this.add(entry.controller);
    } else {
      entry.references += 1;
    }
    const acquired = entry;
    let released = false;
    return {
      controller: acquired.controller,
      ready: acquired.ready,
      release: () => {
        if (released) return;
        released = true;
        acquired.references -= 1;
        if (acquired.references > 0) return;
        if (this.park(acquired, connectionScope)) return;
        this.dispose(acquired);
      },
    };
  }

  /** Number of parked views (for diagnostics and tests). */
  get parkedCount(): number {
    return this.parked.size;
  }

  /** Close every parked view that belongs to a connection that is going away. */
  evictScope(connectionScope: object): void {
    for (const [entry, scope] of Array.from(this.parked)) {
      if (scope === connectionScope) this.dispose(entry);
    }
  }

  /** Close every parked view. */
  clearParked(): void {
    for (const entry of Array.from(this.parked.keys())) this.dispose(entry);
  }

  private park(entry: RetainedController, connectionScope: object): boolean {
    const { controller } = entry;
    if (typeof controller.getState !== 'function' || typeof controller.suspend !== 'function') return false;
    if (!isParkable(controller)) return false;
    const bytes = controller.residentBytes();
    if (bytes > this.limits.maxEntryBytes) return false;
    const unsubscribe = controller.subscribe(() => { this.onParkedChange(entry); });
    entry.parked = { at: this.now(), bytes, unsubscribe };
    this.parked.set(entry, connectionScope);
    if (!isProtectedView(controller)) controller.suspend();
    this.delete(controller);
    this.enforceLimits();
    return true;
  }

  private unpark(entry: RetainedController): void {
    entry.parked?.unsubscribe();
    entry.parked = undefined;
    this.parked.delete(entry);
    this.scheduleTtl();
  }

  private dispose(entry: RetainedController): void {
    if (entry.parked !== undefined) this.unpark(entry);
    if (entry.sessions.get(entry.sessionId) === entry) entry.sessions.delete(entry.sessionId);
    entry.controller.close();
    this.delete(entry.controller);
  }

  /** A live parked view settled (turn ended, approval answered): it may now be suspended. */
  private onParkedChange(entry: RetainedController): void {
    const parked = entry.parked;
    if (parked === undefined || entry.controller.suspended || isProtectedView(entry.controller)) return;
    // The eviction clock starts when the view stops needing to stay live.
    const scope = this.parked.get(entry) ?? {};
    entry.parked = { ...parked, at: this.now() };
    this.parked.delete(entry);
    this.parked.set(entry, scope);
    entry.controller.suspend();
    this.enforceLimits();
  }

  private isLiveProtected(entry: RetainedController): boolean {
    return !entry.controller.suspended && isProtectedView(entry.controller);
  }

  private enforceLimits(): void {
    const now = this.now();
    // Bound live subscriptions: suspend the oldest protected views past the ceiling.
    const live = Array.from(this.parked.keys()).filter((entry) => this.isLiveProtected(entry));
    for (const entry of live.slice(0, Math.max(0, live.length - this.limits.maxLiveParked))) {
      entry.controller.suspend();
    }
    // Evict expired, then least-recently-used suspended views until within budget.
    for (const entry of Array.from(this.parked.keys())) {
      if (!this.isLiveProtected(entry) && now - (entry.parked?.at ?? now) >= this.limits.ttlMs) this.dispose(entry);
    }
    const evictable = (): RetainedController[] =>
      Array.from(this.parked.keys()).filter((entry) => !this.isLiveProtected(entry));
    let candidates = evictable();
    let bytes = candidates.reduce((sum, entry) => sum + (entry.parked?.bytes ?? 0), 0);
    while (candidates.length > 0 &&
      (candidates.length > this.limits.maxParked || bytes > this.limits.maxBytes)) {
      const oldest = candidates[0]!;
      bytes -= oldest.parked?.bytes ?? 0;
      this.dispose(oldest);
      candidates = evictable();
    }
    this.scheduleTtl();
  }

  private scheduleTtl(): void {
    if (this.ttlTimer !== null) {
      this.clearTimer(this.ttlTimer);
      this.ttlTimer = null;
    }
    let earliest = Infinity;
    for (const entry of this.parked.keys()) {
      if (this.isLiveProtected(entry)) continue;
      earliest = Math.min(earliest, (entry.parked?.at ?? 0) + this.limits.ttlMs);
    }
    if (earliest === Infinity) return;
    this.ttlTimer = this.setTimer(() => {
      this.ttlTimer = null;
      this.enforceLimits();
    }, Math.max(0, earliest - this.now()));
  }

  add(controller: SessionController): void {
    this.controllers.add(controller);
    this.emit();
  }

  delete(controller: SessionController): void {
    if (!this.controllers.delete(controller)) return;
    this.emit();
  }

  [Symbol.iterator](): Iterator<SessionController> {
    return this.controllers.values();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): number {
    return this.generation;
  }

  private emit(): void {
    this.generation += 1;
    for (const listener of this.listeners) listener();
  }
}

const ConnectionContext = createContext<ConnectionValue | null>(null);
const GUI_LEASE_INTERVAL_MS = 15_000;
let guiLeaseClientSequence = 0;

export function nextGuiLeaseClientId(now = Date.now()): string {
  guiLeaseClientSequence += 1;
  return `gui-${now.toString(36)}-${guiLeaseClientSequence.toString(36)}`;
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const host = useHost();
  const desktopRuntime = host.kind === 'tauri';
  const vscodeRuntime = isVscodeWebview();
  const { locale, t } = useI18n();
  const scopesRef = useRef(new Map<string, QueryClient>());
  const bootScope = pendingScopeReloadScope();
  const remoteBootRef = useRef(bootScope?.scopeId.startsWith('remote:') ? bootScope : null);
  const localSettings = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    settingsServerSnapshot,
  );
  const requestTimeoutMs = localSettings.requestTimeoutSeconds * 1000;
  // A browser that just redeemed a web entry link is already signed in to this
  // origin by cookie, and that is the connection it wants. A stored `?server=`
  // from an earlier visit must not take it over: same-origin is a stronger
  // claim than anything left in localStorage, and a link handed to someone must
  // land on the Kiki that issued it.
  const [webEntry, setWebEntry] = useState<WebAccessBootstrap>(() => webAccessBootstrap());
  // A link that failed is remembered only for as long as this page lives, so a
  // reload or a later visit is a clean slate rather than a permanent dead end.
  const [webLinkProblem, setWebLinkProblem] = useState<WebLinkProblem | undefined>(
    webEntry.kind === 'failed' ? webEntryProblemFor(webEntry.reason) : undefined,
  );
  const [selection, setSelection] = useState<ConnectionSelection | null>(() => {
    if (desktopRuntime || vscodeRuntime) return null;
    if (webEntry.kind === 'signed-in') {
      return { config: { url: '', token: '' }, persist: false, source: 'web-cookie' };
    }
    // No code in this page load. A browser that redeemed a link earlier still
    // holds the cookie, and must be recognized on a refresh or a later visit
    // rather than being asked for a token it does not have. The answer comes
    // from the server, not from anything stored here, and until it arrives the
    // ordinary connect screen stands — so nothing claims a session it cannot
    // prove.
    void askForWebCookie((claimed) => {
      if (!claimed || selectionRef.current !== null) return;
      connectionEpochRef.current += 1;
      setSelection({ config: { url: '', token: '' }, persist: false, source: 'web-cookie' });
    });
    return selectInitialConnection({
      deepLink: readDeepLinkConfig(),
      stored: readStoredConfig(),
    });
  });
  const config = selection?.config ?? null;
  const scopeId = selection?.scopeId ?? (desktopRuntime ? 'local' : `direct:${config?.url.trim().replace(/\/+$/, '') ?? ''}`);
  const connectionId = selection?.source === 'remote' ? selection.connectionId ?? null : null;
  const connectionSource = selection?.source ?? null;
  const spaceKey = connectionId === null ? activeSpace()?.homeId ?? 'main' : `remote:${connectionId}`;
  let queryClient = scopesRef.current.get(scopeId);
  if (queryClient === undefined) {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: 1, staleTime: 0, refetchOnWindowFocus: false } },
    });
    scopesRef.current.set(scopeId, queryClient);
  }
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [connectError, setConnectError] = useState<ConnectError | null>(null);
  const [desktopBoot, setDesktopBoot] = useState<DesktopBootStatus | null>(() =>
    desktopRuntime ? { stage: 'spawning', startedAtMs: Date.now() } : null,
  );
  const [desktopFailure, setDesktopFailure] = useState<DesktopFailureInfo | null>(null);
  /** Bumped by [重试启动] to re-run the desktop boot effect. */
  const [desktopAttempt, setDesktopAttempt] = useState(0);
  /** Set when the user cancels; keeps the kill's rejection from overwriting the card. */
  const desktopCancelledRef = useRef(false);
  const [wsStatus, setWsStatus] = useState<WsStatus>('closed');
  const controllersRef = useRef(new LiveControllerRegistry());
  const connectionEpochRef = useRef(0);
  const sshAttemptRef = useRef(0);
  const localSelectionRef = useRef<ConnectionSelection | null>(null);
  const [localSelection, setLocalSelection] = useState<ConnectionSelection | null>(null);
  const updateLocalSelection = useCallback((next: ConnectionSelection | null) => {
    localSelectionRef.current = next;
    setLocalSelection(next);
  }, []);
  const stagedClientRef = useRef<{ selection: ConnectionSelection; client: KikiClient; meta: MetaResponse } | null>(null);
  const boundHomeIdsRef = useRef(new Map<string, string>());
  const connectedSshProfileRef = useRef<{ id: string; tunnelId: string } | null>(null);
  const scopePreparingRef = useRef(false);
  const reloadSelectionRef = useRef<{ promise: Promise<ConnectionSelection | null> | null; consumed: boolean }>({ promise: null, consumed: false });
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const leaseClientIdRef = useRef(nextGuiLeaseClientId());

  useEffect(() => {
    host.connection.setWorkspaceScope?.(selection?.source === 'ssh' ? 'ssh' : 'local');
    return () => host.connection.setWorkspaceScope?.('local');
  }, [host, selection?.source]);

  useEffect(() => {
    if (!vscodeRuntime) return;
    let cancelled = false;
    void host.connection.discover().then(
      (connection) => {
        if (cancelled) return;
        if (connection === null) return;
        connectionEpochRef.current += 1;
        setSelection({
          config: connection.config,
          persist: connection.persist,
          source: 'local-detection',
        });
      },
      (error: unknown) => {
        if (cancelled) return;
        setConnectError({
          kind: 'raw',
          text: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [host, vscodeRuntime]);

  // The desktop shell resolves an existing daemon before spawning its own.
  // Keep the shared home token in React memory only.
  useEffect(() => {
    if (host.kind !== 'tauri') return;
    let cancelled = false;
    let resolveGeneration = 0;
    desktopCancelledRef.current = false;
    let unlisten: (() => void) | undefined;

    const resolveDesktopConnection = () => {
      const generation = ++resolveGeneration;
      const resume = reloadSelectionRef.current;
      resume.promise ??= (host.connection.takeScopeConnection?.() ?? Promise.resolve(null)).then((handoff): ConnectionSelection | null => {
        if (handoff === null) return null;
        const resolved = handoff.connection;
        return { config: resolved.config, persist: false, source: 'ssh', scopeId: `ssh:${handoff.profile.id}`, profile: handoff.profile,
          tunnelId: resolved.tunnelId, serverHomeId: resolved.serverHomeId, serverInstanceId: resolved.serverInstanceId,
          serverVersion: resolved.serverVersion, buildId: resolved.buildId, buildChannel: resolved.buildChannel };
      }).catch(() => null);
      void Promise.all([host.connection.discover(), resume.consumed ? Promise.resolve(null) : resume.promise]).then(
        ([connection, handoff]) => {
          if (cancelled || generation !== resolveGeneration) return;
          setDesktopBoot(null);
          setDesktopFailure(null);
          if (connection === null) {
            updateLocalSelection(null);
            if (selectionRef.current?.source === 'ssh' || selectionRef.current?.source === 'remote') return;
            setConnectError({ kind: 'key', key: 'conn.desktopNoServer' });
            return;
          }
          const local: ConnectionSelection = {
            config: connection.config,
            persist: false,
            source: 'desktop',
            scopeId: 'local',
          };
          updateLocalSelection(local);
          if (handoff !== null && !resume.consumed) {
            resume.consumed = true;
            resume.promise = Promise.resolve(null);
            selectionRef.current = handoff;
            if (handoff.profile && handoff.tunnelId) connectedSshProfileRef.current = { id: handoff.profile.id, tunnelId: handoff.tunnelId };
            connectionEpochRef.current += 1;
            setSelection(handoff);
            return;
          }
          if (selectionRef.current?.source === 'ssh' || selectionRef.current?.source === 'remote') return;
          connectionEpochRef.current += 1;
          setSelection(local);
        },
        (error: unknown) => {
          if (cancelled || generation !== resolveGeneration) return;
          updateLocalSelection(null);
          if (selectionRef.current?.source === 'ssh' || selectionRef.current?.source === 'remote') return;
          connectionEpochRef.current += 1;
          setDesktopBoot(null);
          setMeta(null);
          setSelection(null);
          if (desktopCancelledRef.current) return;
          setDesktopFailure(normalizeDesktopFailure(error));
        },
      );
    };

    // Runtime recovery reuses the boot stage event. Each waiting stage resolves
    // the newly spawned sidecar connection because its random port may change.
    void host.connection.onBackendStage((payload) => {
      if (scopePreparingRef.current) return;
      if (payload === 'waiting') {
        updateLocalSelection(null);
        if (selectionRef.current?.source === 'ssh' || selectionRef.current?.source === 'remote') {
          resolveDesktopConnection();
          return;
        }
        connectionEpochRef.current += 1;
        setDesktopFailure(null);
        setConnectError(null);
        setSelection(null);
        setMeta(null);
        setDesktopBoot((boot) => ({
          stage: 'waiting',
          startedAtMs: boot?.startedAtMs ?? Date.now(),
        }));
        resolveDesktopConnection();
        return;
      }
      if (
        payload === null ||
        typeof payload !== 'object' ||
        !('stage' in payload) ||
        payload.stage !== 'failed' ||
        !('failure' in payload)
      ) {
        return;
      }
      resolveGeneration += 1;
      updateLocalSelection(null);
      if (selectionRef.current?.source === 'ssh' || selectionRef.current?.source === 'remote') return;
      connectionEpochRef.current += 1;
      setMeta(null);
      setSelection(null);
      setConnectError(null);
      setDesktopBoot(null);
      setDesktopFailure(normalizeDesktopFailure(payload.failure));
    }).then(
      (fn) => {
        if (cancelled) fn();
        else {
          unlisten = fn;
          resolveDesktopConnection();
        }
      },
      () => {
        resolveDesktopConnection();
      },
    );

    return () => {
      cancelled = true;
      resolveGeneration += 1;
      unlisten?.();
    };
  }, [host, desktopAttempt, updateLocalSelection]);

  const retryDesktopBoot = useCallback(() => {
    setDesktopFailure(null);
    setConnectError(null);
    setDesktopBoot({ stage: 'spawning', startedAtMs: Date.now() });
    setDesktopAttempt((attempt) => attempt + 1);
  }, []);

  const cancelDesktopBoot = useCallback(() => {
    desktopCancelledRef.current = true;
    setDesktopBoot(null);
    setDesktopFailure({ message: t('connect.desktopCancelled'), stderrTail: [], logPath: null });
    void host.connection.cancelStartup?.().catch(() => undefined);
  }, [host, t]);

  const localEndpoint = localSelection?.config.url.trim().replace(/\/+$/, '') ?? null;
  const localToken = localSelection?.config.token.trim() ?? null;
  const [localControl, setLocalControl] = useState<{ selection: ConnectionSelection; client: KikiClient } | null>(null);
  const localClient = localSelection !== null && localControl?.selection === localSelection ? localControl.client : null;
  const localClientRef = useRef(localClient);
  localClientRef.current = localClient;
  const restoredMetaRef = useRef<{ client: KikiClient; meta: MetaResponse } | null>(null);

  useEffect(() => {
    if (localSelection === null || localEndpoint === null || localToken === null) return;
    const instance = new KikiClient({
      baseUrl: localEndpoint, token: localToken, timeoutMs: requestTimeoutMs,
      onSessionMutation: (sessionId) => {
        const localQueries = scopesRef.current.get('local');
        if (localQueries !== undefined) refreshSessionAttention(localQueries, sessionId);
      },
    });
    setLocalControl({ selection: localSelection, client: instance });
    return () => { void instance.klient.close(); };
  }, [localSelection, localEndpoint, localToken, requestTimeoutMs]);

  const endpoint = config?.url.trim().replace(/\/+$/, '') ?? null;
  const token = config?.token.trim() ?? null;
  const [clients, setClients] = useState<{
    endpoint: string;
    token: string;
    scopeId: string;
    client: KikiClient;
  } | null>(null);
  const usesLocalControl = selection?.source === 'desktop';
  const staged = stagedClientRef.current?.selection === selection ? stagedClientRef.current : null;
  const selectedLocalClient = usesLocalControl ? localClient : null;
  const client = staged?.client ?? (clients?.endpoint === endpoint && clients.token === token && clients.scopeId === scopeId &&
    (!usesLocalControl || clients.client === selectedLocalClient) ? clients.client : null);
  const klient = client?.klient ?? null;

  useEffect(() => {
    if (endpoint === null || token === null || (usesLocalControl && selectedLocalClient === null)) return;
    const onSessionMutation = (sessionId: string) => { refreshSessionAttention(queryClient, sessionId); };
    const instance = staged?.client ?? selectedLocalClient ?? (selection?.source === 'remote'
      ? createRemoteSpaceClient({ endpoint, token, connectionId: selection.connectionId!, timeoutMs: requestTimeoutMs, onSessionMutation })
      : new KikiClient({ baseUrl: endpoint, token, timeoutMs: requestTimeoutMs, onSessionMutation }));
    setClients({ endpoint, token, scopeId, client: instance });
    const controllers = controllersRef.current;
    return () => {
      // Parked views are bound to this client's socket; they cannot outlive it.
      controllers.evictScope(instance);
      if (instance !== selectedLocalClient) void instance.klient.close();
    };
  }, [endpoint, token, scopeId, requestTimeoutMs, queryClient, usesLocalControl, selectedLocalClient, staged?.client]);

  // Validate the config against /meta before entering the app.
  useEffect(() => {
    if (client === null || (remoteBootRef.current !== null && selection?.source !== 'remote')) return;
    let cancelled = false;
    const connectionEpoch = connectionEpochRef.current;
    setConnectError(null);
    const restored = staged?.client === client ? staged : restoredMetaRef.current?.client === client ? restoredMetaRef.current : null;
    if (restored !== null) restoredMetaRef.current = null;
    (restored !== null ? Promise.resolve(restored.meta) : client.meta()).then(
      (value) => {
        if (cancelled || connectionEpoch !== connectionEpochRef.current) return;
        scrubUrl();
        if (selection?.source === 'ssh') {
          const claimedHomeId = selection.serverHomeId;
          const priorHomeId = boundHomeIdsRef.current.get(scopeId);
          if (!claimedHomeId || !selection.serverInstanceId || !selection.serverVersion ||
              value.server_home_id !== claimedHomeId || value.server_id !== selection.serverInstanceId ||
              value.server_version !== selection.serverVersion ||
              value.dangerous_bypass_auth !== false ||
              (value.build_id ?? null) !== selection.buildId ||
              (value.build_channel ?? null) !== selection.buildChannel ||
              (priorHomeId !== undefined && priorHomeId !== claimedHomeId)) {
            setMeta(null);
            setConnectError({ kind: 'raw', text: 'SSH server identity changed or could not be verified. This connection is blocked.' });
            return;
          }
          boundHomeIdsRef.current.set(scopeId, claimedHomeId);
        }
        if (selection?.source === 'remote' && (!selection.serverHomeId || value.server_home_id !== selection.serverHomeId)) {
          setMeta(null);
          setConnectError({ kind: 'raw', text: 'identity-mismatch' });
          return;
        }
        if (selection?.source !== 'remote' && selection?.persist === true && config !== null) writeStoredConfig(config);
        setMeta(value);
      },
      (error: unknown) => {
        if (cancelled || connectionEpoch !== connectionEpochRef.current) return;
        setMeta(null);
        setConnectError({
          kind: 'raw',
          text:
            error instanceof ApiError
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error),
        });
        // A failed deep link still carried a token; it must not sit in the
        // address bar (retry happens from the form, not the URL).
        scrubUrl();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, config, selection?.persist]);

  // One socket per connection; frames route to registered session controllers.
  const connected = config !== null && meta !== null && client !== null;

  useEffect(() => {
    if (!connected || client === null) return;
    const renew = () => {
      void client.renewLease({ clientId: leaseClientIdRef.current, kind: 'gui' }).catch(() => undefined);
    };
    renew();
    const interval = window.setInterval(renew, GUI_LEASE_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [client, connected]);

  useEffect(() => {
    if (!connected || selection?.source !== 'ssh' || !host.connection.sshTunnelRunning) return;
    const profileId = selection.profile?.id;
    const tunnelId = selection.tunnelId;
    if (!profileId || !tunnelId) return;
    let active = true;
    let pending = false;
    const check = () => {
      if (pending) return;
      pending = true;
      void host.connection.sshTunnelRunning!(profileId, tunnelId).then(
        (running) => {
          if (!active || running) return;
          connectionEpochRef.current += 1;
          setMeta(null);
          setConnectError({ kind: 'raw', text: 'SSH tunnel disconnected. Check the remote service and connect again.' });
        },
        (error: unknown) => {
          if (!active) return;
          connectionEpochRef.current += 1;
          setMeta(null);
          setConnectError({ kind: 'raw', text: `Cannot check the SSH tunnel: ${String(error)}` });
        },
      ).finally(() => { pending = false; });
    };
    check();
    const interval = window.setInterval(check, 2_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [connected, selection?.source, selection?.profile?.id, selection?.tunnelId, host]);

  const socket = connected ? klient?.terminal ?? null : null;

  useEffect(() => {
    if (socket === null || klient === null) return;
    let active = true;
    const subscribeSearchIndex = () => {
      const subscription = klient.events.on('search.indexStateChanged', (state) => {
        void queryClient.cancelQueries({ queryKey: ['search-index-state'] }).then(() => {
          if (active && searchIndex === subscription) queryClient.setQueryData(['search-index-state'], state);
        });
      });
      void subscription.ready.then(() => {
        if (active && searchIndex === subscription) return queryClient.invalidateQueries({ queryKey: ['search-index-state'] });
      }).catch(() => {});
      return subscription;
    };
    let searchIndex = subscribeSearchIndex();
    let offUsage = subscribeUsageFreshness(klient, queryClient);
    // A plugin change moves capabilities, skills, MCP, panels and commands too,
    // and a reconnect can carry one this window never saw.
    let offPlugins = subscribePluginFreshness(klient, queryClient);
    const offStatus = socket.onStatus((status) => {
      setWsStatus(status);
      if (status === 'open') {
        searchIndex.dispose();
        searchIndex = subscribeSearchIndex();
        offUsage();
        offUsage = subscribeUsageFreshness(klient, queryClient);
        offPlugins();
        offPlugins = subscribePluginFreshness(klient, queryClient);
      }
    });
    const catalog = klient.events.on('kosong.changed', () => {
      handleGlobalConnectionFrame({ type: 'event.model_catalog.changed' }, queryClient);
    });
    return () => {
      active = false;
      offStatus();
      catalog.dispose();
      searchIndex.dispose();
      offUsage();
      offPlugins();
    };
  }, [socket, klient, queryClient]);

  // Page lifecycle next to the socket's own log: a close right after a long
  // hidden-window timer gap reads very differently from one out of the blue.
  useEffect(() => {
    if (socket === null) return;
    return watchPageLifecycle();
  }, [socket]);

  // Browser recovery events nudge a parked socket without adding periodic work.
  useEffect(() => {
    if (socket === null) return;
    const nudge = () => {
      socket.nudge();
      for (const controller of controllersRef.current) controller.nudge();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') nudge();
    };
    window.addEventListener('online', nudge);
    window.addEventListener('focus', nudge);
    window.addEventListener('pageshow', nudge);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', nudge);
      window.removeEventListener('focus', nudge);
      window.removeEventListener('pageshow', nudge);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [socket]);

  const [needsScopeReload, setNeedsScopeReload] = useState(false);
  const adapterActiveRef = useRef({ scope: { homeId: spaceKey, scopeId }, selection, client });
  adapterActiveRef.current = { scope: { homeId: spaceKey, scopeId }, selection, client };
  const scopeAdapter = useMemo(() => createScopeConnectionAdapter({
    host,
    active: () => {
      const active = adapterActiveRef.current;
      if (active.selection === null || active.client === null) throw new Error('No active connection');
      return { scope: active.scope, selection: active.selection, client: active.client };
    },
    local: () => localSelectionRef.current !== null && localClientRef.current !== null
      ? { selection: localSelectionRef.current, client: localClientRef.current } : null,
    control: () => {
      if (localSelectionRef.current !== null && localClientRef.current !== null) return { selection: localSelectionRef.current, client: localClientRef.current };
      const active = adapterActiveRef.current;
      return active.selection !== null && active.client !== null && active.selection.source !== 'remote' && active.selection.source !== 'ssh'
        ? { selection: active.selection, client: active.client } : null;
    },
    createClient: (next) => next.source === 'remote'
      ? createRemoteSpaceClient({ endpoint: next.config.url, token: next.config.token, connectionId: next.connectionId!, timeoutMs: requestTimeoutMs,
        onSessionMutation: (sessionId) => { const queries = scopesRef.current.get(next.scopeId!); if (queries !== undefined) refreshSessionAttention(queries, sessionId); } })
      : new KikiClient({ baseUrl: next.config.url, token: next.config.token, timeoutMs: requestTimeoutMs }),
    reload: () => { if (remoteBootRef.current === null) setNeedsScopeReload(true); },
    preparing: (preparing) => { scopePreparingRef.current = preparing; },
    commit: (next, instance, nextMeta) => {
      sshAttemptRef.current += 1;
      connectionEpochRef.current += 1;
      if (next === adapterActiveRef.current.selection && instance === adapterActiveRef.current.client) {
        // A same-connection return only revalidates identity. Restaging this
        // already-owned client would trigger effect cleanup and then reuse it closed.
        setMeta(nextMeta);
        return;
      }
      const sourceSelection = adapterActiveRef.current.selection;
      if (next.source === 'remote' && !desktopRuntime && sourceSelection !== null && sourceSelection.source !== 'remote' && sourceSelection.source !== 'ssh') {
        updateLocalSelection({ ...sourceSelection, scopeId: adapterActiveRef.current.scope.scopeId });
      }
      const nextTunnel = next.source === 'ssh' && next.profile && next.tunnelId ? { id: next.profile.id, tunnelId: next.tunnelId } : null;
      connectedSshProfileRef.current = nextTunnel;
      // Native retains only the adopted connection and one staged tunnel. Leaving
      // for local does not revoke the exact authenticated reference in history.
      stagedClientRef.current = { selection: next, client: instance, meta: nextMeta };
      selectionRef.current = next;
      setSelection(next);
      setClients({ endpoint: next.config.url.trim().replace(/\/+$/, ''), token: next.config.token.trim(), scopeId: next.scopeId ?? 'local', client: instance });
      setConnectError(null);
      setMeta(nextMeta);
    },
  }), [host, requestTimeoutMs, desktopRuntime, updateLocalSelection]);

  useEffect(() => {
    const scope = remoteBootRef.current;
    if (scope === null || client === null || selection?.source === 'remote') return;
    const controller = new AbortController();
    void (async () => {
      const prepared = await scopeAdapter.prepare(scope, controller.signal);
      try {
        await prepared.validate(`${window.location.pathname}${window.location.search}${window.location.hash}`, controller.signal);
        controller.signal.throwIfAborted();
        await prepared.commit();
        remoteBootRef.current = null;
      } catch (error) { await prepared.dispose(); throw error; }
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setMeta(null);
      setConnectError({ kind: 'raw', text: error instanceof Error ? error.message : String(error) });
    });
    return () => { controller.abort(); };
  }, [client, selection?.source, scopeAdapter]);

  const restoreLocal = useCallback(async (signal = new AbortController().signal) => {
    const instance = localClientRef.current;
    const priorSelection = selectionRef.current;
    const attempt = sshAttemptRef.current;
    const homeId = priorSelection?.source === 'remote'
      ? host.activeSpace === undefined ? 'main' : parseActiveSpacePayload(await host.activeSpace())?.homeId ?? 'main'
      : activeSpace()?.homeId ?? 'main';
    const prepared = await scopeAdapter.prepare({ homeId, scopeId: 'local' }, signal);
    try {
      signal.throwIfAborted();
      if (instance !== localClientRef.current || priorSelection !== selectionRef.current || attempt !== sshAttemptRef.current) {
        throw new DOMException('Local connection restoration was superseded.', 'AbortError');
      }
      await prepared.commit();
    } catch (error) { await prepared.dispose(); throw error; }
  }, [scopeAdapter, host]);
  const activateLocal = useCallback(() => {
    if (meta !== null && client !== null) {
      if (selectionRef.current?.source === 'remote') {
        void (async () => {
          const homeId = host.activeSpace === undefined ? 'main' : parseActiveSpacePayload(await host.activeSpace())?.homeId ?? 'main';
          await requestScopeNavigation({ homeId, scopeId: localSelectionRef.current?.scopeId ?? 'local' });
        })().catch(() => undefined);
      } else void requestScopeNavigation({ scopeId: 'local' }).catch(() => undefined);
      return;
    }
    sshAttemptRef.current += 1;
    connectionEpochRef.current += 1;
    const ssh = connectedSshProfileRef.current;
    connectedSshProfileRef.current = null;
    if (ssh !== null) void host.connection.disconnectSshProfile?.(ssh.id, ssh.tunnelId).catch(() => undefined);
    setMeta(null);
    setConnectError(null);
    setSelection(localSelectionRef.current);
    if (localSelectionRef.current === null && desktopRuntime) retryDesktopBoot();
  }, [meta, client, host, desktopRuntime, retryDesktopBoot]);
  const activateSshProfile = useCallback(async (id: string, token: string) => {
    if (adapterActiveRef.current.client !== null && adapterActiveRef.current.selection !== null) {
      await requestScopeNavigation({ scopeId: `ssh:${id}`, token });
      return;
    }
    // A cold connect has no source visit to push. The normal SSH handshake still
    // runs, but requires a fresh token from the existing connect form.
    if (!host.connection.connectSshProfile || !host.connection.listSshProfiles) {
      throw new Error('SSH connections are available only in the desktop application.');
    }
    const attempt = ++sshAttemptRef.current;
    const profiles = await host.connection.listSshProfiles();
    const profile = profiles.find((entry) => entry.id === id);
    if (!profile) throw new Error('SSH profile no longer exists.');
    if (!profile.serverHomeId || !profile.remotePort || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new Error('Set the remote Kiki port, expected home ID and bearer token first.');
    }
    const resolved = await host.connection.connectSshProfile(id, token);
    if (attempt !== sshAttemptRef.current) {
      if (resolved.tunnelId) void host.connection.disconnectSshProfile?.(id, resolved.tunnelId).catch(() => undefined);
      return;
    }
    let url: URL | null;
    try { url = new URL(resolved.config.url); } catch { url = null; }
    if (url?.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
        url.username || url.password || !url.port || !resolved.tunnelId ||
        resolved.config.token !== token || resolved.serverHomeId !== profile.serverHomeId) {
      if (resolved.tunnelId) void host.connection.disconnectSshProfile?.(id, resolved.tunnelId).catch(() => undefined);
      throw new Error('SSH tunnel endpoint or server home ID could not be verified.');
    }
    connectedSshProfileRef.current = { id, tunnelId: resolved.tunnelId };
    connectionEpochRef.current += 1;
    setMeta(null);
    setConnectError(null);
    setSelection({
      config: resolved.config,
      persist: false,
      source: 'ssh',
      scopeId: `ssh:${id}`,
      profile,
      tunnelId: resolved.tunnelId,
      serverHomeId: resolved.serverHomeId,
      serverInstanceId: resolved.serverInstanceId,
      serverVersion: resolved.serverVersion,
      buildId: resolved.buildId,
      buildChannel: resolved.buildChannel,
    });
  }, [host]);

  const disconnect = useCallback(() => {
    if (selectionRef.current?.source === 'ssh') {
      activateLocal();
      return;
    }
    connectionEpochRef.current += 1;
    clearStoredConfig();
    setMeta(null);
    setSelection(null);
    setConnectError(null);
    scrubUrl();
  }, [activateLocal]);

  /**
   * Retry a link that did not work.
   *
   * The code is gone from the URL and from memory, so this cannot re-send it;
   * what it does is clear the failure so the ordinary connect form is reachable,
   * which is the only recovery a browser in this state can actually use.
   */
  const retryWebLink = useCallback(() => {
    resetWebAccessBootstrap();
    setWebEntry({ kind: 'none' });
    setWebLinkProblem(undefined);
  }, []);

  const connect = useCallback((next: ConnectionConfig, persist = true) => {
    const generation = ++connectionEpochRef.current;
    const prior = selectionRef.current;
    const equivalent = prior !== null &&
      prior.config.url.trim().replace(/\/+$/, '') === next.url.trim().replace(/\/+$/, '') &&
      prior.config.token.trim() === next.token.trim();
    setConnectError(null);
    setMeta(null);
    setSelection({
      config: next,
      persist,
      source: persist ? 'manual' : 'local-detection',
      scopeId: equivalent ? prior.scopeId : `direct:${next.url.trim().replace(/\/+$/, '')}:${generation}`,
    });
  }, []);

  // Settings edits always persist: a connection typed into the settings page
  // is an explicit choice, the same as one typed into the connect screen.
  const applyConnection = useCallback(
    (next: ConnectionConfig) => {
      if (selectionRef.current?.source === 'ssh' || selectionRef.current?.source === 'remote') return;
      connect(next, true);
    },
    [connect],
  );

  const value = useMemo<ConnectionValue | null>(() => {
    if (config === null || client === null || klient === null || socket === null || meta === null) return null;
    return {
      connectionId, connectionSource: selection?.source ?? null, spaceKey, scopeId, connectionRef: selection?.source === 'remote' ? selection.connectionId : selection?.source === 'ssh' ? selection.tunnelId : undefined, sshLabel: selection?.profile?.label ?? null,
      activateSshProfile, activateLocal, restoreLocal, scopeAdapter, needsScopeReload,
      config, client, localClient, klient, socket, meta, wsStatus, disconnect, applyConnection,
    };
  }, [connectionId, connectionSource, spaceKey, scopeId, selection?.tunnelId, selection?.profile?.label, activateSshProfile, activateLocal, restoreLocal, scopeAdapter, needsScopeReload, config, client, localClient, klient, socket, meta, wsStatus, disconnect, applyConnection]);

  const connectErrorText =
    connectError === null
      ? null
      : connectError.kind === 'key'
        ? translate(locale, connectError.key, connectError.params)
        : connectError.text;
  // In desktop mode every failure (attach, spawn, early exit, timeout, /meta)
  // goes to the dedicated failure card; the browser URL/token form is not an
  // actionable recovery path for the native shell.
  const desktopFailureView = selection?.source === 'ssh'
    ? connectErrorText === null ? null : { message: connectErrorText, stderrTail: [], logPath: null }
    : desktopFailure ??
      (desktopRuntime && connectErrorText !== null
        ? { message: connectErrorText, stderrTail: [], logPath: null }
        : null);

  return (
    <ConnectionContext.Provider value={value}>
      {value !== null ? (
        <QueryClientProvider client={queryClient}>
          <ControllerRegistryContext.Provider value={controllersRef.current}>
            {children}
          </ControllerRegistryContext.Provider>
        </QueryClientProvider>
      ) : (
        <ConnectScreen
          initial={config ?? { url: '', token: '' }}
          connecting={desktopBoot !== null || (config !== null && connectError === null)}
          error={desktopRuntime ? null : connectErrorText}
          onConnect={connect}
          onBack={desktopRuntime ? undefined : config !== null ? disconnect : undefined}
          desktopBoot={desktopBoot}
          desktopFailure={desktopFailureView}
          onRetryDesktop={retryDesktopBoot}
          onCancelDesktopBoot={cancelDesktopBoot}
          onConnectSsh={activateSshProfile}
          onSwitchLocal={selection?.source === 'ssh' ? activateLocal : undefined}
          sshProfile={selection?.source === 'ssh' ? selection.profile : undefined}
          webLink={webLinkProblem}
          onRetryWebLink={retryWebLink}
        />
      )}
    </ConnectionContext.Provider>
  );
}

const ControllerRegistryContext = createContext<ControllerRegistry | null>(null);

export function useControllerRegistry(): ControllerRegistry {
  const value = useContext(ControllerRegistryContext);
  if (value === null) throw new Error('useControllerRegistry outside provider');
  return value;
}

export function useOptionalControllerRegistry(): ControllerRegistry | null {
  return useContext(ControllerRegistryContext);
}

export function useConnection(): ConnectionValue {
  const value = useContext(ConnectionContext);
  if (value === null) throw new Error('useConnection used before connecting');
  return value;
}

/**
 * Non-throwing variant for overlays (media preview, lightbox) that can also
 * render in tests or outside a live connection; features needing the client
 * degrade to a disabled state when this returns null.
 */
export function useOptionalConnection(): ConnectionValue | null {
  return useContext(ConnectionContext);
}
