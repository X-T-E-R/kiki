import { Agent, request } from 'node:https';
import type { ClientRequest } from 'node:http';
import { isIP } from 'node:net';
import { connect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import { Readable } from 'node:stream';
import { RELAY_WS_SUBPROTOCOL, normalizeRelayEndpoint } from '@kiki/protocol';
import { createWebSocketStream, WebSocket } from 'ws';
import { AdmissionError } from './admission';
import { spkiFingerprint } from './tlsIdentity';

const IDLE_AGENT_TTL_MS = 120_000;
const MAX_POOLED_AGENTS = 64;
const HAPPY_EYEBALLS_STAGGER_MS = 300;
const REQUEST_SIGNAL = Symbol('kiki.peerTls.requestSignal');

export interface PinnedCandidateRoutes {
  readonly directEndpoints: readonly string[];
  readonly relayEndpoints: readonly string[];
}

interface PooledAgentEntry {
  agent: Agent;
  origin: string;
  fingerprint: string;
  routesKey: string;
  lastUsedAt: number;
}

const pooledAgents = new Map<string, PooledAgentEntry>();
const candidateRoutes = new Map<string, PinnedCandidateRoutes>();
const pendingHandshakes = new WeakMap<Agent, Set<TLSSocket>>();
const requestSignals = new WeakMap<ClientRequest, AbortSignal>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;

function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.trim();
}

function canonicalAgentOrigin(endpoint: string | URL): string {
  const parsed = new URL(endpoint);
  const proto = parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 'https:' : parsed.protocol === 'ws:' ? 'http:' : parsed.protocol;
  return `${proto}//${parsed.host}`;
}

function poolKey(origin: string, fingerprint: string): string {
  return `${origin}|${normalizeFingerprint(fingerprint)}`;
}

function serializeRoutesKey(routes: PinnedCandidateRoutes | undefined): string {
  if (routes === undefined) return '';
  return `${routes.directEndpoints.join(',')}||${routes.relayEndpoints.join(',')}`;
}

/** Registers Happy-Eyeballs direct and relay candidate endpoints for a pinned peer origin. */
export function setPinnedCandidateRoutes(
  endpoint: string | URL,
  fingerprint: string,
  routes: PinnedCandidateRoutes | undefined,
): void {
  const origin = canonicalAgentOrigin(endpoint);
  const key = poolKey(origin, fingerprint);
  if (
    routes === undefined ||
    (routes.relayEndpoints.length === 0 && routes.directEndpoints.length <= 1)
  ) {
    if (candidateRoutes.delete(key)) {
      evictPinnedAgent(endpoint, fingerprint);
    }
    return;
  }
  const previous = candidateRoutes.get(key);
  candidateRoutes.set(key, {
    directEndpoints: [...routes.directEndpoints],
    relayEndpoints: [...routes.relayEndpoints],
  });
  if (serializeRoutesKey(previous) !== serializeRoutesKey(routes)) {
    evictPinnedAgent(endpoint, fingerprint);
  }
}

/** Clears registered candidate routes for a specific peer or all peers. */
export function clearPinnedCandidateRoutes(endpoint?: string | URL, fingerprint?: string): void {
  if (endpoint === undefined && fingerprint === undefined) {
    candidateRoutes.clear();
    return;
  }
  const targetOrigin = endpoint === undefined ? undefined : canonicalAgentOrigin(endpoint);
  const normalized = fingerprint === undefined ? undefined : normalizeFingerprint(fingerprint);
  for (const key of [...candidateRoutes.keys()]) {
    const sep = key.lastIndexOf('|');
    const entryOrigin = sep >= 0 ? key.slice(0, sep) : key;
    const entryFp = sep >= 0 ? key.slice(sep + 1) : '';
    if (targetOrigin !== undefined && entryOrigin !== targetOrigin) continue;
    if (normalized !== undefined && entryFp !== normalized) continue;
    candidateRoutes.delete(key);
  }
}

function agentHasActiveSockets(agent: Agent): boolean {
  if ((pendingHandshakes.get(agent)?.size ?? 0) > 0) return true;
  for (const sockets of Object.values(agent.sockets)) {
    if ((sockets?.length ?? 0) > 0) return true;
  }
  for (const pending of Object.values(agent.requests)) {
    if ((pending?.length ?? 0) > 0) return true;
  }
  return false;
}

