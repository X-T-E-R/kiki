/**
 * 网页抓取: which services read a page, in which order.
 *
 * The everyday surface is the url → markdown chain as service cards: open a
 * card to paste its key or switch it off; move it with the arrows; 添加服务
 * appends another reader. The pair pickers (输入种类 / 输出格式) almost never
 * change, so the non-default pairs sit in their own disclosure, and the
 * routing rules that can override the chain stay in a group below it.
 */

import { useMemo, useState } from 'react';
import type { NbSearchCapabilities } from '@kiki/protocol';
import {
  setNbSearchFetchChain,
  type NbSearchInputKind,
  type NbSearchRepresentation,
} from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { Hint } from '../../controls';
import { SECONDARY_BUTTON } from '../../ui';
import { SectionCard } from '../SectionCard';
import { AdvancedDetails, SettingsGroup } from '../fields';
import { SettingsSelect } from '../SettingsPrimitives';
import { ListEmpty } from '../list';
import { nbSearchServiceCards } from './types';
import type { KeyDraft } from './NbSearchMultiKeyEditor';
import { NbSearchServiceCard } from './NbSearchServiceCard';
import { NbSearchRoutingEditor } from './NbSearchRoutingEditor';
import {
  FETCH_INPUT_KIND_KEYS,
  FETCH_REPRESENTATION_KEYS,
  type NbSearchAdvancedBinding,
} from './advancedSupport';
import {
  DEFAULT_FETCH_PAIR,
  addPipelineService,
  appendablePipeline,
  cardInstance,
  chainPipelines,
  laneProfiles,
  moveInChain,
  removeFromChain,
} from './serviceCards';

type ReadCredential = (instanceId: string, reveal: boolean) => Promise<import('@kiki/protocol').NbSearchManagedCredentialView>;
type ReadKeyUsage = (instanceId: string, refresh: boolean) => Promise<import('@kiki/protocol').NbSearchKeyUsageView>;

const REPRESENTATIONS: readonly NbSearchRepresentation[] = ['markdown', 'text'];

