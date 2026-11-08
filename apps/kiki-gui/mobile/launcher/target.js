/**
 * What the person typed, pasted, or scanned into the launcher, read as a Kiki
 * server or a short-lived pairing URI (`kiki://pair?endpoint=...&code=...`).
 *
 * Accepts a bare address ("192.168.1.5:5494"), a full origin, a pairing URI,
 * or an entry link copied from Settings → Web access (`…/#access=<code >`).
 * The launcher stores server origins and computer identity metadata, while
 * one-time links, QR payloads, and bearer tokens are never written to web
 * storage, logs, or the clipboard.
 */

const LOCAL_HOST = /^(localhost|\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3}|[^.]+|.+\.local)$/i;

export const PAIRING_URI_PREFIX = 'kiki://pair';
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PAIRING_CODE_PATTERN = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{8}$`);

export const STORE_ORIGIN_KEY = 'kiki.shell.origin';
export const STORE_SERVERS_KEY = 'kiki.shell.servers';
export const STORE_DEVICE_KEY = 'kiki.shell.device';

/** @returns {{ ok: true, origin: string, entry: string } | { ok: false, reason: 'empty' | 'invalid' | 'scheme' | 'credentials' }} */
export function readTarget(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: false, reason: 'empty' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url;
  try {
    if (hasScheme) {
      url = new URL(text);
    } else {
      const host = text.split(/[/?#]/, 1)[0].replace(/:\d+$/, '');
      // A home machine on the LAN rarely has a certificate; a named public
      // host almost always does.
      url = new URL(`${LOCAL_HOST.test(host) ? 'http' : 'https'}://${text}`);
    }
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };
  if (url.hostname === '') return { ok: false, reason: 'invalid' };
  const carriesEntry = /(?:^#|&)access=/.test(url.hash) || url.searchParams.has('token');
  return { ok: true, origin: url.origin, entry: carriesEntry ? url.href : `${url.origin}/` };
}

/** Host text for display: the origin without a default scheme's noise. */
export function displayOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' ? url.host : `${url.host} · http`;
  } catch {
    return origin;
  }
}

/** Normalizes an 8-character pairing code into `XXXX-XXXX` or returns null. */
export function normalizePairingCode(raw) {
  const compact = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replaceAll(/[\s-]+/g, '');
  if (!PAIRING_CODE_PATTERN.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}`;
}

/** Formats user typing in the pairing code field into `XXXX-XXXX`. */
export function formatPairingCodeInput(raw) {
  const compact = String(raw ?? '')
    .toUpperCase()
    .replaceAll(/[^0-9A-Z]/g, '')
    .slice(0, 8);
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

function normalizePairingEndpoint(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username !== '' || parsed.password !== '' || parsed.hostname === '') return null;
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${pathname}`;
  } catch {
    return null;
  }
}

/** Formats a short-lived `kiki://pair?endpoint=<encoded>&code=<encoded>` URI. */
export function formatPairingUri(input) {
  const endpoint = normalizePairingEndpoint(input?.endpoint ?? '');
  const code = normalizePairingCode(input?.code ?? '');
  if (!endpoint) throw new Error('Invalid pairing endpoint');
  if (!code) throw new Error('Invalid pairing code');
  const params = new URLSearchParams({
    endpoint,
    code,
  });
  return `${PAIRING_URI_PREFIX}?${params.toString()}`;
}

/** Parses a `kiki://pair?endpoint=<encoded>&code=<encoded>` URI or returns null. */
export function parsePairingUri(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!/^kiki:\/\/\/?pair(?:\?|$)/i.test(trimmed)) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (
    parsed.protocol.toLowerCase() !== 'kiki:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.hash !== ''
  ) {
    return null;
  }
  if (!((host === 'pair' && (path === '' || path === '/')) || (host === '' && path === '/pair'))) {
    return null;
  }
  const endpoint = normalizePairingEndpoint(parsed.searchParams.get('endpoint') ?? '');
  const code = normalizePairingCode(parsed.searchParams.get('code') ?? '');
  if (!endpoint || !code) return null;
  return {
    endpoint,
    code,
  };
}

/**
 * Parses a QR scan payload (`kiki://pair?...` or an explicit `http(s)://` URL).
 * Rejects arbitrary plain text so a stray barcode never becomes a hostname.
 */