function destroyPinnedAgent(agent: Agent): void {
  const handshakes = pendingHandshakes.get(agent);
  if (handshakes !== undefined) {
    const active = [...handshakes];
    handshakes.clear();
    for (const socket of active) {
      socket.destroy(new Error('TLS connection pool closed'));
    }
  }
  agent.destroy();
}

function sweepIdleAgents(now = Date.now()): void {
  for (const [key, entry] of pooledAgents) {
    if (now - entry.lastUsedAt < IDLE_AGENT_TTL_MS || agentHasActiveSockets(entry.agent)) continue;
    pooledAgents.delete(key);
    destroyPinnedAgent(entry.agent);
  }
  if (pooledAgents.size === 0 && sweepTimer !== undefined) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}

function ensureSweepTimer(): void {
  if (sweepTimer !== undefined) return;
  sweepTimer = setInterval(() => sweepIdleAgents(), 60_000);
  sweepTimer.unref();
}

type InternalAgent = Agent & {
  addRequest(req: ClientRequest, options: Record<PropertyKey, unknown>, ...rest: unknown[]): void;
  createSocket(req: ClientRequest, options: Record<PropertyKey, unknown>, cb: (err: Error | null, socket?: TLSSocket) => void): void;
};

function dialSingleDirectCandidate(
  endpointUrl: string,
  fingerprint: string | undefined,
  keepAlive: boolean,
  raceSignal: AbortSignal,
  handshakes: Set<TLSSocket>,
): Promise<{ readonly socket: TLSSocket; readonly actualFingerprint: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(endpointUrl);
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Invalid direct endpoint'));
      return;
    }
    const rawHost = parsed.hostname.replaceAll(/^\[|\]$/g, '');
    const port = Number(parsed.port || (parsed.protocol === 'http:' ? '80' : '443'));
    const socket = connect({
      host: rawHost,
      port,
      ...(isIP(rawHost) === 0 ? { servername: rawHost } : {}),
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    });
    socket.setNoDelay(true);
    if (keepAlive) socket.setKeepAlive(true, 15_000);
    handshakes.add(socket);
    let settled = false;
    const abort = () => {
      socket.destroy(raceSignal.reason instanceof Error ? raceSignal.reason : new Error('TLS handshake cancelled'));
    };
    const closed = () => fail(new Error('TLS handshake closed'));
    const cleanup = () => {
      handshakes.delete(socket);
      raceSignal.removeEventListener('abort', abort);
      socket.off('close', closed);
      socket.off('error', fail);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    socket.once('error', fail);
    socket.once('close', closed);
    raceSignal.addEventListener('abort', abort, { once: true });
    if (raceSignal.aborted) {
      abort();
      return;
    }
    socket.once('secureConnect', () => {
      if (settled || raceSignal.aborted) return;
      const certificate = socket.getPeerX509Certificate();
      const actual = certificate === undefined ? undefined : spkiFingerprint(certificate.publicKey);
      if (actual === undefined || (fingerprint !== undefined && actual !== fingerprint)) {
        fail(new AdmissionError(409, 'identity_changed'));
        return;
      }
      settled = true;
      cleanup();
      resolve({ socket, actualFingerprint: actual });
    });
  });
}

