import { Agent, request } from 'node:https';
import { connect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import { Readable } from 'node:stream';
import { AdmissionError } from './admission';
import { spkiFingerprint } from './tlsIdentity';

const IDLE_AGENT_TTL_MS = 120_000;
const MAX_POOLED_AGENTS = 64;

interface PooledAgentEntry {
  agent: Agent;
  origin: string;
  fingerprint: string;
  lastUsedAt: number;
}

const pooledAgents = new Map<string, PooledAgentEntry>();
const pendingHandshakes = new WeakMap<Agent, Set<TLSSocket>>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;

function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.trim();
}

function poolKey(origin: string, fingerprint: string): string {
  return `${origin}|${normalizeFingerprint(fingerprint)}`;
}

function agentHasActiveSockets(agent: Agent): boolean {
  for (const sockets of Object.values(agent.sockets)) {
    if ((sockets?.length ?? 0) > 0) return true;
  }
  for (const pending of Object.values(agent.requests)) {
    if ((pending?.length ?? 0) > 0) return true;
  }
  return false;
}

function sweepIdleAgents(now = Date.now()): void {
  for (const [key, entry] of pooledAgents) {
    if (now - entry.lastUsedAt < IDLE_AGENT_TTL_MS || agentHasActiveSockets(entry.agent)) continue;
    pooledAgents.delete(key);
    entry.agent.destroy();
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

function attachVerifiedConnection(
  agent: Agent,
  fingerprint: string | undefined,
  observed: ((fingerprint: string) => void) | undefined,
  signal: AbortSignal | undefined,
  keepAlive: boolean,
): void {
  agent.createConnection = (options, callback) => {
    const socket: TLSSocket = connect({ ...options, rejectUnauthorized: false } as ConnectionOptions);
    socket.setNoDelay(true);
    if (keepAlive) socket.setKeepAlive(true, 15_000);
    let handshakes = pendingHandshakes.get(agent);
    if (handshakes === undefined) {
      handshakes = new Set<TLSSocket>();
      pendingHandshakes.set(agent, handshakes);
    }
    handshakes.add(socket);
    const deadline = signal === undefined ? AbortSignal.timeout(15_000) : AbortSignal.any([AbortSignal.timeout(15_000), signal]);
    const abort = () => socket.destroy(deadline.reason instanceof Error ? deadline.reason : new Error('TLS handshake cancelled'));
    const closed = () => fail(new Error('TLS handshake closed'));
    const cleanup = () => {
      handshakes?.delete(socket);
      deadline.removeEventListener('abort', abort);
      socket.off('close', closed);
    };
    const fail = (error: Error): void => {
      cleanup();
      callback!(error, socket);
    };
    socket.once('error', fail);
    socket.once('close', closed);
    deadline.addEventListener('abort', abort, { once: true });
    if (deadline.aborted) abort();
    socket.once('secureConnect', () => {
      if (deadline.aborted) return;
      const certificate = socket.getPeerX509Certificate();
      const actual = certificate === undefined ? undefined : spkiFingerprint(certificate.publicKey);
      if (actual === undefined || (fingerprint !== undefined && actual !== fingerprint)) {
        socket.destroy(new AdmissionError(409, 'identity_changed'));
        return;
      }
      cleanup();
      socket.off('error', fail);
      observed?.(actual);
      callback!(null, socket);
    });
    return undefined;
  };
}

export function requirePinnedTls(endpoint: string | URL, fingerprint?: string): void {
  if (fingerprint !== undefined && !['https:', 'wss:'].includes(new URL(endpoint).protocol)) throw new AdmissionError(409, 'connection_requires_tls');
}

export function pinnedAgent(fingerprint?: string, observed?: (fingerprint: string) => void, signal?: AbortSignal): Agent {
  const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
  attachVerifiedConnection(agent, fingerprint, observed, signal, false);
  return agent;
}

export function pooledPinnedAgent(endpoint: string | URL, fingerprint: string): Agent {
  requirePinnedTls(endpoint, fingerprint);
  const parsed = new URL(endpoint);
  const origin = `${parsed.protocol === 'wss:' ? 'https:' : parsed.protocol}//${parsed.host}`;
  const normalized = normalizeFingerprint(fingerprint);
  const key = poolKey(origin, normalized);
  const now = Date.now();
  const existing = pooledAgents.get(key);
  if (existing !== undefined) {
    existing.lastUsedAt = now;
    return existing.agent;
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
      evicted?.agent.destroy();
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
  attachVerifiedConnection(agent, normalized, undefined, undefined, true);
  pooledAgents.set(key, { agent, origin, fingerprint: normalized, lastUsedAt: now });
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
    entry.agent.destroy();
  }
}

export function closePinnedAgents(): void {
  if (sweepTimer !== undefined) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
  for (const [key, entry] of pooledAgents) {
    pooledAgents.delete(key);
    entry.agent.destroy();
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

function isReplayableBody(body: RequestInit['body']): boolean {
  return body === undefined || body === null || typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array;
}

function dispatchPinnedRequest(url: string | URL, init: RequestInit, agent: Agent): Promise<{ response: Response } | { retryableReusedError: Error }> {
  return new Promise((resolve, reject) => {
    const callerSignal = init.signal ?? undefined;
    if (callerSignal?.aborted) {
      reject(callerSignal.reason instanceof Error ? callerSignal.reason : new Error('Request aborted'));
      return;
    }
    let responded = false;
    let settled = false;
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
      },
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
      const hadAssignedSocket = req.socket !== null && req.socket !== undefined;
      req.destroy(reason);
      if (!hadAssignedSocket) {
        const handshakes = pendingHandshakes.get(agent);
        if (handshakes !== undefined && handshakes.size > 0) {
          const iter = handshakes.values().next();
          if (!iter.done) {
            handshakes.delete(iter.value);
            iter.value.destroy(reason);
          }
        }
      }
      finish({ error: reason });
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    req.once('error', (error) => {
      if (callerSignal?.aborted) {
        finish({ error: callerSignal.reason instanceof Error ? callerSignal.reason : error });
        return;
      }
      if (!responded && req.reusedSocket && isReplayableBody(init.body) && isRetryableTransportError(error)) {
        finish({ retryableReusedError: error });
        return;
      }
      finish({ error });
    });
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

export async function peerFetch(url: string | URL, init: RequestInit = {}, fingerprint?: string, observed?: (fingerprint: string) => void): Promise<Response> {
  requirePinnedTls(url, fingerprint);
  if (fingerprint === undefined && observed === undefined) return fetch(url, { ...init, redirect: 'error' });
  const usePool = fingerprint !== undefined && observed === undefined;
  const agent = usePool ? pooledPinnedAgent(url, fingerprint) : pinnedAgent(fingerprint, observed, init.signal ?? undefined);
  const first = await dispatchPinnedRequest(url, init, agent);
  if ('response' in first) return first.response;
  evictPinnedAgent(url, fingerprint);
  const retryAgent = usePool ? pooledPinnedAgent(url, fingerprint) : pinnedAgent(fingerprint, observed, init.signal ?? undefined);
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
