import { useEffect, useId, useState } from 'react';

import { useI18n } from '../../../i18n';
import { FieldIssue } from '../SettingsPrimitives';
import { parseJsonObject } from './model';

export const JSON_TEXTAREA =
  'block min-h-[5.5rem] w-full resize-y rounded-lg border bg-paper px-2.5 py-2 font-mono text-[12px] leading-5 text-ink outline-none transition-colors placeholder:font-sans placeholder:text-ink-faint focus:border-accent disabled:cursor-not-allowed disabled:bg-hairline/20';

/** Pretty JSON for a stored object; empty for "not set". */
export function jsonText(value: unknown): string {
  return value === undefined || value === null ? '' : JSON.stringify(value, null, 2);
}

/**
 * Monospace JSON-object editor that saves itself on blur, like `CommitInput`:
 * a parse error blocks the write and lands under the field; empty clears it.
 */
export function CommitJsonField({ id, label, value, disabled, onCommit }: {
  id: string;
  label: string;
  value: unknown;
  disabled: boolean;
  onCommit: (next: Record<string, unknown> | undefined) => void;
}) {
  const { t } = useI18n();
  const stored = jsonText(value);
  const [text, setText] = useState(stored);
  const [issue, setIssue] = useState<string | null>(null);
  const errorId = useId();
  useEffect(() => { setText(stored); setIssue(null); }, [stored]);
  const commit = () => {
    const parsed = parseJsonObject(text);
    if (!parsed.ok) { setIssue(t('st.notify.jsonInvalid')); return; }
    setIssue(null);
    if (jsonText(parsed.value) !== stored) onCommit(parsed.value);
  };
  return (
    <div className="min-w-0">
      <textarea id={id} aria-label={label} value={text} disabled={disabled} spellCheck={false} autoComplete="off"
        aria-invalid={issue !== null} aria-describedby={issue !== null ? errorId : undefined}
        className={`${JSON_TEXTAREA} ${issue !== null ? 'border-danger' : 'border-hairline hover:border-hairline-strong'}`}
        onChange={(event) => { setText(event.target.value); if (issue !== null) setIssue(null); }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Escape') { setText(stored); setIssue(null); } }} />
      <FieldIssue id={errorId} text={issue} />
    </div>
  );
}
