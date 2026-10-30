import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ProviderCatalogItem } from '@kiki/protocol';
import { isDecisionConnection } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { AccountSignIn, OAUTH_METHODS_QUERY_KEY } from '../AccountSignIn';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { Icon } from '../icons';
import { NewProviderWizard, PROVIDER_HEALTH_QUERY_KEY, ProviderEditor } from '../ProviderFields';
import { connectionKind, type ConnectionKind } from '../providerPresets';
import { SidePanel } from '../SidePanel';
import { SECONDARY_BUTTON } from '../ui';
import { DecisionConnectionsCard } from './DecisionConnections';
import { ExternalEnginesList, ExternalEnginesVisibilitySwitch } from './ExternalEnginesSection';
import { ListBody, ListEmpty, ListToolbar, useListView, type ListFilterSpec, type ListSortSpec } from './list';
import { MODEL_QUERY_PARAM, ModelDetailSplit, ModelMaintenance, ProviderModelList } from './ModelsSection';
import { SectionCard, SettingsCardMountContext } from './SectionCard';

const KIND_ORDER: readonly ConnectionKind[] = ['api', 'account', 'local'];

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
  showHint = true,
  children,
}: {
  configuredProviderIds: ReadonlySet<string>;
  onAccountChanged: () => Promise<void> | void;
  /** The "sign in without managing keys" line, for a reader with nothing connected yet. */
  showHint?: boolean;
  /** Configured account rows. Sign-in below stays the catalog of accounts not connected yet. */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <SectionCard id="st-card-auth" title={t('st.providers.zone1.title')}>
      <div className="space-y-3">
        {showHint ? (
          <p className="max-w-[62ch] text-[13px] leading-5 text-ink-soft">
            {t('st.providers.zone1.hint')}
          </p>
        ) : null}
        {children}
        <AccountSignIn
          configuredProviderIds={configuredProviderIds}
          onChanged={onAccountChanged}
        />
      </div>
    </SectionCard>
  );
}

/**
 * Connections tab / Providers section: one searchable list, drawn as API,
 * then account, then on this machine, and one way to add to it.
 */
