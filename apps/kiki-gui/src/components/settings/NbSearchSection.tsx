import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { CARD_ID_TO_TAB, NB_SEARCH_TABS, serviceState } from './nbSearch/types';
import { NbSearchTabBar } from './nbSearch/NbSearchTabBar';
import { NbSearchOverviewTab } from './nbSearch/NbSearchOverviewTab';
import { NbSearchLanesTab } from './nbSearch/NbSearchLanesTab';
import { NbSearchFetchTab } from './nbSearch/NbSearchFetchTab';
import { NbSearchProvidersTab } from './nbSearch/NbSearchProvidersTab';
import { NbSearchAdvancedTab, type TestRun } from './nbSearch/NbSearchAdvancedTab';
import type { NbSearchAdvancedBinding } from './nbSearch/advancedSupport';
import { keyDraftIssue, pendingKeyValue, type KeyDraft } from './nbSearch/NbSearchMultiKeyEditor';
import { SearchIndexStatusCard } from './SearchIndexStatusCard';
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
  const { client, scopeId } = useConnection();
  const readCredential = useCallback((id: string, reveal: boolean) => client.readNbSearchCredential(id, reveal), [client]);
  const readKeyUsage = useCallback((id: string, refresh: boolean) => client.readNbSearchKeyUsage(id, refresh), [client]);
  const writeCredential = useCallback((id: string, value: string | null, version: string, binding: string) => client.writeNbSearchCredential(id, value, version, binding), [client]);
  const { t, tp, locale } = useI18n();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();

  const [editorBaseline, setEditorBaseline] = useState<NbSearchEditorBaseline | null>(null);
  const [draft, setDraft] = useState<ExtendedNbSearchDraft | null>(null);
  /**
   * Pending key writes, per service. They live beside the config draft because
   * the two commit separately on the server (config patch, then a
   * version-checked credential write), and a failed key write must survive the
   * config half landing.
   */
  const [keyDrafts, setKeyDrafts] = useState<Readonly<Record<string, KeyDraft>>>({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Set when a save landed but the capabilities refresh failed: the editor
  // drops back to the error shell instead of showing pre-save capabilities
  // as if they were the new state.
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [statusStale, setStatusStale] = useState<unknown>(null);
  const [refreshRetrying, setRefreshRetrying] = useState(false);
  const [testRun, setTestRun] = useState<TestRun>({ status: 'idle' });
  const testAbort = useRef<AbortController | null>(null);
  // A landed patch may still need its post-patch binding read after a failed refresh.
  const bindingBeforePatch = useRef(new Map<string, string>());

  const fetchCapabilities = useCallback(async () => {
    const fresh = await client.getNbSearchCapabilities();
    setStatusStale(null);
    if (statusStale !== null) {
      setFeedback((current) => current?.tone === 'info' ? null : current);
      setEditorBaseline((current) => current === null ? current : { ...current, capabilities: fresh });
    }
    return fresh;
  }, [client, statusStale]);

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
    queryFn: fetchCapabilities,
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

  /** Instances the server has a saved override for: the user's own services. */
  const configuredInstanceIds = useMemo(
    () => new Set(Object.keys((editorBaseline?.config?.provider_instances ?? {}) as Record<string, unknown>)),
    [editorBaseline],
  );

  const pendingKeys = useMemo(
    () => Object.entries(keyDrafts).filter(([, entry]) => entry.mode !== 'keep'),
    [keyDrafts],
  );

  const dirty = useMemo(() => {
    if (draft === null || editorBaseline === null) return pendingKeys.length > 0;
    const nbSearchDirty = nbSearchDraftDirty(editorBaseline.draft.nbSearch, draft.nbSearch);
    const sourceDirty = editorBaseline.draft.reuseLocalConfig !== draft.reuseLocalConfig;
    return nbSearchDirty || sourceDirty || pendingKeys.length > 0;
  }, [draft, editorBaseline, pendingKeys.length]);

  useDirtyReporter('nb-search', dirty);
  // Key drafts are registered on their own id as well: an unsaved key is the
  // one draft the old page dropped without a word when you navigated away.
  useDirtyReporter('nb-search-keys', pendingKeys.length > 0);

  const retryCapabilitiesRefresh = async () => {
    setRefreshRetrying(true);
    try {
      const fresh = await fetchCapabilities();
      queryClient.setQueryData(['nb-search-capabilities'], fresh);
      setEditorBaseline((current) => current === null ? current : { ...current, capabilities: fresh });
      setRefreshError(null);
    } catch (error) {
      if (editorBaseline === null) setRefreshError(error);
      else setStatusStale(error);
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
            <p className="rounded-md border border-amber-rule/60 bg-amber-card px-3 py-1.5 text-[11px] text-amber-ink">
              {t('st.nbSearch.savedStatusFailed')}
              {pendingKeys.length > 0 ? (
                <span className="mt-1 block">{tp('st.nbSearch.savedStatusFailedPendingKeys', pendingKeys.length)}</span>
              ) : null}
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

  /**
   * Replaces the whole nb_search draft. The S2 surfaces (advanced tabs, the
   * second-instance editor) hand back a complete draft rather than one field,
   * and they all land in the same draft and the same save as the S1 fields.
   */
  const updateNbSearchDraft = (next: NbSearchDraft) => {
    setDraft((current) => (current === null ? current : { ...current, nbSearch: next }));
  };

  /**
   * One binding for the three advanced sub-pages: lane and preset profiles, the
   * eight fetch-chain groups, file scopes and the quality fallback all read and
   * write the page draft, so the bottom save row commits them with everything
   * else. A plain object, not a hook: this sits after the loading early return.
   */
  const advancedBinding: NbSearchAdvancedBinding = {
    capabilities,
    draft: draft.nbSearch,
    config: editorBaseline.config,
    onChange: updateNbSearchDraft,
  };

  const toggleReuseLocal = (reuseLocalConfig: boolean) => {
    setDraft((current) =>
      current === null ? current : { ...current, reuseLocalConfig },
    );
  };

  const handleDiscard = () => {
    if (editorBaseline) {
      setDraft(editorBaseline.draft);
      setKeyDrafts({});
      bindingBeforePatch.current.clear();
      setFeedback(null);
    }
  };

  const updateKeyDraft = (instanceId: string, next: KeyDraft) => {
    const previous = keyDrafts[instanceId];
    if (next.mode === 'keep' || (previous?.mode !== 'keep' && next.base !== previous?.base)) {
      bindingBeforePatch.current.delete(instanceId);
    }
    setKeyDrafts((current) => {
      const entries = { ...current };
      if (next.mode === 'keep') delete entries[instanceId];
      else entries[instanceId] = next;
      return entries;
    });
  };

  /** Adding a service saves an explicit override for an instance the server already reports. */
  const addService = (instanceId: string) => {
    updateProviders(instanceId, { isNew: true, enabled: true, isDeleted: false });
  };

  const removeService = (instanceId: string) => {
    const name = capabilities.providers.instances.find((entry) => entry.id === instanceId)?.provider_id ?? instanceId;
    updateProviders(instanceId, { isDeleted: true, isNew: false });
    updateKeyDraft(instanceId, { mode: 'keep' });
    setFeedback({ tone: 'info', text: t('st.nbSearch.service.removed', { name }) });
  };

  /**
   * One save for the page. The config half and the key half commit in the order
   * the server requires — the patch first, because it can move a credential slot
   * and therefore the binding the key write is checked against — and a key that
   * fails to write stays in its field instead of being reported as saved.
   */
  const save = async () => {
    const nbSearchChanged = nbSearchDraftDirty(editorBaseline.draft.nbSearch, draft.nbSearch);
    const sourceChanged = editorBaseline.draft.reuseLocalConfig !== draft.reuseLocalConfig;
    const pendingWrites = Object.entries(keyDrafts).filter(([, entry]) => entry.mode !== 'keep');
    if (!nbSearchChanged && !sourceChanged && pendingWrites.length === 0) return;

    // A key list that cannot be stored must not be reported as stored, and it
    // must not take the rest of the page down with it either.
    for (const [, entry] of pendingWrites) {
      const issue = keyDraftIssue(t, entry);
      if (issue !== null) {
        setFeedback({ tone: 'error', text: issue });
        selectTab('providers');
        return;
      }
    }

    let patchPayload: Record<string, unknown> | null = null;
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
    } else if (sourceChanged) {
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
      const patchBindings = new Map<string, string>();
      if (patchPayload !== null) {
        for (const [instanceId, entry] of pendingWrites) {
          if (entry.mode === 'keep' || entry.base === undefined) continue;
          const view = await readCredential(instanceId, false);
          if (view.binding_version === entry.base.binding) patchBindings.set(instanceId, view.binding_version);
        }
      }
      const config = patchPayload === null
        ? { nb_search: editorBaseline.config, nb_search_source: editorBaseline.sourceConfig }
        : await client.patchConfig(patchPayload);
      if (patchPayload !== null) {
        queryClient.setQueryData(['config'], config);
        for (const [instanceId, binding] of patchBindings) bindingBeforePatch.current.set(instanceId, binding);
      }

      // The config is already saved. A failed refresh hides old capabilities,
      // but neither the pending keys nor their migration check may be discarded.
      let refreshedCapabilities: NbSearchCapabilities;
      try {
        refreshedCapabilities = await fetchCapabilities();
      } catch (error) {
        setEditorBaseline(null);
        setDraft(null);
        setRefreshError(error);
        return;
      }

      const written = new Set<string>();
      const keyFailures: string[] = [];
      const conflictMessage = t('st.nbSearch.keys.conflict');
      for (const [instanceId, entry] of pendingWrites) {
        try {
          if (entry.mode === 'keep') continue;
          const value = pendingKeyValue(entry);
          if (value === undefined) continue;
          let base = entry.base;
          const previousBinding = bindingBeforePatch.current.get(instanceId);
          if (base === undefined || previousBinding !== undefined) {
            const view = await readCredential(instanceId, false);
            // A binding observed unchanged before our landed patch but changed
            // after it (slot, endpoint, or consumers) permits a new base. A version
            // change with the same binding never replaces the user's editing base:
            // the write must return 40941. The marker survives a failed refresh.
            if (base === undefined || (previousBinding === base.binding && view.binding_version !== base.binding)) {
              // A direct paste into an unobserved empty field has no editing base
              // to protect. This first read protects only read -> write; retaining
              // it below gives subsequent retries the same CAS protection.
              base = { version: view.version, binding: view.binding_version };
            }
            bindingBeforePatch.current.delete(instanceId);
          }
          const expected = base;
          setKeyDrafts((current) => current[instanceId] !== entry ? current : {
            ...current, [instanceId]: { ...entry, base: expected },
          });
          await writeCredential(instanceId, value, expected.version, expected.binding);
          written.add(instanceId);
        } catch (error) {
          const conflict = error !== null && typeof error === 'object' && 'code' in error && error.code === 40941;
          keyFailures.push(conflict ? conflictMessage : errorText(locale, error));
        }
      }
      let statusRefreshFailed = false;
      if (written.size > 0) {
        try {
          refreshedCapabilities = await fetchCapabilities();
        } catch (error) {
          statusRefreshFailed = true;
          setStatusStale(error);
        }
      }
      // Never republish the pre-key snapshot as a successful post-key refresh.
      if (!statusRefreshFailed) queryClient.setQueryData(['nb-search-capabilities'], refreshedCapabilities);

      const resetDraft: ExtendedNbSearchDraft = {
        nbSearch: nbSearchDraftFromConfig(config.nb_search, refreshedCapabilities),
        reuseLocalConfig:
          config.nb_search_source?.reuse_local_config
          ?? refreshedCapabilities.config_source?.reuse_local_config
          ?? draft.reuseLocalConfig,
      };

      setEditorBaseline({
        config: config.nb_search,
        sourceConfig: config.nb_search_source,
        capabilities: refreshedCapabilities,
        draft: resetDraft,
      });
      setDraft(resetDraft);
      setKeyDrafts((current) => Object.fromEntries(
        Object.entries(current).filter(([instanceId]) => !written.has(instanceId)),
      ));
      if (keyFailures.length > 0) {
        const reasons = [...new Set(keyFailures)];
        // A conflict carries its own recovery — reread the key list, then save —
        // so it leads alone. Appending the generic "save again to retry" line
        // would send the user straight back into the same rejected write.
        setFeedback({
          tone: 'error',
          text: reasons.length === 1 && reasons[0] === conflictMessage
            ? conflictMessage
            : `${t('st.nbSearch.keys.saveFailed')} ${reasons.join(' ')}`,
        });
      } else if (statusRefreshFailed) {
        setFeedback({ tone: 'info', text: t('st.nbSearch.statusRefreshStale') });
      } else {
        setFeedback({ tone: 'success', text: t('st.nbSearch.saved') });
      }
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

  // Only a configured service that actually fails is worth a number on the tab.
  // The engine ships seventeen instances, so counting every unavailable one
  // turns a normal page into a permanent alarm.
  const attentionCount = capabilities.providers.instances.filter((instance) => {
    if (!configuredInstanceIds.has(instance.id)) return false;
    const instanceDraft = draft.nbSearch.providers[instance.id];
    const state = serviceState(instance, instanceDraft?.enabled ?? instance.enabled);
    return state === 'needsKey' || state === 'failed';
  }).length;

  return (
    <div className="space-y-4">
      {statusStale !== null ? (
        <div className="rounded-md border border-amber-rule/60 bg-amber-card px-3 py-1.5 text-[11px] text-amber-ink" data-nb-search-status-stale>
          <p>{t('st.nbSearch.statusRefreshStale')}</p>
          <button type="button" className={`${SECONDARY_BUTTON} mt-1`} disabled={refreshRetrying || saving}
            onClick={() => { void retryCapabilitiesRefresh(); }}>
            {t('common.retry')}
          </button>
        </div>
      ) : null}
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
          advanced={advancedBinding}
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
          advanced={advancedBinding}
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
          key={scopeId}
          capabilities={capabilities}
          configuredInstanceIds={configuredInstanceIds}
          draftProviders={draft.nbSearch.providers}
          credentialSlots={draft.nbSearch.credentialSlots}
          keyDrafts={keyDrafts}
          nbSearchDraft={draft.nbSearch}
          onUpdateProvider={updateProviders}
          onUpdateCredentialEnv={updateCredentialEnv}
          onKeyDraftChange={updateKeyDraft}
          onAddService={addService}
          onRemoveService={removeService}
          onDraftChange={updateNbSearchDraft}
          readCredential={readCredential}
          readKeyUsage={readKeyUsage}
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
        {activeTab === 'advanced' ? <SearchIndexStatusCard /> : null}
        <NbSearchAdvancedTab
          execution={draft.nbSearch.execution}
          testRun={testRun}
          onUpdateExecution={updateExecution}
          onRunCheck={() => {
            void runCheck();
          }}
          onCancelCheck={cancelCheck}
          saving={saving}
          advanced={advancedBinding}
        />
      </div>

      {/* Page-end save row with dirty state and the last result. */}
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
