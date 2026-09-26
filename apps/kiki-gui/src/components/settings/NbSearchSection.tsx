import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NbSearchCapabilities } from '@kiki/protocol';

import { errorText } from '@kiki/session-core/i18n';
import {
  nbSearchConfigPatch,
  nbSearchDraftDirty,
  nbSearchDraftFromConfig,
  nbSearchReadinessFromCapabilities,
  setNbSearchCredentialEnv,
  type NbSearchDraft,
  type NbSearchProviderDraft,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { useDirtyReporter } from '../dirtyGuard';
import { Hint, InlineError, type Feedback } from '../controls';
import { SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';

import type { ExtendedNbSearchDraft, NbSearchEditorBaseline, NbSearchTab } from './nbSearch/types';
import { CARD_ID_TO_TAB, NB_SEARCH_TABS } from './nbSearch/types';
import { NbSearchTabBar } from './nbSearch/NbSearchTabBar';
import { NbSearchOverviewTab } from './nbSearch/NbSearchOverviewTab';
import { NbSearchLanesTab } from './nbSearch/NbSearchLanesTab';
import { NbSearchFetchTab } from './nbSearch/NbSearchFetchTab';
import { NbSearchProvidersTab } from './nbSearch/NbSearchProvidersTab';
import { NbSearchAdvancedTab, type TestRun } from './nbSearch/NbSearchAdvancedTab';
import { NbSearchActionBar } from './nbSearch/NbSearchActionBar';

function resolveTabFromLocation(
  search: string,
  hash: string,
): NbSearchTab {
  // Hash anchor takes precedence so deep links and search hits locate the true sub-page
  const cleanHash = hash.replace(/^#/, '');
  if (cleanHash && CARD_ID_TO_TAB[cleanHash]) {
    return CARD_ID_TO_TAB[cleanHash]!;
  }
  const params = new URLSearchParams(search);
  const tabParam = params.get('tab');
  if (tabParam && (NB_SEARCH_TABS as readonly string[]).includes(tabParam)) {
    return tabParam as NbSearchTab;
  }
  return 'overview';
}

export function NbSearchSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();

  const [editorBaseline, setEditorBaseline] = useState<NbSearchEditorBaseline | null>(null);
  const [draft, setDraft] = useState<ExtendedNbSearchDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Set when a save landed but the capabilities refresh failed: the editor
  // drops back to the error shell instead of showing pre-save capabilities
  // as if they were the new state.
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [refreshRetrying, setRefreshRetrying] = useState(false);
  const [testRun, setTestRun] = useState<TestRun>({ status: 'idle' });
  const testAbort = useRef<AbortController | null>(null);

  // Tab selection: driven by URL query / hash, fallback to overview
  const activeTab = useMemo(
    () => resolveTabFromLocation(location.search, location.hash),
    [location.search, location.hash],
  );

  const selectTab = (nextTab: NbSearchTab) => {
    if (nextTab === activeTab) return;
    const params = new URLSearchParams(location.search);
    params.set('tab', nextTab);
    // Internal sub-page tab switching preserves draft and does not pop the global leave guard
    void navigate(`/settings/search?${params.toString()}`);
  };

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });

  const capsQuery = useQuery({
    queryKey: ['nb-search-capabilities'],
    queryFn: () => client.getNbSearchCapabilities(),
    staleTime: 30_000,
  });

  const loadedBaseline = useMemo((): NbSearchEditorBaseline | null => {
    if (capsQuery.data === undefined || configQuery.data === undefined) return null;
    const reuseLocal =
      configQuery.data.nb_search_source?.reuse_local_config ??
      capsQuery.data.config_source?.reuse_local_config ??
      true;
    return {
      config: configQuery.data.nb_search,
      sourceConfig: configQuery.data.nb_search_source,
      capabilities: capsQuery.data,
      draft: {
        nbSearch: nbSearchDraftFromConfig(configQuery.data.nb_search, capsQuery.data),
        reuseLocalConfig: reuseLocal,
      },
    };
  }, [configQuery.data, capsQuery.data]);

  useEffect(() => {
    if (editorBaseline !== null || loadedBaseline === null || refreshError !== null) return;
    setEditorBaseline(loadedBaseline);
    setDraft(loadedBaseline.draft);
  }, [editorBaseline, loadedBaseline, refreshError]);

  const capabilities = editorBaseline?.capabilities;

  const dirty = useMemo(() => {
    if (draft === null || editorBaseline === null) return false;
    const nbSearchDirty = nbSearchDraftDirty(editorBaseline.draft.nbSearch, draft.nbSearch);
    const sourceDirty = editorBaseline.draft.reuseLocalConfig !== draft.reuseLocalConfig;
    return nbSearchDirty || sourceDirty;
  }, [draft, editorBaseline]);

  useDirtyReporter('nb-search', dirty);

  const retryCapabilitiesRefresh = async () => {
    setRefreshRetrying(true);
    try {
      const fresh = await client.getNbSearchCapabilities();
      queryClient.setQueryData(['nb-search-capabilities'], fresh);
      setRefreshError(null);
    } catch (error) {
      setRefreshError(error);
    } finally {
      setRefreshRetrying(false);
    }
  };

  if (draft === null || editorBaseline === null || capabilities === undefined) {
    return (
      <SectionCard id="st-card-search-status" title={t('st.nbSearch.statusTitle')}>
        {refreshError !== null ? (
          <div className="space-y-3">
            {/* The save landed; only the status refresh failed — say so before
                the raw error so this never reads as a failed save. */}
            <p className="rounded-md border border-amber-rule/60 bg-amber-card px-2.5 py-1.5 text-[11px] text-amber-ink">
              {t('st.nbSearch.savedStatusFailed')}
            </p>
            <InlineError error={refreshError} />
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={refreshRetrying}
              onClick={() => {
                void retryCapabilitiesRefresh();
              }}
            >
              {t('common.retry')}
            </button>
          </div>
        ) : configQuery.isError ? (
          <InlineError error={configQuery.error} />
        ) : capsQuery.isError ? (
          <InlineError error={capsQuery.error} />
        ) : (
          <Hint>{t('st.nbSearch.loading')}</Hint>
        )}
      </SectionCard>
    );
  }

  const readiness = nbSearchReadinessFromCapabilities(capabilities);

  const updateProviders = (id: string, patch: Partial<NbSearchProviderDraft>) => {
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            nbSearch: {
              ...current.nbSearch,
              providers: {
                ...current.nbSearch.providers,
                [id]: { ...current.nbSearch.providers[id]!, ...patch },
              },
            },
          },
    );
  };

  const updateCredentialEnv = (instanceId: string, providerId: string, credentialEnv: string) => {
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            nbSearch: setNbSearchCredentialEnv(current.nbSearch, instanceId, providerId, credentialEnv),
          },
    );
  };

  const updateExecution = (patch: Partial<NbSearchDraft['execution']>) => {
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            nbSearch: {
              ...current.nbSearch,
              execution: { ...current.nbSearch.execution, ...patch },
            },
          },
    );
  };

  const updateDefaultLane = (defaultSearchLane: string) => {
    setDraft((current) =>
      current === null ? current : { ...current, nbSearch: { ...current.nbSearch, defaultSearchLane } },
    );
  };

  const updateFetchChain = (fetchChain: readonly string[]) => {
    setDraft((current) =>
      current === null ? current : { ...current, nbSearch: { ...current.nbSearch, fetchChain } },
    );
  };

  const updateFetchChainInherited = (fetchChainInherited: boolean) => {
    setDraft((current) =>
      current === null ? current : { ...current, nbSearch: { ...current.nbSearch, fetchChainInherited } },
    );
  };

  const toggleReuseLocal = (reuseLocalConfig: boolean) => {
    setDraft((current) =>
      current === null ? current : { ...current, reuseLocalConfig },
    );
  };

  const handleDiscard = () => {
    if (editorBaseline) {
      setDraft(editorBaseline.draft);
      setFeedback(null);
    }
  };

  const save = async () => {
    const nbSearchChanged = nbSearchDraftDirty(editorBaseline.draft.nbSearch, draft.nbSearch);
    const sourceChanged = editorBaseline.draft.reuseLocalConfig !== draft.reuseLocalConfig;
    if (!nbSearchChanged && !sourceChanged) return;

    let patchPayload: Record<string, unknown>;
    if (nbSearchChanged) {
      let nbSearchPatch;
      try {
        nbSearchPatch = nbSearchConfigPatch(editorBaseline.config, draft.nbSearch, capabilities);
      } catch (error) {
        setFeedback({ tone: 'error', text: errorText(locale, error) });
        return;
      }
      patchPayload = {
        ...nbSearchPatch,
        ...(sourceChanged ? { nb_search_source: { reuse_local_config: draft.reuseLocalConfig } } : {}),
        replace_domains: sourceChanged ? ['nb_search', 'nb_search_source'] : ['nb_search'],
      };
    } else {
      // Source-only save: skip the canonical nb_search form validation and
      // never rewrite the saved nb_search domain. This is the recovery path
      // when an inherited broken local config must be switched off.
      patchPayload = {
        nb_search_source: { reuse_local_config: draft.reuseLocalConfig },
        replace_domains: ['nb_search_source'],
      };
    }

    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(patchPayload);
      queryClient.setQueryData(['config'], echoed);
      // Refetch capabilities directly rather than invalidate-and-hope: a
      // failed refresh must not leave the pre-save capabilities posing as the
      // post-save state.
      let refreshedCapabilities: NbSearchCapabilities;
      try {
        refreshedCapabilities = await client.getNbSearchCapabilities();
      } catch (error) {
        // The cached (pre-save) capabilities stay in the query but are never
        // rendered: the error shell owns the screen until Retry succeeds.
        setEditorBaseline(null);
        setDraft(null);
        setRefreshError(error);
        return;
      }
      queryClient.setQueryData(['nb-search-capabilities'], refreshedCapabilities);
      const resetDraft: ExtendedNbSearchDraft = {
        nbSearch: nbSearchDraftFromConfig(echoed.nb_search, refreshedCapabilities),
        reuseLocalConfig:
          echoed.nb_search_source?.reuse_local_config ??
          refreshedCapabilities.config_source?.reuse_local_config ??
          draft.reuseLocalConfig,
      };

      setEditorBaseline({
        config: echoed.nb_search,
        sourceConfig: echoed.nb_search_source,
        capabilities: refreshedCapabilities,
        draft: resetDraft,
      });
      setDraft(resetDraft);
      setFeedback({ tone: 'success', text: t('st.nbSearch.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const runCheck = async () => {
    const controller = new AbortController();
    testAbort.current = controller;
    setTestRun({ status: 'running' });
    try {
      const result = await client.testNbSearch(controller.signal);
      setTestRun({ status: 'ok', result });
    } catch (error) {
      if (controller.signal.aborted) setTestRun({ status: 'cancelled' });
      else setTestRun({ status: 'error', message: errorText(locale, error) });
    } finally {
      testAbort.current = null;
    }
  };

  const cancelCheck = () => {
    testAbort.current?.abort();
  };

  const attentionCount = capabilities.providers.instances.filter(
    (i) => i.availability === 'unavailable' || i.issues.length > 0,
  ).length;

  return (
    // Bottom padding after the sticky action bar keeps the last card (and the
    // diagnostics error line) scrollable fully above the bar instead of
    // sliding under it at max scroll. The 160px scroll-margin makes every
    // scroll-into-view (proof assertions, keyboard focus) park controls and
    // alerts above the bar even when its buttons wrap to a second row.
    <div className="space-y-4 pb-16 [&_input]:scroll-mb-40 [&_textarea]:scroll-mb-40 [&_button]:scroll-mb-40 [&_[role=switch]]:scroll-mb-40 [&_[role=radio]]:scroll-mb-40 [&_[role=alert]]:scroll-mb-40">
      {/* Sub-page Tab bar navigation */}
      <NbSearchTabBar
        activeTab={activeTab}
        onSelectTab={selectTab}
        attentionCount={attentionCount}
        dirty={dirty}
      />

      {/* Overview & Configuration source sub-page */}
      <div
        id="nb-search-panel-overview"
        role="tabpanel"
        aria-labelledby="nb-search-tab-overview"
        className={activeTab === 'overview' ? 'space-y-4' : 'hidden'}
      >
        <NbSearchOverviewTab
          capabilities={capabilities}
          readiness={readiness}
          reuseLocalConfig={draft.reuseLocalConfig}
          savedReuseLocalConfig={editorBaseline.draft.reuseLocalConfig}
          onToggleReuseLocal={toggleReuseLocal}
          onNavigateToSearch={() => {
            selectTab('search');
          }}
          onNavigateToProviders={() => {
            selectTab('providers');
          }}
          saving={saving}
        />
      </div>

      {/* Search lanes sub-page */}
      <div
        id="nb-search-panel-search"
        role="tabpanel"
        aria-labelledby="nb-search-tab-search"
        className={activeTab === 'search' ? 'space-y-4' : 'hidden'}
      >
        <NbSearchLanesTab
          capabilities={capabilities}
          defaultSearchLane={draft.nbSearch.defaultSearchLane}
          onSelectLane={updateDefaultLane}
          saving={saving}
        />
      </div>

      {/* Fetch chain sub-page */}
      <div
        id="nb-search-panel-fetch"
        role="tabpanel"
        aria-labelledby="nb-search-tab-fetch"
        className={activeTab === 'fetch' ? 'space-y-4' : 'hidden'}
      >
        <NbSearchFetchTab
          capabilities={capabilities}
          fetchChain={draft.nbSearch.fetchChain}
          fetchChainInherited={draft.nbSearch.fetchChainInherited}
          onChangeChain={updateFetchChain}
          onToggleInherited={updateFetchChainInherited}
          saving={saving}
        />
      </div>

      {/* Providers & credentials sub-page */}
      <div
        id="nb-search-panel-providers"
        role="tabpanel"
        aria-labelledby="nb-search-tab-providers"
        className={activeTab === 'providers' ? 'space-y-4' : 'hidden'}
      >
        <NbSearchProvidersTab
          capabilities={capabilities}
          draftProviders={draft.nbSearch.providers}
          credentialSlots={draft.nbSearch.credentialSlots}
          onUpdateProvider={updateProviders}
          onUpdateCredentialEnv={updateCredentialEnv}
          saving={saving}
        />
      </div>

      {/* Advanced & Diagnostics sub-page */}
      <div
        id="nb-search-panel-advanced"
        role="tabpanel"
        aria-labelledby="nb-search-tab-advanced"
        className={activeTab === 'advanced' ? 'space-y-4' : 'hidden'}
      >
        <NbSearchAdvancedTab
          execution={draft.nbSearch.execution}
          testRun={testRun}
          onUpdateExecution={updateExecution}
          onRunCheck={() => {
            void runCheck();
          }}
          onCancelCheck={cancelCheck}
          saving={saving}
        />
      </div>

      {/* Persistent / Sticky Action Bar with dirty state, discard, and save */}
      <NbSearchActionBar
        dirty={dirty}
        saving={saving}
        feedback={feedback}
        onSave={() => {
          void save();
        }}
        onDiscard={handleDiscard}
      />
    </div>
  );
}