function dialSingleRelayCandidate(
  relayUrl: string,
  fingerprint: string,
  raceSignal: AbortSignal,
  handshakes: Set<TLSSocket>,
): Promise<{ readonly socket: TLSSocket; readonly actualFingerprint: string }> {
  return new Promise((resolve, reject) => {
    const safeRelayUrl = normalizeRelayEndpoint(relayUrl);
    if (safeRelayUrl === undefined) {
      reject(new AdmissionError(400, 'invalid_relay_url'));
      return;
    }
    let settled = false;
    let tlsSocket: TLSSocket | undefined;
    let duplexStream: ReturnType<typeof createWebSocketStream> | undefined;
    const ws = new WebSocket(safeRelayUrl, [RELAY_WS_SUBPROTOCOL], {
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: 10_000,
      maxPayload: 1_048_576,
    });

    const cleanupListeners = () => {
      if (tlsSocket !== undefined) handshakes.delete(tlsSocket);
      raceSignal.removeEventListener('abort', onAbort);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      tlsSocket?.destroy();
      duplexStream?.destroy();
      ws.terminate();
      reject(error);
    };

    const onAbort = () => {
      fail(raceSignal.reason instanceof Error ? raceSignal.reason : new Error('Relay TLS handshake cancelled'));
    };

    raceSignal.addEventListener('abort', onAbort, { once: true });
    if (raceSignal.aborted) {
      onAbort();
      return;
    }

    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      fail(new Error(`Relay rejected upgrade (${res.statusCode ?? 502})`));
    });
    ws.once('error', (err) => {
      fail(err instanceof Error ? err : new Error('Relay WebSocket error'));
    });
    ws.once('close', (code, reasonBuf) => {
      if (!settled) {
        const reason = reasonBuf.toString('utf8').trim();
        fail(new Error(reason || `Relay WebSocket closed (${code})`));
      }
    });

    ws.once('open', () => {
      if (settled || raceSignal.aborted) {
        ws.terminate();
        return;
      }
      const duplex = createWebSocketStream(ws, { highWaterMark: 262_144 });
      duplexStream = duplex;
      duplex.on('error', (err) => {
        if (!settled) fail(err instanceof Error ? err : new Error('Relay stream error'));
        else tlsSocket?.destroy(err instanceof Error ? err : undefined);
      });
      const socket = connect({
        socket: duplex,
        servername: 'kiki.peer',
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
      });
      tlsSocket = socket;
      handshakes.add(socket);

      const onTlsError = (err: Error) => fail(err);
      const onTlsClose = () => {
        if (!settled) fail(new Error('Relay inner TLS handshake closed'));
        duplex.destroy();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000);
        }
      };
      socket.once('error', onTlsError);
      socket.once('close', onTlsClose);

      socket.once('secureConnect', () => {
        if (settled || raceSignal.aborted) {
          socket.destroy();
          return;
        }
        const certificate = socket.getPeerX509Certificate();
        const actual = certificate === undefined ? undefined : spkiFingerprint(certificate.publicKey);
        if (actual === undefined || actual !== fingerprint) {
          fail(new AdmissionError(409, 'identity_changed'));
          return;
        }
        settled = true;
        socket.off('error', onTlsError);
        cleanupListeners();
        ws.once('close', () => {
          if (!socket.destroyed) socket.destroy();
        });
        ws.once('error', () => {
          if (!socket.destroyed) socket.destroy();
        });
        resolve({ socket, actualFingerprint: actual });
      });
    });
  });
}

