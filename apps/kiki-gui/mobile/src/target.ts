import {
  HANDSHAKE_HEADERS,
  HANDSHAKE_HEX_PROOF_PATTERN,
  PAIRING_CODE_ALPHABET,
  PAIRING_URI_PREFIX,
  TLS_FINGERPRINT_PATTERN,
  classifyOrigin,
  computeHandshakeProof,
  constantTimeHexEqual,
  createMutualHandshakeChallenge,
  displayOrigin,
  editableOrigin,
  formatPairingCodeInput,
  formatPairingUri,
  handshakeDomainToStatus,
  handshakeRequestPreimage,
  handshakeResponsePreimage,
  handshakeStatusToDomain,
  hmacSha256Hex,
  isDirectConnectionHost,
  isLanHost,
  isLocalDefaultHost,
  isValidTargetHostname,
  isValidTlsFingerprint,
  isVpnHost,
  normalizePairingCode as normalizePairingCodeCanonical,
  normalizePairingEndpoint,
  normalizeTlsFingerprint,
  parsePairInput,
  parsePairingUri as parsePairingUriCanonical,
  readConnectInput,
  readPastePayload,
  readScanPayload,
  readTarget,
  sha256BytesHex,
  sha256Hex,
  stripTokenFromEntry,
  upgradeEndpointForTlsPin,
  type ConnectInputResult,
  type HandshakeResponseDomain,
  type HandshakeStatus,
  type MutualHandshakeChallenge,
  type MutualHandshakeChallengeInput,
  type OriginClassification,
  type PairInputResult,
  type ParsedPairingUri,
  type PastePayloadResult,
  type ScanPayloadResult,
  type TargetParseResult,
} from '@kiki/protocol/pairing';

export {
  HANDSHAKE_HEADERS,
  HANDSHAKE_HEX_PROOF_PATTERN,
  PAIRING_CODE_ALPHABET,
  PAIRING_URI_PREFIX,
  TLS_FINGERPRINT_PATTERN,
  classifyOrigin,
  computeHandshakeProof,
  constantTimeHexEqual,
  createMutualHandshakeChallenge,
  displayOrigin,
  editableOrigin,
  formatPairingCodeInput,
  formatPairingUri,
  handshakeDomainToStatus,
  handshakeRequestPreimage,
  handshakeResponsePreimage,
  handshakeStatusToDomain,
  hmacSha256Hex,
  isDirectConnectionHost,
  isLanHost,
  isLocalDefaultHost,
  isValidTargetHostname,
  isValidTlsFingerprint,
  isVpnHost,
  normalizePairingEndpoint,
  normalizeTlsFingerprint,
  parsePairInput,
  readConnectInput,
  readPastePayload,
  readScanPayload,
  readTarget,
  sha256BytesHex,
  sha256Hex,
  stripTokenFromEntry,
  upgradeEndpointForTlsPin,
  type ConnectInputResult,
  type HandshakeResponseDomain,
  type HandshakeStatus,
  type MutualHandshakeChallenge,
  type MutualHandshakeChallengeInput,
  type OriginClassification,
  type PairInputResult,
  type ParsedPairingUri,
  type PastePayloadResult,
  type ScanPayloadResult,
  type TargetParseResult,
};

export const STORE_ORIGIN_KEY = 'kiki.shell.origin';
export const STORE_SERVERS_KEY = 'kiki.shell.servers';
export const STORE_DEVICE_KEY = 'kiki.shell.device';
export const SHELL_MANAGED_STORAGE_KEY = 'kiki.shell.managed';
export const SHELL_DOCUMENT_NAV_NONCE_PROP = '__kikiShellNavNonce';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StorageLike {
  getItem?(key: string): string | null;
  setItem?(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface DeviceIdentity {
  homeId: string;
  hostId: string;
  label: string;
}

export interface SavedServer {
  id: string;
  label: string;
  origin: string;
  origins: string[];
  verifiedOrigins: string[];
  pinnedFingerprints?: Record<string, string>;
  paired: boolean;
  targetHomeId?: string;
  targetHostId?: string;
  grantId?: string;
  updatedAt: number;
}

export interface UpsertSavedServerInput {
  id?: string;
  origin: string;
  label?: string;
  paired?: boolean;
  targetHomeId?: string;
  targetHostId?: string;
  grantId?: string;
  fingerprint?: string;
  pinnedFingerprints?: Record<string, string>;
  verified?: boolean;
}

export interface ProbeHandshakeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  handshakeKey?: string;
  handshakeProof?: string;
  peerToken?: string;
  grantId?: string;
  nonce?: string;
  targetHomeId?: string;
  targetHostId?: string;
  serverId?: string;
  fingerprint?: string;
  requireMutualProof?: boolean;
  expectedStatus?: 'approved' | 'invited';
}

export interface HandshakeProbeResult {
  ok: boolean;
  aborted?: boolean;
  status?: number;
  reason?: string;
  authRejected?: boolean;
  inboundEnabled?: boolean;
  targetLabel?: string;
  targetHomeId?: string;
  targetHostId?: string;
  handshakeStatus?: HandshakeStatus;
  mutualProofVerified?: boolean;
  mutualRevokedVerified?: boolean;
  mutualDisabledVerified?: boolean;
  mutualInvitedVerified?: boolean;
  requireMutualProof?: boolean;
}

export interface NativeClaimParams {
  endpoint: string;
  origin: string;
  code: string;
  homeId: string;
  hostId: string;
  sourceLabel: string;
  fingerprint?: string;
}

export interface NativeClaimResponse {
  ok: boolean;
  reason?: string;
  origin?: string;
  serverId?: string;
  targetHomeId?: string;
  targetHostId?: string;
  targetLabel?: string;
  grantId?: string;
  revision?: number;
}

export interface ClaimPairingInput {
  endpoint?: string;
  origin?: string;
  code?: string;
  fingerprint?: string;
  platform?: string;
  identity?: DeviceIdentity;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  saveToken?: (serverId: string, token: string, origin: string) => void | Promise<void>;
  nativeClaim?: (params: NativeClaimParams) => Promise<NativeClaimResponse>;
}

export type ClaimPairingResult =
  | {
      ok: true;
      origin: string;
      serverId: string;
      targetHomeId: string;
      targetHostId?: string;
      targetLabel?: string;
      grantId?: string;
      revision?: number;
      peerToken?: string;
      fingerprint?: string;
      server: SavedServer | null;
    }
  | {
      ok: false;
      reason: string;
    };

export interface ResolveVerifiedOpenInput {
  origin: string;
  entry?: string;
  endpoint?: string;
  code?: string;
  serverId?: string;
  label?: string;
  paired?: boolean;
  targetHomeId?: string;
  targetHostId?: string;
  grantId?: string;
  fingerprint?: string;
  platform?: string;
  identity?: DeviceIdentity;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  handshakeKey?: string;
  handshakeProof?: string;
  requireMutualProof?: boolean;
  signal?: AbortSignal;
  isStale?: () => boolean;
  probe?: (origin: string, options?: ProbeHandshakeOptions) => Promise<HandshakeProbeResult>;
  saveToken?: (serverId: string, token: string, origin: string) => void | Promise<void>;
  getToken?: (serverId: string, origin: string) => Promise<string | null | undefined> | string | null | undefined;
  nativeClaim?: (params: NativeClaimParams) => Promise<NativeClaimResponse>;
}

export type ResolveVerifiedOpenResult =
  | {
      ok: true;
      origin: string;
      commitOrigin: string;
      server: SavedServer | null;
      serverId?: string;
      finalEntry: string;
      sessionToken?: string;
      requireMutualProof: boolean;
      tokenAttached: false;
      targetHomeId?: string;
      targetHostId?: string;
      grantId?: string;
      probe?: (origin: string, options?: ProbeHandshakeOptions) => Promise<HandshakeProbeResult>;
    }
  | {
      ok: false;
      stale?: boolean;
      reason: string;
      server?: SavedServer;
    };

export interface PageTargetLike {
  url?: () => string;
  goto?: (url: string, options?: unknown) => Promise<unknown>;
  evaluate?: <TResult, TArg = unknown>(fn: (arg: TArg) => TResult | Promise<TResult>, arg: TArg) => Promise<TResult>;
  waitForLoadState?: (state: string) => Promise<unknown>;
  name?: string;
}

export function normalizePairingCode(raw: string): string | null {
  return normalizePairingCodeCanonical(raw) ?? null;
}

export function parsePairingUri(raw: string): ParsedPairingUri | null {
  return parsePairingUriCanonical(raw) ?? null;
}

function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function readDeviceIdentity(
  storage: StorageLike | undefined = globalThis.localStorage,
  platform = 'android',
): DeviceIdentity {
  try {
    const raw = storage?.getItem?.(STORE_DEVICE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DeviceIdentity> | null;
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
  }
  const homeId = randomUuid();
  const cleanPlatform = String(platform || 'mobile').toLowerCase().replaceAll(/[^a-z0-9]/g, '') || 'mobile';
  const hostId = `kiki-${cleanPlatform}-${homeId.slice(0, 8)}`;
  const label = cleanPlatform === 'ios' ? 'Kiki iOS' : 'Kiki Android';
  const identity: DeviceIdentity = { homeId, hostId, label };
  try {
    storage?.setItem?.(STORE_DEVICE_KEY, JSON.stringify(identity));
  } catch {
  }
  return identity;
}

function defaultLabelForOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.hostname;
  } catch {
    return origin;
  }
}

