import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ProviderCatalogItem } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { DECISION_CONNECTION_PARAM, isDecisionConnection } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { AccountSignIn, OAUTH_METHODS_QUERY_KEY } from '../AccountSignIn';
import { accountState, accountStateKey } from '../accountSignInState';
import { FeedbackLine, type Feedback } from '../controls';
import { ModelConnectCard } from '../firstRun/ModelConnectCard';
import { DisclosureChevron, Icon } from '../icons';
import { NewProviderWizard, PROVIDER_HEALTH_QUERY_KEY, ProviderEditor } from '../ProviderFields';
import { connectionKind, isLocalBaseUrl, vendorLabelFor, type ConnectionKind } from '../providerPresets';
import { SidePanel } from '../SidePanel';
import { SECONDARY_BUTTON } from '../ui';
import { useOAuthFlow } from '../useOAuthFlow';
import { DecisionConnectionsCard } from './DecisionConnections';
import { connectionNeedsAttention } from './DefaultModelBar';
import { ExternalEnginesList, ExternalEnginesVisibilitySwitch } from './ExternalEnginesSection';
import { ListBody, ListEmpty, ListToolbar, useListView, type ListFilterSpec, type ListSortSpec } from './list';
import { MODEL_QUERY_PARAM, ModelDetailSplit, ModelMaintenance, ProviderModelList } from './ModelsSection';
import { SectionCard, SettingsCardMountContext } from './SectionCard';
import { SettingsLoadFailure, SettingsLoading, TEXT_BUTTON } from './SettingsPrimitives';

const KIND_ORDER: readonly ConnectionKind[] = ['api', 'account', 'local'];
const DECISION_CARDS = new Set(['#st-card-decision-connections', '#decision-connection-add']);

