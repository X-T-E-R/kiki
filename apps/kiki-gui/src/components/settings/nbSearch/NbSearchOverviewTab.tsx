/**
 * 概览: can the assistant search and read pages right now, and what needs a
 * hand. Everything that configures how (sources, layering) lives on the
 * advanced tab; this page only points at it.
 */

import type { NbSearchCapabilities, NbSearchTestStatus } from '@kiki/protocol';
import { SectionCard } from '../SectionCard';
import { useI18n } from '../../../i18n';
import { SECONDARY_BUTTON } from '../../ui';
import { fetchUrlState, providerLabelKey, webSearchState } from './types';
import { engineLaneProfiles } from './serviceCards';
import { NbSearchReadinessRow } from './NbSearchReadinessRow';

export function NbSearchOverviewTab({
  capabilities,
  readiness,
  onNavigateToSearch,
  onNavigateToAdvanced,
}: {
  capabilities: NbSearchCapabilities;
  readiness: {
    readonly search: NbSearchTestStatus['search'];
    readonly fetch: NbSearchTestStatus['search'];
  };
  onNavigateToSearch: () => void;
  onNavigateToAdvanced: () => void;
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
      if (lane?.output.channel === 'results') return `${provider} ${t('st.nbSearch.operation.search')}`;
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
  const anyPartial =
    capabilities.providers.instances.some((instance) => instance.issues.length > 0) ||
    capabilities.search.lanes.some((lane) => lane.issues.length > 0) ||
    capabilities.fetch.pipelines.some((pipeline) => pipeline.issues.length > 0);

  return (
    <SectionCard id="st-card-search-status" title={t('st.nbSearch.statusTitle')}>
      <div className="space-y-3">
        <div className="grid gap-2">
          <NbSearchReadinessRow
            label={t('st.nbSearch.webSearch')}
            desc={t('st.nbSearch.webSearchDesc')}
            state={webSearchState(readiness.search)}
            readiness={readiness.search}
            selectionLabel={selectionLabel}
          />
          <NbSearchReadinessRow
            label={t('st.nbSearch.fetchUrl')}
            desc={t('st.nbSearch.fetchUrlDesc')}
            state={fetchUrlState(readiness.fetch)}
            readiness={readiness.fetch}
            selectionLabel={selectionLabel}
          />
        </div>

        {!readiness.search.configured ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-rule/60 bg-amber-card p-3 text-[11.5px] text-amber-ink">
            <p className="min-w-0 flex-1">{t('st.nbSearch.failClosedNote')}</p>
            <button
              type="button"
              onClick={onNavigateToSearch}
              className={`${SECONDARY_BUTTON} text-[11px] font-medium shrink-0`}
              data-nb-search-goto-search
            >
              {t('st.nbSearch.gotoServices')}
            </button>
          </div>
        ) : null}

        {anyPartial ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline bg-paper p-3 text-[11.5px] text-ink-soft">
            <p className="min-w-0 flex-1">{t('st.nbSearch.partialReadyHint')}</p>
            <button
              type="button"
              onClick={onNavigateToAdvanced}
              className={`${SECONDARY_BUTTON} text-[11px] font-medium shrink-0`}
              data-nb-search-goto-advanced
            >
              {t('st.nbSearch.gotoDiagnostics')}
            </button>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
