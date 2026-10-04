import { modelCognitionSchema, modelPromptOverridesSchema, type ModelEntity, type PatchModelRequest } from '@kiki/protocol';
import { LocalizedError } from '@kiki/session-core/i18n';
import { CognitionContentEditor, PromptIdentityEditor, PromptOverridesContentEditor } from './PromptIdentityEditor';
import {
  cognitionBody, cognitionDraft, cognitionProblem, promptOverridesBody, promptOverridesDraft, promptOverridesProblem,
  promptIdentityProblem, promptTableDraft, promptTableText, updatePromptTable,
  type CognitionDraft, type PromptOverridesDraft, type PromptTableDraft,
} from './promptIdentityDraft';

import { useI18n } from '../../i18n';
import { ChipSelect } from '../ChipSelect';
import { Hint } from '../controls';
import { INPUT } from '../ui';
import { FORM_LABEL, SettingsSelect } from './SettingsPrimitives';

/**
 * Per-model engine fields that live in `[models.<alias>]` but not in the
 * shared provider model draft: aliases, input/output ceilings, the context
 * budget, thinking wire details and the structured tables. Text-shaped
 * fields are edited as text and parsed only on save, so a half-typed JSON
 * table never blocks the rest of the row.
 */
export interface ModelEngineDraft {
  aliases: string[];
  maxInputSize: string;
  maxOutputSize: string;
  contextBudget: string;
  offEffort: string;
  reasoningKey: string;
  adaptiveThinking: 'inherit' | 'on' | 'off';
  requestParams: string;
  cognition: PromptTableDraft<CognitionDraft>;
  promptOverrides: PromptTableDraft<PromptOverridesDraft>;
  overrides: string;
}

const jsonText = (value: unknown): string => (value === undefined ? '' : JSON.stringify(value, null, 2));

export function modelEngineDraft(entity: ModelEntity): ModelEngineDraft {
  return {
    aliases: [...(entity.aliases ?? [])],
    maxInputSize: entity.max_input_size === undefined ? '' : String(entity.max_input_size),
    maxOutputSize: entity.max_output_size === undefined ? '' : String(entity.max_output_size),
    contextBudget: entity.context_budget === undefined ? '' : String(entity.context_budget),
    offEffort: entity.off_effort ?? '',
    reasoningKey: entity.reasoning_key ?? '',
    adaptiveThinking: entity.adaptive_thinking === undefined ? 'inherit' : entity.adaptive_thinking ? 'on' : 'off',
    requestParams: jsonText(entity.request_params),
    cognition: promptTableDraft(entity.cognition, cognitionDraft),
    promptOverrides: promptTableDraft(entity.prompt_overrides, promptOverridesDraft),
    overrides: jsonText(entity.overrides),
  };
}

export function modelEngineDraftsEqual(a: ModelEngineDraft, b: ModelEngineDraft): boolean {
  const content = (value: ModelEngineDraft) => ({
    ...value,
    cognition: promptTableText(value.cognition, cognitionBody),
    promptOverrides: promptTableText(value.promptOverrides, promptOverridesBody),
  });
  return JSON.stringify(content(a)) === JSON.stringify(content(b));
}

export type EngineField = keyof ModelEngineDraft;
export class ModelEngineFieldError extends Error {
  constructor(readonly field: EngineField, readonly key: 'count' | 'json' | 'object') {
    super(`${field}: ${key}`);
  }
}