function attachVerifiedConnection(
  agent: Agent,
  fingerprint: string | undefined,
  observed: ((fingerprint: string) => void) | undefined,
  signal: AbortSignal | undefined,
  keepAlive: boolean,
  explicitRoutes?: PinnedCandidateRoutes,
): void {
  const internal = agent as InternalAgent;
  const baseAddRequest = internal.addRequest.bind(internal);
  internal.addRequest = (req, options, ...rest) => {
    if (options !== null && typeof options === 'object' && REQUEST_SIGNAL in options) {
      const candidate = options[REQUEST_SIGNAL];
      delete options[REQUEST_SIGNAL];
      if (candidate instanceof AbortSignal) requestSignals.set(req, candidate);
    }
    baseAddRequest(req, options, ...rest);
  };
  const baseCreateSocket = internal.createSocket.bind(internal);
  internal.createSocket = (req, options, cb) => {
    const reqSignal = requestSignals.get(req);
    const nextOptions = reqSignal === undefined ? options : { ...options, [REQUEST_SIGNAL]: reqSignal };
    baseCreateSocket(req, nextOptions, cb);
  };
  agent.createConnection = (options, callback) => {
    const optionBag = options as Record<PropertyKey, unknown>;
    const requestSignal = optionBag[REQUEST_SIGNAL];
    delete optionBag[REQUEST_SIGNAL];
    let handshakes = pendingHandshakes.get(agent);
    if (handshakes === undefined) {
      handshakes = new Set<TLSSocket>();
      pendingHandshakes.set(agent, handshakes);
    }
    const activeHandshakes = handshakes;
    const callerSignal = requestSignal instanceof AbortSignal ? requestSignal : undefined;
    const signals: AbortSignal[] = [AbortSignal.timeout(15_000)];
    if (signal !== undefined) signals.push(signal);
    if (callerSignal !== undefined) signals.push(callerSignal);
    const deadline = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

    if (
      explicitRoutes !== undefined &&
      (explicitRoutes.relayEndpoints.length > 0 || explicitRoutes.directEndpoints.length > 1)
    ) {
      if (explicitRoutes.relayEndpoints.length > 0 && fingerprint === undefined) {
        queueMicrotask(() => callback!(new AdmissionError(409, 'connection_requires_tls'), undefined as unknown as TLSSocket));
        return undefined;
      }
      const raceController = new AbortController();
      const raceSignal = AbortSignal.any([deadline, raceController.signal]);
      const directList = [...explicitRoutes.directEndpoints];
      const relayList = [...explicitRoutes.relayEndpoints];
      const totalCandidates = directList.length + relayList.length;
      if (totalCandidates === 0) {
        queueMicrotask(() => callback!(new Error('No connection candidates configured'), undefined as unknown as TLSSocket));
        return undefined;
      }

      let won = false;
      let inFlightCount = 0;
      let completedFailures = 0;
      let nextRelayIndex = 0;
      let identityMismatchError: AdmissionError | undefined;
      let firstError: Error | undefined;
      const staggerTimers = new Set<ReturnType<typeof setTimeout>>();

      const clearTimers = () => {
        for (const t of staggerTimers) clearTimeout(t);
        staggerTimers.clear();
      };

      const onCandidateSuccess = (winner: { readonly socket: TLSSocket; readonly actualFingerprint: string }) => {
        if (won) {
          winner.socket.destroy();
          return;
        }
        won = true;
        clearTimers();
        raceController.abort(new Error('Happy-Eyeballs candidate won'));
        observed?.(winner.actualFingerprint);
        callback!(null, winner.socket);
      };

      const maybeStartNextRelayImmediately = () => {
        if (won || raceSignal.aborted) return;
        if (inFlightCount === 0 && nextRelayIndex < relayList.length) {
          clearTimers();
          launchRelayIndex(nextRelayIndex);
        }
      };

      const onCandidateFailure = (err: unknown) => {
        inFlightCount = Math.max(0, inFlightCount - 1);
        completedFailures += 1;
        const normalizedErr = err instanceof Error ? err : new Error(String(err));
        if (normalizedErr instanceof AdmissionError && normalizedErr.reason === 'identity_changed') {
          identityMismatchError ??= normalizedErr;
        } else {
          firstError ??= normalizedErr;
        }
        if (won) return;
        if (completedFailures >= totalCandidates) {
          clearTimers();
          callback!(identityMismatchError ?? firstError ?? normalizedErr, undefined as unknown as TLSSocket);
          return;
        }
        maybeStartNextRelayImmediately();
      };

      const scheduleNextRelayAfter = (delayMs: number) => {
        if (won || raceSignal.aborted || nextRelayIndex >= relayList.length) return;
        const timer = setTimeout(() => {
          staggerTimers.delete(timer);
          if (!won && !raceSignal.aborted && nextRelayIndex < relayList.length) {
            launchRelayIndex(nextRelayIndex);
          }
        }, delayMs);
        timer.unref?.();
        staggerTimers.add(timer);
      };

      const launchRelayIndex = (idx: number) => {
        if (won || raceSignal.aborted || idx !== nextRelayIndex || idx >= relayList.length) return;
        nextRelayIndex += 1;
        inFlightCount += 1;
        const relayUrl = relayList[idx]!;
        void dialSingleRelayCandidate(relayUrl, fingerprint!, raceSignal, activeHandshakes).then(
          onCandidateSuccess,
          onCandidateFailure,
        );
        if (nextRelayIndex < relayList.length) {
          scheduleNextRelayAfter(HAPPY_EYEBALLS_STAGGER_MS);
        }
      };

      for (const directUrl of directList) {
        inFlightCount += 1;
        void dialSingleDirectCandidate(directUrl, fingerprint, keepAlive, raceSignal, activeHandshakes).then(
          onCandidateSuccess,
          onCandidateFailure,
        );
      }

      if (relayList.length > 0) {
        if (directList.length === 0) {
          launchRelayIndex(0);
        } else {
          scheduleNextRelayAfter(HAPPY_EYEBALLS_STAGGER_MS);
        }
      }

      return undefined;
    }

    const socket: TLSSocket = connect({ ...options, rejectUnauthorized: false } as ConnectionOptions);
    socket.setNoDelay(true);
    if (keepAlive) socket.setKeepAlive(true, 15_000);
    activeHandshakes.add(socket);
    let settled = false;
    const abort = () => socket.destroy(deadline.reason instanceof Error ? deadline.reason : new Error('TLS handshake cancelled'));
    const closed = () => fail(new Error('TLS handshake closed'));
    const cleanup = () => {
      activeHandshakes.delete(socket);
      deadline.removeEventListener('abort', abort);
      socket.off('close', closed);
      socket.off('error', fail);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback!(error, socket);
    };
    socket.once('error', fail);
    socket.once('close', closed);
    deadline.addEventListener('abort', abort, { once: true });
    if (deadline.aborted) abort();
    socket.once('secureConnect', () => {
      if (settled || deadline.aborted) return;
      const certificate = socket.getPeerX509Certificate();
      const actual = certificate === undefined ? undefined : spkiFingerprint(certificate.publicKey);
      if (actual === undefined || (fingerprint !== undefined && actual !== fingerprint)) {
        socket.destroy(new AdmissionError(409, 'identity_changed'));
        return;
      }
      settled = true;
      cleanup();
      observed?.(actual);
      callback!(null, socket);
    });
    return undefined;
  };
}

