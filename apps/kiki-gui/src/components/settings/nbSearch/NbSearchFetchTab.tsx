import { useMemo, useState } from 'react';
import type { NbSearchCapabilities } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import {
  nbSearchCompatiblePipelines,
  nbSearchExecutionKind,
  nbSearchIssueCodes,
  setNbSearchFetchChain,
  type NbSearchInputKind,
  type NbSearchRepresentation,
} from '@kiki/session-core/settings';
import { SectionCard } from '../SectionCard';
import { useI18n } from '../../../i18n';
import { costLabelKey, latencyLabelKey } from './types';
import { NbSearchIssues } from './NbSearchIssues';
import { SECONDARY_BUTTON } from '../../ui';
import { SettingsSelect } from '../SettingsPrimitives';
import { Icon } from '../../icons';
import { AdvancedDetails, SettingsGroup } from '../fields';
import {
  FETCH_INPUT_KIND_KEYS,
  FETCH_REPRESENTATION_KEYS,
  nbSearchUsageWord,
  type NbSearchAdvancedBinding,
} from './advancedSupport';
import { NbSearchRoutingEditor } from './NbSearchRoutingEditor';

const REPRESENTATIONS: readonly NbSearchRepresentation[] = ['markdown', 'text'];

function StepNumber({ n }: { n: number }) {
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-hairline/50 font-mono text-[11px] font-semibold text-ink">
      {n}
    </span>
  );
}