function sanitizePinnedFingerprints(rawMap: unknown): Record<string, string> | undefined {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return undefined;
  const clean: Record<string, string> = {};
  let count = 0;
  for (const [rawOrigin, rawFp] of Object.entries(rawMap)) {
    if (count >= 6) break;
    const parsed = readTarget(rawOrigin);
    if (!parsed.ok) continue;
    const fp = typeof rawFp === 'string' ? rawFp.trim().toLowerCase() : '';
    if (!TLS_FINGERPRINT_PATTERN.test(fp)) continue;
    const normalizedOrigin = upgradeEndpointForTlsPin(parsed.origin, fp);
    if (!(normalizedOrigin in clean)) {
      count += 1;
    }
    clean[normalizedOrigin] = fp;
  }
  return count > 0 ? clean : undefined;
}

function resolveMigratedOriginForPinnedMap(
  rawOrigin: string,
  pinnedFingerprints: Record<string, string> | undefined,
): string {
  if (!pinnedFingerprints) return rawOrigin;
  if (rawOrigin in pinnedFingerprints) return rawOrigin;
  const candidate = upgradeEndpointForTlsPin(rawOrigin, '0'.repeat(64));
  if (candidate !== rawOrigin && candidate in pinnedFingerprints) {
    return candidate;
  }
  return rawOrigin;
}

export function getServerFingerprint(
  server: SavedServer | null | undefined,
  rawOrOrigin?: string,
): string | undefined {
  if (!server || !server.pinnedFingerprints || typeof server.pinnedFingerprints !== 'object') {
    return undefined;
  }
  const target = readTarget(rawOrOrigin ?? server.origin ?? '');
  if (!target.ok) return undefined;
  const resolvedOrigin = resolveMigratedOriginForPinnedMap(target.origin, server.pinnedFingerprints);
  const fp = server.pinnedFingerprints[resolvedOrigin];
  return typeof fp === 'string' && TLS_FINGERPRINT_PATTERN.test(fp) ? fp : undefined;
}

function sanitizeServerRecord(raw: unknown): SavedServer | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const target = readTarget(typeof obj['origin'] === 'string' ? obj['origin'] : '');
  if (!target.ok) return null;
  const pinnedFingerprints = sanitizePinnedFingerprints(obj['pinnedFingerprints']);
  const origin = resolveMigratedOriginForPinnedMap(target.origin, pinnedFingerprints);
  const targetHomeId =
    typeof obj['targetHomeId'] === 'string' && obj['targetHomeId'].trim() !== ''
      ? obj['targetHomeId'].trim()
      : undefined;
  const targetHostId =
    typeof obj['targetHostId'] === 'string' && obj['targetHostId'].trim() !== ''
      ? obj['targetHostId'].trim()
      : undefined;
  const grantId =
    typeof obj['grantId'] === 'string' && obj['grantId'].trim() !== ''
      ? obj['grantId'].trim()
      : undefined;
  const paired = Boolean(obj['paired'] || targetHomeId);
  const rawVerified = Array.isArray(obj['verifiedOrigins']) ? obj['verifiedOrigins'] : paired ? [origin] : [];
  const verifiedOrigins: string[] = [];
  for (const item of rawVerified) {
    const parsed = readTarget(String(item ?? ''));
    if (!parsed.ok) continue;
    const migrated = resolveMigratedOriginForPinnedMap(parsed.origin, pinnedFingerprints);
    if (!verifiedOrigins.includes(migrated) && verifiedOrigins.length < 6) {
      verifiedOrigins.push(migrated);
    }
  }
  const rawOrigins = Array.isArray(obj['origins']) ? obj['origins'] : [];
  const origins: string[] = [origin];
  for (const item of [...rawOrigins, ...verifiedOrigins]) {
    const parsed = readTarget(String(item ?? ''));
    if (!parsed.ok) continue;
    const migrated = resolveMigratedOriginForPinnedMap(parsed.origin, pinnedFingerprints);
    if (!origins.includes(migrated) && origins.length < 6) {
      origins.push(migrated);
    }
  }
  const id =
    typeof obj['id'] === 'string' && obj['id'].trim() !== ''
      ? obj['id'].trim()
      : (targetHomeId ?? `origin:${origin}`);
  const label =
    typeof obj['label'] === 'string' && obj['label'].trim() !== ''
      ? obj['label'].trim()
      : defaultLabelForOrigin(origin);
  const record: SavedServer = {
    id,
    label,
    origin,
    origins,
    verifiedOrigins,
    paired,
    targetHomeId,
    targetHostId,
    grantId,
    updatedAt: typeof obj['updatedAt'] === 'number' && Number.isFinite(obj['updatedAt']) ? obj['updatedAt'] : 0,
  };
  if (pinnedFingerprints !== undefined) {
    record.pinnedFingerprints = pinnedFingerprints;
  }
  return record;
}

