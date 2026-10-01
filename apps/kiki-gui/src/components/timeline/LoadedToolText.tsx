import { useState } from 'react';

import { useI18n } from '../../i18n';
import { toolRecordCopy } from '../toolRecordCopy';
import { CopyButton } from './SubagentInvocationView';

export function recordText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Expanding and copying never discards text already present in the record. */
export function LoadedToolText({
  text,
  limit = 6000,
  copy = true,
  className = 'max-h-60 overflow-auto rounded-md bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink',
}: {
  text: string;
  limit?: number;
  copy?: boolean;
  className?: string;
}) {
  const { locale } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const omitted = !showAll && text.length > limit;
  return (
    <div data-loaded-tool-text>
      {omitted || copy ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-faint">
          <span data-tool-display-status>{omitted ? toolRecordCopy('displayOmitted', locale) : ''}</span>
          {copy ? <span title={toolRecordCopy('loadedOnly', locale)}><CopyButton text={text} /></span> : null}
        </div>
      ) : null}
      <pre className={className}>{omitted ? `${text.slice(0, limit)}\n…` : text}</pre>
      {text.length > limit ? (
        <button type="button" data-tool-show-full aria-expanded={showAll}
          onClick={() => { setShowAll((value) => !value); }}
          className="min-h-7 rounded-md px-2 text-[12px] text-ink-faint underline-offset-2 transition-colors hover:text-ink hover:underline">
          {toolRecordCopy(showAll ? 'collapse' : 'showFull', locale)}
        </button>
      ) : null}
    </div>
  );
}
