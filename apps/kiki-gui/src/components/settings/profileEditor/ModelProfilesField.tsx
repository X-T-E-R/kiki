import type { ModelCatalogItem } from '@kiki/protocol';
import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { INPUT } from '../../ui';
import { EffortPicker, ModelPicker } from './fields';
import type { ModelProfileDraft } from './profileDraft';
import { ModelPromptContentEditor, PromptIdentityEditor, PromptOverridesContentEditor } from '../PromptIdentityEditor';
import { modelPromptBody, modelPromptDraft, modelPromptProblem, promptIdentityDraft, promptIdentityProblem, promptOverridesBody, promptOverridesDraft, promptOverridesProblem } from '../promptIdentityDraft';

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
      {values.map((entry, index) => <li key={index} data-model-profile-row={entry.alias || index} className="min-w-0 space-y-2 px-3 py-3">
        <div className="grid grid-cols-[minmax(0,1fr)_7rem_auto] items-center gap-2">
          <ModelPicker id={`mp-model-${index}`} value={entry.alias} models={models} allowInherit={false} disabled={disabled}
            ariaLabel={t('st.profiles.candidateModel')}
            missing={entry.alias !== '' && models.length > 0 && !models.some((model) => model.id === entry.alias)}
            onChange={(alias) => update(index, { alias })} />
          <EffortPicker id={`mp-effort-${index}`} value={entry.effort} supported={effortsFor(entry.alias)} disabled={disabled}
            onChange={(effort) => update(index, { effort })} />
          <button type="button" disabled={disabled} aria-label={t('st.profiles.removeItem', { item: entry.alias || t('st.profiles.candidateModel') })}
            onClick={() => onChange(values.filter((_, at) => at !== index))}
            className="flex h-9 w-9 items-center justify-center rounded-md text-ink-faint hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50">
            <Icon name="close" size={12} />
          </button>
        </div>
        <input id={`mp-when-${index}`} aria-label={t('st.profiles.when')} className={`${INPUT} text-[12.5px]`} value={entry.when} disabled={disabled}
          placeholder={t('st.profiles.whenPlaceholder')} onChange={(event) => update(index, { when: event.target.value })} />
        <details data-model-profile-prompts>
          <summary className="cursor-pointer py-1 text-[12px] text-ink-soft">{t('st.promptIdentity.bodyTitle')}</summary>
          <div className="pt-3">
            <PromptIdentityEditor value={entry.modelPrompt ?? promptIdentityDraft(undefined, modelPromptDraft)} disabled={disabled}
              onChange={(modelPrompt) => update(index, { modelPrompt })}>
              {(content, onChange, label) => <ModelPromptContentEditor value={content} onChange={onChange} label={label} />}
            </PromptIdentityEditor>
            {entry.modelPrompt !== undefined ? <PromptProblem problem={promptIdentityProblem(entry.modelPrompt, modelPromptBody, modelPromptProblem)} /> : null}
          </div>
        </details>
        <details data-model-profile-overrides>
          <summary className="cursor-pointer py-1 text-[12px] text-ink-soft">{t('st.promptIdentity.fieldsTitle')}</summary>
          <div className="pt-3">
            <PromptIdentityEditor value={entry.promptOverrides ?? promptIdentityDraft(undefined, promptOverridesDraft)} disabled={disabled}
              onChange={(promptOverrides) => update(index, { promptOverrides })}>
              {(content, onChange, label) => <PromptOverridesContentEditor value={content} onChange={onChange} label={label} />}
            </PromptIdentityEditor>
            {entry.promptOverrides !== undefined ? <PromptProblem problem={promptIdentityProblem(entry.promptOverrides, promptOverridesBody, promptOverridesProblem)} /> : null}
          </div>
        </details>
      </li>)}
    </ul> : <p className="text-[12px] text-ink-faint">{t('st.profiles.modelProfilesEmpty')}</p>}
    <button type="button" disabled={disabled} data-model-profile-add
      onClick={() => onChange([...values, { alias: '', when: '', effort: '' }])}
      className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12.5px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50">
      <Icon name="plus" size={12} />{t('st.profiles.addCandidate')}
    </button>
  </div>;
}

function PromptProblem({ problem }: { problem?: import('../promptIdentityDraft').PromptDraftProblem }) {
  const { t } = useI18n();
  return problem === undefined ? null : <p role="alert" className="pt-2 text-[12px] leading-5 text-danger">{t(`st.promptIdentity.problem.${problem}`)}</p>;
}
