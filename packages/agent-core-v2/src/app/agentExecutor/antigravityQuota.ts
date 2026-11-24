import { createHash } from 'node:crypto';
import type { HarnessQuotaReading } from '@kiki/plugin-sdk';

import { readAntigravityLocalCredentials } from '#/os/backends/node-local/antigravityHostOps';

export const OFFICIAL_ANTIGRAVITY_QUOTA_SOURCE_ID = 'official:antigravity-acp';
export const ANTIGRAVITY_DAILY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_PROD_ENDPOINT = 'https://cloudcode-pa.googleapis.com';

const ENDPOINTS = {
  'oauth-personal': [ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_PROD_ENDPOINT],
  'oauth-business': [ANTIGRAVITY_PROD_ENDPOINT, ANTIGRAVITY_DAILY_ENDPOINT],
} as const;

const SUMMARY_WINDOW_MINS = new Map<string, number>([
  ['5h', 5 * 60],
  ['weekly', 7 * 24 * 60],
]);

const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_BUFFER_MS = 60_000;
const ROLLING_RESET_TOLERANCE_MS = 60_000;

export function antigravityUserAgent(platform: NodeJS.Platform, arch: string): string {
  return `antigravity/hub/2.24.0 (aidev_client; os_type=${platform}; arch=${arch}; cl=963137146)`;
}

export interface AntigravityQuotaWindow {
  readonly id: string;
  readonly label: string;
  readonly family: string;
  readonly kind: 'session' | 'weekly' | 'other';
  readonly remainingFraction: number;
  readonly usedPercent: number;
  readonly resetAt?: string;
  readonly windowDurationMins?: number;
}

export type AntigravityQuotaResult =
  | {
    readonly ok: true;
    readonly checkedAt: string;
    readonly accountFingerprint: string;
    readonly accountLabel?: string;
    readonly windows: readonly AntigravityQuotaWindow[];
  }
  | {
    readonly ok: false;
    readonly checkedAt: string;
    readonly reason: 'unsupported' | 'auth_required' | 'token_expired' | 'probe_failed';
    readonly message: string;
  };

