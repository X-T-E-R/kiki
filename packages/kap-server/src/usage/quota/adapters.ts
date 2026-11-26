import { isIP } from 'node:net';
import type { ProviderQuotaMeter } from '@kiki/protocol';
import { parseManagedUsagePayload, openaiCodexAccountId } from '@kiki/oauth';

export type QuotaAdapterId = 'kimi' | 'codex' | 'claude' | 'deepseek' | 'minimax' | 'zai' | 'openrouter' | 'stepfun' | 'siliconflow-cn' | 'siliconflow-global' | 'novita' | 'kiki-quota';
export interface QuotaAdapter { id: QuotaAdapterId; label: string; url: string; secondaryUrl?: string; oauth: boolean }
export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const num = (value: unknown): number | null => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) ? Number(value) : null;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const zaiWindowUnits: Record<number, number> = { 1: 86400, 3: 3600, 5: 60, 6: 604800 };
function date(value: unknown, scale = 1): string | undefined {
  const millis = typeof value === 'number' ? value * scale : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(millis) && Math.abs(millis) < 8.64e15 ? new Date(millis).toISOString() : undefined;
}
function unixDate(value: unknown): string | undefined {
  const raw = num(value);
  if (raw === null || raw <= 0) return undefined;
  return date(raw, raw < 1e12 ? 1000 : 1);
}
function isStepPlanPayload(body: Record<string, unknown>): boolean {
  const plan = body['data'] !== undefined && typeof body['data'] === 'object' && body['data'] !== null && !Array.isArray(body['data'])
    ? record(body['data'])
    : body;
  return plan['plan_family'] !== undefined || plan['plan_credit_rate_limit'] !== undefined
    || plan['five_hour_usage_left_rate'] !== undefined || plan['weekly_usage_left_rate'] !== undefined;
}
function stepLeftRateToUsedPercent(value: unknown): number | null {
  const rate = num(value);
  if (rate === null || rate < 0 || rate > 1) return null;
  return Math.round((1 - rate) * 10_000) / 100;
}
function percent(id: string, label: string, used: unknown, reset?: string, seconds?: number, group?: string): ProviderQuotaMeter | undefined {
  const value = num(used);
  if (value === null || value < 0 || value > 100) return undefined;
  return { id, label, unit: 'percent', unit_label: '%', used: value, limit: 100, remaining: Math.round((100 - value) * 1e6) / 1e6, scope: 'account', model_group: group,
    window: { label, duration_seconds: seconds && seconds > 0 ? seconds : undefined, reset_at: reset, reset_timezone: reset ? 'UTC' : undefined } };
}
function parseDurationToken(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  const unitMatch = /(?:^|[^a-z0-9])(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)(?=$|[^a-z0-9])/.exec(lower);
  if (unitMatch) {
    const amount = Number(unitMatch[1]);
    const unit = unitMatch[2]!;
    if (!Number.isFinite(amount) || amount <= 0) return undefined;
    if (unit.startsWith('m')) return amount * 60;
    if (unit.startsWith('h')) return amount * 3600;
    if (unit.startsWith('d')) return amount * 86400;
    if (unit.startsWith('w')) return amount * 604800;
  }
  const zhMatch = /(\d+)\s*(分钟|小时|天|周)/.exec(raw);
  if (zhMatch) {
    const amount = Number(zhMatch[1]);
    const unit = zhMatch[2]!;
    if (!Number.isFinite(amount) || amount <= 0) return undefined;
    if (unit === '分钟') return amount * 60;
    if (unit === '小时') return amount * 3600;
    if (unit === '天') return amount * 86400;
    if (unit === '周') return amount * 604800;
  }
  if (/(?:^|[^a-z0-9])daily(?=$|[^a-z0-9])/.test(lower)) return 86400;
  if (/(?:^|[^a-z0-9])weekly(?=$|[^a-z0-9])/.test(lower)) return 604800;
  if (/(?:^|[^a-z0-9])monthly(?=$|[^a-z0-9])/.test(lower)) return 2592000;
  return undefined;
}
function inferWindowDurationSeconds(key: string | undefined, label: string | undefined): number | undefined {
  return parseDurationToken(key) ?? parseDurationToken(label);
}
const GATEWAY_UNSUPPORTED_TTL_MS = 10 * 60_000;
const unsupportedGatewayOrigins = new Map<string, number>();

