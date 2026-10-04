import { useId, useState } from 'react';

import {
  DECLARATIVE_HOOK_EVENTS,
  type HookRuleConfig,
} from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { Hint, Toggle } from '../../controls';
import { SearchableSelect } from '../../SearchableSelect';
import { DANGER_GHOST_BUTTON, INPUT } from '../../ui';
import { DependentField } from '../fields';
import { FORM_LABEL, FORM_SELECT_TRIGGER, SettingsSegmented } from '../SettingsPrimitives';
import { formatSelectorLines, parseSelectorLines, type DraftIssue } from './hooksDraft';

type DeclarativeHookEvent = (typeof DECLARATIVE_HOOK_EVENTS)[number];
type HookMatchConfig = HookRuleConfig['match'];

const STEP_EVENTS: ReadonlySet<DeclarativeHookEvent> = new Set(['step.before', 'step.after']);
const INJECT_EVENTS: ReadonlySet<DeclarativeHookEvent> = new Set(['prompt.submit', 'step.before']);

const TEXT_MATCH_FIELDS = ['models', 'profiles', 'routes', 'executors', 'tools'] as const;
const ENUM_MATCH_FIELDS = {
  agentRoles: ['root', 'subagent'],
  statuses: ['success', 'error', 'cancelled', 'denied'],
  sources: ['user', 'task', 'mailbox', 'steering'],
  outcomes: ['completed', 'cancelled', 'failed', 'blocked'],
} as const;

type TextMatchField = (typeof TEXT_MATCH_FIELDS)[number];
type EnumMatchField = keyof typeof ENUM_MATCH_FIELDS;

function fieldIssue(issues: readonly DraftIssue[], field: string): string | null {
  return issues.find((issue) => issue.field === field)?.message ?? null;
}

function IssueLine({ field, issues }: { field: string; issues: readonly DraftIssue[] }) {
  const message = fieldIssue(issues, field);
  if (message === null) return null;
  return <p role="alert" data-hook-issue={field} className="mt-1 text-[12px] leading-4 text-danger">{message}</p>;
}