export interface AntigravityQuotaReadOptions {
  readonly profileHome: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

interface CachedLegacyAccessToken {
  readonly fingerprint: string;
  readonly accountFingerprint: string;
  readonly accountLabel?: string;
  readonly accessToken: string;
  readonly expiresAt: number;
}

export function antigravityAccountFingerprint(googleId: string): string {
  return sha256(`google-account\0${googleId}`);
}

export function parseAntigravitySummaryWindows(
  response: unknown,
  requestedAt: number,
): readonly AntigravityQuotaWindow[] {
  const root = asRecord(response);
  if (root === undefined) return [];
  const rawGroups = Array.isArray(root['groups']) ? root['groups'] : undefined;
  const hasGroupBuckets = rawGroups?.some((entry) => {
    const group = asRecord(entry);
    return Array.isArray(group?.['buckets']) && group['buckets'].length > 0;
  }) === true;
  const groups: readonly Record<string, unknown>[] = hasGroupBuckets && rawGroups !== undefined
    ? rawGroups.flatMap((entry) => {
      const group = asRecord(entry);
      return group === undefined ? [] : [group];
    })
    : [{ buckets: root['buckets'] }];

  const windows = new Map<string, AntigravityQuotaWindow>();
  for (const group of groups) {
    const groupDisplayName = nonEmptyString(group['displayName']);
    const buckets = Array.isArray(group['buckets']) ? group['buckets'] : [];
    for (const rawBucket of buckets) {
      const bucket = asRecord(rawBucket);
      if (bucket === undefined || bucket['disabled'] === true) continue;
      const bucketId = nonEmptyString(bucket['bucketId']);
      if (bucketId === undefined) continue;
      const remaining = finiteNumber(bucket['remainingFraction']);
      if (remaining === undefined) continue;
      const family = bucketFamilyName(bucketId, groupDisplayName);
      const rawWindow = nonEmptyString(bucket['window']);
      const weekly = rawWindow === 'weekly';
      const session = rawWindow === '5h';
      const windowDurationMins = rawWindow === undefined ? undefined : SUMMARY_WINDOW_MINS.get(rawWindow);
      const description = nonEmptyString(bucket['description']);
      const displayName = nonEmptyString(bucket['displayName']);
      const resetTime = summaryResetTime(
        remaining,
        nonEmptyString(bucket['resetTime']),
        description,
        windowDurationMins,
        requestedAt,
      );
      const clamped = Math.max(0, Math.min(1, remaining));
      const windowLabel = weekly ? 'Weekly' : session ? '5-hour' : displayName ?? 'Quota';
      windows.set(bucketId, {
        id: bucketId,
        label: `${family} · ${windowLabel}`,
        family,
        kind: weekly ? 'weekly' : session ? 'session' : 'other',
        remainingFraction: clamped,
        usedPercent: (1 - clamped) * 100,
        resetAt: resetTime,
        windowDurationMins,
      });
    }
  }
  return [...windows.values()];
}

export function parseAntigravityModelWindows(response: unknown): readonly AntigravityQuotaWindow[] {
  const root = asRecord(response);
  const models = asRecord(root?.['models']);
  if (models === undefined) return [];
  const windows = new Map<string, AntigravityQuotaWindow>();
  for (const [modelId, rawModel] of Object.entries(models)) {
    const model = asRecord(rawModel);
    if (model === undefined) continue;
    const provider = nonEmptyString(model['modelProvider']);
    const family = provider === 'MODEL_PROVIDER_GOOGLE' || modelId.startsWith('gemini-')
      ? 'Gemini'
      : provider === 'MODEL_PROVIDER_ANTHROPIC' || modelId.startsWith('claude-')
        ? 'Claude'
        : provider === 'MODEL_PROVIDER_OPENAI' || modelId.startsWith('gpt-')
          ? 'GPT'
          : undefined;
    if (family === undefined) continue;
    for (const [suffix, rawQuota] of [
      ['quota', model['quotaInfo']],
      ['weekly', model['weeklyQuotaInfo']],
    ] as const) {
      const quota = asRecord(rawQuota);
      if (quota === undefined) continue;
      const remaining = finiteNumber(quota['remainingFraction']);
      if (remaining === undefined) continue;
      const clamped = Math.max(0, Math.min(1, remaining));
      const id = `${family.toLowerCase()}-${suffix}`;
      const candidate: AntigravityQuotaWindow = {
        id,
        label: `${family} · ${suffix === 'weekly' ? 'Weekly' : 'Reported quota'}`,
        family,
        kind: suffix === 'weekly' ? 'weekly' : 'other',
        remainingFraction: clamped,
        usedPercent: (1 - clamped) * 100,
        resetAt: parseIsoTimestamp(nonEmptyString(quota['resetTime'])),
        windowDurationMins: suffix === 'weekly' ? 7 * 24 * 60 : undefined,
      };
      const previous = windows.get(id);
      if (previous === undefined || candidate.usedPercent > previous.usedPercent) {
        windows.set(id, candidate);
      }
    }
  }
  return [...windows.values()];
}

export function antigravityQuotaToHarnessReadings(input: {
  readonly accountId: string;
  readonly accountLabel?: string;
  readonly windows: readonly AntigravityQuotaWindow[];
  readonly modelIds?: readonly string[];
  readonly readAt: string;
}): readonly HarnessQuotaReading[] {
  return input.windows.map((window) => {
    const matchedModels = matchWindowModels(window.id, input.modelIds);
    const hasScopedModels = matchedModels !== undefined && matchedModels.length > 0;
    return {
      accountId: input.accountId,
      accountLabel: input.accountLabel,
      modelIds: hasScopedModels ? [...matchedModels] : undefined,
      pool: windowPoolId(window.id),
      unit: 'percent',
      window: window.kind === 'session' ? '5h' : window.kind === 'weekly' ? 'weekly' : undefined,
      remaining: Math.round(window.remainingFraction * 1000) / 10,
      resetAt: window.resetAt,
      readAt: input.readAt,
    };
  });
}

export class AntigravityQuotaCollector {
  readonly #legacyTokens = new Map<string, CachedLegacyAccessToken>();
  readonly #generations = new Map<string, number>();

  invalidate(profileHome: string): void {
    this.#legacyTokens.delete(profileHome);
    this.#generations.set(profileHome, (this.#generations.get(profileHome) ?? 0) + 1);
  }

  clear(): void {
    this.#legacyTokens.clear();
    this.#generations.clear();
  }

