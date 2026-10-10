import type { ProviderQuotaMeter } from '@kiki/protocol';
import { parseManagedUsagePayload, openaiCodexAccountId } from '@kiki/oauth';

export type QuotaAdapterId = 'kimi' | 'codex' | 'claude' | 'deepseek' | 'minimax' | 'zai' | 'openrouter' | 'stepfun' | 'siliconflow-cn' | 'siliconflow-global' | 'novita';
export interface QuotaAdapter { id: QuotaAdapterId; label: string; url: string; oauth: boolean }
export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const num = (value: unknown): number | null => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) ? Number(value) : null;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const zaiWindowUnits: Record<number, number> = { 1: 86400, 3: 3600, 5: 60, 6: 604800 };
function date(value: unknown, scale = 1): string | undefined {
  const millis = typeof value === 'number' ? value * scale : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(millis) && Math.abs(millis) < 8.64e15 ? new Date(millis).toISOString() : undefined;
}
function percent(id: string, label: string, used: unknown, reset?: string, seconds?: number, group?: string): ProviderQuotaMeter | undefined {
  const value = num(used);
  if (value === null || value < 0 || value > 100) return undefined;
  return { id, label, unit: 'percent', unit_label: '%', used: value, limit: 100, remaining: 100 - value, scope: 'account', model_group: group,
    window: { label, duration_seconds: seconds && seconds > 0 ? seconds : undefined, reset_at: reset, reset_timezone: reset ? 'UTC' : undefined } };
}
export function selectQuotaAdapter(baseUrl: string | undefined, oauth: boolean): QuotaAdapter | undefined {
  if (!baseUrl) return undefined;
  let url: URL;
  try { url = new URL(baseUrl); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return undefined;
  const host = url.hostname.toLowerCase();
  if (host === 'api.kimi.com' && /^\/coding\/v1\/?$/.test(url.pathname)) return { id: 'kimi', label: 'Kimi Code 官方用量', url: 'https://api.kimi.com/coding/v1/usages', oauth };
  if (oauth && host === 'chatgpt.com' && url.pathname.startsWith('/backend-api/codex')) return { id: 'codex', label: 'ChatGPT / Codex 官方额度', url: 'https://chatgpt.com/backend-api/wham/usage', oauth: true };
  if (oauth && host === 'api.anthropic.com') return { id: 'claude', label: 'Claude 官方套餐用量', url: 'https://api.anthropic.com/api/oauth/usage', oauth: true };
  if (oauth) return undefined;
  if (host === 'api.deepseek.com') return { id: 'deepseek', label: 'DeepSeek 官方余额', url: 'https://api.deepseek.com/user/balance', oauth: false };
  if (host === 'api.minimax.io' || host === 'api.minimaxi.com') return { id: 'minimax', label: 'MiniMax Coding Plan 官方用量', url: `https://${host}/v1/api/openplatform/coding_plan/remains`, oauth: false };
  if (host === 'open.bigmodel.cn' || host === 'api.z.ai') return { id: 'zai', label: host === 'open.bigmodel.cn' ? 'BigModel 官方套餐用量' : 'Z.ai 官方套餐用量', url: `https://${host}/api/monitor/usage/quota/limit`, oauth: false };
  if (host === 'openrouter.ai') return { id: 'openrouter', label: 'OpenRouter 官方 key 额度', url: 'https://openrouter.ai/api/v1/key', oauth: false };
  if (host === 'api.stepfun.com') return { id: 'stepfun', label: 'StepFun 官方余额', url: 'https://api.stepfun.com/v1/accounts', oauth: false };
  if (host === 'api.siliconflow.cn' || host === 'api.siliconflow.com') return { id: host.endsWith('.cn') ? 'siliconflow-cn' : 'siliconflow-global', label: 'SiliconFlow 官方余额', url: `https://${host}/v1/user/info`, oauth: false };
  if (host === 'api.novita.ai') return { id: 'novita', label: 'Novita AI 官方余额', url: 'https://api.novita.ai/v3/user/balance', oauth: false };
  return undefined;
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
    : adapter === 'openrouter' ? body['data'] !== undefined
    : adapter === 'stepfun' ? body['balance'] !== undefined
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
      meters.push({ id: 'booster', label: '加量包余额', unit: 'money', unit_label: currency ?? '货币（币种未提供）', currency, scope: 'account', used: null, limit: null, remaining });
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
    const row = record(body['data']); const limit = num(row['limit']); const used = num(row['usage']);
    const remaining = num(row['limit_remaining']);
    if (remaining !== null || limit !== null || used !== null) meters.push({ id: 'key-limit', label: 'API Key 额度（非账户总余额）', unit: 'money', unit_label: 'USD', currency: 'USD', scope: 'key', used, limit, remaining, window: text(row['limit_reset']) ? { label: String(row['limit_reset']) } : undefined });
  }
  if (adapter === 'stepfun' || adapter === 'siliconflow-cn' || adapter === 'siliconflow-global' || adapter === 'novita') {
    const raw = adapter === 'stepfun' ? body['balance'] : adapter === 'novita' ? body['availableBalance'] : record(body['data'])['totalBalance'];
    const value = num(raw);
    const currency = adapter === 'stepfun' || adapter === 'siliconflow-cn' ? 'CNY' : 'USD';
    if (value !== null) meters.push({ id: 'balance', label: `${currency} 余额`, unit: 'money', unit_label: currency, currency, scope: 'account', used: null, limit: null, remaining: adapter === 'novita' ? value / 10000 : value });
  }
  return meters.filter((meter): meter is ProviderQuotaMeter => meter !== undefined);
}
function windowLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}天`;
  if (seconds % 3600 === 0) return `${seconds / 3600}小时`;
  return `${seconds}秒`;
}
