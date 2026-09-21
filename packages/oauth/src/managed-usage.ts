/**
 * Managed-platform usage fetch / parse.
 *
 * Only `managed:kimi-code` is supported today. The platform exposes a
 * `/usages` endpoint. Current deployments answer with the quota model:
 *
 *   {
 *     "usages": {
 *       "limit_5h":          { "used_ratio": 0.3,  "reset_time": "..." },
 *       "limit_7d":          { "used_ratio": 0.2,  "reset_time": "..." },
 *       "limit_month_total": { "used_ratio": 0.4,  "reset_time": "..." },
 *       "limit_month_code":  { "used_ratio": 0.25, "reset_time": "..." }
 *     },
 *     "boosterWallet": { ... }
 *   }
 *
 * Older deployments answered with absolute counts instead:
 *
 *   {
 *     "usage":  { "used": "40", "limit": "1000", "resetTime": "2026-08-03T05:20:51Z" },
 *     "limits": [
 *       {
 *         "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
 *         "detail": { "used": "1", "limit": "100", "resetTime": "..." }
 *       },
 *       ...
 *     ],
 *     "boosterWallet": { ... }
 *   }
 *
 * Both models normalize into the same `ParsedManagedUsage` (summary + limits
 * + extraUsage), the shape the REST and client contracts carry, so no
 * consumer needs a second code path. A quota entry is a used/total ratio
 * rather than a count, so it is projected onto the percentage scale
 * `used = ratio * 100, limit = 100`: the ratio is what every consumer renders
 * (progress bar, "N% used"), and the absolute counts the old payload carried
 * are no longer served. Numbers arrive as decimal strings; `timeUnit` is a
 * proto-style enum. Presentation (labels, reset hints) is left to the
 * consumer.
 */

import { readApiErrorMessage } from './api-error';
import { isRecord } from './utils';

const MANAGED_PREFIX = 'managed:';
const KIMI_CODE_PLATFORM_ID = 'kimi-code';
export const DEFAULT_KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';

export function isManagedKimiCode(providerKey?: string | null): boolean {
  if (!providerKey) return false;
  if (!providerKey.startsWith(MANAGED_PREFIX)) return false;
  return providerKey.slice(MANAGED_PREFIX.length) === KIMI_CODE_PLATFORM_ID;
}

export function kimiCodeBaseUrl(): string {
  // Single source of truth for the canonical base-url shape: normalize the
  // env override here instead of letting a trailing slash leak into the
  // persisted provider entry, where a later normalized rewrite would diff
  // against it and emit a spurious providers-changed event during login.
  return (process.env['KIKI_CODE_BASE_URL'] ?? DEFAULT_KIMI_CODE_BASE_URL).replace(/\/+$/, '');
}

export function kimiCodeUsageUrl(): string {
  return `${kimiCodeBaseUrl()}/usages`;
}

/**
 * Strict match against the managed Kimi Code endpoint: both URLs are parsed
 * and compared by lowercase origin + pathname without trailing slashes.
 * Anything that fails to parse — or differs in host or path, e.g. a proxy,
 * gateway, or self-hosted mirror — is NOT the managed endpoint and must not
 * be auto-refreshed, because its `/models` schema cannot be trusted.
 */
export function isManagedKimiCodeBaseUrl(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) return false;
  const managed = parseNormalizedUrl(kimiCodeBaseUrl());
  const candidate = parseNormalizedUrl(baseUrl);
  return managed !== undefined && candidate !== undefined && managed === candidate;
}

function parseNormalizedUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

export interface UsageWindow {
  readonly duration: number;
  readonly unit: 'minute' | 'hour' | 'day' | 'week';
}

export interface UsageRow {
  /** Backend `name`, passed through for custom labels. */
  readonly name?: string;
  readonly window?: UsageWindow;
  readonly used: number;
  readonly limit: number;
  /** ISO timestamp at which the window resets. */
  readonly resetAt?: string;
}

export interface BoosterWalletInfo {
  /** Remaining balance in whole cents (from balance.amountLeft). */
  readonly balanceCents: number;
  /** Total balance in whole cents (from balance.amount). */
  readonly totalCents: number;
  /** Whether the user enabled a monthly spending cap. */
  readonly monthlyChargeLimitEnabled: boolean;
  /** Monthly spending cap in whole cents; 0 means unlimited. */
  readonly monthlyChargeLimitCents: number;
  /** Monthly spend so far in whole cents. */
  readonly monthlyUsedCents: number;
  /** ISO currency code, e.g. USD / CNY. */
  readonly currency: string;
}

