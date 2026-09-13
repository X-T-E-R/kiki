import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PromptConfigSchema,
  previewPromptConfig,
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
type PromptDraft = { shared: string; variables: PromptRow[]; tools: PromptRow[] };
type PromptErrors = { shared?: string; variables: Record<number, string>; tools: Record<number, string> };

const EMPTY_DRAFT: PromptDraft = { shared: '', variables: [], tools: [] };
let promptRowCounter = 0;

function newPromptRowId(kind: 'variable' | 'tool'): string {
  promptRowCounter += 1;
  return `${kind}-${promptRowCounter}`;
}

function promptDraftFromConfig(value: unknown): PromptDraft {
  const config = typeof value === 'object' && value !== null ? value as Partial<PromptConfig> : {};
  return {
    shared: typeof config.shared === 'string' ? config.shared : '',
    variables: Object.entries(config.variables ?? {}).filter(([, variable]) => typeof variable === 'string').map(([name, variable]) => ({ id: newPromptRowId('variable'), name, value: variable })),
    tools: Object.entries(config.tools ?? {}).filter(([, description]) => typeof description === 'string').map(([name, description]) => ({ id: newPromptRowId('tool'), name, value: description })),
  };
}

function promptConfigFromDraft(draft: PromptDraft): PromptConfig {
  return {
    shared: draft.shared,
    variables: Object.fromEntries(draft.variables.map((row) => [row.name.trim(), row.value])),
    tools: Object.fromEntries(draft.tools.map((row) => [row.name.trim(), row.value])),
  };
}

function nameValid(configKey: 'variables' | 'tools', name: string): boolean {
  const result = PromptConfigSchema.safeParse({ [configKey]: Object.fromEntries([[name, '']]) });
  return result.success;
}

function validatePromptDraft(draft: PromptDraft, t: (key: I18nKey, params?: I18nParams) => string): PromptErrors {
  const errors: PromptErrors = { variables: {}, tools: {} };
  const validateRows = (rows: PromptRow[], target: Record<number, string>, kind: 'variables' | 'tools') => {
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      const name = row.name.trim();
      if (name === '') target[index] = t('st.prompt.nameRequired');
      else if (!nameValid(kind, name)) target[index] = t('st.prompt.nameInvalid');
      else if (seen.has(name)) target[index] = t('st.prompt.duplicateName', { name });
      else seen.add(name);
    }
  };
  validateRows(draft.variables, errors.variables, 'variables');
  validateRows(draft.tools, errors.tools, 'tools');
  if (Object.keys(errors.variables).length > 0 || Object.keys(errors.tools).length > 0) return errors;

  const result = PromptConfigSchema.safeParse(promptConfigFromDraft(draft));
  if (!result.success) {
    for (const issue of result.error.issues) {
      if (issue.path[0] === 'shared') errors.shared ??= issue.message;
      if (issue.path[0] === 'tools' && typeof issue.path[1] === 'string') {
        const index = draft.tools.findIndex((row) => row.name.trim() === issue.path[1]);
        if (index >= 0) errors.tools[index] ??= issue.message;
      }
      if (issue.path[0] === 'variables' && typeof issue.path[1] === 'string') {
        const index = draft.variables.findIndex((row) => row.name.trim() === issue.path[1]);
        if (index >= 0) errors.variables[index] ??= issue.message;
      }
    }
  }
  return errors;
}