  async read(options: AntigravityQuotaReadOptions): Promise<AntigravityQuotaResult> {
    const now = options.now ?? (() => Date.now());
    const checkedAt = new Date(now()).toISOString();
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const startedGeneration = this.#generations.get(options.profileHome) ?? 0;

    try {
      const credentials = await readAntigravityLocalCredentials(options.profileHome, now());
      const authMethod = credentials.settings.authMethod;
      if (authMethod !== 'oauth-personal' && authMethod !== 'oauth-business') {
        return {
          ok: false,
          checkedAt,
          reason: 'unsupported',
          message: 'Antigravity quota telemetry is only available for Google OAuth sign-in.',
        };
      }

      let accessToken: string;
      let accountFingerprint: string;
      let accountLabel: string | undefined;
      let projectId: string | undefined = credentials.settings.gcpProject;

      if (credentials.legacyToken !== undefined) {
        const legacy = credentials.legacyToken;
        projectId = legacy.projectId ?? projectId;
        const fingerprint = sha256(`${legacy.clientId}\0${legacy.refreshToken}\0${legacy.projectId ?? ''}`);
        const cached = this.#legacyTokens.get(options.profileHome);
        if (cached !== undefined && cached.fingerprint === fingerprint && cached.expiresAt > now() + TOKEN_REFRESH_BUFFER_MS) {
          accessToken = cached.accessToken;
          accountFingerprint = cached.accountFingerprint;
          accountLabel = cached.accountLabel;
        } else {
          this.#legacyTokens.delete(options.profileHome);
          const refreshed = await refreshLegacyAccessToken(legacy, fetchImpl, options.signal);
          accessToken = refreshed.accessToken;
          const userInfo = await fetchGoogleUserInfo(accessToken, fetchImpl, options.signal).catch(() => undefined);
          accountFingerprint = userInfo?.id ? antigravityAccountFingerprint(userInfo.id) : fingerprint;
          accountLabel = userInfo?.email;
          if ((this.#generations.get(options.profileHome) ?? 0) === startedGeneration) {
            this.#legacyTokens.set(options.profileHome, {
              fingerprint,
              accountFingerprint,
              accountLabel,
              accessToken,
              expiresAt: now() + refreshed.expiresInSeconds * 1000,
            });
          }
        }
      } else if (credentials.cliToken !== undefined) {
        this.#legacyTokens.delete(options.profileHome);
        if (credentials.cliToken.expired) {
          return {
            ok: false,
            checkedAt,
            reason: 'token_expired',
            message: "Antigravity's saved sign-in has expired. Start an Antigravity turn to renew it, then refresh limits.",
          };
        }
        accessToken = credentials.cliToken.accessToken;
        const userInfo = await fetchGoogleUserInfo(accessToken, fetchImpl, options.signal).catch(() => undefined);
        accountFingerprint = userInfo?.id
          ? antigravityAccountFingerprint(userInfo.id)
          : sha256(`antigravity-cli\0${credentials.cliToken.refreshToken ?? accessToken}`);
        accountLabel = userInfo?.email;
      } else {
        this.#legacyTokens.delete(options.profileHome);
        return {
          ok: false,
          checkedAt,
          reason: 'auth_required',
          message: 'Sign in with Google to see Antigravity limits.',
        };
      }

      const endpoints = ENDPOINTS[authMethod];
      const userAgent = antigravityUserAgent(options.platform, options.arch);
      const summary = await fetchMergedWindows(
        endpoints,
        'retrieveUserQuotaSummary',
        accessToken,
        userAgent,
        projectId,
        fetchImpl,
        now,
        options.signal,
        parseAntigravitySummaryWindows,
      );
      const windows = summary.length > 0
        ? summary
        : await fetchMergedWindows(
          endpoints,
          'fetchAvailableModels',
          accessToken,
          userAgent,
          projectId,
          fetchImpl,
          now,
          options.signal,
          (payload) => parseAntigravityModelWindows(payload),
        );
      if (windows.length === 0) {
        return {
          ok: false,
          checkedAt,
          reason: 'probe_failed',
          message: 'Antigravity did not return usable quota information.',
        };
      }
      return {
        ok: true,
        checkedAt,
        accountFingerprint,
        accountLabel,
        windows,
      };
    } catch {
      return {
        ok: false,
        checkedAt,
        reason: 'probe_failed',
        message: 'Could not read Antigravity limits. Refresh provider status to retry.',
      };
    }
  }
}

export async function fetchGoogleUserInfo(
  accessToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<{ readonly id: string; readonly email?: string } | undefined> {
  const payload = await requestJson(
    'https://www.googleapis.com/oauth2/v2/userinfo',
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'manual',
    },
    fetchImpl,
    signal,
  );
  const record = asRecord(payload);
  const id = nonEmptyString(record?.['id']);
  if (id === undefined) return undefined;
  return { id, email: nonEmptyString(record?.['email']) };
}