function writeServers(storage: StorageLike | undefined, servers: SavedServer[]): void {
  try {
    if (servers.length === 0) {
      storage?.removeItem?.(STORE_SERVERS_KEY);
      storage?.removeItem?.(STORE_ORIGIN_KEY);
    } else {
      storage?.setItem?.(STORE_SERVERS_KEY, JSON.stringify(servers));
      storage?.setItem?.(STORE_ORIGIN_KEY, servers[0]!.origin);
    }
  } catch {
  }
}

export function isServerOriginVerified(
  server: SavedServer | null | undefined,
  rawOrOrigin: string,
): boolean {
  if (!server || !server.paired || !server.targetHomeId) return false;
  const target = readTarget(rawOrOrigin);
  if (!target.ok) return false;
  return Array.isArray(server.verifiedOrigins) && server.verifiedOrigins.includes(target.origin);
}

export function readSavedServers(storage: StorageLike | undefined = globalThis.localStorage): SavedServer[] {
  const list: SavedServer[] = [];
  try {
    const rawList = storage?.getItem?.(STORE_SERVERS_KEY);
    if (rawList) {
      const parsed = JSON.parse(rawList) as unknown;
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
  }

  let legacyOrigin: string | null = null;
  try {
    const rawOrigin = storage?.getItem?.(STORE_ORIGIN_KEY);
    if (rawOrigin) {
      const parsed = readTarget(rawOrigin);
      if (parsed.ok) legacyOrigin = parsed.origin;
    }
  } catch {
  }

  if (legacyOrigin !== null) {
    const resolveLegacyForServer = (item: SavedServer): string =>
      resolveMigratedOriginForPinnedMap(legacyOrigin!, item.pinnedFingerprints);
    const existingIndex = list.findIndex((item) => {
      const candidate = resolveLegacyForServer(item);
      return (
        (!item.paired && (item.origin === candidate || item.origins.includes(candidate))) ||
        (item.paired && isServerOriginVerified(item, candidate))
      );
    });
    if (existingIndex === -1) {
      if (!list.some((item) => item.paired)) {
        const migrated = sanitizeServerRecord({
          id: `origin:${legacyOrigin}`,
          label: defaultLabelForOrigin(legacyOrigin),
          origin: legacyOrigin,
          origins: [legacyOrigin],
          verifiedOrigins: [],
          paired: false,
          updatedAt: Date.now(),
        });
        if (migrated) list.unshift(migrated);
      }
    } else if (existingIndex > 0) {
      const [matched] = list.splice(existingIndex, 1);
      if (matched) {
        const candidate = resolveLegacyForServer(matched);
        matched.origin = candidate;
        matched.origins = [candidate, ...matched.origins.filter((o) => o !== candidate)];
        list.unshift(matched);
      }
    }
  }

  return list;
}

export function upsertSavedServer(
  storage: StorageLike | undefined,
  input: UpsertSavedServerInput,
): SavedServer | null {
  const target = readTarget(input?.origin ?? '');
  if (!target.ok) return null;
  const origin = target.origin;
  const current = readSavedServers(storage);
  const targetHomeId =
    typeof input?.targetHomeId === 'string' && input.targetHomeId.trim() !== ''
      ? input.targetHomeId.trim()
      : undefined;
  const explicitId =
    typeof input?.id === 'string' && input.id.trim() !== '' ? input.id.trim() : undefined;
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

  const existing = matchIndex >= 0 ? current[matchIndex]! : null;
  const resolvedHomeId = targetHomeId ?? existing?.targetHomeId;
  const resolvedId =
    resolvedHomeId ??
    (existing?.id && !existing.id.startsWith('origin:') ? existing.id : desiredId);
  const isPaired = Boolean(input?.paired || existing?.paired || resolvedHomeId);
  const markVerified = isPaired && input?.verified !== false;
  if (isPaired && !markVerified && existing && !isServerOriginVerified(existing, origin)) {
    return existing;
  }
  const verifiedOrigins: string[] = markVerified ? [origin] : [];
  if (existing && Array.isArray(existing.verifiedOrigins)) {
    for (const prev of existing.verifiedOrigins) {
      if (!verifiedOrigins.includes(prev) && verifiedOrigins.length < 6) {
        verifiedOrigins.push(prev);
      }
    }
  }

  const origins: string[] = [origin];
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

  const mergedFingerprints: Record<string, string> = {
    ...existing?.pinnedFingerprints,
    ...input?.pinnedFingerprints,
  };
  if (typeof input?.fingerprint === 'string' && TLS_FINGERPRINT_PATTERN.test(input.fingerprint.trim())) {
    mergedFingerprints[origin] = input.fingerprint.trim();
  }

  const updated = sanitizeServerRecord({
    id: resolvedId,
    label,
    origin,
    origins,
    verifiedOrigins,
    pinnedFingerprints: mergedFingerprints,
    paired: isPaired,
    targetHomeId: resolvedHomeId,
    targetHostId: input?.targetHostId ?? existing?.targetHostId,
    grantId: input?.grantId ?? existing?.grantId,
    updatedAt: Date.now(),
  });
  if (!updated) return null;

  const next = [updated, ...current.filter((_, idx) => idx !== matchIndex)];
  writeServers(storage, next);
  return updated;
}

export function updateSavedServerOrigin(
  storage: StorageLike | undefined,
  serverId: string,
  rawNewOrigin: string,
): { ok: true; server: SavedServer } | { ok: false; reason: string; origin?: string; server?: SavedServer } {
  const target = readTarget(rawNewOrigin);
  if (!target.ok) return { ok: false, reason: target.reason };
  const current = readSavedServers(storage);
  const index = current.findIndex(
    (item) => item.id === serverId || item.targetHomeId === serverId || item.origin === serverId,
  );
  if (index === -1) return { ok: false, reason: 'not_found' };
  const existing = current[index]!;
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
  const nextId =
    existing.id.startsWith('origin:') && !existing.paired ? `origin:${nextOrigin}` : existing.id;
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
  if (!updated) return { ok: false, reason: 'invalid' };
  const next = [updated, ...current.filter((_, idx) => idx !== index)];
  writeServers(storage, next);
  return { ok: true, server: updated };
}

function rollbackUnverifiedOrigin(
  storage: StorageLike | undefined,
  current: SavedServer[],
  index: number,
  candidateOrigin: string,
  reason: string,
  keepVerified = false,
): { ok: false; reason: string; server: SavedServer } {
  const existing = current[index]!;
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
    })!;
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
  })!;
  const next = current.map((item, idx) => (idx === index ? restored : item));
  writeServers(storage, next);
  return { ok: false, reason, server: restored };
}

