import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { mergeConfigCredentials } from '@kiki/agent-core-v2/app/config/credentials';
import type { PortableSpaceDomain, PortableSpaceExcludedItem } from '@kiki/protocol';
import { sameUnit, type VerifiedBase } from './mergeEngine';
import { encodeToml, object, parseToml, PLAIN, type Data, type Units } from './treeProjection';
import { RECIPE_INSTALLATIONS, readRecipeInstallations, installBytes } from './recipeStore';

type SubscriptionUnit = Units extends Map<string, infer U> ? U : never;

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_ETAG_LENGTH = 512;

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

const PARTIAL_MERGE_CONFIG_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  'config:permission': new Set(['reviewer']),
  'config:memory': new Set(['advisor']),
};

const USER_KEEP_DOMAINS = new Set<PortableSpaceDomain>([
  'appearance',
  'memories',
  'sessions',
]);

export interface UrlSafetyOptions {
  readonly allowLoopback?: boolean;
  readonly lookupFn?: (hostname: string) => Promise<readonly { readonly address: string; readonly family?: number }[]>;
}

export interface UrlFetchOptions extends UrlSafetyOptions {
  readonly ifNoneMatch?: string;
  readonly fetchFn?: typeof fetch;
  readonly signal?: AbortSignal;
}

export type UrlFetchResult =
  | { readonly status: 'not_modified'; readonly etag?: string }
  | { readonly status: 'ok'; readonly bytes: Buffer; readonly etag?: string };

export interface SubscriptionMergeResult {
  readonly nextUnits: Units;
  readonly nextBaseUnits: Units;
  readonly nextManagedIds: string[];
  readonly appliedIds: string[];
  readonly deletedIds: string[];
  readonly skippedIds: string[];
}

interface SafeSubscriptionTarget {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
  readonly isLoopback: boolean;
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
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new Error('Subscription URL resolved to a blocked private address');
    }
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

/** Derives a safe display label from a subscription URL without leaking long path tokens. */
export function defaultLabelForSubscriptionUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const tail = parsed.pathname.split('/').filter(Boolean).at(-1) ?? '';
    const stem = tail.replace(/\.(?:kiki\.)?(?:tgz|tar\.gz|age)$/i, '');
    if (stem.length > 0 && stem.length <= 32 && !/^[a-f0-9]{24,}$/i.test(stem)) {
      return `${parsed.hostname} (${stem})`.slice(0, 256);
    }
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

interface PinnedHttpResponse {
  readonly status: number;
  readonly etag?: string;
  readonly location?: string;
  readonly bytes: Buffer;
}

function fetchPinnedTarget(
  target: SafeSubscriptionTarget,
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

function combinedSignal(outer: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return outer === undefined ? timeout : AbortSignal.any([outer, timeout]);
}

/** Fetches a remote subscription archive with DNS-pinned SSRF checks, redirect validation, size bounds, and If-None-Match 304 support. */
export async function fetchSubscriptionArchive(rawUrl: string, options: UrlFetchOptions = {}): Promise<UrlFetchResult> {
  const initialTarget = await resolveSafeSubscriptionTarget(rawUrl, options);
  const redirectAllowLoopback = options.allowLoopback === true && initialTarget.isLoopback;
  let currentTarget = initialTarget;
  const normalizedIfNoneMatch = sanitizeEtag(options.ifNoneMatch);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { accept: 'application/gzip, application/octet-stream, */*' };
    if (normalizedIfNoneMatch !== undefined) {
      headers['if-none-match'] = normalizedIfNoneMatch;
    }
    const signal = combinedSignal(options.signal);

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
      const pinned = await fetchPinnedTarget(currentTarget, headers, signal);
      status = pinned.status;
      etag = pinned.etag;
      location = pinned.location;
      bytes = pinned.bytes;
    }

    if (status === 304) {
      return { status: 'not_modified', etag: etag ?? normalizedIfNoneMatch };
    }
    if (status >= 300 && status < 400) {
      if (!location) throw new Error(`Subscription redirect missing Location (HTTP ${status})`);
      if (hop === MAX_REDIRECTS) throw new Error('Too many redirects fetching subscription');
      const nextUrl = new URL(location, currentTarget.url).toString();
      currentTarget = await resolveSafeSubscriptionTarget(nextUrl, {
        allowLoopback: redirectAllowLoopback,
        lookupFn: options.lookupFn,
      });
      continue;
    }
    if (status < 200 || status >= 300) {
      throw new Error(`Subscription fetch failed with HTTP ${status}`);
    }
    return { status: 'ok', bytes, etag };
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

/** Strips executable hooks, cron scripts, agent executors, recipe hooks, and stdio/executable MCP settings from remote URL packs. */
export function sanitizeRemoteSubscriptionFiles(files: ReadonlyMap<string, Buffer>): {
  readonly files: Map<string, Buffer>;
  readonly excluded: PortableSpaceExcludedItem[];
} {
  const sanitized = new Map<string, Buffer>();
  const excluded: PortableSpaceExcludedItem[] = [];
  const allowedRemoteMcpNames = new Set<string>();

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

function filterAllowedPartialObject(raw: unknown, allowedKeys: ReadonlySet<string>): Data {
  const source = object(raw);
  const filtered: Data = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowedKeys.has(key)) filtered[key] = value;
  }
  return filtered;
}