export function markGatewayQuotaUnsupported(origin: string, now = Date.now()): void {
  unsupportedGatewayOrigins.set(origin.toLowerCase(), now + GATEWAY_UNSUPPORTED_TTL_MS);
}

export function isGatewayQuotaUnsupported(origin: string, now = Date.now()): boolean {
  const key = origin.toLowerCase();
  const expiresAt = unsupportedGatewayOrigins.get(key);
  if (expiresAt === undefined) return false;
  if (now >= expiresAt) {
    unsupportedGatewayOrigins.delete(key);
    return false;
  }
  return true;
}

export function clearGatewayQuotaUnsupportedCache(): void {
  unsupportedGatewayOrigins.clear();
}

const OFFICIAL_VENDOR_HOSTS = [
  'api.kimi.com',
  'chatgpt.com',
  'api.anthropic.com',
  'api.deepseek.com',
  'api.minimax.io',
  'api.minimaxi.com',
  'open.bigmodel.cn',
  'api.z.ai',
  'openrouter.ai',
  'api.stepfun.com',
  'api.siliconflow.cn',
  'api.siliconflow.com',
  'api.novita.ai',
  'api.openai.com',
] as const;

const FIRST_PARTY_NO_API_KEY_QUOTA_HOSTS = new Set([
  'api.openai.com',
  'chatgpt.com',
  'api.anthropic.com',
  'claude.ai',
  'generativelanguage.googleapis.com',
  'aiplatform.googleapis.com',
  'cloudcode-pa.googleapis.com',
  'api.kimi.com',
  'api.moonshot.cn',
  'api.moonshot.ai',
  'api.mistral.ai',
  'api.x.ai',
  'api.groq.com',
  'api.cohere.com',
  'api.together.xyz',
  'api.fireworks.ai',
  'api.perplexity.ai',
  'models.inference.ai.azure.com',
  'dashscope.aliyuncs.com',
]);

