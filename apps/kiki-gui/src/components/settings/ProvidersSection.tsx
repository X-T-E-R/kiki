import { useCallback, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ProviderCatalogItem } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { OAUTH_METHODS_QUERY_KEY } from '../AccountSignIn';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { Icon } from '../icons';
import { NewProviderWizard, PROVIDER_HEALTH_QUERY_KEY, ProviderEditor } from '../ProviderFields';
import { connectionKind, type ConnectionKind } from '../providerPresets';
import { SidePanel } from '../SidePanel';
import { SECONDARY_BUTTON } from '../ui';
import { AccountQuotaCard } from './AccountQuotaCard';
import { CatalogImportCard } from './CatalogImportCard';
import { ExternalEnginesList } from './ExternalEnginesSection';
import { ListBody, ListEmpty, ListToolbar, useListView, type ListFilterSpec, type ListSortSpec } from './list';
import { SectionCard } from './SectionCard';

const KIND_ORDER: readonly ConnectionKind[] = ['account', 'api', 'local'];

/**
 * Connections tab: the services Kiki can reach. One list of configured
 * connections — account sign-ins, hosted APIs and local servers side by side,
 * each a row with its address, model count and health in words — and one
 * "Add connection" entry that first asks how (API key or account), then
 * which protocol. Vendors are presets inside that flow, never a type.
 */