function mergePartialConfigUnit(
  upstream: SubscriptionUnit,
  current: SubscriptionUnit | undefined,
  priorUpstream: SubscriptionUnit | undefined,
  allowedKeys: ReadonlySet<string>,
): { readonly merged: SubscriptionUnit; readonly filteredUpstream: SubscriptionUnit } {
  const upstreamObj = filterAllowedPartialObject(upstream.value, allowedKeys);
  const priorObj = filterAllowedPartialObject(priorUpstream?.value, allowedKeys);
  const merged: Data = { ...object(current?.value) };
  for (const oldKey of Object.keys(priorObj)) {
    if (!Object.hasOwn(upstreamObj, oldKey)) {
      delete merged[oldKey];
    }
  }
  for (const [key, value] of Object.entries(upstreamObj)) {
    merged[key] = value;
  }
  return {
    merged: { ...upstream, value: merged },
    filteredUpstream: { ...upstream, value: upstreamObj },
  };
}

function prunePartialConfigUnit(
  current: SubscriptionUnit,
  priorUpstream: SubscriptionUnit | undefined,
  allowedKeys: ReadonlySet<string>,
): SubscriptionUnit | undefined {
  if (priorUpstream === undefined) return undefined;
  const priorObj = filterAllowedPartialObject(priorUpstream.value, allowedKeys);
  const remaining: Data = { ...object(current.value) };
  for (const oldKey of Object.keys(priorObj)) {
    delete remaining[oldKey];
  }
  if (Object.keys(remaining).length === 0) return undefined;
  return { ...current, value: remaining };
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

    const allowedPartialKeys = PARTIAL_MERGE_CONFIG_KEYS[id];
    if (allowedPartialKeys !== undefined) {
      const priorUpstream = priorBase?.units.get(id);
      const { merged: mergedUnit, filteredUpstream } = mergePartialConfigUnit(upstream, current, priorUpstream, allowedPartialKeys);
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
      if (credId !== undefined && credId.length > 0 && credId !== providerId) {
        const poolUnitId = `credentials:pool.${credId.replaceAll('%', '%25').replaceAll('.', '%2E')}`;
        if (targetUnits.has(poolUnitId) && !upstreamUnits.has(poolUnitId) && !previousManagedSet.has(poolUnitId)) {
          throw new Error(`Remote URL subscription provider "${providerId}" cannot reference unmanaged local credential "${credId}"`);
        }
      }
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
    if (USER_KEEP_CONFIG_IDS.has(oldId) || USER_KEEP_DOMAINS.has(current.domain)) continue;
    const allowedPartialKeys = PARTIAL_MERGE_CONFIG_KEYS[oldId];
    if (allowedPartialKeys !== undefined) {
      const pruned = prunePartialConfigUnit(current, priorBase?.units.get(oldId), allowedPartialKeys);
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