export function requirePinnedTls(endpoint: string | URL, fingerprint?: string): void {
  if (fingerprint !== undefined && !['https:', 'wss:'].includes(new URL(endpoint).protocol)) throw new AdmissionError(409, 'connection_requires_tls');
}

export function pinnedAgent(
  fingerprint?: string,
  observed?: (fingerprint: string) => void,
  signal?: AbortSignal,
  candidates?: PinnedCandidateRoutes,
): Agent {
  const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
  attachVerifiedConnection(agent, fingerprint, observed, signal, false, candidates);
  return agent;
}

export function pooledPinnedAgent(
  endpoint: string | URL,
  fingerprint: string,
  candidates?: PinnedCandidateRoutes,
): Agent {
  requirePinnedTls(endpoint, fingerprint);
  const origin = canonicalAgentOrigin(endpoint);
  const normalized = normalizeFingerprint(fingerprint);
  const key = poolKey(origin, normalized);
  const resolvedCandidates = candidates ?? candidateRoutes.get(key);
  const routesKey = serializeRoutesKey(resolvedCandidates);
  const now = Date.now();
  const existing = pooledAgents.get(key);
  if (existing !== undefined && existing.routesKey === routesKey) {
    existing.lastUsedAt = now;
    return existing.agent;
  }
  if (existing !== undefined) {
    pooledAgents.delete(key);
    destroyPinnedAgent(existing.agent);
  }
  sweepIdleAgents(now);
  if (pooledAgents.size >= MAX_POOLED_AGENTS) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [candidateKey, candidate] of pooledAgents) {
      if (agentHasActiveSockets(candidate.agent)) continue;
      if (candidate.lastUsedAt < oldestAt) {
        oldestAt = candidate.lastUsedAt;
        oldestKey = candidateKey;
      }
    }
    if (oldestKey !== undefined) {
      const evicted = pooledAgents.get(oldestKey);
      pooledAgents.delete(oldestKey);
      if (evicted !== undefined) destroyPinnedAgent(evicted.agent);
    }
  }
  const agent = new Agent({
    keepAlive: true,
    keepAliveMsecs: 15_000,
    maxSockets: 16,
    maxFreeSockets: 4,
    maxCachedSessions: 16,
    timeout: 45_000,
  });
  attachVerifiedConnection(agent, normalized, undefined, undefined, true, resolvedCandidates);
  pooledAgents.set(key, { agent, origin, fingerprint: normalized, routesKey, lastUsedAt: now });
  ensureSweepTimer();
  return agent;
}

export function evictPinnedAgent(endpoint?: string | URL, fingerprint?: string): void {
  if (endpoint === undefined && fingerprint === undefined) {
    closePinnedAgents();
    return;
  }
  let targetOrigin: string | undefined;
  if (endpoint !== undefined) {
    try {
      const parsed = new URL(endpoint);
      if (['https:', 'wss:'].includes(parsed.protocol)) {
        targetOrigin = `https://${parsed.host}`;
      } else {
        return;
      }
    } catch {
      return;
    }
  }
  const normalized = fingerprint === undefined ? undefined : normalizeFingerprint(fingerprint);
  for (const [key, entry] of pooledAgents) {
    if (targetOrigin !== undefined && entry.origin !== targetOrigin) continue;
    if (normalized !== undefined && entry.fingerprint !== normalized) continue;
    pooledAgents.delete(key);
    destroyPinnedAgent(entry.agent);
  }
}

export function closePinnedAgents(): void {
  if (sweepTimer !== undefined) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
  for (const [key, entry] of pooledAgents) {
    pooledAgents.delete(key);
    destroyPinnedAgent(entry.agent);
  }
}

