import { useId, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { FORM_LABEL, SettingsSelect, SettingsSegmented } from './SettingsPrimitives';
import {
  changePromptBranch, newPromptOverrideRow,
  type CognitionDraft, type ModelPromptDraft, type PromptBranchMode, type PromptIdentityDraft, type PromptOverridesDraft,
} from './promptIdentityDraft';

const EDITOR_INPUT = `${INPUT} border-0 bg-ink/[0.035] font-normal focus-visible:ring-2 focus-visible:ring-selected-ink/40`;

export function PromptIdentityEditor<T>({ value, onChange, children, disabled = false, showCommon = true }: {
  value: PromptIdentityDraft<T>;
  onChange: (next: PromptIdentityDraft<T>) => void;
  children: (content: T, onChange: (next: T) => void, label: string) => ReactNode;
  disabled?: boolean;
  showCommon?: boolean;
}) {
  const { t } = useI18n();
  return <fieldset disabled={disabled} className="min-w-0 space-y-5 disabled:opacity-60" data-prompt-identity-editor>
    {showCommon ? <div className="space-y-2" data-prompt-common>
      <p className="text-[12px] font-medium text-ink-soft">{t('st.promptIdentity.common')}</p>
      {children(value.common, (common) => onChange({ ...value, common }), t('st.promptIdentity.common'))}
    </div> : null}
    {(['main', 'independent'] as const).map((position) => {
      const branch = value[position];
      const label = t(`st.promptIdentity.${position}`);
      return <details key={position} data-prompt-position={position} className="group min-w-0">
        <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 rounded py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40">
          <span className="font-medium text-ink-soft">{label}</span>
          <span className="flex min-w-0 items-center gap-1 text-right text-ink-faint">{t(`st.promptIdentity.mode.${branch.mode}`)}<Icon name="chevron" size={12} /></span>
        </summary>
        <div className="space-y-3 pt-2">
          <SettingsSegmented<PromptBranchMode> ariaLabel={label} value={branch.mode} disabled={disabled}
            dataAttr={`data-prompt-branch-${position}`} onChange={(mode) => onChange(changePromptBranch(value, position, mode))}
            choices={(['same', 'off', 'custom'] as const).map((mode) => ({ value: mode, label: t(`st.promptIdentity.mode.${mode}`) }))} />
          {branch.mode === 'same' && branch.explicitSame ? <button type="button" disabled={disabled} data-prompt-clear-explicit={position}
            className="block rounded py-1 text-[12px] text-ink-soft underline decoration-ink/20 underline-offset-4 hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40"
            onClick={() => onChange(changePromptBranch(value, position, 'same'))}>{t('st.promptIdentity.clearExplicitSame')}</button> : null}
          {branch.mode === 'custom' ? <div className="space-y-2" data-prompt-custom={position}>
            <p className="text-[11.5px] leading-5 text-ink-faint">{t('st.promptIdentity.customHint')}</p>
            {children(branch.content, (content) => onChange({ ...value, [position]: { ...branch, content } }), label)}
          </div> : branch.mode === 'off' ? <p className="text-[11.5px] leading-5 text-ink-faint">{t('st.promptIdentity.offHint')}</p> : null}
        </div>
      </details>;
    })}
  </fieldset>;
}

export function PromptOverridesContentEditor({ value, onChange, label }: {
  value: PromptOverridesDraft; onChange: (next: PromptOverridesDraft) => void; label: string;
}) {
  const { t } = useI18n();
  return <div className="min-w-0 space-y-3" data-prompt-overrides-content>
    <label className={FORM_LABEL}>{t('st.prompt.files')}
      <textarea aria-label={`${label}: ${t('st.prompt.files')}`} rows={2} spellCheck={false}
        className={`${EDITOR_INPUT} mt-1 h-auto resize-y font-mono text-[12px] leading-5`} value={value.files}
        placeholder={t('st.promptIdentity.pathsPlaceholder')} onChange={(event) => onChange({ ...value, files: event.target.value })} />
    </label>
    {value.fields.map((row, index) => <div key={row.id} className="space-y-1" data-identity-field-row>
      <div className="flex items-center gap-1">
        <input className={`${EDITOR_INPUT} min-w-0 flex-1 font-mono text-[12px]`} value={row.name}
          aria-label={`${label}: ${t('st.prompt.fieldName')}`} placeholder={t('st.prompt.fieldNamePlaceholder')}
          onChange={(event) => onChange({ ...value, fields: value.fields.map((item, at) => at === index ? { ...item, name: event.target.value } : item) })} />
        <button type="button" className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40"
          aria-label={t('st.prompt.removeField', { name: row.name || String(index + 1) })}
          onClick={() => onChange({ ...value, fields: value.fields.filter((_, at) => at !== index) })}><Icon name="close" size={12} /></button>
      </div>
      <textarea rows={3} className={`${EDITOR_INPUT} h-auto resize-y font-mono text-[12px] leading-5`} value={row.value}
        aria-label={`${label}: ${t('st.prompt.fieldValue')}`} spellCheck={false}
        onChange={(event) => onChange({ ...value, fields: value.fields.map((item, at) => at === index ? { ...item, value: event.target.value } : item) })} />
    </div>)}
    <button type="button" className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5 border-0 focus-visible:ring-2 focus-visible:ring-selected-ink/40`} onClick={() => onChange({ ...value, fields: [...value.fields, newPromptOverrideRow()] })}>
      <Icon name="plus" size={12} />{t('st.prompt.addField')}
    </button>
  </div>;
}

export function CognitionContentEditor({ value, onChange, label }: {
  value: CognitionDraft; onChange: (next: CognitionDraft) => void; label: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const set = <K extends keyof CognitionDraft>(key: K, next: CognitionDraft[K]) => onChange({ ...value, [key]: next });
  const pathField = (key: 'overlay' | 'steering' | 'anchor') => <label className={FORM_LABEL}>
    {t(`st.promptIdentity.${key}`)}
    <textarea rows={2} spellCheck={false} aria-label={`${label}: ${t(`st.promptIdentity.${key}`)}`}
      className={`${EDITOR_INPUT} mt-1 h-auto resize-y font-mono text-[12px] leading-5`} value={value[key]}
      placeholder={t('st.promptIdentity.pathsPlaceholder')} onChange={(event) => set(key, event.target.value)} />
  </label>;
  return <div className="min-w-0 space-y-3" data-cognition-content>
    {pathField('overlay')}
    <div className="space-y-1">
      <p id={`${id}-mode`} className={FORM_LABEL}>{t('st.promptIdentity.overlayMode')}</p>
      <SettingsSelect<CognitionDraft['overlayMode']> value={value.overlayMode} onChange={(next) => set('overlayMode', next)}
        ariaLabel={`${label}: ${t('st.promptIdentity.overlayMode')}`}
        choices={(['', 'append', 'prepend', 'wrap', 'persona', 'replace'] as const).map((mode) => ({ value: mode, label: t(`st.promptIdentity.overlayMode.${mode || 'default'}`) }))} />
    </div>
    <details className="min-w-0" data-cognition-timing>
      <summary className="cursor-pointer py-1 text-[12px] text-ink-soft">{t('st.promptIdentity.timing')}</summary>
      <div className="space-y-3 pt-2">
        {pathField('steering')}
        {pathField('anchor')}
        <div className="grid gap-3 min-[768px]:grid-cols-2">
          <label className={FORM_LABEL}>{t('st.promptIdentity.anchorSteps')}
            <input className={`${EDITOR_INPUT} mt-1 font-mono`} inputMode="numeric" value={value.anchorSteps}
              aria-label={`${label}: ${t('st.promptIdentity.anchorSteps')}`} placeholder="1" onChange={(event) => set('anchorSteps', event.target.value)} />
          </label>
          <div className="space-y-1">
            <p className={FORM_LABEL}>{t('st.promptIdentity.anchorScope')}</p>
            <SettingsSelect<CognitionDraft['anchorScope']> value={value.anchorScope} onChange={(next) => set('anchorScope', next)}
              ariaLabel={`${label}: ${t('st.promptIdentity.anchorScope')}`}
              choices={(['', 'session', 'turn'] as const).map((scope) => ({ value: scope, label: t(`st.promptIdentity.anchorScope.${scope || 'default'}`) }))} />
          </div>
        </div>
      </div>
    </details>
  </div>;
}

export function ModelPromptContentEditor({ value, onChange, label }: {
  value: ModelPromptDraft; onChange: (next: ModelPromptDraft) => void; label: string;
}) {
  const { t } = useI18n();
  return <div className="min-w-0 space-y-2" data-model-prompt-content>
    <SettingsSelect<ModelPromptDraft['mode']> value={value.mode} onChange={(mode) => onChange({ mode, prompt: mode === '' ? '' : value.prompt })}
      ariaLabel={`${label}: ${t('st.promptIdentity.bodyMode')}`}
      choices={(['', 'append', 'prepend', 'wrap'] as const).map((mode) => ({ value: mode, label: t(mode === '' ? 'st.promptIdentity.noBody' : `st.promptIdentity.overlayMode.${mode}`) }))} />
    <textarea rows={4} spellCheck={false} className={`${EDITOR_INPUT} h-auto resize-y font-mono text-[12px] leading-5`}
      aria-label={`${label}: ${t('st.promptIdentity.body')}`} value={value.prompt}
      onChange={(event) => onChange({ prompt: event.target.value, mode: value.mode || 'append' })} />
  </div>;
}