export function readScanPayload(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: false, reason: 'invalid_qr' };
  const pair = parsePairingUri(text);
  if (pair !== null) {
    const target = readTarget(pair.endpoint);
    if (!target.ok) return { ok: false, reason: 'invalid_qr' };
    return {
      ok: true,
      kind: 'pair',
      origin: target.origin,
      endpoint: pair.endpoint,
      code: pair.code,
      entry: `${target.origin}/`,
    };
  }
  if (!/^https?:\/\//i.test(text)) {
    return { ok: false, reason: 'invalid_qr' };
  }
  const target = readTarget(text);
  if (!target.ok) return { ok: false, reason: 'invalid_qr' };
  try {
    const url = new URL(text);
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
    const embeddedCode = normalizePairingCode(url.searchParams.get('code') ?? hashParams.get('code') ?? '');
    if (embeddedCode !== null) {
      return {
        ok: true,
        kind: 'pair',
        origin: target.origin,
        endpoint: target.origin,
        code: embeddedCode,
        entry: `${target.origin}/`,
      };
    }
  } catch {
    /* already validated by readTarget */
  }
  return {
    ok: true,
    kind: 'target',
    origin: target.origin,
    entry: target.entry,
  };
}

/**
 * Reads the manual address + optional pairing code fields together.
 * Also accepts a `kiki://pair?...` URI pasted directly into the address field.
 */
export function readConnectInput(rawAddress, rawCode = '') {
  const addressText = String(rawAddress ?? '').trim();
  const codeText = String(rawCode ?? '').trim();
  if (/^kiki:\/\//i.test(addressText)) {
    const scanned = readScanPayload(addressText);
    if (!scanned.ok) return { ok: false, reason: 'invalid' };
    if (codeText !== '') {
      const overrideCode = normalizePairingCode(codeText);
      if (overrideCode === null) return { ok: false, reason: 'invalid_code' };
      return {
        ok: true,
        kind: 'pair',
        origin: scanned.origin,
        endpoint: scanned.endpoint ?? scanned.origin,
        code: overrideCode,
        entry: `${scanned.origin}/`,
      };
    }
    return scanned;
  }
  const target = readTarget(addressText);
  if (!target.ok) return target;
  if (codeText !== '') {
    const code = normalizePairingCode(codeText);
    if (code === null) return { ok: false, reason: 'invalid_code' };
    return {
      ok: true,
      kind: 'pair',
      origin: target.origin,
      endpoint: target.origin,
      code,
      entry: `${target.origin}/`,
    };
  }
  return {
    ok: true,
    kind: 'target',
    origin: target.origin,
    entry: target.entry,
  };
}

function parseIpv4Octets(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const nums = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function isVpnHost(hostname) {
  const lower = hostname.toLowerCase().replaceAll(/^\[|\]$/g, '');
  if (lower.endsWith('.ts.net') || lower.endsWith('.tailscale.net')) return true;
  if (lower.startsWith('fd7a:115c:a1e0:')) return true;
  const ipv4 = parseIpv4Octets(lower);
  if (ipv4 !== null) {
    return ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127;
  }
  return false;
}

function isLanHost(hostname) {
  const lower = hostname.toLowerCase().replaceAll(/^\[|\]$/g, '');
  if (lower === 'localhost' || lower === '::1' || lower.endsWith('.local') || !lower.includes('.')) {
    if (!lower.includes(':')) return true;
  }
  if (lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
    return !lower.startsWith('fd7a:115c:a1e0:');
  }
  const ipv4 = parseIpv4Octets(lower);
  if (ipv4 !== null) {
    const [a, b] = ipv4;
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/**
 * Classifies a server origin or raw input into its transport layer:
 * `'lan'` (local network), `'vpn'` (Tailscale / CGNAT mesh), `'https'`, or `'http'`.
 */
export function classifyOrigin(rawOrOrigin) {
  const target = readTarget(rawOrOrigin);
  const resolved = target.ok ? target.origin : String(rawOrOrigin ?? '').trim();
  try {
    const url = new URL(resolved);
    const protocol = url.protocol === 'https:' ? 'https' : 'http';
    const hostname = url.hostname;
    if (isVpnHost(hostname)) {
      return { layer: 'vpn', protocol, host: url.host };
    }
    if (isLanHost(hostname)) {
      return { layer: 'lan', protocol, host: url.host };
    }
    return { layer: protocol === 'https' ? 'https' : 'http', protocol, host: url.host };
  } catch {
    return { layer: 'lan', protocol: 'http', host: resolved };
  }
}

function randomUuid() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Returns the persistent mobile device identity used for pairing claims
 * (`source: { homeId, hostId, protocol: 1 }`).
 */
export function readDeviceIdentity(storage = globalThis.localStorage, platform = 'android') {
  try {
    const raw = storage?.getItem?.(STORE_DEVICE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.homeId === 'string' &&
        UUID_PATTERN.test(parsed.homeId) &&
        typeof parsed.hostId === 'string' &&
        parsed.hostId.trim() !== ''
      ) {
        return {
          homeId: parsed.homeId,
          hostId: parsed.hostId,
          label: typeof parsed.label === 'string' && parsed.label.trim() !== '' ? parsed.label : 'Kiki Mobile',
        };
      }
    }
  } catch {
    /* create fresh identity below */
  }
  const homeId = randomUuid();
  const cleanPlatform = String(platform || 'mobile').toLowerCase().replaceAll(/[^a-z0-9]/g, '') || 'mobile';
  const hostId = `kiki-${cleanPlatform}-${homeId.slice(0, 8)}`;
  const label = cleanPlatform === 'ios' ? 'Kiki iOS' : 'Kiki Android';
  const identity = { homeId, hostId, label };
  try {
    storage?.setItem?.(STORE_DEVICE_KEY, JSON.stringify(identity));
  } catch {
    /* storage unavailable */
  }
  return identity;
}

function defaultLabelForOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.hostname;
  } catch {
    return origin;
  }
}

function sanitizeServerRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const target = readTarget(raw.origin ?? '');
  if (!target.ok) return null;
  const origin = target.origin;
  const targetHomeId = typeof raw.targetHomeId === 'string' && raw.targetHomeId.trim() !== '' ? raw.targetHomeId.trim() : undefined;
  const targetHostId = typeof raw.targetHostId === 'string' && raw.targetHostId.trim() !== '' ? raw.targetHostId.trim() : undefined;
  const grantId = typeof raw.grantId === 'string' && raw.grantId.trim() !== '' ? raw.grantId.trim() : undefined;
  const paired = Boolean(raw.paired || targetHomeId);
  const rawVerified = Array.isArray(raw.verifiedOrigins) ? raw.verifiedOrigins : paired ? [origin] : [];
  const verifiedOrigins = [];
  for (const item of rawVerified) {
    const parsed = readTarget(item);
    if (parsed.ok && !verifiedOrigins.includes(parsed.origin) && verifiedOrigins.length < 6) {
      verifiedOrigins.push(parsed.origin);
    }
  }
  const rawOrigins = Array.isArray(raw.origins) ? raw.origins : [];
  const origins = [origin];
  for (const item of [...rawOrigins, ...verifiedOrigins]) {
    const parsed = readTarget(item);
    if (parsed.ok && !origins.includes(parsed.origin) && origins.length < 6) {
      origins.push(parsed.origin);
    }
  }
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : (targetHomeId ?? `origin:${origin}`);
  const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : defaultLabelForOrigin(origin);
  return {
    id,
    label,
    origin,
    origins,
    verifiedOrigins,
    paired,
    targetHomeId,
    targetHostId,
    grantId,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
}

function writeServers(storage, servers) {
  try {
    if (servers.length === 0) {
      storage?.removeItem?.(STORE_SERVERS_KEY);
      storage?.removeItem?.(STORE_ORIGIN_KEY);
    } else {
      storage?.setItem?.(STORE_SERVERS_KEY, JSON.stringify(servers));
      storage?.setItem?.(STORE_ORIGIN_KEY, servers[0].origin);
    }
  } catch {
    /* storage unavailable */
  }
}

/**
 * Reads saved computers from storage, migrating legacy `kiki.shell.origin`
 * seamlessly if present.
 */
