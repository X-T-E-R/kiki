/**
 * 概览: can the assistant search and read pages right now, and what needs a
 * hand. Everything that configures how (sources, layering) lives on the
 * advanced tab; this page only points at it.
 */

import type { NbSearchCapabilities, NbSearchTestStatus } from '@kiki/protocol';
import { SectionCard } from '../SectionCard';
import { useI18n } from '../../../i18n';
import { SECONDARY_BUTTON } from '../../ui';
import { fetchUrlState, webSearchState } from './types';
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
          />
          <NbSearchReadinessRow
            label={t('st.nbSearch.fetchUrl')}
            desc={t('st.nbSearch.fetchUrlDesc')}
            state={fetchUrlState(readiness.fetch)}
            readiness={readiness.fetch}
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
