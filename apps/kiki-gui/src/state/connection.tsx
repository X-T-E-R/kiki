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

import { ConnectScreen } from '../components/ConnectScreen';
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
import { ApiError, KikiClient } from '../lib/client';
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
      window.history.replaceState(null, '', scrubbedUrl);
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
  readonly scopeId: string;
  readonly sshLabel: string | null;
  readonly activateSshProfile: (id: string, token: string) => Promise<void>;
  readonly activateLocal: () => void;
  readonly config: ConnectionConfig;
  readonly client: KikiClient;
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
    for (const [entry, scope] of [...this.parked]) {
      if (scope === connectionScope) this.dispose(entry);
    }
  }

  /** Close every parked view. */
  clearParked(): void {
    for (const entry of [...this.parked.keys()]) this.dispose(entry);
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
    const live = [...this.parked.keys()].filter((entry) => this.isLiveProtected(entry));
    for (const entry of live.slice(0, Math.max(0, live.length - this.limits.maxLiveParked))) {
      entry.controller.suspend();
    }
    // Evict expired, then least-recently-used suspended views until within budget.
    for (const entry of [...this.parked.keys()]) {
      if (!this.isLiveProtected(entry) && now - (entry.parked?.at ?? now) >= this.limits.ttlMs) this.dispose(entry);
    }
    const evictable = (): RetainedController[] =>
      [...this.parked.keys()].filter((entry) => !this.isLiveProtected(entry));
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
  const localSettings = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    settingsServerSnapshot,
  );
  const requestTimeoutMs = localSettings.requestTimeoutSeconds * 1000;
  const [selection, setSelection] = useState<ConnectionSelection | null>(() =>
    desktopRuntime || vscodeRuntime
      ? null
      : selectInitialConnection({
          deepLink: readDeepLinkConfig(),
          stored: readStoredConfig(),
        }),
  );
  const config = selection?.config ?? null;
  const scopeId = selection?.scopeId ?? (desktopRuntime ? 'local' : `direct:${config?.url.trim().replace(/\/+$/, '') ?? ''}`);
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
  const boundHomeIdsRef = useRef(new Map<string, string>());
  const connectedSshProfileRef = useRef<{ id: string; tunnelId: string } | null>(null);
  const routesRef = useRef(new Map<string, string>());
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
      void host.connection.discover().then(
        (connection) => {
          if (cancelled || generation !== resolveGeneration) return;
          setDesktopBoot(null);
          setDesktopFailure(null);
          if (connection === null) {
            setConnectError({ kind: 'key', key: 'conn.desktopNoServer' });
            return;
          }
          const local: ConnectionSelection = {
            config: connection.config,
            persist: false,
            source: 'desktop',
            scopeId: 'local',
          };
          localSelectionRef.current = local;
          if (selectionRef.current?.source === 'ssh') return;
          connectionEpochRef.current += 1;
          setSelection(local);
        },
        (error: unknown) => {
          if (cancelled || generation !== resolveGeneration) return;
          if (selectionRef.current?.source === 'ssh') return;
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
      if (payload === 'waiting') {
        if (selectionRef.current?.source === 'ssh') {
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
      localSelectionRef.current = null;
      if (selectionRef.current?.source === 'ssh') return;
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
  }, [host, desktopAttempt]);

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

  const endpoint = config?.url.trim().replace(/\/+$/, '') ?? null;
  const token = config?.token.trim() ?? null;
  const [clients, setClients] = useState<{
    endpoint: string;
    token: string;
    scopeId: string;
    client: KikiClient;
  } | null>(null);
  const client = clients?.endpoint === endpoint && clients.token === token && clients.scopeId === scopeId ? clients.client : null;
  const klient = client?.klient ?? null;

  useEffect(() => {
    if (endpoint === null || token === null) return;
    const instance = new KikiClient({
      baseUrl: endpoint,
      token,
      timeoutMs: requestTimeoutMs,
      onSessionMutation: (sessionId) => { refreshSessionAttention(queryClient, sessionId); },
    });
    setClients({ endpoint, token, scopeId, client: instance });
    const controllers = controllersRef.current;
    return () => {
      // Parked views are bound to this client's socket; they cannot outlive it.
      controllers.evictScope(instance);
      void instance.klient.close();
    };
  }, [endpoint, token, scopeId, requestTimeoutMs, queryClient]);

  // Validate the config against /meta before entering the app.
  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    const connectionEpoch = connectionEpochRef.current;
    setConnectError(null);
    client.meta().then(
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
        if (selection?.persist === true && config !== null) writeStoredConfig(config);
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
    const offStatus = socket.onStatus((status) => {
      setWsStatus(status);
      if (status === 'open') {
        searchIndex.dispose();
        searchIndex = subscribeSearchIndex();
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

  const activateLocal = useCallback(() => {
    sshAttemptRef.current += 1;
    connectionEpochRef.current += 1;
    const ssh = connectedSshProfileRef.current;
    connectedSshProfileRef.current = null;
    if (ssh !== null) void host.connection.disconnectSshProfile?.(ssh.id, ssh.tunnelId).catch(() => undefined);
    if (selectionRef.current?.source === 'ssh') {
      routesRef.current.set(selectionRef.current.scopeId ?? '', `${window.location.pathname}${window.location.search}`);
      window.history.replaceState(null, '', routesRef.current.get('local') ?? '/new');
    }
    setMeta(null);
    setConnectError(null);
    setSelection(localSelectionRef.current);
    if (localSelectionRef.current === null && desktopRuntime) retryDesktopBoot();
  }, [desktopRuntime, host, retryDesktopBoot]);

  const activateSshProfile = useCallback(async (id: string, token: string) => {
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
    routesRef.current.set(selectionRef.current?.scopeId ?? 'local', `${window.location.pathname}${window.location.search}`);
    window.history.replaceState(null, '', routesRef.current.get(`ssh:${id}`) ?? '/new');
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
      if (selectionRef.current?.source === 'ssh') return;
      connect(next, true);
    },
    [connect],
  );

  const value = useMemo<ConnectionValue | null>(() => {
    if (config === null || client === null || klient === null || socket === null || meta === null) return null;
    return {
      scopeId, sshLabel: selection?.profile?.label ?? null,
      activateSshProfile, activateLocal,
      config, client, klient, socket, meta, wsStatus, disconnect, applyConnection,
    };
  }, [scopeId, selection?.profile?.label, activateSshProfile, activateLocal, config, client, klient, socket, meta, wsStatus, disconnect, applyConnection]);

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
        <QueryClientProvider key={scopeId} client={queryClient}>
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
