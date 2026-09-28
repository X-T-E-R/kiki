import { useI18n } from '../../i18n';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { useDirtyReporter } from '../dirtyGuard';
import { SearchableSelect } from '../SearchableSelect';

/**
 * One editor, one independent save/discard transaction. The bar belongs to the
 * block above it: no rule of its own, 12px under the last field, buttons in a
 * fixed order (Save · Discard · status). `extra` takes reset-style actions,
 * which sit at the far end so they are never the thing clicked by habit.
 */
export function SettingsDraftFooter({ id, dirty, saving = false, saveDisabled = false, saveLabel, onSave, onDiscard, restartRequired = false, extra, persistent = false }: {
  id: string;
  dirty: boolean;
  saving?: boolean;
  saveDisabled?: boolean;
  saveLabel?: string;
  onSave: () => void;
  onDiscard: () => void;
  restartRequired?: boolean;
  extra?: React.ReactNode;
  /** Creation forms keep their commit button in view even before an edit. */
  persistent?: boolean;
}) {
  const { t } = useI18n();
  useDirtyReporter(id, dirty);
  // Clean → the bar is not there (a row of disabled buttons is noise); it
  // appears with the first edit. `hidden` keeps the nodes mounted, so focus
  // order and tests see one stable bar.
  const shown = persistent || dirty || saving || restartRequired;
  return <div data-settings-draft={id} data-dirty={dirty ? 'true' : undefined} hidden={!shown}
    className={`flex flex-wrap items-center gap-2 pt-3 ${shown ? 'anim-enter' : ''}`}>
    <button type="button" className={PRIMARY_BUTTON} disabled={!dirty || saving || saveDisabled} onClick={onSave}>
      {saving ? t('common.saving') : saveLabel ?? t('common.save')}
    </button>
    <button type="button" className={SECONDARY_BUTTON} disabled={!dirty || saving} onClick={onDiscard}>
      {t('st.advanced.discard')}
    </button>
    {dirty ? <span role="status" className="text-[12px] text-ink-faint">{t('st.tools.unsaved')}</span> : null}
    {restartRequired ? <span className="text-[12px] text-ink-soft">{t('st.badge.restartRequired')}</span> : null}
    {extra !== undefined ? <span className="ml-auto flex items-center gap-2">{extra}</span> : null}
  </div>;
}

export function SettingsDiagnosticRow({ label, value }: { label: string; value: string | number | boolean }) {
  return <div className="flex items-baseline justify-between gap-4 py-1 text-[13px]">
    <dt className="text-ink-soft">{label}</dt>
    <dd className="min-w-0 break-all text-right text-ink">{typeof value === 'boolean' ? String(value) : value}</dd>
  </div>;
}

/**
 * List → detail console. Side by side from `md`; below that only one pane is
 * shown at a time (`narrowPane`), so a tap on a row opens the detail instead
 * of dropping it under a long list.
 */
export function SettingsDetailLayout({ list, detail, narrowPane = 'list' }: {
  list: React.ReactNode;
  detail: React.ReactNode;
  narrowPane?: 'list' | 'detail';
}) {
  return <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(168px,0.75fr)_minmax(0,1.7fr)]" data-settings-list-detail data-narrow-pane={narrowPane}>
    <div className={`min-w-0 ${narrowPane === 'detail' ? 'max-md:hidden' : ''}`}>{list}</div>
    <div className={`min-w-0 md:border-l md:border-hairline md:pl-6 ${narrowPane === 'list' ? 'max-md:hidden' : ''}`}>{detail}</div>
  </div>;
}

/**
 * Stacked form label (label above its input): T5, 12px/500 ink-soft — the
 * same step as the memory and task-board editors. Row settings use
 * `SettingField` (T3/400) instead.
 */
export const FORM_LABEL = 'block text-[12px] font-medium text-ink-soft';

/** A SearchableSelect trigger that sits in a form grid next to `INPUT` fields. */
export const FORM_SELECT_TRIGGER =
  'flex w-full min-w-0 items-center justify-between gap-1.5 rounded-lg border border-hairline bg-paper px-2.5 py-2 text-left text-[12px] text-ink outline-none transition-colors hover:border-hairline-strong focus-visible:border-accent disabled:cursor-not-allowed disabled:bg-hairline/20 disabled:text-ink-faint';

/** The error line that belongs to one field; pair with `aria-describedby`. */
export function FieldIssue({ id, text }: { id: string; text: string | null }) {
  if (text === null) return null;
  return <p id={id} role="alert" data-field-issue className="mt-1 text-[12px] leading-4 text-danger">{text}</p>;
}

/** One trigger height for every settings picker, matching `SettingsSegmented`. */
export const SETTINGS_SELECT_TRIGGER =
  'flex h-8 max-w-full items-center gap-1.5 rounded-md bg-ink/[0.04] px-2.5 text-[13px] text-ink outline-none transition-colors hover:bg-ink/[0.07] disabled:cursor-not-allowed disabled:text-ink-faint';

export interface SettingsChoice<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Tint the selected state as a warning (e.g. Full access). */
  readonly caution?: boolean;
  readonly disabled?: boolean;
}

/**
 * Segmented single choice for 2–4 short options. The selected segment is a
 * raised paper chip, not an orange outline, so a row of them stays calm; the
 * buttons keep `aria-pressed` so tests and assistive tech read the state.
 */
export function SettingsSegmented<T extends string>({ choices, value, onChange, disabled = false, ariaLabel, ariaLabelledBy, dataAttr }: {
  choices: readonly SettingsChoice<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /** Per-button data attribute name (e.g. `data-theme-choice`) carrying the value. */
  dataAttr?: string;
}) {
  return <div role="group" aria-label={ariaLabel} aria-labelledby={ariaLabelledBy}
    className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-md bg-ink/[0.04] p-0.5">
    {choices.map((choice) => {
      const selected = choice.value === value;
      return <button key={choice.value} type="button" aria-pressed={selected}
        disabled={disabled || choice.disabled === true}
        {...(dataAttr !== undefined ? { [dataAttr]: choice.value } : {})}
        onClick={() => { if (!selected) onChange(choice.value); }}
        className={`h-7 rounded-[5px] px-2.5 text-[13px] transition-colors disabled:cursor-not-allowed disabled:text-ink-faint ${
          selected
            ? choice.caution === true
              ? 'bg-amber-card font-medium text-amber-ink shadow-[var(--kiki-sheet-shadow)]'
              : 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
            : 'text-ink-soft hover:text-ink'
        }`}>
        {choice.label}
      </button>;
    })}
  </div>;
}

/**
 * Short fixed-option dropdown on the shared SearchableSelect popover (the
 * composer's picker look). The filter row only appears for long lists.
 */
export function SettingsSelect<T extends string>({ id, choices, value, onChange, ariaLabel, disabled, className }: {
  id?: string;
  choices: readonly { value: T; label: string; hint?: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  return <SearchableSelect id={id} options={choices} value={value} ariaLabel={ariaLabel} disabled={disabled}
    hideFilter={choices.length <= 8} onChange={(next) => { onChange(next as T); }}
    buttonClassName={`${SETTINGS_SELECT_TRIGGER} ${className ?? ''}`} />;
}
