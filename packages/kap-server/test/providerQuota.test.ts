import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { providerQuotaSnapshotSchema, type NbSearchKeyUsageView } from '@kiki/protocol';
import { Error2, ErrorCodes, IAtomicDocumentStore, IHarnessQuotaService, ILogService, IPluginLlmDirectoryService, IProviderService, IOAuthService, type Scope } from '@kiki/agent-core-v2';
import { INbSearchService } from '@kiki/agent-core-v2/app/nbSearch/nbSearch';
import { IAgentExecutorRegistry } from '@kiki/agent-core-v2/app/agentExecutor/agentExecutor';
import { parseQuota, selectQuotaAdapter, quotaHeaders } from '../src/usage/quota/adapters';
import { ProviderQuotaService, QuotaFailure, type QuotaTarget } from '../src/usage/quota/service';
import { registerProviderQuotaRoutes } from '../src/routes/providerQuota';
import { registerHarnessQuotaRoutes } from '../src/routes/harnessQuota';
import { createProviderQuotaFacade } from '../../klient/src/transports/http/provider-quota';
import { fetchOfficialQuota } from '../src/usage/quota/fetch';
import { createProviderQuotaService } from '../src/usage/quota/runtime';

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
function searchQuotaFixture(providerId: string, keys: NbSearchKeyUsageView['keys']) {
  const instanceId = `${providerId}.default`;
  const keyUsage = vi.fn(async (): Promise<NbSearchKeyUsageView> => ({ provider_instance_id: instanceId, provider_id: providerId, balance_supported: true, keys }));
  const services = new Map<unknown, unknown>([
    [IProviderService, { ready: Promise.resolve(), list: () => ({}) }],
    [IOAuthService, {}],
    [IAtomicDocumentStore, { get: async () => undefined }],
    [INbSearchService, { quotaSources: async () => [{ id: instanceId, provider_id: providerId, revision: 'fixture-account', enabled: true }], keyUsage }],
    [IAgentExecutorRegistry, { list: () => [] }],
  ]);
  const core = { accessor: { get: (token: unknown) => { expect(services.has(token)).toBe(true); return services.get(token); } } } as unknown as Scope;
  return { service: createProviderQuotaService(core), sourceId: `service:${instanceId}`, keyUsage };
}

