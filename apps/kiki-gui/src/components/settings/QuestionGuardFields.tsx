/**
 * The AskUserQuestion frequency guard, rendered.
 *
 * One control serves both layers. The global card and a model row differ in
 * exactly two things — whether the switch offers a third "inherit" position,
 * and whether a number the model leaves empty says where its value comes from
 * — so they share this fieldset rather than maintaining two copies that would
 * drift apart on the first copy fix.
 *
 * The shape follows the page's own grammar. The switch is a `Toggle` row
 * because it is the decision that makes the rest mean anything, the numbers
 * are `SettingField` rows that each commit on their own, and the thresholds
 * sit behind `DependentField`, so a guard that is off shows a switch and a
 * sentence rather than four live boxes that quietly do nothing.
 *
 * Thresholds show while the guard is *effectively* on, not while the draft
 * says so. A model inheriting an enabled global layer is already subject to it,
 * and hiding its numbers until it set its own would hide the rules it is
 * actually living under. The window is edited in minutes and stored in
 * milliseconds; that conversion is the adapter's, and this file never sees ms.
 */

import { useI18n } from '../../i18n';
import { SaveStatus, Toggle } from '../controls';
import { DependentField, SettingField } from './fields';
import { CommitInput, SettingsSelect } from './SettingsPrimitives';
import {
  GUARD_NUMBER_FIELDS,
  guardDisplayValue,
  guardNumberValue,
  type GuardEnabledChoice,
  type GuardInheritedValue,
  type GuardNumberField,
  type QuestionGuardDraft,
} from './questionGuardDraft';

/** The bounds sentence, in the field's own unit. */
function rangeTextFor(t: ReturnType<typeof useI18n>['t'], field: GuardNumberField): string {
  return t(field.minutes ? 'st.questionGuard.windowRange' : 'st.questionGuard.range', { min: field.min, max: field.max });
}

/**
 * One threshold. On a model row an empty box is a real state, so it carries the
 * value it is actually getting and a control to hand the field back; on the
 * global card a box always holds a value and needs neither.
 */
function GuardNumberRow({ field, draft, inherited, disabled, saving, onCommit, onClear }: {
  field: GuardNumberField;
  draft: QuestionGuardDraft;
  /** Only on a model row: what an empty box is currently getting. */
  inherited?: (field: GuardNumberField) => GuardInheritedValue | undefined;
  disabled?: boolean;
  saving?: boolean;
  onCommit: (field: GuardNumberField, text: string) => void;
  onClear?: (field: GuardNumberField) => void;
}) {
  const { t } = useI18n();
  const source = inherited?.(field);
  const own = draft[field.draftKey].trim() !== '';
  return (
    <SettingField label={t(field.label)} help={source === undefined ? t(field.help) : undefined}>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <CommitInput
          className="w-20"
          inputMode={field.minutes ? 'decimal' : 'numeric'}
          ariaLabel={t(field.label)}
          dataAttr={`data-question-guard-${field.wire.replaceAll('_', '-')}`}
          value={guardDisplayValue(field, draft[field.draftKey])}
          placeholder={source?.text}
          disabled={disabled}
          validate={(text) => (text.trim() === '' || guardNumberValue(field, text) !== undefined ? null : rangeTextFor(t, field))}
          onCommit={(text) => { onCommit(field, text); }}
        />
        {field.minutes ? <span className="text-[12px] text-ink-faint">{t('st.questionGuard.minutesUnit')}</span> : null}
        {onClear !== undefined && own ? (
          <button
            type="button"
            className="rounded px-1 py-0.5 text-[12px] text-ink-soft underline decoration-dotted underline-offset-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-60"
            disabled={disabled || saving}
            data-question-guard-clear={field.wire}
            onClick={() => { onClear(field); }}
          >{t('st.questionGuard.useInherited')}</button>
        ) : null}
        {source !== undefined ? (
          <p className="text-[12px] leading-snug text-ink-faint" data-question-guard-inherited={field.wire}>
            {source.source === 'global'
              ? t('st.questionGuard.fromGlobal', { value: source.text })
              : t('st.questionGuard.fromDefault', { value: source.text })}
          </p>
        ) : null}
      </div>
    </SettingField>
  );
}

/**
 * The guard as a whole.
 *
 * `scope="model"` adds the third switch position and the provenance line; the
 * global card passes `scope="global"` and gets a two-way switch with no
 * fallback text, because a global field with nothing above it always holds a
 * concrete value.
 */
export function QuestionGuardFields({ scope, draft, enabled, disabled = false, saving = false, saved = false, inherited, onEnabledChange, onNumberCommit, onNumberClear }: {
  scope: 'global' | 'model';
  draft: QuestionGuardDraft;
  /** The guard's effective on/off, which is not always the draft's own choice. */
  enabled: boolean;
  disabled?: boolean;
  saving?: boolean;
  saved?: boolean;
  inherited?: (field: GuardNumberField) => GuardInheritedValue | undefined;
  onEnabledChange: (choice: GuardEnabledChoice) => void;
  onNumberCommit: (field: GuardNumberField, text: string) => void;
  onNumberClear?: (field: GuardNumberField) => void;
}) {
  const { t } = useI18n();
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-1 disabled:opacity-60" data-question-guard={scope}>
      <SettingField
        label={t('st.questionGuard.enableLabel')}
        help={t('st.questionGuard.enableHelp')}
        detail={t('st.questionGuard.enableDetail')}
      >
        <SaveStatus saving={saving} saved={saved} />
        {scope === 'model'
          ? <SettingsSelect<GuardEnabledChoice>
            ariaLabel={t('st.questionGuard.enableLabel')}
            dataAttr="data-question-guard-enabled"
            value={draft.enabled}
            disabled={disabled}
            onChange={onEnabledChange}
            choices={[
              { value: 'inherit', label: t('st.questionGuard.inherit') },
              { value: 'on', label: t('st.questionGuard.on') },
              { value: 'off', label: t('st.questionGuard.off') },
            ]}
          />
          : <Toggle
            id={`question-guard-enabled-${scope}`}
            layout="bare"
            label={t('st.questionGuard.enableLabel')}
            checked={enabled}
            disabled={disabled || saving}
            onChange={(checked) => { onEnabledChange(checked ? 'on' : 'off'); }}
          />}
      </SettingField>
      <DependentField when={enabled}>
        <div className="space-y-0.5">
          {GUARD_NUMBER_FIELDS.map((field) => (
            <GuardNumberRow
              key={field.key}
              field={field}
              draft={draft}
              disabled={disabled}
              saving={saving}
              inherited={inherited}
              onCommit={onNumberCommit}
              onClear={onNumberClear}
            />
          ))}
        </div>
      </DependentField>
    </fieldset>
  );
}

export type { GuardEnabledChoice, GuardNumberField, QuestionGuardDraft };
export { rangeTextFor };
