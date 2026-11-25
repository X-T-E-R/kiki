import { createHash } from 'node:crypto';
import { IAtomicDocumentStore, IPluginLlmDirectoryService, IProviderService, IOAuthService, explainProviderEndpoint, type Scope } from '@kiki/agent-core-v2';
import { INbSearchService } from '@kiki/agent-core-v2/app/nbSearch/nbSearch';
import { IAgentExecutorRegistry } from '@kiki/agent-core-v2/app/agentExecutor/agentExecutor';
import { OAuthUnauthorizedError, decodeJwtPayload } from '@kiki/oauth';
import type { PluginProviderQuotaMeter, ProviderQuotaMeter, ProviderQuotaSource } from '@kiki/protocol';
import { selectQuotaAdapter } from './adapters';
import { fetchOfficialQuota } from './fetch';
import { ProviderQuotaService, QuotaFailure, type QuotaTarget } from './service';

const PLUGIN_QUOTA_LIST_TIMEOUT_MS = 15_000;

function toProtocolQuotaMeter(meter: PluginProviderQuotaMeter): ProviderQuotaMeter {
  const isUsd = meter.unit === 'usd';
  const unit: ProviderQuotaMeter['unit'] = isUsd ? 'money' : meter.unit;
  const unitLabel = meter.unit_label ?? (isUsd ? 'USD' : meter.unit === 'percent' ? '%' : meter.unit);
  return {
    id: meter.id,
    label: meter.label,
    unit,
    unit_label: unitLabel,
    ...(isUsd ? { currency: 'USD' } : {}),
    used: meter.used,
    limit: meter.limit,
    remaining: meter.remaining,
    scope: meter.scope ?? 'account',
    status: meter.status,
    ...(meter.message !== undefined ? { message: meter.message } : {}),
    ...(meter.data_as_of !== undefined ? { data_as_of: meter.data_as_of } : {}),
    ...(meter.window !== undefined ? { window: meter.window } : {}),
  };
}

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
  let pluginLlm: IPluginLlmDirectoryService | undefined;
  try {
    pluginLlm = core.accessor.get(IPluginLlmDirectoryService);
  } catch {
    pluginLlm = undefined;
  }
  const scope = 'provider-quota'; const key = 'preferences';
  const targets = async (): Promise<QuotaTarget[]> => {
    await providers.ready;
    const pluginQuotaSources = pluginLlm?.listQuotaSources() ?? [];
    const pluginOwnedProviders = new Set<string>([
      ...(pluginLlm?.listProviders().map((entry) => entry.definition.id) ?? []),
      ...pluginQuotaSources.map((entry) => entry.definition.providerId),
    ]);
    const configuredEntries = Object.entries(providers.list()).filter(([id]) => !pluginOwnedProviders.has(id));
    const result = await Promise.all(configuredEntries.map(async ([id, config]): Promise<QuotaTarget> => {
      const endpoint = explainProviderEndpoint(config.type ?? '', config.env ?? {});
      const adapter = selectQuotaAdapter(config.baseUrl ?? endpoint.baseUrl, config.oauth !== undefined);
      let identity: unknown;
      if (adapter && config.oauth) {
        try { identity = credentialIdentity(await oauth.getCachedAccessToken(id, config.oauth)); }
        catch { identity = 'unavailable'; }
      }
      return { id: `provider:${id}`, label: id, kind: 'provider', providerId: id, accountLabel: config.oauth ? '已连接 OAuth 账户' : '此提供商的 API Key',
        revision: fingerprint([config, identity]), active: true, supported: adapter !== undefined,
        auth: { action: config.oauth ? 'oauth_login' : 'provider_settings', provider: id },
        source: { label: adapter?.label ?? '暂无官方额度接口', url: adapter?.url },
        fetch: async (signal) => {
          signal.throwIfAborted();
          if (!adapter) return [];
          const tokenProvider = config.oauth ? oauth.resolveTokenProvider(id, config.oauth) : undefined;
          let token: string | undefined;
          try { token = tokenProvider ? await tokenProvider.getAccessToken() : config.apiKey ?? endpoint.apiKey; }
          catch (error) { throw error instanceof OAuthUnauthorizedError ? new QuotaFailure('auth_required') : new QuotaFailure('request_failed'); }
          if (!token?.trim()) throw new QuotaFailure('auth_required');
          signal.throwIfAborted();
          try { return await fetchOfficialQuota(adapter, token, fetchImpl, signal); }
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
    }));
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
    for (const quotaSource of pluginQuotaSources) {
      const resolvedPanelId =
        quotaSource.definition.panelId ??
        pluginLlm?.getProvider(quotaSource.definition.providerId)?.definition.panelId;
      const auth: ProviderQuotaSource['auth'] = resolvedPanelId !== undefined
        ? {
            action: 'open_plugin_panel',
            provider: quotaSource.definition.providerId,
            plugin_id: quotaSource.pluginId,
            panel_id: resolvedPanelId,
          }
        : { action: 'provider_settings', provider: quotaSource.definition.providerId };
      let descriptors: readonly import('@kiki/protocol').PluginProviderQuotaTargetDescriptor[] = [];
      let listFailed = false;
      const listController = new AbortController();
      const listTimer = setTimeout(() => listController.abort(), PLUGIN_QUOTA_LIST_TIMEOUT_MS);
      listTimer.unref();
      try {
        descriptors = await quotaSource.runtime.listTargets(listController.signal);
      } catch {
        listFailed = true;
      } finally {
        clearTimeout(listTimer);
      }
      if (descriptors.length === 0) {
        result.push({
          id: `plugin-quota:${quotaSource.pluginId}/${quotaSource.definition.id}:signin`,
          label: quotaSource.definition.label,
          kind: 'provider',
          providerId: quotaSource.definition.providerId,
          accountLabel: listFailed ? '插件额度源暂不可用' : '未登录账号',
          revision: `${quotaSource.generation}:${listFailed ? 'error' : 'empty'}`,
          active: true,
          supported: true,
          auth,
          source: { label: quotaSource.definition.label },
          fetch: async () => {
            throw new QuotaFailure(listFailed ? 'request_failed' : 'auth_required');
          },
        });
        continue;
      }
      for (const descriptor of descriptors) {
        const targetId = `plugin-quota:${quotaSource.pluginId}/${quotaSource.definition.id}/${descriptor.id}`;
        result.push({
          id: targetId,
          label: descriptor.label,
          kind: 'provider',
          providerId: quotaSource.definition.providerId,
          accountLabel: descriptor.accountLabel ?? quotaSource.definition.label,
          revision: `${quotaSource.generation}:${descriptor.revision}`,
          active: descriptor.active,
          supported: true,
          auth,
          source: { label: descriptor.sourceLabel ?? quotaSource.definition.label },
          fetch: async (signal) => {
            signal.throwIfAborted();
            const readResult = await quotaSource.runtime.read(descriptor.id, signal);
            if (!readResult.ok) {
              const reason = readResult.reason === 'unsupported' ? 'request_failed' : readResult.reason;
              throw new QuotaFailure(reason, {
                partialMeters: readResult.partialMeters?.map(toProtocolQuotaMeter),
              });
            }
            return readResult.meters.map(toProtocolQuotaMeter);
          },
        });
      }
    }
    return result;
  };
  return new ProviderQuotaService(targets, {
    read: async () => (await store.get<Record<string, boolean>>(scope, key)) ?? {},
    update: async (id, enabled) => { await store.update<Record<string, boolean>>(scope, key, (current) => ({ ...current, [id]: enabled })); },
  });
}
