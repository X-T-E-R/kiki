import { useId } from 'react';

import { LEGACY_HOOK_EVENTS, type LegacyHookConfig } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { Hint } from '../../controls';
import { DANGER_GHOST_BUTTON, INPUT } from '../../ui';
import { FORM_LABEL, SettingsSelect } from '../SettingsPrimitives';
import type { DraftIssue } from './hooksDraft';

/** First issue message for one field of this rule, if any. */
function fieldIssue(issues: readonly DraftIssue[], field: string): string | null {
  return issues.find((issue) => issue.field === field)?.message ?? null;
}

/**
 * Editor for one legacy command rule. Works on the top-level legacy array and
 * on `legacy` inside a v2 object — the parent owns the shape. New rules start
 * with an empty command; the save path reports that against this rule.
 */
export function LegacyRuleEditor({ rule, ruleLabel, issues, onChange, onRemove }: {
  readonly rule: LegacyHookConfig;
  /** Row label for the remove button's aria (e.g. its 1-based position). */
  readonly ruleLabel: string;
  readonly issues: readonly DraftIssue[];
  readonly onChange: (patch: Partial<LegacyHookConfig>) => void;
  readonly onRemove: () => void;
}) {
  const { t } = useI18n();
  const idPrefix = useId();
  const commandIssue = fieldIssue(issues, 'command');
  const eventIssue = fieldIssue(issues, 'event');
  const matcherIssue = fieldIssue(issues, 'matcher');
  const timeoutIssue = fieldIssue(issues, 'timeout');
  return (
    <div className="space-y-3" data-hook-editor="legacy">
      <div className="grid gap-1">
        <span className={FORM_LABEL}>{t('st.hooks.event')}</span>
        <SettingsSelect<LegacyHookConfig['event']>
          variant="form"
          dataAttr="data-hook-event"
          ariaLabel={t('st.hooks.event')}
          value={rule.event}
          onChange={(next) => onChange({ event: next })}
          choices={LEGACY_HOOK_EVENTS.map((event) => ({ value: event, label: t(`st.hooks.event.${event}`) }))}
        />
        {eventIssue !== null ? <p role="alert" data-hook-issue="event" className="text-[12px] leading-4 text-danger">{eventIssue}</p> : null}
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${idPrefix}-command`} className={FORM_LABEL}>{t('st.hooks.command')}</label>
        <textarea
          id={`${idPrefix}-command`}
          className={`${INPUT} min-h-16 font-mono`}
          value={rule.command}
          aria-invalid={commandIssue !== null}
          onChange={(event) => onChange({ command: event.target.value })}
        />
        {commandIssue !== null
          ? <p role="alert" data-hook-issue="command" className="text-[12px] leading-4 text-danger">{commandIssue}</p>
          : <Hint>{t('st.hooks.commandHint')}</Hint>}
      </div>
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_10rem]">
        <div className="grid gap-1">
          <label htmlFor={`${idPrefix}-matcher`} className={FORM_LABEL}>{t('st.hooks.matcher')}</label>
          <input
            id={`${idPrefix}-matcher`}
            className={INPUT}
            value={rule.matcher ?? ''}
            aria-invalid={matcherIssue !== null}
            onChange={(event) => onChange({ matcher: event.target.value === '' ? undefined : event.target.value })}
          />
          {matcherIssue !== null ? <p role="alert" data-hook-issue="matcher" className="text-[12px] leading-4 text-danger">{matcherIssue}</p> : null}
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${idPrefix}-timeout`} className={FORM_LABEL}>{t('st.hooks.timeout')}</label>
          <input
            id={`${idPrefix}-timeout`}
            type="number"
            min={1}
            max={600}
            step={1}
            placeholder="30"
            className={INPUT}
            value={rule.timeout ?? ''}
            aria-invalid={timeoutIssue !== null}
            onChange={(event) => onChange({ timeout: event.target.value === '' ? undefined : Number(event.target.value) })}
          />
          {timeoutIssue !== null ? <p role="alert" data-hook-issue="timeout" className="text-[12px] leading-4 text-danger">{timeoutIssue}</p> : null}
        </div>
      </div>
      <Hint>{t('st.hooks.matchHint')}</Hint>
      <div>
        <button type="button" className={DANGER_GHOST_BUTTON} aria-label={t('st.hooks.removeRule', { rule: ruleLabel })} onClick={onRemove}>
          {t('st.hooks.remove')}
        </button>
      </div>
    </div>
  );
}