function hasPromptErrors(errors: PromptErrors): boolean {
  return errors.shared !== undefined
    || Object.keys(errors.variables).length > 0
    || Object.keys(errors.tools).length > 0;
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
  const preview = useMemo(() => {
    if (hasPromptErrors(errors)) return null;
    return previewPromptConfig(promptConfigFromDraft(draft));
  }, [draft, errors]);

  useDirtyReporter('prompt-config', dirty);

  useEffect(() => {
    if (configQuery.data !== undefined && !dirty) setDraft(promptDraftFromConfig(configQuery.data.prompt));
  }, [configQuery.data, dirty]);

  const update = (next: PromptDraft) => {
    setDraft(next);
    setDirty(true);
    setFeedback(null);
  };
  const newRow = (kind: 'variable' | 'tool'): PromptRow => ({ id: newPromptRowId(kind), name: '', value: '' });
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
                {tp('st.prompt.summaryTools', draft.tools.length)}
              </span>
            </span>
          ) : null}
        </summary>
        <div className="mt-3 space-y-4">
          <Hint>{t('st.prompt.hint')}</Hint>
          <fieldset disabled={!ready || saving} className="space-y-4 disabled:opacity-60">
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.prompt.shared')}
            <textarea
              className={`${INPUT} mt-1 min-h-24`}
              data-prompt-shared
              value={draft.shared}
              placeholder={t('st.prompt.sharedPlaceholder')}
              onChange={(event) => { update({ ...draft, shared: event.target.value }); }}
            />
            {errors.shared !== undefined ? <span className="mt-1 block text-[11px] text-danger" role="alert">{errors.shared}</span> : null}
          </label>

          <fieldset disabled={saving} className="space-y-2 disabled:opacity-60">
            <legend className="text-[12px] font-medium text-ink">{t('st.prompt.variables')}</legend>
            {draft.variables.map((row, index) => (
              <div key={row.id} data-prompt-variable-row={row.id} className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
                <input
                  className={INPUT}
                  value={row.name}
                  placeholder={t('st.prompt.variableNamePlaceholder')}
                  aria-label={t('st.prompt.variableName')}
                  data-prompt-variable-name
                  onChange={(event) => { update({ ...draft, variables: draft.variables.map((item, rowIndex) => rowIndex === index ? { ...item, name: event.target.value } : item) }); }}
                />
                <textarea
                  className={`${INPUT} min-h-16`}
                  value={row.value}
                  placeholder={t('st.prompt.variableValuePlaceholder')}
                  aria-label={t('st.prompt.variableValue')}
                  onChange={(event) => { update({ ...draft, variables: draft.variables.map((item, rowIndex) => rowIndex === index ? { ...item, value: event.target.value } : item) }); }}
                />
                <button type="button" className={SECONDARY_BUTTON} aria-label={t('st.prompt.removeVariable', { name: row.name || String(index + 1) })} onClick={() => { update({ ...draft, variables: draft.variables.filter((_, rowIndex) => rowIndex !== index) }); }}>×</button>
                {errors.variables[index] !== undefined ? <p className="sm:col-span-3 text-[11px] text-danger" role="alert">{errors.variables[index]}</p> : null}
              </div>
            ))}
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { update({ ...draft, variables: [...draft.variables, newRow('variable')] }); }}>{t('st.prompt.addVariable')}</button>
            {draft.variables.length === 0 ? <Hint>{t('st.prompt.emptyVariables')}</Hint> : null}
          </fieldset>

          <fieldset disabled={saving} className="space-y-2 disabled:opacity-60">
            <legend className="text-[12px] font-medium text-ink">{t('st.prompt.tools')}</legend>
            {draft.tools.map((row, index) => (
              <div key={row.id} data-prompt-tool-row={row.id} className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
                <input
                  className={INPUT}
                  value={row.name}
                  placeholder={t('st.prompt.toolNamePlaceholder')}
                  aria-label={t('st.prompt.toolName')}
                  onChange={(event) => { update({ ...draft, tools: draft.tools.map((item, rowIndex) => rowIndex === index ? { ...item, name: event.target.value } : item) }); }}
                />
                <textarea
                  className={`${INPUT} min-h-16`}
                  value={row.value}
                  placeholder={t('st.prompt.toolDescriptionPlaceholder')}
                  aria-label={t('st.prompt.toolDescription')}
                  onChange={(event) => { update({ ...draft, tools: draft.tools.map((item, rowIndex) => rowIndex === index ? { ...item, value: event.target.value } : item) }); }}
                />
                <button type="button" className={SECONDARY_BUTTON} aria-label={t('st.prompt.removeTool', { name: row.name || String(index + 1) })} onClick={() => { update({ ...draft, tools: draft.tools.filter((_, rowIndex) => rowIndex !== index) }); }}>×</button>
                {errors.tools[index] !== undefined ? <p className="sm:col-span-3 text-[11px] text-danger" role="alert">{errors.tools[index]}</p> : null}
              </div>
            ))}
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { update({ ...draft, tools: [...draft.tools, newRow('tool')] }); }}>{t('st.prompt.addTool')}</button>
            {draft.tools.length === 0 ? <Hint>{t('st.prompt.emptyTools')}</Hint> : null}
          </fieldset>
          </fieldset>

          <details data-prompt-preview className="rounded-lg border border-hairline bg-paper px-3 py-2 text-[11px] text-ink-soft">
            <summary className="cursor-pointer font-medium">{t('st.prompt.preview')}</summary>
            <div className="mt-3 space-y-3">
              {preview === null ? <p role="status">{t('st.prompt.previewUnavailable')}</p> : (
                <>
                  <div>
                    <p className="font-medium text-ink">{t('st.prompt.previewShared')}</p>
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{preview.shared || '—'}</pre>
                  </div>
                  <div>
                    <p className="font-medium text-ink">{t('st.prompt.previewTools')}</p>
                    {Object.entries(preview.tools).length === 0 ? <p>—</p> : Object.entries(preview.tools).map(([name, text]) => <pre key={name} className="mt-1 whitespace-pre-wrap break-words font-mono">{name}: {text}</pre>)}
                  </div>
                </>
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