export function ConnectionsTab() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const { hash } = useLocation();
  const queryClient = useQueryClient();
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const [signOutFeedback, setSignOutFeedback] = useState<Feedback>(null);

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
      queryClient.invalidateQueries({ queryKey: PROVIDER_HEALTH_QUERY_KEY }),
    ]);
  }, [queryClient]);

  const providerItems = providersQuery.data?.items ?? [];
  const methods = methodsQuery.data ?? [];
  const accountProviders = useMemo(() => new Set(methods.map((method) => method.provider)), [methods]);
  const methodFor = (providerId: string) => methods.find((method) => method.provider === providerId);
  const modelCount = (providerId: string) =>
    (modelsQuery.data?.items ?? []).filter((model) => model.provider_id === providerId).length;
  const empty = providersQuery.isSuccess && providerItems.length === 0;

  const keyOf = useCallback((provider: ProviderCatalogItem) => provider.id, []);
  const textOf = useCallback(
    (provider: ProviderCatalogItem) => [provider.id, methodFor(provider.id)?.label, provider.base_url],
    [methods],
  );
  const filters = useMemo<readonly ListFilterSpec<ProviderCatalogItem>[]>(() => [
    ...KIND_ORDER.map((kind) => ({
      id: kind, label: t(`st.connections.kind.${kind}`),
      test: (provider: ProviderCatalogItem) => connectionKind(provider, accountProviders) === kind,
    })),
    {
      id: 'attention', label: t('st.connections.filter.attention'), tone: 'attention' as const,
      test: (provider: ProviderCatalogItem) => provider.status === 'error' || provider.status === 'unconfigured',
    },
  ], [t, accountProviders]);
  const sorts = useMemo<readonly ListSortSpec<ProviderCatalogItem>[]>(() => [
    {
      id: 'kind', label: t('st.list.sort.order'),
      compare: (a, b) => KIND_ORDER.indexOf(connectionKind(a, accountProviders)) - KIND_ORDER.indexOf(connectionKind(b, accountProviders))
        || a.id.localeCompare(b.id),
    },
    { id: 'name', label: t('st.list.sort.name'), compare: (a, b) => a.id.localeCompare(b.id) },
  ], [t, accountProviders]);
  const view = useListView({ listId: 'connections', items: providerItems, keyOf, textOf, filters, sorts });
  // The /new banner deep-links to account sign-in; open the add flow on it.
  const wantsAccount = hash === '#st-card-auth';
  const [adding, setAdding] = useState(false);
  // A deep link opens the add flow once; closing it stays closed.
  const [linkClosed, setLinkClosed] = useState<string | null>(null);
  const linked = (wantsAccount || hash === '#st-card-providers-add') && linkClosed !== hash;
  const addOpen = adding || empty || linked;
  const closeAdd = () => { setAdding(false); setLinkClosed(hash); };

  const signOut = async (providerId: string) => {
    const method = methodFor(providerId);
    if (method === undefined) return;
    setSigningOut(providerId);
    setSignOutFeedback(null);
    try {
      await client.logoutOAuth({ provider: method.id });
      setSignOutFeedback({ tone: 'success', text: t('st.account.signedOut', { method: method.label }) });
      await refreshProviderData();
    } catch (error) {
      setSignOutFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSigningOut(null);
    }
  };

  return (
    <div className="space-y-6">
      <SectionCard id="st-card-providers" title={t('st.providers.title')}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="mr-auto max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t('st.connections.intro')}</p>
            {empty && !addOpen ? (
              <button type="button" data-add-connection className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
                onClick={() => { setAdding(true); }}>
                <Icon name="plus" size={12} />
                {t('st.connections.add')}
              </button>
            ) : null}
          </div>
          {providerItems.length > 0 ? (
            <>
              <ListToolbar view={view} total={providerItems.length} filters={filters} sorts={sorts}
                searchLabel={t('st.connections.search')} searchPlaceholder={t('st.connections.searchPlaceholder')}
                actions={!addOpen ? (
                  <button type="button" data-add-connection className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
                    onClick={() => { setAdding(true); }}>
                    <Icon name="plus" size={12} />
                    {t('st.connections.add')}
                  </button>
                ) : undefined} />
              {view.visible.length === 0 ? (
                <ListEmpty kind="no-match" title={t('st.connections.noMatchTitle')}
                  body={view.query.trim() !== '' ? t('st.connections.noMatches', { query: view.query.trim() }) : undefined}
                  onClear={view.clear} />
              ) : (
                <div data-connection-list>
                  <ListBody items={view.visible} keyOf={keyOf} density={view.density} label={t('st.providers.title')}
                    virtualizeAfter={Number.POSITIVE_INFINITY}
                    renderRow={(provider) => {
                      const method = methodFor(provider.id);
                      return (
                        <ProviderEditor
                          provider={provider}
                          models={modelsQuery.data?.items ?? []}
                          managed={accountProviders.has(provider.id)}
                          modelCount={modelCount(provider.id)}
                          onSaved={refreshProviderData}
                          accountLabel={method?.label}
                          account={method}
                          onSignOut={method?.signed_in === true ? () => void signOut(provider.id) : undefined}
                          signingOut={signingOut === provider.id}
                          density={view.density}
                        />
                      );
                    }} />
                </div>
              )}
            </>
          ) : null}
          {empty ? (
            <div data-connections-empty>
              <ListEmpty kind="none" title={t('st.connections.emptyTitle')} body={t('st.connections.emptyBody')} />
            </div>
          ) : null}
          {providersQuery.isLoading ? <Hint>{t('st.providers.loading')}</Hint> : null}
          {providersQuery.isError ? <InlineError error={providersQuery.error} /> : null}
          <FeedbackLine feedback={signOutFeedback} />
        </div>
      </SectionCard>

      <AccountQuotaCard methods={methods} />

      <CatalogImportCard configuredIds={new Set(providerItems.map((provider) => provider.id))} onImported={refreshProviderData} />

      <SectionCard id="st-card-engines" title={t('st.engines.title')}><ExternalEnginesList /></SectionCard>

      {/* With no connection yet the add flow is the page itself; otherwise it
          opens beside the list in a side panel, so the list stays in view. */}
      {addOpen && empty ? (
        <SectionCard id="st-card-providers-add" title={t('st.connections.addTitle')}>
          <span id="st-card-auth" aria-hidden className="block" />
          <NewProviderWizard
            key={wantsAccount ? 'account' : 'api'}
            initialMethod={wantsAccount ? 'account' : 'api'}
            onSaved={async () => { await refreshProviderData(); closeAdd(); }}
            onAccountChanged={refreshProviderData}
          />
        </SectionCard>
      ) : null}
      {addOpen && !empty ? (
        <SidePanel
          title={t('st.connections.addTitle')}
          overlayId="settings-add-connection"
          onClose={closeAdd}
          width="lg"
          data={{ 'data-add-connection-panel': '' }}
        >
          <div id="st-card-providers-add">
            <span id="st-card-auth" aria-hidden className="block" />
            <NewProviderWizard
              key={wantsAccount ? 'account' : 'api'}
              initialMethod={wantsAccount ? 'account' : 'api'}
              onSaved={async () => { await refreshProviderData(); closeAdd(); }}
              onAccountChanged={refreshProviderData}
            />
          </div>
        </SidePanel>
      ) : null}
    </div>
  );
}
