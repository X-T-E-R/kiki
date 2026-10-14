import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ProviderCatalogItem } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { AccountSignIn, OAUTH_METHODS_QUERY_KEY } from '../AccountSignIn';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { Icon } from '../icons';
import { NewProviderWizard, PROVIDER_HEALTH_QUERY_KEY, ProviderEditor } from '../ProviderFields';
import { connectionKind, type ConnectionKind } from '../providerPresets';
import { SidePanel } from '../SidePanel';
import { SECONDARY_BUTTON } from '../ui';
import { ExternalEnginesList } from './ExternalEnginesSection';
import { ListBody, ListEmpty, ListToolbar, useListView, type ListFilterSpec, type ListSortSpec } from './list';
import { SectionCard, SettingsCardMountContext } from './SectionCard';

const KIND_ORDER: readonly ConnectionKind[] = ['account', 'api', 'local'];

/**
 * Connections tab: one list, and one way to add to it.
 *
 * Every way Kiki reaches a model is a connection — an account sign-in, a hosted
 * API, a server on this machine — so there is one list of them and each row
 * says how it is reached, what it carries and whether it works. An account's
 * sign-in is part of its connection rather than a separate list of accounts, so
 * a subscription is added, checked, renewed and removed in exactly one place.
 *
 * "Add connection" is that single entry: it offers the sign-in methods the
 * server has and the protocols you can bring a key to, and it is what an empty
 * page shows instead of an empty table.
 */
export function OAuthAccountCard({
  configuredProviderIds,
  onAccountChanged,
}: {
  configuredProviderIds: ReadonlySet<string>;
  onAccountChanged: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  return (
    <SectionCard id="st-card-auth" title={t('st.providers.zone1.title')}>
      <div className="space-y-3">
        <p className="max-w-[62ch] text-[13px] leading-5 text-ink-soft">
          {t('st.providers.zone1.hint')}
        </p>
        <AccountSignIn
          configuredProviderIds={configuredProviderIds}
          onChanged={onAccountChanged}
        />
      </div>
    </SectionCard>
  );
}

/**
 * Connections tab / Providers section: one list, and one way to add to it.
 *
 * Divided into three clear access zones:
 * ① Account sign-in (OAuth / subscription)
 * ② Local CLI harnesses
 * ③ API key providers
 */
export function ProvidersSection() {
  const { client } = useConnection();
  const { t } = useI18n();
  const { hash } = useLocation();
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<Feedback>(null);

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
      test: (provider: ProviderCatalogItem) => {
        const facts = methodFor(provider.id);
        return provider.status === 'error' || provider.status === 'unconfigured'
          || (facts !== undefined && facts.signed_in && facts.connection_state === 'reconnect_required');
      },
    },
  ], [t, accountProviders, methods]);
  const sorts = useMemo<readonly ListSortSpec<ProviderCatalogItem>[]>(() => [
    {
      id: 'kind', label: t('st.list.sort.order'),
      compare: (a, b) => KIND_ORDER.indexOf(connectionKind(a, accountProviders)) - KIND_ORDER.indexOf(connectionKind(b, accountProviders))
        || a.id.localeCompare(b.id),
    },
    { id: 'name', label: t('st.list.sort.name'), compare: (a, b) => a.id.localeCompare(b.id) },
  ], [t, accountProviders]);
  const view = useListView({ listId: 'connections', items: providerItems, keyOf, textOf, filters, sorts });

  const [adding, setAdding] = useState(false);
  const [linkClosed, setLinkClosed] = useState<string | null>(null);
  const wanted = hash === '#st-card-auth' || hash === '#st-card-providers-add';
  const linked = wanted && linkClosed !== hash;
  const addOpen = adding || empty || linked;
  const closeAdd = () => { setAdding(false); setLinkClosed(hash); };
  const openAdd = () => { setAdding(true); setFeedback(null); };

  const onCardMount = useContext(SettingsCardMountContext);
  useEffect(() => {
    if (addOpen && hash === '#st-card-auth') onCardMount?.('st-card-auth');
  }, [addOpen, hash, onCardMount]);

  const addButton = (
    <button type="button" data-add-connection
      className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
      onClick={() => { openAdd(); }}>
      <Icon name="plus" size={12} />
      {t('st.connections.add')}
    </button>
  );

  return (
    <div className="space-y-6">
      {/* Zone 1: Account sign-in (OAuth / direct subscription) */}
      <div data-providers-zone="oauth">
        <OAuthAccountCard
          configuredProviderIds={new Set(providerItems.map((p) => p.id))}
          onAccountChanged={refreshProviderData}
        />
      </div>

      {/* Zone 2: Local CLI harnesses */}
      <div data-providers-zone="harnesses">
        <SectionCard id="st-card-engines" title={t('st.providers.zone2.title')}>
          <p className="mb-3 max-w-[62ch] text-[13px] leading-5 text-ink-soft">
            {t('st.providers.zone2.hint')}
          </p>
          <ExternalEnginesList />
          <div className="mt-4 border-t border-hairline pt-3">
            <Link
              to="/settings/external-clients"
              data-external-clients-entry
              className="-ml-1.5 flex min-h-8 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[12.5px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
            >
              <Icon name="external" size={12} className="shrink-0 text-ink-faint" />
              <span className="min-w-0 truncate">{t('st.engines.externalClientsEntry')}</span>
              <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />
            </Link>
            <p className="mt-0.5 max-w-[62ch] pl-1.5 text-[12px] leading-4 text-ink-faint">
              {t('st.engines.externalClientsEntryHint')}
            </p>
          </div>
        </SectionCard>
      </div>

      {/* Zone 3: API key providers */}
      <div data-providers-zone="apikey">
        <SectionCard id="st-card-providers" title={t('st.providers.zone3.title')}>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="mr-auto max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t('st.providers.zone3.hint')}</p>
            </div>
            {providerItems.length > 0 ? (
              <>
                <ListToolbar view={view} total={providerItems.length} filters={filters} sorts={sorts}
                  searchLabel={t('st.connections.search')} searchPlaceholder={t('st.connections.searchPlaceholder')}
                  actions={addOpen ? undefined : addButton} />
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
                            accountMethod={method}
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
            <FeedbackLine feedback={feedback} />
          </div>
        </SectionCard>
      </div>

      {/* With no connection yet the add flow is the page itself; otherwise it
          opens beside the list in a side panel, so the list stays in view. */}
      {addOpen && empty ? (
        <SectionCard id="st-card-providers-add" title={t('st.connections.addTitle')}>
          <NewProviderWizard
            key={hash === '#st-card-auth' ? 'account' : 'api'}
            initialMethod={hash === '#st-card-auth' ? 'account' : 'api'}
            configuredIds={new Set(providerItems.map((provider) => provider.id))}
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
            <NewProviderWizard
              key={hash === '#st-card-auth' ? 'account' : 'api'}
              initialMethod={hash === '#st-card-auth' ? 'account' : 'api'}
              configuredIds={new Set(providerItems.map((provider) => provider.id))}
              onSaved={async () => { await refreshProviderData(); closeAdd(); }}
              onAccountChanged={refreshProviderData}
            />
          </div>
        </SidePanel>
      ) : null}
    </div>
  );
}

export { ProvidersSection as ConnectionsTab };
