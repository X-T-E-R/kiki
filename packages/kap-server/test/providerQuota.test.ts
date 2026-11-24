import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { providerQuotaSnapshotSchema, type NbSearchKeyUsageView } from '@kiki/protocol';
import { Error2, ErrorCodes, IAtomicDocumentStore, IHarnessQuotaService, ILogService, IProviderService, IOAuthService, type Scope } from '@kiki/agent-core-v2';
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
    const orAdapter = selectQuotaAdapter('https://openrouter.ai/api/v1', false)!;
    expect(orAdapter.url).toBe('https://openrouter.ai/api/v1/credits');
    expect(orAdapter.secondaryUrl).toBe('https://openrouter.ai/api/v1/key');
    const orFetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/credits')) return new Response(JSON.stringify({ data: { total_credits: 25, total_usage: 5.5 } }));
      return new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 6, usage: 4 } }));
    });
    const orMeters = await fetchOfficialQuota(orAdapter, 'YOUR_API_KEY', orFetch);
    expect(orMeters).toMatchObject([
      { id: 'account-credits', scope: 'account', remaining: 19.5, limit: 25, used: 5.5 },
      { id: 'key-limit', scope: 'key', remaining: 6, limit: 10, used: 4 },
    ]);

    const orRestricted = await fetchOfficialQuota(orAdapter, 'YOUR_API_KEY', async (url) => {
      if (String(url).endsWith('/credits')) return new Response('forbidden', { status: 403 });
      return new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 7, usage: 3 } }));
    });
    expect(orRestricted).toMatchObject([{ id: 'key-limit', scope: 'key', remaining: 7 }]);

    const stepAdapter = selectQuotaAdapter('https://api.stepfun.com/v1', false)!;
    expect(stepAdapter.url).toBe('https://api.stepfun.com/v1/accounts');
    expect(stepAdapter.secondaryUrl).toBe('https://api.stepfun.com/step_plan/v1/usage');
    const stepCodingMeters = await fetchOfficialQuota(stepAdapter, 'YOUR_API_KEY', async (url) => {
      if (String(url).endsWith('/accounts')) return new Response(JSON.stringify({ balance: '18.25' }));
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
      if (String(url).endsWith('/accounts')) return new Response(JSON.stringify({ balance: '12.00' }));
      return new Response('not found', { status: 404 });
    });
    expect(stepPayg).toMatchObject([{ id: 'balance', currency: 'CNY', limit: null, remaining: 12 }]);

    await expect(fetchOfficialQuota(orAdapter, 'YOUR_API_KEY', async (url) => {
      if (String(url).endsWith('/credits')) return new Response('rate limit', { status: 429 });
      return new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 7, usage: 3 } }));
    })).rejects.toMatchObject({
      reason: 'rate_limited',
      partialMeters: [expect.objectContaining({ id: 'key-limit', remaining: 7 })],
    });

    await expect(fetchOfficialQuota(stepAdapter, 'YOUR_API_KEY', async (url) => {
      if (String(url).endsWith('/accounts')) return new Response('bad gateway', { status: 502 });
      return new Response(JSON.stringify({ status: 0 }));
    })).rejects.toMatchObject({ reason: 'request_failed' });

    let now = time;
    let mode: 'both' | 'credits_429' | 'credits_empty' = 'both';
    const orTarget: QuotaTarget = {
      id: 'provider:openrouter', label: 'OpenRouter', kind: 'provider', providerId: 'openrouter', accountLabel: 'OpenRouter',
      revision: 'rev-1', active: true, supported: true, auth: { action: 'provider_settings', provider: 'openrouter' },
      source: { label: 'OpenRouter', url: orAdapter.url },
      fetch: (signal) => fetchOfficialQuota(orAdapter, 'YOUR_API_KEY', async (url) => {
        if (String(url).endsWith('/credits')) {
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
  it('selects official hosts only and prevents OAuth credentials from API-key balance calls', () => {
    for (const url of ['http://api.deepseek.com', 'https://api.deepseek.com.evil.test', 'https://proxy.example.test', 'https://secret@api.deepseek.com', 'https://api.deepseek.com:444', 'https://api.deepseek.com?x=1']) expect(selectQuotaAdapter(url, false)).toBeUndefined();
    expect(selectQuotaAdapter('https://api.deepseek.com', true)).toBeUndefined();
    const zai = selectQuotaAdapter('https://api.z.ai/api/paas/v4', false)!;
    expect(quotaHeaders(zai, 'YOUR_API_KEY')['Authorization']).toBe('YOUR_API_KEY');
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
});