export function verifySavedServerOrigin(
  storage: StorageLike | undefined,
  serverId: string,
  rawOrigin: string,
  handshake: HandshakeProbeResult | undefined,
): { ok: true; verified: true; server: SavedServer } | { ok: false; reason: string; server?: SavedServer } {
  const target = readTarget(rawOrigin);
  if (!target.ok) return { ok: false, reason: target.reason };
  const current = readSavedServers(storage);
  const index = current.findIndex(
    (item) => item.id === serverId || item.targetHomeId === serverId || item.origin === serverId,
  );
  if (index === -1) return { ok: false, reason: 'not_found' };
  const existing = current[index]!;
  const candidateOrigin = target.origin;

  const probeHomeId =
    typeof handshake?.targetHomeId === 'string' && handshake.targetHomeId.trim() !== ''
      ? handshake.targetHomeId.trim()
      : undefined;
  const probeHostId =
    typeof handshake?.targetHostId === 'string' && handshake.targetHostId.trim() !== ''
      ? handshake.targetHostId.trim()
      : undefined;

  if (probeHomeId) {
    const homeMatches = Boolean(existing.targetHomeId && probeHomeId === existing.targetHomeId);
    const hostMatches = Boolean(
      !existing.targetHostId || !probeHostId || probeHostId === existing.targetHostId,
    );
    if (!homeMatches || !hostMatches) {
      return rollbackUnverifiedOrigin(storage, current, index, candidateOrigin, 'identity_mismatch', true);
    }
  }

  const isAuthRejected =
    handshake?.reason === 'pairing_revoked' ||
    handshake?.authRejected === true ||
    handshake?.mutualRevokedVerified === true;
  const isInvitedNotApproved =
    handshake?.reason === 'pairing_required' ||
    handshake?.mutualInvitedVerified === true ||
    handshake?.handshakeStatus === 'invited';
  const isUnverifiedHandshakeProof = handshake?.reason === 'unverified_handshake_proof';

  if (!handshake?.ok) {
    if (isAuthRejected && isServerOriginVerified(existing, candidateOrigin)) {
      return { ok: false, reason: 'pairing_revoked', server: existing };
    }
    if (isInvitedNotApproved && isServerOriginVerified(existing, candidateOrigin)) {
      return { ok: false, reason: 'pairing_required', server: existing };
    }
    if (isUnverifiedHandshakeProof && isServerOriginVerified(existing, candidateOrigin)) {
      return { ok: false, reason: 'unverified_handshake_proof', server: existing };
    }
    if (existing.origin === candidateOrigin && !isServerOriginVerified(existing, candidateOrigin)) {
      return rollbackUnverifiedOrigin(storage, current, index, candidateOrigin, 'unreachable', true);
    }
    return { ok: false, reason: 'unreachable', server: existing };
  }

  if (!probeHomeId) {
    if (existing.origin === candidateOrigin && !isServerOriginVerified(existing, candidateOrigin)) {
      return rollbackUnverifiedOrigin(storage, current, index, candidateOrigin, 'unreachable', true);
    }
    return { ok: false, reason: 'unreachable', server: existing };
  }

  if (!isServerOriginVerified(existing, candidateOrigin)) {
    return rollbackUnverifiedOrigin(storage, current, index, candidateOrigin, 'pairing_required', true);
  }

  if (handshake.mutualRevokedVerified === true) {
    return { ok: false, reason: 'pairing_revoked', server: existing };
  }
  if (handshake.mutualInvitedVerified === true || handshake.handshakeStatus === 'invited') {
    return { ok: false, reason: 'pairing_required', server: existing };
  }
  if (handshake.mutualDisabledVerified === true || handshake.inboundEnabled === false) {
    return { ok: false, reason: 'unreachable', server: existing };
  }
  if (handshake.requireMutualProof && !handshake.mutualProofVerified) {
    return { ok: false, reason: 'unverified_handshake_proof', server: existing };
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
  })!;
  const next = [updated, ...current.filter((_, idx) => idx !== index)];
  writeServers(storage, next);
  return { ok: true, verified: true, server: updated };
}

export function removeSavedServer(
  storage: StorageLike | undefined,
  serverId: string,
): SavedServer[] {
  const current = readSavedServers(storage);
  const next = current.filter((item) => item.id !== serverId && item.origin !== serverId);
  writeServers(storage, next);
  return next;
}

function isSameOriginResponse(res: Response | undefined, expectedOrigin: string): boolean {
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

function readResponseHeader(res: Response, name: string): string | null {
  const headers = res.headers as Headers | Record<string, string> | undefined;
  if (!headers) return null;
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }
  const map = headers as Record<string, string>;
  return map[name] ?? map[name.toLowerCase()] ?? null;
}