export function ProvidersSection() {
  const { client } = useConnection();
  const { t } = useI18n();
  const { hash, search } = useLocation();
  const requestedModel = new URLSearchParams(search).get(MODEL_QUERY_PARAM);
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

  // Decision services are connections too, but they carry no chat models, so
  // they get their own card below and stay out of the chat zones.
  const allProviders = providersQuery.data?.items ?? [];
  const providerItems = useMemo(() => allProviders.filter((provider) => !isDecisionConnection(provider)), [allProviders]);
  const decisionProviders = useMemo(() => allProviders.filter(isDecisionConnection), [allProviders]);
  const allProviderIds = useMemo(() => new Set(allProviders.map((provider) => provider.id)), [allProviders]);
  const methods = methodsQuery.data ?? [];
  const accountProviders = useMemo(() => new Set(methods.map((method) => method.provider)), [methods]);

  const methodFor = (providerId: string) => methods.find((method) => method.provider === providerId);
  const modelCount = (providerId: string) =>
    (modelsQuery.data?.items ?? []).filter((model) => model.provider_id === providerId).length;
  const empty = providersQuery.isSuccess && providerItems.length === 0;

  const keyOf = useCallback((provider: ProviderCatalogItem) => provider.id, []);
  // A connection is also found by the models it carries, since that is where
  // every model is edited now.
  const textOf = useCallback(
    (provider: ProviderCatalogItem) => [
      provider.id, methodFor(provider.id)?.label, provider.base_url,
      ...(modelsQuery.data?.items ?? []).filter((model) => model.provider_id === provider.id)
        .flatMap((model) => [model.id, model.remote_id, model.display_name]),
    ],
    [methods, modelsQuery.data],
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
  const visibleOf = (kind: ConnectionKind) =>
    view.visible.filter((provider) => connectionKind(provider, accountProviders) === kind);
  const renderProvider = (provider: ProviderCatalogItem) => {
    const method = methodFor(provider.id);
    const models = modelsQuery.data?.items ?? [];
    return (
      <ProviderEditor
        provider={provider}
        models={models}
        defaultOpen={requestedModel !== null && models.some((model) => model.id === requestedModel && model.provider_id === provider.id)}
        modelList={(
          <ProviderModelList providerId={provider.id} models={models} />
        )}
        managed={accountProviders.has(provider.id)}
        modelCount={modelCount(provider.id)}
        onSaved={refreshProviderData}
        accountLabel={method?.label}
        accountMethod={method}
        density={view.density}
      />
    );
  };
  const connectionRows = (items: readonly ProviderCatalogItem[]) => items.length === 0 ? null : (
    <div data-connection-list>
      <ListBody items={items} keyOf={keyOf} density={view.density} label={t('st.providers.title')}
        virtualizeAfter={Number.POSITIVE_INFINITY}
        renderRow={renderProvider} />
    </div>
  );

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

  const page = (
    <div className="space-y-6">
      {/* One search over every configured connection, then the three zones:
          API key, account sign-in, and services on this machine (HTTP and CLI).
          Explanations show only while nothing is connected yet. */}
      {providerItems.length > 0 ? (
        <ListToolbar view={view} total={providerItems.length} filters={filters} sorts={sorts}
          searchLabel={t('st.connections.search')} searchPlaceholder={t('st.connections.searchPlaceholder')}
          actions={addOpen ? undefined : addButton} />
      ) : null}
      {providerItems.length > 0 && view.visible.length === 0 ? (
        <ListEmpty kind="no-match" title={t('st.connections.noMatchTitle')}
          body={view.query.trim() !== '' ? t('st.connections.noMatches', { query: view.query.trim() }) : undefined}
          onClear={view.clear} />
      ) : null}
      <div data-providers-zone="apikey">
        <SectionCard id="st-card-providers" title={t('st.providers.zone3.title')}>
          <div className="space-y-3">
            {/* A local HTTP server (Ollama, LM Studio) is an API the user points
                at an address, so it lists with the API services; the card
                below is only for CLI engines Kiki drives. */}
            {connectionRows([...visibleOf('api'), ...visibleOf('local')])}
            {empty ? (
              <div data-connections-empty>
                <ListEmpty kind="none" title={t('st.connections.emptyTitle')} body={t('st.connections.emptyBody')} />
              </div>
            ) : null}
            {providersQuery.isLoading ? <Hint>{t('st.providers.loading')}</Hint> : null}
            {[providersQuery, modelsQuery].filter((query) => query.isError).map((query, index) => (
              <div key={index} className="flex flex-wrap items-center gap-3" data-providers-read-error>
                <InlineError error={query.error} />
                <button type="button" className={SECONDARY_BUTTON} disabled={query.isFetching}
                  onClick={() => void query.refetch()}>{t('common.retry')}</button>
              </div>
            ))}
            <FeedbackLine feedback={feedback} />
          </div>
        </SectionCard>
      </div>

      {/* With no connection yet the add flow is the page itself, right under
          the empty list; otherwise it opens beside the list in a side panel,
          so the list stays in view. */}
      {addOpen && empty ? (
        <SectionCard id="st-card-providers-add" title={t('st.connections.addTitle')}>
          <NewProviderWizard
            key={hash === '#st-card-auth' ? 'account' : 'api'}
            initialMethod={hash === '#st-card-auth' ? 'account' : 'api'}
            configuredIds={allProviderIds}
            onSaved={async () => { await refreshProviderData(); closeAdd(); }}
            onAccountChanged={refreshProviderData}
          />
        </SectionCard>
      ) : null}

      <div data-providers-zone="oauth">
        <OAuthAccountCard
          configuredProviderIds={new Set(providerItems.map((p) => p.id))}
          onAccountChanged={refreshProviderData}
          showHint={empty}
        >
          {connectionRows(visibleOf('account'))}
        </OAuthAccountCard>
      </div>

      <div data-providers-zone="harnesses">
        <SectionCard id="st-card-engines" title={t('st.providers.localConnectionsTitle')} actions={<ExternalEnginesVisibilitySwitch />}>
          <ExternalEnginesList />
          <div className="mt-4">
            <Link
              to="/settings/external-clients"
              data-external-clients-entry
              title={t('st.engines.externalClientsEntryHint')}
              className="-ml-1.5 inline-flex min-h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-[12.5px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
            >
              <Icon name="external" size={12} className="shrink-0 text-ink-faint" />
              <span className="min-w-0 truncate">{t('st.engines.externalClientsEntry')}</span>
              <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />
            </Link>
          </div>
        </SectionCard>
      </div>

      <div data-providers-zone="decision">
        <DecisionConnectionsCard providers={decisionProviders} configuredIds={allProviderIds} onChanged={refreshProviderData} />
      </div>

      <ModelMaintenance />
    </div>
  );

  // A model opened from any connection edits in the page: the connections
  // fold into a rail and the model takes the column (`?model=<id>`).
  return (
    <>
      <ModelDetailSplit list={page} models={modelsQuery.data?.items ?? []} providers={allProviders}
        ready={modelsQuery.isSuccess} onChanged={refreshProviderData}
        providerLabel={(id) => methodFor(id)?.label ?? id} />
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
              configuredIds={allProviderIds}
              onSaved={async () => { await refreshProviderData(); closeAdd(); }}
              onAccountChanged={refreshProviderData}
            />
          </div>
        </SidePanel>
      ) : null}
    </>
  );
}

export { ProvidersSection as ConnectionsTab };
