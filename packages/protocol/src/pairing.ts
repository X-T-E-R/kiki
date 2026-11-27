const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export const PAIRING_URI_PREFIX = 'kiki://pair';
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PAIRING_CODE_PATTERN = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{8}$`);
export const TLS_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
export const HANDSHAKE_NONCE_PATTERN = /^[a-f0-9]{32,128}$/i;
export const HANDSHAKE_HEX_PROOF_PATTERN = /^[a-f0-9]{64}$/i;

export const HANDSHAKE_HEADERS = {
  nonce: 'x-kiki-handshake-nonce',
  proof: 'x-kiki-handshake-proof',
  grant: 'x-kiki-handshake-grant',
  status: 'x-kiki-handshake-status',
} as const;

export const HANDSHAKE_DOMAINS = {
  req: 'kiki-handshake-req-v1',
  res: 'kiki-handshake-res-v1',
  revoked: 'kiki-handshake-revoked-v1',
  disabled: 'kiki-handshake-disabled-v1',
  invited: 'kiki-handshake-invited-v1',
} as const;

export type HandshakeStatus = 'approved' | 'revoked' | 'inbound_disabled' | 'invited';
export type HandshakeResponseDomain = 'res' | 'revoked' | 'disabled' | 'invited';

export type TargetParseErrorReason = 'empty' | 'invalid' | 'scheme' | 'credentials';

export type TargetParseResult =
  | { readonly ok: true; readonly origin: string; readonly entry: string }
  | { readonly ok: false; readonly reason: TargetParseErrorReason };

export interface ParsedPairingUri {
  readonly endpoint: string;
  readonly endpoints?: readonly string[];
  readonly relayEndpoints?: readonly string[];
  readonly code: string;
  readonly fingerprint?: string;
}

export type ScanPayloadResult =
  | {
      readonly ok: true;
      readonly kind: 'pair';
      readonly origin: string;
      readonly endpoint: string;
      readonly endpoints?: readonly string[];
      readonly relayEndpoints?: readonly string[];
      readonly code: string;
      readonly entry: string;
      readonly fingerprint?: string;
    }
  | {
      readonly ok: true;
      readonly kind: 'target';
      readonly origin: string;
      readonly entry: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'invalid_qr';
    };

export type ConnectInputResult =
  | {
      readonly ok: true;
      readonly kind: 'pair';
      readonly origin: string;
      readonly endpoint: string;
      readonly endpoints?: readonly string[];
      readonly relayEndpoints?: readonly string[];
      readonly code: string;
      readonly entry: string;
      readonly fingerprint?: string;
    }
  | {
      readonly ok: true;
      readonly kind: 'target';
      readonly origin: string;
      readonly entry: string;
    }
  | {
      readonly ok: false;
      readonly reason: TargetParseErrorReason | 'invalid_code';
    };

export type PastePayloadResult =
  | {
      readonly ok: true;
      readonly kind: 'pair';
      readonly origin: string;
      readonly endpoint: string;
      readonly endpoints?: readonly string[];
      readonly relayEndpoints?: readonly string[];
      readonly code: string;
      readonly entry: string;
      readonly fingerprint?: string;
    }
  | {
      readonly ok: true;
      readonly kind: 'target';
      readonly origin: string;
      readonly entry: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'empty' | 'invalid';
    };

export type PairInputResult =
  | {
      readonly ok: true;
      readonly kind: 'pair';
      readonly origin: string;
      readonly endpoint: string;
      readonly endpoints?: readonly string[];
      readonly relayEndpoints?: readonly string[];
      readonly code: string;
      readonly entry: string;
      readonly fingerprint?: string;
    }
  | {
      readonly ok: true;
      readonly kind: 'code';
      readonly code: string;
    }
  | {
      readonly ok: true;
      readonly kind: 'target';
      readonly origin: string;
      readonly entry: string;
    }
  | {
      readonly ok: false;
      readonly reason: TargetParseErrorReason | 'invalid_code';
    };

export type OriginLayer = 'lan' | 'vpn' | 'https' | 'http' | 'invalid';

export interface OriginClassification {
  readonly layer: OriginLayer;
  readonly protocol: 'http' | 'https';
  readonly host: string;
}

export interface MutualHandshakeChallengeInput {
  readonly handshakeKey?: string;
  readonly peerToken?: string;
  readonly grantId?: string;
  readonly nonce?: string;
}

export interface MutualHandshakeChallenge {
  readonly nonce: string;
  readonly grantId?: string;
  readonly requestProof: string;
  verifyResponse(responseProof: string, targetHomeId: string, targetHostId?: string): Promise<boolean>;
  verifyRevokedResponse(responseProof: string, targetHomeId: string, targetHostId?: string): Promise<boolean>;
  verifyDisabledResponse(responseProof: string, targetHomeId: string, targetHostId?: string): Promise<boolean>;
  verifyInvitedResponse(responseProof: string, targetHomeId: string, targetHostId?: string): Promise<boolean>;
  verifyStatusResponse(
    statusHeader: string | null | undefined,
    responseProof: string,
    targetHomeId: string,
    targetHostId?: string,
  ): Promise<HandshakeStatus | undefined>;
}

function parseIpv4Octets(hostname: string): readonly [number, number, number, number] | undefined {
  const parts = String(hostname ?? '').split('.');
  if (parts.length !== 4) return undefined;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const n = Number(part);
    if (n < 0 || n > 255) return undefined;
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isValidIpv6Address(raw: string): boolean {
  const value = String(raw ?? '').toLowerCase();
  if (value === '' || /[^0-9a-f:.]/.test(value)) return false;
  const doubleColonParts = value.split('::');
  if (doubleColonParts.length > 2) return false;
  const parseSide = (side: string, allowEmbeddedIpv4: boolean): { ok: boolean; groups: number } => {
    if (side === '') return { ok: true, groups: 0 };
    const tokens = side.split(':');
    let groups = 0;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (allowEmbeddedIpv4 && i === tokens.length - 1 && token.includes('.')) {
        if (parseIpv4Octets(token) === undefined) return { ok: false, groups: 0 };
        groups += 2;
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(token)) return { ok: false, groups: 0 };
        groups += 1;
      }
    }
    return { ok: true, groups };
  };
  if (doubleColonParts.length === 1) {
    const full = parseSide(doubleColonParts[0]!, true);
    return full.ok && full.groups === 8;
  }
  const left = parseSide(doubleColonParts[0]!, false);
  const right = parseSide(doubleColonParts[1]!, true);
  return left.ok && right.ok && left.groups + right.groups < 8;
}

export function isValidTlsFingerprint(raw: string): boolean {
  return TLS_FINGERPRINT_PATTERN.test(raw);
}

export function normalizeTlsFingerprint(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const clean = raw.trim().toLowerCase();
  return TLS_FINGERPRINT_PATTERN.test(clean) ? clean : undefined;
}

export function upgradeEndpointForTlsPin(
  endpoint: string,
  fingerprint?: string | null,
): string {
  if (normalizeTlsFingerprint(fingerprint) === undefined) return endpoint;
  const trimmed = String(endpoint ?? '').trim();
  if (!/^http:\/\//i.test(trimmed)) return endpoint;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:') return endpoint;
    const port = url.port || '80';
    url.protocol = 'https:';
    url.port = port;
    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}${url.search}${url.hash}`;
  } catch {
    return endpoint;
  }
}

