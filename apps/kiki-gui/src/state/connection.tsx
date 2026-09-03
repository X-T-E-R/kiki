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
  type ReactNode,
} from 'react';

import type { MetaResponse } from '@moonshot-ai/protocol';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

import { ConnectScreen } from '../components/ConnectScreen';
import { useHost } from '../host';
import { translate, type I18nKey, type I18nParams } from '../i18n/locale';
import { useI18n } from '../i18n';
import { ApiError, KikiClient } from '../lib/client';
import { KikiSocket, type WsStatus } from '../lib/ws';
import type { SessionEventFrame } from '../lib/types';
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
import type { SessionController } from './sessionController';

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
  frame: Pick<SessionEventFrame, 'type'>,
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
): boolean {
  if (frame.type !== 'event.model_catalog.changed') return false;
  void queryClient.invalidateQueries({ queryKey: ['models'] });
  void queryClient.invalidateQueries({ queryKey: ['providers'] });
  return true;
}

interface ConnectionValue {
  readonly config: ConnectionConfig;
  readonly client: KikiClient;
  readonly socket: KikiSocket;
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

export interface ControllerRegistry {
  add(controller: SessionController): void;
  delete(controller: SessionController): void;
  [Symbol.iterator](): Iterator<SessionController>;
  subscribe(listener: () => void): () => void;
  snapshot(): number;
}

class LiveControllerRegistry implements ControllerRegistry {
  private readonly controllers = new Set<SessionController>();
  private readonly listeners = new Set<() => void>();
  private generation = 0;

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
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<ConnectionSelection | null>(() =>
    desktopRuntime
      ? null
      : selectInitialConnection({
          deepLink: readDeepLinkConfig(),
          stored: readStoredConfig(),
        }),
  );
  const config = selection?.config ?? null;
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
  const liveSocketRef = useRef<KikiSocket | null>(null);
  const connectionEpochRef = useRef(0);
  const leaseClientIdRef = useRef(nextGuiLeaseClientId());

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
          connectionEpochRef.current += 1;
          setSelection({
            config: connection.config,
            persist: false,
            source: 'desktop',
          });
        },
        (error: unknown) => {
          if (cancelled || generation !== resolveGeneration) return;
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

  const client = useMemo(
    () =>
      config === null
        ? null
        : new KikiClient({
            baseUrl: config.url.trim().replace(/\/+$/, ''),
            token: config.token.trim(),
          }),
    [config],
  );

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
        if (selection?.persist === true && config !== null) {
          writeStoredConfig(config);
        }
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

  const socket = useMemo(() => {
    if (!connected || config === null || client === null || meta === null) return null;
    const instance = new KikiSocket({
      baseUrl: config.url.trim().replace(/\/+$/, ''),
      token: config.token.trim(),
      events: {
        onStatus: (status, _detail, generation) => {
          if (liveSocketRef.current !== instance) return;
          if (generation !== undefined && generation !== instance.connectionGeneration) return;
          if (status !== 'open') {
            for (const controller of controllersRef.current) controller.handleWsDrop();
          }
          setWsStatus(status);
        },
        onFrame: (frame, generation) => {
          if (liveSocketRef.current !== instance) return;
          if (generation !== undefined && generation !== instance.connectionGeneration) return;
          if (handleGlobalConnectionFrame(frame, queryClient)) return;
          for (const controller of controllersRef.current) controller.handleFrame(frame);
        },
        onTranscript: (event, generation) => {
          if (liveSocketRef.current !== instance) return;
          if (generation !== undefined && generation !== instance.connectionGeneration) return;
          for (const controller of controllersRef.current) {
            if (controller.sessionId === event.session_id) controller.handleTranscript(event, generation);
          }
        },
        onResyncRequired: (payload, generation) => {
          if (liveSocketRef.current !== instance) return;
          if (generation !== undefined && generation !== instance.connectionGeneration) return;
          for (const controller of controllersRef.current) {
            controller.handleResyncRequired(payload);
          }
        },
        onSubscribeAck: (accepted, resyncRequired, cursors, reconnected, generation) => {
          if (liveSocketRef.current !== instance) return;
          if (generation !== undefined && generation !== instance.connectionGeneration) return;
          for (const controller of controllersRef.current) {
            const offered = cursors?.[controller.sessionId];
            const localEpoch = controller.getState().cursor.epoch;
            const epochChanged =
              offered?.epoch !== undefined &&
              localEpoch !== undefined &&
              offered.epoch !== localEpoch;
            if (resyncRequired.includes(controller.sessionId) || epochChanged) {
              controller.handleSubscribeRejected(generation);
              continue;
            }
            if (!accepted.includes(controller.sessionId)) continue;
            if (reconnected) controller.handleReconnectAck();
          }
        },
      },
    });
    return instance;
  }, [client, config, connected, queryClient]);

  useEffect(() => {
    liveSocketRef.current = socket;
    if (socket === null) return;
    socket.connect();
    return () => {
      if (liveSocketRef.current === socket) liveSocketRef.current = null;
      socket.close();
    };
  }, [socket]);

  // Browser recovery events nudge a parked socket without adding periodic work.
  useEffect(() => {
    if (socket === null) return;
    const nudge = () => {
      socket.nudge();
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

  const disconnect = useCallback(() => {
    connectionEpochRef.current += 1;
    clearStoredConfig();
    setMeta(null);
    setSelection(null);
    setConnectError(null);
    // Abandoning the screen counts as giving up on the credential handoff.
    scrubUrl();
  }, []);

  const connect = useCallback((next: ConnectionConfig, persist = true) => {
    connectionEpochRef.current += 1;
    setConnectError(null);
    setMeta(null);
    setSelection({
      config: next,
      persist,
      source: persist ? 'manual' : 'local-detection',
    });
  }, []);

  // Settings edits always persist: a connection typed into the settings page
  // is an explicit choice, the same as one typed into the connect screen.
  const applyConnection = useCallback(
    (next: ConnectionConfig) => {
      connect(next, true);
    },
    [connect],
  );

  const value = useMemo<ConnectionValue | null>(() => {
    if (config === null || client === null || socket === null || meta === null) return null;
    return { config, client, socket, meta, wsStatus, disconnect, applyConnection };
  }, [config, client, socket, meta, wsStatus, disconnect, applyConnection]);

  const connectErrorText =
    connectError === null
      ? null
      : connectError.kind === 'key'
        ? translate(locale, connectError.key, connectError.params)
        : connectError.text;
  // In desktop mode every failure (attach, spawn, early exit, timeout, /meta)
  // goes to the dedicated failure card; the browser URL/token form is not an
  // actionable recovery path for the native shell.
  const desktopFailureView =
    desktopFailure ??
    (desktopRuntime && connectErrorText !== null
      ? { message: connectErrorText, stderrTail: [] as string[], logPath: null }
      : null);

  return (
    <ConnectionContext.Provider value={value}>
      {value !== null ? (
        <ControllerRegistryContext.Provider value={controllersRef.current}>
          {children}
        </ControllerRegistryContext.Provider>
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