export interface ParsedManagedUsage {
  readonly summary: UsageRow | null;
  readonly limits: UsageRow[];
  readonly extraUsage: BoosterWalletInfo | null;
}

const FIXED_POINT_CENTS = 1_000_000;

function fixedPointToCents(value: number): number {
  const cents = value / FIXED_POINT_CENTS;
  if (cents > 0 && cents < 1) return 1;
  return Math.round(cents);
}

function parseMoney(raw: unknown): { cents: number; currency: string } | null {
  if (!isRecord(raw)) return null;
  const cents = toInt(raw['priceInCents']);
  if (cents === null) return null;
  const currency = typeof raw['currency'] === 'string' ? raw['currency'] : '';
  return { cents, currency };
}

function parseBoosterWallet(raw: unknown): BoosterWalletInfo | null {
  if (!isRecord(raw)) return null;
  const balance = raw['balance'];
  if (!isRecord(balance)) return null;
  if (balance['type'] !== 'BOOSTER') return null;
  const amountRaw = toInt(balance['amount']);
  if (amountRaw === null || amountRaw <= 0) return null;
  const totalCents = fixedPointToCents(amountRaw);
  const amountLeftRaw = toInt(balance['amountLeft']);
  const balanceCents = amountLeftRaw !== null ? fixedPointToCents(amountLeftRaw) : 0;

  const monthlyLimit = parseMoney(raw['monthlyChargeLimit']);
  const monthlyUsed = parseMoney(raw['monthlyUsed']);
  const monthlyChargeLimitEnabled = raw['monthlyChargeLimitEnabled'] === true;

  const currency =
    monthlyLimit && monthlyLimit.currency.length > 0
      ? monthlyLimit.currency
      : monthlyUsed && monthlyUsed.currency.length > 0
        ? monthlyUsed.currency
        : 'USD';

  return {
    balanceCents,
    totalCents,
    monthlyChargeLimitEnabled,
    monthlyChargeLimitCents: monthlyLimit?.cents ?? 0,
    monthlyUsedCents: monthlyUsed?.cents ?? 0,
    currency,
  };
}

export function parseManagedUsagePayload(payload: unknown): ParsedManagedUsage {
  if (typeof payload !== 'object' || payload === null) {
    return { summary: null, limits: [], extraUsage: null };
  }
  const rec = payload as Record<string, unknown>;
  const extraUsage = parseBoosterWallet(rec['boosterWallet']);
  const quota = parseQuotaRows(rec['usages']);
  if (quota !== null) {
    return { summary: quota.summary, limits: quota.limits, extraUsage };
  }
  let summary = toUsageRow(rec['usage']);
  // The summary is the plan's weekly limit; the backend omits the window,
  // so synthesize it here instead of making every client special-case it.
  if (summary !== null && summary.window === undefined) {
    summary = { ...summary, window: { duration: 1, unit: 'week' } };
  }
  return {
    summary,
    limits: parseLimitRows(rec),
    extraUsage,
  };
}

/** Percentage scale a quota ratio is projected onto; the ratio itself is what
 *  consumers render, and this keeps `used`/`limit` integral on the wire. */
const QUOTA_PERCENT = 100;

interface QuotaRowDefinition {
  readonly key: string;
  readonly name?: string;
  readonly window?: UsageWindow;
}

/** The plan's weekly quota is the summary row, mirroring the legacy payload
 *  where `usage` was the weekly plan limit and `limits` held the rest. */
const QUOTA_SUMMARY_ROW: QuotaRowDefinition = {
  key: 'limit_7d',
  window: { duration: 1, unit: 'week' },
};

const QUOTA_LIMIT_ROWS: readonly QuotaRowDefinition[] = [
  { key: 'limit_5h', window: { duration: 5, unit: 'hour' } },
  { key: 'limit_month_total', name: 'Monthly limit' },
  { key: 'limit_month_code', name: 'Monthly code usage' },
];

interface ParsedQuotaRows {
  readonly summary: UsageRow | null;
  readonly limits: UsageRow[];
}

function parseQuotaRows(rawUsages: unknown): ParsedQuotaRows | null {
  if (!isRecord(rawUsages)) return null;
  const summary = quotaRow(QUOTA_SUMMARY_ROW, rawUsages[QUOTA_SUMMARY_ROW.key]);
  const limits: UsageRow[] = [];
  for (const definition of QUOTA_LIMIT_ROWS) {
    const row = quotaRow(definition, rawUsages[definition.key]);
    if (row !== null) limits.push(row);
  }
  if (summary === null && limits.length === 0) return null;
  return { summary, limits };
}