function isLocalOrPrivateHost(rawHost: string): boolean {
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

function resolveGatewayUsageUrl(url: URL): string {
  const pathname = url.pathname.replace(/\/+$/u, '');
  if (pathname === '') return `${url.origin}/v1/usage`;
  if (pathname.endsWith('/usage')) return `${url.origin}${pathname}`;
  if (pathname.endsWith('/v1')) return `${url.origin}${pathname}/usage`;
  return `${url.origin}/v1/usage`;
}

export function gatewayQuotaCacheKey(adapter: Pick<QuotaAdapter, 'url' | 'secondaryUrl'>): string {
  return (adapter.secondaryUrl ?? adapter.url).toLowerCase();
}

export function selectQuotaAdapter(baseUrl: string | undefined, oauth: boolean, now = Date.now()): QuotaAdapter | undefined {
  if (!baseUrl) return undefined;
  let url: URL;
  try { url = new URL(baseUrl); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
  const host = url.hostname.toLowerCase();
  if (isLocalOrPrivateHost(host)) return undefined;
  if (!url.port) {
    if (host === 'api.kimi.com' && /^\/coding\/v1\/?$/.test(url.pathname)) return { id: 'kimi', label: 'Kimi Code 官方用量', url: 'https://api.kimi.com/coding/v1/usages', oauth };
    if (oauth && host === 'chatgpt.com' && url.pathname.startsWith('/backend-api/codex')) return { id: 'codex', label: 'ChatGPT / Codex 官方额度', url: 'https://chatgpt.com/backend-api/wham/usage', oauth: true };
    if (oauth && host === 'api.anthropic.com') return { id: 'claude', label: 'Claude 官方套餐用量', url: 'https://api.anthropic.com/api/oauth/usage', oauth: true };
    if (oauth) return undefined;
    if (host === 'api.deepseek.com') return { id: 'deepseek', label: 'DeepSeek 官方余额', url: 'https://api.deepseek.com/user/balance', oauth: false };
    if (host === 'api.minimax.io' || host === 'api.minimaxi.com') return { id: 'minimax', label: 'MiniMax Coding Plan 官方用量', url: `https://${host}/v1/api/openplatform/coding_plan/remains`, oauth: false };
    if (host === 'open.bigmodel.cn' || host === 'api.z.ai') return { id: 'zai', label: host === 'open.bigmodel.cn' ? 'BigModel 官方套餐用量' : 'Z.ai 官方套餐用量', url: `https://${host}/api/monitor/usage/quota/limit`, oauth: false };
    if (host === 'openrouter.ai') return { id: 'openrouter', label: 'OpenRouter 官方额度', url: 'https://openrouter.ai/api/v1/credits', secondaryUrl: 'https://openrouter.ai/api/v1/key', oauth: false };
    if (host === 'api.stepfun.com') return { id: 'stepfun', label: 'StepFun 官方额度', url: 'https://api.stepfun.com/v1/accounts', secondaryUrl: 'https://api.stepfun.com/step_plan/v1/usage', oauth: false };
    if (host === 'api.siliconflow.cn' || host === 'api.siliconflow.com') return { id: host.endsWith('.cn') ? 'siliconflow-cn' : 'siliconflow-global', label: 'SiliconFlow 官方余额', url: `https://${host}/v1/user/info`, oauth: false };
    if (host === 'api.novita.ai') return { id: 'novita', label: 'Novita AI 官方余额', url: 'https://api.novita.ai/v3/user/balance', oauth: false };
  }
  if (oauth) return undefined;
  if (OFFICIAL_VENDOR_HOSTS.some((vendor) => host === vendor || host.startsWith(`${vendor}.`))) return undefined;
  if (FIRST_PARTY_NO_API_KEY_QUOTA_HOSTS.has(host)) return undefined;
  const primaryUrl = `${url.origin}/v1/kiki/quota`;
  const secondaryUrl = resolveGatewayUsageUrl(url);
  if (isGatewayQuotaUnsupported(secondaryUrl.toLowerCase(), now)) return undefined;
  return {
    id: 'kiki-quota',
    label: '网关订阅与凭据额度',
    url: primaryUrl,
    secondaryUrl,
    oauth: false,
  };
}
export function quotaHeaders(adapter: QuotaAdapter, token: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: adapter.id === 'zai' ? token : `Bearer ${token}`, Accept: 'application/json' };
  if (adapter.id === 'codex') {
    headers['User-Agent'] = 'codex-cli';
    const account = openaiCodexAccountId(token);
    if (account) headers['ChatGPT-Account-Id'] = account;
  }
  if (adapter.id === 'claude') headers['anthropic-beta'] = 'oauth-2025-04-20';
  return headers;
}
export function parseQuota(adapter: QuotaAdapterId, payload: unknown, now: number): ProviderQuotaMeter[] {
  const body = record(payload);
  const shape = adapter === 'kimi' ? body['usages'] !== undefined || body['usage'] !== undefined || Array.isArray(body['limits'])
    : adapter === 'codex' ? body['rate_limit'] !== undefined || body['credits'] !== undefined
    : adapter === 'claude' ? Object.keys(body).some((key) => key.startsWith('five_hour') || key.startsWith('seven_day') || key === 'extra_usage')
    : adapter === 'deepseek' ? Array.isArray(body['balance_infos'])
    : adapter === 'minimax' ? Array.isArray(body['model_remains'])
    : adapter === 'zai' ? Array.isArray(record(body['data'])['limits'])
    : adapter === 'openrouter' ? body['data'] !== undefined || body['credits'] !== undefined || body['key'] !== undefined
    : adapter === 'stepfun' ? body['balance'] !== undefined || isStepPlanPayload(body)
    : adapter === 'kiki-quota' ? (
        body['object'] === 'kiki.key_quota'
        || Array.isArray(body['pool_quotas'])
        || (body['object'] === 'list' && (body['exposed'] === true || (Array.isArray(body['data']) && body['summary'] !== undefined)))
        || (body['unit'] !== undefined && ((body['daily'] !== null && typeof body['daily'] === 'object') || (body['weekly'] !== null && typeof body['weekly'] === 'object')))
      )
    : adapter === 'novita' ? body['availableBalance'] !== undefined : body['data'] !== undefined;
  if (!shape) throw new Error('invalid_response');
  const meters: (ProviderQuotaMeter | undefined)[] = [];
  if (adapter === 'kimi') {
    const parsed = parseManagedUsagePayload(payload);
    for (const [index, row] of [parsed.summary, ...parsed.limits].entries()) {
      if (!row || row.unit !== 'percent') continue;
      const seconds = row.window ? row.window.duration * ({ minute: 60, hour: 3600, day: 86400, week: 604800 }[row.window.unit]) : undefined;
      const label = row.name ?? (seconds ? windowLabel(seconds) : '套餐额度');
      meters.push(percent(`quota-${index}`, label, row.used, date(row.resetAt), seconds));
    }
    if (body['usages'] === undefined) {
      for (const [index, raw] of [body['usage'], ...array(body['limits'])].entries()) {
        const input = index === 0 ? record(raw) : record(record(raw)['detail']);
        const row = index === 0 ? parseManagedUsagePayload({ usage: raw }).summary : parseManagedUsagePayload({ limits: [raw] }).limits[0];
        if (!row) continue;
        const used = num(input['used']); const limit = num(input['limit']);
        const remaining = num(input['remaining']) ?? (used !== null && limit !== null ? Math.max(0, limit - used) : null);
        const seconds = row.window ? row.window.duration * ({ minute: 60, hour: 3600, day: 86400, week: 604800 }[row.window.unit]) : undefined;
        const label = row.name ?? (seconds ? windowLabel(seconds) : '套餐额度');
        meters.push({ id: `legacy-${index}`, label, unit: 'count', unit_label: '次', scope: 'account', used, limit, remaining, window: { label, duration_seconds: seconds, reset_at: date(row.resetAt), reset_timezone: row.resetAt ? 'UTC' : undefined } });
      }
    }
    if (parsed.extraUsage) {
      const wallet = parsed.extraUsage; const raw = record(body['boosterWallet']);
      const currency = text(record(raw['monthlyChargeLimit'])['currency']) ?? text(record(raw['monthlyUsed'])['currency']);
      const remaining = num(record(raw['balance'])['amountLeft']) === null ? null : wallet.balanceCents / 100;
      meters.push({ id: 'booster', label: '加量包余额', unit: 'money', unit_label: currency ?? '货币', currency, scope: 'account', used: null, limit: null, remaining });
    }
  }
  if (adapter === 'codex') {
    const rate = record(body['rate_limit']);
    for (const key of ['primary_window', 'secondary_window']) {
      const row = record(rate[key]);
      const seconds = num(row['limit_window_seconds']);
      meters.push(percent(key, seconds ? windowLabel(seconds) : '套餐窗口', row['used_percent'], date(row['reset_at'], 1000), seconds ?? undefined));
    }
    const credits = record(body['credits']);
    const balance = num(credits['balance']);
    if (balance !== null) meters.push({ id: 'credits', label: 'Credits', unit: 'credits', unit_label: 'credits', remaining: balance, limit: null, used: null, scope: 'account' });
  }
  if (adapter === 'claude') {
    for (const [key, raw] of Object.entries(body)) {
      const row = record(raw);
      if (key === 'extra_usage') continue;
      const seconds = key.startsWith('five_hour') ? 18000 : key.startsWith('seven_day') ? 604800 : undefined;
      const group = key.includes('opus') ? 'Opus' : key.includes('sonnet') ? 'Sonnet' : undefined;
      const label = (seconds ? windowLabel(seconds) : key.replaceAll('_', ' ')) + (group ? ` · ${group}` : '');
      meters.push(percent(key, label, row['utilization'], date(row['resets_at']), seconds, group));
    }
    const extra = record(body['extra_usage']);
    if (extra['is_enabled'] === true) meters.push(percent('extra', '额外用量 · 月度', extra['utilization']));
  }
  if (adapter === 'deepseek') {
    for (const [index, raw] of array(body['balance_infos']).entries()) {
      const row = record(raw); const currency = text(row['currency']); const remaining = num(row['total_balance']);
      if (currency && remaining !== null) meters.push({ id: `balance-${index}`, label: `${currency} 余额`, unit: 'money', unit_label: currency, currency, scope: 'account', used: null, limit: null, remaining });
    }
  }
  if (adapter === 'minimax') {
    const status = record(body['base_resp'])['status_code'];
    if (status !== undefined && status !== 0) throw new Error('invalid_response');
    const row = record(array(body['model_remains']).find((raw) => record(raw)['model_name'] === 'general'));
    const remain = num(row['current_interval_remaining_percent']);
    meters.push(percent('5h', '5小时', remain === null ? null : 100 - remain, date(row['end_time']), 18000, 'general'));
    if (row['current_weekly_status'] === 1) {
      const weekly = num(row['current_weekly_remaining_percent']);
      meters.push(percent('7d', '7天', weekly === null ? null : 100 - weekly, date(row['weekly_end_time']), 604800, 'general'));
    }
  }
  if (adapter === 'zai') {
    if (body['success'] !== true || body['code'] !== 200) throw new Error('invalid_response');
    for (const [index, raw] of array(record(body['data'])['limits']).entries()) {
      const row = record(raw); const type = row['type'];
      if (!['TOKENS_LIMIT', 'CREDIT_LIMIT', 'TIME_LIMIT'].includes(String(type))) continue;
      const unit = num(row['unit']); const count = num(row['number']);
      const seconds = count !== null && count > 0 ? count * (zaiWindowUnits[unit ?? 0] ?? 0) : 0;
      const reset = num(row['nextResetTime']);
      const plausible = reset !== null && (seconds !== 18000 || reset <= now + 18060000);
      const label = type === 'TIME_LIMIT' ? 'MCP 套餐限额' : `${seconds ? windowLabel(seconds) : '套餐'} · ${type === 'CREDIT_LIMIT' ? 'Credits' : 'Tokens'}`;
      meters.push(percent(`limit-${index}`, label, row['percentage'], plausible ? date(reset) : undefined, seconds || undefined));
    }
  }
  if (adapter === 'openrouter') {
    const parseCreditsRow = (row: Record<string, unknown>): void => {
      const totalCredits = num(row['total_credits']);
      const totalUsage = num(row['total_usage']);
      if (totalCredits === null && totalUsage === null) return;
      const remaining = totalCredits !== null && totalUsage !== null ? Math.round((totalCredits - totalUsage) * 1e6) / 1e6 : null;
      meters.push({ id: 'account-credits', label: '账户余额', unit: 'money', unit_label: 'USD', currency: 'USD', scope: 'account', used: totalUsage, limit: totalCredits, remaining });
    };
    const parseKeyRow = (row: Record<string, unknown>): void => {
      const limit = num(row['limit']);
      const used = num(row['usage']);
      const remaining = num(row['limit_remaining']);
      if (remaining !== null || limit !== null || used !== null) {
        meters.push({ id: 'key-limit', label: 'API Key 额度', unit: 'money', unit_label: 'USD', currency: 'USD', scope: 'key', used, limit, remaining, window: text(row['limit_reset']) ? { label: String(row['limit_reset']) } : undefined });
      }
    };
    if (body['credits'] !== undefined) parseCreditsRow(record(record(body['credits'])['data'] ?? body['credits']));
    if (body['key'] !== undefined) parseKeyRow(record(record(body['key'])['data'] ?? body['key']));
    if (body['data'] !== undefined) {
      const row = record(body['data']);
      parseCreditsRow(row);
      parseKeyRow(row);
    }
  }
  if (adapter === 'stepfun') {
    const balance = num(body['balance']);
    if (balance !== null) {
      meters.push({ id: 'balance', label: 'CNY 余额', unit: 'money', unit_label: 'CNY', currency: 'CNY', scope: 'account', used: null, limit: null, remaining: balance });
    }
    if (isStepPlanPayload(body)) {
      const plan = body['data'] !== undefined && typeof body['data'] === 'object' && body['data'] !== null && !Array.isArray(body['data'])
        ? record(body['data'])
        : body;
      const status = num(plan['status']);
      if (status !== null && status !== 0 && status !== 1) throw new Error('invalid_response');
      const creditLimit = record(plan['plan_credit_rate_limit']);
      const fiveHourReset = unixDate(plan['five_hour_usage_reset_time']);
      const weeklyReset = unixDate(plan['weekly_usage_reset_time']);
      const isCreditPlan = num(plan['plan_family']) === 2 || (
        plan['plan_credit_rate_limit'] !== undefined &&
        fiveHourReset === undefined &&
        weeklyReset === undefined &&
        (num(plan['five_hour_usage_left_rate']) ?? 0) === 0 &&
        (num(plan['weekly_usage_left_rate']) ?? 0) === 0
      );
      if (isCreditPlan) {
        const buckets = array(creditLimit['credit_buckets']);
        let bucketTotal = 0;
        let bucketResidual = 0;
        let hasBuckets = false;
        let earliestResetMs: number | undefined;
        for (const item of buckets) {
          const entry = record(item);
          const total = num(entry['credit_total']);
          const residual = num(entry['credit_residual']);
          if (total === null || total <= 0 || residual === null || residual < 0) continue;
          hasBuckets = true;
          bucketTotal += total;
          bucketResidual += residual;
          const resetIso = unixDate(entry['next_reset_at']) ?? unixDate(entry['expire_at']);
          if (resetIso !== undefined) {
            const ms = Date.parse(resetIso);
            if (earliestResetMs === undefined || ms < earliestResetMs) earliestResetMs = ms;
          }
        }
        const resetAt = unixDate(creditLimit['subscription_credit_reset_time'])
          ?? (earliestResetMs !== undefined ? new Date(earliestResetMs).toISOString() : undefined);
        if (hasBuckets) {
          meters.push({
            id: 'step-plan-credits', label: 'Step Plan 额度', unit: 'credits', unit_label: 'credits', scope: 'account',
            used: Math.max(0, bucketTotal - bucketResidual), limit: bucketTotal, remaining: bucketResidual,
            window: resetAt ? { label: '订阅周期', reset_at: resetAt, reset_timezone: 'UTC' } : undefined,
          });
        } else {
          const total = num(creditLimit['credit_total']);
          const residual = num(creditLimit['credit_residual']);
          if (total !== null && total > 0 && residual !== null && residual >= 0) {
            meters.push({
              id: 'step-plan-credits', label: 'Step Plan 额度', unit: 'credits', unit_label: 'credits', scope: 'account',
              used: Math.max(0, total - residual), limit: total, remaining: residual,
              window: resetAt ? { label: '订阅周期', reset_at: resetAt, reset_timezone: 'UTC' } : undefined,
            });
          } else {
            const leftUsed = stepLeftRateToUsedPercent(creditLimit['subscription_credit_left_rate'])
              ?? stepLeftRateToUsedPercent(creditLimit['topup_credit_left_rate']);
            if (leftUsed !== null) meters.push(percent('step-plan-credits', 'Step Plan 额度', leftUsed, resetAt));
          }
        }
      } else {
        if (fiveHourReset !== undefined) {
          const used5h = stepLeftRateToUsedPercent(plan['five_hour_usage_left_rate']);
          if (used5h !== null) meters.push(percent('step-plan-5h', '5小时', used5h, fiveHourReset, 18000));
        }
        if (weeklyReset !== undefined) {
          const used7d = stepLeftRateToUsedPercent(plan['weekly_usage_left_rate']);
          if (used7d !== null) meters.push(percent('step-plan-7d', '7天', used7d, weeklyReset, 604800));
        }
      }
    }
  }
  if (adapter === 'siliconflow-cn' || adapter === 'siliconflow-global' || adapter === 'novita') {
    const raw = adapter === 'novita' ? body['availableBalance'] : record(body['data'])['totalBalance'];
    const value = num(raw);
    const currency = adapter === 'siliconflow-cn' ? 'CNY' : 'USD';
    if (value !== null) meters.push({ id: 'balance', label: `${currency} 余额`, unit: 'money', unit_label: currency, currency, scope: 'account', used: null, limit: null, remaining: adapter === 'novita' ? value / 10000 : value });
  }
  if (adapter === 'kiki-quota') {
    const usedIds = new Set<string>();
    const uniqueId = (base: string, fallback: string): string => {
      const candidate = usedIds.has(base) ? `${base}-${fallback}` : base;
      usedIds.add(candidate);
      return candidate;
    };
    const keyInfo = record(body['key']);
    const channelTag = array(keyInfo['channel_tags']).map(text).find((tag): tag is string => tag !== undefined);
    const groupTag = channelTag ?? text(keyInfo['group_name']);
    for (const [poolIndex, rawPool] of array(body['pool_quotas']).entries()) {
      const pool = record(rawPool);
      const slug = text(pool['slug']);
      const title = text(pool['title']) ?? slug ?? `Pool ${poolIndex + 1}`;
      const poolKey = slug ?? String(poolIndex);
      for (const [windowIndex, rawWindow] of array(pool['windows']).entries()) {
        const win = record(rawWindow);
        const winKey = text(win['key']);
        const winLabel = text(win['label']) ?? winKey;
        const usedDirect = num(win['usedPercent']);
        const remainingDirect = num(win['remainingPercent']);
        const used = usedDirect ?? (remainingDirect !== null ? Math.round((100 - remainingDirect) * 1e6) / 1e6 : null);
        if (used === null) continue;
        const durationSeconds = inferWindowDurationSeconds(winKey, winLabel);
        const label = winLabel ? `${title} · ${winLabel}` : title;
        const id = uniqueId(`pool-${poolKey}-${winKey ?? windowIndex}`, `${poolIndex}-${windowIndex}`);
        meters.push(percent(id, label, used, date(win['resetAt']), durationSeconds, title));
      }
    }
    const personal = record(body['personal_usage']);
    const personalSpecs: ReadonlyArray<readonly [string, string, string, string]> = [
      ['requests_today', 'personal-requests-today', '今日请求', '次'],
      ['tokens_today', 'personal-tokens-today', '今日 Tokens', 'tokens'],
      ['tokens_7d', 'personal-tokens-7d', '7日 Tokens', 'tokens'],
    ];
    for (const [field, id, title, unitLabel] of personalSpecs) {
      const value = num(personal[field]);
      if (value === null || value < 0) continue;
      meters.push({
        id: uniqueId(id, field),
        label: groupTag ? `${groupTag} · ${title}` : title,
        unit: 'count',
        unit_label: unitLabel,
        scope: 'key',
        model_group: groupTag,
        used: value,
        limit: null,
        remaining: null,
      });
    }
    if (body['unit'] !== undefined && ((body['daily'] !== null && typeof body['daily'] === 'object') || (body['weekly'] !== null && typeof body['weekly'] === 'object'))) {
      const rawUnit = text(body['unit']);
      const upperUnit = rawUnit?.toUpperCase();
      const isFiat = upperUnit === 'USD' || upperUnit === 'CNY' || upperUnit === 'EUR';
      const isPercent = upperUnit === 'PERCENT' || upperUnit === '%';
      const isCount = upperUnit === 'TOKENS' || upperUnit === 'REQUESTS';
      const meterUnit: ProviderQuotaMeter['unit'] = isFiat ? 'money' : isPercent ? 'percent' : isCount ? 'count' : 'credits';
      const meterUnitLabel = isFiat ? upperUnit! : isPercent ? '%' : (rawUnit ?? 'credits');
      const windowDefs: ReadonlyArray<readonly [string, string, string, number]> = [
        ['daily', '今日用量', '24h', 86400],
        ['weekly', '本周用量', '7d', 604800],
      ];
      for (const [key, label, shortLabel, durationSeconds] of windowDefs) {
        const rawWin = body[key];
        if (rawWin === null || typeof rawWin !== 'object' || Array.isArray(rawWin)) continue;
        const win = record(rawWin);
        const total = num(win['total'] ?? win['limit']);
        const used = num(win['used']);
        const remDirect = num(win['remaining']);
        const remaining = remDirect ?? (total !== null && used !== null ? Math.max(0, Math.round((total - used) * 1e6) / 1e6) : null);
        if (used === null && total === null && remaining === null) continue;
        const resetAt = date(win['resetsAt'] ?? win['resetAt'] ?? win['reset_at']);
        meters.push({
          id: uniqueId(`usage-${key}`, key),
          label,
          unit: meterUnit,
          unit_label: meterUnitLabel,
          ...(isFiat ? { currency: upperUnit } : {}),
          scope: 'key',
          used,
          limit: total,
          remaining,
          window: {
            label: shortLabel,
            duration_seconds: durationSeconds,
            ...(resetAt !== undefined ? { reset_at: resetAt, reset_timezone: 'UTC' } : {}),
          },
        });
      }
    }
    if (body['object'] === 'list' && Array.isArray(body['data'])) {
      const dataAsOf = date(body['generated_at']);
      if (body['exposed'] === true && array(body['data']).length === 0) {
        meters.push({
          id: uniqueId('gateway-exhausted', 'pool'),
          label: '渠道池额度（已耗尽）',
          unit: 'percent',
          unit_label: '%',
          scope: 'account',
          used: 100,
          limit: 100,
          remaining: 0,
          ...(dataAsOf !== undefined ? { data_as_of: dataAsOf } : {}),
        });
      }
      const listSummary = record(body['summary']);
      const totalKeys = num(listSummary['total_keys']);
      const availableKeys = num(listSummary['available_keys']) ?? num(listSummary['active_keys']);
      let emittedBalanceMeters = 0;
      for (const [channelIndex, rawChannel] of array(body['data']).entries()) {
        const channel = record(rawChannel);
        const channelId = num(channel['channel_id']) ?? channelIndex + 1;
        const channelName = text(channel['channel_name']) ?? `Channel ${channelId}`;
        const qSummary = record(channel['quota_summary']);
        const totalRem = num(qSummary['total_remaining']);
        const totalUsed = num(qSummary['total_used']);
        const totalLim = num(qSummary['total_limit']);
        if (totalRem === null && totalUsed === null && totalLim === null) continue;
        emittedBalanceMeters += 1;
        const rawCurrency = text(qSummary['currency'])?.toUpperCase();
        const isFiat = rawCurrency === 'USD' || rawCurrency === 'CNY' || rawCurrency === 'EUR';
        const isPercent = rawCurrency === 'PERCENT' || rawCurrency === '%';
        meters.push({
          id: uniqueId(`channel-${channelId}-quota`, String(channelIndex)),
          label: channelName,
          unit: isFiat ? 'money' : isPercent ? 'percent' : 'credits',
          unit_label: isFiat ? rawCurrency : isPercent ? '%' : (rawCurrency ?? 'credits').toLowerCase(),
          ...(isFiat ? { currency: rawCurrency } : {}),
          scope: 'account',
          used: totalUsed,
          limit: totalLim,
          remaining: totalRem,
          ...(dataAsOf !== undefined ? { data_as_of: dataAsOf } : {}),
        });
      }
      if (totalKeys !== null && availableKeys !== null && totalKeys > 0) {
        meters.push({
          id: uniqueId('gateway-available-keys', 'pool'),
          label: '可用上游凭据池',
          unit: 'count',
          unit_label: '把',
          scope: 'account',
          used: Math.max(0, totalKeys - availableKeys),
          limit: totalKeys,
          remaining: availableKeys,
          ...(dataAsOf !== undefined ? { data_as_of: dataAsOf } : {}),
        });
      } else if (emittedBalanceMeters === 0) {
        for (const [channelIndex, rawChannel] of array(body['data']).slice(0, 6).entries()) {
          const channel = record(rawChannel);
          const channelId = num(channel['channel_id']) ?? channelIndex + 1;
          const channelName = text(channel['channel_name']) ?? `Channel ${channelId}`;
          const counts = record(channel['key_counts']);
          const chTotal = num(counts['total']);
          const chActive = num(counts['active']);
          if (chTotal === null || chActive === null || chTotal <= 0) continue;
          meters.push({
            id: uniqueId(`channel-${channelId}-keys`, String(channelIndex)),
            label: `${channelName} · 可用 Key`,
            unit: 'count',
            unit_label: '把',
            scope: 'account',
            used: Math.max(0, chTotal - chActive),
            limit: chTotal,
            remaining: chActive,
            ...(dataAsOf !== undefined ? { data_as_of: dataAsOf } : {}),
          });
        }
      }
    }
  }
  return meters.filter((meter): meter is ProviderQuotaMeter => meter !== undefined);
}
function windowLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}天`;
  if (seconds % 3600 === 0) return `${seconds / 3600}小时`;
  return `${seconds}秒`;
}
