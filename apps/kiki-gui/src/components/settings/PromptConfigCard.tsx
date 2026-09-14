import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PromptConfigSchema,
  type PromptConfig,
} from '@kiki/agent-profiles/promptConfig';
import { errorText, type I18nKey, type I18nParams } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { useDirtyReporter } from '../dirtyGuard';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';

type PromptRow = { id: string; name: string; value: string };
type PromptFileRow = { id: string; value: string };
type PromptDraft = { files: PromptFileRow[]; variables: PromptRow[]; fields: PromptRow[] };
type PromptErrors = { files: Record<number, string>; variables: Record<number, string>; fields: Record<number, string> };

const EMPTY_DRAFT: PromptDraft = { files: [], variables: [], fields: [] };
const FIELD_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
let promptRowCounter = 0;

function newPromptRowId(kind: 'variable' | 'field' | 'file'): string {
  promptRowCounter += 1;
  return `${kind}-${promptRowCounter}`;
}

function promptDraftFromConfig(value: unknown): PromptDraft {
  const config = typeof value === 'object' && value !== null ? value as Partial<PromptConfig> : {};
  return {
    files: (config.overrides?.files ?? []).filter((path): path is string => typeof path === 'string').map((path) => ({ id: newPromptRowId('file'), value: path })),
    variables: Object.entries(config.variables ?? {}).filter(([, variable]) => typeof variable === 'string').map(([name, variable]) => ({ id: newPromptRowId('variable'), name, value: variable })),
    fields: Object.entries(config.overrides?.fields ?? {}).filter(([, text]) => typeof text === 'string').map(([name, text]) => ({ id: newPromptRowId('field'), name, value: text })),
  };
}

function promptConfigFromDraft(draft: PromptDraft): PromptConfig {
  return {
    variables: Object.fromEntries(draft.variables.map((row) => [row.name.trim(), row.value])),
    overrides: {
      files: draft.files.map((row) => row.value.trim()),
      fields: Object.fromEntries(draft.fields.map((row) => [row.name.trim(), row.value])),
    },
  };
}

function variableNameValid(name: string): boolean {
  return PromptConfigSchema.safeParse({ variables: { [name]: '' } }).success;
}

function validatePromptDraft(draft: PromptDraft, t: (key: I18nKey, params?: I18nParams) => string): PromptErrors {
  const errors: PromptErrors = { files: {}, variables: {}, fields: {} };
  const validateRows = (rows: PromptRow[], target: Record<number, string>, kind: 'variables' | 'fields') => {
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      const name = row.name.trim();
      if (name === '') target[index] = t('st.prompt.nameRequired');
      else if (kind === 'variables' ? !variableNameValid(name) : !FIELD_ID_PATTERN.test(name)) target[index] = t('st.prompt.nameInvalid');
      else if (seen.has(name)) target[index] = t('st.prompt.duplicateName', { name });
      else seen.add(name);
    }
  };
  validateRows(draft.variables, errors.variables, 'variables');
  validateRows(draft.fields, errors.fields, 'fields');
  for (const [index, row] of draft.files.entries()) {
    if (row.value.trim() === '') errors.files[index] = t('st.prompt.fileRequired');
  }
  if (Object.values(errors).some((section) => Object.keys(section).length > 0)) return errors;

  const result = PromptConfigSchema.safeParse(promptConfigFromDraft(draft));
  if (!result.success) {
    for (const issue of result.error.issues) {
      if (issue.path[0] === 'variables' && typeof issue.path[1] === 'string') {
        const index = draft.variables.findIndex((row) => row.name.trim() === issue.path[1]);
        if (index >= 0) errors.variables[index] ??= issue.message;
      }
      if (issue.path[0] === 'overrides' && issue.path[1] === 'fields' && typeof issue.path[2] === 'string') {
        const index = draft.fields.findIndex((row) => row.name.trim() === issue.path[2]);
        if (index >= 0) errors.fields[index] ??= issue.message;
      }
    }
  }
  return errors;
}

function hasPromptErrors(errors: PromptErrors): boolean {
  return Object.values(errors).some((section) => Object.keys(section).length > 0);
}

function previewFields(draft: PromptDraft): Record<string, string> {
  const variables = Object.fromEntries(draft.variables.map((row) => [row.name.trim(), row.value]));
  return Object.fromEntries(draft.fields.map((row) => [
    row.name.trim(),
    row.value.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (token, name: string) => variables[name] ?? token),
  ]));
}