export function isRetryableTransportError(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof AdmissionError) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  const code = (error as NodeJS.ErrnoException).code ?? (error.cause instanceof Error ? (error.cause as NodeJS.ErrnoException).code : undefined);
  if (code !== undefined && ['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'ERR_SOCKET_CLOSED'].includes(code)) {
    return true;
  }
  return /socket hang up|TLS handshake closed|network socket disconnected|other side closed/i.test(error.message);
}

export interface PeerFetchInit extends RequestInit {
  readonly idempotentRetry?: boolean;
  readonly candidates?: PinnedCandidateRoutes;
}

export function isIdempotentHttpMethod(method: string | undefined): boolean {
  const normalized = (method ?? 'GET').trim().toUpperCase();
  return normalized === 'GET' || normalized === 'HEAD';
}

function isReplayableBody(body: RequestInit['body']): boolean {
  return body === undefined || body === null || typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array;
}

function dispatchPinnedRequest(url: string | URL, init: PeerFetchInit, agent: Agent): Promise<{ response: Response } | { retryableReusedError: Error }> {
  return new Promise((resolve, reject) => {
    const callerSignal = init.signal ?? undefined;
    if (callerSignal?.aborted) {
      reject(callerSignal.reason instanceof Error ? callerSignal.reason : new Error('Request aborted'));
      return;
    }
    let responded = false;
    let settled = false;
    const handshakeController = callerSignal === undefined ? undefined : new AbortController();
    const finish = (outcome: { response: Response } | { retryableReusedError: Error } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      callerSignal?.removeEventListener('abort', onCallerAbort);
      if ('error' in outcome) reject(outcome.error);
      else resolve(outcome);
    };
    const req = request(
      url,
      {
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        agent,
        [REQUEST_SIGNAL]: handshakeController?.signal,
      } as Parameters<typeof request>[1],
      (res) => {
        responded = true;
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
        }
        finish({
          response: new Response(
            [204, 205, 304].includes(res.statusCode!) || init.method === 'HEAD' ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
            { status: res.statusCode, statusText: res.statusMessage, headers },
          ),
        });
      },
    );
    const onCallerAbort = () => {
      const reason = callerSignal?.reason instanceof Error ? callerSignal.reason : new Error('Request aborted');
      handshakeController?.abort(reason);
      req.destroy(reason);
      finish({ error: reason });
    };
    req.on('error', (error) => {
      if (callerSignal?.aborted) {
        finish({ error: callerSignal.reason instanceof Error ? callerSignal.reason : error });
        return;
      }
      if (!responded && req.reusedSocket && (init.idempotentRetry === true || isIdempotentHttpMethod(init.method)) && isReplayableBody(init.body) && isRetryableTransportError(error)) {
        finish({ retryableReusedError: error });
        return;
      }
      finish({ error });
    });
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    if (init.body === undefined || init.body === null) req.end();
    else if (typeof init.body === 'string' || Buffer.isBuffer(init.body) || init.body instanceof Uint8Array) req.end(init.body);
    else {
      const body = init.body instanceof Readable ? init.body : Readable.from(init.body as AsyncIterable<Uint8Array>);
      body.once('error', (error) => req.destroy(error));
      req.once('close', () => body.destroy());
      body.pipe(req);
    }
  });
}

export async function peerFetch(url: string | URL, init: PeerFetchInit = {}, fingerprint?: string, observed?: (fingerprint: string) => void): Promise<Response> {
  requirePinnedTls(url, fingerprint);
  const { idempotentRetry: _idempotentRetry, candidates, ...requestInit } = init;
  if (fingerprint === undefined && observed === undefined && candidates === undefined) return fetch(url, { ...requestInit, redirect: 'error' });
  const usePool = fingerprint !== undefined && observed === undefined && candidates === undefined;
  const agent = usePool ? pooledPinnedAgent(url, fingerprint) : pinnedAgent(fingerprint, observed, requestInit.signal ?? undefined, candidates);
  const first = await dispatchPinnedRequest(url, init, agent);
  if ('response' in first) return first.response;
  evictPinnedAgent(url, fingerprint);
  const retryAgent = usePool ? pooledPinnedAgent(url, fingerprint) : pinnedAgent(fingerprint, observed, requestInit.signal ?? undefined, candidates);
  const second = await dispatchPinnedRequest(url, init, retryAgent);
  if ('response' in second) return second.response;
  throw second.retryableReusedError;
}

export function isLegacyTlsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return ['ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG', 'ERR_SSL_RECORD_LAYER_FAILURE'].includes(code ?? '')
    || code === 'EPROTO' && /wrong version number|packet length too long|record layer failure|unknown protocol/i.test(error.message);
}
