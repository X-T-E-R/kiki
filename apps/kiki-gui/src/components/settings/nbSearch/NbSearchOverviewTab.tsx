/**
 * 概览: can the assistant search and read pages right now, and what needs a
 * hand. A degraded tool names the tab that fixes it, inline on its own row.
 */

import type { NbSearchCapabilities, NbSearchTestStatus } from '@kiki/protocol';
import { SectionCard } from '../SectionCard';
import { useI18n } from '../../../i18n';
import { SECONDARY_BUTTON } from '../../ui';
import { fetchUrlState, operationWord, providerLabelKey, serviceTitle, webSearchState } from './types';
import { engineLaneProfiles } from './serviceCards';
import { NbSearchReadinessRow } from './NbSearchReadinessRow';

export function NbSearchOverviewTab({
  capabilities,
  readiness,
  onNavigateToSearch,
  onNavigateToFetch,
}: {
  capabilities: NbSearchCapabilities;
  readiness: {
    readonly search: NbSearchTestStatus['search'];
    readonly fetch: NbSearchTestStatus['search'];
  };
  onNavigateToSearch: () => void;
  onNavigateToFetch: () => void;
}) {
  const { t } = useI18n();
  // The selection line names the service the way the service cards do — the
  // engine's lane / pipeline ids never print on this page.
  const engineProfiles = engineLaneProfiles(capabilities);
  const selectionLabel = (id: string): string => {
    const profile = engineProfiles[id];
    if (profile !== undefined) {
      const labelKey = providerLabelKey(profile.provider_id);
      const provider = labelKey === undefined ? profile.provider_id : t(labelKey);
      const lane = capabilities.search.lanes.find((candidate) => candidate.id === id);
      if (lane !== undefined) return serviceTitle(provider, operationWord(t, lane, profile.operation_id));
      return provider;
    }
    const pipeline = capabilities.fetch.pipelines.find((candidate) => candidate.id === id);
    const stageProvider = pipeline?.stages[0]?.id;
    if (stageProvider !== undefined) {
      const labelKey = providerLabelKey(stageProvider);
      return labelKey === undefined ? stageProvider : t(labelKey);
    }
    return id;
  };
  const searchState = webSearchState(readiness.search);
  const fetchState = fetchUrlState(readiness.fetch);
  // A row earns its fix link when the tool is not quietly working: unconfigured
  // already has the amber fail-closed note below, so only degraded and
  // unavailable rows carry one.
  const searchFix = searchState === 'degraded' || searchState === 'unavailable' ? (
    <button
      type="button"
      onClick={onNavigateToSearch}
      className="text-[11px] font-medium text-selected-ink hover:underline"
      data-nb-search-goto-search
    >
      {t('st.nbSearch.gotoServices')}
    </button>
  ) : null;
  const fetchFix = fetchState === 'degraded' || fetchState === 'unavailable' ? (
    <button
      type="button"
      onClick={onNavigateToFetch}
      className="text-[11px] font-medium text-selected-ink hover:underline"
      data-nb-search-goto-fetch
    >
      {t('st.nbSearch.gotoFetch')}
    </button>
  ) : null;

  return (
    <SectionCard id="st-card-search-status" title={t('st.nbSearch.statusTitle')}>
      <div className="space-y-3">
        <div className="grid gap-2">
          <NbSearchReadinessRow
            label={t('st.nbSearch.webSearch')}
            desc={t('st.nbSearch.webSearchDesc')}
            state={searchState}
            readiness={readiness.search}
            selectionLabel={selectionLabel}
            action={searchFix}
          />
          <NbSearchReadinessRow
            label={t('st.nbSearch.fetchUrl')}
            desc={t('st.nbSearch.fetchUrlDesc')}
            state={fetchState}
            readiness={readiness.fetch}
            selectionLabel={selectionLabel}
            issueContext="fetch"
            action={fetchFix}
          />
        </div>

        {!readiness.search.configured ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-rule/60 bg-amber-card p-3 text-[11.5px] text-amber-ink">
            <p className="min-w-0 flex-1">{t('st.nbSearch.failClosedNote')}</p>
            <button
              type="button"
              onClick={onNavigateToSearch}
              className={`${SECONDARY_BUTTON} text-[11px] font-medium shrink-0`}
              data-nb-search-goto-search-unconfigured
            >
              {t('st.nbSearch.gotoServices')}
            </button>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