export function readSavedServers(storage = globalThis.localStorage) {
  const list = [];
  try {
    const rawList = storage?.getItem?.(STORE_SERVERS_KEY);
    if (rawList) {
      const parsed = JSON.parse(rawList);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const clean = sanitizeServerRecord(item);
          if (clean && !list.some((existing) => existing.id === clean.id)) {
            list.push(clean);
          }
        }
      }
    }
  } catch {
    /* ignore malformed storage */
  }

  let legacyOrigin = null;
  try {
    const rawOrigin = storage?.getItem?.(STORE_ORIGIN_KEY);
    if (rawOrigin) {
      const parsed = readTarget(rawOrigin);
      if (parsed.ok) legacyOrigin = parsed.origin;
    }
  } catch {
    /* ignore */
  }

  if (legacyOrigin !== null) {
    const existingIndex = list.findIndex(
      (item) => item.origin === legacyOrigin || item.origins.includes(legacyOrigin),
    );
    if (existingIndex === -1) {
      list.unshift(
        sanitizeServerRecord({
          id: `origin:${legacyOrigin}`,
          label: defaultLabelForOrigin(legacyOrigin),
          origin: legacyOrigin,
          origins: [legacyOrigin],
          verifiedOrigins: [],
          paired: false,
          updatedAt: Date.now(),
        }),
      );
    } else if (existingIndex > 0) {
      const [matched] = list.splice(existingIndex, 1);
      matched.origin = legacyOrigin;
      matched.origins = [legacyOrigin, ...matched.origins.filter((o) => o !== legacyOrigin)];
      list.unshift(matched);
    }
  }

  return list;
}

/**
 * Adds or updates a saved computer. When paired (`targetHomeId` present), the
 * computer's identity is keyed by `targetHomeId` so switching networks or editing
 * its IP preserves device trust and previous endpoints.
 */
export function upsertSavedServer(storage, input) {
  const target = readTarget(input?.origin ?? '');
  if (!target.ok) return null;
  const origin = target.origin;
  const current = readSavedServers(storage);
  const targetHomeId =
    typeof input?.targetHomeId === 'string' && input.targetHomeId.trim() !== ''
      ? input.targetHomeId.trim()
      : undefined;
  const explicitId = typeof input?.id === 'string' && input.id.trim() !== '' ? input.id.trim() : undefined;
  const desiredId = targetHomeId ?? explicitId ?? `origin:${origin}`;

  const matchIndex = current.findIndex((item) => {
    if (targetHomeId !== undefined) {
      return (
        item.id === desiredId ||
        item.targetHomeId === targetHomeId ||
        (!item.paired && !item.targetHomeId && (item.origin === origin || item.origins.includes(origin)))
      );
    }
    if (explicitId !== undefined) {
      return item.id === explicitId;
    }
    return (
      (!item.paired && !item.targetHomeId && (item.origin === origin || item.origins.includes(origin))) ||
      (item.paired && Array.isArray(item.verifiedOrigins) && item.verifiedOrigins.includes(origin))
    );
  });

  const existing = matchIndex >= 0 ? current[matchIndex] : null;
  const resolvedHomeId = targetHomeId ?? existing?.targetHomeId;
  const resolvedId = resolvedHomeId ?? (existing?.id && !existing.id.startsWith('origin:') ? existing.id : desiredId);
  const isPaired = Boolean(input?.paired || existing?.paired || resolvedHomeId);
  const markVerified = isPaired && input?.verified !== false;
  const verifiedOrigins = markVerified ? [origin] : [];
  if (existing && Array.isArray(existing.verifiedOrigins)) {
    for (const prev of existing.verifiedOrigins) {
      if (!verifiedOrigins.includes(prev) && verifiedOrigins.length < 6) {
        verifiedOrigins.push(prev);
      }
    }
  }

  const origins = [origin];
  if (existing) {
    for (const prev of existing.origins) {
      if (!origins.includes(prev) && origins.length < 6) origins.push(prev);
    }
  }

  const label =
    typeof input?.label === 'string' && input.label.trim() !== ''
      ? input.label.trim()
      : existing?.label && existing.label !== defaultLabelForOrigin(existing.origin)
        ? existing.label
        : defaultLabelForOrigin(origin);

  const updated = sanitizeServerRecord({
    id: resolvedId,
    label,
    origin,
    origins,
    verifiedOrigins,
    paired: isPaired,
    targetHomeId: resolvedHomeId,
    targetHostId: input?.targetHostId ?? existing?.targetHostId,
    grantId: input?.grantId ?? existing?.grantId,
    updatedAt: Date.now(),
  });

  const next = [updated, ...current.filter((_, idx) => idx !== matchIndex)];
  writeServers(storage, next);
  return updated;
}

/**
 * Returns whether `rawOrOrigin` has been verified via pairing or handshake to
 * belong to the paired computer `server`.
 */