/** Multi-choice chips in the SettingsSegmented family, for enum match fields. */
function MatchChips<T extends string>({ values, options, onChange, ariaLabel }: {
  readonly values: readonly T[];
  readonly options: readonly { value: T; label: string }[];
  readonly onChange: (next: T[]) => void;
  readonly ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-md bg-ink/[0.04] p-0.5">
      {options.map(({ value, label }) => {
        const on = values.includes(value);
        return (
          <button
            key={value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? values.filter((entry) => entry !== value) : [...values, value])}
            className={`h-7 rounded-[5px] px-3 text-[13px] transition-colors ${
              on ? 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]' : 'text-ink-soft hover:text-ink'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function hasConditions(match: HookMatchConfig): boolean {
  return Object.values(match).some((value) => Array.isArray(value) && value.length > 0);
}

/**
 * Editor for one declarative (v2) rule. Invalid event/action/cadence
 * combinations are prevented by disabling choices instead of producing
 * save-time errors; switching inject → observe and back keeps the typed text
 * or file in local state so nothing is lost mid-edit. The component remounts
 * per rule id (`key`), which resets those stashes between rules.
 */
export function DeclarativeRuleEditor({ rule, issues, onChange, onRemove }: {
  readonly rule: HookRuleConfig;
  readonly issues: readonly DraftIssue[];
  readonly onChange: (patch: Partial<HookRuleConfig>) => void;
  readonly onRemove: () => void;
}) {
  const { t } = useI18n();
  const idPrefix = useId();
  const inject = rule.action.type === 'inject' ? rule.action : null;
  const [lastText, setLastText] = useState(inject?.text ?? '');
  const [lastFile, setLastFile] = useState(inject?.textFile ?? '');
  const [matchOpen, setMatchOpen] = useState(() => hasConditions(rule.match));

  const cadenceAllowed = STEP_EVENTS.has(rule.event);
  const eventOptions = DECLARATIVE_HOOK_EVENTS.map((event) => {
    const injectBlock = inject !== null && !INJECT_EVENTS.has(event);
    const cadenceBlock = rule.cadence !== undefined && !STEP_EVENTS.has(event);
    return {
      value: event as string,
      label: t(`st.hooks.v2event.${event}`),
      disabled: injectBlock || cadenceBlock,
      hint: injectBlock ? t('st.hooks.eventInjectOnly') : cadenceBlock ? t('st.hooks.eventCadenceOnly') : undefined,
    };
  });

  const setAction = (type: 'inject' | 'observe') => {
    if (type === rule.action.type) return;
    if (type === 'observe') {
      onChange({ action: { type: 'observe' } });
      return;
    }
    const action = lastFile !== '' && lastText === ''
      ? { type: 'inject' as const, textFile: lastFile }
      : { type: 'inject' as const, text: lastText };
    // Inject only exists on prompt.submit and step.before — move the event
    // with the action instead of leaving an unsavable combination.
    onChange(INJECT_EVENTS.has(rule.event) ? { action } : { action, event: 'prompt.submit' });
  };

  const setInjectSource = (source: 'text' | 'file') => {
    if (inject === null) return;
    if (source === 'text') onChange({ action: { type: 'inject', text: lastText } });
    else onChange({ action: { type: 'inject', textFile: lastFile } });
  };

  const setCadence = (on: boolean) => {
    if (on) {
      const cadence = { everyCompletedSteps: 1, counterScope: 'agent' as const, partitionBy: 'model' as const };
      onChange(cadenceAllowed ? { cadence } : { cadence, event: 'step.before' });
    } else {
      onChange({ cadence: undefined });
    }
  };

  const setMatch = (field: TextMatchField | EnumMatchField, next: readonly string[]) => {
    const match: Record<string, unknown> = { ...rule.match };
    if (next.length === 0) delete match[field];
    else match[field] = [...next];
    onChange({ match: match as HookMatchConfig });
  };

  const MATCH_FIELDS: readonly (TextMatchField | EnumMatchField)[] = [...TEXT_MATCH_FIELDS, ...(Object.keys(ENUM_MATCH_FIELDS) as EnumMatchField[])];
  const activeConditions = MATCH_FIELDS
    .filter((field) => (rule.match[field]?.length ?? 0) > 0)
    .map((field) => t(`st.hooks.match.${field}`));

  return (
    <div className="space-y-4" data-hook-editor="declarative">
      <div className="flex flex-wrap items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-1">
          <label htmlFor={`${idPrefix}-id`} className={FORM_LABEL}>{t('st.hooks.ruleId')}</label>
          <input
            id={`${idPrefix}-id`}
            className={`${INPUT} font-mono`}
            value={rule.id}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={fieldIssue(issues, 'id') !== null}
            onChange={(event) => onChange({ id: event.target.value })}
          />
          <IssueLine field="id" issues={issues} />
        </div>
        <div className="pt-5">
          <Toggle layout="inline" label={t('st.hooks.ruleEnabled')} checked={rule.enabled} onChange={(enabled) => onChange({ enabled })} />
        </div>
      </div>
      <Hint>{t('st.hooks.ruleIdHint')}</Hint>

      <div className="grid gap-1">
        <span className={FORM_LABEL}>{t('st.hooks.event')}</span>
        <SearchableSelect
          options={eventOptions}
          value={rule.event}
          ariaLabel={t('st.hooks.event')}
          onChange={(next) => onChange({ event: next as DeclarativeHookEvent })}
          hideFilter
          placement="auto"
          buttonClassName={FORM_SELECT_TRIGGER}
        />
        <IssueLine field="event" issues={issues} />
      </div>

      <div className="grid gap-1.5" data-hook-field="action">
        <span className={FORM_LABEL}>{t('st.hooks.action')}</span>
        <SettingsSegmented<'inject' | 'observe'>
          ariaLabel={t('st.hooks.action')}
          dataAttr="data-hook-action"
          value={rule.action.type}
          onChange={(next) => setAction(next)}
          choices={[
            { value: 'inject', label: t('st.hooks.action.inject') },
            { value: 'observe', label: t('st.hooks.action.observe') },
          ]}
        />
        <IssueLine field="action" issues={issues} />
        {rule.action.type === 'observe' ? <Hint>{t('st.hooks.observeHint')}</Hint> : (
          <div className="space-y-2 pt-1">
            <SettingsSegmented<'text' | 'file'>
              ariaLabel={t('st.hooks.injectText')}
              dataAttr="data-hook-inject-source"
              value={inject?.textFile !== undefined ? 'file' : 'text'}
              onChange={(next) => setInjectSource(next)}
              choices={[
                { value: 'text', label: t('st.hooks.injectSource.text') },
                { value: 'file', label: t('st.hooks.injectSource.file') },
              ]}
            />
            {inject?.textFile !== undefined ? (
              <div className="grid gap-1">
                <input
                  className={`${INPUT} font-mono`}
                  value={inject.textFile}
                  aria-label={t('st.hooks.injectFile')}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={fieldIssue(issues, 'textFile') !== null}
                  onChange={(event) => { setLastFile(event.target.value); onChange({ action: { type: 'inject', textFile: event.target.value } }); }}
                />
                <IssueLine field="textFile" issues={issues} />
                <Hint>{t('st.hooks.injectFileHint')}</Hint>
              </div>
            ) : (
              <div className="grid gap-1">
                <textarea
                  className={`${INPUT} min-h-24`}
                  value={inject?.text ?? ''}
                  aria-label={t('st.hooks.injectText')}
                  aria-invalid={fieldIssue(issues, 'text') !== null}
                  onChange={(event) => { setLastText(event.target.value); onChange({ action: { type: 'inject', text: event.target.value } }); }}
                />
                <IssueLine field="text" issues={issues} />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid max-w-40 gap-1">
        <label htmlFor={`${idPrefix}-priority`} className={FORM_LABEL}>{t('st.hooks.priority')}</label>
        <input
          id={`${idPrefix}-priority`}
          type="number"
          step={1}
          className={INPUT}
          value={rule.priority}
          aria-invalid={fieldIssue(issues, 'priority') !== null}
          onChange={(event) => onChange({ priority: Number(event.target.value) })}
        />
        <IssueLine field="priority" issues={issues} />
        <Hint>{t('st.hooks.priorityHint')}</Hint>
      </div>

      <DependentField when={cadenceAllowed}>
        <div className="grid gap-2" data-hook-field="cadence">
          <Toggle
            layout="inline"
            label={t('st.hooks.cadenceEnable')}
            checked={rule.cadence !== undefined}
            onChange={(on) => setCadence(on)}
          />
          {rule.cadence !== undefined ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid w-36 gap-1">
                <label htmlFor={`${idPrefix}-cadence`} className={FORM_LABEL}>{t('st.hooks.cadenceEvery')}</label>
                <input
                  id={`${idPrefix}-cadence`}
                  type="number"
                  min={1}
                  step={1}
                  className={INPUT}
                  value={rule.cadence.everyCompletedSteps}
                  aria-invalid={fieldIssue(issues, 'everyCompletedSteps') !== null}
                  onChange={(event) => onChange({ cadence: { ...rule.cadence!, everyCompletedSteps: Number(event.target.value) } })}
                />
              </div>
              <div className="grid gap-1">
                <span className={FORM_LABEL}>{t('st.hooks.cadenceScope')}</span>
                <SettingsSegmented<'agent' | 'turn'>
                  ariaLabel={t('st.hooks.cadenceScope')}
                  dataAttr="data-hook-cadence-scope"
                  value={rule.cadence.counterScope}
                  onChange={(next) => onChange({ cadence: { ...rule.cadence!, counterScope: next } })}
                  choices={[
                    { value: 'agent', label: t('st.hooks.cadenceScope.agent') },
                    { value: 'turn', label: t('st.hooks.cadenceScope.turn') },
                  ]}
                />
              </div>
            </div>
          ) : null}
          <IssueLine field="everyCompletedSteps" issues={issues} />
          <IssueLine field="cadence" issues={issues} />
        </div>
      </DependentField>

      <div className="border-t border-hairline pt-3" data-hook-field="match">
        <button
          type="button"
          aria-expanded={matchOpen}
          onClick={() => setMatchOpen(!matchOpen)}
          className="flex min-h-7 w-full items-center justify-between gap-3 text-left focus-visible:outline-2 focus-visible:outline-selected-ink"
        >
          <span className="text-[13px] font-medium text-ink">{t('st.hooks.matchTitle')}</span>
          <span className="min-w-0 truncate text-[12px] text-ink-faint">
            {activeConditions.length === 0 ? t('st.hooks.matchEmpty') : activeConditions.join(' · ')}
          </span>
        </button>
        {matchOpen ? (
          <div className="space-y-3 pt-2">
            <Hint>{t('st.hooks.matchLine')}</Hint>
            {TEXT_MATCH_FIELDS.map((field) => (
              <div key={field} className="grid gap-1">
                <label htmlFor={`${idPrefix}-match-${field}`} className={FORM_LABEL}>{t(`st.hooks.match.${field}`)}</label>
                <textarea
                  id={`${idPrefix}-match-${field}`}
                  className={`${INPUT} min-h-8 font-mono`}
                  value={formatSelectorLines(rule.match[field] ?? [])}
                  aria-invalid={fieldIssue(issues, field) !== null}
                  onChange={(event) => setMatch(field, parseSelectorLines(event.target.value))}
                />
                <IssueLine field={field} issues={issues} />
              </div>
            ))}
            {(Object.keys(ENUM_MATCH_FIELDS) as EnumMatchField[]).map((field) => (
              <div key={field} className="grid gap-1">
                <span className={FORM_LABEL}>{t(`st.hooks.match.${field}`)}</span>
                <MatchChips
                  values={rule.match[field] ?? []}
                  options={ENUM_MATCH_FIELDS[field].map((value) => ({ value, label: t(`st.hooks.matchValue.${value}`) }))}
                  ariaLabel={t(`st.hooks.match.${field}`)}
                  onChange={(next) => setMatch(field, next)}
                />
                <IssueLine field={field} issues={issues} />
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div>
        <button type="button" className={DANGER_GHOST_BUTTON} aria-label={t('st.hooks.removeRule', { rule: rule.id })} onClick={onRemove}>
          {t('st.hooks.remove')}
        </button>
      </div>
    </div>
  );
}
