/**
 * Chip multi-select — known enum options plus a free-form custom entry.
 * Replaces comma-string inputs; output goes through normalizeTags.
 */

import { useState } from 'react';

import { normalizeTags } from '@kiki/session-core/settings';

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
            className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              selected
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-hairline bg-paper text-ink-soft hover:border-hairline-strong hover:text-ink'
            }`}
          >
            {option}
          </button>
        );
      })}
      {customValues.map((value) => (
        <span
          key={value}
          className="inline-flex items-center gap-1 rounded-full border border-accent bg-accent-soft px-2.5 py-0.5 text-[11px] font-medium text-accent"
        >
          {value}
          <button
            type="button"
            disabled={disabled}
            aria-label={removeLabel(value)}
            onClick={() => { toggle(value); }}
            className="text-accent/70 transition-colors hover:text-accent disabled:opacity-50"
          >
            ×
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