export function isServerOriginVerified(server, rawOrOrigin) {
  if (!server || !server.paired || !server.targetHomeId) return false;
  const target = readTarget(rawOrOrigin);
  if (!target.ok) return false;
  return Array.isArray(server.verifiedOrigins) && server.verifiedOrigins.includes(target.origin);
}

/**
 * Updates the candidate network address (`origin`) of an existing saved computer
 * while keeping `verifiedOrigins` limited to identity-confirmed endpoints.
 */
export function updateSavedServerOrigin(storage, serverId, rawNewOrigin) {
  const target = readTarget(rawNewOrigin);
  if (!target.ok) return { ok: false, reason: target.reason };
  const current = readSavedServers(storage);
  const index = current.findIndex((item) => item.id === serverId || item.origin === serverId);
  if (index === -1) return { ok: false, reason: 'not_found' };
  const existing = current[index];
  const nextOrigin = target.origin;
  const nextOrigins = [nextOrigin, ...existing.origins.filter((o) => o !== nextOrigin)].slice(0, 6);
  const nextId = existing.id.startsWith('origin:') && !existing.paired ? `origin:${nextOrigin}` : existing.id;
  const nextLabel =
    existing.label === defaultLabelForOrigin(existing.origin)
      ? defaultLabelForOrigin(nextOrigin)
      : existing.label;

  const updated = sanitizeServerRecord({
    ...existing,
    id: nextId,
    label: nextLabel,
    origin: nextOrigin,
    origins: nextOrigins,
    verifiedOrigins: existing.verifiedOrigins,
    updatedAt: Date.now(),
  });
  const next = [updated, ...current.filter((_, idx) => idx !== index)];
  writeServers(storage, next);
  return { ok: true, server: updated };
}

/**
 * Verifies a candidate `rawOrigin` against a handshake probe result (`{ ok, targetHomeId, targetHostId }`).
 * Only promotes `rawOrigin` into `verifiedOrigins` when `targetHomeId` (and `targetHostId` when known)
 * matches the paired computer; on identity mismatch, rolls back the unverified address and preserves
 * the paired computer's previous verified address and trust.
 */
export function verifySavedServerOrigin(storage, serverId, rawOrigin, handshake) {
  const target = readTarget(rawOrigin);
  if (!target.ok) return { ok: false, reason: target.reason };
  const current = readSavedServers(storage);
  const index = current.findIndex((item) => item.id === serverId || item.targetHomeId === serverId);
  if (index === -1) return { ok: false, reason: 'not_found' };
  const existing = current[index];
  const candidateOrigin = target.origin;

  if (!handshake?.ok) {
    return { ok: false, reason: 'unreachable', server: existing };
  }

  const probeHomeId =
    typeof handshake.targetHomeId === 'string' && handshake.targetHomeId.trim() !== ''
      ? handshake.targetHomeId.trim()
      : undefined;
  const probeHostId =
    typeof handshake.targetHostId === 'string' && handshake.targetHostId.trim() !== ''
      ? handshake.targetHostId.trim()
      : undefined;

  const homeMatches = Boolean(existing.targetHomeId && probeHomeId === existing.targetHomeId);
  const hostMatches = !existing.targetHostId || !probeHostId || probeHostId === existing.targetHostId;

  if (homeMatches && hostMatches) {
    const verifiedOrigins = [
      candidateOrigin,
      ...existing.verifiedOrigins.filter((o) => o !== candidateOrigin),
    ].slice(0, 6);
    const origins = [
      candidateOrigin,
      ...existing.origins.filter((o) => o !== candidateOrigin),
    ].slice(0, 6);
    const updated = sanitizeServerRecord({
      ...existing,
      origin: candidateOrigin,
      origins,
      verifiedOrigins,
      targetHostId: existing.targetHostId ?? probeHostId,
      updatedAt: Date.now(),
    });
    const next = [updated, ...current.filter((_, idx) => idx !== index)];
    writeServers(storage, next);
    return { ok: true, verified: true, server: updated };
  }

  const verifiedOrigins = existing.verifiedOrigins.filter((o) => o !== candidateOrigin);
  const fallbackOrigin =
    verifiedOrigins[0] ?? existing.origins.find((o) => o !== candidateOrigin) ?? existing.origin;
  const nextOrigins = existing.origins.filter((o) => o !== candidateOrigin);
  if (nextOrigins.length === 0) nextOrigins.push(fallbackOrigin);
  const restoredLabel =
    existing.label === defaultLabelForOrigin(candidateOrigin)
      ? defaultLabelForOrigin(fallbackOrigin)
      : existing.label;

  const restored = sanitizeServerRecord({
    ...existing,
    label: restoredLabel,
    origin: fallbackOrigin,
    origins: nextOrigins,
    verifiedOrigins: verifiedOrigins.length > 0 ? verifiedOrigins : [fallbackOrigin],
    updatedAt: Date.now(),
  });
  const next = current.map((item, idx) => (idx === index ? restored : item));
  writeServers(storage, next);
  return { ok: false, reason: 'identity_mismatch', server: restored };
}

