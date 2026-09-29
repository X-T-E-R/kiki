/**
 * Temporary picker for the round-3 style tiers (R1 / R2 / R3). Review only;
 * removed when a tier is chosen.
 */

import { FOCUS_RING } from './shell';
import { RAIL_VARIANTS, type RailVariant } from './tone';

export function VariantSwitch({ variant, onChoose }: { variant: RailVariant; onChoose: (next: RailVariant) => void }) {
  return (
    <div role="radiogroup" aria-label="样式档" data-rail-variant-switch className="flex shrink-0 items-center">
      {RAIL_VARIANTS.map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={variant === value}
          data-rail-variant-option={value}
          onClick={() => { onChoose(value); }}
          className={`h-6 rounded px-1 font-mono text-[11px] uppercase transition-colors ${variant === value ? 'text-ink underline underline-offset-4' : 'text-ink-faint hover:text-ink'} ${FOCUS_RING}`}
        >
          {value}
        </button>
      ))}
    </div>
  );
}
