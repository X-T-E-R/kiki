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
      (item) =>
        (!item.paired && (item.origin === legacyOrigin || item.origins.includes(legacyOrigin))) ||
        (item.paired && isServerOriginVerified(item, legacyOrigin)),
    );
    if (existingIndex === -1) {
      if (!list.some((item) => item.paired)) {
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
      }
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
  if (isPaired && !markVerified && existing && !isServerOriginVerified(existing, origin)) {
    return existing;
  }
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
 * Returns whether `rawOrOrigin` has been verified via pairing to belong to
 * the paired computer `server`.
 */
export function isServerOriginVerified(server, rawOrOrigin) {
  if (!server || !server.paired || !server.targetHomeId) return false;
  const target = readTarget(rawOrOrigin);
  if (!target.ok) return false;
  return Array.isArray(server.verifiedOrigins) && server.verifiedOrigins.includes(target.origin);
}

/**
 * Switches the active network address (`origin`) of an existing saved computer.
 * For paired computers, only origins already verified via pairing can be selected;
 * a new unpaired origin returns `reason: 'pairing_required'` without overwriting
 * the saved computer.
 */
export function updateSavedServerOrigin(storage, serverId, rawNewOrigin) {
  const target = readTarget(rawNewOrigin);
  if (!target.ok) return { ok: false, reason: target.reason };
  const current = readSavedServers(storage);
  const index = current.findIndex(
    (item) => item.id === serverId || item.targetHomeId === serverId || item.origin === serverId,
  );
  if (index === -1) return { ok: false, reason: 'not_found' };
  const existing = current[index];
  const nextOrigin = target.origin;

  if ((existing.paired || existing.targetHomeId) && !isServerOriginVerified(existing, nextOrigin)) {
    return {
      ok: false,
      reason: 'pairing_required',
      origin: nextOrigin,
      server: existing,
    };
  }

  const nextOrigins = [nextOrigin, ...existing.origins.filter((o) => o !== nextOrigin)].slice(0, 6);
  const nextVerified = existing.verifiedOrigins.includes(nextOrigin)
    ? [nextOrigin, ...existing.verifiedOrigins.filter((o) => o !== nextOrigin)].slice(0, 6)
    : existing.verifiedOrigins;
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
    verifiedOrigins: nextVerified,
    updatedAt: Date.now(),
  });
  const next = [updated, ...current.filter((_, idx) => idx !== index)];
  writeServers(storage, next);
  return { ok: true, server: updated };
}

function rollbackUnverifiedOrigin(storage, current, index, candidateOrigin, reason, keepVerified = false) {
  const existing = current[index];
  const verifiedOrigins = keepVerified
    ? existing.verifiedOrigins
    : existing.verifiedOrigins.filter((o) => o !== candidateOrigin);
  if (verifiedOrigins.length === 0 && (existing.paired || existing.targetHomeId)) {
    const preserved = sanitizeServerRecord({
      ...existing,
      origins: existing.origins.includes(existing.origin)
        ? existing.origins
        : [existing.origin, ...existing.origins].slice(0, 6),
      verifiedOrigins: existing.verifiedOrigins.length > 0 ? existing.verifiedOrigins : [existing.origin],
      updatedAt: existing.updatedAt || Date.now(),
    });
    const next = current.map((item, idx) => (idx === index ? preserved : item));
    writeServers(storage, next);
    return { ok: false, reason, server: preserved };
  }
  const fallbackOrigin =
    keepVerified && existing.verifiedOrigins.includes(existing.origin)
      ? existing.origin
      : verifiedOrigins.find((o) => o !== candidateOrigin) ??
        verifiedOrigins[0] ??
        existing.origins.find((o) => o !== candidateOrigin) ??
        existing.origin;
  const nextOrigins = existing.origins.filter((o) => o !== candidateOrigin || verifiedOrigins.includes(o));
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
    updatedAt: existing.updatedAt || Date.now(),
  });
  const next = current.map((item, idx) => (idx === index ? restored : item));
  writeServers(storage, next);
  return { ok: false, reason, server: restored };
}

/**
 * Checks a candidate `rawOrigin` against a handshake probe result (`{ ok, targetHomeId, targetHostId }`).
 * Because `/api/remote-connections/handshake` is unauthenticated public metadata, a handshake probe
 * never promotes an unpaired origin into `verifiedOrigins`; new origins must be paired with a code
 * (`reason: 'pairing_required'`), while mismatched homes are rejected (`reason: 'identity_mismatch'`).
 */