export function PromptConfigCard() {
  const { client } = useConnection();
  const { t, tp, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<PromptDraft>(EMPTY_DRAFT);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const ready = configQuery.data !== undefined;
  const errors = useMemo(() => validatePromptDraft(draft, t), [draft, t]);
  const preview = useMemo(() => hasPromptErrors(errors) ? null : previewFields(draft), [draft, errors]);

  useDirtyReporter('prompt-config', dirty);

  useEffect(() => {
    if (configQuery.data !== undefined && !dirty) setDraft(promptDraftFromConfig(configQuery.data.prompt));
  }, [configQuery.data, dirty]);

  const update = (next: PromptDraft) => {
    setDraft(next);
    setDirty(true);
    setFeedback(null);
  };
  const newRow = (kind: 'variable' | 'field'): PromptRow => ({ id: newPromptRowId(kind), name: '', value: '' });
  const save = async () => {
    if (hasPromptErrors(errors)) {
      setFeedback({ tone: 'error', text: t('st.prompt.invalid') });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({
        prompt: promptConfigFromDraft(draft),
        replace_domains: ['prompt'],
      });
      queryClient.setQueryData(['config'], echoed);
      setDraft(promptDraftFromConfig(echoed.prompt));
      setDirty(false);
      setFeedback({ tone: 'success', text: t('st.prompt.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-prompt-config" title={t('st.prompt.title')}>
      <details data-prompt-config>
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-[12px] text-ink-soft">
          <span>{t('st.prompt.expand')}</span>
          {ready ? (
            <span className="ml-auto flex flex-wrap gap-1.5">
              <span className="rounded-full border border-hairline bg-panel px-1.5 py-px text-[9.5px] text-ink-faint">
                {tp('st.prompt.summaryVariables', draft.variables.length)}
              </span>
              <span className="rounded-full border border-hairline bg-panel px-1.5 py-px text-[9.5px] text-ink-faint">
                {tp('st.prompt.summaryFields', draft.fields.length)}
              </span>
            </span>
          ) : null}
        </summary>
        <div className="mt-3 space-y-4">
          <Hint>{t('st.prompt.hint')}</Hint>
          <fieldset disabled={!ready || saving} className="space-y-4 disabled:opacity-60">
            <fieldset disabled={saving} className="space-y-2 disabled:opacity-60">
              <legend className="text-[12px] font-medium text-ink">{t('st.prompt.files')}</legend>
              {draft.files.map((row, index) => (
                <div key={row.id} data-prompt-file-row={row.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <input
                    className={INPUT}
                    value={row.value}
                    placeholder={t('st.prompt.filePathPlaceholder')}
                    aria-label={t('st.prompt.filePath')}
                    onChange={(event) => { update({ ...draft, files: draft.files.map((item, rowIndex) => rowIndex === index ? { ...item, value: event.target.value } : item) }); }}
                  />
                  <button type="button" className={SECONDARY_BUTTON} aria-label={t('st.prompt.removeFile', { name: row.value || String(index + 1) })} onClick={() => { update({ ...draft, files: draft.files.filter((_, rowIndex) => rowIndex !== index) }); }}>×</button>
                  {errors.files[index] !== undefined ? <p className="sm:col-span-2 text-[11px] text-danger" role="alert">{errors.files[index]}</p> : null}
                </div>
              ))}
              <button type="button" className={SECONDARY_BUTTON} onClick={() => { update({ ...draft, files: [...draft.files, { id: newPromptRowId('file'), value: '' }] }); }}>{t('st.prompt.addFile')}</button>
              {draft.files.length === 0 ? <Hint>{t('st.prompt.emptyFiles')}</Hint> : null}
            </fieldset>

            <fieldset disabled={saving} className="space-y-2 disabled:opacity-60">
              <legend className="text-[12px] font-medium text-ink">{t('st.prompt.variables')}</legend>
              {draft.variables.map((row, index) => (
                <div key={row.id} data-prompt-variable-row={row.id} className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
                  <input className={INPUT} value={row.name} placeholder={t('st.prompt.variableNamePlaceholder')} aria-label={t('st.prompt.variableName')} data-prompt-variable-name onChange={(event) => { update({ ...draft, variables: draft.variables.map((item, rowIndex) => rowIndex === index ? { ...item, name: event.target.value } : item) }); }} />
                  <textarea className={`${INPUT} min-h-16`} value={row.value} placeholder={t('st.prompt.variableValuePlaceholder')} aria-label={t('st.prompt.variableValue')} onChange={(event) => { update({ ...draft, variables: draft.variables.map((item, rowIndex) => rowIndex === index ? { ...item, value: event.target.value } : item) }); }} />
                  <button type="button" className={SECONDARY_BUTTON} aria-label={t('st.prompt.removeVariable', { name: row.name || String(index + 1) })} onClick={() => { update({ ...draft, variables: draft.variables.filter((_, rowIndex) => rowIndex !== index) }); }}>×</button>
                  {errors.variables[index] !== undefined ? <p className="sm:col-span-3 text-[11px] text-danger" role="alert">{errors.variables[index]}</p> : null}
                </div>
              ))}
              <button type="button" className={SECONDARY_BUTTON} onClick={() => { update({ ...draft, variables: [...draft.variables, newRow('variable')] }); }}>{t('st.prompt.addVariable')}</button>
              {draft.variables.length === 0 ? <Hint>{t('st.prompt.emptyVariables')}</Hint> : null}
            </fieldset>

            <fieldset disabled={saving} className="space-y-2 disabled:opacity-60">
              <legend className="text-[12px] font-medium text-ink">{t('st.prompt.fields')}</legend>
              {draft.fields.map((row, index) => (
                <div key={row.id} data-prompt-field-row={row.id} className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
                  <input className={INPUT} value={row.name} placeholder={t('st.prompt.fieldNamePlaceholder')} aria-label={t('st.prompt.fieldName')} onChange={(event) => { update({ ...draft, fields: draft.fields.map((item, rowIndex) => rowIndex === index ? { ...item, name: event.target.value } : item) }); }} />
                  <textarea className={`${INPUT} min-h-16`} value={row.value} placeholder={t('st.prompt.fieldValuePlaceholder')} aria-label={t('st.prompt.fieldValue')} onChange={(event) => { update({ ...draft, fields: draft.fields.map((item, rowIndex) => rowIndex === index ? { ...item, value: event.target.value } : item) }); }} />
                  <button type="button" className={SECONDARY_BUTTON} aria-label={t('st.prompt.removeField', { name: row.name || String(index + 1) })} onClick={() => { update({ ...draft, fields: draft.fields.filter((_, rowIndex) => rowIndex !== index) }); }}>×</button>
                  {errors.fields[index] !== undefined ? <p className="sm:col-span-3 text-[11px] text-danger" role="alert">{errors.fields[index]}</p> : null}
                </div>
              ))}
              <button type="button" className={SECONDARY_BUTTON} onClick={() => { update({ ...draft, fields: [...draft.fields, newRow('field')] }); }}>{t('st.prompt.addField')}</button>
              {draft.fields.length === 0 ? <Hint>{t('st.prompt.emptyFields')}</Hint> : null}
            </fieldset>
          </fieldset>

          <details data-prompt-preview className="rounded-lg border border-hairline bg-paper px-3 py-2 text-[11px] text-ink-soft">
            <summary className="cursor-pointer font-medium">{t('st.prompt.preview')}</summary>
            <div className="mt-3 space-y-3">
              {preview === null ? <p role="status">{t('st.prompt.previewUnavailable')}</p> : (
                <div>
                  <p className="font-medium text-ink">{t('st.prompt.previewFields')}</p>
                  {Object.entries(preview).length === 0 ? <p>—</p> : Object.entries(preview).map(([name, text]) => <pre key={name} className="mt-1 whitespace-pre-wrap break-words font-mono">{name}: {text}</pre>)}
                </div>
              )}
            </div>
          </details>

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={PRIMARY_BUTTON} disabled={!ready || saving || !dirty || hasPromptErrors(errors)} onClick={() => void save()}>{saving ? t('common.saving') : t('st.prompt.save')}</button>
            {dirty ? <span className="text-[12px] text-ink-soft">{t('st.tools.unsaved')}</span> : null}
          </div>
          {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
          <FeedbackLine feedback={feedback} />
        </div>
      </details>
    </SectionCard>
  );
}
