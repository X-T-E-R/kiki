import { useId, type ReactNode } from 'react';

import type { ModelCatalogItem } from '@kiki/protocol';
import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { buildCatalogModelOptions } from '../../modelSelectOptions';
import { SearchableSelect, type SearchableSelectOption } from '../../SearchableSelect';
import { FORM_SELECT_TRIGGER } from '../SettingsPrimitives';
import type { NamedAgentExecutorField } from '@kiki/protocol';
import { EFFORTS, effortLabel } from './profileDraft';

/** Stacked field: label (12/500), control, optional hint and applicability note. */
export function Field({ label, htmlFor, hint, children, applicability, engine, dataField }: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  /** How the profile's engine treats this field (reserved data; absent = applies). */
  applicability?: NamedAgentExecutorField;
  engine?: string;
  dataField?: string;
}) {
  const { t } = useI18n();
  const ignored = applicability?.state === 'ignored';
  return <div className={`min-w-0 space-y-1.5 ${ignored ? 'opacity-70' : ''}`} data-profile-field={dataField}
    data-field-applicability={applicability?.state}>
    <label htmlFor={htmlFor} className="block text-[12px] font-medium text-ink-soft">{label}</label>
    {children}
    {ignored ? <p className="text-[11.5px] leading-snug text-ink-faint">{applicability.reason ?? t('st.profiles.fieldIgnored', { engine: engine ?? '' })}</p> : null}
    {applicability?.state === 'mapped' ? <p className="text-[11.5px] leading-snug text-ink-faint">{applicability.reason ?? t('st.profiles.fieldMapped', { engine: engine ?? '' })}</p> : null}
    {hint !== undefined && !ignored ? <div className="text-[11.5px] leading-snug text-ink-faint">{hint}</div> : null}
  </div>;
}

export function modelOptions(
  models: readonly ModelCatalogItem[],
  t: ReturnType<typeof useI18n>['t'],
  { allowInherit, unsetLabel }: { allowInherit: boolean; unsetLabel?: string },
): SearchableSelectOption[] {
  return [
    ...(unsetLabel === undefined ? [] : [{ value: '', label: unsetLabel }]),
    ...(allowInherit ? [{ value: 'inherit', label: t('st.namedAgents.followCallerModel'), description: t('st.namedAgents.followCallerModelHint') }] : []),
    ...buildCatalogModelOptions(models, t),
  ];
}

/** One model alias. Custom values are allowed: external engines use their own ids. */
export function ModelPicker({ id, value, onChange, models, allowInherit, disabled, missing, unsetLabel, unsetTrigger, ariaLabel }: {
  id: string; value: string; onChange: (value: string) => void; models: readonly ModelCatalogItem[];
  allowInherit: boolean; disabled?: boolean; missing?: boolean;
  /** Label for the empty value (e.g. what a lease falls back to). */
  unsetLabel?: string;
  /** Trigger content while unset (the inherited value, muted). */
  unsetTrigger?: ReactNode;
  ariaLabel?: string;
}) {
  const { t } = useI18n();
  // The trigger shows the alias as written in the file, like the team table.
  return <SearchableSelect id={id} value={value} disabled={disabled} allowCustomValue
    triggerLabel={value !== '' && value !== 'inherit' ? value : value === '' ? unsetTrigger : undefined}
    options={modelOptions(models, t, { allowInherit, unsetLabel: unsetLabel ?? t('st.profiles.modelUnset') })}
    ariaLabel={ariaLabel ?? t('st.profiles.model')} searchPlaceholder="provider/model"
    triggerSuffix={missing === true ? <span data-alias-missing className="shrink-0 text-[11px] text-amber-ink">{t('st.profiles.aliasMissingShort')}</span> : undefined}
    buttonClassName={`${FORM_SELECT_TRIGGER} font-mono ${missing === true ? 'border-amber-ink/50' : ''}`}
    onChange={onChange} />;
}