export function OAuthAccountCard({
  configuredProviderIds,
  onAccountChanged,
  showHint = true,
  children,
}: {
  configuredProviderIds: ReadonlySet<string>;
  onAccountChanged: () => Promise<void> | void;
  showHint?: boolean;
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
 * Connections tab: Needs attention (only when something needs it), one unified
 * Connections list, and two folds (Command-line agents, Decision models).
 */
export function ProvidersSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const { hash, search } = useLocation();
  const params = new URLSearchParams(search);
  const requestedModel = params.get(MODEL_QUERY_PARAM);
  const requestedEngine = params.get('engine');
  const requestedDecision = params.get(DECISION_CONNECTION_PARAM);
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [focusKeyRequest, setFocusKeyRequest] = useState<{ providerId: string; nonce: number } | null>(null);
  const [openRowRequest, setOpenRowRequest] = useState<string | null>(null);

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

  const oauthFlow = useOAuthFlow(refreshProviderData);

  const allProviders = providersQuery.data?.items ?? [];
  const providerItems = useMemo(() => allProviders.filter((provider) => !isDecisionConnection(provider)), [allProviders]);
  const decisionProviders = useMemo(() => allProviders.filter(isDecisionConnection), [allProviders]);
  const allProviderIds = useMemo(() => new Set(allProviders.map((provider) => provider.id)), [allProviders]);
  const chatProviderIds = useMemo(() => new Set(providerItems.map((provider) => provider.id)), [providerItems]);
  const methods = methodsQuery.data ?? [];
  const accountProviders = useMemo(() => new Set(methods.map((method) => method.provider)), [methods]);

  const methodFor = useCallback(
    (providerId: string) => methods.find((method) => method.provider === providerId),
    [methods],
  );
  const modelCount = (providerId: string) =>
    (modelsQuery.data?.items ?? []).filter((model) => model.provider_id === providerId).length;
  const empty = providersQuery.isSuccess && providerItems.length === 0;

  const attentionItems = useMemo(
    () => providerItems.filter((provider) => connectionNeedsAttention(provider, methodFor(provider.id))),
    [providerItems, methodFor],
  );

  const keyOf = useCallback((provider: ProviderCatalogItem) => provider.id, []);
  const textOf = useCallback(
    (provider: ProviderCatalogItem) => [
      provider.id, methodFor(provider.id)?.label, provider.base_url,
      ...(modelsQuery.data?.items ?? []).filter((model) => model.provider_id === provider.id)
        .flatMap((model) => [model.id, model.remote_id, model.display_name]),
    ],
    [methodFor, modelsQuery.data],
  );
  const filters = useMemo<readonly ListFilterSpec<ProviderCatalogItem>[]>(() => [
    ...KIND_ORDER.map((kind) => ({
      id: kind, label: t(`st.connections.kind.${kind}`),
      test: (provider: ProviderCatalogItem) => connectionKind(provider, accountProviders) === kind,
    })),
    {
      id: 'attention', label: t('st.connections.filter.attention'), tone: 'attention' as const,
      test: (provider: ProviderCatalogItem) => connectionNeedsAttention(provider, methodFor(provider.id)),
    },
  ], [t, accountProviders, methodFor]);
  const sorts = useMemo<readonly ListSortSpec<ProviderCatalogItem>[]>(() => [
    {
      id: 'kind', label: t('st.list.sort.order'),
      compare: (a, b) => KIND_ORDER.indexOf(connectionKind(a, accountProviders)) - KIND_ORDER.indexOf(connectionKind(b, accountProviders))
        || a.id.localeCompare(b.id),
    },
    { id: 'name', label: t('st.list.sort.name'), compare: (a, b) => a.id.localeCompare(b.id) },
  ], [t, accountProviders]);
  const view = useListView({ listId: 'connections', items: providerItems, keyOf, textOf, filters, sorts });

  const renderProvider = (provider: ProviderCatalogItem) => {
    const method = methodFor(provider.id);
    const models = modelsQuery.data?.items ?? [];
    const modelRequested = requestedModel !== null
      && models.some((model) => model.id === requestedModel && model.provider_id === provider.id);
    return (
      <ProviderEditor
        provider={provider}
        models={models}
        defaultOpen={modelRequested || openRowRequest === provider.id}
        openFocusKeySignal={focusKeyRequest?.providerId === provider.id ? focusKeyRequest.nonce : 0}
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

  const [adding, setAdding] = useState(false);
  const [customFormOpen, setCustomFormOpen] = useState(false);
  const [linkClosed, setLinkClosed] = useState<string | null>(null);
  const wanted = hash === '#st-card-auth' || hash === '#st-card-providers-add';
  const linked = wanted && linkClosed !== hash;
  const addOpen = adding || empty || linked;
  const closeAdd = () => {
    setAdding(false);
    setCustomFormOpen(false);
    setLinkClosed(hash);
  };
  const openAdd = () => {
    setCustomFormOpen(false);
    setAdding(true);
    setFeedback(null);
  };

  const enginesLinked = hash === '#st-card-engines' || requestedEngine !== null;
  const [enginesOpen, setEnginesOpen] = useState(enginesLinked);
  useEffect(() => { if (enginesLinked) setEnginesOpen(true); }, [enginesLinked]);

  const decisionLinked = DECISION_CARDS.has(hash) || requestedDecision !== null;
  const [decisionOpen, setDecisionOpen] = useState(decisionLinked);
  useEffect(() => { if (decisionLinked) setDecisionOpen(true); }, [decisionLinked]);

  const onCardMount = useContext(SettingsCardMountContext);
  useEffect(() => {
    if (addOpen && hash === '#st-card-auth') onCardMount?.('st-card-auth');
    if (addOpen && hash === '#st-card-providers-add') onCardMount?.('st-card-providers-add');
  }, [addOpen, hash, onCardMount]);

  const addContent = customFormOpen ? (
    <NewProviderWizard
      key="custom"
      initialMethod="api"
      configuredIds={allProviderIds}
      onSaved={async () => { await refreshProviderData(); closeAdd(); }}
      onImported={refreshProviderData}
      onAccountChanged={refreshProviderData}
    />
  ) : (
    <ModelConnectCard
      key={hash === '#st-card-auth' ? 'account' : 'lanes'}
      surface="settings"
      initialLane={hash === '#st-card-auth' ? 'account' : null}
      configuredProviderIds={chatProviderIds}
      onConnected={async () => {
        await refreshProviderData();
        if (!empty) closeAdd();
      }}
      onOpenCustomForm={() => { setCustomFormOpen(true); }}
    />
  );

  const addButton = !empty && !addOpen ? (
    <button
      type="button"
      data-add-connection
      className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
      onClick={openAdd}
    >
      <Icon name="plus" size={12} />
      {t('st.connections.add')}
    </button>
  ) : undefined;

  const findConnectionRow = (providerId: string): HTMLDetailsElement | null =>
    [...document.querySelectorAll<HTMLDetailsElement>('[data-connection-row]')]
      .find((row) => row.dataset['connectionRow'] === providerId) ?? null;

  const openProviderKeyField = (providerId: string) => {
    if (view.narrowed && !view.visible.some((item) => item.id === providerId)) {
      view.clear();
    }
    setOpenRowRequest(providerId);
    setFocusKeyRequest((current) => ({ providerId, nonce: (current?.nonce ?? 0) + 1 }));
    requestAnimationFrame(() => {
      findConnectionRow(providerId)?.scrollIntoView?.({ block: 'nearest' });
    });
  };

  const openProviderRow = (providerId: string) => {
    if (view.narrowed && !view.visible.some((item) => item.id === providerId)) {
      view.clear();
    }
    setOpenRowRequest(providerId);
    requestAnimationFrame(() => {
      const row = findConnectionRow(providerId);
      if (row !== null) {
        row.open = true;
        row.scrollIntoView?.({ block: 'nearest' });
      }
    });
  };

  const page = (
    <div className="space-y-6">
      {attentionItems.length > 0 ? (
        <section
          data-connections-attention
          aria-label={t('st.nav.needsAttention')}
          className="space-y-1.5"
        >
          <p className="text-[12px] font-medium text-amber-ink">{t('st.nav.needsAttention')}</p>
          <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-panel">
            {attentionItems.map((provider) => {
              const method = methodFor(provider.id);
              const kind = connectionKind(provider, accountProviders);
              const count = modelCount(provider.id);
              const needsKey = kind === 'api' && !isLocalBaseUrl(provider.base_url)
                && !provider.has_api_key && provider.api_key_env === undefined;
              const accountFacts = method === undefined ? null : accountState(method, undefined);
              const statusWord = accountFacts !== null
                ? t(accountStateKey(accountFacts))
                : provider.status === 'error'
                  ? t('st.connections.statusError')
                  : needsKey
                    ? t('st.connections.statusNeedsKey')
                    : t('st.connections.statusSetup');
              const displayName = method?.label ?? vendorLabelFor(provider.base_url) ?? provider.id;

              return (
                <li
                  key={provider.id}
                  data-attention-row={provider.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-[13px] font-medium text-ink">{displayName}</span>
                    <span className="ml-2 text-[12px] text-ink-faint">
                      {t(`st.connections.kind.${kind}`)} · {t('st.connections.modelCount', { count })}
                    </span>
                  </span>
                  <span className={`shrink-0 text-[12px] ${provider.status === 'error' ? 'text-danger' : 'text-amber-ink'}`}>
                    {statusWord}
                  </span>
                  {needsKey ? (
                    <button
                      type="button"
                      data-attention-fix={provider.id}
                      className={`min-h-7 shrink-0 px-1 pointer-coarse:min-h-10 ${TEXT_BUTTON}`}
                      onClick={() => { openProviderKeyField(provider.id); }}
                    >
                      {t('st.ai.fix.key')}
                    </button>
                  ) : method !== undefined && (accountFacts?.state === 'signIn' || accountFacts?.state === 'reconnect') ? (
                    <button
                      type="button"
                      data-attention-fix={provider.id}
                      disabled={oauthFlow.busy !== null}
                      className={`min-h-7 shrink-0 px-1 pointer-coarse:min-h-10 ${TEXT_BUTTON}`}
                      onClick={() => {
                        openProviderRow(provider.id);
                        void oauthFlow.start(method);
                      }}
                    >
                      {accountFacts.state === 'signIn' ? t('st.account.signIn') : t('st.account.signInAgain')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-attention-fix={provider.id}
                      className={`min-h-7 shrink-0 px-1 pointer-coarse:min-h-10 ${TEXT_BUTTON}`}
                      onClick={() => { openProviderRow(provider.id); }}
                    >
                      {t('st.profiles.openThere')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {empty ? (
        <div id="st-card-providers" data-providers-zone="connections">
          <div id={hash === '#st-card-auth' ? 'st-card-auth' : 'st-card-providers-add'}>
            {addContent}
          </div>
        </div>
      ) : (
        <div data-providers-zone="connections">
          <SectionCard id="st-card-providers" title={t('st.ai.tab.connections')} actions={addButton}>
            <div className="space-y-3">
              {providerItems.length > 0 ? (
                <ListToolbar
                  view={view}
                  total={providerItems.length}
                  filters={filters}
                  sorts={sorts}
                  searchLabel={t('st.connections.search')}
                  searchPlaceholder={t('st.connections.searchPlaceholder')}
                />
              ) : null}
              {providerItems.length > 0 && view.visible.length === 0 ? (
                <ListEmpty
                  kind="no-match"
                  title={t('st.connections.noMatchTitle')}
                  body={view.query.trim() !== '' ? t('st.connections.noMatches', { query: view.query.trim() }) : undefined}
                  onClear={view.clear}
                />
              ) : null}
              {view.visible.length > 0 ? (
                <div data-connection-list>
                  <ListBody
                    items={view.visible}
                    keyOf={keyOf}
                    density={view.density}
                    label={t('st.ai.tab.connections')}
                    virtualizeAfter={Number.POSITIVE_INFINITY}
                    renderRow={renderProvider}
                  />
                </div>
              ) : null}
              {providersQuery.isLoading ? (
                <SettingsLoading label={t('st.ai.status.loading')} rows={2} />
              ) : null}
              {[providersQuery, modelsQuery].filter((query) => query.isError).map((query, index) => (
                <div key={index} data-providers-read-error>
                  <SettingsLoadFailure
                    message={t('st.ai.listFailed', { detail: errorText(locale, query.error) })}
                    retrying={query.isFetching}
                    onRetry={() => { void query.refetch(); }}
                  />
                </div>
              ))}
              <FeedbackLine feedback={feedback} />
            </div>
          </SectionCard>
        </div>
      )}

      <details
        className="group"
        data-providers-zone="harnesses"
        data-engines-fold
        open={enginesOpen}
        onToggle={(event) => { setEnginesOpen(event.currentTarget.open); }}
      >
        <summary className="flex min-h-8 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-[12.5px] font-medium text-ink-soft hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
          <DisclosureChevron open={false} className="text-ink-soft transition-transform group-open:rotate-90" />
          {t('st.ai.engines.fold')}
        </summary>
        {enginesOpen ? (
          <div className="pt-3">
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
        ) : null}
      </details>

      <details
        className="group"
        data-providers-zone="decision"
        data-decision-fold
        open={decisionOpen}
        onToggle={(event) => { setDecisionOpen(event.currentTarget.open); }}
      >
        <summary className="flex min-h-8 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-[12.5px] font-medium text-ink-soft hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
          <DisclosureChevron open={false} className="text-ink-soft transition-transform group-open:rotate-90" />
          {t('st.ai.decision.fold')}
        </summary>
        {decisionOpen ? (
          <div className="pt-3">
            <DecisionConnectionsCard providers={decisionProviders} configuredIds={allProviderIds} onChanged={refreshProviderData} />
          </div>
        ) : null}
      </details>

      <ModelMaintenance />
    </div>
  );

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
          <div id={hash === '#st-card-auth' ? 'st-card-auth' : 'st-card-providers-add'}>
            {addContent}
          </div>
        </SidePanel>
      ) : null}
    </>
  );
}

export { ProvidersSection as ConnectionsTab };