function quotaRow(definition: QuotaRowDefinition, raw: unknown): UsageRow | null {
  if (!isRecord(raw)) return null;
  const ratio = ratioFrom(raw['used_ratio']);
  if (ratio === null) return null;
  return {
    name: definition.name,
    window: definition.window,
    used: Math.round(ratio * QUOTA_PERCENT),
    limit: QUOTA_PERCENT,
    resetAt: quotaResetAt(raw),
  };
}

function quotaResetAt(raw: Record<string, unknown>): string | undefined {
  const value = raw['reset_time'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function ratioFrom(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseLimitRows(rec: Record<string, unknown>): UsageRow[] {
  const limits: UsageRow[] = [];
  const rawLimits = rec['limits'];
  if (!Array.isArray(rawLimits)) return limits;
  for (const rawItem of rawLimits) {
    if (!isRecord(rawItem)) continue;
    const row = toUsageRow(rawItem['detail'], {
      name: nameFrom(rawItem),
      window: windowFrom(rawItem['window']),
    });
    if (row !== null) limits.push(row);
  }
  return limits;
}

function toUsageRow(
  raw: unknown,
  extra: { readonly name?: string; readonly window?: UsageWindow } = {},
): UsageRow | null {
  if (!isRecord(raw)) return null;
  const used = toInt(raw['used']);
  const limit = toInt(raw['limit']);
  if (used === null && limit === null) return null;
  return {
    name: extra.name ?? nameFrom(raw),
    window: extra.window,
    used: used ?? 0,
    limit: limit ?? 0,
    resetAt: resetAtFrom(raw),
  };
}

function nameFrom(raw: Record<string, unknown>): string | undefined {
  const v = raw['name'];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function normalizeTimeUnit(raw: unknown): UsageWindow['unit'] | null {
  switch (raw) {
    case 'TIME_UNIT_MINUTE':
      return 'minute';
    case 'TIME_UNIT_HOUR':
      return 'hour';
    case 'TIME_UNIT_DAY':
      return 'day';
    case 'TIME_UNIT_WEEK':
      return 'week';
    default:
      return null;
  }
}

function windowFrom(raw: unknown): UsageWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const duration = toInt(raw['duration']);
  const unit = normalizeTimeUnit(raw['timeUnit']);
  if (duration === null || unit === null) return undefined;
  // The platform expresses sub-day windows in minutes (the 5-hour limit
  // arrives as 300 TIME_UNIT_MINUTE); fold whole hours so clients render
  // "5h limit" rather than "300m limit".
  if (unit === 'minute' && duration >= 60 && duration % 60 === 0) {
    return { duration: duration / 60, unit: 'hour' };
  }
  return { duration, unit };
}

function resetAtFrom(raw: Record<string, unknown>): string | undefined {
  const v = raw['resetTime'];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0s';
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${String(days)}d`);
  if (hours) parts.push(`${String(hours)}h`);
  if (minutes) parts.push(`${String(minutes)}m`);
  if (secs && parts.length === 0) parts.push(`${String(secs)}s`);
  return parts.length > 0 ? parts.join(' ') : '0s';
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

// ── HTTP fetch ────────────────────────────────────────────────────────

export interface FetchManagedUsageResult {
  readonly kind: 'ok';
  readonly parsed: ParsedManagedUsage;
}

export interface FetchManagedUsageError {
  readonly kind: 'error';
  readonly status?: number;
  readonly message: string;
}

export async function fetchManagedUsage(
  url: string,
  accessToken: string,
  opts: { timeoutMs?: number } = {},
): Promise<FetchManagedUsageResult | FetchManagedUsageError> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const status = res.status;
      const hint =
        status === 401
          ? 'Authorization failed. Please check your API key (try /login).'
          : status === 404
            ? 'Usage endpoint not available. Try Kimi For Coding.'
            : `Failed to fetch usage: HTTP ${String(status)}`;
      return { kind: 'error', status, message: await readApiErrorMessage(res, hint) };
    }
    const json: unknown = await res.json();
    return { kind: 'ok', parsed: parseManagedUsagePayload(json) };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { kind: 'error', message: 'Failed to fetch usage: request timed out.' };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `Failed to fetch usage: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