export function EffortPicker({ id, value, onChange, supported, disabled, allowUnset = true, unsetLabel, unsetTrigger, ariaLabel }: {
  id: string; value: string; onChange: (value: string) => void; supported?: readonly string[];
  disabled?: boolean; allowUnset?: boolean; unsetLabel?: string; unsetTrigger?: ReactNode; ariaLabel?: string;
}) {
  const { t } = useI18n();
  const levels = supported !== undefined && supported.length > 0 ? supported : EFFORTS;
  const choices = [...(allowUnset ? [{ value: '', label: unsetLabel ?? t('st.profiles.effortUnset') }] : []),
    ...levels.map((level) => ({ value: level, label: effortLabel(level) })),
    ...(value !== '' && !levels.includes(value) ? [{ value, label: effortLabel(value), hint: t('st.profiles.effortUnsupported') }] : [])];
  return <SearchableSelect id={id} value={value} disabled={disabled} options={choices} hideFilter
    triggerLabel={value === '' ? unsetTrigger : undefined}
    ariaLabel={ariaLabel ?? t('st.profiles.effort')} buttonClassName={FORM_SELECT_TRIGGER} onChange={onChange} />;
}

/**
 * An ordered set of model aliases as removable chips plus an add picker.
 * Aliases the catalog does not list are marked, not refused.
 */
export function AliasChips({ id, values, onChange, models, disabled, addLabel }: {
  id: string; values: readonly string[]; onChange: (next: string[]) => void; models: readonly ModelCatalogItem[];
  disabled?: boolean; addLabel: string;
}) {
  const { t } = useI18n();
  const known = new Set(models.map((model) => model.id));
  const options = buildCatalogModelOptions(models.filter((model) => !values.includes(model.id)), t);
  return <div className="flex flex-wrap items-center gap-1.5" data-alias-chips={id}>
    {values.map((alias) => {
      const missing = models.length > 0 && !known.has(alias) && alias !== '*';
      return <span key={alias} data-alias-chip={alias} data-alias-missing={missing ? 'true' : undefined}
        title={missing ? t('st.profiles.aliasMissingTitle', { alias }) : alias}
        className={`inline-flex h-7 max-w-full items-center gap-1 rounded-md border pl-2 pr-0.5 font-mono text-[11.5px] ${missing ? 'border-amber-ink/40 text-amber-ink' : 'border-hairline text-ink'}`}>
        {missing ? <Icon name="warning" size={12} /> : null}
        <span className="min-w-0 truncate">{alias}</span>
        <button type="button" disabled={disabled} aria-label={t('st.profiles.removeItem', { item: alias })}
          onClick={() => onChange(values.filter((value) => value !== alias))}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-ink/[0.06] hover:text-ink disabled:opacity-50">
          <Icon name="close" size={12} />
        </button>
      </span>;
    })}
    <SearchableSelect id={`${id}-add`} value="" options={options} allowCustomValue disabled={disabled}
      ariaLabel={addLabel} searchPlaceholder="provider/model" hideChevron
      triggerLabel={<span className="inline-flex items-center gap-1"><Icon name="plus" size={12} />{addLabel}</span>}
      buttonClassName="inline-flex h-7 items-center rounded-md px-2 text-[12px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50"
      onChange={(next) => { const alias = next.trim(); if (alias !== '' && !values.includes(alias)) onChange([...values, alias]); }} />
  </div>;
}

/** Collapsible editor section; the summary line says what is set without opening it. */
export function Section({ title, summary, defaultOpen = false, children, dataSection, count }: {
  title: string; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode; dataSection: string; count?: number;
}) {
  const id = useId();
  return <details open={defaultOpen} data-profile-section={dataSection}
    className="group border-t border-hairline [&[open]>summary_[data-chevron]]:rotate-90">
    <summary aria-controls={id} className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-2 outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/50 [&::-webkit-details-marker]:hidden">
      <span data-chevron className="flex shrink-0 text-ink-faint transition-transform duration-150 motion-reduce:transition-none"><Icon name="chevron" size={12} /></span>
      <span className="text-[13px] font-medium text-ink">{title}</span>
      {count !== undefined && count > 0 ? <span className="rounded-[4px] bg-ink/[0.05] px-1.5 text-[11px] tabular-nums text-ink-soft">{count}</span> : null}
      {summary !== undefined ? <span className="ml-auto min-w-0 truncate text-[12px] text-ink-faint">{summary}</span> : null}
    </summary>
    <div id={id} className="space-y-4 pb-4 pl-5">{children}</div>
  </details>;
}
