import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { nbSearchKeyUsageViewSchema, type NbSearchKeyUsageView } from '@kiki/protocol';

export interface RawGatewayRoute {
  readonly origin: string;
  readonly channelId: string;
}

const RAW_GATEWAY_PATH_RE = /\/raw\/(\d+)(?:\/|$)/;
const RAW_GATEWAY_UNSUPPORTED_TTL_MS = 10 * 60_000;
const unsupportedRawGatewayKeys = new Map<string, number>();

function hashKeyIdentity(origin: string, channelId: string, apiKey: string): string {
  return createHash('sha256').update(`${origin.toLowerCase()}|${channelId}|${apiKey}`).digest('hex');
}

function markRawGatewayUnsupported(origin: string, channelId: string, apiKey: string, now = Date.now()): void {
  unsupportedRawGatewayKeys.set(hashKeyIdentity(origin, channelId, apiKey), now + RAW_GATEWAY_UNSUPPORTED_TTL_MS);
}

function isRawGatewayKeyUnsupported(origin: string, channelId: string, apiKey: string, now = Date.now()): boolean {
  const cacheKey = hashKeyIdentity(origin, channelId, apiKey);
  const expiresAt = unsupportedRawGatewayKeys.get(cacheKey);
  if (expiresAt === undefined) return false;
  if (now >= expiresAt) {
    unsupportedRawGatewayKeys.delete(cacheKey);
    return false;
  }
  return true;
}

export function clearRawGatewayQuotaUnsupportedCache(): void {
  unsupportedRawGatewayKeys.clear();
}

function isPrivateOrLoopbackHost(rawHost: string): boolean {
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  const ipKind = isIP(lower);
  if (ipKind === 4) {
    const parts = lower.split('.').map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    return a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (ipKind === 6) {
    return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
  }
  return false;
}

export function parseRawGatewayRoute(baseUrl: string | undefined): RawGatewayRoute | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed || !URL.canParse(trimmed)) return undefined;
  const url = new URL(trimmed);
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
    return undefined;
  }
  if (isPrivateOrLoopbackHost(url.hostname)) return undefined;
  const match = RAW_GATEWAY_PATH_RE.exec(url.pathname);
  if (!match?.[1]) return undefined;
  return { origin: url.origin, channelId: match[1] };
}

function isOfficialTavilyBaseUrl(baseUrl: string | undefined): boolean {
  const trimmed = baseUrl?.trim();
  return !trimmed || /^https:\/\/(?:www\.)?api\.tavily\.com(?:\/|$)/i.test(trimmed);
}

export function isNbSearchBalanceSupported(
  providerId: string,
  baseUrl: string | undefined,
  keys?: readonly string[],
  now = Date.now(),
): boolean {
  const route = parseRawGatewayRoute(baseUrl);
  if (route !== undefined) {
    if (keys !== undefined && keys.length > 0 && keys.every((key) => isRawGatewayKeyUnsupported(route.origin, route.channelId, key, now))) {
      return false;
    }
    return true;
  }
  if (providerId === 'tavily') return isOfficialTavilyBaseUrl(baseUrl);
  return providerId === 'firecrawl' || providerId === 'zhihu';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  if ((typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : undefined;
}

async function readBoundedJson(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<{ readonly status: number; readonly isJson: boolean; readonly body?: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    redirect: 'error',
    signal,
  });
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('text/html')) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, isJson: false };
  }
  const reader = response.body?.getReader();
  if (!reader) return { status: response.status, isJson: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) {
        await reader.cancel();
        return { status: response.status, isJson: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const isJson = contentType === '' || contentType.includes('json');
    return isJson ? { status: response.status, isJson: true, body: asRecord(parsed) } : { status: response.status, isJson: false };
  } catch {
    return { status: response.status, isJson: false };
  }
}

type KeyUsageEntry = NbSearchKeyUsageView['keys'][number];
type KeyUsageMeter = NonNullable<NonNullable<KeyUsageEntry['usage']>['meters']>[number];