export function NbSearchFetchTab({
  capabilities,
  fetchChain,
  fetchChainInherited,
  onChangeChain,
  onToggleInherited,
  saving = false,
  advanced,
}: {
  capabilities: NbSearchCapabilities;
  fetchChain: readonly string[];
  fetchChainInherited: boolean;
  onChangeChain: (chain: readonly string[]) => void;
  onToggleInherited: (inherited: boolean) => void;
  saving?: boolean;
  /** Present once the page hands its draft over; enables every input × output pair. */
  advanced?: NbSearchAdvancedBinding;
}) {
  const { t, tp } = useI18n();
  const [combo, setCombo] = useState<{ inputKind: NbSearchInputKind; representation: NbSearchRepresentation }>({
    inputKind: 'url',
    representation: 'markdown',
  });

  const draft = advanced?.draft;
  const chainDraft = draft?.advanced?.fetchChains.find(
    (chain) => chain.inputKind === combo.inputKind && chain.representation === combo.representation,
  );

  // Without the page's draft the tab keeps editing the url→markdown chain the
  // way it always did; with it, the same controls edit whichever pair is picked.
  const currentChain = advanced === undefined ? fetchChain : chainDraft?.pipelines ?? [];
  const currentInherited = advanced === undefined ? fetchChainInherited : chainDraft?.inherited ?? true;

  const pipelineById = useMemo(
    () => new Map(capabilities.fetch.pipelines.map((pipeline) => [pipeline.id, pipeline])),
    [capabilities.fetch.pipelines],
  );

  const compatible = useMemo(
    () => (advanced === undefined
      ? capabilities.fetch.pipelines
      : nbSearchCompatiblePipelines(capabilities, combo.inputKind, combo.representation)),
    [advanced, capabilities, combo],
  );

  const tierLabel = (key: I18nKey | undefined, raw: string) => (key === undefined ? raw : t(key));

  const write = (pipelines: readonly string[], inherited = false) => {
    if (advanced === undefined) {
      onChangeChain(pipelines);
      return;
    }
    advanced.onChange(setNbSearchFetchChain(advanced.draft, combo.inputKind, combo.representation, pipelines, inherited));
  };

  const setInherited = (inherited: boolean) => {
    if (advanced === undefined) {
      onToggleInherited(inherited);
      return;
    }
    write(currentChain, inherited);
  };

  const summary = combo.inputKind === 'url' && combo.representation === 'markdown'
    ? t('st.nbSearch.fetch.chainSummary')
    : t('st.nbSearch.custom.fetchChainSummary');

  const pairs = draft?.advanced?.fetchChains ?? [];
  const ownedPairs = pairs.filter((chain) => !chain.inherited);

  /**
   * Restoring inheritance is an all-or-nothing action: the config format
   * replaces the whole chain array, so per-pair "restore" only takes the
   * source order for that pair into the snapshot.
   */
  const restoreAll = () => {
    if (advanced === undefined) return;
    let next = advanced.draft;
    for (const chain of pairs) {
      next = setNbSearchFetchChain(next, chain.inputKind, chain.representation, chain.pipelines, true);
    }
    advanced.onChange(next);
  };

  return (
    <SectionCard
      id="st-card-search-fetch"
      title={advanced === undefined ? t('st.nbSearch.fetchChainLabel') : t('st.nbSearch.fetch.title')}
    >
      <div className="space-y-4">
        {advanced === undefined ? null : (
          <div className="grid gap-3 sm:grid-cols-2" data-nb-search-fetch-combo>
            <label className="block text-[12px] font-medium text-ink-soft">
              {t('st.nbSearch.fetch.inputKind')}
              <span className="mt-1 block font-normal">
                <SettingsSelect
                  variant="form"
                  value={combo.inputKind}
                  ariaLabel={t('st.nbSearch.fetch.inputKind')}
                  disabled={saving}
                  dataAttr="data-nb-search-fetch-input"
                  choices={capabilities.fetch.inputs.map((input) => ({
                    value: input.kind,
                    label: t(FETCH_INPUT_KIND_KEYS[input.kind]!),
                    hint: input.enabled ? undefined : t('st.nbSearch.fetch.inputDisabled'),
                  }))}
                  onChange={(next) => {
                    setCombo((current) => ({ ...current, inputKind: next }));
                  }}
                />
              </span>
            </label>
            <label className="block text-[12px] font-medium text-ink-soft">
              {t('st.nbSearch.fetch.representation')}
              <span className="mt-1 block font-normal">
                <SettingsSelect
                  variant="form"
                  value={combo.representation}
                  ariaLabel={t('st.nbSearch.fetch.representation')}
                  disabled={saving}
                  dataAttr="data-nb-search-fetch-representation"
                  choices={REPRESENTATIONS.map((value) => ({
                    value,
                    label: t(FETCH_REPRESENTATION_KEYS[value]!),
                  }))}
                  onChange={(next) => {
                    setCombo((current) => ({ ...current, representation: next }));
                  }}
                />
              </span>
            </label>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <span
              className="text-[13px] text-ink"
              data-nb-search-fetch-mode={advanced === undefined ? (currentInherited ? 'inherited' : 'custom') : (currentInherited ? 'source' : 'edited')}
            >
              {advanced === undefined
                ? currentInherited ? t('st.nbSearch.chainInherited') : t('st.nbSearch.chainCustom')
                : currentInherited
                  ? t('st.nbSearch.custom.chain.pairSource')
                  : t('st.nbSearch.custom.chain.pairEdited')}
            </span>
            <p className="text-[12px] leading-snug text-ink-faint">{summary}</p>
          </div>
          <div className="shrink-0">
            {currentInherited ? (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={saving || currentChain.length === 0}
                data-nb-search-fetch-customize
                onClick={() => {
                  setInherited(false);
                }}
              >
                {advanced === undefined
                  ? t('st.nbSearch.customizeChain')
                  : t('st.nbSearch.custom.chain.customizePair')}
              </button>
            ) : (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={saving}
                data-nb-search-fetch-restore
                onClick={() => {
                  setInherited(true);
                }}
              >
                {advanced === undefined
                  ? t('st.nbSearch.resetChain')
                  : t('st.nbSearch.custom.chain.restoreSourceOrder')}
              </button>
            )}
          </div>
        </div>

        {compatible.length === 0 && !currentInherited ? (
          <p className="text-[12px] leading-snug text-amber-ink" data-nb-search-fetch-no-pipeline>
            {t('st.nbSearch.custom.noCompatiblePipeline')}
          </p>
        ) : null}

        <fieldset disabled={saving} className="disabled:opacity-60">
          <ol className="divide-y divide-hairline" data-nb-search-fetch-chain>
            {currentChain.map((pipelineId, index) => {
              const pipeline = pipelineById.get(pipelineId);
              const incompatible = advanced !== undefined && !currentInherited
                && compatible.every((candidate) => candidate.id !== pipelineId);
              const execution = pipeline === undefined ? 'none' : nbSearchExecutionKind(pipeline.execution_modes);
              return (
                <li key={`${index}:${pipelineId}`} className="flex flex-wrap items-center gap-2 py-2" data-fetch-chain-step={pipelineId}>
                  <StepNumber n={index + 1} />

                  {currentInherited || advanced === undefined ? (
                    <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-ink">{pipelineId}</span>
                  ) : (
                    <div className="min-w-0 flex-1">
                      <SettingsSelect
                        variant="form"
                        mono
                        dataAttr="data-fetch-chain-step"
                        ariaLabel={`${t('st.nbSearch.fetchChainLabel')} ${index + 1}`}
                        value={pipelineId}
                        onChange={(nextId) => {
                          const next = [...currentChain];
                          next[index] = nextId;
                          write(next);
                        }}
                        choices={[
                          ...(compatible.every((candidate) => candidate.id !== pipelineId)
                            ? [{ value: pipelineId, label: pipelineId, hint: t('st.nbSearch.custom.pipelineIncompatible') }]
                            : []),
                          ...compatible.map((candidate) => ({
                            value: candidate.id,
                            label: candidate.id,
                            hint: `${tierLabel(latencyLabelKey(candidate.latency), candidate.latency)} · ${tierLabel(costLabelKey(candidate.cost), candidate.cost)}`,
                          })),
                        ]}
                      />
                    </div>
                  )}

                  <span className={`shrink-0 text-[12px] ${execution === 'sync' && pipeline?.availability === 'ready' ? 'text-ink-soft' : 'text-ink-faint'}`}>
                    {pipeline === undefined
                      ? t('st.nbSearch.custom.pipelineUnknown')
                      : t(nbSearchUsageWord(pipeline.availability, execution))}
                  </span>

                  {currentInherited || advanced === undefined ? null : (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        className={`${SECONDARY_BUTTON} px-1.5 py-1`}
                        data-nb-search-fetch-up
                        aria-label={t('st.nbSearch.movePipelineUp', { n: index + 1 })}
                        title={t('st.nbSearch.movePipelineUp', { n: index + 1 })}
                        disabled={index === 0}
                        onClick={() => {
                          const next = [...currentChain];
                          [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                          write(next);
                        }}
                      >
                        <Icon name="arrowDown" size={12} className="rotate-180" />
                      </button>
                      <button
                        type="button"
                        className={`${SECONDARY_BUTTON} px-1.5 py-1`}
                        data-nb-search-fetch-down
                        aria-label={t('st.nbSearch.movePipelineDown', { n: index + 1 })}
                        title={t('st.nbSearch.movePipelineDown', { n: index + 1 })}
                        disabled={index === currentChain.length - 1}
                        onClick={() => {
                          const next = [...currentChain];
                          [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                          write(next);
                        }}
                      >
                        <Icon name="arrowDown" size={12} />
                      </button>
                      <button
                        type="button"
                        className={`${SECONDARY_BUTTON} px-1.5 py-1 text-danger hover:border-danger/40`}
                        data-nb-search-fetch-remove
                        aria-label={t('st.nbSearch.removePipeline', { n: index + 1 })}
                        title={t('st.nbSearch.removePipeline', { n: index + 1 })}
                        disabled={currentChain.length === 1}
                        onClick={() => {
                          write(currentChain.filter((_, candidate) => candidate !== index));
                        }}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                  )}

                  {pipeline !== undefined ? (
                    <span className="basis-full pl-8">
                      {incompatible ? (
                        <p className="mt-1 text-[11px] leading-relaxed text-danger" data-nb-search-fetch-incompatible>
                          {t('st.nbSearch.custom.pipelineIncompatible')}
                        </p>
                      ) : null}
                      <NbSearchIssues issues={nbSearchIssueCodes(pipeline.issues)} />
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>

          {currentChain.length > 0 ? (
            <p className="mt-2 text-[12px] leading-snug text-ink-faint">
              {t('st.nbSearch.fetch.fallbackHint')}
            </p>
          ) : null}

          {currentInherited || advanced === undefined ? null : (
            <button
              type="button"
              className={`${SECONDARY_BUTTON} mt-2 inline-flex items-center gap-1`}
              data-nb-search-fetch-add
              disabled={compatible.every((candidate) => currentChain.includes(candidate.id))}
              onClick={() => {
                const unused = compatible.find((pipeline) => !currentChain.includes(pipeline.id));
                if (unused !== undefined) write([...currentChain, unused.id]);
              }}
            >
              <Icon name="plus" size={12} />
              {t('st.nbSearch.addPipeline')}
            </button>
          )}

          {/* Whole-array replace: per-pair "restore" only writes the source
              order into the snapshot, so the all-pairs restore is its own
              action and states how many pairs are no longer just the source. */}
          {advanced === undefined || ownedPairs.length === 0 ? null : (
            <div className="mt-3 space-y-1 border-t border-hairline pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  disabled={saving}
                  data-nb-search-fetch-restore-all
                  onClick={restoreAll}
                >
                  {t('st.nbSearch.custom.chain.restoreAll')}
                </button>
                <span className="text-[12px] leading-snug text-ink-faint" data-nb-search-fetch-snapshot>
                  {tp('st.nbSearch.custom.chain.snapshot', ownedPairs.length)}
                </span>
              </div>
              <AdvancedDetails summary={t('st.nbSearch.custom.chain.noteTitle')}>
                <p data-nb-search-fetch-snapshot-note>
                  {t('st.nbSearch.custom.chain.noteBody', { count: String(pairs.length) })}
                </p>
              </AdvancedDetails>
            </div>
          )}

          {currentChain.length === 0 && !currentInherited ? (
            <p className="mt-2 text-[12px] text-amber-ink">
              {t('st.nbSearch.chainEmpty')}
            </p>
          ) : null}
        </fieldset>

        {/* Routing answers the same question one step earlier: which chain a URL
            request gets. It reads the same draft, so it belongs to this card,
            and the chain above keeps its meaning as "what runs when no rule
            matches". */}
        {advanced === undefined ? null : (
          <SettingsGroup title={t('st.nbSearch.routing.title')} help={t('st.nbSearch.routing.help')}>
            <p className="text-[12px] leading-snug text-ink-faint" data-nb-search-chain-role>
              {t('st.nbSearch.routing.chainRoleHint')}
            </p>
            <fieldset disabled={saving} className="space-y-3 disabled:opacity-60">
              <NbSearchRoutingEditor binding={advanced} saving={saving} />
            </fieldset>
          </SettingsGroup>
        )}
      </div>
    </SectionCard>
  );
}
