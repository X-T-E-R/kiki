import { useMemo, useState } from 'react';

import type {
  EvaluatedBindingSlot,
  GroupedBindingSlot,
  PortableSpaceBindingChoices,
  PortableSpaceLocalModelOption,
  PortableSpaceSubscribePreviewManifest,
  SubscriptionSelectionEvaluation,
} from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { PORTABLE_SUBSCRIPTION_SCOPE_LABEL_KEY } from '../../../lib/portableSpaces';
import { DisclosureChevron } from '../../icons';
import { ModelPicker } from '../../ModelPicker';
import type { SearchableSelectOption } from '../../SearchableSelect';
import { FORM_SELECT_TRIGGER } from '../SettingsPrimitives';

export interface ModelBindingSectionProps {
  readonly manifest: PortableSpaceSubscribePreviewManifest;
  readonly evaluation: SubscriptionSelectionEvaluation;
  readonly bindings: PortableSpaceBindingChoices;
  readonly disabled?: boolean;
  readonly onChangeBindings: (next: PortableSpaceBindingChoices) => void;
}

function buildPickerOptions(
  indices: readonly number[],
  localModelOptions: readonly PortableSpaceLocalModelOption[],
): SearchableSelectOption[] {
  const result: SearchableSelectOption[] = [];
  for (const index of indices) {
    const option = localModelOptions[index];
    if (option === undefined) continue;
    const badges: { label: string }[] = [];
    if (option.defaultThinkingEffort !== undefined) {
      badges.push({ label: option.defaultThinkingEffort });
    }
    result.push({
      value: option.id,
      label: option.label,
      description: option.label !== option.id ? option.id : undefined,
      group: option.providerId,
      badges: badges.length > 0 ? badges : undefined,
      keywords: [option.id, option.label, option.providerId ?? ''].join(' '),
    });
  }
  return result;
}

function normalizeBindingChoices(draft: {
  modelBindings?: Record<string, string>;
  unitModelBindings?: Record<string, string>;
  deferredSlotIds?: string[];
}): PortableSpaceBindingChoices {
  const modelBindings = draft.modelBindings !== undefined && Object.keys(draft.modelBindings).length > 0
    ? draft.modelBindings
    : undefined;
  const unitModelBindings = draft.unitModelBindings !== undefined && Object.keys(draft.unitModelBindings).length > 0
    ? draft.unitModelBindings
    : undefined;
  const deferred = draft.deferredSlotIds !== undefined && draft.deferredSlotIds.length > 0
    ? [...new Set(draft.deferredSlotIds)].sort()
    : undefined;

  return {
    ...(modelBindings !== undefined ? { modelBindings } : {}),
    ...(unitModelBindings !== undefined ? { unitModelBindings } : {}),
    ...(deferred !== undefined ? { unmappedModelPolicy: 'defer' as const, deferredSlotIds: deferred } : {}),
  };
}

