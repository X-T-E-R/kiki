import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { mergeConfigCredentials } from '@kiki/agent-core-v2/app/config/credentials';
import { readBundledPluginCatalog } from '@kiki/agent-core-v2/app/plugin/defaultCatalog';
import type { PortableSpaceDomain, PortableSpaceExcludedItem } from '@kiki/protocol';
import { sameUnit, type VerifiedBase } from './mergeEngine';
import { encodeToml, domainForFile, hasBundledPluginManifest, isPortablePluginId, object, parseToml, PLAIN, type Data, type Units } from './treeProjection';
import { safePortablePath } from './tarArchive';
import { RECIPE_INSTALLATIONS, readRecipeInstallations, installBytes } from './recipeStore';

type SubscriptionUnit = Units extends Map<string, infer U> ? U : never;

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const DIRECT_FALLBACK_TIMEOUT_MS = 8_000;
const DOH_TIMEOUT_MS = 4_000;
const DOH_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ETAG_LENGTH = 512;

const DOH_ENDPOINTS: readonly { readonly host: string; readonly path: string; readonly budgetMs: number }[] = [
  { host: '223.5.5.5', path: '/resolve', budgetMs: 1_500 },
  { host: '1.12.12.12', path: '/resolve', budgetMs: 1_200 },
  { host: '1.1.1.1', path: '/dns-query', budgetMs: 1_300 },
];

const BLOCKED_CONFIG_SECTIONS = ['hooks', 'agent_executors', 'agent_executor_instances'] as const;
const ALLOWED_REMOTE_MCP_SECRET_KEYS = new Set(['headers', 'token', 'bearerToken', 'apiKey']);

const USER_KEEP_CONFIG_IDS = new Set([
  'config:default_model',
  'config:default_provider',
  'config:default_permission_mode',
  'config:default_plan_mode',
  'config:thinking',
  'config:fast_model',
  'config:session_title',
  'config:disabled_skills',
  'config:disabled_named_profiles',
]);

const PARTIAL_MERGE_NESTED_KEYS: Readonly<Record<string, Readonly<Record<string, ReadonlySet<string>>>>> = {
  'config:permission': {
    reviewer: new Set(['backend', 'source']),
  },
  'config:memory': {
    advisor: new Set(['mode', 'source']),
  },
};

const BLOCKED_REMOTE_DOMAINS = new Set<PortableSpaceDomain>([
  'sessions',
  'memories',
  'skills',
]);

const USER_KEEP_DOMAINS = new Set<PortableSpaceDomain>([
  'appearance',
]);

export interface UrlSafetyOptions {
  readonly allowLoopback?: boolean;
  readonly lookupFn?: (hostname: string) => Promise<readonly { readonly address: string; readonly family?: number }[]>;
  readonly dohResolveFn?: (
    hostname: string,
    signal?: AbortSignal,
  ) => Promise<readonly { readonly address: string; readonly family?: number }[]>;
}

export interface PinnedHttpResponse {
  readonly status: number;
  readonly etag?: string;
  readonly location?: string;
  readonly bytes: Buffer;
}

export interface UrlFetchOptions extends UrlSafetyOptions {
  readonly ifNoneMatch?: string;
  readonly ifNoneMatchOrigin?: string;
  readonly fetchFn?: typeof fetch;
  readonly pinnedFetchFn?: (
    target: { readonly url: URL; readonly address: string; readonly family: 4 | 6 },
    headers: Record<string, string>,
    signal: AbortSignal,
  ) => Promise<PinnedHttpResponse>;
  readonly signal?: AbortSignal;
}

export type UrlFetchResult =
  | { readonly status: 'not_modified'; readonly etag?: string; readonly finalOrigin: string }
  | { readonly status: 'ok'; readonly bytes: Buffer; readonly etag?: string; readonly finalOrigin: string };

export interface SubscriptionMergeResult {
  readonly nextUnits: Units;
  readonly nextBaseUnits: Units;
  readonly nextManagedIds: string[];
  readonly appliedIds: string[];
  readonly deletedIds: string[];
  readonly skippedIds: string[];
}

interface ResolvedIpTarget {
  readonly address: string;
  readonly family: 4 | 6;
}