function mapChannelQuotaEntry(
  keyIndex: number,
  channelId: string,
  body: Record<string, unknown>,
  nowIso: string,
): KeyUsageEntry | undefined {
  if (body['object'] !== 'list' && !Array.isArray(body['data'])) return undefined;
  const checkedAt = asIsoDate(body['generated_at']) ?? nowIso;
  const data = asArray(body['data']).map(asRecord);
  if (body['exposed'] === true && data.length === 0) {
    return {
      key_index: keyIndex,
      state: 'exhausted',
      usage: {
        scope: 'team',
        unit: 'credits',
        used: 100,
        limit: 100,
        remaining: 0,
        checked_at: checkedAt,
        meters: [{
          id: `channel-${channelId}-exhausted`,
          label: '渠道池额度（已耗尽）',
          unit: 'credits',
          used: 100,
          limit: 100,
          remaining: 0,
        }],
      },
    };
  }
  const channelNum = Number(channelId);
  const channel = data.find((item) => asNumber(item['channel_id']) === channelNum);
  if (channel === undefined) return undefined;
  const channelName = asText(channel['channel_name']);
  const summary = asRecord(channel['quota_summary']);
  const counts = asRecord(channel['key_counts']);
  const totalRemaining = asNumber(summary['total_remaining']);
  const totalUsed = asNumber(summary['total_used']);
  const totalLimit = asNumber(summary['total_limit']);
  const currency = asText(summary['currency']);
  const totalKeys = asNumber(counts['total']);
  const activeKeys = asNumber(counts['active']);
  const exhaustedKeys = asNumber(counts['exhausted']);

  const meters: KeyUsageMeter[] = [];
  const currencySuffix = currency && currency.toLowerCase() !== 'credits' ? ` (${currency})` : '';
  if (totalRemaining !== null || totalUsed !== null || totalLimit !== null) {
    meters.push({
      id: `channel-${channelId}-total`,
      label: channelName ? `${channelName} · 渠道池额度${currencySuffix}` : `渠道池额度${currencySuffix}`,
      unit: 'credits',
      used: totalUsed,
      limit: totalLimit,
      remaining: totalRemaining,
    });
  } else if (totalKeys !== null && activeKeys !== null && totalKeys > 0) {
    meters.push({
      id: `channel-${channelId}-keys`,
      label: channelName ? `${channelName} · 可用凭据` : '可用凭据',
      unit: 'requests',
      used: Math.max(0, totalKeys - activeKeys),
      limit: totalKeys,
      remaining: activeKeys,
    });
  }

  for (const [idx, rawKey] of asArray(channel['keys']).slice(0, 16).entries()) {
    const k = asRecord(rawKey);
    const rem = asNumber(k['remaining']);
    const used = asNumber(k['used']);
    const lim = asNumber(k['limit']);
    if (rem === null && used === null && lim === null) continue;
    const keyId = asText(k['id']) ?? `upstream-${idx + 1}`;
    const keyLabel = asText(k['name']) ?? asText(k['masked_key']) ?? `Upstream ${idx + 1}`;
    const resetAt = asIsoDate(k['reset_at']);
    meters.push({
      id: keyId,
      label: keyLabel,
      unit: 'credits',
      used,
      limit: lim,
      remaining: rem,
      ...(resetAt !== undefined ? { reset_at: resetAt, reset_timezone: 'UTC' } : {}),
    });
  }

  const isExhausted =
    (totalLimit !== null && totalLimit > 0 && totalRemaining !== null && totalRemaining <= 0)
    || (activeKeys === 0 && exhaustedKeys !== null && exhaustedKeys > 0);

  return {
    key_index: keyIndex,
    state: isExhausted ? 'exhausted' : 'ready',
    usage: {
      scope: 'team',
      unit: 'credits',
      used: totalUsed,
      limit: totalLimit,
      remaining: totalRemaining,
      checked_at: checkedAt,
      ...(meters.length > 0 ? { meters } : {}),
    },
  };
}

export async function fetchRawGatewayKeyUsage(input: {
  readonly instanceId: string;
  readonly providerId: string;
  readonly route: RawGatewayRoute;
  readonly keys: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<NbSearchKeyUsageView> {
  const { instanceId, providerId, route, keys, fetchImpl = fetch, signal } = input;
  if (keys.length === 0) {
    return nbSearchKeyUsageViewSchema.parse({
      provider_instance_id: instanceId,
      provider_id: providerId,
      balance_supported: true,
      keys: [],
    });
  }

  const cappedKeys = keys.slice(0, 32);
  const nowIso = new Date().toISOString();
  const entries: KeyUsageEntry[] = [];
  let supportedCount = 0;

  for (const [idx, apiKey] of cappedKeys.entries()) {
    const keyIndex = idx + 1;
    const timeout = AbortSignal.timeout(8_000);
    const callSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      const quotasUrl = `${route.origin}/v1/quotas?channel_id=${encodeURIComponent(route.channelId)}`;
      const quotasRes = await readBoundedJson(quotasUrl, apiKey, fetchImpl, callSignal);
      if (quotasRes.status === 200 && quotasRes.isJson && quotasRes.body !== undefined) {
        const mapped = mapChannelQuotaEntry(1, route.channelId, quotasRes.body, nowIso);
        if (mapped !== undefined) {
          return nbSearchKeyUsageViewSchema.parse({
            provider_instance_id: instanceId,
            provider_id: providerId,
            balance_supported: true,
            keys: [mapped],
          });
        }
      }
      const errCode = asText(asRecord(quotasRes.body?.['error'])['code']) ?? asText(quotasRes.body?.['code']);
      if (
        (quotasRes.status === 403 && errCode === 'key_quota_exposure_disabled')
        || quotasRes.status === 404
        || quotasRes.status === 405
        || (quotasRes.status === 200 && !quotasRes.isJson)
      ) {
        markRawGatewayUnsupported(route.origin, route.channelId, apiKey);
        entries.push({ key_index: keyIndex, state: 'unknown' });
        continue;
      }
      if (quotasRes.status === 401 || quotasRes.status === 403) {
        supportedCount += 1;
        entries.push({ key_index: keyIndex, state: 'invalid' });
        continue;
      }
      supportedCount += 1;
      entries.push({ key_index: keyIndex, state: 'ready', usage_error: 'unavailable' });
    } catch {
      supportedCount += 1;
      entries.push({ key_index: keyIndex, state: 'ready', usage_error: 'unavailable' });
    }
  }

  if (supportedCount === 0) {
    return nbSearchKeyUsageViewSchema.parse({
      provider_instance_id: instanceId,
      provider_id: providerId,
      balance_supported: false,
      keys: entries.slice(0, 1),
    });
  }

  if (entries.every((entry) => entry.state === 'invalid')) {
    return nbSearchKeyUsageViewSchema.parse({
      provider_instance_id: instanceId,
      provider_id: providerId,
      balance_supported: true,
      keys: [{ key_index: 1, state: 'invalid' }],
    });
  }

  const representative = entries.find((entry) => entry.usage_error !== undefined) ?? entries[0]!;
  return nbSearchKeyUsageViewSchema.parse({
    provider_instance_id: instanceId,
    provider_id: providerId,
    balance_supported: true,
    keys: [{ ...representative, key_index: 1 }],
  });
}
