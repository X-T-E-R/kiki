import { useId } from 'react';

import { LEGACY_HOOK_EVENTS, type LegacyHookConfig } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { DANGER_GHOST_BUTTON, INPUT } from '../../ui';
import { SettingField, SettingsBox } from '../fields';
import { FORM_LABEL, SettingsSegmented, SettingsSelect } from '../SettingsPrimitives';
import type { DraftIssue } from './hooksDraft';

/** First issue message for one field of this rule, if any. */
function fieldIssue(issues: readonly DraftIssue[], field: string): string | null {
  return issues.find((issue) => issue.field === field)?.message ?? null;
}

/**
 * Editor for one legacy command rule. Works on the top-level legacy array and
 * on `legacy` inside a v2 object — the parent owns the shape. New rules start
 * with an empty command; the save path reports that against this rule.
 *
 * The kind choice (text rule vs command rule) is the editor's own; switching
 * to a text rule replaces this editor through `onConvertToDeclarative`.
 */
export function LegacyRuleEditor({ rule, ruleLabel, issues, onChange, onRemove, onConvertToDeclarative }: {
  readonly rule: LegacyHookConfig;
  /** Row label for the remove button's aria (e.g. its 1-based position). */
  readonly ruleLabel: string;
  readonly issues: readonly DraftIssue[];
  readonly onChange: (patch: Partial<LegacyHookConfig>) => void;
  readonly onRemove: () => void;
  readonly onConvertToDeclarative?: () => void;
}) {
  const { t } = useI18n();
  const idPrefix = useId();
  const commandIssue = fieldIssue(issues, 'command');
  const eventIssue = fieldIssue(issues, 'event');
  const matcherIssue = fieldIssue(issues, 'matcher');
  const timeoutIssue = fieldIssue(issues, 'timeout');
  return (
    <div className="space-y-3" data-hook-editor="legacy">
      <SettingsBox>
        {onConvertToDeclarative !== undefined ? (
          <SettingField label={t('st.hooks.kind')} help={t('st.hooks.kind.commandHint')}>
            <SettingsSegmented<'declarative' | 'command'>
              ariaLabel={t('st.hooks.kind')}
              dataAttr="data-hook-kind"
              value="command"
              onChange={(next) => { if (next === 'declarative') onConvertToDeclarative(); }}
              choices={[
                { value: 'declarative', label: t('st.hooks.kind.declarative') },
                { value: 'command', label: t('st.hooks.kind.command') },
              ]}
            />
          </SettingField>
        ) : null}
        <SettingField label={t('st.hooks.event')}>
          <SettingsSelect<LegacyHookConfig['event']>
            variant="form"
            dataAttr="data-hook-event"
            ariaLabel={t('st.hooks.event')}
            value={rule.event}
            onChange={(next) => onChange({ event: next })}
            choices={LEGACY_HOOK_EVENTS.map((event) => ({ value: event, label: t(`st.hooks.event.${event}`) }))}
          />
          {eventIssue !== null ? <p role="alert" data-hook-issue="event" className="mt-1 text-[12px] leading-4 text-danger">{eventIssue}</p> : null}
        </SettingField>
        <SettingField label={t('st.hooks.command')} layout="stack" help={commandIssue !== null ? undefined : t('st.hooks.commandHint')}>
          <textarea
            id={`${idPrefix}-command`}
            className={`${INPUT} min-h-16 font-mono`}
            value={rule.command}
            aria-invalid={commandIssue !== null}
            onChange={(event) => onChange({ command: event.target.value })}
          />
          {commandIssue !== null ? <p role="alert" data-hook-issue="command" className="mt-1 text-[12px] leading-4 text-danger">{commandIssue}</p> : null}
        </SettingField>
        <SettingField label={t('st.hooks.matcher')} htmlFor={`${idPrefix}-matcher`} help={t('st.hooks.matchHint')}>
          <input
            id={`${idPrefix}-matcher`}
            className={INPUT}
            value={rule.matcher ?? ''}
            aria-invalid={matcherIssue !== null}
            onChange={(event) => onChange({ matcher: event.target.value === '' ? undefined : event.target.value })}
          />
          {matcherIssue !== null ? <p role="alert" data-hook-issue="matcher" className="mt-1 text-[12px] leading-4 text-danger">{matcherIssue}</p> : null}
        </SettingField>
        <SettingField label={t('st.hooks.timeout')} htmlFor={`${idPrefix}-timeout`}>
          <input
            id={`${idPrefix}-timeout`}
            type="number"
            min={1}
            max={600}
            step={1}
            placeholder="30"
            className="w-24 rounded-lg border border-hairline bg-paper px-3 py-2 text-[12px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent disabled:cursor-not-allowed disabled:bg-hairline/20 disabled:text-ink-faint"
            value={rule.timeout ?? ''}
            aria-invalid={timeoutIssue !== null}
            onChange={(event) => onChange({ timeout: event.target.value === '' ? undefined : Number(event.target.value) })}
          />
          {timeoutIssue !== null ? <p role="alert" data-hook-issue="timeout" className="mt-1 text-[12px] leading-4 text-danger">{timeoutIssue}</p> : null}
        </SettingField>
      </SettingsBox>
      <div>
        <button type="button" className={DANGER_GHOST_BUTTON} aria-label={t('st.hooks.removeRule', { rule: ruleLabel })} onClick={onRemove}>
          {t('st.hooks.remove')}
        </button>
      </div>
    </div>
  );
}