describe('provider quotas', () => {
  it('projects Zhihu capability meters with daily reset metadata and independent units', async () => {
    const checkedAt = '2026-11-15T12:00:00Z';
    const resetAt = new Date(Date.now() + 86_400_000).toISOString();
    const f = searchQuotaFixture('zhihu', [{ key_index: 1, state: 'ready', usage: {
      scope: 'key', unit: 'credits', used: null, limit: null, remaining: null, checked_at: checkedAt,
      meters: [
        { id: 'zhihu_search', label: 'Zhihu search', unit: 'requests', used: 0, limit: 100, remaining: 100, reset_at: resetAt, reset_timezone: 'Asia/Shanghai' },
        { id: 'global_search', unit: 'requests', used: null, limit: null, remaining: null },
        { id: 'credits', unit: 'credits', used: 3, limit: 10, remaining: 7 },
      ],
    } }]);
    const initial = (await f.service.snapshot()).sources[0]!;
    expect(initial).toMatchObject({ status: 'unknown', source: { label: 'zhihu 官方每日额度（nb-search）' } });
    expect(f.keyUsage).not.toHaveBeenCalled();
    const source = providerQuotaSnapshotSchema.parse(await f.service.refresh(f.sourceId)).sources[0]!;
    expect(source.status).toBe('ready');
    expect(source.meters).toEqual([
      { id: 'key-1-zhihu_search', label: 'Zhihu search', unit: 'count', unit_label: '次', scope: 'key', used: 0, limit: 100, remaining: 100, data_as_of: checkedAt, status: 'ready',
        window: { label: '1d', duration_seconds: 86400, reset_at: resetAt, reset_timezone: 'Asia/Shanghai' } },
      { id: 'key-1-global_search', label: 'global_search', unit: 'count', unit_label: '次', scope: 'key', used: null, limit: null, remaining: null, data_as_of: checkedAt, status: 'ready' },
      { id: 'key-1-credits', label: 'credits', unit: 'credits', unit_label: 'credits', scope: 'key', used: 3, limit: 10, remaining: 7, data_as_of: checkedAt, status: 'ready' },
    ]);
    expect(f.keyUsage).toHaveBeenCalledWith('zhihu.default', true);

    const generic = searchQuotaFixture('tavily', [{ key_index: 1, state: 'ready', usage: {
      scope: 'key', unit: 'credits', used: 10, limit: 100, remaining: 90, checked_at: checkedAt,
      meters: [{ id: 'monthly', label: 'Monthly plan', unit: 'credits', used: 10, limit: 100, remaining: 90, reset_at: resetAt, reset_timezone: 'UTC' }],
    } }]);
    const genericSource = providerQuotaSnapshotSchema.parse(await generic.service.refresh(generic.sourceId)).sources[0]!;
    expect(genericSource.meters[0]!.window).toEqual({ reset_at: resetAt, reset_timezone: 'UTC' });
  });

  it('keeps key labels and authentication/error states independent for multi-meter search quotas', async () => {
    const usage = { scope: 'team' as const, unit: 'credits' as const, used: null, limit: null, remaining: null, checked_at: '2026-11-15T12:00:00Z',
      meters: [{ id: 'search', label: 'Search', unit: 'requests' as const, used: 100, limit: 100, remaining: 0 }],
    };
    const f = searchQuotaFixture('zhihu', [
      { key_index: 1, state: 'ready', usage },
      { key_index: 2, state: 'cooldown', usage, usage_error: 'unavailable' },
      { key_index: 3, state: 'invalid', usage },
      { key_index: 4, state: 'ready', usage_error: 'invalid_response' },
    ]);
    const source = providerQuotaSnapshotSchema.parse(await f.service.refresh(f.sourceId)).sources[0]!;
    expect(source).toMatchObject({ status: 'stale', reason: 'partial_data', message: '部分额度表项状态异常，详见各表项说明。' });
    expect(source.message).not.toBe('partial_data');
    expect(source.meters).toMatchObject([
      { id: 'key-1-search', label: 'Key 1 · Search', status: 'ready', scope: 'team', remaining: 0 },
      { id: 'key-2-search', label: 'Key 2 · Search', status: 'stale', message: '此 Key 的额度查询失败。' },
      { id: 'key-3-search', label: 'Key 3 · Search', status: 'auth_required', message: '此 Key 需要重新配置凭据。' },
      { id: 'key-4', label: 'Key 4', status: 'error', message: '此 Key 的额度查询失败。' },
    ]);
    expect(source.meters.every((meter) => meter.window === undefined)).toBe(true);
    const invalid = searchQuotaFixture('zhihu', [{ key_index: 1, state: 'invalid' }]);
    expect((await invalid.service.refresh(invalid.sourceId)).sources[0]!.status).toBe('auth_required');
  });

  it.each(['tavily', 'firecrawl'])('preserves the legacy credits row for %s with absent or empty meters', async (providerId) => {
    const usage = { scope: 'team' as const, unit: 'credits' as const, used: 3, limit: 10, remaining: 7, checked_at: '2026-11-15T12:00:00Z' };
    const f = searchQuotaFixture(providerId, [{ key_index: 1, state: 'ready', usage }, { key_index: 2, state: 'ready', usage: { ...usage, meters: [] } }]);
    const source = providerQuotaSnapshotSchema.parse(await f.service.refresh(f.sourceId)).sources[0]!;
    expect(source.source.label).toBe(`${providerId} 官方 credits（nb-search）`);
    expect(source.meters).toEqual([1, 2].map((index) => ({ id: `key-${index}`, label: `Key ${index} · Team 共享额度`, unit: 'credits', unit_label: 'credits', scope: 'team',
      used: 3, limit: 10, remaining: 7, data_as_of: usage.checked_at, status: 'ready',
    })));
  });

  it('marks custom-proxy Tavily instances as unsupported while keeping official api.tavily.com errors intact', async () => {
    const keyUsage = vi.fn(async (instanceId: string): Promise<NbSearchKeyUsageView> => ({
      provider_instance_id: instanceId,
      provider_id: 'tavily',
      balance_supported: true,
      keys: [{ key_index: 1, state: 'invalid' }],
    }));
    const services = new Map<unknown, unknown>([
      [IProviderService, { ready: Promise.resolve(), list: () => ({}) }],
      [IOAuthService, {}],
      [IAtomicDocumentStore, { get: async () => undefined }],
      [INbSearchService, {
        quotaSources: async () => [
          { id: 'tavily.raw-disabled', provider_id: 'tavily', revision: 'proxy-rev', enabled: true, base_url: 'https://api.example.test/raw/69', balance_supported: false },
          { id: 'tavily.raw-enabled', provider_id: 'tavily', revision: 'raw-rev', enabled: true, base_url: 'https://api.example.test/raw/69' },
          { id: 'tavily.proxy-implicit', provider_id: 'tavily', revision: 'proxy-rev-2', enabled: true, base_url: 'https://proxy.example.test/tavily' },
          { id: 'tavily.default', provider_id: 'tavily', revision: 'official-rev', enabled: true, base_url: 'https://api.tavily.com', balance_supported: true },
        ],
        keyUsage,
      }],
      [IAgentExecutorRegistry, { list: () => [] }],
    ]);
    const core = { accessor: { get: (token: unknown) => services.get(token) } } as unknown as Scope;
    const service = createProviderQuotaService(core);
    const snap = providerQuotaSnapshotSchema.parse(await service.snapshot());
    expect(snap.sources.find((s) => s.id === 'service:tavily.raw-disabled')).toMatchObject({ supported: false, status: 'unsupported', reason: 'no_official_quota_api' });
    expect(snap.sources.find((s) => s.id === 'service:tavily.raw-enabled')).toMatchObject({ supported: true, status: 'unknown', source: { label: 'tavily 网关凭据池额度' } });
    expect(snap.sources.find((s) => s.id === 'service:tavily.proxy-implicit')).toMatchObject({ supported: false, status: 'unsupported' });
    expect(snap.sources.find((s) => s.id === 'service:tavily.default')).toMatchObject({ supported: true, status: 'unknown' });
    await service.refresh('service:tavily.raw-disabled');
    expect(keyUsage).not.toHaveBeenCalled();
    const officialRefreshed = providerQuotaSnapshotSchema.parse(await service.refresh('service:tavily.default'));
    expect(officialRefreshed.sources.find((s) => s.id === 'service:tavily.default')).toMatchObject({ status: 'auth_required' });
  });
  it('does not fetch on reads, enable, off refresh, unsupported or disconnected targets', async () => {
    const f = fixture();
    expect((await f.service.snapshot()).sources[0]!.status).toBe('unknown');
    await f.service.setEnabled(f.target.id, false);
    expect((await f.service.refresh(f.target.id)).sources[0]!.status).toBe('off');
    await f.service.setEnabled(f.target.id, true);
    f.target.supported = false;
    expect((await f.service.refresh(f.target.id)).sources[0]!.status).toBe('unsupported');
    f.target.supported = true; f.target.active = false;
    await f.service.refresh(f.target.id);
    expect(f.fetchQuota).not.toHaveBeenCalled();
  });
  it('keeps zero distinct, serves stale after TTL/reset and retains last good only on same account errors', async () => {
    const f = fixture();
    const ready = (await f.service.refresh(f.target.id)).sources[0]!;
    expect(ready.status).toBe('ready'); expect(ready.meters[0]!.remaining).toBe(0);
    await f.service.refresh(f.target.id); expect(f.fetchQuota).toHaveBeenCalledTimes(1);
    f.advance(300001);
    expect((await f.service.snapshot()).sources[0]!.status).toBe('stale');
    f.fetchQuota.mockRejectedValueOnce(new QuotaFailure('request_failed'));
    const stale = (await f.service.refresh(f.target.id)).sources[0]!;
    expect(stale.status).toBe('stale'); expect(stale.meters[0]!.remaining).toBe(0); expect(stale.data_as_of).toBe(ready.data_as_of);
    f.target.revision = 'account-b';
    expect((await f.service.snapshot()).sources[0]!.meters).toEqual([]);
    f.fetchQuota.mockRejectedValueOnce(new QuotaFailure('auth_required'));
    const auth = (await f.service.refresh(f.target.id)).sources[0]!;
    expect(auth.status).toBe('auth_required'); expect(auth.meters).toEqual([]);
  });
  it('single-flights refresh, drops late results after disable or account replacement', async () => {
    const f = fixture(); let finish!: () => void;
    f.fetchQuota.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { finish = resolve; }); return []; });
    const first = f.service.refresh(f.target.id);
    await vi.waitFor(() => expect(f.fetchQuota).toHaveBeenCalledTimes(1));
    const second = f.service.refresh(f.target.id);
    await f.service.setEnabled(f.target.id, false); finish(); await Promise.all([first, second]);
    expect((await f.service.snapshot()).sources[0]!.status).toBe('off');
    await f.service.setEnabled(f.target.id, true);
    expect((await f.service.snapshot()).sources[0]!.checked_at).toBeUndefined();
  });
  it('does not add independent accounts and rejects missing source identifiers', async () => {
    const f = fixture(); f.sources.push({ ...f.target, id: 'provider:second', revision: 'second-account' });
    const data = await f.service.refresh(f.target.id);
    expect(data.sources).toHaveLength(2); expect(data.sources[1]!.meters).toEqual([]);
    await expect(f.service.refresh('provider:missing')).rejects.toThrow('quota_source_not_found');
  });
  it('ports Codex and Claude percent windows with timezone instants and model groups', () => {
    const codex = parseQuota('codex', { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: time / 1000 + 3600 }, secondary_window: { used_percent: 10, limit_window_seconds: 2592000 } }, credits: { balance: '0' } }, time);
    expect(codex[0]).toMatchObject({ remaining: 75, unit: 'percent', window: { duration_seconds: 18000, reset_at: '2026-10-10T05:00:00.000Z', reset_timezone: 'UTC' } });
    expect(codex[1]!.window?.label).toBe('30天'); expect(codex[2]!.remaining).toBe(0);
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
    expect(meters[0]).toMatchObject({ unit: 'percent', limit: 100, remaining: 80 }); expect(meters[0]!.window?.reset_at).toBeUndefined();
    expect(meters[1]!.window?.duration_seconds).toBe(604800);
  });
  it('reuses Kimi typed parser and does not conflate OpenRouter key cap with account balance', () => {
    const kimi = parseQuota('kimi', { usages: { limit_5h: { used_ratio: 0 }, limit_7d: { used_ratio: 0.4 } } }, time);
    expect(kimi.map((m) => m.remaining)).toEqual([60, 100]); expect(kimi.every((m) => m.unit === 'percent')).toBe(true);
    expect(parseQuota('kimi', { usage: { limit: '100' } }, time)[0]).toMatchObject({ used: null, limit: 100, remaining: null });
    expect(parseQuota('kimi', { usage: { used: '0', limit: '100' } }, time)[0]).toMatchObject({ used: 0, remaining: 100 });
    const router = parseQuota('openrouter', { data: { limit: null, limit_remaining: null, usage: 4 } }, time)[0];
    expect(router).toMatchObject({ scope: 'key', label: 'API Key 额度', remaining: null, limit: null, used: 4 });
    expect(router?.label).not.toContain('（');
    const routerCredits = parseQuota('openrouter', { data: { total_credits: 50, total_usage: 12.5 } }, time)[0];
    expect(routerCredits).toMatchObject({ id: 'account-credits', scope: 'account', unit: 'money', currency: 'USD', limit: 50, used: 12.5, remaining: 37.5 });
    const kimiBooster = parseQuota('kimi', {
      usages: { limit_5h: { used_ratio: 0.1 } },
      boosterWallet: { balance: { type: 'BOOSTER', amount: 2000, amountLeft: 1234 }, monthlyChargeLimit: {}, monthlyUsed: {} },
    }, time).find((m) => m.id === 'booster');
    expect(kimiBooster?.unit_label).toBe('货币');
    expect(kimiBooster?.unit_label).not.toContain('（');
  });

  it('probes OpenRouter /credits alongside /key and StepFun /v1/accounts alongside /step_plan/v1/usage', async () => {
    const urlText = (u: string | URL | Request): string => (u instanceof Request ? u.url : typeof u === 'string' ? u : u.href);
    const orAdapter = selectQuotaAdapter('https://openrouter.ai/api/v1', false)!;
    expect(orAdapter.url).toBe('https://openrouter.ai/api/v1/credits');
    expect(orAdapter.secondaryUrl).toBe('https://openrouter.ai/api/v1/key');
    const orFetch = vi.fn(async (url: string | URL | Request) => {
      if (urlText(url).endsWith('/credits')) return new Response(JSON.stringify({ data: { total_credits: 25, total_usage: 5.5 } }));
      return new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 6, usage: 4 } }));
    });
    const orMeters = await fetchOfficialQuota(orAdapter, 'YOUR_API_KEY', orFetch);
    expect(orMeters).toMatchObject([
      { id: 'account-credits', scope: 'account', remaining: 19.5, limit: 25, used: 5.5 },
      { id: 'key-limit', scope: 'key', remaining: 6, limit: 10, used: 4 },
    ]);

    const orRestricted = await fetchOfficialQuota(orAdapter, 'YOUR_API_KEY', async (url) => {
      if (urlText(url).endsWith('/credits')) return new Response('forbidden', { status: 403 });
      return new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 7, usage: 3 } }));
    });
    expect(orRestricted).toMatchObject([{ id: 'key-limit', scope: 'key', remaining: 7 }]);

    const stepAdapter = selectQuotaAdapter('https://api.stepfun.com/v1', false)!;
    expect(stepAdapter.url).toBe('https://api.stepfun.com/v1/accounts');
    expect(stepAdapter.secondaryUrl).toBe('https://api.stepfun.com/step_plan/v1/usage');
    const stepCodingMeters = await fetchOfficialQuota(stepAdapter, 'YOUR_API_KEY', async (url) => {
      if (urlText(url).endsWith('/accounts')) return new Response(JSON.stringify({ balance: '18.25' }));
      return new Response(JSON.stringify({
        status: 1,
        five_hour_usage_left_rate: 0.75,
        five_hour_usage_reset_time: String(Math.floor(time / 1000) + 7200),
        weekly_usage_left_rate: 0.9,
        weekly_usage_reset_time: String(Math.floor(time / 1000) + 86400),
      }));
    });
    expect(stepCodingMeters).toMatchObject([
      { id: 'balance', unit: 'money', currency: 'CNY', limit: null, remaining: 18.25 },
      { id: 'step-plan-5h', unit: 'percent', remaining: 75, used: 25, window: { duration_seconds: 18000 } },
      { id: 'step-plan-7d', unit: 'percent', remaining: 90, used: 10, window: { duration_seconds: 604800 } },
    ]);

    const stepCreditMeters = parseQuota('stepfun', {
      status: 1,
      plan_family: 2,
      five_hour_usage_left_rate: 0,
      five_hour_usage_reset_time: '0',
      weekly_usage_left_rate: 0,
      weekly_usage_reset_time: '0',
      plan_credit_rate_limit: {
        subscription_credit_left_rate: 0.95,
        subscription_credit_reset_time: String(Math.floor(time / 1000) + 86400),
        credit_buckets: [{ credit_total: '1000', credit_residual: '950', next_reset_at: '0' }],
      },
    }, time);
    expect(stepCreditMeters).toHaveLength(1);
    expect(stepCreditMeters[0]).toMatchObject({ id: 'step-plan-credits', unit: 'credits', limit: 1000, remaining: 950, used: 50 });

    const stepPayg = await fetchOfficialQuota(stepAdapter, 'YOUR_API_KEY', async (url) => {
      if (urlText(url).endsWith('/accounts')) return new Response(JSON.stringify({ balance: '12.00' }));
      return new Response('not found', { status: 404 });
    });
    expect(stepPayg).toMatchObject([{ id: 'balance', currency: 'CNY', limit: null, remaining: 12 }]);

    await expect(fetchOfficialQuota(orAdapter, 'YOUR_API_KEY', async (url) => {
      if (urlText(url).endsWith('/credits')) return new Response('rate limit', { status: 429 });
      return new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 7, usage: 3 } }));
    })).rejects.toMatchObject({
      reason: 'rate_limited',
      partialMeters: [expect.objectContaining({ id: 'key-limit', remaining: 7 })],
    });

    await expect(fetchOfficialQuota(stepAdapter, 'YOUR_API_KEY', async (url) => {
      if (urlText(url).endsWith('/accounts')) return new Response('bad gateway', { status: 502 });
      return new Response(JSON.stringify({ status: 0 }));
    })).rejects.toMatchObject({ reason: 'request_failed' });

    let now = time;
    let mode: 'both' | 'credits_429' | 'credits_empty' = 'both';
    const orTarget: QuotaTarget = {
      id: 'provider:openrouter', label: 'OpenRouter', kind: 'provider', providerId: 'openrouter', accountLabel: 'OpenRouter',
      revision: 'rev-1', active: true, supported: true, auth: { action: 'provider_settings', provider: 'openrouter' },
      source: { label: 'OpenRouter', url: orAdapter.url },
      fetch: (signal) => fetchOfficialQuota(orAdapter, 'YOUR_API_KEY', async (url) => {
        if (urlText(url).endsWith('/credits')) {
          if (mode === 'both') return new Response(JSON.stringify({ data: { total_credits: 25, total_usage: 5.5 } }));
          if (mode === 'credits_empty') return new Response(JSON.stringify({ data: {} }));
          return new Response('rate limited', { status: 429 });
        }
        return new Response(JSON.stringify({ data: { limit: 10, limit_remaining: mode === 'both' ? 6 : 5, usage: mode === 'both' ? 4 : 5 } }));
      }, signal),
    };
    const svc = new ProviderQuotaService(async () => [orTarget], { read: async () => ({}), update: async () => {} }, () => now);
    const first = (await svc.refresh(orTarget.id)).sources[0]!;
    expect(first.status).toBe('ready');
    expect(first.meters.map((m) => [m.id, m.remaining])).toEqual([['account-credits', 19.5], ['key-limit', 6]]);

    now += 61_000;
    mode = 'credits_429';
    const second = (await svc.refresh(orTarget.id)).sources[0]!;
    expect(second.status).toBe('stale');
    expect(second.reason).toBe('rate_limited');
    expect(second.meters.map((m) => [m.id, m.remaining])).toEqual([['account-credits', 19.5], ['key-limit', 5]]);

    now += 61_000;
    mode = 'credits_empty';
    const third = (await svc.refresh(orTarget.id)).sources[0]!;
    expect(third.status).toBe('stale');
    expect(third.reason).toBe('invalid_response');
    expect(third.meters.map((m) => [m.id, m.remaining])).toEqual([['account-credits', 19.5], ['key-limit', 5]]);
  });

  it('routes bounded plugin harness quota actions via POST /api/harness-quota/:sourceId/action', async () => {
    const performAction = vi.fn(async () => ({ ok: true, message: 'Primary switched' }));
    const warn = vi.fn();
    const core = {
      accessor: {
        get: (token: unknown) => {
          if (token === ILogService) return { warn };
          expect(token).toBe(IHarnessQuotaService);
          return {
            cached: async () => ({ sources: [] }),
            read: async () => [],
            performAction,
          };
        },
      },
    } as unknown as Scope;
    const app = Fastify();
    app.setValidatorCompiler(() => () => true);
    app.setSerializerCompiler(() => (data) => JSON.stringify(data));
    app.register(async (api) => {
      registerHarnessQuotaRoutes(api as unknown as Parameters<typeof registerHarnessQuotaRoutes>[0], core);
    }, { prefix: '/api' });
    try {
      const encodedId = encodeURIComponent('plugin:magpie/agy');
      const ok = await app.inject({
        method: 'POST',
        url: `/api/harness-quota/${encodedId}/action`,
        payload: { action: 'set_primary', account_id: 'seat-01' },
      });
      expect(ok.json()).toMatchObject({ code: 0, data: { ok: true, message: 'Primary switched' } });
      expect(performAction).toHaveBeenCalledWith('plugin:magpie/agy', 'set_primary', 'seat-01', expect.any(AbortSignal));

      const invalidAction = await app.inject({
        method: 'POST',
        url: `/api/harness-quota/${encodedId}/action`,
        payload: { action: 'set_routing_mode' },
      });
      expect(invalidAction.json().code).toBe(40001);

      performAction.mockRejectedValueOnce(new Error2(ErrorCodes.PLUGIN_NOT_FOUND, 'Unknown harness quota source plugin:magpie/agy'));
      const missingSource = await app.inject({
        method: 'POST',
        url: `/api/harness-quota/${encodedId}/action`,
        payload: { action: 'set_primary', account_id: 'seat-01' },
      });
      expect(missingSource.json().code).toBe(40419);

      performAction.mockRejectedValueOnce(new Error2(ErrorCodes.REQUEST_INVALID, 'Action set_primary requires account_id'));
      const badInput = await app.inject({
        method: 'POST',
        url: `/api/harness-quota/${encodedId}/action`,
        payload: { action: 'set_primary' },
      });
      expect(badInput.json().code).toBe(40001);

      performAction.mockRejectedValueOnce(new Error('upstream bearer YOUR_API_KEY timed out'));
      const runtimeFailure = await app.inject({
        method: 'POST',
        url: `/api/harness-quota/${encodedId}/action`,
        payload: { action: 'set_primary', account_id: 'seat-01' },
      });
      expect(runtimeFailure.json().code).toBe(50001);
      expect(runtimeFailure.json().msg).not.toContain('YOUR_API_KEY');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('YOUR_API_KEY');
    } finally {
      await app.close();
    }
  });
  it('selects official and HTTPS gateway hosts safely while preventing OAuth credentials from API-key balance calls', () => {
    for (const url of ['http://api.deepseek.com', 'https://api.deepseek.com.evil.test', 'https://secret@api.deepseek.com', 'https://api.deepseek.com:444', 'https://api.deepseek.com?x=1']) expect(selectQuotaAdapter(url, false)).toBeUndefined();
    expect(selectQuotaAdapter('https://api.deepseek.com', true)).toBeUndefined();
    const zai = selectQuotaAdapter('https://api.z.ai/api/paas/v4', false)!;
    expect(quotaHeaders(zai, 'YOUR_API_KEY')['Authorization']).toBe('YOUR_API_KEY');
    for (const url of ['http://gateway.example.test/v1', 'https://127.0.0.1:8443/v1', 'https://gateway.example.test/v1?x=1']) {
      expect(selectQuotaAdapter(url, false)).toBeUndefined();
    }
    expect(selectQuotaAdapter('https://gateway.example.test/v1', true)).toBeUndefined();
    expect(selectQuotaAdapter('https://gateway.example.test/v1', false)).toMatchObject({ id: 'kiki-quota', url: 'https://gateway.example.test/v1/kiki/quota', secondaryUrl: 'https://gateway.example.test/v1/usage', oauth: false });
    expect(selectQuotaAdapter('https://gateway.example.test', false)).toMatchObject({ id: 'kiki-quota', url: 'https://gateway.example.test/v1/kiki/quota', secondaryUrl: 'https://gateway.example.test/v1/usage', oauth: false });
  });
  it('parses kiki.key_quota pool windows and personal usage with group tags', () => {
    const payload = {
      object: 'kiki.key_quota',
      generated_at: '2026-11-25T05:35:00Z',
      key: {
        id: 123,
        name: 'Kiki Subscription',
        masked_key: 'ah-••••abcd',
        portal_managed: true,
        project_id: 2,
        group_slug: 'ren-group',
        group_name: '用户组1',
        channel_tags: ['我们组'],
      },
      personal_usage: {
        requests_today: 12,
        tokens_today: 45210,
        requests_7d: 84,
        tokens_7d: 391000,
      },
      pool_quotas: [
        {
          slug: 'gemini',
          title: 'Google Gemini 4',
          availability: 'available',
          models: ['gemini-4-neon', 'gemini-4-carbon', 'gemini-4-hydrogen'],
          apiFormats: ['anthropic/messages'],
          windows: [
            { key: '5h', label: '5h Window', usedPercent: 12.5, remainingPercent: 87.5, resetAt: '2026-11-25T08:00:00Z' },
            { key: 'weekly', label: 'Weekly Cap', remainingPercent: 65, resetAt: '2026-12-01T00:00:00Z' },
          ],
        },
        {
          slug: 'claude',
          title: 'Claude',
          windows: [
            { key: '24h', usedPercent: 100, remainingPercent: 0, resetAt: '2026-11-26T00:00:00Z' },
            { key: '1d', label: 'Daily Burst', usedPercent: 25 },
            { key: 'bad', usedPercent: 150 },
          ],
        },
      ],
    };
    const meters = parseQuota('kiki-quota', payload, time);
    expect(meters).toEqual([
      {
        id: 'pool-gemini-5h',
        label: 'Google Gemini 4 · 5h Window',
        unit: 'percent',
        unit_label: '%',
        used: 12.5,
        limit: 100,
        remaining: 87.5,
        scope: 'account',
        model_group: 'Google Gemini 4',
        window: { label: 'Google Gemini 4 · 5h Window', duration_seconds: 18000, reset_at: '2026-11-25T08:00:00.000Z', reset_timezone: 'UTC' },
      },
      {
        id: 'pool-gemini-weekly',
        label: 'Google Gemini 4 · Weekly Cap',
        unit: 'percent',
        unit_label: '%',
        used: 35,
        limit: 100,
        remaining: 65,
        scope: 'account',
        model_group: 'Google Gemini 4',
        window: { label: 'Google Gemini 4 · Weekly Cap', duration_seconds: 604800, reset_at: '2026-12-01T00:00:00.000Z', reset_timezone: 'UTC' },
      },
      {
        id: 'pool-claude-24h',
        label: 'Claude · 24h',
        unit: 'percent',
        unit_label: '%',
        used: 100,
        limit: 100,
        remaining: 0,
        scope: 'account',
        model_group: 'Claude',
        window: { label: 'Claude · 24h', duration_seconds: 86400, reset_at: '2026-11-26T00:00:00.000Z', reset_timezone: 'UTC' },
      },
      {
        id: 'pool-claude-1d',
        label: 'Claude · Daily Burst',
        unit: 'percent',
        unit_label: '%',
        used: 25,
        limit: 100,
        remaining: 75,
        scope: 'account',
        model_group: 'Claude',
        window: { label: 'Claude · Daily Burst', duration_seconds: 86400, reset_at: undefined, reset_timezone: undefined },
      },
      {
        id: 'personal-requests-today',
        label: '我们组 · 今日请求',
        unit: 'count',
        unit_label: '次',
        scope: 'key',
        model_group: '我们组',
        used: 12,
        limit: null,
        remaining: null,
      },
      {
        id: 'personal-tokens-today',
        label: '我们组 · 今日 Tokens',
        unit: 'count',
        unit_label: 'tokens',
        scope: 'key',
        model_group: '我们组',
        used: 45210,
        limit: null,
        remaining: null,
      },
      {
        id: 'personal-tokens-7d',
        label: '我们组 · 7日 Tokens',
        unit: 'count',
        unit_label: 'tokens',
        scope: 'key',
        model_group: '我们组',
        used: 391000,
        limit: null,
        remaining: null,
      },
    ]);

    const fallbackGroup = parseQuota('kiki-quota', {
      object: 'kiki.key_quota',
      key: { group_name: '用户组1', channel_tags: [] },
      personal_usage: { requests_today: 0, tokens_today: 0, tokens_7d: 500 },
      pool_quotas: [],
    }, time);
    expect(fallbackGroup.map((m) => [m.id, m.label, m.model_group, m.used, m.limit, m.remaining])).toEqual([
      ['personal-requests-today', '用户组1 · 今日请求', '用户组1', 0, null, null],
      ['personal-tokens-today', '用户组1 · 今日 Tokens', '用户组1', 0, null, null],
      ['personal-tokens-7d', '用户组1 · 7日 Tokens', '用户组1', 500, null, null],
    ]);

    expect(() => parseQuota('kiki-quota', { object: 'unknown' }, time)).toThrow('invalid_response');
  });
  it('deduplicates providers sharing the same quota endpoint and credential while preserving distinct keys', async () => {
    const providers = {
      axon: { type: 'openai_responses', baseUrl: 'https://api.example.com/v1', apiKey: 'ah-test-shared-001' },
      'axon-message': { type: 'anthropic', baseUrl: 'https://api.example.com', apiKey: 'ah-test-shared-001' },
      'axon-alt': { type: 'openai_responses', baseUrl: 'https://api.example.com/v1', apiKey: 'ah-test-other-002' },
      'axon-empty': { type: 'openai_responses', baseUrl: 'https://api.example.com/v1' },
    };
    const services = new Map<unknown, unknown>([
      [IProviderService, { ready: Promise.resolve(), list: () => providers }],
      [IOAuthService, {}],
      [IAtomicDocumentStore, { get: async () => undefined, update: async () => {} }],
      [INbSearchService, { quotaSources: async () => [] }],
      [IAgentExecutorRegistry, { list: () => [] }],
    ]);
    const core = { accessor: { get: (token: unknown) => { expect(services.has(token)).toBe(true); return services.get(token); } } } as unknown as Scope;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url instanceof Request ? url.url : typeof url === 'string' ? url : url.href).toBe('https://api.example.com/v1/kiki/quota');
      expect(init?.redirect).toBe('error');
      const auth = new Headers(init?.headers).get('authorization');
      const tag = auth === 'Bearer ah-test-shared-001' ? '我们组' : '共享曹';
      return new Response(JSON.stringify({
        object: 'kiki.key_quota',
        generated_at: '2026-11-25T05:35:00Z',
        key: { channel_tags: [tag] },
        personal_usage: { requests_today: 12, tokens_today: 45210, tokens_7d: 391000 },
        pool_quotas: [{ slug: 'gemini', title: 'Google Gemini 4', windows: [{ key: '5h', label: '5h Window', usedPercent: 12.5, remainingPercent: 87.5, resetAt: '2099-01-01T00:00:00Z' }] }],
      }));
    });
    const service = createProviderQuotaService(core, fetchMock);
    const initial = providerQuotaSnapshotSchema.parse(await service.snapshot());
    expect(initial.sources.map((s) => [s.id, s.account_label, s.supported])).toEqual([
      ['provider:axon', '共享凭据：axon · axon-message', true],
      ['provider:axon-alt', '此提供商的 API Key', true],
      ['provider:axon-empty', '此提供商的 API Key', true],
    ]);

    const refreshed = providerQuotaSnapshotSchema.parse(await service.refresh('provider:axon'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const axonSource = refreshed.sources.find((s) => s.id === 'provider:axon')!;
    expect(axonSource.status).toBe('ready');
    expect(axonSource.meters.map((m) => [m.id, m.label, m.remaining, m.used])).toEqual([
      ['pool-gemini-5h', 'Google Gemini 4 · 5h Window', 87.5, 12.5],
      ['personal-requests-today', '我们组 · 今日请求', null, 12],
      ['personal-tokens-today', '我们组 · 今日 Tokens', null, 45210],
      ['personal-tokens-7d', '我们组 · 7日 Tokens', null, 391000],
    ]);
    expect(JSON.stringify(refreshed)).not.toContain('ah-test-shared-001');
    expect(JSON.stringify(refreshed)).not.toContain('ah-test-other-002');

    const altRefreshed = providerQuotaSnapshotSchema.parse(await service.refresh('provider:axon-alt'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(altRefreshed.sources.find((s) => s.id === 'provider:axon-alt')!.meters[1]?.label).toBe('共享曹 · 今日请求');

    const emptyRefreshed = providerQuotaSnapshotSchema.parse(await service.refresh('provider:axon-empty'));
    expect(emptyRefreshed.sources.find((s) => s.id === 'provider:axon-empty')!.status).toBe('auth_required');
  });
  it('uses bounded read-only requests, rejects redirects/auth/oversized or malformed data without leaking secrets', async () => {
    const adapter = selectQuotaAdapter('https://api.deepseek.com', false)!;
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error'); expect(init?.method ?? 'GET').toBe('GET'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer YOUR_API_KEY');
      return new Response(JSON.stringify({ balance_infos: [{ currency: 'USD', total_balance: '0' }] }));
    });
    expect((await fetchOfficialQuota(adapter, 'YOUR_API_KEY', request))[0]!.remaining).toBe(0);
    for (const [status, reason] of [[401, 'auth_required'], [403, 'auth_required'], [429, 'rate_limited'], [500, 'request_failed']] as const) {
      await expect(fetchOfficialQuota(adapter, 'YOUR_API_KEY', async () => new Response('secret body YOUR_API_KEY', { status }))).rejects.toMatchObject({ reason, message: reason });
    }
    await expect(fetchOfficialQuota(adapter, 'YOUR_API_KEY', async () => new Response('bad json'))).rejects.toMatchObject({ reason: 'invalid_response' });
    await expect(fetchOfficialQuota(adapter, 'YOUR_API_KEY', async () => new Response('x'.repeat(1024 * 1024 + 1)))).rejects.toMatchObject({ reason: 'invalid_response' });
  });
  it('runs real route and typed-helper flow with isolated targets, validates inputs and returns no credentials', async () => {
    const f = fixture(); const app = Fastify(); registerProviderQuotaRoutes(app, f.service);
    const client = createProviderQuotaFacade({
      raw: async () => { throw new Error('Quota facade must not request raw responses'); },
      json: async <T>(path: string, options?: { method?: string; body?: unknown }) => {
        const response = await app.inject({
          method: (options?.method ?? 'GET') as 'GET' | 'POST' | 'PUT', url: '/api' + path,
          payload: options?.body === undefined ? undefined : JSON.stringify(options.body),
          headers: { 'content-type': 'application/json' },
        });
        const envelope = response.json(); if (envelope.code !== 0) throw new Error(envelope.msg); return envelope.data as T;
      },
    });
    try {
      expect(providerQuotaSnapshotSchema.parse(await client.snapshot()).sources[0]!.status).toBe('unknown');
      expect((await client.refresh(f.target.id)).sources[0]!.status).toBe('ready');
      expect((await client.setEnabled(f.target.id, false)).sources[0]!.status).toBe('off');
      const invalid = await app.inject({ method: 'POST', url: '/api/usage/provider-quotas/refresh', payload: { source_id: f.target.id, api_key: 'YOUR_API_KEY' } });
      expect(invalid.json().code).toBe(40001); expect(invalid.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(await client.snapshot())).not.toContain('YOUR_API_KEY');
    } finally { await app.close(); }
  });

  it('exposes official Google Antigravity CloudCode PA quota for antigravity-acp and its instances', async () => {
    const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { IBootstrapService } = await import('@kiki/agent-core-v2');
    const root = await mkdtemp(join(tmpdir(), 'kiki-kap-agy-quota-'));
    try {
      const profileMain = join(root, 'main-profile');
      const profileApiKey = join(root, 'apikey-profile');
      await mkdir(join(profileMain, 'antigravity-acp'), { recursive: true });
      await mkdir(join(profileApiKey, 'antigravity-acp'), { recursive: true });
      await writeFile(join(profileMain, 'antigravity-acp', 'settings.json'), JSON.stringify({ auth: { type: 'oauth-personal' } }));
      await writeFile(join(profileMain, 'antigravity-acp', 'antigravity-oauth-token'), JSON.stringify({
        token: { access_token: 'agy-live-token', expiry: new Date(Date.now() + 3_600_000).toISOString() },
      }));
      await writeFile(join(profileApiKey, 'antigravity-acp', 'settings.json'), JSON.stringify({ auth: { type: 'gemini-api-key' } }));

      const prefs = new Map<string, Record<string, boolean>>();
      const services = new Map<unknown, unknown>([
        [IProviderService, { ready: Promise.resolve(), list: () => ({}) }],
        [IOAuthService, {}],
        [IAtomicDocumentStore, {
          get: async (s: string, k: string) => prefs.get(`${s}:${k}`),
          update: async (s: string, k: string, fn: (v: Record<string, boolean> | undefined) => Record<string, boolean>) => {
            prefs.set(`${s}:${k}`, fn(prefs.get(`${s}:${k}`)));
          },
        }],
        [INbSearchService, { quotaSources: async () => [], keyUsage: async () => ({ keys: [] }) }],
        [IBootstrapService, { homeDir: root, osHomeDir: root, platform: 'win32', arch: 'x64', getEnv: () => undefined }],
        [IAgentExecutorRegistry, {
          list: () => [
            { id: 'antigravity-acp', label: 'Google Antigravity ACP', protocol: 'acp-v1', args: [], revision: '1', homeEnv: 'GEMINI_HOME', homeDir: profileMain },
            {
              id: 'agy-apikey',
              label: 'AGY API Key',
              protocol: 'acp-v1',
              args: [],
              revision: '2',
              homeEnv: 'GEMINI_HOME',
              homeDir: profileApiKey,
              instance: { source_executor: 'antigravity-acp', label: 'AGY API Key', configuration: { kind: 'config_directory', path: profileApiKey }, proxy: { kind: 'inherit' } },
            },
          ],
        }],
      ]);
      const futureResetAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
      const fakeFetch: typeof fetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/oauth2/v2/userinfo')) return new Response(JSON.stringify({ id: 'u1', email: 'quota@example.test' }));
        if (url.includes('daily-cloudcode-pa.googleapis.com')) {
          return new Response(JSON.stringify({
            groups: [{ buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: futureResetAt }] }],
          }));
        }
        return new Response(JSON.stringify({ groups: [] }));
      };
      const service = createProviderQuotaService({ accessor: { get: (token: unknown) => services.get(token) } } as unknown as Scope, fakeFetch);
      const initial = await service.snapshot();
      const mainSource = initial.sources.find((s) => s.id === 'executor:antigravity-acp');
      const apiKeySource = initial.sources.find((s) => s.id === 'executor:agy-apikey');
      expect(mainSource).toMatchObject({ supported: true, status: 'unknown', source: { label: 'Google CloudCode PA 官方额度' } });
      expect(apiKeySource).toMatchObject({ supported: false, status: 'unsupported' });

      const refreshed = await service.refresh('executor:antigravity-acp');
      const ready = refreshed.sources.find((s) => s.id === 'executor:antigravity-acp');
      expect(ready?.status).toBe('ready');
      expect(ready?.meters[0]).toMatchObject({
        id: 'gemini-5h',
        unit: 'percent',
        used: 20,
        limit: 100,
        remaining: 80,
        window: { label: '5h', duration_seconds: 18_000, reset_at: futureResetAt },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects plugin provider quota targets with open_plugin_panel auth, skips TOML collision, and aborts stale flights on revision change or withdrawal', async () => {
    let signedIn = false;
    let currentRevision = 'rev-1';
    let withdrawn = false;
    let firstAborted = false;
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let unblockFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });
    let readCalls = 0;

    const pluginSource = {
      pluginId: 'acme-bridge-plugin',
      generation: 1,
      definition: {
        schemaVersion: 1 as const,
        id: 'acme-quota',
        providerId: 'acme-bridge',
        label: 'Acme Bridge',
        minRefreshIntervalMs: 30_000,
      },
      runtime: {
        listTargets: async () => {
          if (withdrawn || !signedIn) return [];
          return [
            { id: 'acct-1', label: 'Acme (Alice)', accountLabel: 'alice@example.test', revision: currentRevision, active: true },
            { id: 'acct-2', label: 'Acme (Bob)', accountLabel: 'bob@example.test', revision: 'rev-b1', active: false },
          ];
        },
        read: async (targetId: string, signal?: AbortSignal) => {
          readCalls += 1;
          if (targetId === 'acct-1' && currentRevision === 'rev-1') {
            releaseFirst?.();
            signal?.addEventListener('abort', () => { firstAborted = true; }, { once: true });
            await firstGate;
            if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
          }
          return {
            ok: true as const,
            meters: [
              { id: 'model-alpha', label: 'Alpha', unit: 'percent' as const, scope: 'model' as const, used: 25, limit: 100, remaining: 75, status: 'ready' as const },
              { id: 'win-5h', label: '5h window', unit: 'percent' as const, scope: 'window' as const, used: 10, limit: 100, remaining: 90, status: 'ready' as const },
            ],
          };
        },
      },
    };

    const pluginDirectory = {
      listProviders: () => withdrawn ? [] : [{
        pluginId: 'acme-bridge-plugin',
        generation: 1,
        definition: { schemaVersion: 1, id: 'acme-bridge', label: 'Acme Bridge', panelId: 'accounts' },
        readiness: signedIn ? 'ready' : 'auth_required',
        models: [],
        supportsForceRefreshAuth: true,
        runtime: {},
      }],
      listQuotaSources: () => withdrawn ? [] : [pluginSource],
      getProvider: (id: string) => withdrawn || id !== 'acme-bridge' ? undefined : {
        pluginId: 'acme-bridge-plugin',
        generation: 1,
        definition: { schemaVersion: 1, id: 'acme-bridge', label: 'Acme Bridge', panelId: 'accounts' },
      },
    };

    const services = new Map<unknown, unknown>([
      [IProviderService, { ready: Promise.resolve(), list: () => ({ 'acme-bridge': { type: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'YOUR_API_KEY' } }) }],
      [IOAuthService, {}],
      [IAtomicDocumentStore, { get: async () => undefined }],
      [INbSearchService, { quotaSources: async () => [] }],
      [IAgentExecutorRegistry, { list: () => [] }],
      [IPluginLlmDirectoryService, pluginDirectory],
    ]);
    const core = { accessor: { get: (token: unknown) => services.get(token) } } as unknown as Scope;
    const service = createProviderQuotaService(core);

    const signedOutSnap = providerQuotaSnapshotSchema.parse(await service.snapshot());
    expect(signedOutSnap.sources).toHaveLength(1);
    expect(signedOutSnap.sources[0]).toMatchObject({
      id: 'plugin-quota:acme-bridge-plugin/acme-quota:signin',
      kind: 'provider',
      provider_id: 'acme-bridge',
      status: 'unknown',
      auth: { action: 'open_plugin_panel', provider: 'acme-bridge', plugin_id: 'acme-bridge-plugin', panel_id: 'accounts' },
    });
    const signedOutRefreshed = providerQuotaSnapshotSchema.parse(
      await service.refresh('plugin-quota:acme-bridge-plugin/acme-quota:signin'),
    );
    expect(signedOutRefreshed.sources[0]?.status).toBe('auth_required');

    signedIn = true;
    const signedInSnap = providerQuotaSnapshotSchema.parse(await service.snapshot());
    expect(signedInSnap.sources.map((s) => s.id)).toEqual([
      'plugin-quota:acme-bridge-plugin/acme-quota/acct-1',
      'plugin-quota:acme-bridge-plugin/acme-quota/acct-2',
    ]);
    expect(signedInSnap.sources[0]?.revision).toBe('1:rev-1');
    expect(signedInSnap.sources[0]?.auth).toEqual({
      action: 'open_plugin_panel',
      provider: 'acme-bridge',
      plugin_id: 'acme-bridge-plugin',
      panel_id: 'accounts',
    });

    const staleFlight = service.refresh('plugin-quota:acme-bridge-plugin/acme-quota/acct-1');
    await firstStarted;

    currentRevision = 'rev-2';
    const freshSnap = providerQuotaSnapshotSchema.parse(
      await service.refresh('plugin-quota:acme-bridge-plugin/acme-quota/acct-1'),
    );
    expect(firstAborted).toBe(true);
    unblockFirst?.();
    await staleFlight.catch(() => undefined);

    const refreshed = freshSnap.sources.find((s) => s.id === 'plugin-quota:acme-bridge-plugin/acme-quota/acct-1')!;
    expect(refreshed.status).toBe('ready');
    expect(refreshed.revision).toBe('1:rev-2');
    expect(refreshed.meters).toMatchObject([
      { id: 'model-alpha', scope: 'model', remaining: 75 },
      { id: 'win-5h', scope: 'window', remaining: 90 },
    ]);
    expect(readCalls).toBeGreaterThanOrEqual(2);

    withdrawn = true;
    const afterWithdraw = providerQuotaSnapshotSchema.parse(await service.snapshot());
    expect(afterWithdraw.sources.some((s) => s.id.startsWith('plugin-quota:'))).toBe(false);
    expect(afterWithdraw.sources.map((s) => s.id)).toEqual(['provider:acme-bridge']);
  });

  it('renders one deduplicated pool row for /raw/<id> multi-key search instances including prefixed paths', async () => {
    const keyUsage = vi.fn(async (instanceId: string): Promise<NbSearchKeyUsageView> => ({
      provider_instance_id: instanceId,
      provider_id: 'tavily',
      balance_supported: true,
      keys: [
        {
          key_index: 1,
          state: 'ready',
          usage: {
            scope: 'team',
            unit: 'credits',
            used: 10,
            limit: 100,
            remaining: 90,
            checked_at: '2026-11-26T00:00:00Z',
            meters: [{ id: 'channel-69-total', label: 'Search Pool · 渠道池额度', unit: 'credits', used: 10, limit: 100, remaining: 90 }],
          },
        },
        {
          key_index: 2,
          state: 'ready',
          usage: {
            scope: 'team',
            unit: 'credits',
            used: 10,
            limit: 100,
            remaining: 90,
            checked_at: '2026-11-26T00:00:00Z',
            meters: [{ id: 'channel-69-total', label: 'Search Pool · 渠道池额度', unit: 'credits', used: 10, limit: 100, remaining: 90 }],
          },
        },
      ],
    }));
    const services = new Map<unknown, unknown>([
      [IProviderService, { ready: Promise.resolve(), list: () => ({}) }],
      [IOAuthService, {}],
      [IAtomicDocumentStore, { get: async () => undefined }],
      [INbSearchService, {
        quotaSources: async () => [
          { id: 'tavily.prefixed-raw', provider_id: 'tavily', revision: 'raw-rev-1', enabled: true, base_url: 'https://api.example.test/prefix/raw/69' },
        ],
        keyUsage,
      }],
      [IAgentExecutorRegistry, { list: () => [] }],
    ]);
    const core = { accessor: { get: (token: unknown) => services.get(token) } } as unknown as Scope;
    const service = createProviderQuotaService(core);
    const snap = providerQuotaSnapshotSchema.parse(await service.refresh('service:tavily.prefixed-raw'));
    const source = snap.sources.find((s) => s.id === 'service:tavily.prefixed-raw')!;
    expect(source.supported).toBe(true);
    expect(source.account_label).toBe('网关渠道池共享额度');
    expect(source.meters).toHaveLength(1);
    expect(source.meters[0]).toMatchObject({
      id: 'pool-channel-69-total',
      label: 'Search Pool · 渠道池额度',
      scope: 'team',
      remaining: 90,
    });
  });

  it('recognizes LLM gateway 403 key_quota_exposure_disabled as managed state instead of auth_required', async () => {
    const { clearGatewayQuotaUnsupportedCache } = await import('../src/usage/quota/adapters');
    clearGatewayQuotaUnsupportedCache();
    try {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({
        error: { code: 'key_quota_exposure_disabled', message: 'quota exposure disabled by admin' },
      }), { status: 403, headers: { 'content-type': 'application/json' } }));
      const services = new Map<unknown, unknown>([
        [IProviderService, {
          ready: Promise.resolve(),
          list: () => ({
            managedgw: { type: 'openai', baseUrl: 'https://managed-gw.example.test/v1', apiKey: 'sk-managed' },
          }),
        }],
        [IOAuthService, {}],
        [IAtomicDocumentStore, { get: async () => undefined }],
        [INbSearchService, { quotaSources: async () => [] }],
        [IAgentExecutorRegistry, { list: () => [] }],
      ]);
      const core = { accessor: { get: (token: unknown) => services.get(token) } } as unknown as Scope;
      const service = createProviderQuotaService(core, fetchMock as typeof fetch);
      const snap = providerQuotaSnapshotSchema.parse(await service.refresh('provider:managedgw'));
      const source = snap.sources.find((s) => s.id === 'provider:managedgw')!;
      expect(source.status).toBe('unsupported');
      expect(source.reason).toBe('key_quota_exposure_disabled');
      expect(source.status).not.toBe('auth_required');
    } finally {
      clearGatewayQuotaUnsupportedCache();
    }
  });
});
