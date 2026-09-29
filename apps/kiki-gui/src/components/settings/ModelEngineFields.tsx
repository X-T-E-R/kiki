import type { ModelEntity, PatchModelRequest } from '@kiki/protocol';

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
  cognition: string;
  promptOverrides: string;
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
    cognition: jsonText(entity.cognition),
    promptOverrides: jsonText(entity.prompt_overrides),
    overrides: jsonText(entity.overrides),
  };
}

export function modelEngineDraftsEqual(a: ModelEngineDraft, b: ModelEngineDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
  const table = (field: EngineField, wire: string) => {
    const text = (draft[field] as string).trim();
    if (text === (baseline[field] as string).trim()) return;
    if (text === '') { patch[wire] = null; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new ModelEngineFieldError(field, 'json'); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ModelEngineFieldError(field, 'object');
    patch[wire] = parsed;
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

const TABLES: readonly { field: EngineField; label: 'st.modelEngine.requestParams' | 'st.modelEngine.cognition' | 'st.modelEngine.promptOverrides' | 'st.modelEngine.overrides'; help: 'st.modelEngine.requestParamsHelp' | 'st.modelEngine.cognitionHelp' | 'st.modelEngine.promptOverridesHelp' | 'st.modelEngine.overridesHelp' }[] = [
  { field: 'requestParams', label: 'st.modelEngine.requestParams', help: 'st.modelEngine.requestParamsHelp' },
  { field: 'overrides', label: 'st.modelEngine.overrides', help: 'st.modelEngine.overridesHelp' },
  { field: 'cognition', label: 'st.modelEngine.cognition', help: 'st.modelEngine.cognitionHelp' },
  { field: 'promptOverrides', label: 'st.modelEngine.promptOverrides', help: 'st.modelEngine.promptOverridesHelp' },
];

export function ModelEngineFields({ modelId, value, onChange, issue }: {
  modelId: string;
  value: ModelEngineDraft;
  onChange: (next: ModelEngineDraft) => void;
  /** The field that blocked the last save, with its message. */
  issue: { field: EngineField; text: string } | null;
}) {
  const { t } = useI18n();
  const set = <K extends EngineField>(field: K, next: ModelEngineDraft[K]) => { onChange({ ...value, [field]: next }); };
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
    <div className="space-y-3 border-t border-hairline pt-3" data-model-engine-fields={modelId}>
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
    </div>
  );
}
