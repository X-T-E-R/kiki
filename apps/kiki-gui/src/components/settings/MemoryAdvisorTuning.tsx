/**
 * Memory advisor engine tuning: the pick mode, whether sub-agents inherit it,
 * the eight timing/budget numbers, and the saved destination. Rendered as the
 * 高级 fold inside the memory page's advisor card (AdvancedDetails), so the
 * page keeps one card per subject.
 */

import { useState } from 'react';

import type { MemorySettingsPatch } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import {
  MEMORY_ADVISOR_DEFAULTS,
  MEMORY_ADVISOR_NUMBER_FIELDS,
  MEMORY_ADVISOR_RANGES,
  parseMemoryAdvisorNumber,
  type MemoryAdvisorNumberField,
} from '@kiki/session-core/settings';

/** The unit that sits right of each number input, read from the field's wire name. */
const FIELD_UNIT: Readonly<Record<MemoryAdvisorNumberField, 'ms' | 'tokens' | 'chars' | undefined>> = {
  first_step_wait_ms: 'ms',
  timeout_ms: 'ms',
  max_calls_per_turn: undefined,
  max_full_units: undefined,
  judge_input_tokens: 'tokens',
  candidate_chars: 'chars',
  catalog_page_items: undefined,
  max_catalog_pages: undefined,
};

import { useI18n } from '../../i18n';
import { FeedbackLine, SaveStatus, Toggle, type Feedback } from '../controls';
import type { useMemoryAdvisor } from '../memory/useMemoryAdvisor';
import { MemoryAdvisorRuntime } from './MemoryAdvisorRuntime';
import { SettingField } from './fields';
import { CommitInput, SettingsSegmented } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

type WriteSlot = 'mode' | 'children' | MemoryAdvisorNumberField;

export function MemoryAdvisorTuning({ workspaceId, advisor }: {
  readonly workspaceId?: string;
  readonly advisor: ReturnType<typeof useMemoryAdvisor>;
}) {
  const { t, locale } = useI18n();
  const [saved, ping] = useSavedTick();
  const [slot, setSlot] = useState<WriteSlot | undefined>();

  const config = advisor.data?.advisor;
  const status = advisor.data?.advisor_status;
  const destination = status?.destination;
  const write = (next: WriteSlot, patch: MemorySettingsPatch): void => {
    if (advisor.save.isPending) return;
    setSlot(next);
    void advisor.save.mutateAsync(patch).then(() => { ping(); }, () => undefined);
  };
  const statusFor = (key: WriteSlot) => (slot === key ? <SaveStatus saving={advisor.save.isPending} saved={saved && !advisor.save.isError} /> : null);
  const busy = advisor.query.isPending || advisor.save.isPending;
  const pairScore = (status?.source_status?.protocol ?? config?.selector?.protocol) === 'pair_score';
  const feedback: Feedback = advisor.query.isError
    ? { tone: 'error', text: t('memory.advisor.loadFailed', { detail: errorText(locale, advisor.query.error) }) }
    : advisor.save.isError
      ? { tone: 'error', text: t('memory.advisor.saveFailed', { detail: errorText(locale, advisor.save.error) }) }
      : null;

  return (
    <div className="min-w-0 space-y-1 text-[13px] text-ink" data-memory-advisor-tuning>
      <SettingField label={t('memory.advisor.mode')} labelId="memory-advisor-mode-label"
        help={t(config?.mode === 'select' ? 'memory.advisor.modeHint.select' : 'memory.advisor.modeHint.rank')}>
        {statusFor('mode')}
        <SettingsSegmented<'rank' | 'select'> ariaLabelledBy="memory-advisor-mode-label" dataAttr="data-memory-advisor-mode"
          value={config?.mode === 'select' ? 'select' : 'rank'} disabled={busy}
          onChange={(mode) => { write('mode', { advisor: { mode } }); }}
          choices={[
            { value: 'rank', label: t('memory.advisor.mode.rank') },
            { value: 'select', label: t('memory.advisor.mode.select'), disabled: pairScore },
          ]} />
      </SettingField>
      <SettingField label={t('memory.advisor.children')} htmlFor="memory-advisor-children" help={t('memory.advisor.childrenHint')}>
        {statusFor('children')}
        <Toggle id="memory-advisor-children" layout="bare" label={t('memory.advisor.children')}
          checked={config?.apply_to_children ?? MEMORY_ADVISOR_DEFAULTS.apply_to_children} disabled={busy}
          onChange={(apply_to_children) => { write('children', { advisor: { apply_to_children } }); }} />
      </SettingField>
      {MEMORY_ADVISOR_NUMBER_FIELDS.map((field) => {
        const range = MEMORY_ADVISOR_RANGES[field];
        const unit = FIELD_UNIT[field];
        return (
          <SettingField key={field} label={t(`memory.advisor.field.${field}` as I18nKey)} htmlFor={`memory-advisor-${field}`}
            detail={t('memory.advisor.fieldDefault', { value: range.fallback })}>
            {statusFor(field)}
            <div className="flex items-center gap-1.5">
              <CommitInput id={`memory-advisor-${field}`} dataAttr={`data-memory-advisor-${field.replaceAll('_', '-')}`}
                className="w-24 text-right" inputMode="numeric" disabled={busy}
                value={String(config?.[field] ?? range.fallback)}
                validate={(text) => (parseMemoryAdvisorNumber(field, text) === null ? t('memory.advisor.fieldInvalid', { min: range.min, max: range.max }) : null)}
                onCommit={(text) => { write(field, { advisor: { [field]: Number(text) } }); }} />
              {unit !== undefined ? <span className="text-[12px] text-ink-faint">{t(`st.residency.${unit === 'ms' ? 'msUnit' : unit === 'tokens' ? 'tokensUnit' : 'charsUnit'}` as I18nKey)}</span> : null}
            </div>
          </SettingField>
        );
      })}
      {destination !== undefined ? (
        <dl data-memory-advisor-destination-row className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 py-1 text-[13px]">
          <dt className="text-ink-soft">{t('memory.advisor.destination')}</dt>
          <dd data-memory-advisor-destination className="min-w-0 break-all font-mono text-[12px] text-ink">{destination}</dd>
        </dl>
      ) : null}
      <MemoryAdvisorRuntime workspaceId={workspaceId} config={config} />
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