export function isValidTargetHostname(hostname: string): boolean {
  const value = String(hostname ?? '');
  if (value === '' || value.length > 255) return false;
  if (value.startsWith('[') || value.endsWith(']')) {
    if (!value.startsWith('[') || !value.endsWith(']')) return false;
    return isValidIpv6Address(value.slice(1, -1));
  }
  if (value.startsWith('.')) return false;
  if (/^[0-9.]+$/.test(value)) {
    return parseIpv4Octets(value) !== undefined;
  }
  const dns = value.endsWith('.') ? value.slice(0, -1) : value;
  if (dns === '' || dns.length > 253 || dns.endsWith('.')) return false;
  const labels = dns.split('.');
  for (const label of labels) {
    if (!DNS_LABEL_PATTERN.test(label)) return false;
  }
  const lastLabel = labels.at(-1)!;
  if (/^\d+$/.test(lastLabel)) return false;
  return true;
}

export function isLoopbackHost(
  hostname: string,
  options?: { readonly allowSubdomains?: boolean },
): boolean {
  const trimmed = hostname.trim();
  if (trimmed === '') return false;
  const bare =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  const lower = bare.toLowerCase();
  if (lower === 'localhost' || lower === '::1') return true;
  if (options?.allowSubdomains === true && lower.endsWith('.localhost')) return true;
  const ipv4 = parseIpv4Octets(lower);
  return ipv4 !== undefined && ipv4[0] === 127;
}

