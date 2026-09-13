import { useMemo } from 'react';
import type { NbSearchCapabilities } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import { nbSearchIssueCodes } from '@kiki/session-core/settings';
import { SectionCard } from '../SectionCard';
import { useI18n } from '../../../i18n';
import { costLabelKey, latencyLabelKey } from './types';
import { NbSearchIssues } from './NbSearchIssues';
import { SECONDARY_BUTTON, SMALL_INPUT } from '../../ui';

function AvailabilityBadge({ availability }: { availability: 'ready' | 'unavailable' }) {
  const { t } = useI18n();
  return (
    <span
      className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide shrink-0 ${
        availability === 'ready'
          ? 'border-success/40 bg-success/10 text-success'
          : 'border-danger/40 bg-danger/5 text-danger'
      }`}
    >
      {availability === 'ready'
        ? t('st.nbSearch.availabilityReady')
        : t('st.nbSearch.availabilityUnavailable')}
    </span>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-hairline/50 font-mono text-[11px] font-bold text-ink">
      {n}
    </div>
  );
}

function FallbackArrow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center -my-1">
      <span className="text-ink-faint text-[10px] select-none">↓ {label}</span>
    </div>
  );
}

export function NbSearchFetchTab({
  capabilities,
  fetchChain,
  fetchChainInherited,
  onChangeChain,
  onToggleInherited,
  saving = false,
}: {
  capabilities: NbSearchCapabilities;
  fetchChain: readonly string[];
  fetchChainInherited: boolean;
  onChangeChain: (chain: readonly string[]) => void;
  onToggleInherited: (inherited: boolean) => void;
  saving?: boolean;
}) {
  const { t } = useI18n();

  const pipelineById = useMemo(
    () => new Map(capabilities.fetch.pipelines.map((pipeline) => [pipeline.id, pipeline])),
    [capabilities.fetch.pipelines],
  );

  const tierLabel = (key: I18nKey | undefined, raw: string) => (key === undefined ? raw : t(key));

  return (
    <SectionCard id="st-card-search-fetch" title={t('st.nbSearch.fetchChainLabel')}>
      <div className="space-y-4">
        {/* Mode banner & toggle */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline bg-paper p-3">
          <div className="space-y-0.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] font-semibold text-ink">
                {fetchChainInherited
                  ? t('st.nbSearch.chainInherited')
                  : t('st.nbSearch.chainCustom')}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-[9.5px] font-medium ${
                  fetchChainInherited
                    ? 'bg-hairline/40 text-ink-soft'
                    : 'bg-accent/15 text-accent border border-accent/30'
                }`}
              >
                {fetchChainInherited
                  ? t('st.nbSearch.fetch.inheritedBadge')
                  : t('st.nbSearch.fetch.customBadge')}
              </span>
            </div>
            <p className="text-[11px] text-ink-soft">
              {t('st.nbSearch.fetch.chainSummary')}
            </p>
          </div>

          <div>
            {fetchChainInherited ? (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={saving}
                onClick={() => {
                  onToggleInherited(false);
                }}
              >
                {t('st.nbSearch.customizeChain')}
              </button>
            ) : (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={saving}
                onClick={() => {
                  onToggleInherited(true);
                }}
              >
                {t('st.nbSearch.resetChain')}
              </button>
            )}
          </div>
        </div>

        {/* Pipeline fallback chain. Inherited mode reads as a static ordered
            list; custom mode turns each row into an editable select. */}
        <fieldset disabled={saving} className="space-y-2.5 disabled:opacity-60">
          {fetchChain.map((pipelineId, index) => {
            const pipeline = pipelineById.get(pipelineId);
            return (
              <div key={`${index}:${pipelineId}`} className="space-y-2">
                {fetchChainInherited ? (
                  <div className="rounded-lg border border-hairline bg-paper p-2.5">
                    <div className="flex items-center gap-2">
                      <StepNumber n={index + 1} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
                        {pipelineId}
                      </span>
                      {pipeline !== undefined ? (
                        <span className="text-[10.5px] text-ink-faint shrink-0">
                          {tierLabel(latencyLabelKey(pipeline.latency), pipeline.latency)}
                          {' · '}
                          {tierLabel(costLabelKey(pipeline.cost), pipeline.cost)}
                        </span>
                      ) : null}
                      {pipeline !== undefined ? (
                        <AvailabilityBadge availability={pipeline.availability} />
                      ) : null}
                    </div>
                    {pipeline !== undefined ? (
                      <NbSearchIssues issues={nbSearchIssueCodes(pipeline.issues)} />
                    ) : null}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-lg border border-hairline bg-paper p-2.5">
                    <StepNumber n={index + 1} />

                    <select
                      className={`${SMALL_INPUT} min-w-0 flex-1 font-mono text-[12px]`}
                      value={pipelineId}
                      aria-label={`${t('st.nbSearch.fetchChainLabel')} ${index + 1}`}
                      onChange={(event) => {
                        const next = [...fetchChain];
                        next[index] = event.target.value;
                        onChangeChain(next);
                      }}
                    >
                      {pipeline === undefined ? (
                        <option value={pipelineId}>{pipelineId}</option>
                      ) : null}
                      {capabilities.fetch.pipelines.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.id}
                          {' ('}
                          {tierLabel(latencyLabelKey(candidate.latency), candidate.latency)}
                          {' · '}
                          {tierLabel(costLabelKey(candidate.cost), candidate.cost)}
                          {')'}
                        </option>
                      ))}
                    </select>

                    {pipeline !== undefined ? (
                      <AvailabilityBadge availability={pipeline.availability} />
                    ) : null}

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        className={`${SECONDARY_BUTTON} px-2 py-1 text-[11px]`}
                        aria-label={t('st.nbSearch.movePipelineUp', { n: index + 1 })}
                        disabled={index === 0}
                        onClick={() => {
                          const next = [...fetchChain];
                          [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                          onChangeChain(next);
                        }}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className={`${SECONDARY_BUTTON} px-2 py-1 text-[11px]`}
                        aria-label={t('st.nbSearch.movePipelineDown', { n: index + 1 })}
                        disabled={index === fetchChain.length - 1}
                        onClick={() => {
                          const next = [...fetchChain];
                          [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                          onChangeChain(next);
                        }}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className={`${SECONDARY_BUTTON} px-2 py-1 text-[11px] text-danger hover:border-danger/40`}
                        aria-label={t('st.nbSearch.removePipeline', { n: index + 1 })}
                        onClick={() => {
                          onChangeChain(fetchChain.filter((_, candidate) => candidate !== index));
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                )}

                {index < fetchChain.length - 1 ? (
                  <FallbackArrow label={t('st.nbSearch.fetch.fallbackHint')} />
                ) : null}
              </div>
            );
          })}

          {!fetchChainInherited ? (
            <button
              type="button"
              className={`${SECONDARY_BUTTON} mt-2 text-[12px] font-medium`}
              onClick={() => {
                const unused = capabilities.fetch.pipelines.find(
                  (pipeline) => !fetchChain.includes(pipeline.id),
                );
                onChangeChain([...fetchChain, unused?.id ?? '']);
              }}
            >
              + {t('st.nbSearch.addPipeline')}
            </button>
          ) : null}

          {fetchChain.length === 0 && !fetchChainInherited ? (
            <p className="rounded-lg border border-amber-rule/60 bg-amber-card p-3 text-[11.5px] text-amber-ink">
              {t('st.nbSearch.chainEmpty')}
            </p>
          ) : null}
        </fieldset>
      </div>
    </SectionCard>
  );
}
