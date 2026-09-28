import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ProviderCatalogItem } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { AccountSignIn, OAUTH_METHODS_QUERY_KEY } from '../AccountSignIn';
import { Hint, InlineError } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { NewProviderWizard, ProviderEditor } from '../ProviderFields';
import { PROTOCOL_ORDER, protocolLabel } from '../providerPresets';
import { SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';

/**
 * Tab 1 of "Models & providers": everything about connecting a service.
 * Two ways in, in the order most people need them — an API key for any
 * provider (the general path), or signing in with an account (Kimi Code,
 * GitHub Copilot, ChatGPT). Configured connections follow, grouped by the
 * wire protocol they speak, so the list reads the same whichever vendor sits
 * behind each one. Model browsing and new-session defaults live on the
 * sibling tabs.
 */
export function ConnectionsTab() {
  const { client } = useConnection();
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();

  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const methodsQuery = useQuery({ queryKey: OAUTH_METHODS_QUERY_KEY, queryFn: () => client.listOAuthMethods(), staleTime: 10_000 });

  const refreshProviderData = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['providers'] }),
      queryClient.invalidateQueries({ queryKey: ['models'] }),
      queryClient.invalidateQueries({ queryKey: ['generation-entity'] }),
      queryClient.invalidateQueries({ queryKey: ['auth'] }),
      queryClient.invalidateQueries({ queryKey: ['config'] }),
      queryClient.invalidateQueries({ queryKey: OAUTH_METHODS_QUERY_KEY }),
    ]);
  }, [queryClient]);

  const providerItems = providersQuery.data?.items ?? [];
  const accountProviders = new Set((methodsQuery.data ?? []).map((method) => method.provider));
  const modelCount = (providerId: string) =>
    (modelsQuery.data?.items ?? []).filter((model) => model.provider_id === providerId).length;
  const unconfiguredCount = providerItems.filter(
    (provider) => !provider.has_api_key && !accountProviders.has(provider.id),
  ).length;

  const groups = new Map<string, ProviderCatalogItem[]>();
  for (const provider of providerItems) {
    const key = accountProviders.has(provider.id) ? 'account' : provider.type;
    groups.set(key, [...(groups.get(key) ?? []), provider]);
  }
  const order = ['account', ...PROTOCOL_ORDER];
  const orderedGroups = [...groups.entries()].toSorted(
    ([a], [b]) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)),
  );

  return (
    <div className="space-y-4">
      <p className="max-w-[62ch] text-[13px] leading-relaxed text-ink-soft">{t('st.connections.intro')}</p>

      <SectionCard id="st-card-providers-add" title={t('st.providers.addTitle')} aside={t('st.providers.addAside')}>
        <NewProviderWizard onSaved={refreshProviderData} />
      </SectionCard>

      <SectionCard id="st-card-auth" title={t('st.account.title')} aside={t('st.account.aside')}>
        <AccountSignIn onChanged={refreshProviderData} />
      </SectionCard>

      <SectionCard id="st-card-providers" title={t('st.providers.title')}>
        <div className="space-y-4">
          {providerItems.length > 0 ? <Hint>{t('st.providers.listHint')}</Hint> : null}
          {orderedGroups.map(([group, providers]) => (
            <section key={group} data-provider-group={group} className="space-y-2">
              <p className="flex items-baseline gap-2 text-[12px] font-medium text-ink-soft">
                {group === 'account' ? t('st.providers.groupAccount') : protocolLabel(group)}
                <span className="font-mono text-[11px] font-normal text-ink-faint">{providers.length}</span>
              </p>
              {providers.map((provider) => (
                <ProviderEditor
                  key={provider.id}
                  provider={provider}
                  models={modelsQuery.data?.items ?? []}
                  managed={accountProviders.has(provider.id)}
                  modelCount={modelCount(provider.id)}
                  onSaved={refreshProviderData}
                />
              ))}
            </section>
          ))}
          {providersQuery.isLoading ? <Hint>{t('st.providers.loading')}</Hint> : null}
          {providersQuery.data?.items.length === 0 ? (
            <div className="space-y-1.5 rounded-lg border border-dashed border-hairline-strong px-3 py-4">
              <p className="text-[13px] text-ink-soft">{t('st.providers.empty')}</p>
              <Hint>{t('st.providers.emptyGo')}</Hint>
            </div>
          ) : null}
          {providersQuery.isError ? <InlineError error={providersQuery.error} /> : null}
        </div>
      </SectionCard>

      {providerItems.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-hairline bg-panel px-3 py-2.5">
          <Hint>
            {t('st.providers.nextStepHint')}
            {unconfiguredCount > 0 ? ` ${t('st.providers.nextStepUnconfigured', { count: unconfiguredCount })}` : ''}
          </Hint>
          <button
            type="button"
            className={`${SECONDARY_BUTTON} ml-auto`}
            onClick={() => { navigate('/settings/ai?tab=models'); }}
          >
            {t('st.defaults.pickModel')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