export function NbSearchFetchTab({
  capabilities,
  saving = false,
  advanced,
  keyDrafts,
  onKeyDraftChange,
  readCredential,
  readKeyUsage,
}: {
  capabilities: NbSearchCapabilities;
  saving?: boolean;
  advanced: NbSearchAdvancedBinding;
  keyDrafts: Readonly<Record<string, KeyDraft>>;
  onKeyDraftChange: (instanceId: string, draft: KeyDraft) => void;
  readCredential: ReadCredential;
  readKeyUsage: ReadKeyUsage;
}) {
  const { t } = useI18n();
  const draft = advanced.draft;
  const profiles = useMemo(() => laneProfiles(capabilities, draft), [capabilities, draft]);
  const cards = useMemo(
    () => new Map(nbSearchServiceCards(t, capabilities, profiles).map((card) => [card.id, card])),
    [t, capabilities, profiles],
  );

  const defaultChain = chainPipelines(
    capabilities, draft, DEFAULT_FETCH_PAIR.inputKind, DEFAULT_FETCH_PAIR.representation,
  );

  const chainCard = (pipelineId: string): import('./types').ServiceCard => {
    const known = cards.get(pipelineId);
    if (known !== undefined) return known;
    return { id: pipelineId, title: pipelineId, subtitle: t('st.nbSearch.role.fetchShort') };
  };

  const appendTarget = appendablePipeline(
    capabilities, draft, DEFAULT_FETCH_PAIR.inputKind, DEFAULT_FETCH_PAIR.representation,
  );

  return (
    <div className="space-y-4">
      <SectionCard id="st-card-search-fetch" title={t('st.nbSearch.fetch.title')}>
        <div className="space-y-4">
          <Hint>{t('st.nbSearch.fetch.pageHint')}</Hint>

          {defaultChain.pipelines.length === 0 ? (
            <ListEmpty
              kind="none"
              title={t('st.nbSearch.chainEmpty')}
            />
          ) : (
            <div className="space-y-2" data-nb-search-fetch-chain>
              {defaultChain.pipelines.map((pipelineId, index) => {
                const instance = cardInstance(capabilities, draft, profiles, 'pipeline', pipelineId);
                return (
                  <NbSearchServiceCard
                    key={`${index}:${pipelineId}`}
                    card={chainCard(pipelineId)}
                    kind="pipeline"
                    capabilities={capabilities}
                    draft={draft}
                    onChange={advanced.onChange}
                    keyDraft={instance === undefined ? { mode: 'keep' } : keyDrafts[instance.id] ?? { mode: 'keep' }}
                    onKeyDraftChange={(next) => {
                      if (instance !== undefined) onKeyDraftChange(instance.id, next);
                    }}
                    readCredential={readCredential}
                    readKeyUsage={readKeyUsage}
                    saving={saving}
                    chain={{
                      position: index,
                      length: defaultChain.pipelines.length,
                      onMove: (delta) => {
                        advanced.onChange(moveInChain(
                          draft, capabilities, DEFAULT_FETCH_PAIR.inputKind, DEFAULT_FETCH_PAIR.representation, pipelineId, delta,
                        ));
                      },
                      onRemove: () => {
                        advanced.onChange(removeFromChain(
                          draft, capabilities, DEFAULT_FETCH_PAIR.inputKind, DEFAULT_FETCH_PAIR.representation, pipelineId,
                        ));
                      },
                    }}
                  />
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`${SECONDARY_BUTTON} inline-flex items-center gap-1`}
              disabled={saving || appendTarget === undefined}
              data-nb-search-fetch-add
              onClick={() => {
                if (appendTarget === undefined) return;
                advanced.onChange(addPipelineService(draft, capabilities, appendTarget, [
                  DEFAULT_FETCH_PAIR,
                ]));
              }}
            >
              <Icon name="plus" size={12} />
              {t('st.nbSearch.addPipeline')}
            </button>
            {!defaultChain.inherited ? (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={saving}
                data-nb-search-fetch-restore
                onClick={() => {
                  advanced.onChange(setNbSearchFetchChain(
                    draft,
                    DEFAULT_FETCH_PAIR.inputKind,
                    DEFAULT_FETCH_PAIR.representation,
                    defaultChain.pipelines,
                    true,
                  ));
                }}
              >
                {t('st.nbSearch.custom.chain.restoreSourceOrder')}
              </button>
            ) : null}
            {defaultChain.inherited ? (
              <span className="text-[12px] text-ink-faint" data-nb-search-fetch-inherited>
                {t('st.nbSearch.custom.chain.pairSource')}
              </span>
            ) : null}
          </div>

          <OtherPairs capabilities={capabilities} binding={advanced} saving={saving} cards={cards} />

          <SettingsGroup title={t('st.nbSearch.routing.title')} help={t('st.nbSearch.routing.help')}>
            <p className="text-[12px] leading-snug text-ink-faint" data-nb-search-chain-role>
              {t('st.nbSearch.routing.chainRoleHint')}
            </p>
            <fieldset disabled={saving} className="space-y-3 disabled:opacity-60">
              <NbSearchRoutingEditor binding={advanced} saving={saving} />
            </fieldset>
          </SettingsGroup>
        </div>
      </SectionCard>
    </div>
  );
}

/** Every pair that is not url → markdown, behind its own disclosure. */
function OtherPairs({
  capabilities,
  binding,
  saving,
  cards,
}: {
  capabilities: NbSearchCapabilities;
  binding: NbSearchAdvancedBinding;
  saving: boolean;
  cards: ReadonlyMap<string, { id: string; title: string; subtitle: string; latency?: string; cost?: string }>;
}) {
  const { t, tp } = useI18n();
  const [combo, setCombo] = useState<{ inputKind: NbSearchInputKind; representation: NbSearchRepresentation }>({
    inputKind: 'inline_text',
    representation: 'markdown',
  });
  const draft = binding.draft;
  const chain = chainPipelines(capabilities, draft, combo.inputKind, combo.representation);
  const appendTarget = appendablePipeline(capabilities, draft, combo.inputKind, combo.representation);

  return (
    <AdvancedDetails summary={t('st.nbSearch.fetch.otherPairs')} data-nb-search-fetch-other-pairs>
      <div className="space-y-3">
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

        {chain.pipelines.length === 0 ? (
          <p className="text-[12px] leading-snug text-ink-faint">{t('st.nbSearch.custom.noCompatiblePipeline')}</p>
        ) : (
          <ol className="space-y-2" data-nb-search-fetch-other-chain>
            {chain.pipelines.map((pipelineId, index) => (
              <li key={`${index}:${pipelineId}`} className="flex items-center gap-2 rounded-lg border border-hairline px-3 py-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-hairline/50 font-mono text-[11px] font-semibold text-ink">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {cards.get(pipelineId)?.title ?? pipelineId}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    className={`${SECONDARY_BUTTON} px-1.5 py-1`}
                    aria-label={t('st.nbSearch.movePipelineUp', { n: index + 1 })}
                    title={t('st.nbSearch.movePipelineUp', { n: index + 1 })}
                    disabled={saving || index === 0}
                    onClick={() => {
                      binding.onChange(moveInChain(draft, capabilities, combo.inputKind, combo.representation, pipelineId, -1));
                    }}
                  >
                    <Icon name="arrowDown" size={12} className="rotate-180" />
                  </button>
                  <button
                    type="button"
                    className={`${SECONDARY_BUTTON} px-1.5 py-1`}
                    aria-label={t('st.nbSearch.movePipelineDown', { n: index + 1 })}
                    title={t('st.nbSearch.movePipelineDown', { n: index + 1 })}
                    disabled={saving || index === chain.pipelines.length - 1}
                    onClick={() => {
                      binding.onChange(moveInChain(draft, capabilities, combo.inputKind, combo.representation, pipelineId, 1));
                    }}
                  >
                    <Icon name="arrowDown" size={12} />
                  </button>
                  <button
                    type="button"
                    className={`${SECONDARY_BUTTON} px-1.5 py-1 text-danger hover:border-danger/40`}
                    aria-label={t('st.nbSearch.removePipeline', { n: index + 1 })}
                    title={t('st.nbSearch.removePipeline', { n: index + 1 })}
                    disabled={saving || chain.pipelines.length === 1}
                    onClick={() => {
                      binding.onChange(removeFromChain(draft, capabilities, combo.inputKind, combo.representation, pipelineId));
                    }}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={`${SECONDARY_BUTTON} inline-flex items-center gap-1`}
            disabled={saving || appendTarget === undefined}
            data-nb-search-fetch-add-other
            onClick={() => {
              if (appendTarget === undefined) return;
              binding.onChange(addPipelineService(draft, capabilities, appendTarget, [combo]));
            }}
          >
            <Icon name="plus" size={12} />
            {t('st.nbSearch.addPipeline')}
          </button>
          {!chain.inherited ? (
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={saving}
              data-nb-search-fetch-restore-pair
              onClick={() => {
                binding.onChange(setNbSearchFetchChain(draft, combo.inputKind, combo.representation, chain.pipelines, true));
              }}
            >
              {t('st.nbSearch.custom.chain.restoreSourceOrder')}
            </button>
          ) : (
            <span className="text-[12px] text-ink-faint">{t('st.nbSearch.custom.chain.pairSource')}</span>
          )}
        </div>
        <p className="text-[12px] leading-snug text-ink-faint">
          {tp('st.nbSearch.custom.chain.snapshot', (draft.advanced?.fetchChains ?? []).filter((pair) => !pair.inherited).length)}
        </p>
      </div>
    </AdvancedDetails>
  );
}