interface SafeSubscriptionTarget {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
  readonly isLoopback: boolean;
  readonly dohVerified?: boolean;
  readonly fallbackAddresses?: readonly ResolvedIpTarget[];
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isExplicitLoopbackHost(hostname: string): boolean {
  const bare = stripBrackets(hostname).toLowerCase();
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function parseMappedIpv4(bare: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (dotted !== null) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(bare);
  if (hex !== null) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return undefined;
}

function isBlockedIp(rawIp: string): boolean {
  const bare = stripBrackets(rawIp).split('%')[0]!.toLowerCase();
  const kind = isIP(bare);
  if (kind === 4) return isBlockedIpv4(bare);
  if (kind !== 6) return true;
  if (bare === '::' || bare === '::1' || /^0{0,4}(?::0{0,4})*:0{0,3}[01]$/.test(bare)) return true;
  const mapped = parseMappedIpv4(bare);
  if (mapped !== undefined) return isBlockedIpv4(mapped);
  const first = bare.split(':')[0] ?? '';
  if (/^f[cd][0-9a-f]{0,2}$/.test(first)) return true;
  if (/^fe[89ab][0-9a-f]?$/.test(first)) return true;
  if (/^ff[0-9a-f]{0,2}$/.test(first)) return true;
  return false;
}

function isFakeIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 198 && (b === 18 || b === 19);
}

function isFakeIpAddress(rawIp: string): boolean {
  const bare = stripBrackets(rawIp).split('%')[0]!.toLowerCase();
  const kind = isIP(bare);
  if (kind === 4) return isFakeIpv4(bare);
  if (kind !== 6) return false;
  const mapped = parseMappedIpv4(bare);
  return mapped !== undefined && isFakeIpv4(mapped);
}

interface DohJsonResponse {
  readonly Status?: unknown;
  readonly Answer?: unknown;
}

function queryDohRecord(
  endpoint: { readonly host: string; readonly path: string },
  hostname: string,
  recordType: 'A' | 'AAAA',
  signal: AbortSignal,
): Promise<{ readonly status: number; readonly addresses: ResolvedIpTarget[] }> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('DoH lookup aborted'));
      return;
    }
    const queryPath = `${endpoint.path}?name=${encodeURIComponent(hostname)}&type=${recordType}`;
    const req = httpsRequest(
      {
        host: endpoint.host,
        port: 443,
        path: queryPath,
        method: 'GET',
        headers: { accept: 'application/dns-json' },
        signal,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          rejectPromise(new Error(`DoH HTTP ${statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > DOH_MAX_RESPONSE_BYTES) {
            res.destroy();
            rejectPromise(new Error('DoH response exceeds size limit'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (error) => rejectPromise(error));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as DohJsonResponse;
            const dnsStatus = typeof parsed.Status === 'number' ? parsed.Status : -1;
            const expectedType = recordType === 'A' ? 1 : 28;
            const expectedFamily: 4 | 6 = recordType === 'A' ? 4 : 6;
            const addresses: ResolvedIpTarget[] = [];
            if (Array.isArray(parsed.Answer)) {
              for (const rawEntry of parsed.Answer) {
                if (rawEntry === null || typeof rawEntry !== 'object') continue;
                const entry = rawEntry as { readonly type?: unknown; readonly data?: unknown };
                if (entry.type !== expectedType || typeof entry.data !== 'string') continue;
                const clean = stripBrackets(entry.data.trim());
                if (isIP(clean) === expectedFamily) {
                  addresses.push({ address: clean, family: expectedFamily });
                }
              }
            }
            resolvePromise({ status: dnsStatus, addresses });
          } catch (error) {
            rejectPromise(error instanceof Error ? error : new Error('Invalid DoH JSON'));
          }
        });
      },
    );
    req.on('error', (error) => rejectPromise(error));
    req.end();
  });
}

async function resolvePublicHostViaDoH(hostname: string, outerSignal?: AbortSignal): Promise<readonly ResolvedIpTarget[]> {
  const overall = overallSignal(outerSignal, DOH_TIMEOUT_MS);
  const deadline = Date.now() + DOH_TIMEOUT_MS;
  for (const endpoint of DOH_ENDPOINTS) {
    if (overall.aborted) break;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 50) break;
    const stepSignal = AbortSignal.any([overall, AbortSignal.timeout(Math.min(endpoint.budgetMs, remainingMs))]);
    const [aResult, aaaaResult] = await Promise.allSettled([
      queryDohRecord(endpoint, hostname, 'A', stepSignal),
      queryDohRecord(endpoint, hostname, 'AAAA', stepSignal),
    ]);
    if (aResult.status !== 'fulfilled' || aaaaResult.status !== 'fulfilled') continue;
    const aStatus = aResult.value.status;
    const aaaaStatus = aaaaResult.value.status;
    if ((aStatus !== 0 && aStatus !== 3) || (aaaaStatus !== 0 && aaaaStatus !== 3)) continue;
    const dedup = new Map<string, ResolvedIpTarget>();
    for (const item of [...aResult.value.addresses, ...aaaaResult.value.addresses]) {
      if (!dedup.has(item.address)) dedup.set(item.address, item);
    }
    return [...dedup.values()];
  }
  return [];
}

function parseNoProxyHost(entry: string): { readonly host: string; readonly port?: string } {
  let host = entry;
  let port: string | undefined;
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    if (close > 0) {
      host = entry.slice(1, close);
      const rest = entry.slice(close + 1);
      if (rest.startsWith(':')) port = rest.slice(1);
    }
  } else {
    const colon = entry.indexOf(':');
    if (colon !== -1 && colon === entry.lastIndexOf(':') && /^\d+$/.test(entry.slice(colon + 1))) {
      host = entry.slice(0, colon);
      port = entry.slice(colon + 1);
    }
  }
  if (host.startsWith('*.')) host = host.slice(2);
  else if (host.startsWith('.')) host = host.slice(1);
  return port === undefined ? { host } : { host, port };
}

function hasConfiguredProxyForUrl(targetUrl: URL, env: NodeJS.ProcessEnv = process.env): boolean {
  const proxyRaw = targetUrl.protocol === 'https:'
    ? env['HTTPS_PROXY'] ?? env['https_proxy'] ?? env['ALL_PROXY'] ?? env['all_proxy']
    : env['HTTP_PROXY'] ?? env['http_proxy'] ?? env['ALL_PROXY'] ?? env['all_proxy'];
  if (proxyRaw === undefined || proxyRaw.trim().length === 0) return false;
  const noProxyRaw = env['NO_PROXY'] ?? env['no_proxy'] ?? '';
  const entries = noProxyRaw.split(',').map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0);
  if (entries.includes('*')) return false;
  const host = stripBrackets(targetUrl.hostname).toLowerCase();
  const port = targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80');
  for (const entry of entries) {
    const parsed = parseNoProxyHost(entry);
    if (parsed.port !== undefined && parsed.port !== port) continue;
    if (host === parsed.host || host.endsWith(`.${parsed.host}`)) return false;
  }
  return true;
}

/** Sanitizes an HTTP ETag validator value, stripping unsafe header characters and bounding length. */
export function sanitizeEtag(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ETAG_LENGTH) return undefined;
  if (/[\r\n\0]/.test(trimmed)) return undefined;
  return trimmed;
}

async function resolveSafeSubscriptionTarget(
  rawUrl: string,
  options: UrlSafetyOptions = {},
  signal?: AbortSignal,
): Promise<SafeSubscriptionTarget> {
  if (!URL.canParse(rawUrl)) throw new Error('Invalid subscription URL');
  const parsed = new URL(rawUrl);
  if (parsed.username || parsed.password) {
    throw new Error('Subscription URL must not embed credentials');
  }
  const explicitLoopback = isExplicitLoopbackHost(parsed.hostname);
  const allowLoopback = options.allowLoopback === true;
  if (parsed.protocol === 'http:') {
    if (!explicitLoopback || !allowLoopback) throw new Error('Subscription URL must use HTTPS');
  } else if (parsed.protocol !== 'https:') {
    throw new Error('Subscription URL must use HTTPS');
  }
  const bare = stripBrackets(parsed.hostname);
  if (explicitLoopback) {
    if (!allowLoopback) throw new Error('Subscription URL target address is blocked');
    const loopbackAddress = bare.toLowerCase() === '::1' ? '::1' : '127.0.0.1';
    const loopbackFamily: 4 | 6 = loopbackAddress === '::1' ? 6 : 4;
    return { url: parsed, address: loopbackAddress, family: loopbackFamily, isLoopback: true };
  }
  const ipKind = isIP(bare);
  if (ipKind !== 0) {
    if (isBlockedIp(bare)) throw new Error('Subscription URL target address is blocked');
    return { url: parsed, address: bare, family: ipKind === 6 ? 6 : 4, isLoopback: false };
  }
  const resolver = options.lookupFn ?? ((host: string) => lookup(host, { all: true }));
  const records = await resolver(bare);
  if (records.length === 0) throw new Error('Subscription URL host could not be resolved');
  const fakeIpRecords: ResolvedIpTarget[] = [];
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      if (isFakeIpAddress(record.address)) {
        const clean = stripBrackets(record.address);
        const fam: 4 | 6 = record.family === 6 || isIP(clean) === 6 ? 6 : 4;
        fakeIpRecords.push({ address: clean, family: fam });
        continue;
      }
      throw new Error('Subscription URL resolved to a blocked private address');
    }
  }
  if (fakeIpRecords.length > 0) {
    if (options.lookupFn !== undefined && options.dohResolveFn === undefined) {
      throw new Error('Subscription URL resolved to a blocked private address');
    }
    const dohResolver = options.dohResolveFn ?? resolvePublicHostViaDoH;
    let verifiedRecords: readonly { readonly address: string; readonly family?: number }[];
    try {
      verifiedRecords = await dohResolver(bare, signal);
    } catch {
      throw new Error('Subscription URL resolved to a blocked private address');
    }
    if (verifiedRecords.length === 0) {
      throw new Error('Subscription URL resolved to a blocked private address');
    }
    const publicTargets: ResolvedIpTarget[] = [];
    for (const record of verifiedRecords) {
      const clean = stripBrackets(record.address);
      const kind = isIP(clean);
      if (kind === 0 || isBlockedIp(clean)) {
        throw new Error('Subscription URL resolved to a blocked private address');
      }
      publicTargets.push({ address: clean, family: kind === 6 ? 6 : 4 });
    }
    const primary = publicTargets[0]!;
    return {
      url: parsed,
      address: primary.address,
      family: primary.family,
      isLoopback: false,
      dohVerified: true,
      fallbackAddresses: [...publicTargets.slice(1), ...fakeIpRecords],
    };
  }
  const first = records[0]!;
  const family: 4 | 6 = first.family === 6 || isIP(stripBrackets(first.address)) === 6 ? 6 : 4;
  return { url: parsed, address: stripBrackets(first.address), family, isLoopback: false };
}

/** Validates a subscription URL against SSRF rules; permits HTTPS public hosts and optional test-only loopback. */
export async function assertSafeSubscriptionUrl(
  rawUrl: string,
  options?: UrlSafetyOptions | ((hostname: string) => Promise<readonly { readonly address: string }[]>),
): Promise<URL> {
  const normalized: UrlSafetyOptions = typeof options === 'function' ? { lookupFn: options } : (options ?? {});
  const target = await resolveSafeSubscriptionTarget(rawUrl, normalized);
  return target.url;
}

/** Derives a safe display label from a subscription URL using only its hostname so path tokens never leak. */
export function defaultLabelForSubscriptionUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.slice(0, 256) || 'URL Subscription';
  } catch {
    return 'URL Subscription';
  }
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null) {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
      throw new Error('Subscription archive exceeds maximum size limit');
    }
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      throw new Error('Subscription archive exceeds maximum size limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function fetchPinnedTarget(
  target: Pick<SafeSubscriptionTarget, 'url' | 'address' | 'family'>,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<PinnedHttpResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('Subscription fetch aborted'));
      return;
    }
    const requester = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requester(
      target.url,
      {
        method: 'GET',
        headers,
        signal,
        lookup: (_hostname, opts, cb) => {
          if (opts !== undefined && typeof opts === 'object' && opts.all === true) {
            cb(null, [{ address: target.address, family: target.family }] as never);
          } else {
            cb(null, target.address, target.family);
          }
        },
        ...(target.url.protocol === 'https:' ? { servername: stripBrackets(target.url.hostname) } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const etagHeader = typeof res.headers.etag === 'string' ? res.headers.etag : undefined;
        const locationHeader = typeof res.headers.location === 'string' ? res.headers.location : undefined;
        if (status === 304 || (status >= 300 && status < 400)) {
          res.resume();
          resolvePromise({
            status,
            etag: sanitizeEtag(etagHeader),
            location: locationHeader,
            bytes: Buffer.alloc(0),
          });
          return;
        }
        const lengthHeader = typeof res.headers['content-length'] === 'string' ? res.headers['content-length'] : undefined;
        if (lengthHeader !== undefined) {
          const declared = Number(lengthHeader);
          if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
            res.destroy();
            rejectPromise(new Error('Subscription archive exceeds maximum size limit'));
            return;
          }
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > MAX_ARCHIVE_BYTES) {
            res.destroy();
            rejectPromise(new Error('Subscription archive exceeds maximum size limit'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (error) => rejectPromise(error));
        res.on('end', () => {
          resolvePromise({
            status,
            etag: sanitizeEtag(etagHeader),
            location: locationHeader,
            bytes: Buffer.concat(chunks, total),
          });
        });
      },
    );
    req.on('error', (error) => rejectPromise(error));
    req.end();
  });
}

function isNonRetryableFetchError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Subscription archive exceeds maximum size limit';
}

async function fetchPinnedTargetWithFallback(
  target: SafeSubscriptionTarget,
  headers: Record<string, string>,
  signal: AbortSignal,
  pinnedFetch: (
    target: { readonly url: URL; readonly address: string; readonly family: 4 | 6 },
    headers: Record<string, string>,
    signal: AbortSignal,
  ) => Promise<PinnedHttpResponse> = fetchPinnedTarget,
): Promise<PinnedHttpResponse> {
  const candidates: ResolvedIpTarget[] = [
    { address: target.address, family: target.family },
    ...(target.fallbackAddresses ?? []),
  ];
  const allowProxyFallback = target.dohVerified === true
    && !target.isLoopback
    && target.url.protocol === 'https:'
    && isIP(stripBrackets(target.url.hostname)) === 0
    && hasConfiguredProxyForUrl(target.url);
  let lastError: unknown;
  for (let i = 0; i < candidates.length; i++) {
    throwIfAborted(signal);
    const candidate = candidates[i]!;
    const hasMoreAttempts = i < candidates.length - 1 || allowProxyFallback;
    const attemptSignal = hasMoreAttempts
      ? AbortSignal.any([signal, AbortSignal.timeout(DIRECT_FALLBACK_TIMEOUT_MS)])
      : signal;
    try {
      return await pinnedFetch(
        { url: target.url, address: candidate.address, family: candidate.family },
        headers,
        attemptSignal,
      );
    } catch (error) {
      if (signal.aborted || isNonRetryableFetchError(error)) throw error;
      lastError = error;
    }
  }
  if (allowProxyFallback) {
    throwIfAborted(signal);
    const response = await fetch(target.url.toString(), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal,
    });
    const status = response.status;
    const etag = sanitizeEtag(response.headers.get('etag'));
    const location = response.headers.get('location') ?? undefined;
    const bytes = status === 304 || (status >= 300 && status < 400) || !response.ok
      ? Buffer.alloc(0)
      : await readBoundedResponse(response);
    return { status, etag, location, bytes };
  }
  throw lastError instanceof Error ? lastError : new Error('Subscription fetch failed');
}

function overallSignal(outer: AbortSignal | undefined, deadlineMs = FETCH_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(deadlineMs);
  return outer === undefined ? timeout : AbortSignal.any([outer, timeout]);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Subscription fetch timed out or aborted');
  }
}

/** Fetches a remote subscription archive with DNS-pinned SSRF checks, single overall 30s deadline, redirect validation, size bounds, and origin-bound If-None-Match 304 support. */
export async function fetchSubscriptionArchive(rawUrl: string, options: UrlFetchOptions = {}): Promise<UrlFetchResult> {
  const signal = overallSignal(options.signal);
  throwIfAborted(signal);
  const initialTarget = await resolveSafeSubscriptionTarget(rawUrl, options, signal);
  throwIfAborted(signal);
  const redirectAllowLoopback = options.allowLoopback === true && initialTarget.isLoopback;
  let currentTarget = initialTarget;
  const normalizedIfNoneMatch = sanitizeEtag(options.ifNoneMatch);
  const expectedEtagOrigin = (options.ifNoneMatchOrigin ?? initialTarget.url.origin).toLowerCase();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    throwIfAborted(signal);
    const currentOrigin = currentTarget.url.origin.toLowerCase();
    const headers: Record<string, string> = { accept: 'application/gzip, application/octet-stream, */*' };
    const sentIfNoneMatch = normalizedIfNoneMatch !== undefined && currentOrigin === expectedEtagOrigin;
    if (sentIfNoneMatch) {
      headers['if-none-match'] = normalizedIfNoneMatch;
    }

    let status: number;
    let etag: string | undefined;
    let location: string | undefined;
    let bytes: Buffer;

    if (options.fetchFn !== undefined) {
      const response = await options.fetchFn(currentTarget.url.toString(), {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal,
      });
      status = response.status;
      etag = sanitizeEtag(response.headers.get('etag'));
      location = response.headers.get('location') ?? undefined;
      if (status === 304 || (status >= 300 && status < 400)) {
        bytes = Buffer.alloc(0);
      } else if (response.ok) {
        bytes = await readBoundedResponse(response);
      } else {
        bytes = Buffer.alloc(0);
      }
    } else {
      const pinned = await fetchPinnedTargetWithFallback(
        currentTarget,
        headers,
        signal,
        options.pinnedFetchFn,
      );
      status = pinned.status;
      etag = pinned.etag;
      location = pinned.location;
      bytes = pinned.bytes;
    }

    if (status === 304) {
      if (!sentIfNoneMatch) {
        throw new Error('Unexpected 304 Not Modified response without If-None-Match');
      }
      return { status: 'not_modified', etag: etag ?? normalizedIfNoneMatch, finalOrigin: currentOrigin };
    }
    if (status >= 300 && status < 400) {
      if (!location) throw new Error(`Subscription redirect missing Location (HTTP ${status})`);
      if (hop === MAX_REDIRECTS) throw new Error('Too many redirects fetching subscription');
      const nextUrl = new URL(location, currentTarget.url).toString();
      currentTarget = await resolveSafeSubscriptionTarget(nextUrl, {
        allowLoopback: redirectAllowLoopback,
        lookupFn: options.lookupFn,
        dohResolveFn: options.dohResolveFn,
      }, signal);
      continue;
    }
    if (status < 200 || status >= 300) {
      throw new Error(`Subscription fetch failed with HTTP ${status}`);
    }
    return { status: 'ok', bytes, etag, finalOrigin: currentOrigin };
  }
  throw new Error('Too many redirects fetching subscription');
}

function stripRecipeHooksFromToml(bytes: Buffer): { readonly bytes: Buffer; readonly stripped: boolean } {
  let data: Data;
  try {
    data = parseToml(bytes);
  } catch {
    return { bytes, stripped: false };
  }
  if (!Object.hasOwn(data, 'hooks')) return { bytes, stripped: false };
  delete data['hooks'];
  return { bytes: encodeToml(data), stripped: true };
}

function isExecutableMcpEntry(entry: Data): boolean {
  return entry['command'] !== undefined
    || entry['args'] !== undefined
    || entry['cwd'] !== undefined
    || entry['type'] === 'stdio';
}

export interface OfficialCatalogPlugin {
  readonly id: string;
  readonly source: string;
  readonly sha256?: string;
}

let cachedOfficialPlugins: ReadonlyMap<string, OfficialCatalogPlugin> | undefined;

/** Looks up a compiled-in official Kiki plugin by ID without network access or trusting remote sources. */
export function findBundledOfficialPlugin(id: string): OfficialCatalogPlugin | undefined {
  if (cachedOfficialPlugins === undefined) {
    const map = new Map<string, OfficialCatalogPlugin>();
    for (const entry of readBundledPluginCatalog().marketplace.plugins) {
      if (entry.tier === 'official' && typeof entry.source === 'string' && entry.source.length > 0) {
        map.set(entry.id, {
          id: entry.id,
          source: entry.source,
          ...(typeof entry.sha256 === 'string' && entry.sha256.length > 0 ? { sha256: entry.sha256 } : {}),
        });
      }
    }
    cachedOfficialPlugins = map;
  }
  return cachedOfficialPlugins.get(id);
}

function isSameOriginPinnedPluginZip(
  rawSource: unknown,
  rawSha256: unknown,
  subscriptionOrigin: string | undefined,
): { readonly source: string; readonly sha256: string } | undefined {
  if (typeof rawSource !== 'string' || typeof rawSha256 !== 'string' || subscriptionOrigin === undefined) {
    return undefined;
  }
  const source = rawSource.trim();
  const sha256 = rawSha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256) || !URL.canParse(source)) return undefined;
  const parsed = new URL(source);
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return undefined;
  if (!/\.zip$/i.test(parsed.pathname)) return undefined;
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(subscriptionOrigin).origin.toLowerCase();
  } catch {
    return undefined;
  }
  if (!expectedOrigin.startsWith('https://') || parsed.origin.toLowerCase() !== expectedOrigin) {
    return undefined;
  }
  return { source, sha256 };
}

function validateBundledPluginManifestName(
  pluginId: string,
  files: ReadonlyMap<string, Buffer>,
): string | undefined {
  for (const manifestFile of [`plugins/${pluginId}/kimi.plugin.json`, `plugins/${pluginId}/package.json`]) {
    const rawBytes = files.get(manifestFile);
    if (rawBytes === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBytes.toString('utf8'));
    } catch {
      return `Invalid JSON in ${manifestFile}`;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return `Invalid manifest object in ${manifestFile}`;
    }
    const rawName = (parsed as Record<string, unknown>)['name'];
    if (typeof rawName === 'string' && rawName.trim().length > 0) {
      const normalized = rawName.trim().toLowerCase().replace(/^@[^/]+\//, '');
      if (normalized !== pluginId) {
        return `Bundled plugin manifest name "${rawName}" does not match directory "${pluginId}"`;
      }
    }
  }
  return undefined;
}

/** Strips executable hooks, cron scripts, agent executors, recipe hooks, stdio MCP settings, and untrusted extensions from remote URL packs. */
export function sanitizeRemoteSubscriptionFiles(
  files: ReadonlyMap<string, Buffer>,
  subscriptionOrigin?: string,
): {
  readonly files: Map<string, Buffer>;
  readonly excluded: PortableSpaceExcludedItem[];
} {
  const sanitized = new Map<string, Buffer>();
  const excluded: PortableSpaceExcludedItem[] = [];
  const allowedRemoteMcpNames = new Set<string>();
  const candidateBundledPluginPaths = new Map<string, Set<string>>();
  for (const rawPath of files.keys()) {
    if (!/^plugins(?:\/|$)/i.test(rawPath)) continue;
    let canonical: string;
    try {
      canonical = safePortablePath(rawPath);
    } catch {
      excluded.push({
        id: `plugins:${rawPath.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
        domain: 'plugins',
        path: rawPath.slice(0, 512),
        reason: 'Blocked unsafe bundled plugin path from remote URL subscription',
      });
      continue;
    }
    const parts = canonical.split('/');
    const pluginId = parts[1];
    if (parts.length < 3 || pluginId === undefined || !isPortablePluginId(pluginId) || domainForFile(canonical) !== 'plugins') {
      excluded.push({
        id: `plugins:${canonical.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
        domain: 'plugins',
        path: canonical.slice(0, 512),
        reason: 'Blocked invalid or disallowed bundled plugin file from remote URL subscription',
      });
      continue;
    }
    let set = candidateBundledPluginPaths.get(pluginId);
    if (set === undefined) {
      set = new Set<string>();
      candidateBundledPluginPaths.set(pluginId, set);
    }
    set.add(canonical);
  }
  const validBundledPluginIds = new Set<string>();
  for (const [pluginId, group] of candidateBundledPluginPaths) {
    if (findBundledOfficialPlugin(pluginId) !== undefined) {
      excluded.push({
        id: `plugins:plugins.${pluginId.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
        domain: 'plugins',
        path: `plugins/${pluginId}`.slice(0, 512),
        reason: `Blocked bundled plugin "${pluginId}" shadowing compiled-in official catalog plugin`,
      });
      continue;
    }
    if (!hasBundledPluginManifest(pluginId, group)) {
      excluded.push({
        id: `plugins:plugins.${pluginId.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
        domain: 'plugins',
        path: `plugins/${pluginId}`.slice(0, 512),
        reason: `Bundled plugin "${pluginId}" is missing required kimi.plugin.json or package.json`,
      });
      continue;
    }
    const manifestIssue = validateBundledPluginManifestName(pluginId, files);
    if (manifestIssue !== undefined) {
      excluded.push({
        id: `plugins:plugins.${pluginId.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
        domain: 'plugins',
        path: `plugins/${pluginId}`.slice(0, 512),
        reason: manifestIssue,
      });
      continue;
    }
    validBundledPluginIds.add(pluginId);
  }

  const rawMcp = files.get('mcp.json');
  if (rawMcp !== undefined) {
    let data: Data;
    try {
      data = object(JSON.parse(rawMcp.toString('utf8')));
    } catch {
      throw new Error('Invalid Portable Space mcp.json');
    }
    const key = Object.hasOwn(data, 'mcpServers') ? 'mcpServers' : Object.hasOwn(data, 'servers') ? 'servers' : undefined;
    const servers = object(key === undefined ? data : data[key]);
    const kept: Data = {};
    for (const [name, entry] of Object.entries(servers)) {
      const server = object(entry);
      if (isExecutableMcpEntry(server)) {
        excluded.push({
          id: `mcp:${name.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
          domain: 'mcp',
          path: `mcp.${name}`.slice(0, 512),
          reason: 'Blocked stdio MCP command from remote URL subscription',
        });
        continue;
      }
      kept[name] = entry;
      allowedRemoteMcpNames.add(name);
    }
    if (Object.keys(kept).length > 0) {
      sanitized.set('mcp.json', Buffer.from(`${JSON.stringify({ mcpServers: kept }, null, 2)}\n`));
    }
  }

  for (const [path, bytes] of files) {
    if (path === 'mcp.json') continue;

    if (path === PLAIN) {
      const data = parseToml(bytes);
      let mutated = false;
      if (Object.hasOwn(data, 'mcp')) {
        const mcpCreds = object(data['mcp']);
        const keptMcp: Data = {};
        for (const [name, entry] of Object.entries(mcpCreds)) {
          if (!allowedRemoteMcpNames.has(name)) {
            mutated = true;
            excluded.push({
              id: `credentials:mcp.${name.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
              domain: 'credentials',
              path: `credentials.mcp.${name}`.slice(0, 512),
              reason: 'Blocked MCP credential targeting undeclared or executable MCP server',
            });
            continue;
          }
          const secretObj = object(entry);
          const filtered: Data = {};
          for (const [field, value] of Object.entries(secretObj)) {
            if (!ALLOWED_REMOTE_MCP_SECRET_KEYS.has(field)) {
              mutated = true;
              excluded.push({
                id: `credentials:mcp.${name.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
                domain: 'credentials',
                path: `credentials.mcp.${name}.${field}`.slice(0, 512),
                reason: 'Blocked non-secret field in remote MCP credential record',
              });
              continue;
            }
            filtered[field] = value;
          }
          if (Object.keys(filtered).length > 0) keptMcp[name] = filtered;
        }
        if (Object.keys(keptMcp).length === 0) delete data['mcp'];
        else data['mcp'] = keptMcp;
      }
      if (!mutated) sanitized.set(path, bytes);
      else if (Object.keys(data).length > 0) sanitized.set(path, encodeToml(data));
      continue;
    }

    if (/^config(?:\.(?:linux|darwin|win32))?\.toml$/i.test(path)) {
      const data = parseToml(bytes);
      let mutated = false;
      for (const section of BLOCKED_CONFIG_SECTIONS) {
        if (Object.hasOwn(data, section)) {
          delete data[section];
          mutated = true;
          excluded.push({
            id: `config:${section}`,
            domain: 'config',
            path: section,
            reason: 'Blocked executable config section from remote URL subscription',
          });
        }
      }
      if (Object.hasOwn(data, 'cron')) {
        const cron = object(data['cron']);
        if (Object.hasOwn(cron, 'scripts')) {
          delete cron['scripts'];
          mutated = true;
          excluded.push({
            id: 'config:cron.scripts',
            domain: 'config',
            path: 'cron.scripts',
            reason: 'Blocked executable cron.scripts from remote URL subscription',
          });
          if (Object.keys(cron).length === 0) delete data['cron'];
          else data['cron'] = cron;
        }
      }
      sanitized.set(path, mutated ? encodeToml(data) : bytes);
      continue;
    }

    if (path === 'extensions.toml') {
      const data = parseToml(bytes);
      if (Object.hasOwn(data, 'skill_repos')) {
        const repos = Array.isArray(data['skill_repos']) ? data['skill_repos'] : [];
        if (repos.length === 0) {
          excluded.push({
            id: 'skills:skill_repos',
            domain: 'skills',
            path: 'skill_repos',
            reason: 'Blocked skill_repos git clone from remote URL subscription',
          });
        } else {
          for (const entry of repos) {
            const name = typeof object(entry)['name'] === 'string' ? String(object(entry)['name']) : 'unknown';
            excluded.push({
              id: `skills:skill_repos.${name.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
              domain: 'skills',
              path: `skill_repos.${name}`.slice(0, 512),
              reason: 'Blocked skill_repos git clone from remote URL subscription',
            });
          }
        }
      }
      const keptPlugins: Data[] = [];
      const seenPluginIds = new Set<string>();
      if (Array.isArray(data['plugins'])) {
        for (const rawEntry of data['plugins']) {
          const entry = object(rawEntry);
          const id = typeof entry['id'] === 'string' ? entry['id'].trim() : '';
          if (id.length === 0 || !isPortablePluginId(id)) {
            excluded.push({
              id: `plugins:plugins.${(id || 'unknown').replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
              domain: 'plugins',
              path: `plugins.${id || 'unknown'}`.slice(0, 512),
              reason: 'Blocked invalid plugin declaration from remote URL subscription',
            });
            continue;
          }
          if (findBundledOfficialPlugin(id) !== undefined) {
            if (!seenPluginIds.has(id)) {
              seenPluginIds.add(id);
              keptPlugins.push({
                id,
                enabled: entry['enabled'] !== false,
              });
            }
            continue;
          }
          if (validBundledPluginIds.has(id)) {
            if (!seenPluginIds.has(id)) {
              seenPluginIds.add(id);
              keptPlugins.push({
                id,
                enabled: entry['enabled'] !== false,
              });
            }
            continue;
          }
          const sameOriginZip = isSameOriginPinnedPluginZip(entry['source'], entry['sha256'], subscriptionOrigin);
          if (sameOriginZip !== undefined) {
            if (!seenPluginIds.has(id)) {
              seenPluginIds.add(id);
              keptPlugins.push({
                id,
                enabled: entry['enabled'] !== false,
                source: sameOriginZip.source,
                sha256: sameOriginZip.sha256,
              });
            }
            continue;
          }
          excluded.push({
            id: `plugins:plugins.${id.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
            domain: 'plugins',
            path: `plugins.${id}`.slice(0, 512),
            reason: 'Blocked non-official plugin from remote URL subscription',
          });
        }
      }
      for (const bundledId of validBundledPluginIds) {
        if (!seenPluginIds.has(bundledId)) {
          seenPluginIds.add(bundledId);
          keptPlugins.push({ id: bundledId, enabled: true });
        }
      }
      if (keptPlugins.length > 0) {
        sanitized.set(path, encodeToml({ plugins: keptPlugins }));
      }
      continue;
    }

    if (path === RECIPE_INSTALLATIONS) {
      const records = readRecipeInstallations(bytes);
      let mutated = false;
      for (const [id, record] of Object.entries(records)) {
        if (record.trustedHooks !== undefined) {
          delete record.trustedHooks;
          mutated = true;
          excluded.push({
            id: `recipes:installation.${id}`.slice(0, 512),
            domain: 'recipes',
            path: `${RECIPE_INSTALLATIONS}/${id}`.slice(0, 512),
            reason: 'Blocked trusted recipe hooks from remote URL subscription',
          });
        }
      }
      sanitized.set(path, mutated ? installBytes(records) : bytes);
      continue;
    }

    if (/^plugins(?:\/|$)/i.test(path)) {
      let canonical: string | undefined;
      try {
        canonical = safePortablePath(path);
      } catch {
        canonical = undefined;
      }
      const parts = canonical?.split('/');
      const pluginId = parts?.[1];
      if (canonical !== undefined && pluginId !== undefined && validBundledPluginIds.has(pluginId) && domainForFile(canonical) === 'plugins') {
        sanitized.set(canonical, bytes);
      }
      continue;
    }

    if (/^skills(?:\/|$)/i.test(path)) {
      excluded.push({
        id: `skills:${path.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
        domain: 'skills',
        path: path.slice(0, 512),
        reason: 'Blocked skill bundle from remote URL subscription',
      });
      continue;
    }

    if (/^sessions(?:\/|$)/i.test(path)) {
      excluded.push({
        id: `sessions:${path.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
        domain: 'sessions',
        path: path.slice(0, 512),
        reason: 'Blocked session history from remote URL subscription',
      });
      continue;
    }

    if (/^memories(?:\/|$)/i.test(path)) {
      excluded.push({
        id: `memories:${path.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
        domain: 'memories',
        path: path.slice(0, 512),
        reason: 'Blocked personal memories from remote URL subscription',
      });
      continue;
    }

    if (/^(?:recipes|store\/recipes)\/.+\/hooks(?:\/|$)/i.test(path)) {
      excluded.push({
        id: `recipes:${path.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
        domain: 'recipes',
        path: path.slice(0, 512),
        reason: 'Blocked executable recipe hook script from remote URL subscription',
      });
      continue;
    }

    if (/^(?:recipes|store\/recipes)\/.+\.toml$/i.test(path)) {
      const cleaned = stripRecipeHooksFromToml(bytes);
      if (cleaned.stripped) {
        excluded.push({
          id: `recipes:${path.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
          domain: 'recipes',
          path: path.slice(0, 512),
          reason: 'Blocked executable recipe [[hooks]] from remote URL subscription',
        });
      }
      sanitized.set(path, cleaned.bytes);
      continue;
    }

    sanitized.set(path, bytes);
  }

  if (!files.has('extensions.toml') && validBundledPluginIds.size > 0) {
    sanitized.set(
      'extensions.toml',
      encodeToml({
        plugins: [...validBundledPluginIds].sort().map((id) => ({ id, enabled: true })),
      }),
    );
  }

  return { files: sanitized, excluded };
}

/** Verifies after merge composition that no touched MCP server introduces or modifies executable stdio settings. */
export function assertNoRemoteExecutableMcp(
  nextUnits: Units,
  beforeUnits: Units,
  touchedIds: readonly string[],
): void {
  const touchedServers = new Set<string>();
  for (const id of touchedIds) {
    const unit = nextUnits.get(id) ?? beforeUnits.get(id);
    if (unit === undefined) continue;
    if (unit.domain === 'mcp' && unit.key[0] !== undefined) {
      touchedServers.add(unit.key[0]);
    } else if (unit.domain === 'credentials' && unit.key[0] === 'mcp' && unit.key[1] !== undefined) {
      touchedServers.add(unit.key[1]);
    }
  }
  for (const name of touchedServers) {
    const nextServerUnit = [...nextUnits.values()].find((unit) => unit.domain === 'mcp' && unit.key[0] === name);
    const beforeServerUnit = [...beforeUnits.values()].find((unit) => unit.domain === 'mcp' && unit.key[0] === name);
    const nextSecretUnit = [...nextUnits.values()].find((unit) => unit.domain === 'credentials' && unit.key[0] === 'mcp' && unit.key[1] === name);
    if (beforeServerUnit !== undefined && isExecutableMcpEntry(object(beforeServerUnit.value))) {
      throw new Error(`Remote URL subscription cannot modify executable stdio MCP server "${name}"`);
    }
    const composed = mergeConfigCredentials(object(nextServerUnit?.value), object(nextSecretUnit?.value));
    if (isExecutableMcpEntry(composed)) {
      throw new Error(`Remote URL subscription cannot install executable stdio MCP server "${name}"`);
    }
  }
}

function originOfHttpUrl(rawUrl: unknown): string | undefined {
  if (typeof rawUrl !== 'string') return undefined;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || !URL.canParse(trimmed)) return undefined;
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.origin.toLowerCase();
}

function encodeUnitKeySegment(segment: string): string {
  return segment.replaceAll('%', '%25').replaceAll('.', '%2E');
}

function isUnmanagedPoolCredential(
  credId: string,
  targetUnits: Units,
  upstreamUnits: Units,
  previousManagedSet: ReadonlySet<string>,
): boolean {
  const poolUnitId = `credentials:pool.${encodeUnitKeySegment(credId)}`;
  return targetUnits.has(poolUnitId) && !upstreamUnits.has(poolUnitId) && !previousManagedSet.has(poolUnitId);
}

function hasUnmanagedProviderCredential(
  providerId: string,
  providerObj: Data,
  beforeProviderObj: Data | undefined,
  targetUnits: Units,
  upstreamUnits: Units,
  previousManagedSet: ReadonlySet<string>,
): boolean {
  const providerCredUnitId = `credentials:providers.${encodeUnitKeySegment(providerId)}`;
  if (targetUnits.has(providerCredUnitId) && !upstreamUnits.has(providerCredUnitId) && !previousManagedSet.has(providerCredUnitId)) {
    return true;
  }
  const explicitCredId = typeof providerObj['credential_id'] === 'string' && providerObj['credential_id'].trim().length > 0
    ? providerObj['credential_id'].trim()
    : undefined;
  const beforeCredId = typeof beforeProviderObj?.['credential_id'] === 'string' && beforeProviderObj['credential_id'].trim().length > 0
    ? beforeProviderObj['credential_id'].trim()
    : undefined;
  for (const candidateId of new Set([providerId, explicitCredId, beforeCredId].filter((v): v is string => v !== undefined))) {
    if (isUnmanagedPoolCredential(candidateId, targetUnits, upstreamUnits, previousManagedSet)) return true;
  }
  if (beforeProviderObj !== undefined) {
    const providerUnitId = `config:providers.${encodeUnitKeySegment(providerId)}`;
    const providerWasUnmanaged = !previousManagedSet.has(providerUnitId);
    if (
      providerWasUnmanaged
      && (typeof beforeProviderObj['api_key_env'] === 'string' || beforeProviderObj['oauth'] !== undefined)
    ) {
      return true;
    }
    if (typeof beforeProviderObj['api_key_env'] === 'string' && beforeProviderObj['api_key_env'] === providerObj['api_key_env']) {
      return true;
    }
    if (beforeProviderObj['oauth'] !== undefined && providerObj['oauth'] !== undefined) {
      return true;
    }
  }
  return false;
}

/** Verifies after composition that remote URL subscriptions never retarget unmanaged local credentials to a new origin at provider or model level. */
export function assertSafeRemoteCredentialBindings(
  nextUnits: Units,
  targetUnits: Units,
  upstreamUnits: Units,
  previousManagedIds: readonly string[],
): void {
  const previousManagedSet = new Set(previousManagedIds);

  for (const [id, upstream] of upstreamUnits) {
    if (upstream.domain === 'config' && upstream.key[0] === 'providers' && upstream.key[1] !== undefined) {
      const providerId = upstream.key[1];
      const nextUnit = nextUnits.get(id);
      if (nextUnit === undefined) continue;
      const nextProvider = object(nextUnit.value);
      const beforeUnit = targetUnits.get(id);
      const beforeProvider = beforeUnit === undefined ? undefined : object(beforeUnit.value);
      const credId = typeof nextProvider['credential_id'] === 'string' ? nextProvider['credential_id'].trim() : undefined;
      if (
        credId !== undefined
        && credId.length > 0
        && credId !== providerId
        && isUnmanagedPoolCredential(credId, targetUnits, upstreamUnits, previousManagedSet)
      ) {
        throw new Error(`Remote URL subscription provider "${providerId}" cannot reference unmanaged local credential "${credId}"`);
      }
      if (
        beforeProvider !== undefined
        && hasUnmanagedProviderCredential(providerId, nextProvider, beforeProvider, targetUnits, upstreamUnits, previousManagedSet)
      ) {
        const beforeOrigin = originOfHttpUrl(beforeProvider['base_url']);
        const nextOrigin = originOfHttpUrl(nextProvider['base_url']);
        if (beforeOrigin !== undefined && nextOrigin !== beforeOrigin) {
          throw new Error(`Remote URL subscription provider "${providerId}" cannot retarget unmanaged local credentials to a different origin`);
        }
      }
    }
  }

  for (const [id, upstream] of upstreamUnits) {
    if (upstream.domain !== 'config' || upstream.key[0] !== 'models' || upstream.key[1] === undefined) continue;
    const modelId = upstream.key[1];
    const nextUnit = nextUnits.get(id);
    if (nextUnit === undefined) continue;
    const nextModel = object(nextUnit.value);
    const modelCredId = typeof nextModel['credential_id'] === 'string' ? nextModel['credential_id'].trim() : undefined;
    if (modelCredId !== undefined && modelCredId.length > 0 && isUnmanagedPoolCredential(modelCredId, targetUnits, upstreamUnits, previousManagedSet)) {
      throw new Error(`Remote URL subscription model "${modelId}" cannot reference unmanaged local credential "${modelCredId}"`);
    }
    const rawModelBaseUrl = nextModel['base_url'];
    if (typeof rawModelBaseUrl !== 'string' || rawModelBaseUrl.trim().length === 0) continue;
    const modelOrigin = originOfHttpUrl(rawModelBaseUrl);
    if (modelOrigin === undefined) {
      throw new Error(`Remote URL subscription model "${modelId}" specifies an invalid base_url`);
    }
    const providerName = typeof nextModel['provider'] === 'string' && nextModel['provider'].trim().length > 0
      ? nextModel['provider'].trim()
      : typeof nextModel['provider_id'] === 'string' && nextModel['provider_id'].trim().length > 0
        ? nextModel['provider_id'].trim()
        : undefined;
    if (providerName !== undefined) {
      const providerUnitId = `config:providers.${encodeUnitKeySegment(providerName)}`;
      const nextProviderUnit = nextUnits.get(providerUnitId);
      const beforeProviderUnit = targetUnits.get(providerUnitId);
      const nextProviderObj = nextProviderUnit === undefined ? {} : object(nextProviderUnit.value);
      const beforeProviderObj = beforeProviderUnit === undefined ? undefined : object(beforeProviderUnit.value);
      if (hasUnmanagedProviderCredential(providerName, nextProviderObj, beforeProviderObj, targetUnits, upstreamUnits, previousManagedSet)) {
        const expectedOrigin = originOfHttpUrl(beforeProviderObj?.['base_url']) ?? originOfHttpUrl(nextProviderObj['base_url']);
        if (expectedOrigin === undefined || modelOrigin !== expectedOrigin) {
          throw new Error(`Remote URL subscription model "${modelId}" cannot override base_url to a different origin while using provider "${providerName}" credentials`);
        }
      }
    }
    const modelCredUnitId = `credentials:models.${encodeUnitKeySegment(modelId)}`;
    if (targetUnits.has(modelCredUnitId) && !upstreamUnits.has(modelCredUnitId) && !previousManagedSet.has(modelCredUnitId)) {
      const beforeModelUnit = targetUnits.get(id);
      const beforeOrigin = beforeModelUnit === undefined ? undefined : originOfHttpUrl(object(beforeModelUnit.value)['base_url']);
      if (beforeOrigin !== undefined && modelOrigin !== beforeOrigin) {
        throw new Error(`Remote URL subscription model "${modelId}" cannot retarget unmanaged local model credentials to a different origin`);
      }
    }
  }
}

function filterAllowedNestedPartialObject(
  raw: unknown,
  allowedNested: Readonly<Record<string, ReadonlySet<string>>>,
): Data {
  const source = object(raw);
  const filtered: Data = {};
  for (const [sectionKey, allowedFields] of Object.entries(allowedNested)) {
    if (!Object.hasOwn(source, sectionKey)) continue;
    const subSource = object(source[sectionKey]);
    const subFiltered: Data = {};
    for (const [field, value] of Object.entries(subSource)) {
      if (allowedFields.has(field)) subFiltered[field] = value;
    }
    if (Object.keys(subFiltered).length > 0) filtered[sectionKey] = subFiltered;
  }
  return filtered;
}

function mergePartialConfigUnit(
  upstream: SubscriptionUnit,
  current: SubscriptionUnit | undefined,
  priorUpstream: SubscriptionUnit | undefined,
  allowedNested: Readonly<Record<string, ReadonlySet<string>>>,
): { readonly merged: SubscriptionUnit; readonly filteredUpstream: SubscriptionUnit } {
  const upstreamObj = filterAllowedNestedPartialObject(upstream.value, allowedNested);
  const priorObj = filterAllowedNestedPartialObject(priorUpstream?.value, allowedNested);
  const merged: Data = { ...object(current?.value) };
  for (const sectionKey of Object.keys(allowedNested)) {
    const nextSection = object(upstreamObj[sectionKey]);
    const priorSection = object(priorObj[sectionKey]);
    const hasCurrentSection = Object.hasOwn(merged, sectionKey);
    const mergedSection: Data = hasCurrentSection ? { ...object(merged[sectionKey]) } : {};
    for (const oldField of Object.keys(priorSection)) {
      if (!Object.hasOwn(nextSection, oldField)) {
        delete mergedSection[oldField];
      }
    }
    for (const [field, value] of Object.entries(nextSection)) {
      mergedSection[field] = value;
    }
    if (Object.keys(mergedSection).length === 0) {
      delete merged[sectionKey];
    } else if (hasCurrentSection || Object.keys(nextSection).length > 0) {
      merged[sectionKey] = mergedSection;
    }
  }
  return {
    merged: { ...upstream, value: merged },
    filteredUpstream: { ...upstream, value: upstreamObj },
  };
}

function prunePartialConfigUnit(
  current: SubscriptionUnit,
  priorUpstream: SubscriptionUnit | undefined,
  allowedNested: Readonly<Record<string, ReadonlySet<string>>>,
): SubscriptionUnit | undefined {
  if (priorUpstream === undefined) return current;
  const priorObj = filterAllowedNestedPartialObject(priorUpstream.value, allowedNested);
  const remaining: Data = { ...object(current.value) };
  for (const [sectionKey, priorSectionVal] of Object.entries(priorObj)) {
    if (!Object.hasOwn(remaining, sectionKey)) continue;
    const section = { ...object(remaining[sectionKey]) };
    for (const oldField of Object.keys(object(priorSectionVal))) {
      delete section[oldField];
    }
    if (Object.keys(section).length === 0) delete remaining[sectionKey];
    else remaining[sectionKey] = section;
  }
  if (Object.keys(remaining).length === 0) return undefined;
  return { ...current, value: remaining };
}

function isProtectedUnmanagedCustomUnit(unit: SubscriptionUnit): boolean {
  return unit.domain === 'mcp' || (unit.domain === 'config' && unit.key[0] === 'providers');
}

/** Reconciles an upstream URL subscription into live target units using managed_overwrite + user_keep rules. */
export function reconcileSubscriptionUnits(
  upstreamUnits: Units,
  targetUnits: Units,
  previousManagedIds: readonly string[],
  priorBase: VerifiedBase | undefined,
  isFirstSubscribe: boolean,
): SubscriptionMergeResult {
  const nextUnits: Units = new Map(targetUnits);
  const nextBaseUnits: Units = new Map();
  const nextManagedSet = new Set<string>();
  const previousManagedSet = new Set(previousManagedIds);
  const appliedIds: string[] = [];
  const deletedIds: string[] = [];
  const skippedIds: string[] = [];

  for (const [id, upstream] of upstreamUnits) {
    if (BLOCKED_REMOTE_DOMAINS.has(upstream.domain)) {
      skippedIds.push(id);
      continue;
    }
    const current = targetUnits.get(id);
    if (USER_KEEP_CONFIG_IDS.has(id) || USER_KEEP_DOMAINS.has(upstream.domain)) {
      if (isFirstSubscribe && current === undefined) {
        nextUnits.set(id, upstream);
        appliedIds.push(id);
      } else if (!sameUnit(upstream, current)) {
        skippedIds.push(id);
      }
      continue;
    }

    if (id === 'config:error_telemetry') {
      const priorUpstream = priorBase?.units.get(id);
      const localOptOut = current !== undefined
        && object(current.value)['enabled'] === false
        && (priorUpstream === undefined || object(priorUpstream.value)['enabled'] !== false);
      if (localOptOut) {
        if (priorUpstream !== undefined) {
          nextManagedSet.add(id);
          nextBaseUnits.set(id, priorUpstream);
        }
        skippedIds.push(id);
        continue;
      }
    }

    const allowedNested = PARTIAL_MERGE_NESTED_KEYS[id];
    if (allowedNested !== undefined) {
      const priorUpstream = priorBase?.units.get(id);
      const { merged: mergedUnit, filteredUpstream } = mergePartialConfigUnit(upstream, current, priorUpstream, allowedNested);
      if (Object.keys(object(filteredUpstream.value)).length === 0) {
        skippedIds.push(id);
        continue;
      }
      nextManagedSet.add(id);
      nextBaseUnits.set(id, filteredUpstream);
      if (!sameUnit(mergedUnit, current)) {
        nextUnits.set(id, mergedUnit);
        appliedIds.push(id);
      }
      continue;
    }

    if (upstream.domain === 'personas') {
      const priorUpstream = priorBase?.units.get(id);
      if (isFirstSubscribe && current !== undefined && !sameUnit(upstream, current)) {
        skippedIds.push(id);
        continue;
      }
      if (current === undefined) {
        if (previousManagedSet.has(id) && priorUpstream !== undefined) {
          nextManagedSet.add(id);
          nextBaseUnits.set(id, priorUpstream);
          skippedIds.push(id);
          continue;
        }
        nextUnits.set(id, upstream);
        nextManagedSet.add(id);
        nextBaseUnits.set(id, upstream);
        appliedIds.push(id);
        continue;
      }
      if (sameUnit(upstream, current)) {
        nextManagedSet.add(id);
        nextBaseUnits.set(id, upstream);
        continue;
      }
      if (priorUpstream !== undefined && sameUnit(current, priorUpstream)) {
        nextUnits.set(id, upstream);
        nextManagedSet.add(id);
        nextBaseUnits.set(id, upstream);
        appliedIds.push(id);
        continue;
      }
      if (priorUpstream !== undefined) {
        nextManagedSet.add(id);
        nextBaseUnits.set(id, priorUpstream);
      }
      skippedIds.push(id);
      continue;
    }

    if (upstream.domain === 'config' && upstream.key[0] === 'providers' && upstream.key[1] !== undefined) {
      const providerId = upstream.key[1];
      const upstreamProvider = object(upstream.value);
      const credId = typeof upstreamProvider['credential_id'] === 'string' ? upstreamProvider['credential_id'].trim() : undefined;
      if (
        credId !== undefined
        && credId.length > 0
        && credId !== providerId
        && isUnmanagedPoolCredential(credId, targetUnits, upstreamUnits, previousManagedSet)
      ) {
        throw new Error(`Remote URL subscription provider "${providerId}" cannot reference unmanaged local credential "${credId}"`);
      }
    }

    if (isProtectedUnmanagedCustomUnit(upstream) && current !== undefined && !previousManagedSet.has(id)) {
      if (!sameUnit(upstream, current)) {
        skippedIds.push(id);
      }
      continue;
    }

    nextManagedSet.add(id);
    nextBaseUnits.set(id, upstream);
    if (!sameUnit(upstream, current)) {
      nextUnits.set(id, upstream);
      appliedIds.push(id);
    }
  }

  for (const oldId of previousManagedIds) {
    if (nextManagedSet.has(oldId)) continue;
    const current = nextUnits.get(oldId);
    if (current === undefined) continue;
    if (USER_KEEP_CONFIG_IDS.has(oldId) || USER_KEEP_DOMAINS.has(current.domain) || BLOCKED_REMOTE_DOMAINS.has(current.domain)) continue;
    if (oldId === 'config:error_telemetry' && object(current.value)['enabled'] === false) {
      skippedIds.push(oldId);
      continue;
    }
    const allowedNested = PARTIAL_MERGE_NESTED_KEYS[oldId];
    if (allowedNested !== undefined) {
      const pruned = prunePartialConfigUnit(current, priorBase?.units.get(oldId), allowedNested);
      if (pruned === undefined) {
        nextUnits.delete(oldId);
        deletedIds.push(oldId);
      } else if (!sameUnit(pruned, current)) {
        nextUnits.set(oldId, pruned);
        appliedIds.push(oldId);
      }
      continue;
    }
    if (current.domain === 'personas') {
      const priorUpstream = priorBase?.units.get(oldId);
      if (priorUpstream === undefined || !sameUnit(current, priorUpstream)) {
        skippedIds.push(oldId);
        continue;
      }
    }
    nextUnits.delete(oldId);
    deletedIds.push(oldId);
  }

  return {
    nextUnits,
    nextBaseUnits,
    nextManagedIds: [...nextManagedSet].sort(),
    appliedIds: appliedIds.sort(),
    deletedIds: deletedIds.sort(),
    skippedIds: skippedIds.sort(),
  };
}
