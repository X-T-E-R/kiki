#!/usr/bin/env node
import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const wsModule = await import(new URL('../vendor/ws/wrapper.mjs', import.meta.url).href).catch(() =>
  import('ws'),
);
const { WebSocket, WebSocketServer } = wsModule;

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_WS_SUBPROTOCOL = 'kiki-relay-v1';

const CHALLENGE_WINDOW_MS = 120_000;
const REGISTER_TIMEOUT_MS = 10_000;
const OPEN_POOL_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const NONCE_REPLAY_TTL_MS = 60_000;
const MAX_NONCE_CACHE = 4096;
const CONTROL_MAX_PAYLOAD = 65_536;
const STREAM_MAX_PAYLOAD = 16 * 1024 * 1024;
const BACKPRESSURE_HIGH_WATER = 1024 * 1024;
const BACKPRESSURE_LOW_WATER = 256 * 1024;

function normalizeBasePath(raw) {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '' || trimmed === '/') return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

export function canonicalOriginPath(rawUrl) {
  const parsed = new URL(rawUrl);
  const defaultPort =
    ((parsed.protocol === 'wss:' || parsed.protocol === 'https:') && parsed.port === '443') ||
    ((parsed.protocol === 'ws:' || parsed.protocol === 'http:') && parsed.port === '80');
  const host = defaultPort ? parsed.hostname.toLowerCase() : parsed.host.toLowerCase();
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${host}${pathname}`;
}

export function formatShareUri({ publicUrl, label, token, role }) {
  const parsed = new URL(publicUrl);
  const insecure = parsed.protocol === 'ws:' || parsed.protocol === 'http:';
  const defaultPort =
    ((parsed.protocol === 'wss:' || parsed.protocol === 'https:') && parsed.port === '443') ||
    ((parsed.protocol === 'ws:' || parsed.protocol === 'http:') && parsed.port === '80');
  const host = defaultPort ? parsed.hostname.toLowerCase() : parsed.host.toLowerCase();
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (label && String(label).trim() !== '') params.set('name', String(label).trim());
  if (token && String(token).trim() !== '') params.set('token', String(token).trim());
  if (role === 'backup-only') params.set('role', 'backup-only');
  if (insecure) params.set('insecure', '1');
  const query = params.toString();
  return `kiki-relay://${host}${pathname}${query ? `?${query}` : ''}`;
}

export function deriveCapKey(serverSecretBuf, fp) {
  return createHmac('sha256', serverSecretBuf)
    .update(`kiki-relay-cap-v1:${fp}`, 'utf8')
    .digest('hex');
}

function verifyBearerToken(headerValue, expectedToken) {
  if (!expectedToken) return true;
  if (typeof headerValue !== 'string') return false;
  const match = /^Bearer\s+(\S+)$/i.exec(headerValue.trim());
  if (!match) return false;
  const actualDigest = createHash('sha256').update(match[1], 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expectedToken, 'utf8').digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export function verifyStreamTicket(capKeyHex, fp, ticket, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof ticket !== 'string') return false;
  const parts = ticket.split('.');
  if (parts.length !== 3) return false;
  const [kind, idOrExp, macHex] = parts;
  if (!macHex || !/^[a-f0-9]{64}$/i.test(macHex)) return false;
  let expectedHex;
  if (kind === 'p') {
    if (!idOrExp || !/^\d{1,12}$/.test(idOrExp)) return false;
    const expSec = Number(idOrExp);
    if (!Number.isSafeInteger(expSec) || expSec < nowSec || expSec > nowSec + 86_400) return false;
    expectedHex = createHmac('sha256', Buffer.from(capKeyHex, 'hex'))
      .update(`pair:${fp}:${expSec}`, 'utf8')
      .digest('hex');
  } else if (kind === 'g') {
    if (!idOrExp || !/^[A-Za-z0-9_-]{1,64}$/.test(idOrExp)) return false;
    expectedHex = createHmac('sha256', Buffer.from(capKeyHex, 'hex'))
      .update(`grant:${fp}:${idOrExp}`, 'utf8')
      .digest('hex');
  } else {
    return false;
  }
  return timingSafeEqual(Buffer.from(macHex.toLowerCase(), 'hex'), Buffer.from(expectedHex, 'hex'));
}

