import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { providerQuotaSnapshotSchema } from '@kiki/protocol';
import { parseQuota, selectQuotaAdapter, quotaHeaders } from '../src/usage/quota/adapters';
import { ProviderQuotaService, QuotaFailure, type QuotaTarget } from '../src/usage/quota/service';
import { registerProviderQuotaRoutes } from '../src/routes/providerQuota';
import { createProviderQuotaFacade } from '../../klient/src/transports/http/provider-quota';
import { fetchOfficialQuota } from '../src/usage/quota/fetch';

const time = Date.parse('2026-10-10T04:00:00Z');
const reset = '2026-10-10T05:00:00+08:00';
function fixture() {
  let now = time; let prefs: Record<string, boolean> = {};
  const fetchQuota = vi.fn(async () => parseQuota('codex', { rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: time / 1000 + 3600 } } }, time));
  const target: QuotaTarget = { id: 'provider:example', label: 'Example', kind: 'provider', providerId: 'example', accountLabel: 'Example account', revision: 'account-a', active: true, supported: true, auth: { action: 'oauth_login', provider: 'example' }, source: { label: 'Official usage', url: 'https://example.test/usage' }, fetch: fetchQuota };
  const sources = [target];
  const service = new ProviderQuotaService(async () => sources, { read: async () => prefs, update: async (id, enabled) => { prefs = { ...prefs, [id]: enabled }; } }, () => now);
  return { service, target, sources, fetchQuota, advance: (ms: number) => { now += ms; } };
}
describe('provider quotas', () => {
  it('does not fetch on reads, enable, off refresh, unsupported or disconnected targets', async () => {
    const f = fixture();
    expect((await f.service.snapshot()).sources[0].status).toBe('unknown');
    await f.service.setEnabled(f.target.id, false);
    expect((await f.service.refresh(f.target.id)).sources[0].status).toBe('off');
    await f.service.setEnabled(f.target.id, true);
    f.target.supported = false;
    expect((await f.service.refresh(f.target.id)).sources[0].status).toBe('unsupported');
    f.target.supported = true; f.target.active = false;
    await f.service.refresh(f.target.id);
    expect(f.fetchQuota).not.toHaveBeenCalled();
  });
  it('keeps zero distinct, serves stale after TTL/reset and retains last good only on same account errors', async () => {
    const f = fixture();
    const ready = (await f.service.refresh(f.target.id)).sources[0];
    expect(ready.status).toBe('ready'); expect(ready.meters[0].remaining).toBe(0);
    await f.service.refresh(f.target.id); expect(f.fetchQuota).toHaveBeenCalledTimes(1);
    f.advance(300001);
    expect((await f.service.snapshot()).sources[0].status).toBe('stale');
    f.fetchQuota.mockRejectedValueOnce(new QuotaFailure('request_failed'));
    const stale = (await f.service.refresh(f.target.id)).sources[0];
    expect(stale.status).toBe('stale'); expect(stale.meters[0].remaining).toBe(0); expect(stale.data_as_of).toBe(ready.data_as_of);
    f.target.revision = 'account-b';
    expect((await f.service.snapshot()).sources[0].meters).toEqual([]);
    f.fetchQuota.mockRejectedValueOnce(new QuotaFailure('auth_required'));
    const auth = (await f.service.refresh(f.target.id)).sources[0];
    expect(auth.status).toBe('auth_required'); expect(auth.meters).toEqual([]);
  });
  it('single-flights refresh, drops late results after disable or account replacement', async () => {
    const f = fixture(); let finish!: () => void;
    f.fetchQuota.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { finish = resolve; }); return []; });
    const first = f.service.refresh(f.target.id);
    await vi.waitFor(() => expect(f.fetchQuota).toHaveBeenCalledTimes(1));
    const second = f.service.refresh(f.target.id);
    await f.service.setEnabled(f.target.id, false); finish(); await Promise.all([first, second]);
    expect((await f.service.snapshot()).sources[0].status).toBe('off');
    await f.service.setEnabled(f.target.id, true);
    expect((await f.service.snapshot()).sources[0].checked_at).toBeUndefined();
  });
  it('does not add independent accounts and rejects missing source identifiers', async () => {
    const f = fixture(); f.sources.push({ ...f.target, id: 'provider:second', revision: 'second-account' });
    const data = await f.service.refresh(f.target.id);
    expect(data.sources).toHaveLength(2); expect(data.sources[1].meters).toEqual([]);
    await expect(f.service.refresh('provider:missing')).rejects.toThrow('quota_source_not_found');
  });
  it('ports Codex and Claude percent windows with timezone instants and model groups', () => {
    const codex = parseQuota('codex', { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: time / 1000 + 3600 }, secondary_window: { used_percent: 10, limit_window_seconds: 2592000 } }, credits: { balance: '0' } }, time);
    expect(codex[0]).toMatchObject({ remaining: 75, unit: 'percent', window: { duration_seconds: 18000, reset_at: '2026-10-10T05:00:00.000Z', reset_timezone: 'UTC' } });
    expect(codex[1].window?.label).toBe('30天'); expect(codex[2].remaining).toBe(0);
    const claude = parseQuota('claude', { seven_day_opus: { utilization: 40, resets_at: reset }, five_hour: { utilization: null } }, time);
    expect(claude).toHaveLength(1); expect(claude[0]).toMatchObject({ model_group: 'Opus', remaining: 60, window: { reset_at: '2026-10-09T21:00:00.000Z' } });
  });
  it('preserves money instead of tokens and MiniMax only active general plan windows', () => {
    expect(parseQuota('deepseek', { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34' }, { currency: 'USD', total_balance: '0' }] }, time).map((m) => [m.currency, m.remaining])).toEqual([['CNY', 12.34], ['USD', 0]]);
    expect(parseQuota('stepfun', { balance: '9.50' }, time)[0]).toMatchObject({ currency: 'CNY', remaining: 9.5 });
    expect(parseQuota('siliconflow-global', { data: { totalBalance: '2' } }, time)[0]).toMatchObject({ currency: 'USD', remaining: 2 });
    expect(parseQuota('novita', { availableBalance: 12345 }, time)[0]).toMatchObject({ currency: 'USD', remaining: 1.2345 });
    const payload = { base_resp: { status_code: 0 }, model_remains: [{ model_name: 'video', current_interval_remaining_percent: 10 }, { model_name: 'general', current_interval_remaining_percent: 80, end_time: time + 3600000, current_weekly_status: 3, current_weekly_remaining_percent: 100 }] };
    const minimax = parseQuota('minimax', payload, time); expect(minimax).toHaveLength(1); expect(minimax[0]).toMatchObject({ remaining: 80, used: 20, model_group: 'general' });
  });
  it('adapts ZAI units without inventing absolute tokens or an implausible 5h reset', () => {
    const meters = parseQuota('zai', { success: true, code: 200, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 20, usage: 100000, nextResetTime: time + 604800000 }, { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 0, nextResetTime: time + 3600000 }] } }, time);
    expect(meters[0]).toMatchObject({ unit: 'percent', limit: 100, remaining: 80 }); expect(meters[0].window?.reset_at).toBeUndefined();
    expect(meters[1].window?.duration_seconds).toBe(604800);
  });
  it('reuses Kimi typed parser and does not conflate OpenRouter key cap with account balance', () => {
    const kimi = parseQuota('kimi', { usages: { limit_5h: { used_ratio: 0 }, limit_7d: { used_ratio: 0.4 } } }, time);
    expect(kimi.map((m) => m.remaining)).toEqual([60, 100]); expect(kimi.every((m) => m.unit === 'percent')).toBe(true);
    expect(parseQuota('kimi', { usage: { limit: '100' } }, time)[0]).toMatchObject({ used: null, limit: 100, remaining: null });
    expect(parseQuota('kimi', { usage: { used: '0', limit: '100' } }, time)[0]).toMatchObject({ used: 0, remaining: 100 });
    const router = parseQuota('openrouter', { data: { limit: null, limit_remaining: null, usage: 4 } }, time)[0];
    expect(router).toMatchObject({ scope: 'key', remaining: null, limit: null, used: 4 });
  });
  it('selects official hosts only and prevents OAuth credentials from API-key balance calls', () => {
    for (const url of ['http://api.deepseek.com', 'https://api.deepseek.com.evil.test', 'https://proxy.example.test', 'https://secret@api.deepseek.com', 'https://api.deepseek.com:444', 'https://api.deepseek.com?x=1']) expect(selectQuotaAdapter(url, false)).toBeUndefined();
    expect(selectQuotaAdapter('https://api.deepseek.com', true)).toBeUndefined();
    const zai = selectQuotaAdapter('https://api.z.ai/api/paas/v4', false)!;
    expect(quotaHeaders(zai, 'YOUR_API_KEY').Authorization).toBe('YOUR_API_KEY');
  });
  it('uses bounded read-only requests, rejects redirects/auth/oversized or malformed data without leaking secrets', async () => {
    const adapter = selectQuotaAdapter('https://api.deepseek.com', false)!;
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error'); expect(init?.method ?? 'GET').toBe('GET'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer YOUR_API_KEY');
      return new Response(JSON.stringify({ balance_infos: [{ currency: 'USD', total_balance: '0' }] }));
    });
    expect((await fetchOfficialQuota(adapter, 'YOUR_API_KEY', request))[0].remaining).toBe(0);
    for (const [status, reason] of [[401, 'auth_required'], [403, 'auth_required'], [429, 'rate_limited'], [500, 'request_failed']] as const) {
      await expect(fetchOfficialQuota(adapter, 'YOUR_API_KEY', async () => new Response('secret body YOUR_API_KEY', { status }))).rejects.toMatchObject({ reason, message: reason });
    }
    await expect(fetchOfficialQuota(adapter, 'YOUR_API_KEY', async () => new Response('bad json'))).rejects.toMatchObject({ reason: 'invalid_response' });
    await expect(fetchOfficialQuota(adapter, 'YOUR_API_KEY', async () => new Response('x'.repeat(1024 * 1024 + 1)))).rejects.toMatchObject({ reason: 'invalid_response' });
  });
  it('runs real route and typed-helper flow with isolated targets, validates inputs and returns no credentials', async () => {
    const f = fixture(); const app = Fastify(); registerProviderQuotaRoutes(app, f.service);
    const client = createProviderQuotaFacade({ json: async <T>(path: string, options?: { method?: string; body?: unknown }) => {
      const response = await app.inject({ method: (options?.method ?? 'GET') as 'GET' | 'POST' | 'PUT', url: '/api' + path, payload: options?.body });
      const envelope = response.json(); if (envelope.code !== 0) throw new Error(envelope.msg); return envelope.data as T;
    } });
    try {
      expect(providerQuotaSnapshotSchema.parse(await client.snapshot()).sources[0].status).toBe('unknown');
      expect((await client.refresh(f.target.id)).sources[0].status).toBe('ready');
      expect((await client.setEnabled(f.target.id, false)).sources[0].status).toBe('off');
      const invalid = await app.inject({ method: 'POST', url: '/api/usage/provider-quotas/refresh', payload: { source_id: f.target.id, api_key: 'YOUR_API_KEY' } });
      expect(invalid.json().code).toBe(40001); expect(invalid.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(await client.snapshot())).not.toContain('YOUR_API_KEY');
    } finally { await app.close(); }
  });
});