export function isDirectConnectionHost(hostname: string): boolean {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const name = bare.toLowerCase();
  if (name === 'localhost' || name.endsWith('.local') || name.endsWith('.ts.net')) return true;
  if (name === '::1' || name.startsWith('fe80:')) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (match === null) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return false;
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function isLocalDefaultHost(host: string): boolean {
  if (!isValidTargetHostname(host)) return false;
  const lower = host.toLowerCase();
  if (lower.startsWith('[')) return true;
  if (parseIpv4Octets(lower) !== undefined) return true;
  const bare = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  return bare === 'localhost' || !bare.includes('.') || bare.endsWith('.local');
}

export function isVpnHost(hostname: string): boolean {
  if (!isValidTargetHostname(hostname)) return false;
  const lower = hostname.toLowerCase().replaceAll(/^\[|\]$/g, '');
  const bare = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  if (bare.endsWith('.ts.net') || bare.endsWith('.tailscale.net')) return true;
  if (lower.startsWith('fd7a:115c:a1e0:')) return true;
  const ipv4 = parseIpv4Octets(lower);
  if (ipv4 !== undefined) {
    return ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127;
  }
  return false;
}

export function isLanHost(hostname: string): boolean {
  if (!isValidTargetHostname(hostname)) return false;
  const lower = hostname.toLowerCase().replaceAll(/^\[|\]$/g, '');
  const bare = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  if (bare === 'localhost' || lower === '::1' || bare.endsWith('.local') || !bare.includes('.')) {
    if (!lower.includes(':') && parseIpv4Octets(lower) === undefined) return true;
  }
  if (lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
    return !lower.startsWith('fd7a:115c:a1e0:');
  }
  const ipv4 = parseIpv4Octets(lower);
  if (ipv4 !== undefined) {
    const [a, b] = ipv4;
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

function parseRawAuthorityHost(authority: string): string | undefined {
  if (authority === '') return undefined;
  let host: string;
  let port: string | undefined;
  if (authority.startsWith('[')) {
    const match = authority.match(/^(\[[^\]]+\])(?::([^/?#]*))?$/);
    if (!match) return undefined;
    host = match[1]!;
    port = match[2];
  } else {
    const match = authority.match(/^([^:]+)(?::([^/?#]*))?$/);
    if (!match) return undefined;
    host = match[1]!;
    port = match[2];
  }
  if (port !== undefined) {
    if (!/^\d{1,5}$/.test(port)) return undefined;
    const portNum = Number(port);
    if (portNum < 1 || portNum > 65535) return undefined;
  }
  if (!host.startsWith('[') && (host.startsWith('.') || host.endsWith('..') || host.includes('..') || host.includes('*'))) {
    return undefined;
  }
  if (!host.startsWith('[') && /^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+))*\.?$/i.test(host)) {
    if (parseIpv4Octets(host) === undefined) return undefined;
  }
  return host;
}

export function readTarget(raw: string): TargetParseResult {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: false, reason: 'empty' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  const schemeLower = hasScheme ? text.slice(0, text.indexOf(':')).toLowerCase() : '';
  if (hasScheme && schemeLower !== 'http' && schemeLower !== 'https') {
    return { ok: false, reason: 'scheme' };
  }
  const withoutScheme = hasScheme ? text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') : text;
  const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? '';
  if (authority.includes('@')) {
    try {
      const credCheck = new URL(hasScheme ? text : `http://${text}`);
      if (credCheck.username !== '' || credCheck.password !== '') {
        return { ok: false, reason: 'credentials' };
      }
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: false, reason: 'invalid' };
  }
  const rawHost = parseRawAuthorityHost(authority);
  if (rawHost === undefined) return { ok: false, reason: 'invalid' };
  let url: URL;
  try {
    if (hasScheme) {
      url = new URL(text);
    } else {
      url = new URL(`${isLocalDefaultHost(rawHost) ? 'http' : 'https'}://${text}`);
    }
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };
  if (!isValidTargetHostname(url.hostname)) return { ok: false, reason: 'invalid' };
  const carriesEntry = /(?:^#|&)access=/.test(url.hash) || url.searchParams.has('token');
  return { ok: true, origin: url.origin, entry: carriesEntry ? url.href : `${url.origin}/` };
}

export function displayOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' ? url.host : `${url.host} · http`;
  } catch {
    return origin;
  }
}

export function editableOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:' && isLocalDefaultHost(url.hostname)) {
      return url.origin;
    }
    return url.host;
  } catch {
    return origin;
  }
}

export function classifyOrigin(rawOrOrigin: string): OriginClassification {
  const target = readTarget(rawOrOrigin);
  if (!target.ok) {
    return { layer: 'invalid', protocol: 'http', host: '' };
  }
  const url = new URL(target.origin);
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  const hostname = url.hostname;
  if (isVpnHost(hostname)) {
    return { layer: 'vpn', protocol, host: url.host };
  }
  if (isLanHost(hostname)) {
    return { layer: 'lan', protocol, host: url.host };
  }
  return { layer: protocol === 'https' ? 'https' : 'http', protocol, host: url.host };
}

export function stripTokenFromEntry(origin: string, entry?: string): string {
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

export function normalizePairingCode(raw: string): string | undefined {
  const compact = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replaceAll(/[\s-]+/g, '');
  if (!PAIRING_CODE_PATTERN.test(compact)) return undefined;
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}`;
}

export function formatPairingCodeInput(raw: string): string {
  const compact = String(raw ?? '')
    .toUpperCase()
    .replaceAll(/[^0-9A-Z]/g, '')
    .slice(0, 8);
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

export function normalizePairingEndpoint(raw: string): string | undefined {
  const trimmed = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  const target = readTarget(trimmed);
  if (!target.ok) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (parsed.username !== '' || parsed.password !== '' || !isValidTargetHostname(parsed.hostname)) return undefined;
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${pathname}`;
  } catch {
    return undefined;
  }
}

export function normalizeRelayEndpoint(raw: string): string | undefined {
  const trimmed = String(raw ?? '').trim();
  if (!/^wss?:\/\//i.test(trimmed)) return undefined;
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'wss:' && protocol !== 'ws:') return undefined;
    if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') return undefined;
    if (!isValidTargetHostname(parsed.hostname)) return undefined;
    if (protocol === 'ws:' && !isDirectConnectionHost(parsed.hostname) && !isLoopbackHost(parsed.hostname)) {
      return undefined;
    }
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    const defaultPort = (protocol === 'wss:' && parsed.port === '443') || (protocol === 'ws:' && parsed.port === '80');
    const host = defaultPort ? parsed.hostname.toLowerCase() : parsed.host.toLowerCase();
    return `${protocol}//${host}${pathname}${parsed.search}`;
  } catch {
    return undefined;
  }
}

export function extractRelayTargetFingerprint(raw: string): string | undefined {
  const normalized = normalizeRelayEndpoint(raw);
  if (normalized === undefined) return undefined;
  try {
    const parsed = new URL(normalized);
    const queryTarget = normalizeTlsFingerprint(parsed.searchParams.get('target'));
    if (queryTarget !== undefined) return queryTarget;
    const connectMatch = /\/v1\/connect\/([a-f0-9]{64})$/i.exec(parsed.pathname);
    if (connectMatch !== null) return connectMatch[1]!.toLowerCase();
    return undefined;
  } catch {
    return undefined;
  }
}

function relayDisplayOrigin(relayUrl: string): string | undefined {
  try {
    const parsed = new URL(relayUrl);
    const scheme = parsed.protocol === 'ws:' ? 'http:' : 'https:';
    return `${scheme}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

export function formatPairingUri(input: {
  readonly endpoint: string;
  readonly endpoints?: readonly string[];
  readonly relayEndpoints?: readonly string[];
  readonly code: string;
  readonly fingerprint?: string;
}): string {
  const code = normalizePairingCode(input?.code ?? '');
  const fingerprint = input?.fingerprint;
  if (
    code === undefined ||
    (fingerprint !== undefined && !TLS_FINGERPRINT_PATTERN.test(fingerprint))
  ) {
    throw new Error('Invalid pairing URI payload');
  }
  const directCandidates: string[] = [];
  const primaryDirect = normalizePairingEndpoint(input?.endpoint ?? '');
  if (primaryDirect !== undefined) directCandidates.push(primaryDirect);
  for (const extra of input?.endpoints ?? []) {
    const normalized = normalizePairingEndpoint(extra);
    if (normalized !== undefined && !directCandidates.includes(normalized)) {
      directCandidates.push(normalized);
    }
  }
  const relayCandidates: string[] = [];
  const primaryAsRelay = primaryDirect === undefined ? normalizeRelayEndpoint(input?.endpoint ?? '') : undefined;
  if (primaryAsRelay !== undefined) relayCandidates.push(primaryAsRelay);
  for (const rawRelay of input?.relayEndpoints ?? []) {
    const normalized = normalizeRelayEndpoint(rawRelay);
    if (normalized === undefined) {
      throw new Error('Invalid pairing URI relay endpoint');
    }
    if (!relayCandidates.includes(normalized)) {
      relayCandidates.push(normalized);
    }
  }
  if (relayCandidates.length > 0 && fingerprint === undefined) {
    throw new Error('Relay pairing URI requires a TLS SPKI fingerprint');
  }
  if (directCandidates.length === 0 && relayCandidates.length === 0) {
    throw new Error('Invalid pairing URI payload');
  }
  const parts: string[] = [];
  for (const ep of directCandidates) {
    parts.push(`endpoint=${encodeURIComponent(ep)}`);
  }
  for (const relay of relayCandidates) {
    parts.push(`relay=${encodeURIComponent(relay)}`);
  }
  parts.push(`code=${encodeURIComponent(code)}`);
  if (fingerprint !== undefined) {
    parts.push(`fp=${encodeURIComponent(fingerprint)}`);
  }
  return `${PAIRING_URI_PREFIX}?${parts.join('&')}`;
}

export function parsePairingUri(raw: string): ParsedPairingUri | undefined {
  const text = String(raw ?? '').trim();
  if (!/^kiki:\/\/\/?pair(?:\?|$)/i.test(text)) return undefined;
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (
      url.protocol.toLowerCase() !== 'kiki:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.hash !== ''
    ) {
      return undefined;
    }
    if (!((host === 'pair' && (path === '' || path === '/')) || (host === '' && path === '/pair'))) {
      return undefined;
    }
    const rawEndpoints = url.searchParams.getAll('endpoint');
    const endpoints: string[] = [];
    for (const candidate of rawEndpoints) {
      const normalized = normalizePairingEndpoint(candidate);
      if (normalized !== undefined && !endpoints.includes(normalized)) {
        endpoints.push(normalized);
      }
    }
    const code = normalizePairingCode(url.searchParams.get('code') ?? '');
    const fingerprint = url.searchParams.get('fp') ?? undefined;
    if (code === undefined || (fingerprint !== undefined && !TLS_FINGERPRINT_PATTERN.test(fingerprint))) {
      return undefined;
    }
    const relayEndpoints: string[] = [];
    if (fingerprint !== undefined) {
      for (const candidate of url.searchParams.getAll('relay')) {
        const normalized = normalizeRelayEndpoint(candidate);
        if (normalized !== undefined && !relayEndpoints.includes(normalized)) {
          relayEndpoints.push(normalized);
        }
      }
      if (endpoints.length === 0) {
        for (const candidate of rawEndpoints) {
          const asRelay = normalizeRelayEndpoint(candidate);
          if (asRelay !== undefined && !relayEndpoints.includes(asRelay)) {
            relayEndpoints.push(asRelay);
          }
        }
      }
    }
    const endpoint = endpoints[0] ?? (fingerprint !== undefined ? relayEndpoints[0] : undefined);
    if (endpoint === undefined) {
      return undefined;
    }
    return {
      endpoint,
      code,
      ...(endpoints.length > 1 ? { endpoints } : {}),
      ...(relayEndpoints.length > 0 ? { relayEndpoints } : {}),
      ...(fingerprint === undefined ? {} : { fingerprint }),
    };
  } catch {
    return undefined;
  }
}

export function readScanPayload(raw: string): ScanPayloadResult {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: false, reason: 'invalid_qr' };
  const pair = parsePairingUri(text);
  if (pair !== undefined) {
    const asRelay = normalizeRelayEndpoint(pair.endpoint);
    if (asRelay !== undefined) {
      if (pair.fingerprint === undefined) return { ok: false, reason: 'invalid_qr' };
      const display = relayDisplayOrigin(asRelay);
      if (display === undefined) return { ok: false, reason: 'invalid_qr' };
      return {
        ok: true,
        kind: 'pair',
        origin: display,
        endpoint: asRelay,
        ...(pair.relayEndpoints === undefined ? { relayEndpoints: [asRelay] } : { relayEndpoints: pair.relayEndpoints }),
        code: pair.code,
        entry: `${display}/`,
        fingerprint: pair.fingerprint,
      };
    }
    const resolvedEndpoint = upgradeEndpointForTlsPin(pair.endpoint, pair.fingerprint);
    const target = readTarget(resolvedEndpoint);
    if (!target.ok) return { ok: false, reason: 'invalid_qr' };
    const upgradedEndpoints = pair.endpoints?.map((item) => upgradeEndpointForTlsPin(item, pair.fingerprint));
    return {
      ok: true,
      kind: 'pair',
      origin: target.origin,
      endpoint: resolvedEndpoint,
      ...(upgradedEndpoints !== undefined && upgradedEndpoints.length > 1 ? { endpoints: upgradedEndpoints } : {}),
      ...(pair.relayEndpoints !== undefined && pair.relayEndpoints.length > 0 ? { relayEndpoints: pair.relayEndpoints } : {}),
      code: pair.code,
      entry: `${target.origin}/`,
      ...(pair.fingerprint === undefined ? {} : { fingerprint: pair.fingerprint }),
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
    if (embeddedCode !== undefined) {
      const embeddedFp = url.searchParams.get('fp') ?? hashParams.get('fp');
      if (embeddedFp !== null && TLS_FINGERPRINT_PATTERN.test(embeddedFp)) {
        const upgradedEndpoint = upgradeEndpointForTlsPin(target.origin, embeddedFp);
        const upgradedTarget = readTarget(upgradedEndpoint);
        const finalOrigin = upgradedTarget.ok ? upgradedTarget.origin : target.origin;
        return {
          ok: true,
          kind: 'pair',
          origin: finalOrigin,
          endpoint: finalOrigin,
          code: embeddedCode,
          entry: `${finalOrigin}/`,
          fingerprint: embeddedFp,
        };
      }
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
    return {
      ok: true,
      kind: 'target',
      origin: target.origin,
      entry: target.entry,
    };
  }
  return {
    ok: true,
    kind: 'target',
    origin: target.origin,
    entry: target.entry,
  };
}

export function readConnectInput(rawAddress: string, rawCode = ''): ConnectInputResult {
  const addressText = String(rawAddress ?? '').trim();
  const codeText = String(rawCode ?? '').trim();
  if (/^kiki:\/\//i.test(addressText)) {
    const scanned = readScanPayload(addressText);
    if (!scanned.ok) return { ok: false, reason: 'invalid' };
    if (codeText !== '') {
      const overrideCode = normalizePairingCode(codeText);
      if (overrideCode === undefined) return { ok: false, reason: 'invalid_code' };
      const endpoint = scanned.kind === 'pair' ? scanned.endpoint : scanned.origin;
      const fingerprint = scanned.kind === 'pair' ? scanned.fingerprint : undefined;
      return {
        ok: true,
        kind: 'pair',
        origin: scanned.origin,
        endpoint,
        ...(scanned.kind === 'pair' && scanned.endpoints !== undefined ? { endpoints: scanned.endpoints } : {}),
        ...(scanned.kind === 'pair' && scanned.relayEndpoints !== undefined ? { relayEndpoints: scanned.relayEndpoints } : {}),
        code: overrideCode,
        entry: `${scanned.origin}/`,
        ...(fingerprint === undefined ? {} : { fingerprint }),
      };
    }
    return scanned;
  }
  const relayOnly = normalizeRelayEndpoint(addressText);
  if (relayOnly !== undefined) {
    if (codeText === '') return { ok: false, reason: 'scheme' };
    const code = normalizePairingCode(codeText);
    if (code === undefined) return { ok: false, reason: 'invalid_code' };
    const display = relayDisplayOrigin(relayOnly);
    if (display === undefined) return { ok: false, reason: 'invalid' };
    const fingerprint = extractRelayTargetFingerprint(relayOnly);
    return {
      ok: true,
      kind: 'pair',
      origin: display,
      endpoint: relayOnly,
      relayEndpoints: [relayOnly],
      code,
      entry: `${display}/`,
      ...(fingerprint === undefined ? {} : { fingerprint }),
    };
  }
  const target = readTarget(addressText);
  if (!target.ok) return target;
  if (codeText !== '') {
    const code = normalizePairingCode(codeText);
    if (code === undefined) return { ok: false, reason: 'invalid_code' };
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

export function readPastePayload(raw: string): PastePayloadResult {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: false, reason: 'empty' };
  const directScan = readScanPayload(text);
  if (directScan.ok) return directScan;
  const embeddedPair = text.match(/kiki:\/\/\/?pair\?[^\s"'<>]+/i);
  if (embeddedPair) {
    const cleaned = embeddedPair[0].replace(/[),.;!?]+$/, '');
    const scanned = readScanPayload(cleaned);
    if (scanned.ok) return scanned;
  }
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 2) {
    const combined = readConnectInput(tokens[0]!, tokens[1]!);
    if (combined.ok && combined.kind === 'pair') return combined;
  }
  const bare = readTarget(text);
  if (bare.ok) {
    return {
      ok: true,
      kind: 'target',
      origin: bare.origin,
      entry: bare.entry,
    };
  }
  return { ok: false, reason: 'invalid' };
}

export function parsePairInput(raw: string, rawCode?: string): PairInputResult {
  if (rawCode !== undefined && String(rawCode).trim() !== '') {
    return readConnectInput(raw, rawCode);
  }
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: false, reason: 'empty' };
  if (/^[a-z0-9]{4}[-\s][a-z0-9]{4}$/i.test(text)) {
    const code = normalizePairingCode(text);
    if (code !== undefined) {
      return { ok: true, kind: 'code', code };
    }
  }
  const pasted = readPastePayload(text);
  if (pasted.ok) return pasted;
  const bareTarget = readTarget(text);
  if (!bareTarget.ok) return bareTarget;
  return {
    ok: true,
    kind: 'target',
    origin: bareTarget.origin,
    entry: bareTarget.entry,
  };
}

export function handshakeRequestPreimage(nonce: string): string {
  return `${HANDSHAKE_DOMAINS.req}:${nonce.trim().toLowerCase()}`;
}

export function handshakeResponsePreimage(
  domain: HandshakeResponseDomain,
  nonce: string,
  targetHomeId: string,
  targetHostId = '',
): string {
  return `${HANDSHAKE_DOMAINS[domain]}:${nonce.trim().toLowerCase()}:${targetHomeId.trim()}:${String(targetHostId ?? '').trim()}`;
}

export function handshakeStatusToDomain(status: string | null | undefined): HandshakeResponseDomain | undefined {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (normalized === 'approved') return 'res';
  if (normalized === 'revoked') return 'revoked';
  if (normalized === 'inbound_disabled') return 'disabled';
  if (normalized === 'invited') return 'invited';
  return undefined;
}

export function handshakeDomainToStatus(domain: HandshakeResponseDomain): HandshakeStatus {
  if (domain === 'res') return 'approved';
  if (domain === 'revoked') return 'revoked';
  if (domain === 'disabled') return 'inbound_disabled';
  return 'invited';
}

function randomHex(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256BytesHex(bytes: Uint8Array): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') return undefined;
  try {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const buf = await subtle.digest('SHA-256', copy.buffer);
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

export async function sha256Hex(value: string): Promise<string | undefined> {
  if (typeof value !== 'string' || value === '') return undefined;
  return sha256BytesHex(new TextEncoder().encode(value));
}

export async function hmacSha256Hex(keyString: string, message: string): Promise<string | undefined> {
  if (typeof keyString !== 'string' || keyString === '') return undefined;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.importKey !== 'function' || typeof subtle.sign !== 'function') {
    return undefined;
  }
  try {
    const encoder = new TextEncoder();
    const cryptoKey = await subtle.importKey(
      'raw',
      encoder.encode(keyString),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await subtle.sign('HMAC', cryptoKey, encoder.encode(message));
    return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

export function constantTimeHexEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const cleanA = a.trim().toLowerCase();
  const cleanB = b.trim().toLowerCase();
  if (cleanA.length !== cleanB.length || cleanA.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < cleanA.length; i += 1) {
    diff |= (cleanA.codePointAt(i) ?? 0) ^ (cleanB.codePointAt(i) ?? 0);
  }
  return diff === 0;
}

export async function computeHandshakeProof(peerToken: string, nonce = ''): Promise<string | undefined> {
  if (typeof peerToken !== 'string' || peerToken.trim() === '') return undefined;
  const keyHex = await sha256Hex(peerToken);
  if (keyHex === undefined) return undefined;
  if (typeof nonce === 'string' && HANDSHAKE_NONCE_PATTERN.test(nonce.trim())) {
    return hmacSha256Hex(keyHex, handshakeRequestPreimage(nonce));
  }
  return keyHex;
}

export async function createMutualHandshakeChallenge(
  input: MutualHandshakeChallengeInput = {},
): Promise<MutualHandshakeChallenge | undefined> {
  const rawKey =
    typeof input.handshakeKey === 'string' && HANDSHAKE_HEX_PROOF_PATTERN.test(input.handshakeKey.trim())
      ? input.handshakeKey.trim().toLowerCase()
      : typeof input.peerToken === 'string' && input.peerToken.trim() !== ''
        ? await computeHandshakeProof(input.peerToken)
        : undefined;
  if (rawKey === undefined) return undefined;
  const nonce =
    typeof input.nonce === 'string' && HANDSHAKE_NONCE_PATTERN.test(input.nonce.trim())
      ? input.nonce.trim().toLowerCase()
      : randomHex(16);
  const requestProof = await hmacSha256Hex(rawKey, handshakeRequestPreimage(nonce));
  if (requestProof === undefined) return undefined;
  const grantId =
    typeof input.grantId === 'string' && input.grantId.trim() !== ''
      ? input.grantId.trim()
      : undefined;

  const verifyDomainResponse = async (
    domain: HandshakeResponseDomain,
    responseProof: string,
    targetHomeId: string,
    targetHostId = '',
  ): Promise<boolean> => {
    if (typeof responseProof !== 'string' || !HANDSHAKE_HEX_PROOF_PATTERN.test(responseProof.trim())) {
      return false;
    }
    if (typeof targetHomeId !== 'string' || targetHomeId.trim() === '') {
      return false;
    }
    const expected = await hmacSha256Hex(
      rawKey,
      handshakeResponsePreimage(domain, nonce, targetHomeId, targetHostId),
    );
    if (expected === undefined) return false;
    return constantTimeHexEqual(responseProof, expected);
  };

  return {
    nonce,
    grantId,
    requestProof,
    verifyResponse(responseProof, targetHomeId, targetHostId = '') {
      return verifyDomainResponse('res', responseProof, targetHomeId, targetHostId);
    },
    verifyRevokedResponse(responseProof, targetHomeId, targetHostId = '') {
      return verifyDomainResponse('revoked', responseProof, targetHomeId, targetHostId);
    },
    verifyDisabledResponse(responseProof, targetHomeId, targetHostId = '') {
      return verifyDomainResponse('disabled', responseProof, targetHomeId, targetHostId);
    },
    verifyInvitedResponse(responseProof, targetHomeId, targetHostId = '') {
      return verifyDomainResponse('invited', responseProof, targetHomeId, targetHostId);
    },
    async verifyStatusResponse(statusHeader, responseProof, targetHomeId, targetHostId = '') {
      const hasHeader = typeof statusHeader === 'string' && statusHeader.trim() !== '';
      if (hasHeader) {
        const expectedDomain = handshakeStatusToDomain(statusHeader);
        if (expectedDomain === undefined) return undefined;
        const ok = await verifyDomainResponse(expectedDomain, responseProof, targetHomeId, targetHostId);
        return ok ? handshakeDomainToStatus(expectedDomain) : undefined;
      }
      const domains: readonly HandshakeResponseDomain[] = ['res', 'revoked', 'disabled', 'invited'];
      for (const domain of domains) {
        if (await verifyDomainResponse(domain, responseProof, targetHomeId, targetHostId)) {
          return handshakeDomainToStatus(domain);
        }
      }
      return undefined;
    },
  };
}