export function verifySavedServerOrigin(storage, serverId, rawOrigin, handshake) {
  const target = readTarget(rawOrigin);
  if (!target.ok) return { ok: false, reason: target.reason };
  const current = readSavedServers(storage);
  const index = current.findIndex(
    (item) => item.id === serverId || item.targetHomeId === serverId || item.origin === serverId,
  );
  if (index === -1) return { ok: false, reason: 'not_found' };
  const existing = current[index];
  const candidateOrigin = target.origin;

  if (!handshake?.ok) {
    if (existing.origin === candidateOrigin && !isServerOriginVerified(existing, candidateOrigin)) {
      return rollbackUnverifiedOrigin(storage, current, index, candidateOrigin, 'unreachable', true);
    }
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

  if (!probeHomeId) {
    if (existing.origin === candidateOrigin && !isServerOriginVerified(existing, candidateOrigin)) {
      return rollbackUnverifiedOrigin(storage, current, index, candidateOrigin, 'unreachable', true);
    }
    return { ok: false, reason: 'unreachable', server: existing };
  }

  const homeMatches = Boolean(existing.targetHomeId && probeHomeId === existing.targetHomeId);
  const hostMatches = Boolean(
    probeHomeId && (!existing.targetHostId || !probeHostId || probeHostId === existing.targetHostId),
  );

  if (!homeMatches || !hostMatches) {
    return rollbackUnverifiedOrigin(storage, current, index, candidateOrigin, 'identity_mismatch', true);
  }

  if (!isServerOriginVerified(existing, candidateOrigin)) {
    return rollbackUnverifiedOrigin(storage, current, index, candidateOrigin, 'pairing_required', true);
  }

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

/** Removes a saved computer and updates `kiki.shell.origin`. */
export function removeSavedServer(storage, serverId) {
  const current = readSavedServers(storage);
  const next = current.filter((item) => item.id !== serverId && item.origin !== serverId);
  writeServers(storage, next);
  return next;
}

function isSameOriginResponse(res, expectedOrigin) {
  if (!res) return false;
  if (res.type === 'opaqueredirect' || res.redirected === true) return false;
  if (typeof res.status === 'number' && res.status >= 300 && res.status < 400) return false;
  if (typeof res.url === 'string' && res.url !== '') {
    try {
      if (new URL(res.url).origin !== new URL(expectedOrigin).origin) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Probes a Kiki server's zero-token handshake (`/api/remote-connections/handshake`)
 * with fallback to `/api/meta` for unauthenticated reachability and hints.
 * Never follows redirects, never mutates saved computers, and never attaches credentials.
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
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!isSameOriginResponse(handshakeRes, origin)) {
      return { ok: false };
    }
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
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!isSameOriginResponse(metaRes, origin)) {
      return { ok: false };
    }
    const status = metaRes.status;
    return {
      ok: (status >= 200 && status < 300) || status === 401 || status === 403,
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Redeems a short-lived pairing code or `kiki://pair` URI at `input.endpoint`
 * (`POST /api/remote-connections/pair/claim`) without following redirects, stores
 * the issued peer token, and records the endpoint in the computer's `verifiedOrigins`.
 */
export async function claimPairingOrigin(storage, input) {
  let rawEndpoint = input?.endpoint ?? input?.origin ?? '';
  let rawCode = input?.code ?? '';
  if (/^kiki:\/\//i.test(String(rawEndpoint).trim())) {
    const parsedUri = parsePairingUri(rawEndpoint);
    if (!parsedUri) return { ok: false, reason: 'invalid_code' };
    rawEndpoint = parsedUri.endpoint;
    if (!rawCode) rawCode = parsedUri.code;
  }
  const normalizedEndpoint = normalizePairingEndpoint(rawEndpoint);
  const target = readTarget(normalizedEndpoint ?? rawEndpoint);
  const code = normalizePairingCode(rawCode);
  if (!target.ok) return { ok: false, reason: target.reason };
  if (!code) return { ok: false, reason: 'invalid_code' };

  const origin = target.origin;
  const endpointBase = normalizedEndpoint ?? origin;
  const identity = input?.identity ?? readDeviceIdentity(storage, input?.platform);

  if (typeof input?.nativeClaim === 'function') {
    const res = await input.nativeClaim({
      endpoint: endpointBase,
      origin,
      code,
      homeId: identity.homeId,
      hostId: identity.hostId,
      sourceLabel: identity.label,
    });
    if (res?.ok && res.targetHomeId) {
      const server = upsertSavedServer(storage, {
        id: res.serverId ?? res.targetHomeId,
        origin,
        label: res.targetLabel,
        paired: true,
        targetHomeId: res.targetHomeId,
        targetHostId: res.targetHostId,
        grantId: res.grantId,
        verified: true,
      });
      return {
        ok: true,
        origin,
        serverId: server?.id ?? res.serverId ?? res.targetHomeId,
        targetHomeId: res.targetHomeId,
        targetHostId: res.targetHostId,
        targetLabel: res.targetLabel,
        grantId: res.grantId,
        server,
      };
    }
    return {
      ok: false,
      reason: res?.reason === 'rejected' ? 'rejected' : 'unreachable',
    };
  }

  const fetchImpl = input?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = input?.timeoutMs ?? 6000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${endpointBase}/api/remote-connections/pair/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      redirect: 'manual',
      body: JSON.stringify({
        code,
        source: {
          homeId: identity.homeId,
          hostId: identity.hostId,
          protocol: 1,
        },
        sourceLabel: identity.label,
        requestBridge: false,
      }),
      signal: controller.signal,
    });
    if (!isSameOriginResponse(response, origin)) {
      return { ok: false, reason: 'rejected' };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: response.status >= 400 && response.status < 500 ? 'rejected' : 'unreachable',
      };
    }
    const payload = await response.json().catch(() => null);
    const data = payload?.data;
    if (
      !data ||
      typeof data.peerToken !== 'string' ||
      data.peerToken === '' ||
      typeof data.target?.homeId !== 'string' ||
      data.target.homeId === ''
    ) {
      return { ok: false, reason: 'rejected' };
    }
    if (typeof input?.saveToken === 'function') {
      await input.saveToken(data.target.homeId, data.peerToken, origin);
    }
    const server = upsertSavedServer(storage, {
      id: data.target.homeId,
      origin,
      label: data.targetLabel,
      paired: true,
      targetHomeId: data.target.homeId,
      targetHostId: data.target.hostId,
      grantId: data.grantId,
      verified: true,
    });
    return {
      ok: true,
      origin,
      serverId: server?.id ?? data.target.homeId,
      targetHomeId: data.target.homeId,
      targetHostId: data.target.hostId,
      targetLabel: data.targetLabel,
      grantId: data.grantId,
      revision: data.revision,
      peerToken: data.peerToken,
      server,
    };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Removes any `token` query or fragment parameter from `entry` while preserving
 * the rest of the path, query, and hash (such as `/settings#st-card-providers-add`).
 */
export function stripTokenFromEntry(origin, entry) {
  try {
    const expectedOrigin = new URL(origin).origin;
    const parsed = new URL(entry || `${expectedOrigin}/`, `${expectedOrigin}/`);
    if (parsed.origin !== expectedOrigin) {
      return `${expectedOrigin}/`;
    }
    if (parsed.searchParams.has('token')) {
      parsed.searchParams.delete('token');
    }
    if (parsed.hash && /(?:^#|&)token=/.test(parsed.hash)) {
      const rawHash = parsed.hash.slice(1);
      if (rawHash.includes('=')) {
        const hashParams = new URLSearchParams(rawHash);
        if (hashParams.has('token')) {
          hashParams.delete('token');
          const nextHash = hashParams.toString();
          parsed.hash = nextHash ? `#${nextHash}` : '';
        }
      }
    }
    return parsed.toString();
  } catch {
    return `${origin}/`;
  }
}

export const SHELL_MANAGED_STORAGE_KEY = 'kiki.shell.managed';

/**
 * Builds an origin-checked credential delivery script that stages the peer token
 * only in the current document's memory (`document.__kikiShellStagedCredential` +
 * `kiki:shell-token` event) when `window.location.origin === expectedOrigin`
 * after navigation commits. Never writes credentials to `localStorage`,
 * `sessionStorage`, or `window.name`, refuses to overwrite an existing non-shell
 * owner connection, and preserves the page's route path, query, non-credential
 * hash, and history state (`idx`).
 */
export function buildCommittedCredentialScript(expectedOrigin, token) {
  const originJson = JSON.stringify(String(expectedOrigin ?? ''));
  const tokenJson = JSON.stringify(String(token ?? ''));
  return `(function(){try{if(window.location.origin!==${originJson})return false;var t=${tokenJson};if(!t)return false;try{var raw=window.localStorage.getItem("kiki.connection");var managed=window.localStorage.getItem("kiki.shell.managed")==="1";if(raw){var parsed=JSON.parse(raw);var pTok=parsed&&typeof parsed.token==="string"?parsed.token.trim():"";var pUrl=parsed&&typeof parsed.url==="string"?parsed.url.trim():"";if(pTok!==""&&(!managed||pUrl!=="")){try{window.localStorage.removeItem("kiki.shell.managed");}catch(e){}try{window.sessionStorage.removeItem("kiki.peer.token");}catch(e){}try{if(window.document)delete window.document.__kikiShellStagedCredential;}catch(e){}return false;}}}catch(e){return false;}try{window.localStorage.removeItem("kiki.connection");window.localStorage.removeItem("kiki.shell.managed");}catch(e){}try{window.sessionStorage.removeItem("kiki.peer.token");}catch(e){}try{var doc=window.document||window;var used=false;Object.defineProperty(doc,"__kikiShellStagedCredential",{configurable:true,enumerable:false,get:function(){if(used)return null;used=true;try{delete doc.__kikiShellStagedCredential;}catch(e){}return{origin:${originJson},token:t};}});}catch(e){try{(window.document||window).__kikiShellStagedCredential={origin:${originJson},token:t};}catch(e2){return false;}}try{window.dispatchEvent(new CustomEvent("kiki:shell-token",{detail:{origin:${originJson},token:t}}));}catch(e){}return true;}catch(e){return false;}})();`;
}

/**
 * Delivers `resolved.sessionToken` only after verifying that the target page
 * has committed at `resolved.commitOrigin` (`resolved.origin`) via a committed
 * WebView/page evaluation handle. Never stages tokens in `window.name` or URL,
 * and never overwrites an existing non-shell owner connection.
 */
export async function deliverCommittedServerCredential(target, resolved, options = {}) {
  if (!resolved || !resolved.ok) {
    return {
      ok: false,
      reason: resolved?.reason ?? 'invalid_resolution',
      tokenDelivered: false,
    };
  }
  const rawOrigin = resolved.commitOrigin ?? resolved.origin ?? '';
  let expectedOrigin = '';
  try {
    expectedOrigin = new URL(rawOrigin).origin;
  } catch {
    return {
      ok: false,
      reason: 'invalid_origin',
      tokenDelivered: false,
    };
  }
  const token =
    typeof resolved.sessionToken === 'string' && resolved.sessionToken !== ''
      ? resolved.sessionToken
      : '';

  if (typeof target?.evaluate !== 'function') {
    if (target && typeof target === 'object' && 'name' in target) {
      try {
        target.name = '';
      } catch {}
    }
    if (!token) {
      return {
        ok: true,
        committedOrigin: expectedOrigin,
        tokenDelivered: false,
      };
    }
    return {
      ok: false,
      reason: target ? 'native_bridge_required' : 'unsupported_target',
      tokenDelivered: false,
    };
  }

  if (typeof target.url === 'function') {
    let committedOrigin = '';
    try {
      committedOrigin = new URL(target.url()).origin;
    } catch {
      return {
        ok: false,
        reason: 'invalid_committed_url',
        committedOrigin: '',
        tokenDelivered: false,
      };
    }
    if (committedOrigin !== expectedOrigin) {
      return {
        ok: false,
        reason: 'cross_origin_redirect',
        committedOrigin,
        tokenDelivered: false,
      };
    }
  }
  if (!token) {
    return {
      ok: true,
      committedOrigin: expectedOrigin,
      tokenDelivered: false,
    };
  }
  const expectedHomeId =
    typeof resolved.server?.targetHomeId === 'string' && resolved.server.targetHomeId.trim() !== ''
      ? resolved.server.targetHomeId.trim()
      : typeof resolved.targetHomeId === 'string' && resolved.targetHomeId.trim() !== ''
        ? resolved.targetHomeId.trim()
        : undefined;
  const expectedHostId =
    typeof resolved.server?.targetHostId === 'string' && resolved.server.targetHostId.trim() !== ''
      ? resolved.server.targetHostId.trim()
      : typeof resolved.targetHostId === 'string' && resolved.targetHostId.trim() !== ''
        ? resolved.targetHostId.trim()
        : undefined;
  if (expectedHomeId) {
    const probeFn =
      options.probe ??
      resolved.probe ??
      ((targetOrigin) => probeOriginHandshake(targetOrigin, { fetchImpl: options.fetchImpl }));
    const probe = await probeFn(expectedOrigin);
    if (!probe?.ok || !probe.targetHomeId) {
      return {
        ok: false,
        reason: 'unreachable',
        committedOrigin: expectedOrigin,
        tokenDelivered: false,
      };
    }
    if (
      probe.targetHomeId !== expectedHomeId ||
      (expectedHostId && probe.targetHostId && probe.targetHostId !== expectedHostId)
    ) {
      return {
        ok: false,
        reason: 'identity_mismatch',
        committedOrigin: expectedOrigin,
        targetHomeId: probe.targetHomeId,
        tokenDelivered: false,
      };
    }
  }
  let delivered;
  try {
    delivered = await target.evaluate(
      async ({ expectedOrigin: exp, token: tok }) => {
        try {
          if (typeof window.name === 'string' && window.name !== '') {
            window.name = '';
          }
        } catch {}
        await new Promise((resolveTurn) => {
          setTimeout(resolveTurn, 0);
        });
        if (window.location.origin !== exp || !tok) {
          return {
            ok: false,
            reason: 'cross_origin_redirect',
            committedOrigin: window.location.origin,
          };
        }
        try {
          const raw = window.localStorage.getItem('kiki.connection');
          const managed = window.localStorage.getItem('kiki.shell.managed') === '1';
          if (raw) {
            const parsed = JSON.parse(raw);
            const parsedToken = parsed && typeof parsed.token === 'string' ? parsed.token.trim() : '';
            const parsedUrl = parsed && typeof parsed.url === 'string' ? parsed.url.trim() : '';
            if (parsedToken !== '' && (!managed || parsedUrl !== '')) {
              try {
                window.localStorage.removeItem('kiki.shell.managed');
              } catch {}
              try {
                window.sessionStorage.removeItem('kiki.peer.token');
              } catch {}
              try {
                if (window.document) delete window.document.__kikiShellStagedCredential;
              } catch {}
              return {
                ok: false,
                reason: 'existing_owner_credential',
                committedOrigin: window.location.origin,
              };
            }
          }
        } catch {
          return {
            ok: false,
            reason: 'storage_unavailable',
            committedOrigin: window.location.origin,
          };
        }
        try {
          window.localStorage.removeItem('kiki.connection');
          window.localStorage.removeItem('kiki.shell.managed');
        } catch {}
        try {
          window.sessionStorage.removeItem('kiki.peer.token');
        } catch {}
        try {
          const doc = window.document || window;
          let used = false;
          Object.defineProperty(doc, '__kikiShellStagedCredential', {
            configurable: true,
            enumerable: false,
            get() {
              if (used) return null;
              used = true;
              try {
                delete doc.__kikiShellStagedCredential;
              } catch {}
              return { origin: exp, token: tok };
            },
          });
        } catch {
          try {
            (window.document || window).__kikiShellStagedCredential = { origin: exp, token: tok };
          } catch {
            return {
              ok: false,
              reason: 'storage_unavailable',
              committedOrigin: window.location.origin,
            };
          }
        }
        try {
          window.dispatchEvent(
            new CustomEvent('kiki:shell-token', { detail: { origin: exp, token: tok } }),
          );
        } catch {}
        return { ok: true, committedOrigin: window.location.origin };
      },
      { expectedOrigin, token },
    );
  } catch {
    if (typeof target.waitForLoadState === 'function') {
      await target.waitForLoadState('load').catch(() => {});
    }
    let committedOrigin = '';
    if (typeof target.url === 'function') {
      try {
        committedOrigin = new URL(target.url()).origin;
      } catch {}
    }
    return {
      ok: false,
      reason: 'cross_origin_redirect',
      committedOrigin,
      tokenDelivered: false,
    };
  }
  if (!delivered?.ok) {
    return {
      ok: false,
      reason: delivered?.reason ?? 'cross_origin_redirect',
      committedOrigin: delivered?.committedOrigin ?? '',
      tokenDelivered: false,
    };
  }
  return {
    ok: true,
    committedOrigin: delivered.committedOrigin,
    tokenDelivered: true,
  };
}

/**
 * Resolves a verified server open, navigates `page` to the token-free `finalEntry`,
 * and delivers the credential only if the navigation commits at `resolved.origin`.
 */
export async function openVerifiedServerNavigation(page, storage, input, options = {}) {
  const resolved = await resolveVerifiedServerOpen(storage, input);
  if (!resolved.ok) {
    return { ...resolved, tokenDelivered: false };
  }
  await page.goto(resolved.finalEntry, options.gotoOptions);
  const delivery = await deliverCommittedServerCredential(page, resolved, options);
  if (!delivery.ok) {
    return {
      ok: false,
      reason: delivery.reason,
      origin: resolved.origin,
      committedOrigin: delivery.committedOrigin,
      server: resolved.server,
      serverId: resolved.serverId,
      finalEntry: resolved.finalEntry,
      tokenAttached: false,
      tokenDelivered: false,
    };
  }
  return {
    ...resolved,
    committedOrigin: delivery.committedOrigin,
    tokenDelivered: delivery.tokenDelivered,
  };
}

/**
 * Opens `input.origin` only when it has established pairing trust (`verifiedOrigins`)
 * or redeems a pairing code (`input.code`) first. Never promotes an unpaired origin
 * via public handshake metadata, never follows cross-origin redirects, never
 * overwrites an existing paired computer before pairing succeeds, and never attaches
 * `#token=` to `finalEntry` before navigation commits.
 */
export async function resolveVerifiedServerOpen(storage, input) {
  const parsedTarget = readTarget(input?.origin ?? '');
  if (!parsedTarget.ok) {
    return { ok: false, reason: parsedTarget.reason };
  }
  const origin = parsedTarget.origin;
  const entry = input.entry ?? `${origin}/`;
  let current = readSavedServers(storage);
  const requestedServerId = input.serverId ?? input.targetHomeId;
  let existing =
    current.find(
      (item) =>
        (requestedServerId && (item.id === requestedServerId || item.targetHomeId === requestedServerId)) ||
        (input.targetHomeId && item.targetHomeId === input.targetHomeId) ||
        isServerOriginVerified(item, origin) ||
        (!item.paired && !item.targetHomeId && (item.origin === origin || item.origins.includes(origin))),
    ) ?? null;

  let claimedToken;
  if (typeof input.code === 'string' && input.code.trim() !== '') {
    const claim = await claimPairingOrigin(storage, {
      endpoint: input.endpoint ?? origin,
      origin,
      code: input.code,
      platform: input.platform,
      identity: input.identity,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
      saveToken: input.saveToken,
      nativeClaim: input.nativeClaim,
    });
    if (!claim.ok) {
      return {
        ok: false,
        reason: claim.reason,
        server: existing ?? undefined,
      };
    }
    claimedToken = claim.peerToken;
    current = readSavedServers(storage);
    existing =
      current.find((item) => item.id === claim.serverId || item.targetHomeId === claim.targetHomeId) ??
      claim.server ??
      null;
  }

  const isPairedTarget = Boolean(
    input.paired || input.targetHomeId || existing?.paired || existing?.targetHomeId,
  );
  const targetServerId = existing?.id ?? requestedServerId;

  if (isPairedTarget) {
    if (!claimedToken) {
      const probeFn =
        input.probe ??
        ((targetOrigin) => probeOriginHandshake(targetOrigin, { fetchImpl: input.fetchImpl }));
      const probe = await probeFn(origin);
      if (existing && targetServerId) {
        const verified = verifySavedServerOrigin(storage, targetServerId, origin, probe);
        if (!verified.ok) {
          return {
            ok: false,
            reason: verified.reason,
            server: verified.server,
          };
        }
        existing = verified.server;
      } else {
        return {
          ok: false,
          reason: probe.ok ? 'pairing_required' : 'unreachable',
          server: existing ?? undefined,
        };
      }
    } else if (!existing || !isServerOriginVerified(existing, origin)) {
      return {
        ok: false,
        reason: 'pairing_required',
        server: existing ?? undefined,
      };
    }
  }

  const saved = upsertSavedServer(storage, {
    id: existing?.id ?? input.serverId,
    origin,
    label: existing?.label ?? input.label,
    paired: isPairedTarget,
    targetHomeId: existing?.targetHomeId ?? input.targetHomeId,
    targetHostId: existing?.targetHostId ?? input.targetHostId,
    grantId: existing?.grantId ?? input.grantId,
    verified: isPairedTarget,
  });
  const serverId = saved?.id ?? targetServerId;

  const finalEntry = isPairedTarget ? stripTokenFromEntry(origin, entry) : entry;
  const sessionToken =
    claimedToken ??
    (isPairedTarget && serverId && isServerOriginVerified(saved, origin) && typeof input.getToken === 'function'
      ? await input.getToken(serverId, origin)
      : undefined);

  return {
    ok: true,
    origin,
    commitOrigin: origin,
    server: saved,
    serverId,
    finalEntry,
    sessionToken:
      typeof sessionToken === 'string' && sessionToken !== '' ? sessionToken : undefined,
    tokenAttached: false,
  };
}
