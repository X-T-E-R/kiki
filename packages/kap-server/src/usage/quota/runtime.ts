import { createHash } from 'node:crypto';
import { IAtomicDocumentStore, IProviderService, IOAuthService, explainProviderEndpoint, type Scope } from '@kiki/agent-core-v2';
import { INbSearchService } from '@kiki/agent-core-v2/app/nbSearch/nbSearch';
import { IAgentExecutorRegistry } from '@kiki/agent-core-v2/app/agentExecutor/agentExecutor';
import { OAuthUnauthorizedError, decodeJwtPayload } from '@kiki/oauth';
import type { ProviderQuotaMeter } from '@kiki/protocol';
import { selectQuotaAdapter } from './adapters';
import { fetchOfficialQuota } from './fetch';
import { ProviderQuotaService, QuotaFailure, type QuotaTarget } from './service';

const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function credentialIdentity(token: string | undefined): unknown {
  if (!token) return 'signed_out';
  const claims = decodeJwtPayload(token);
  return claims?.['sub'] ? [claims['iss'], claims['sub'], claims['https://api.openai.com/auth']] : fingerprint(token);
}
export function createProviderQuotaService(core: Scope, fetchImpl: typeof fetch = fetch): ProviderQuotaService {
  const providers = core.accessor.get(IProviderService);
  const oauth = core.accessor.get(IOAuthService);
  const store = core.accessor.get(IAtomicDocumentStore);
  const nbSearch = core.accessor.get(INbSearchService);
  const executors = core.accessor.get(IAgentExecutorRegistry);
  const scope = 'provider-quota'; const key = 'preferences';
  const targets = async (): Promise<QuotaTarget[]> => {
    await providers.ready;
    const entries = await Promise.all(Object.entries(providers.list()).map(async ([id, config]) => {
      const endpoint = explainProviderEndpoint(config.type ?? '', config.env ?? {});
      const adapter = selectQuotaAdapter(config.baseUrl ?? endpoint.baseUrl, config.oauth !== undefined);
      let identity: unknown;
      if (adapter && config.oauth) {
        try { identity = credentialIdentity(await oauth.getCachedAccessToken(id, config.oauth)); }
        catch { identity = 'unavailable'; }
      }
      const apiKey = !config.oauth ? (config.apiKey ?? endpoint.apiKey)?.trim() : undefined;
      const dedupeKey = adapter && apiKey ? fingerprint([adapter.id, adapter.url, adapter.secondaryUrl ?? '', apiKey]) : undefined;
      return { id, config, endpoint, adapter, identity, dedupeKey };
    }));
    const groups: Array<typeof entries> = [];
    const groupByKey = new Map<string, typeof entries>();
    for (const entry of entries) {
      if (entry.dedupeKey !== undefined) {
        const existing = groupByKey.get(entry.dedupeKey);
        if (existing) {
          existing.push(entry);
          continue;
        }
        const created = [entry];
        groupByKey.set(entry.dedupeKey, created);
        groups.push(created);
      } else {
        groups.push([entry]);
      }
    }
    const result: QuotaTarget[] = groups.map((group): QuotaTarget => {
      const primary = group[0]!;
      const { id, config, endpoint, adapter, identity } = primary;
      const sharedIds = group.map((member) => member.id);
      const accountLabel = config.oauth
        ? '已连接 OAuth 账户'
        : sharedIds.length > 1
          ? `共享凭据：${sharedIds.join(' · ')}`
          : '此提供商的 API Key';
      const revision = sharedIds.length > 1
        ? fingerprint(group.map((member) => [member.id, member.config, member.identity]))
        : fingerprint([config, identity]);
      return { id: `provider:${id}`, label: id, kind: 'provider', providerId: id, accountLabel,
        revision, active: true, supported: adapter !== undefined,
        auth: { action: config.oauth ? 'oauth_login' : 'provider_settings', provider: id },
        source: { label: adapter?.label ?? '暂无官方额度接口', url: adapter?.url },
        fetch: async (signal) => {
          signal.throwIfAborted();
          if (!adapter) return [];
          const tokenProvider = config.oauth ? oauth.resolveTokenProvider(id, config.oauth) : undefined;
          let token: string | undefined;
          try { token = tokenProvider ? await tokenProvider.getAccessToken() : config.apiKey ?? endpoint.apiKey; }
          catch (error) { throw error instanceof OAuthUnauthorizedError ? new QuotaFailure('auth_required') : new QuotaFailure('request_failed'); }
          const trimmedToken = token?.trim();
          if (!trimmedToken) throw new QuotaFailure('auth_required');
          signal.throwIfAborted();
          try { return await fetchOfficialQuota(adapter, trimmedToken, fetchImpl, signal); }
          catch (error) {
            if (!(error instanceof QuotaFailure) || error.reason !== 'auth_required' || !tokenProvider) throw error;
            signal.throwIfAborted();
            let refreshed: string;
            try { refreshed = await tokenProvider.getAccessToken({ force: true }); }
            catch (refreshError) { throw refreshError instanceof OAuthUnauthorizedError ? new QuotaFailure('auth_required') : new QuotaFailure('request_failed'); }
            signal.throwIfAborted();
            return fetchOfficialQuota(adapter, refreshed, fetchImpl, signal);
          }
        } };
    });
    const instances = await nbSearch.quotaSources();
    for (const instance of instances) {
      const supported = instance.provider_id === 'tavily' || instance.provider_id === 'firecrawl' || instance.provider_id === 'zhihu';
      result.push({ id: `service:${instance.id}`, label: instance.id, kind: 'external_service', providerId: instance.provider_id, accountLabel: '按 Key / Team 独立显示',
        revision: instance.revision, active: instance.enabled, supported,
        auth: { action: 'external_service_settings', provider: instance.id },
        source: { label: instance.provider_id === 'zhihu' ? 'zhihu 官方每日额度（nb-search）' : `${instance.provider_id} 官方 credits（nb-search）` },
        fetch: async () => {
          const usage = await nbSearch.keyUsage(instance.id, true);
          if (usage.keys.length === 0 || usage.keys.every((entry) => entry.state === 'invalid')) throw new QuotaFailure('auth_required');
          return usage.keys.flatMap((entry): ProviderQuotaMeter[] => {
            const data = entry.usage;
            const keyId = `key-${entry.key_index}`;
            const keyLabel = `Key ${entry.key_index}`;
            const common = {
              scope: data?.scope ?? 'key',
              data_as_of: data?.checked_at,
              status: entry.state === 'invalid' ? 'auth_required' : entry.usage_error ? data ? 'stale' : 'error' : data ? 'ready' : 'unknown',
              message: entry.state === 'invalid' ? '此 Key 需要重新配置凭据。' : entry.usage_error ? '此 Key 的额度查询失败。' : data ? undefined : '尚无此 Key 的官方额度数据。',
            } satisfies Pick<ProviderQuotaMeter, 'scope' | 'data_as_of' | 'status' | 'message'>;
            if (data?.meters?.length) {
              return data.meters.map((meter): ProviderQuotaMeter => {
                const label = meter.label ?? meter.id;
                return { ...common, id: `${keyId}-${meter.id}`, label: usage.keys.length > 1 ? `${keyLabel} · ${label}` : label,
                  unit: meter.unit === 'requests' ? 'count' : 'credits', unit_label: meter.unit === 'requests' ? '次' : 'credits',
                  used: meter.used, limit: meter.limit, remaining: meter.remaining,
                  window: meter.reset_at === undefined ? undefined : instance.provider_id === 'zhihu'
                    ? { label: '1d', duration_seconds: 86400, reset_at: meter.reset_at, reset_timezone: meter.reset_timezone }
                    : { reset_at: meter.reset_at, reset_timezone: meter.reset_timezone } };
              });
            }
            return [{ ...common, id: keyId, label: `${keyLabel}${data?.scope === 'team' ? ' · Team 共享额度' : ''}`, unit: 'credits', unit_label: 'credits',
              used: data?.used ?? null, limit: data?.limit ?? null, remaining: data?.remaining ?? null }];
          });
        } });
    }
    for (const executor of executors.list()) {
      if (executor.protocol === 'native' || executor.instance !== undefined) continue;
      result.push({ id: `executor:${executor.id}`, label: executor.label ?? executor.id, kind: 'executor', providerId: executor.id, accountLabel: '执行器自行管理的登录',
        revision: fingerprint([executor.id, executor.protocol, executor.homeDir]), active: true, supported: false,
        unsupportedReason: 'executor_credentials_not_shared', auth: { action: 'executor_login', provider: executor.id }, source: { label: '执行器登录不等于已批准的提供商额度连接' }, fetch: async () => [] });
    }
    return result;
  };
  return new ProviderQuotaService(targets, {
    read: async () => (await store.get<Record<string, boolean>>(scope, key)) ?? {},
    update: async (id, enabled) => { await store.update<Record<string, boolean>>(scope, key, (current) => ({ ...current, [id]: enabled })); },
  });
}
