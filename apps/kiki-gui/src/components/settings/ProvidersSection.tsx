import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ProviderCatalogItem } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { OAUTH_METHODS_QUERY_KEY } from '../AccountSignIn';
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
export function ConnectionsTab() {
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
  // A sign-in method that has no connection yet is offered inside "Add
  // connection" rather than as a row of its own; the list holds connections
  // that exist, including one whose credential has gone stale.
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

  // Both deep links open the one entry point: `#st-card-auth` asked for a
  // sign-in and `#st-card-providers-add` for the form, and a person who
  // arrived from either wants the same thing — add a connection.
  const [adding, setAdding] = useState(false);
  // A deep link opens it once; closing it stays closed.
  const [linkClosed, setLinkClosed] = useState<string | null>(null);
  const wanted = hash === '#st-card-auth' || hash === '#st-card-providers-add';
  const linked = wanted && linkClosed !== hash;
  const addOpen = adding || empty || linked;
  const closeAdd = () => { setAdding(false); setLinkClosed(hash); };
  const openAdd = () => { setAdding(true); setFeedback(null); };

  // `#st-card-auth` no longer names a card of its own — sign-in is the account
  // lane of the one add flow. The page only scrolls and flashes a card that
  // announces itself, so this anchor answers the locate request itself, and
  // only while the flow is actually on screen to receive the arrival.
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
      <SectionCard id="st-card-providers" title={t('st.providers.title')}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="mr-auto max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t('st.connections.intro')}</p>
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

      <SectionCard id="st-card-engines" title={t('st.engines.title')}><ExternalEnginesList /></SectionCard>

      {/* With no connection yet the add flow is the page itself; otherwise it
          opens beside the list in a side panel, so the list stays in view. */}
      {addOpen && empty ? (
        <SectionCard id="st-card-providers-add" title={t('st.connections.addTitle')}>
          <span id="st-card-auth" className="scroll-mt-4" />
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
            <span id="st-card-auth" className="scroll-mt-4" />
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
