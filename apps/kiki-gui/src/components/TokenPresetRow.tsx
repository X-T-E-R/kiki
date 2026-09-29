/**
 * TokenPresetRow — a row of one-click token values (context windows,
 * compaction points). Quiet at rest (text only); the value that matches the
 * current setting is the raised paper chip, never an accent fill.
 */

import { formatPresetTokens } from '../lib/autoCompact';

export function TokenPresetRow({
  values,
  current,
  onPick,
  label,
  disabled = false,
  dataAttribute,
}: {
  values: readonly number[];
  current: number | undefined;
  onPick: (value: number) => void;
  /** Accessible group name, e.g. "Common compaction points". */
  label: string;
  disabled?: boolean;
  dataAttribute?: string;
}) {
  if (values.length === 0) return null;
  return (
    <div role="group" aria-label={label} data-token-presets={dataAttribute} className="flex flex-wrap items-center gap-0.5">
      {values.map((value) => {
        const selected = value === current;
        return (
          <button
            key={value}
            type="button"
            data-token-preset={value}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => { onPick(value); }}
            className={`h-7 rounded-md px-2 font-mono text-[12px] tabular-nums outline-none transition-colors duration-[var(--kiki-motion-quick)] focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:text-ink-faint pointer-coarse:h-10 pointer-coarse:px-3 ${
              selected
                ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                : 'text-ink-soft hover:bg-ink/[0.04] hover:text-ink'
            }`}
          >
            {formatPresetTokens(value)}
          </button>
        );
      })}
    </div>
  );
}