/** Removes a saved computer and updates `kiki.shell.origin`. */
export function removeSavedServer(storage, serverId) {
  const current = readSavedServers(storage);
  const next = current.filter((item) => item.id !== serverId && item.origin !== serverId);
  writeServers(storage, next);
  return next;
}

/**
 * Probes a Kiki server's zero-token handshake (`/api/remote-connections/handshake`)
 * with fallback to `/api/meta` for unauthenticated reachability.
 * Never attaches any bearer token or credentials.
 */
export async function probeOriginHandshake(origin, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 4500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const handshakeRes = await fetchImpl(`${origin}/api/remote-connections/handshake`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (handshakeRes.ok) {
      const payload = await handshakeRes.json().catch(() => null);
      const data = payload?.data;
      return {
        ok: true,
        targetLabel:
          typeof data?.targetLabel === 'string' && data.targetLabel !== ''
            ? data.targetLabel
            : undefined,
        targetHomeId:
          typeof data?.identity?.homeId === 'string' && data.identity.homeId !== ''
            ? data.identity.homeId
            : typeof data?.target?.homeId === 'string' && data.target.homeId !== ''
              ? data.target.homeId
              : undefined,
        targetHostId:
          typeof data?.identity?.hostId === 'string' && data.identity.hostId !== ''
            ? data.identity.hostId
            : typeof data?.target?.hostId === 'string' && data.target.hostId !== ''
              ? data.target.hostId
              : undefined,
      };
    }
    const metaRes = await fetchImpl(`${origin}/api/meta`, {
      method: 'GET',
      signal: controller.signal,
    });
    return { ok: metaRes.status > 0 };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verifies a paired computer's target identity at `input.origin` before any
 * bearer token is attached or the address is trusted.
 */
export async function resolveVerifiedServerOpen(storage, input) {
  const origin = input.origin;
  const entry = input.entry ?? `${origin}/`;
  const isPairedTarget = Boolean(input.paired || input.targetHomeId);
  const targetServerId = input.serverId ?? input.targetHomeId;
  const probeFn =
    input.probe ??
    ((targetOrigin) => probeOriginHandshake(targetOrigin, { fetchImpl: input.fetchImpl }));

  if (isPairedTarget && targetServerId && input.verified !== true) {
    const probe = await probeFn(origin);
    if (!probe.ok) {
      return { ok: false, reason: 'unreachable' };
    }
    const verified = verifySavedServerOrigin(storage, targetServerId, origin, probe);
    if (!verified.ok) {
      return {
        ok: false,
        reason: verified.reason,
        server: verified.server,
      };
    }
  }

  const saved = upsertSavedServer(storage, {
    id: input.serverId,
    origin,
    label: input.label,
    paired: input.paired,
    targetHomeId: input.targetHomeId,
    targetHostId: input.targetHostId,
    grantId: input.grantId,
    verified: isPairedTarget,
  });
  const serverId = saved?.id ?? input.serverId;

  let finalEntry = entry;
  const sessionToken =
    isPairedTarget && serverId && isServerOriginVerified(saved, origin) && typeof input.getToken === 'function'
      ? await input.getToken(serverId)
      : undefined;
  if (sessionToken && !/(?:^#|&)token=/.test(finalEntry) && !/(?:^#|&)access=/.test(finalEntry)) {
    finalEntry = `${origin}/#token=${encodeURIComponent(sessionToken)}`;
  }

  return {
    ok: true,
    server: saved,
    serverId,
    finalEntry,
    tokenAttached: Boolean(sessionToken && finalEntry.includes('#token=')),
  };
}
