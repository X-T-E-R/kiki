/**
 * Chip multi-select — known enum options plus a free-form custom entry.
 * Replaces comma-string inputs; output goes through normalizeTags.
 */

import { useState } from 'react';

import { normalizeTags } from '@kiki/session-core/settings';

import { Icon } from './icons';

export interface ChipSelectProps {
  readonly values: readonly string[];
  readonly knownOptions: readonly string[];
  readonly onChange: (values: string[]) => void;
  readonly ariaLabel: string;
  readonly addPlaceholder: string;
  readonly removeLabel: (value: string) => string;
  readonly disabled?: boolean;
}

export function ChipSelect({
  values,
  knownOptions,
  onChange,
  ariaLabel,
  addPlaceholder,
  removeLabel,
  disabled = false,
}: ChipSelectProps) {
  const [custom, setCustom] = useState('');

  const toggle = (value: string) => {
    onChange(
      values.includes(value)
        ? values.filter((entry) => entry !== value)
        : normalizeTags([...values, value]),
    );
  };

  const commitCustom = () => {
    const next = normalizeTags([...values, custom]);
    setCustom('');
    if (next.length !== values.length) onChange(next);
  };

  const customValues = values.filter((value) => !knownOptions.includes(value));

  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap items-center gap-1.5">
      {knownOptions.map((option) => {
        const selected = values.includes(option);
        return (
          <button
            key={option}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => { toggle(option); }}
            // Selected = the raised paper sheet with a check; unselected is
            // quiet text with a dashed hairline so it still reads as a choice.
            className={`inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[12px] transition-colors duration-[var(--kiki-motion-quick)] disabled:cursor-not-allowed disabled:opacity-50 ${
              selected
                ? 'bg-paper pl-2 font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                : 'border border-dashed border-hairline-strong text-ink-soft hover:bg-ink/[0.04] hover:text-ink'
            }`}
          >
            {selected ? <Icon name="check" size={12} className="text-ink-soft" /> : null}
            {option}
          </button>
        );
      })}
      {customValues.map((value) => (
        <span
          key={value}
          className="inline-flex h-6 items-center gap-1 rounded-full bg-paper pr-1 pl-2.5 text-[12px] font-medium text-ink shadow-[var(--kiki-sheet-shadow)]"
        >
          {value}
          <button
            type="button"
            disabled={disabled}
            aria-label={removeLabel(value)}
            onClick={() => { toggle(value); }}
            className="flex h-4 w-4 items-center justify-center rounded text-ink-faint transition-colors hover:text-ink disabled:opacity-50"
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={custom}
        disabled={disabled}
        placeholder={addPlaceholder}
        aria-label={ariaLabel}
        className="w-32 rounded-full border border-dashed border-hairline bg-paper px-2.5 py-0.5 text-[11px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
        onChange={(event) => { setCustom(event.target.value); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            commitCustom();
          }
        }}
        onBlur={commitCustom}
      />
    </div>
  );
}