export function ModelBindingSection({
  manifest,
  evaluation,
  bindings,
  disabled = false,
  onChangeBindings,
}: ModelBindingSectionProps) {
  const { t, locale } = useI18n();
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());

  const toggleGroupExpand = (sourceModelId: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(sourceModelId)) next.delete(sourceModelId);
      else next.add(sourceModelId);
      return next;
    });
  };

  const setGroupBinding = (group: GroupedBindingSlot, localModelId: string) => {
    const nextModelBindings = { ...(bindings.modelBindings ?? {}) };
    if (localModelId === '') delete nextModelBindings[group.sourceModelId];
    else nextModelBindings[group.sourceModelId] = localModelId;

    const groupTupleKeys = new Set(group.slots.map((entry) => entry.slot.tupleKey));
    const nextUnitBindings = { ...(bindings.unitModelBindings ?? {}) };
    // Choosing a group mapping clears defer on its slots unless a per-unit override stays in place.
    const nextDeferred = (bindings.deferredSlotIds ?? []).filter((key) => !groupTupleKeys.has(key));
    onChangeBindings(normalizeBindingChoices({
      modelBindings: nextModelBindings,
      unitModelBindings: nextUnitBindings,
      deferredSlotIds: nextDeferred,
    }));
  };

  const setGroupDeferred = (group: GroupedBindingSlot, deferred: boolean) => {
    const groupTupleKeys = new Set(group.slots.map((entry) => entry.slot.tupleKey));
    const nextModelBindings = { ...(bindings.modelBindings ?? {}) };
    const nextUnitBindings = { ...(bindings.unitModelBindings ?? {}) };
    const deferredSet = new Set(bindings.deferredSlotIds ?? []);

    if (deferred) {
      delete nextModelBindings[group.sourceModelId];
      for (const key of groupTupleKeys) {
        delete nextUnitBindings[key];
        deferredSet.add(key);
      }
    } else {
      for (const key of groupTupleKeys) {
        deferredSet.delete(key);
      }
    }
    onChangeBindings(normalizeBindingChoices({
      modelBindings: nextModelBindings,
      unitModelBindings: nextUnitBindings,
      deferredSlotIds: [...deferredSet],
    }));
  };

  const setSlotBinding = (entry: EvaluatedBindingSlot, localModelId: string) => {
    const key = entry.slot.tupleKey;
    const nextUnitBindings = { ...(bindings.unitModelBindings ?? {}) };
    if (localModelId === '') delete nextUnitBindings[key];
    else nextUnitBindings[key] = localModelId;
    const nextDeferred = (bindings.deferredSlotIds ?? []).filter((id) => id !== key);
    onChangeBindings(normalizeBindingChoices({
      modelBindings: { ...(bindings.modelBindings ?? {}) },
      unitModelBindings: nextUnitBindings,
      deferredSlotIds: nextDeferred,
    }));
  };

  const setSlotDeferred = (entry: EvaluatedBindingSlot, deferred: boolean) => {
    const key = entry.slot.tupleKey;
    const nextUnitBindings = { ...(bindings.unitModelBindings ?? {}) };
    const deferredSet = new Set(bindings.deferredSlotIds ?? []);
    if (deferred) {
      delete nextUnitBindings[key];
      deferredSet.add(key);
    } else {
      deferredSet.delete(key);
    }
    onChangeBindings(normalizeBindingChoices({
      modelBindings: { ...(bindings.modelBindings ?? {}) },
      unitModelBindings: nextUnitBindings,
      deferredSlotIds: [...deferredSet],
    }));
  };

  const groups = evaluation.groupedActionableSlots;
  const optionCount = manifest.localModelOptions.length;

  const consumersLabel = useMemo(
    () => (group: GroupedBindingSlot) => {
      const preview = group.consumerLabels.slice(0, 2).join(locale === 'zh' ? '、' : ', ');
      if (group.consumerLabels.length <= 2) {
        return t('st.portable.center.bindingConsumers', { names: preview });
      }
      return t('st.portable.center.bindingConsumersMore', { names: preview, count: group.consumerLabels.length });
    },
    [locale, t],
  );

  if (groups.length === 0) return null;

  return (
    <section
      aria-label={t('st.portable.center.bindingHeading')}
      data-portable-model-bindings
      className="space-y-3 border-t border-hairline pt-4"
    >
      <div>
        <h3 className="text-[13.5px] font-medium text-ink">{t('st.portable.center.bindingHeading')}</h3>
        <p className="mt-0.5 text-[12px] text-ink-soft">{t('st.portable.center.bindingSubtitle')}</p>
      </div>

      {optionCount === 0 ? (
        <p className="text-[12px] text-amber-ink" data-portable-no-local-models>
          {t('st.portable.center.bindingNoLocalModels')}
        </p>
      ) : null}

      <ul className="divide-y divide-hairline border-t border-b border-hairline">
        {groups.map((group) => {
          const intersectionOptions = buildPickerOptions(group.intersectionOptionIndices, manifest.localModelOptions);
          const hasPerItemOverride = group.slots.some(
            (entry) => bindings.unitModelBindings?.[entry.slot.tupleKey] !== undefined,
          );
          const hasMixedDefer = !group.allDeferred && group.slots.some((entry) => entry.state === 'deferred');
          const perItemOpen =
            expandedGroups.has(group.sourceModelId)
            || hasPerItemOverride
            || hasMixedDefer
            || (group.intersectionOptionIndices.length === 0 && group.slots.length > 0 && optionCount > 0);
          const groupValue = group.allDeferred ? '' : (group.groupLocalModelId ?? '');
          const invalidEntry = group.slots.find((entry) => entry.state === 'invalid_target');

          return (
            <li
              key={group.sourceModelId}
              data-portable-binding-group={group.sourceModelId}
              className="space-y-2.5 py-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-mono text-[12.5px] font-medium text-ink" data-portable-binding-source>
                      {group.sourceModelId}
                    </span>
                    {group.allDeferred ? (
                      <span
                        data-portable-binding-deferred-badge={group.sourceModelId}
                        className="text-[11.5px] font-medium text-amber-ink"
                      >
                        {t('st.portable.center.bindingUnboundBadge')}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-[12px] text-ink-soft">{consumersLabel(group)}</p>
                  {invalidEntry?.invalidLocalModelId !== undefined ? (
                    <p className="text-[12px] text-danger-ink" data-portable-binding-invalid={group.sourceModelId}>
                      {t('st.portable.center.bindingInvalidTarget', { model: invalidEntry.invalidLocalModelId })}
                    </p>
                  ) : null}
                  {optionCount > 0 && group.intersectionOptionIndices.length === 0 ? (
                    <p className="text-[12px] text-amber-ink">
                      {t('st.portable.center.bindingNoIntersection')}
                    </p>
                  ) : null}
                </div>

                <div className="flex w-full flex-col gap-2 sm:w-64 sm:shrink-0">
                  <ModelPicker
                    value={groupValue}
                    options={intersectionOptions}
                    allowCustomValue={false}
                    allowInherit={false}
                    disabled={disabled || group.allDeferred || intersectionOptions.length === 0}
                    emptyText={t('st.portable.center.bindingChoosePlaceholder')}
                    ariaLabel={`${t('st.portable.center.bindingHeading')}: ${group.sourceModelId}`}
                    buttonClassName={`${FORM_SELECT_TRIGGER} pointer-coarse:min-h-11`}
                    triggerData={{ 'data-portable-binding-group-picker': group.sourceModelId }}
                    onChange={(nextValue) => { setGroupBinding(group, nextValue); }}
                  />
                  <label className="inline-flex min-h-[28px] cursor-pointer items-center gap-2 text-[12px] text-ink-soft pointer-coarse:min-h-11">
                    <input
                      type="checkbox"
                      data-portable-binding-group-defer={group.sourceModelId}
                      checked={group.allDeferred}
                      disabled={disabled}
                      onChange={(event) => { setGroupDeferred(group, event.target.checked); }}
                      className="h-4 w-4 shrink-0 accent-[var(--color-selected-ink)]"
                    />
                    <span>{t('st.portable.center.bindingDeferLabel')}</span>
                  </label>
                </div>
              </div>

              {group.slots.length > 0 ? (
                <div>
                  <button
                    type="button"
                    data-portable-binding-expand={group.sourceModelId}
                    aria-expanded={perItemOpen}
                    onClick={() => { toggleGroupExpand(group.sourceModelId); }}
                    className="inline-flex min-h-[28px] items-center gap-1 text-[12px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
                  >
                    <DisclosureChevron open={perItemOpen} />
                    <span>
                      {perItemOpen
                        ? t('st.portable.center.bindingPerItemHide')
                        : t('st.portable.center.bindingPerItemShow', { count: group.slots.length })}
                    </span>
                  </button>

                  {perItemOpen ? (
                    <ul className="mt-2 space-y-2 border-l border-hairline pl-3" data-portable-binding-slots={group.sourceModelId}>
                      {group.slots.map((entry) => {
                        const slotOptions = buildPickerOptions(entry.slot.eligibleOptionIndices, manifest.localModelOptions);
                        const slotDeferred = entry.state === 'deferred';
                        const unitSelected = bindings.unitModelBindings?.[entry.slot.tupleKey] ?? '';
                        const effectiveDisplayValue = slotDeferred
                          ? ''
                          : unitSelected !== ''
                            ? unitSelected
                            : (entry.state === 'bound_group' ? (entry.resolvedLocalModelId ?? '') : '');
                        return (
                          <li
                            key={entry.slot.tupleKey}
                            data-portable-binding-slot={entry.slot.tupleKey}
                            className="flex flex-wrap items-start justify-between gap-2 py-1"
                          >
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <div className="flex flex-wrap items-baseline gap-x-2">
                                <span className="text-[12.5px] font-medium text-ink">{entry.slot.itemLabel}</span>
                                <span className="text-[11px] text-ink-faint">
                                  {t(PORTABLE_SUBSCRIPTION_SCOPE_LABEL_KEY[entry.slot.itemScope])} · {entry.slot.location}
                                </span>
                              </div>
                              {entry.slot.restrictionNote !== undefined ? (
                                <p className="text-[11.5px] text-amber-ink">{entry.slot.restrictionNote}</p>
                              ) : null}
                              {entry.state === 'invalid_target' && entry.invalidLocalModelId !== undefined ? (
                                <p className="text-[11.5px] text-danger-ink">
                                  {t('st.portable.center.bindingInvalidTarget', { model: entry.invalidLocalModelId })}
                                </p>
                              ) : null}
                            </div>

                            <div className="flex w-full flex-col gap-1.5 sm:w-60 sm:shrink-0">
                              <ModelPicker
                                value={effectiveDisplayValue}
                                options={slotOptions}
                                allowCustomValue={false}
                                allowInherit={false}
                                disabled={disabled || slotDeferred || slotOptions.length === 0}
                                emptyText={t('st.portable.center.bindingChoosePlaceholder')}
                                ariaLabel={`${entry.slot.itemLabel} (${entry.slot.sourceModelId})`}
                                buttonClassName={`${FORM_SELECT_TRIGGER} pointer-coarse:min-h-11`}
                                triggerData={{ 'data-portable-binding-slot-picker': entry.slot.tupleKey }}
                                onChange={(nextValue) => { setSlotBinding(entry, nextValue); }}
                              />
                              <label className="inline-flex min-h-[26px] cursor-pointer items-center gap-2 text-[11.5px] text-ink-soft pointer-coarse:min-h-11">
                                <input
                                  type="checkbox"
                                  data-portable-binding-slot-defer={entry.slot.tupleKey}
                                  checked={slotDeferred}
                                  disabled={disabled}
                                  onChange={(event) => { setSlotDeferred(entry, event.target.checked); }}
                                  className="h-3.5 w-3.5 shrink-0 accent-[var(--color-selected-ink)]"
                                />
                                <span>{t('st.portable.center.bindingDeferItem')}</span>
                              </label>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {evaluation.deferredSlots.length > 0 ? (
        <p className="text-[12px] text-amber-ink" data-portable-deferred-summary>
          {t('st.portable.center.bindingDeferredHint', { count: evaluation.deferredSlots.length })}
        </p>
      ) : null}
    </section>
  );
}