/** Only the changed fields; an emptied field is sent as null so the key is removed. */
export function modelEnginePatch(draft: ModelEngineDraft, baseline: ModelEngineDraft): PatchModelRequest {
  const patch: Record<string, unknown> = {};
  const count = (field: EngineField, wire: string) => {
    const text = (draft[field] as string).trim();
    if (text === (baseline[field] as string).trim()) return;
    if (text === '') { patch[wire] = null; return; }
    if (!/^\d+$/.test(text) || Number(text) < 1) throw new ModelEngineFieldError(field, 'count');
    patch[wire] = Number(text);
  };
  const word = (field: EngineField, wire: string) => {
    const text = (draft[field] as string).trim();
    if (text !== (baseline[field] as string).trim()) patch[wire] = text === '' ? null : text;
  };
  const table = (field: 'requestParams' | 'overrides' | 'cognition' | 'promptOverrides', wire: string) => {
    const content = (value: ModelEngineDraft) => field === 'cognition' ? promptTableText(value.cognition, cognitionBody)
      : field === 'promptOverrides' ? promptTableText(value.promptOverrides, promptOverridesBody) : value[field];
    const text = content(draft).trim();
    if (text === content(baseline).trim()) return;
    const problem = field === 'cognition' && !draft.cognition.rawActive
      ? promptIdentityProblem(draft.cognition.value, cognitionBody, cognitionProblem)
      : field === 'promptOverrides' && !draft.promptOverrides.rawActive
        ? promptIdentityProblem(draft.promptOverrides.value, promptOverridesBody, promptOverridesProblem) : undefined;
    if (problem !== undefined) throw new LocalizedError({ key: `st.promptIdentity.problem.${problem}` });
    if (text === '') { patch[wire] = null; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new ModelEngineFieldError(field, 'json'); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ModelEngineFieldError(field, 'object');
    if (field === 'cognition') modelCognitionSchema.parse(parsed);
    if (field === 'promptOverrides') modelPromptOverridesSchema.parse(parsed);
    patch[wire] = Object.keys(parsed).length === 0 ? null : parsed;
  };
  if (JSON.stringify(draft.aliases) !== JSON.stringify(baseline.aliases)) {
    patch['aliases'] = draft.aliases.length === 0 ? null : draft.aliases;
  }
  count('maxInputSize', 'max_input_size');
  count('maxOutputSize', 'max_output_size');
  count('contextBudget', 'context_budget');
  word('offEffort', 'off_effort');
  word('reasoningKey', 'reasoning_key');
  if (draft.adaptiveThinking !== baseline.adaptiveThinking) {
    patch['adaptive_thinking'] = draft.adaptiveThinking === 'inherit' ? null : draft.adaptiveThinking === 'on';
  }
  table('requestParams', 'request_params');
  table('cognition', 'cognition');
  table('promptOverrides', 'prompt_overrides');
  table('overrides', 'overrides');
  return patch as PatchModelRequest;
}

const TABLES = [
  { field: 'requestParams', label: 'st.modelEngine.requestParams', help: 'st.modelEngine.requestParamsHelp' },
  { field: 'overrides', label: 'st.modelEngine.overrides', help: 'st.modelEngine.overridesHelp' },
] as const;

export function ModelEngineFields({ modelId, value, onChange, issue, disabled = false }: {
  modelId: string;
  value: ModelEngineDraft;
  onChange: (next: ModelEngineDraft) => void;
  disabled?: boolean;
  /** The field that blocked the last save, with its message. */
  issue: { field: EngineField; text: string } | null;
}) {
  const { t } = useI18n();
  const set = <K extends EngineField>(field: K, next: ModelEngineDraft[K]) => { onChange({ ...value, [field]: next }); };
  const rawResult = (field: 'cognition' | 'promptOverrides') => {
    let parsed: unknown;
    try { parsed = value[field].raw.trim() === '' ? {} : JSON.parse(value[field].raw); } catch { return { error: t('st.modelEngine.issueJson') }; }
    const result = (field === 'cognition' ? modelCognitionSchema : modelPromptOverridesSchema).safeParse(parsed);
    return result.success ? { value: result.data } : { error: result.error.issues[0]?.message ?? t('st.modelEngine.issueObject') };
  };
  const restoreFormButton = (field: 'cognition' | 'promptOverrides') => {
    if (!value[field].rawActive) return null;
    const result = rawResult(field);
    return <div className="pt-2">
      <button type="button" disabled={result.error !== undefined} className="rounded px-2 py-1 text-[12px] text-ink-soft hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:opacity-50"
        onClick={() => { if (result.error === undefined) {
          if (field === 'cognition') set(field, promptTableDraft(result.value, cognitionDraft));
          else set(field, promptTableDraft(result.value, promptOverridesDraft));
        } }}>{t('st.profiles.modeForm')}</button>
      {result.error !== undefined ? <p role="alert" className="text-[12px] text-danger">{result.error}</p> : null}
    </div>;
  };
  const issueLine = (field: EngineField) => (issue?.field === field
    ? <p role="alert" className="mt-1 text-[12px] font-normal text-danger">{issue.text}</p>
    : null);
  const border = (field: EngineField) => (issue?.field === field ? 'border-danger' : '');
  const numberField = (field: 'maxInputSize' | 'maxOutputSize' | 'contextBudget', label: string) => (
    <label className={FORM_LABEL}>
      {label}
      <input className={`${INPUT} mt-1 font-mono font-normal ${border(field)}`} inputMode="numeric" value={value[field]}
        aria-invalid={issue?.field === field} data-model-engine={field}
        placeholder={t('st.modelEngine.unset')} onChange={(event) => { set(field, event.target.value); }} />
      {issueLine(field)}
    </label>
  );
  const textField = (field: 'offEffort' | 'reasoningKey', label: string) => (
    <label className={FORM_LABEL}>
      {label}
      <input className={`${INPUT} mt-1 font-mono font-normal`} value={value[field]} placeholder={t('st.modelEngine.unset')}
        data-model-engine={field} onChange={(event) => { set(field, event.target.value); }} />
    </label>
  );

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3 pt-3 disabled:opacity-60" data-model-engine-fields={modelId}>
      <p className="text-[12px] font-semibold text-ink">{t('st.modelEngine.title')}</p>
      <div className="space-y-1">
        <p className={FORM_LABEL}>{t('st.modelEngine.aliases')}</p>
        <Hint>{t('st.modelEngine.aliasesHelp')}</Hint>
        <ChipSelect values={value.aliases} knownOptions={[]} onChange={(aliases) => { set('aliases', aliases); }}
          ariaLabel={t('st.modelEngine.aliasesAria', { model: modelId })}
          addPlaceholder={t('st.chips.addPlaceholder')} removeLabel={(alias) => t('st.chips.removeAria', { value: alias })} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {numberField('maxInputSize', t('st.modelEngine.maxInput'))}
        {numberField('maxOutputSize', t('st.modelEngine.maxOutput'))}
        {numberField('contextBudget', t('st.modelEngine.contextBudget'))}
      </div>
      <Hint>{t('st.modelEngine.sizesHelp')}</Hint>
      <div className="grid gap-3 sm:grid-cols-3">
        {textField('offEffort', t('st.modelEngine.offEffort'))}
        {textField('reasoningKey', t('st.modelEngine.reasoningKey'))}
        <div className={FORM_LABEL}>
          {t('st.modelEngine.adaptive')}
          <div className="mt-1 font-normal">
            <SettingsSelect<ModelEngineDraft['adaptiveThinking']>
              variant="form"
              ariaLabel={t('st.modelEngine.adaptive')}
              dataAttr="data-model-engine-adaptive"
              value={value.adaptiveThinking}
              onChange={(next) => { set('adaptiveThinking', next); }}
              choices={[
                { value: 'inherit', label: t('st.modelEngine.adaptiveInherit') },
                { value: 'on', label: t('st.modelEngine.adaptiveOn') },
                { value: 'off', label: t('st.modelEngine.adaptiveOff') },
              ]}
            />
          </div>
        </div>
      </div>
      <Hint>{t('st.modelEngine.thinkingHelp')}</Hint>
      <details data-model-cognition-editor className="pt-2">
        <summary className="cursor-pointer py-1 text-[13px] font-medium text-ink">{t('st.promptIdentity.cognitionTitle')}</summary>
        <div className="space-y-4 pt-3">
          {!value.cognition.rawActive ? <PromptIdentityEditor value={value.cognition.value}
            onChange={(next) => set('cognition', updatePromptTable(value.cognition, next, cognitionBody))}>
            {(content, change, label) => <CognitionContentEditor value={content} onChange={change} label={label} />}
          </PromptIdentityEditor> : null}
          <details data-prompt-json="cognition">
            <summary className="cursor-pointer text-[11.5px] text-ink-faint">{t('st.promptIdentity.raw')}</summary>
            <textarea rows={6} spellCheck={false} data-model-engine="cognition" aria-label={t('st.promptIdentity.cognitionTitle')}
              className={`${INPUT} mt-2 h-auto border-0 bg-ink/[0.035] font-mono text-[12px] leading-5`}
              value={value.cognition.raw} onChange={(event) => set('cognition', { ...value.cognition, raw: event.target.value, rawActive: true })} />
            {restoreFormButton('cognition')}
          </details>
          {issueLine('cognition')}
        </div>
      </details>
      <details data-model-overrides-editor className="pt-2">
        <summary className="cursor-pointer py-1 text-[13px] font-medium text-ink">{t('st.promptIdentity.fieldsTitle')}</summary>
        <div className="space-y-4 pt-3">
          {!value.promptOverrides.rawActive ? <PromptIdentityEditor value={value.promptOverrides.value}
            onChange={(next) => set('promptOverrides', updatePromptTable(value.promptOverrides, next, promptOverridesBody))}>
            {(content, change, label) => <PromptOverridesContentEditor value={content} onChange={change} label={label} />}
          </PromptIdentityEditor> : null}
          <details data-prompt-json="promptOverrides">
            <summary className="cursor-pointer text-[11.5px] text-ink-faint">{t('st.promptIdentity.raw')}</summary>
            <textarea rows={6} spellCheck={false} data-model-engine="promptOverrides" aria-label={t('st.promptIdentity.fieldsTitle')}
              className={`${INPUT} mt-2 h-auto border-0 bg-ink/[0.035] font-mono text-[12px] leading-5`}
              value={value.promptOverrides.raw} onChange={(event) => set('promptOverrides', { ...value.promptOverrides, raw: event.target.value, rawActive: true })} />
            {restoreFormButton('promptOverrides')}
          </details>
          {issueLine('promptOverrides')}
        </div>
      </details>
      {TABLES.map(({ field, label, help }) => (
        <label key={field} className={`${FORM_LABEL} block`}>
          {t(label)}
          <span className="mt-0.5 block text-[12px] font-normal leading-snug text-ink-faint">{t(help)}</span>
          <textarea rows={3} spellCheck={false} data-model-engine={field}
            aria-invalid={issue?.field === field}
            className={`${INPUT} mt-1 h-auto py-1.5 font-mono text-[12px] font-normal leading-5 ${border(field)}`}
            value={value[field] as string} onChange={(event) => { set(field, event.target.value); }} />
          {issueLine(field)}
        </label>
      ))}
    </fieldset>
  );
}
