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
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { ConnectScreen } from '../components/ConnectScreen';
import { translate, type I18nKey, type I18nParams } from '../i18n/locale';
import { useI18n } from '../i18n';
import { ApiError, KikiClient } from '../lib/client';
import { detectLocalConnection, isDesktopRuntime } from '../lib/localServer';
import { KikiSocket, type WsStatus } from '../lib/ws';
import {
  readDeepLinkConfig,
  readStoredConfig,
  scrubConnectionUrl,
  selectInitialConnection,
  type ConnectionConfig,
  type ConnectionSelection,
} from './connectionConfig';
import type { SessionController } from './sessionController';

export type { ConnectionConfig } from './connectionConfig';

const STORAGE_KEY = 'kiki.connection';
const DESKTOP_STAGE_EVENT = 'kiki://desktop-backend-stage';

/** Boot phase of the desktop-owned backend, for the boot card's copy. */
export type DesktopBootStage = 'spawning' | 'waiting';

export interface DesktopBootStatus {
  readonly stage: DesktopBootStage;
  readonly startedAtMs: number;
}

/** Structured failure from the Rust shell (`DesktopStartupFailure`). */
export interface DesktopFailureInfo {
  readonly message: string;
  readonly stderrTail: readonly string[];
  readonly logPath: string | null;
}

/** Shape the desktop backend rejection into the failure card's input. */
export function normalizeDesktopFailure(error: unknown): DesktopFailureInfo {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const raw = error as { message?: unknown; stderrTail?: unknown; logPath?: unknown };
    if (typeof raw.message === 'string') {
      return {
        message: raw.message,
        stderrTail: Array.isArray(raw.stderrTail)
          ? raw.stderrTail.filter((line): line is string => typeof line === 'string')
          : [],
        logPath: typeof raw.logPath === 'string' ? raw.logPath : null,
      };
    }
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    stderrTail: [],
    logPath: null,
  };
}

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
    window.history.replaceState(null, '', scrubbedUrl);
  }
}

interface ConnectionValue {
  readonly config: ConnectionConfig;
  readonly client: KikiClient;
  readonly socket: KikiSocket;
  readonly meta: MetaResponse;
  readonly wsStatus: WsStatus;
  readonly disconnect: () => void;
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

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const desktopRuntime = isDesktopRuntime();
  const { locale, t } = useI18n();
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

  // The desktop shell owns its backend. Resolve that connection before
  // considering browser handoffs or persisted remote connections, and keep
  // the bearer token in React memory only.
  useEffect(() => {
    if (!desktopRuntime) return;
    let cancelled = false;
    desktopCancelledRef.current = false;
    let unlisten: (() => void) | undefined;

    // The shell reports when the sidecar exists and readiness polling began.
    void listen<string>(DESKTOP_STAGE_EVENT, (event) => {
      if (event.payload !== 'waiting') return;
      setDesktopBoot((boot) => (boot === null ? boot : { ...boot, stage: 'waiting' }));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }, () => {
      // Listening is cosmetic; the boot still proceeds without stage updates.
    });

    void detectLocalConnection().then(
      (connection) => {
        if (cancelled) return;
        setDesktopBoot(null);
        if (connection === null) {
          setConnectError({ kind: 'key', key: 'conn.desktopNoServer' });
          return;
        }
        setSelection({
          config: connection.config,
          persist: false,
          source: 'desktop',
        });
      },
      (error: unknown) => {
        if (cancelled) return;
        setDesktopBoot(null);
        if (desktopCancelledRef.current) return;
        setDesktopFailure(normalizeDesktopFailure(error));
      },
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [desktopRuntime, desktopAttempt]);

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
    void invoke('cancel_desktop_startup').catch(() => undefined);
  }, [t]);

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
    setConnectError(null);
    client.meta().then(
      (value) => {
        if (cancelled) return;
        setMeta(value);
        if (selection?.persist === true) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
        }
        scrubUrl();
      },
      (error: unknown) => {
        if (cancelled) return;
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
          for (const controller of controllersRef.current) controller.handleFrame(frame);
        },
        onTranscript: (event, generation) => {
          if (liveSocketRef.current !== instance) return;
          if (generation !== undefined && generation !== instance.connectionGeneration) return;
          for (const controller of controllersRef.current) {
            if (controller.sessionId === event.session_id) controller.handleTranscript(event);
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
            if (!accepted.includes(controller.sessionId)) continue;
            if (reconnected) controller.handleReconnectAck();
            const offered = cursors?.[controller.sessionId];
            const localEpoch = controller.getState().cursor.epoch;
            const epochChanged =
              offered?.epoch !== undefined &&
              localEpoch !== undefined &&
              offered.epoch !== localEpoch;
            if (resyncRequired.includes(controller.sessionId) || epochChanged) {
              void controller.resync();
            }
          }
        },
      },
    });
    return instance;
  }, [client, config, connected]);

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
    localStorage.removeItem(STORAGE_KEY);
    setMeta(null);
    setSelection(null);
    setConnectError(null);
    // Abandoning the screen counts as giving up on the credential handoff.
    scrubUrl();
  }, []);

  const connect = useCallback((next: ConnectionConfig, persist = true) => {
    setConnectError(null);
    setMeta(null);
    setSelection({
      config: next,
      persist,
      source: persist ? 'manual' : 'local-detection',
    });
  }, []);

  const value = useMemo<ConnectionValue | null>(() => {
    if (config === null || client === null || socket === null || meta === null) return null;
    return { config, client, socket, meta, wsStatus, disconnect };
  }, [config, client, socket, meta, wsStatus, disconnect]);

  const connectErrorText =
    connectError === null
      ? null
      : connectError.kind === 'key'
        ? translate(locale, connectError.key, connectError.params)
        : connectError.text;
  // In desktop mode every failure (spawn, early exit, timeout, /meta) goes to
  // the dedicated failure card; the browser URL/token form is meaningless
  // there (the port is random and the token is process-owned).
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