async function refreshLegacyAccessToken(
  token: { readonly clientId: string; readonly clientSecret: string; readonly refreshToken: string },
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ readonly accessToken: string; readonly expiresInSeconds: number }> {
  const body = new URLSearchParams({
    client_id: token.clientId,
    client_secret: token.clientSecret,
    refresh_token: token.refreshToken,
    grant_type: 'refresh_token',
  });
  const payload = await requestJson(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    },
    fetchImpl,
    signal,
  );
  const record = asRecord(payload);
  const accessToken = nonEmptyString(record?.['access_token']);
  const expiresIn = finiteNumber(record?.['expires_in']);
  if (accessToken === undefined || expiresIn === undefined || expiresIn <= 0) {
    throw new Error('Google OAuth token response was invalid');
  }
  return { accessToken, expiresInSeconds: expiresIn };
}

async function fetchMergedWindows(
  endpoints: readonly string[],
  operation: string,
  accessToken: string,
  userAgent: string,
  projectId: string | undefined,
  fetchImpl: typeof fetch,
  now: () => number,
  signal: AbortSignal | undefined,
  parse: (payload: unknown, requestedAt: number) => readonly AntigravityQuotaWindow[],
): Promise<readonly AntigravityQuotaWindow[]> {
  const perEndpoint = await Promise.all(endpoints.map(async (endpoint) => {
    const requestedAt = now();
    try {
      const payload = await requestJson(
        `${endpoint}/v1internal:${operation}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': userAgent,
          },
          body: JSON.stringify(projectId ? { project: projectId } : {}),
          redirect: 'manual',
        },
        fetchImpl,
        signal,
      );
      return parse(payload, requestedAt);
    } catch {
      return [] as readonly AntigravityQuotaWindow[];
    }
  }));
  const merged = new Map<string, AntigravityQuotaWindow>();
  for (const list of perEndpoint) {
    for (const window of list) {
      if (!merged.has(window.id)) merged.set(window.id, window);
    }
  }
  return [...merged.values()];
}

async function requestJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const response = await fetchImpl(url, { ...init, signal: combined });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  return response.json();
}

function bucketFamilyName(bucketId: string, groupDisplayName: string | undefined): string {
  if (bucketId.startsWith('gemini-argon-')) return groupDisplayName ?? 'Gemini Argon';
  if (bucketId.startsWith('gemini-carbon-')) return groupDisplayName ?? 'Gemini Carbon';
  if (bucketId.startsWith('gemini-')) return 'Gemini';
  if (bucketId.startsWith('3p-')) return 'Claude & GPT (shared)';
  return groupDisplayName ?? bucketId;
}

function windowPoolId(bucketId: string): string {
  if (bucketId.startsWith('gemini-argon-')) return 'gemini-argon';
  if (bucketId.startsWith('gemini-carbon-')) return 'gemini-carbon';
  if (bucketId.startsWith('gemini-')) return 'gemini';
  if (bucketId.startsWith('3p-')) return 'claude-gpt';
  if (bucketId.startsWith('claude-')) return 'claude';
  if (bucketId.startsWith('gpt-')) return 'gpt';
  return bucketId;
}

function matchWindowModels(
  bucketId: string,
  modelIds: readonly string[] | undefined,
): readonly string[] | undefined {
  if (modelIds === undefined || modelIds.length === 0) return undefined;
  const lower = (value: string) => value.toLowerCase();
  if (bucketId.startsWith('gemini-argon-')) {
    return modelIds.filter((id) => lower(id).includes('argon'));
  }
  if (bucketId.startsWith('gemini-carbon-')) {
    return modelIds.filter((id) => lower(id).includes('carbon'));
  }
  if (bucketId.startsWith('gemini-')) {
    return modelIds.filter((id) => lower(id).startsWith('gemini') && !lower(id).includes('argon') && !lower(id).includes('carbon'));
  }
  if (bucketId.startsWith('3p-')) {
    return modelIds.filter((id) => lower(id).startsWith('claude') || lower(id).startsWith('gpt'));
  }
  if (bucketId.startsWith('claude-')) {
    return modelIds.filter((id) => lower(id).startsWith('claude'));
  }
  if (bucketId.startsWith('gpt-')) {
    return modelIds.filter((id) => lower(id).startsWith('gpt'));
  }
  return undefined;
}

function summaryResetTime(
  remainingFraction: number,
  resetTime: string | undefined,
  description: string | undefined,
  windowDurationMins: number | undefined,
  requestedAt: number,
): string | undefined {
  if (resetTime === undefined) return undefined;
  const parsedMs = Date.parse(resetTime);
  if (!Number.isFinite(parsedMs)) return undefined;
  const untouched = remainingFraction === 1 &&
    description === undefined &&
    windowDurationMins !== undefined &&
    Math.abs(parsedMs - requestedAt - windowDurationMins * 60_000) <= ROLLING_RESET_TOLERANCE_MS;
  return untouched ? undefined : new Date(parsedMs).toISOString();
}

function parseIsoTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
