/**
 * Collapsible capability group — the skill catalog's section primitive.
 * Header = name + count pill + chevron; the body folds with the shared
 * `.expand-collapse` grid-rows transition (0fr ↔ 1fr, inner overflow hidden).
 * Structure follows the donor plugin group card; all chrome is kiki tokens.
 */

import type { ReactNode } from 'react';

export function CapabilityGroup({
  id,
  title,
  count,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section
      data-capability-group={id}
      className="rounded-2xl border border-hairline bg-panel shadow-[0_2px_4px_rgba(28,25,23,0.03)]"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`cap-group-body-${id}`}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-2xl px-4 py-3 text-left transition-colors hover:bg-paper/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      >
        <span className="min-w-0 flex-1 truncate font-display text-[14px] font-semibold text-ink">
          {title}
        </span>
        <span className="shrink-0 rounded-full border border-hairline bg-paper px-1.5 py-px font-mono text-[10px] text-ink-faint tabular-nums">
          {count}
        </span>
        <span
          aria-hidden
          className={`shrink-0 text-[11px] text-ink-faint transition-transform duration-150 ${
            open ? 'rotate-180' : ''
          }`}
        >
          ▾
        </span>
      </button>
      <div
        id={`cap-group-body-${id}`}
        className="expand-collapse grid"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="space-y-2 px-4 pb-4">{children}</div>
        </div>
      </div>
    </section>
  );
}
