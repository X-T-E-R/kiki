import type { ModelCatalogItem } from '@kiki/protocol';
import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { INPUT } from '../../ui';
import { EffortPicker, Field, ModelPicker } from './fields';
import type { ModelProfileDraft } from './profileDraft';

/**
 * `model_profiles`: explicit candidates, each with the natural-language
 * condition the dispatcher reads (`when`) and its own effort. Order is kept
 * as written but is not a fallback chain; the hint says so once.
 */
export function ModelProfilesField({ values, onChange, models, disabled }: {
  values: readonly ModelProfileDraft[];
  onChange: (next: ModelProfileDraft[]) => void;
  models: readonly ModelCatalogItem[];
  disabled: boolean;
}) {
  const { t } = useI18n();
  const update = (index: number, patch: Partial<ModelProfileDraft>) =>
    onChange(values.map((entry, at) => at === index ? { ...entry, ...patch } : entry));
  const effortsFor = (alias: string) => models.find((model) => model.id === alias)?.support_efforts;
  return <div className="space-y-2" data-model-profiles-field>
    {values.length > 0 ? <ul className="divide-y divide-hairline rounded-lg border border-hairline">
      {values.map((entry, index) => <li key={index} data-model-profile-row={entry.alias || index} className="space-y-2 px-3 py-2">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_auto] sm:items-end">
          <div className="col-span-2 sm:col-span-1">
            <Field label={t('st.profiles.candidateModel')} htmlFor={`mp-model-${index}`}>
              <ModelPicker id={`mp-model-${index}`} value={entry.alias} models={models} allowInherit={false} disabled={disabled}
                missing={entry.alias !== '' && models.length > 0 && !models.some((model) => model.id === entry.alias)}
                onChange={(alias) => update(index, { alias })} />
            </Field>
          </div>
          <Field label={t('st.profiles.effort')} htmlFor={`mp-effort-${index}`}>
            <EffortPicker id={`mp-effort-${index}`} value={entry.effort} supported={effortsFor(entry.alias)} disabled={disabled}
              onChange={(effort) => update(index, { effort })} />
          </Field>
          <button type="button" disabled={disabled} aria-label={t('st.profiles.removeItem', { item: entry.alias || t('st.profiles.candidateModel') })}
            onClick={() => onChange(values.filter((_, at) => at !== index))}
            className="flex h-11 w-11 items-center justify-center self-end rounded-md text-ink-faint hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 sm:h-9 sm:w-9">
            <Icon name="close" size={12} />
          </button>
        </div>
        <Field label={t('st.profiles.when')} htmlFor={`mp-when-${index}`}>
          <input id={`mp-when-${index}`} className={`${INPUT} text-[12.5px]`} value={entry.when} disabled={disabled}
            placeholder={t('st.profiles.whenPlaceholder')} onChange={(event) => update(index, { when: event.target.value })} />
        </Field>
      </li>)}
    </ul> : <p className="text-[12px] text-ink-faint">{t('st.profiles.modelProfilesEmpty')}</p>}
    <button type="button" disabled={disabled} data-model-profile-add
      onClick={() => onChange([...values, { alias: '', when: '', effort: '' }])}
      className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12.5px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50">
      <Icon name="plus" size={12} />{t('st.profiles.addCandidate')}
    </button>
  </div>;
}