export async function probeOriginHandshake(
  origin: string,
  options: ProbeHandshakeOptions = {},
): Promise<HandshakeProbeResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 4500;
  const expectedStatus = options.expectedStatus ?? 'approved';
  const externalSignal = options.signal;
  const isExternalAborted = (): boolean => externalSignal?.aborted === true;
  if (isExternalAborted()) {
    return { ok: false, aborted: true, reason: 'aborted' };
  }
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const challenge = await createMutualHandshakeChallenge({
      handshakeKey: options.handshakeKey ?? options.handshakeProof,
      peerToken: options.peerToken,
      grantId: options.grantId,
      nonce: options.nonce,
    });
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (challenge) {
      headers[HANDSHAKE_HEADERS.nonce] = challenge.nonce;
      headers[HANDSHAKE_HEADERS.proof] = challenge.requestProof;
      if (challenge.grantId) {
        headers[HANDSHAKE_HEADERS.grant] = challenge.grantId;
      }
    }
    const handshakeRes = await fetchImpl(`${origin}/api/remote-connections/handshake`, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!isSameOriginResponse(handshakeRes, origin)) {
      return { ok: false };
    }
    const statusHeader = readResponseHeader(handshakeRes, HANDSHAKE_HEADERS.status);
    const resProof = readResponseHeader(handshakeRes, HANDSHAKE_HEADERS.proof) ?? '';

    if (handshakeRes.ok) {
      const payload = (await handshakeRes.json().catch(() => null)) as {
        data?: {
          identity?: { homeId?: string; hostId?: string };
          target?: { homeId?: string; hostId?: string };
          targetLabel?: string;
          inboundEnabled?: boolean;
        };
      } | null;
      const data = payload?.data;
      const targetHomeId =
        typeof data?.identity?.homeId === 'string' && data.identity.homeId !== ''
          ? data.identity.homeId
          : typeof data?.target?.homeId === 'string' && data.target.homeId !== ''
            ? data.target.homeId
            : undefined;
      const targetHostId =
        typeof data?.identity?.hostId === 'string' && data.identity.hostId !== ''
          ? data.identity.hostId
          : typeof data?.target?.hostId === 'string' && data.target.hostId !== ''
            ? data.target.hostId
            : undefined;
      const targetLabel =
        typeof data?.targetLabel === 'string' && data.targetLabel !== '' ? data.targetLabel : undefined;
      const inboundEnabled = data?.inboundEnabled !== false;

      let verifiedStatus: HandshakeStatus | undefined;
      if (challenge && targetHomeId) {
        verifiedStatus = await challenge.verifyStatusResponse(
          statusHeader,
          resProof,
          targetHomeId,
          targetHostId ?? '',
        );
      }
      const mutualProofVerified = verifiedStatus === 'approved';
      const mutualRevokedVerified = verifiedStatus === 'revoked';
      const mutualDisabledVerified = verifiedStatus === 'inbound_disabled';
      const mutualInvitedVerified = verifiedStatus === 'invited';

      if (mutualRevokedVerified) {
        return {
          ok: false,
          status: handshakeRes.status,
          reason: 'pairing_revoked',
          authRejected: true,
          targetHomeId,
          targetHostId,
          handshakeStatus: 'revoked',
          mutualProofVerified: false,
          mutualRevokedVerified: true,
          mutualDisabledVerified: false,
          mutualInvitedVerified: false,
        };
      }
      if (challenge && (mutualDisabledVerified || !inboundEnabled)) {
        return {
          ok: false,
          status: handshakeRes.status,
          reason: 'unreachable',
          inboundEnabled: false,
          targetHomeId,
          targetHostId,
          handshakeStatus: mutualDisabledVerified ? 'inbound_disabled' : undefined,
          mutualProofVerified: false,
          mutualRevokedVerified: false,
          mutualDisabledVerified,
          mutualInvitedVerified: false,
        };
      }
      if (mutualInvitedVerified) {
        if (expectedStatus === 'invited') {
          return {
            ok: true,
            status: handshakeRes.status,
            inboundEnabled,
            targetLabel,
            targetHomeId,
            targetHostId,
            handshakeStatus: 'invited',
            mutualProofVerified: false,
            mutualRevokedVerified: false,
            mutualDisabledVerified: false,
            mutualInvitedVerified: true,
          };
        }
        return {
          ok: false,
          status: handshakeRes.status,
          reason: 'pairing_required',
          inboundEnabled,
          targetLabel,
          targetHomeId,
          targetHostId,
          handshakeStatus: 'invited',
          mutualProofVerified: false,
          mutualRevokedVerified: false,
          mutualDisabledVerified: false,
          mutualInvitedVerified: true,
        };
      }
      if (challenge && expectedStatus === 'invited') {
        return {
          ok: false,
          status: handshakeRes.status,
          reason: 'pairing_required',
          inboundEnabled,
          targetLabel,
          targetHomeId,
          targetHostId,
          handshakeStatus: mutualProofVerified ? 'approved' : undefined,
          mutualProofVerified,
          mutualRevokedVerified: false,
          mutualDisabledVerified: false,
          mutualInvitedVerified: false,
        };
      }
      if (options.requireMutualProof && challenge) {
        if (!mutualProofVerified) {
          return {
            ok: false,
            status: handshakeRes.status,
            reason: 'unverified_handshake_proof',
            targetHomeId,
            targetHostId,
            mutualProofVerified: false,
            mutualInvitedVerified: false,
          };
        }
      }
      return {
        ok: true,
        status: handshakeRes.status,
        inboundEnabled,
        targetLabel,
        targetHomeId,
        targetHostId,
        handshakeStatus: mutualProofVerified ? 'approved' : undefined,
        mutualProofVerified,
        mutualRevokedVerified: false,
        mutualDisabledVerified: false,
        mutualInvitedVerified: false,
      };
    }

    if (challenge && (handshakeRes.status === 401 || handshakeRes.status === 403)) {
      const expectedHomeId =
        typeof options.targetHomeId === 'string' && options.targetHomeId.trim() !== ''
          ? options.targetHomeId.trim()
          : typeof options.serverId === 'string' && options.serverId.trim() !== ''
            ? options.serverId.trim()
            : '';
      const expectedHostId =
        typeof options.targetHostId === 'string' ? options.targetHostId.trim() : '';
      let verifiedStatus: HandshakeStatus | undefined;
      if (resProof && expectedHomeId) {
        verifiedStatus = await challenge.verifyStatusResponse(
          statusHeader,
          resProof,
          expectedHomeId,
          expectedHostId,
        );
        if (verifiedStatus === undefined && expectedHostId) {
          verifiedStatus = await challenge.verifyStatusResponse(
            statusHeader,
            resProof,
            expectedHomeId,
            '',
          );
        }
      }
      if (verifiedStatus === 'revoked') {
        return {
          ok: false,
          status: handshakeRes.status,
          reason: 'pairing_revoked',
          authRejected: true,
          handshakeStatus: 'revoked',
          mutualProofVerified: false,
          mutualRevokedVerified: true,
          mutualDisabledVerified: false,
          mutualInvitedVerified: false,
        };
      }
      if (verifiedStatus === 'inbound_disabled') {
        return {
          ok: false,
          status: handshakeRes.status,
          reason: 'unreachable',
          inboundEnabled: false,
          handshakeStatus: 'inbound_disabled',
          mutualProofVerified: false,
          mutualRevokedVerified: false,
          mutualDisabledVerified: true,
          mutualInvitedVerified: false,
        };
      }
      if (verifiedStatus === 'invited') {
        if (expectedStatus === 'invited') {
          return {
            ok: true,
            status: handshakeRes.status,
            targetHomeId: expectedHomeId || undefined,
            targetHostId: expectedHostId || undefined,
            handshakeStatus: 'invited',
            mutualProofVerified: false,
            mutualRevokedVerified: false,
            mutualDisabledVerified: false,
            mutualInvitedVerified: true,
          };
        }
        return {
          ok: false,
          status: handshakeRes.status,
          reason: 'pairing_required',
          handshakeStatus: 'invited',
          mutualProofVerified: false,
          mutualRevokedVerified: false,
          mutualDisabledVerified: false,
          mutualInvitedVerified: true,
        };
      }
      return {
        ok: false,
        status: handshakeRes.status,
        reason: 'unverified_handshake_proof',
        authRejected: false,
        mutualProofVerified: false,
        mutualRevokedVerified: false,
        mutualDisabledVerified: false,
        mutualInvitedVerified: false,
      };
    }

    if (options.requireMutualProof && challenge) {
      return {
        ok: false,
        status: handshakeRes.status,
        reason: 'unreachable',
        mutualProofVerified: false,
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
    if (isExternalAborted()) {
      return { ok: false, aborted: true, reason: 'aborted' };
    }
    return { ok: false };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function claimPairingOrigin(
  storage: StorageLike | undefined,
  input: ClaimPairingInput,
): Promise<ClaimPairingResult> {
  let rawEndpoint = input?.endpoint ?? input?.origin ?? '';
  let rawCode = input?.code ?? '';
  let rawFingerprint = typeof input?.fingerprint === 'string' ? input.fingerprint.trim() : '';
  if (/^kiki:\/\//i.test(String(rawEndpoint).trim())) {
    const parsedUri = parsePairingUri(rawEndpoint);
    if (!parsedUri) return { ok: false, reason: 'invalid_code' };
    rawEndpoint = parsedUri.endpoint;
    if (!rawCode) rawCode = parsedUri.code;
    if (!rawFingerprint && parsedUri.fingerprint) rawFingerprint = parsedUri.fingerprint;
  }
  const fingerprint = TLS_FINGERPRINT_PATTERN.test(rawFingerprint) ? rawFingerprint : undefined;
  if (fingerprint !== undefined) {
    rawEndpoint = upgradeEndpointForTlsPin(rawEndpoint, fingerprint);
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
    const nativeParams: NativeClaimParams = {
      endpoint: endpointBase,
      origin,
      code,
      homeId: identity.homeId,
      hostId: identity.hostId,
      sourceLabel: identity.label,
      fingerprint,
    };
    const res = await input.nativeClaim(nativeParams);
    if (res?.ok && res.targetHomeId) {
      const resolvedOriginTarget =
        typeof res.origin === 'string' && res.origin.trim() !== '' ? readTarget(res.origin) : null;
      const finalOrigin = resolvedOriginTarget?.ok ? resolvedOriginTarget.origin : origin;
      const server = upsertSavedServer(storage, {
        id: res.serverId ?? res.targetHomeId,
        origin: finalOrigin,
        label: res.targetLabel,
        paired: true,
        targetHomeId: res.targetHomeId,
        targetHostId: res.targetHostId,
        grantId: res.grantId,
        fingerprint,
        verified: true,
      });
      return {
        ok: true,
        origin: finalOrigin,
        serverId: server?.id ?? res.serverId ?? res.targetHomeId,
        targetHomeId: res.targetHomeId,
        targetHostId: res.targetHostId,
        targetLabel: res.targetLabel,
        grantId: res.grantId,
        fingerprint,
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
        'x-kiki-pairing-rotation': '1',
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
    const payload = (await response.json().catch(() => null)) as {
      data?: {
        peerToken?: string;
        grantId?: string;
        revision?: number;
        targetLabel?: string;
        target?: { homeId?: string; hostId?: string };
      };
    } | null;
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
      fingerprint,
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
      fingerprint,
      server,
    };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

let navNonceSequence = 0;

export function buildDocumentNavNonceScript(expectedOrigin: string, navNonce: string): string {
  const originJson = JSON.stringify(String(expectedOrigin ?? ''));
  const nonceJson = JSON.stringify(String(navNonce ?? ''));
  return `(function(){try{if(window.location.origin!==${originJson})return false;var doc=window.document||window;var n=${nonceJson};if(!n)return false;try{Object.defineProperty(doc,"__kikiShellNavNonce",{configurable:true,enumerable:false,writable:true,value:n});}catch(e){doc.__kikiShellNavNonce=n;}return true;}catch(e){return false;}})();`;
}

export function buildCommittedCredentialScript(
  expectedOrigin: string,
  token: string,
  expectedNavNonce = '',
): string {
  const originJson = JSON.stringify(String(expectedOrigin ?? ''));
  const tokenJson = JSON.stringify(String(token ?? ''));
  const nonceJson = JSON.stringify(String(expectedNavNonce ?? ''));
  return `(function(){try{if(window.location.origin!==${originJson})return false;var doc=window.document||window;var n=${nonceJson};if(n&&doc.__kikiShellNavNonce!==n)return false;var t=${tokenJson};if(!t)return false;try{var raw=window.localStorage.getItem("kiki.connection");var managed=window.localStorage.getItem("kiki.shell.managed")==="1";if(raw){var parsed=JSON.parse(raw);var pTok=parsed&&typeof parsed.token==="string"?parsed.token.trim():"";var pUrl=parsed&&typeof parsed.url==="string"?parsed.url.trim():"";if(pTok!==""&&(!managed||pUrl!=="")){try{window.localStorage.removeItem("kiki.shell.managed");}catch(e){}try{window.sessionStorage.removeItem("kiki.peer.token");}catch(e){}try{delete doc.__kikiShellStagedCredential;}catch(e){}return false;}}}catch(e){return false;}try{window.localStorage.removeItem("kiki.connection");window.localStorage.removeItem("kiki.shell.managed");}catch(e){}try{window.sessionStorage.removeItem("kiki.peer.token");}catch(e){}try{if(doc.__kikiShellDeliveredNonce&&doc.__kikiShellDeliveredNonce===n)return true;}catch(e){}try{var used=false;Object.defineProperty(doc,"__kikiShellStagedCredential",{configurable:true,enumerable:false,get:function(){if(used)return null;used=true;try{delete doc.__kikiShellStagedCredential;}catch(e){}return{origin:${originJson},token:t};}});}catch(e){try{doc.__kikiShellStagedCredential={origin:${originJson},token:t};}catch(e2){return false;}}try{if(n){try{Object.defineProperty(doc,"__kikiShellDeliveredNonce",{configurable:true,enumerable:false,writable:true,value:n});}catch(e){doc.__kikiShellDeliveredNonce=n;}}}catch(e){}try{window.dispatchEvent(new CustomEvent("kiki:shell-token",{detail:{origin:${originJson},token:t}}));}catch(e){}return true;}catch(e){return false;}})();`;
}

export async function deliverCommittedServerCredential(
  target: PageTargetLike | null | undefined,
  resolved: ResolveVerifiedOpenResult | null | undefined,
  options: {
    navNonce?: string;
    probe?: (origin: string, options?: ProbeHandshakeOptions) => Promise<HandshakeProbeResult>;
    fetchImpl?: typeof fetch;
    requireMutualProof?: boolean;
  } = {},
): Promise<{
  ok: boolean;
  reason?: string;
  committedOrigin?: string;
  targetHomeId?: string;
  tokenDelivered: boolean;
}> {
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
      } catch {
      }
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
  const navNonce =
    typeof options.navNonce === 'string' && options.navNonce.trim() !== ''
      ? options.navNonce.trim()
      : `nav-${++navNonceSequence}-${Date.now()}`;

  try {
    const stamped = await target.evaluate(
      ({ expectedOrigin: exp, nonce }) => {
        if (window.location.origin !== exp || !nonce) return false;
        const doc = (window.document || window) as unknown as Record<string, unknown>;
        try {
          Object.defineProperty(doc, '__kikiShellNavNonce', {
            configurable: true,
            enumerable: false,
            writable: true,
            value: nonce,
          });
        } catch {
          doc['__kikiShellNavNonce'] = nonce;
        }
        return true;
      },
      { expectedOrigin, nonce: navNonce },
    );
    if (!stamped) {
      return {
        ok: false,
        reason: 'cross_origin_redirect',
        committedOrigin: '',
        tokenDelivered: false,
      };
    }
  } catch {
    return {
      ok: false,
      reason: 'cross_origin_redirect',
      committedOrigin: '',
      tokenDelivered: false,
    };
  }

  if (expectedHomeId) {
    const grantId =
      typeof resolved.server?.grantId === 'string' && resolved.server.grantId.trim() !== ''
        ? resolved.server.grantId.trim()
        : typeof resolved.grantId === 'string' && resolved.grantId.trim() !== ''
          ? resolved.grantId.trim()
          : undefined;
    const handshakeKey = await computeHandshakeProof(token);
    const probeFn =
      options.probe ??
      resolved.probe ??
      ((targetOrigin: string, probeOptions?: ProbeHandshakeOptions) =>
        probeOriginHandshake(targetOrigin, {
          fetchImpl: options.fetchImpl,
          handshakeKey: probeOptions?.handshakeKey ?? probeOptions?.handshakeProof,
          peerToken: probeOptions?.peerToken ?? token,
          grantId: probeOptions?.grantId ?? grantId,
          targetHomeId: probeOptions?.targetHomeId ?? expectedHomeId,
          targetHostId: probeOptions?.targetHostId ?? expectedHostId,
          serverId: probeOptions?.serverId ?? resolved.serverId ?? expectedHomeId,
          requireMutualProof: Boolean(probeOptions?.requireMutualProof),
        }));
    const mustVerifyMutualProof = Boolean(options.requireMutualProof ?? resolved.requireMutualProof);
    const probe = await probeFn(expectedOrigin, {
      serverId: resolved.serverId ?? expectedHomeId,
      targetHomeId: expectedHomeId,
      targetHostId: expectedHostId,
      grantId,
      handshakeKey,
      handshakeProof: handshakeKey,
      requireMutualProof: mustVerifyMutualProof,
    });
    if (
      probe?.targetHomeId &&
      (probe.targetHomeId !== expectedHomeId ||
        (expectedHostId && probe.targetHostId && probe.targetHostId !== expectedHostId))
    ) {
      return {
        ok: false,
        reason: 'identity_mismatch',
        committedOrigin: expectedOrigin,
        targetHomeId: probe.targetHomeId,
        tokenDelivered: false,
      };
    }
    const probeAuthRejected =
      probe?.reason === 'pairing_revoked' ||
      probe?.authRejected === true ||
      probe?.mutualRevokedVerified === true;
    if (probeAuthRejected) {
      return {
        ok: false,
        reason: 'pairing_revoked',
        committedOrigin: expectedOrigin,
        tokenDelivered: false,
      };
    }
    const probeInvited =
      probe?.reason === 'pairing_required' ||
      probe?.mutualInvitedVerified === true ||
      probe?.handshakeStatus === 'invited';
    if (probeInvited) {
      return {
        ok: false,
        reason: 'pairing_required',
        committedOrigin: expectedOrigin,
        tokenDelivered: false,
      };
    }
    const probeProofUnverified =
      probe?.reason === 'unverified_handshake_proof' ||
      (mustVerifyMutualProof && probe?.ok && probe.mutualProofVerified === false);
    if (probeProofUnverified) {
      return {
        ok: false,
        reason: 'unverified_handshake_proof',
        committedOrigin: expectedOrigin,
        tokenDelivered: false,
      };
    }
    if (!probe?.ok || !probe.targetHomeId) {
      return {
        ok: false,
        reason: 'unreachable',
        committedOrigin: expectedOrigin,
        tokenDelivered: false,
      };
    }
  }

  let delivered: { ok: boolean; reason?: string; committedOrigin?: string } | undefined;
  try {
    delivered = await target.evaluate(
      async ({ expectedOrigin: exp, token: tok, expectedNonce }) => {
        try {
          if (typeof window.name === 'string' && window.name !== '') {
            window.name = '';
          }
        } catch {
        }
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
        const doc = (window.document || window) as unknown as Record<string, unknown>;
        if (expectedNonce && doc['__kikiShellNavNonce'] !== expectedNonce) {
          return {
            ok: false,
            reason: 'stale_document',
            committedOrigin: window.location.origin,
          };
        }
        try {
          const raw = window.localStorage.getItem('kiki.connection');
          const managed = window.localStorage.getItem('kiki.shell.managed') === '1';
          if (raw) {
            const parsed = JSON.parse(raw) as { token?: unknown; url?: unknown } | null;
            const parsedToken =
              parsed && typeof parsed.token === 'string' ? parsed.token.trim() : '';
            const parsedUrl = parsed && typeof parsed.url === 'string' ? parsed.url.trim() : '';
            if (parsedToken !== '' && (!managed || parsedUrl !== '')) {
              try {
                window.localStorage.removeItem('kiki.shell.managed');
              } catch {
              }
              try {
                window.sessionStorage.removeItem('kiki.peer.token');
              } catch {
              }
              try {
                delete doc['__kikiShellStagedCredential'];
              } catch {
              }
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
        } catch {
        }
        try {
          window.sessionStorage.removeItem('kiki.peer.token');
        } catch {
        }
        try {
          let used = false;
          Object.defineProperty(doc, '__kikiShellStagedCredential', {
            configurable: true,
            enumerable: false,
            get() {
              if (used) return null;
              used = true;
              try {
                delete doc['__kikiShellStagedCredential'];
              } catch {
              }
              return { origin: exp, token: tok };
            },
          });
        } catch {
          try {
            doc['__kikiShellStagedCredential'] = { origin: exp, token: tok };
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
        } catch {
        }
        return { ok: true, committedOrigin: window.location.origin };
      },
      { expectedOrigin, token, expectedNonce: navNonce },
    );
  } catch {
    if (typeof target.waitForLoadState === 'function') {
      await target.waitForLoadState('load').catch(() => {});
    }
    let committedOrigin = '';
    if (typeof target.url === 'function') {
      try {
        committedOrigin = new URL(target.url()).origin;
      } catch {
      }
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

export async function openVerifiedServerNavigation(
  page: PageTargetLike,
  storage: StorageLike | undefined,
  input: ResolveVerifiedOpenInput,
  options: {
    gotoOptions?: unknown;
    navNonce?: string;
    probe?: (origin: string, options?: ProbeHandshakeOptions) => Promise<HandshakeProbeResult>;
    fetchImpl?: typeof fetch;
    requireMutualProof?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const resolved = await resolveVerifiedServerOpen(storage, input);
  if (!resolved.ok) {
    return { ...resolved, tokenDelivered: false };
  }
  await page.goto?.(resolved.finalEntry, options.gotoOptions);
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

export async function resolveVerifiedServerOpen(
  storage: StorageLike | undefined,
  input: ResolveVerifiedOpenInput,
): Promise<ResolveVerifiedOpenResult> {
  const signal = input?.signal;
  const isStale =
    typeof input?.isStale === 'function'
      ? () => Boolean(input.isStale?.() || signal?.aborted === true)
      : () => signal?.aborted === true;
  if (isStale()) {
    return { ok: false, stale: true, reason: 'aborted' };
  }
  const rawOriginInput = upgradeEndpointForTlsPin(input?.origin ?? '', input?.fingerprint);
  const parsedTarget = readTarget(rawOriginInput);
  if (!parsedTarget.ok) {
    return { ok: false, reason: parsedTarget.reason };
  }
  const origin = parsedTarget.origin;
  const entry = upgradeEndpointForTlsPin(input.entry ?? `${origin}/`, input.fingerprint);
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

  let claimedToken: string | undefined;
  if (typeof input.code === 'string' && input.code.trim() !== '') {
    const claim = await claimPairingOrigin(storage, {
      endpoint: input.endpoint ?? origin,
      origin,
      code: input.code,
      fingerprint: input.fingerprint,
      platform: input.platform,
      identity: input.identity,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
      saveToken: input.saveToken,
      nativeClaim: input.nativeClaim,
    });
    if (isStale()) {
      return { ok: false, stale: true, reason: 'aborted' };
    }
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
      const canProveVerifiedOrigin = Boolean(
        existing && targetServerId && isServerOriginVerified(existing, origin),
      );
      const rawKey = input.handshakeKey ?? input.handshakeProof;
      const handshakeKey =
        typeof rawKey === 'string' && HANDSHAKE_HEX_PROOF_PATTERN.test(rawKey.trim())
          ? rawKey.trim().toLowerCase()
          : undefined;
      const grantId =
        typeof existing?.grantId === 'string' && existing.grantId.trim() !== ''
          ? existing.grantId.trim()
          : typeof input.grantId === 'string' && input.grantId.trim() !== ''
            ? input.grantId.trim()
            : undefined;
      const requireMutualProof = Boolean(
        canProveVerifiedOrigin && (input.requireMutualProof || handshakeKey),
      );
      const expectedHomeId = existing?.targetHomeId ?? input.targetHomeId;
      const expectedHostId = existing?.targetHostId ?? input.targetHostId;
      const resolvedFingerprint = input.fingerprint ?? getServerFingerprint(existing, origin);
      const probeFn =
        input.probe ??
        ((targetOrigin: string, probeOptions?: ProbeHandshakeOptions) =>
          probeOriginHandshake(targetOrigin, {
            fetchImpl: input.fetchImpl,
            handshakeKey: probeOptions?.handshakeKey ?? probeOptions?.handshakeProof ?? handshakeKey,
            grantId: probeOptions?.grantId ?? grantId,
            targetHomeId: probeOptions?.targetHomeId ?? expectedHomeId,
            targetHostId: probeOptions?.targetHostId ?? expectedHostId,
            serverId: probeOptions?.serverId ?? targetServerId,
            requireMutualProof: Boolean(probeOptions?.requireMutualProof ?? requireMutualProof),
            signal: probeOptions?.signal ?? signal,
          }));
      const probe = await probeFn(
        origin,
        canProveVerifiedOrigin
          ? {
              serverId: targetServerId,
              targetHomeId: expectedHomeId,
              targetHostId: expectedHostId,
              grantId,
              fingerprint: resolvedFingerprint,
              handshakeKey,
              handshakeProof: handshakeKey,
              requireMutualProof,
              signal,
            }
          : { fingerprint: resolvedFingerprint, signal },
      );
      if (isStale() || probe?.aborted === true || probe?.reason === 'aborted') {
        return { ok: false, stale: true, reason: 'aborted' };
      }
      if (existing && targetServerId) {
        const verified = verifySavedServerOrigin(
          storage,
          targetServerId,
          origin,
          probe ? { ...probe, requireMutualProof } : probe,
        );
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

  if (isStale()) {
    return { ok: false, stale: true, reason: 'aborted' };
  }

  const saved = upsertSavedServer(storage, {
    id: existing?.id ?? input.serverId,
    origin,
    label: existing?.label ?? input.label,
    paired: isPairedTarget,
    targetHomeId: existing?.targetHomeId ?? input.targetHomeId,
    targetHostId: existing?.targetHostId ?? input.targetHostId,
    grantId: existing?.grantId ?? input.grantId,
    fingerprint: input.fingerprint ?? getServerFingerprint(existing, origin),
    verified: isPairedTarget,
  });
  const serverId = saved?.id ?? targetServerId;

  const finalEntry = isPairedTarget ? stripTokenFromEntry(origin, entry) : entry;
  const sessionToken =
    claimedToken ??
    (isPairedTarget && serverId && isServerOriginVerified(saved, origin) && typeof input.getToken === 'function'
      ? await input.getToken(serverId, origin)
      : undefined);

  if (isStale()) {
    return { ok: false, stale: true, reason: 'aborted' };
  }

  return {
    ok: true,
    origin,
    commitOrigin: origin,
    server: saved,
    serverId,
    finalEntry,
    sessionToken:
      typeof sessionToken === 'string' && sessionToken !== '' ? sessionToken : undefined,
    requireMutualProof: Boolean(
      isPairedTarget && (input.requireMutualProof || input.handshakeKey || input.handshakeProof),
    ),
    tokenAttached: false,
  };
}
