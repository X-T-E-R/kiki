import { useState } from 'react';

import { useI18n } from '../../../i18n';
import { INPUT, SECONDARY_BUTTON } from '../../ui';

/**
 * One-line string collection (rule files, disabled rule ids): mono rows with
 * a quiet remove action, then a single add row that commits on Enter or the
 * add button. Empty and duplicate entries never enter the list.
 */
export function StringListEditor({ items, onChange, addLabel, placeholder, dataAttr }: {
  readonly items: readonly string[];
  readonly onChange: (next: string[]) => void;
  /** Button text and aria-label of the add row. */
  readonly addLabel: string;
  readonly placeholder: string;
  readonly dataAttr?: string;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const add = () => {
    const value = text.trim();
    if (value === '' || items.includes(value)) return;
    onChange([...items, value]);
    setText('');
  };
  return (
    <div className="space-y-1.5" {...(dataAttr !== undefined ? { [dataAttr]: '' } : {})}>
      {items.length > 0 ? (
        <ul className="divide-y divide-hairline">
          {items.map((item) => (
            <li key={item} className="flex items-center gap-2 py-1">
              <span className="min-w-0 flex-1 break-all font-mono text-[12px] text-ink">{item}</span>
              <button
                type="button"
                aria-label={`${t('common.remove')} ${item}`}
                onClick={() => onChange(items.filter((entry) => entry !== item))}
                className="inline-flex min-h-7 shrink-0 items-center text-[12px] text-ink-faint transition-colors hover:text-danger focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
              >
                {t('common.remove')}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        <input
          className={`${INPUT} font-mono`}
          value={text}
          aria-label={addLabel}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }}
        />
        <button type="button" className={`${SECONDARY_BUTTON} shrink-0`} disabled={text.trim() === '' || items.includes(text.trim())} onClick={add}>
          {addLabel}
        </button>
      </div>
    </div>
  );
}