function verifyPoolToken(capKeyHex, fp, nonce, ticket, poolToken) {
  if (!/^[a-f0-9]{64}$/i.test(poolToken)) return false;
  const expectedHex = createHmac('sha256', Buffer.from(capKeyHex, 'hex'))
    .update(`pool:${fp}:${nonce}:${ticket ?? ''}`, 'utf8')
    .digest('hex');
  return timingSafeEqual(Buffer.from(poolToken.toLowerCase(), 'hex'), Buffer.from(expectedHex, 'hex'));
}

function rawToBuffer(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function clientIpFromRequest(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function rejectHttpUpgrade(socket, statusCode, message) {
  const reason =
    statusCode === 401 ? 'Unauthorized'
      : statusCode === 403 ? 'Forbidden'
        : statusCode === 404 ? 'Not Found'
          : statusCode === 429 ? 'Too Many Requests'
            : statusCode === 502 ? 'Bad Gateway'
              : 'Bad Request';
  const body = JSON.stringify({ ok: false, error: message });
  if (socket.writable) {
    socket.end(
      `HTTP/1.1 ${statusCode} ${reason}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
    );
  } else {
    socket.destroy();
  }
}

function bridgeRelaySockets(clientWs, hostPoolWs, onDone) {
  let closed = false;

  const checkDrainTimer = setInterval(() => {
    if (clientWs.isPaused && hostPoolWs.readyState === WebSocket.OPEN && hostPoolWs.bufferedAmount <= BACKPRESSURE_LOW_WATER) {
      clientWs.resume();
    }
    if (hostPoolWs.isPaused && clientWs.readyState === WebSocket.OPEN && clientWs.bufferedAmount <= BACKPRESSURE_LOW_WATER) {
      hostPoolWs.resume();
    }
  }, 15);
  checkDrainTimer.unref?.();

  const teardown = (closeCode = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    clearInterval(checkDrainTimer);
    if (clientWs.isPaused) clientWs.resume();
    if (hostPoolWs.isPaused) hostPoolWs.resume();
    try {
      if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
        clientWs.close(closeCode, reason);
      }
    } catch {
      clientWs.terminate();
    }
    try {
      if (hostPoolWs.readyState === WebSocket.OPEN || hostPoolWs.readyState === WebSocket.CONNECTING) {
        hostPoolWs.close(closeCode, reason);
      }
    } catch {
      hostPoolWs.terminate();
    }
    onDone?.();
  };

  clientWs.on('message', (data, isBinary) => {
    if (closed) return;
    if (!isBinary) {
      teardown(1003, 'binary required');
      return;
    }
    if (hostPoolWs.readyState !== WebSocket.OPEN) {
      teardown(1001, 'host closed');
      return;
    }
    hostPoolWs.send(data, { binary: true, compress: false }, (err) => {
      if (err) {
        teardown(1011, 'forward error');
        return;
      }
      if (!closed && clientWs.isPaused && hostPoolWs.bufferedAmount <= BACKPRESSURE_LOW_WATER) {
        clientWs.resume();
      }
    });
    if (!clientWs.isPaused && hostPoolWs.bufferedAmount >= BACKPRESSURE_HIGH_WATER) {
      clientWs.pause();
    }
  });

  hostPoolWs.on('message', (data, isBinary) => {
    if (closed) return;
    if (!isBinary) {
      teardown(1003, 'binary required');
      return;
    }
    if (clientWs.readyState !== WebSocket.OPEN) {
      teardown(1001, 'client closed');
      return;
    }
    clientWs.send(data, { binary: true, compress: false }, (err) => {
      if (err) {
        teardown(1011, 'forward error');
        return;
      }
      if (!closed && hostPoolWs.isPaused && clientWs.bufferedAmount <= BACKPRESSURE_LOW_WATER) {
        hostPoolWs.resume();
      }
    });
    if (!hostPoolWs.isPaused && clientWs.bufferedAmount >= BACKPRESSURE_HIGH_WATER) {
      hostPoolWs.pause();
    }
  });

  clientWs.once('close', () => teardown(1000));
  hostPoolWs.once('close', () => teardown(1000));
  clientWs.once('error', () => teardown(1011));
  hostPoolWs.once('error', () => teardown(1011));

  if (clientWs.isPaused) clientWs.resume();
  if (hostPoolWs.isPaused) hostPoolWs.resume();
}

export async function startKikiRelayServer(options = {}) {
  const host = options.host ?? process.env.RELAY_HOST ?? '0.0.0.0';
  const requestedPort = Number(options.port ?? process.env.RELAY_PORT ?? 9440);
  const publicUrlRaw = options.publicUrl ?? process.env.RELAY_PUBLIC_URL ?? '';
  const inferredPath = publicUrlRaw ? (() => {
    try { return normalizeBasePath(new URL(publicUrlRaw).pathname); } catch { return ''; }
  })() : '';
  const basePath = normalizeBasePath(options.basePath ?? process.env.RELAY_BASE_PATH ?? inferredPath);
  const hostToken = (options.hostToken ?? process.env.RELAY_HOST_TOKEN ?? '').trim() || undefined;
  const label = (options.label ?? process.env.RELAY_NAME ?? '').trim() || undefined;
  const verifyUrl = (options.verifyUrl ?? process.env.RELAY_VERIFY_URL ?? '').trim() || undefined;
  const trustProxy = Boolean(options.trustProxy ?? (process.env.RELAY_TRUST_PROXY === '1' || process.env.RELAY_TRUST_PROXY === 'true'));
  const requireTicketRaw = options.requireTicket ?? process.env.RELAY_REQUIRE_TICKET;
  const requireTicket = requireTicketRaw === undefined
    ? true
    : (requireTicketRaw !== false && requireTicketRaw !== '0' && String(requireTicketRaw).toLowerCase() !== 'false');
  const maxWarmPool = Number(options.maxWarmPool ?? 8);
  const maxStreamsPerIp = Number(options.maxStreamsPerIp ?? 32);
  const rateLimitPerMinute = Number(options.rateLimitPerMinute ?? 120);
  let probeDelayMs = Math.max(0, Number(options.probeDelayMs ?? 0) || 0);

  const rawSecret = (options.secret ?? process.env.RELAY_SECRET ?? '').trim();
  const serverSecret = rawSecret
    ? createHash('sha256').update(rawSecret, 'utf8').digest()
    : randomBytes(32);

  const configuredOriginPath = publicUrlRaw ? (() => {
    try { return canonicalOriginPath(publicUrlRaw); } catch { return undefined; }
  })() : undefined;

  const hosts = new Map();
  const usedNonces = new Map();
  const ipStreams = new Map();
  const ipRateBuckets = new Map();

  const pruneNonces = (now) => {
    if (usedNonces.size === 0) return;
    for (const [key, exp] of usedNonces) {
      if (exp <= now) usedNonces.delete(key);
    }
    while (usedNonces.size > MAX_NONCE_CACHE) {
      const oldest = usedNonces.keys().next().value;
      if (oldest === undefined) break;
      usedNonces.delete(oldest);
    }
  };

  const checkIpAdmission = (ip) => {
    const active = ipStreams.get(ip) ?? 0;
    if (active >= maxStreamsPerIp) return false;
    const now = Date.now();
    let bucket = ipRateBuckets.get(ip);
    if (!bucket || now - bucket.windowStart >= 60_000) {
      bucket = { windowStart: now, count: 0 };
      ipRateBuckets.set(ip, bucket);
    }
    if (bucket.count >= rateLimitPerMinute) return false;
    bucket.count += 1;
    return true;
  };

  const matchRouteSuffix = (pathname) => {
    if (basePath !== '' && pathname.startsWith(`${basePath}/v1/`)) {
      return { suffix: pathname.slice(basePath.length), prefix: basePath };
    }
    if (pathname.startsWith('/v1/')) {
      return { suffix: pathname, prefix: '' };
    }
    return undefined;
  };

  const resolveAllowedOriginPaths = (req, prefix) => {
    const set = new Set();
    if (configuredOriginPath) set.add(configuredOriginPath);
    const reqHost = String(req.headers.host ?? '').trim().toLowerCase();
    if (reqHost) {
      const strippedHost = reqHost.replace(/:(80|443)$/, '');
      const effectivePrefix = prefix || basePath;
      set.add(`${strippedHost}${effectivePrefix}`);
      if (prefix !== basePath) set.add(`${strippedHost}${prefix}`);
    }
    if (trustProxy && typeof req.headers['x-forwarded-host'] === 'string') {
      const fwdHost = req.headers['x-forwarded-host'].split(',')[0].trim().toLowerCase().replace(/:(80|443)$/, '');
      if (fwdHost) {
        set.add(`${fwdHost}${prefix || basePath}`);
        if (prefix !== basePath) set.add(`${fwdHost}${prefix}`);
      }
    }
    return [...set];
  };

  const controlWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: CONTROL_MAX_PAYLOAD,
    handleProtocols: (protocols) => (protocols.has(RELAY_WS_SUBPROTOCOL) ? RELAY_WS_SUBPROTOCOL : false),
  });

  const poolWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: STREAM_MAX_PAYLOAD,
    handleProtocols: (protocols) => (protocols.has(RELAY_WS_SUBPROTOCOL) ? RELAY_WS_SUBPROTOCOL : false),
  });

  const streamWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: STREAM_MAX_PAYLOAD,
    handleProtocols: (protocols) => (protocols.has(RELAY_WS_SUBPROTOCOL) ? RELAY_WS_SUBPROTOCOL : ''),
  });

  const popHealthyIdleSocket = (entry) => {
    while (entry.idlePool.length > 0) {
      const candidate = entry.idlePool.shift();
      if (candidate.ws.readyState === WebSocket.OPEN) {
        clearInterval(candidate.pingTimer);
        return candidate.ws;
      }
    }
    return undefined;
  };

  const handoffPoolToClient = (entry, clientWs, hostPoolWs, onFinished) => {
    try {
      hostPoolWs.send(JSON.stringify({ type: 'activate' }), { binary: false, compress: false });
    } catch {
      clientWs.close(1011, 'pool activate failed');
      hostPoolWs.terminate();
      onFinished();
      return;
    }
    bridgeRelaySockets(clientWs, hostPoolWs, onFinished);
  };

  const closeHostEntry = (fp, entry, reason = 'host disconnected') => {
    if (hosts.get(fp) === entry) {
      hosts.delete(fp);
    }
    clearInterval(entry.pingTimer);
    for (const item of entry.idlePool.splice(0)) {
      clearInterval(item.pingTimer);
      item.ws.terminate();
    }
    for (const [, waiter] of entry.pendingTickets) {
      clearTimeout(waiter.timer);
      waiter.reject();
    }
    entry.pendingTickets.clear();
    for (const waiter of entry.fifoWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject();
    }
    try {
      if (entry.controlWs.readyState === WebSocket.OPEN) {
        entry.controlWs.close(1000, reason);
      } else {
        entry.controlWs.terminate();
      }
    } catch {
      entry.controlWs.terminate();
    }
  };

  controlWss.on('connection', (ws, req, allowedOriginPaths) => {
    const nonce = randomBytes(16).toString('hex');
    const challengeTs = Date.now();
    let registeredFp = null;

    const regTimer = setTimeout(() => {
      if (!registeredFp) ws.close(1008, 'register timeout');
    }, REGISTER_TIMEOUT_MS);
    regTimer.unref?.();

    ws.send(JSON.stringify({ type: 'challenge', nonce, ts: challengeTs }));

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        ws.close(1003, 'text required on control');
        return;
      }
      let msg;
      try {
        msg = JSON.parse(rawToBuffer(raw).toString('utf8'));
      } catch {
        ws.close(1008, 'invalid json');
        return;
      }

      if (!registeredFp) {
        if (msg?.type !== 'register' || typeof msg.spkiDer !== 'string' || typeof msg.signature !== 'string') {
          ws.close(1008, 'expected register');
          return;
        }
        if (Math.abs(Date.now() - challengeTs) > CHALLENGE_WINDOW_MS) {
          ws.close(1008, 'challenge expired');
          return;
        }
        let publicKey;
        let canonicalSpki;
        try {
          const spkiBuf = Buffer.from(msg.spkiDer, 'base64');
          publicKey = createPublicKey({ key: spkiBuf, format: 'der', type: 'spki' });
          if (publicKey.asymmetricKeyType !== 'ec') {
            ws.close(1008, 'ec key required');
            return;
          }
          canonicalSpki = publicKey.export({ type: 'spki', format: 'der' });
          if (!canonicalSpki.equals(spkiBuf)) {
            ws.close(1008, 'non-canonical spki');
            return;
          }
        } catch {
          ws.close(1008, 'invalid spki');
          return;
        }

        const fp = createHash('sha256').update(canonicalSpki).digest('hex');
        const sigBuf = Buffer.from(msg.signature, 'base64');
        const verified = allowedOriginPaths.some((originPath) => {
          const preimage = Buffer.from(`kiki-relay-host-v1:${originPath}:${fp}:${nonce}:${challengeTs}`, 'utf8');
          try {
            return verify('sha256', preimage, publicKey, sigBuf);
          } catch {
            return false;
          }
        });

        if (!verified) {
          ws.close(1008, 'invalid challenge signature');
          return;
        }

        clearTimeout(regTimer);
        registeredFp = fp;
        const capKey = deriveCapKey(serverSecret, fp);

        const existing = hosts.get(fp);
        if (existing) {
          closeHostEntry(fp, existing, 'superseded');
        }

        let awaitingPong = false;
        const pingTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (awaitingPong) {
            ws.terminate();
            return;
          }
          awaitingPong = true;
          try { ws.ping(); } catch { ws.terminate(); }
        }, HEARTBEAT_INTERVAL_MS);
        pingTimer.unref?.();

        ws.on('pong', () => { awaitingPong = false; });

        const entry = {
          fp,
          capKey,
          controlWs: ws,
          pingTimer,
          idlePool: [],
          pendingTickets: new Map(),
          fifoWaiters: [],
        };
        hosts.set(fp, entry);

        ws.once('close', () => {
          clearTimeout(regTimer);
          closeHostEntry(fp, entry);
        });
        ws.once('error', () => {
          clearTimeout(regTimer);
          closeHostEntry(fp, entry);
        });

        ws.send(JSON.stringify({ type: 'registered', fp, capKey }));
        return;
      }

      if (msg?.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: typeof msg.ts === 'number' ? msg.ts : Date.now() }));
      }
    });

    ws.once('close', () => clearTimeout(regTimer));
    ws.once('error', () => clearTimeout(regTimer));
  });

  poolWss.on('connection', (poolWs, _req, fp, ticket) => {
    const entry = hosts.get(fp);
    if (!entry) {
      poolWs.close(1008, 'host not registered');
      return;
    }

    if (ticket && entry.pendingTickets.has(ticket)) {
      const waiter = entry.pendingTickets.get(ticket);
      entry.pendingTickets.delete(ticket);
      clearTimeout(waiter.timer);
      waiter.resolve(poolWs);
      return;
    }

    if (entry.fifoWaiters.length > 0) {
      const waiter = entry.fifoWaiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(poolWs);
      return;
    }

    while (entry.idlePool.length >= maxWarmPool) {
      const dropped = entry.idlePool.shift();
      if (dropped) {
        clearInterval(dropped.pingTimer);
        dropped.ws.close(1000, 'pool full');
      }
    }

    let alive = true;
    const pingTimer = setInterval(() => {
      if (poolWs.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        poolWs.terminate();
        return;
      }
      alive = false;
      try { poolWs.ping(); } catch { poolWs.terminate(); }
    }, HEARTBEAT_INTERVAL_MS);
    pingTimer.unref?.();

    poolWs.on('pong', () => { alive = true; });

    const record = { ws: poolWs, pingTimer };
    entry.idlePool.push(record);

    const removeIdle = () => {
      clearInterval(pingTimer);
      const idx = entry.idlePool.indexOf(record);
      if (idx !== -1) entry.idlePool.splice(idx, 1);
    };
    poolWs.once('close', removeIdle);
    poolWs.once('error', removeIdle);
  });

  streamWss.on('connection', (clientWs, _req, targetFp, clientIp) => {
    ipStreams.set(clientIp, (ipStreams.get(clientIp) ?? 0) + 1);
    let releasedIp = false;
    const releaseIpSlot = () => {
      if (releasedIp) return;
      releasedIp = true;
      const next = (ipStreams.get(clientIp) ?? 1) - 1;
      if (next <= 0) ipStreams.delete(clientIp);
      else ipStreams.set(clientIp, next);
    };
    clientWs.once('close', releaseIpSlot);
    clientWs.once('error', releaseIpSlot);

    const entry = hosts.get(targetFp);
    if (!entry || entry.controlWs.readyState !== WebSocket.OPEN) {
      clientWs.close(1013, 'host offline');
      releaseIpSlot();
      return;
    }

    const warmWs = popHealthyIdleSocket(entry);
    if (warmWs) {
      try {
        entry.controlWs.send(JSON.stringify({ type: 'replenish', need: 1 }));
      } catch {
        // Control socket errors are handled by controlWs lifecycle.
      }
      handoffPoolToClient(entry, clientWs, warmWs, releaseIpSlot);
      return;
    }

    clientWs.pause();
    const openTicket = randomBytes(16).toString('hex');
    let settled = false;
    const waiter = {
      timer: setTimeout(() => {
        if (settled) return;
        settled = true;
        entry.pendingTickets.delete(openTicket);
        const idx = entry.fifoWaiters.indexOf(waiter);
        if (idx !== -1) entry.fifoWaiters.splice(idx, 1);
        clientWs.close(1013, 'relay pool timeout');
        releaseIpSlot();
      }, OPEN_POOL_TIMEOUT_MS),
      resolve: (poolWs) => {
        if (settled) {
          poolWs.terminate();
          return;
        }
        settled = true;
        entry.pendingTickets.delete(openTicket);
        const idx = entry.fifoWaiters.indexOf(waiter);
        if (idx !== -1) entry.fifoWaiters.splice(idx, 1);
        if (clientWs.readyState !== WebSocket.OPEN) {
          poolWs.terminate();
          releaseIpSlot();
          return;
        }
        handoffPoolToClient(entry, clientWs, poolWs, releaseIpSlot);
      },
      reject: () => {
        if (settled) return;
        settled = true;
        clientWs.close(1013, 'host disconnected');
        releaseIpSlot();
      },
    };
    waiter.timer.unref?.();
    entry.pendingTickets.set(openTicket, waiter);
    entry.fifoWaiters.push(waiter);

    clientWs.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(waiter.timer);
      entry.pendingTickets.delete(openTicket);
      const idx = entry.fifoWaiters.indexOf(waiter);
      if (idx !== -1) entry.fifoWaiters.splice(idx, 1);
      releaseIpSlot();
    });

    try {
      entry.controlWs.send(JSON.stringify({ type: 'open', ticket: openTicket }));
    } catch {
      clearTimeout(waiter.timer);
      waiter.reject();
    }
  });

  const verifyViaWebhook = async (targetFp, ticket) => {
    if (!verifyUrl) return false;
    try {
      const response = await fetch(verifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: targetFp, ticket }),
        redirect: 'error',
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return false;
      const body = await response.json();
      return body?.ok === true;
    } catch {
      return false;
    }
  };

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
    const matched = matchRouteSuffix(parsedUrl.pathname);
    if (matched && (matched.suffix === '/v1/probe' || matched.suffix === '/v1/health')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const sendProbe = () => {
          const payload = JSON.stringify({
            ok: true,
            version: RELAY_PROTOCOL_VERSION,
            ts: Date.now(),
          });
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(payload),
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(req.method === 'HEAD' ? undefined : payload);
        };
        if (probeDelayMs > 0) {
          setTimeout(sendProbe, probeDelayMs).unref?.();
        } else {
          sendProbe();
        }
        return;
      }
    }
    res.writeHead(404, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });

  server.on('upgrade', (req, socket, head) => {
    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
    const matched = matchRouteSuffix(parsedUrl.pathname);
    if (!matched) {
      rejectHttpUpgrade(socket, 404, 'unknown relay path');
      return;
    }

    if (matched.suffix === '/v1/host') {
      const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
      if (!offered.includes(RELAY_WS_SUBPROTOCOL)) {
        rejectHttpUpgrade(socket, 400, 'kiki-relay-v1 subprotocol required');
        return;
      }
      if (!verifyBearerToken(req.headers.authorization, hostToken)) {
        rejectHttpUpgrade(socket, 401, 'invalid host token');
        return;
      }
      const allowedOriginPaths = resolveAllowedOriginPaths(req, matched.prefix);
      controlWss.handleUpgrade(req, socket, head, (ws) => {
        controlWss.emit('connection', ws, req, allowedOriginPaths);
      });
      return;
    }

    if (matched.suffix === '/v1/pool') {
      const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
      if (!offered.includes(RELAY_WS_SUBPROTOCOL)) {
        rejectHttpUpgrade(socket, 400, 'kiki-relay-v1 subprotocol required');
        return;
      }
      if (!verifyBearerToken(req.headers.authorization, hostToken)) {
        rejectHttpUpgrade(socket, 401, 'invalid host token');
        return;
      }
      const fp = (parsedUrl.searchParams.get('fp') ?? '').toLowerCase();
      const nonce = (parsedUrl.searchParams.get('nonce') ?? '').toLowerCase();
      const poolToken = parsedUrl.searchParams.get('poolToken') ?? '';
      const ticket = parsedUrl.searchParams.get('ticket') ?? '';
      if (!/^[a-f0-9]{64}$/.test(fp) || !/^[a-f0-9]{32,128}$/.test(nonce)) {
        rejectHttpUpgrade(socket, 400, 'invalid pool parameters');
        return;
      }
      const now = Date.now();
      pruneNonces(now);
      const nonceKey = `${fp}:${nonce}`;
      if (usedNonces.has(nonceKey)) {
        rejectHttpUpgrade(socket, 403, 'replayed pool nonce');
        return;
      }
      const capKey = deriveCapKey(serverSecret, fp);
      if (!verifyPoolToken(capKey, fp, nonce, ticket, poolToken)) {
        rejectHttpUpgrade(socket, 403, 'invalid pool token');
        return;
      }
      if (!hosts.has(fp)) {
        rejectHttpUpgrade(socket, 404, 'host not registered');
        return;
      }
      usedNonces.set(nonceKey, now + NONCE_REPLAY_TTL_MS);
      poolWss.handleUpgrade(req, socket, head, (ws) => {
        poolWss.emit('connection', ws, req, fp, ticket || undefined);
      });
      return;
    }

    if (matched.suffix === '/v1/stream') {
      const rawSubproto = req.headers['sec-websocket-protocol'];
      if (typeof rawSubproto === 'string' && rawSubproto.trim() !== '') {
        const offered = rawSubproto.split(',').map((s) => s.trim());
        if (!offered.includes(RELAY_WS_SUBPROTOCOL)) {
          rejectHttpUpgrade(socket, 400, 'unsupported subprotocol');
          return;
        }
      }
      const clientIp = clientIpFromRequest(req, trustProxy);
      if (!checkIpAdmission(clientIp)) {
        rejectHttpUpgrade(socket, 429, 'rate limit exceeded');
        return;
      }
      const targetFp = (parsedUrl.searchParams.get('target') ?? '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(targetFp)) {
        rejectHttpUpgrade(socket, 400, 'invalid target fingerprint');
        return;
      }
      const rt = parsedUrl.searchParams.get('rt') ?? '';
      const capKey = deriveCapKey(serverSecret, targetFp);

      const proceedStreamUpgrade = () => {
        const entry = hosts.get(targetFp);
        if (!entry || entry.controlWs.readyState !== WebSocket.OPEN) {
          rejectHttpUpgrade(socket, 502, 'target host offline');
          return;
        }
        streamWss.handleUpgrade(req, socket, head, (ws) => {
          streamWss.emit('connection', ws, req, targetFp, clientIp);
        });
      };

      if (!requireTicket) {
        proceedStreamUpgrade();
        return;
      }

      if (verifyStreamTicket(capKey, targetFp, rt)) {
        proceedStreamUpgrade();
        return;
      }

      if (verifyUrl && rt) {
        void verifyViaWebhook(targetFp, rt).then((allowed) => {
          if (!allowed) {
            rejectHttpUpgrade(socket, 403, 'invalid relay ticket');
            return;
          }
          proceedStreamUpgrade();
        });
        return;
      }

      rejectHttpUpgrade(socket, 403, 'invalid or missing relay ticket');
      return;
    }

    rejectHttpUpgrade(socket, 404, 'unknown relay endpoint');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : requestedPort;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const effectivePublicUrl = publicUrlRaw || `ws://${displayHost}:${actualPort}${basePath}`;
  const shareUri = formatShareUri({
    publicUrl: effectivePublicUrl,
    label,
    token: hostToken,
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const [fp, entry] of [...hosts.entries()]) {
      try {
        if (entry.controlWs.readyState === WebSocket.OPEN) {
          entry.controlWs.send(JSON.stringify({ type: 'restarting', reconnectInMs: 1000 }));
        }
      } catch {
        // Ignore best-effort restart advisory failure.
      }
      closeHostEntry(fp, entry, 'server stopping');
    }
    for (const ws of streamWss.clients) ws.terminate();
    for (const ws of poolWss.clients) ws.terminate();
    for (const ws of controlWss.clients) ws.terminate();
    controlWss.close();
    poolWss.close();
    streamWss.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  };

  return {
    server,
    host,
    port: actualPort,
    basePath,
    publicUrl: effectivePublicUrl,
    shareUri,
    stats: () => ({
      registeredHosts: hosts.size,
      warmSockets: [...hosts.values()].reduce((acc, e) => acc + e.idlePool.length, 0),
      activeClientStreams: [...ipStreams.values()].reduce((acc, n) => acc + n, 0),
    }),
    setProbeDelayMs: (ms) => {
      probeDelayMs = Math.max(0, Number(ms) || 0);
    },
    stop,
  };
}

async function runCli() {
  const { values } = parseArgs({
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      'base-path': { type: 'string' },
      'public-url': { type: 'string' },
      name: { type: 'string' },
      token: { type: 'string' },
      secret: { type: 'string' },
      'verify-url': { type: 'string' },
      'trust-proxy': { type: 'boolean' },
      'no-ticket': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(
      'kiki-relay-server — Zero-knowledge E2E TLS-pinned WebSocket relay for Kiki\n\n' +
      'Usage:\n' +
      '  node server/kiki-relay-server.mjs [options]\n\n' +
      'Options:\n' +
      '  --host <addr>         Bind address (default: RELAY_HOST or 0.0.0.0)\n' +
      '  --port <port>         Listen port (default: RELAY_PORT or 9440)\n' +
      '  --base-path <path>    URL prefix, e.g. /kiki-relay (default: RELAY_BASE_PATH)\n' +
      '  --public-url <url>    External URL, e.g. wss://relay.example.com/kiki-relay\n' +
      '  --name <label>        Display name embedded in printed kiki-relay:// link\n' +
      '  --token <secret>      Require Bearer token for Host registration (RELAY_HOST_TOKEN)\n' +
      '  --secret <secret>     Stateless HMAC root secret (RELAY_SECRET)\n' +
      '  --verify-url <url>    Optional ticket verification webhook (RELAY_VERIFY_URL)\n' +
      '  --trust-proxy         Trust X-Forwarded-For / X-Forwarded-Host headers\n' +
      '  --no-ticket           Allow unticketed /v1/stream connections (testing only)\n',
    );
    return;
  }

  const instance = await startKikiRelayServer({
    host: values.host,
    port: values.port ? Number(values.port) : undefined,
    basePath: values['base-path'],
    publicUrl: values['public-url'],
    label: values.name,
    hostToken: values.token,
    secret: values.secret,
    verifyUrl: values['verify-url'],
    trustProxy: values['trust-proxy'],
    requireTicket: values['no-ticket'] ? false : undefined,
  });

  process.stdout.write(
    `[kiki-relay] listening on http://${instance.host}:${instance.port}${instance.basePath || '/'}\n` +
    `[kiki-relay] paste into Kiki Settings -> External Connections:\n  ${instance.shareUri}\n`,
  );

  const shutdown = () => {
    void instance.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((err) => {
    process.stderr.write(`[kiki-relay] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
