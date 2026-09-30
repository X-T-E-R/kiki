/**
 * Collapsible capability group — the skill catalog's section primitive.
 * Header = name + count pill + chevron; the body folds with the shared
 * `.expand-collapse` grid-rows transition (0fr ↔ 1fr, inner overflow hidden).
 * Structure follows the donor plugin group card; all chrome is kiki tokens.
 */

import type { ReactNode } from 'react';

import { Icon } from '../icons';

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
      className="rounded-2xl border border-hairline bg-panel shadow-[0_2px_4px_rgb(var(--kiki-shadow-ink)/0.03)]"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`cap-group-body-${id}`}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded-2xl px-4 py-3 text-left transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/30"
      >
        <span className="min-w-0 truncate text-[13px] font-medium text-ink">
          {title}
        </span>
        <span className="mr-auto shrink-0 text-[12px] text-ink-faint tabular-nums">
          {count}
        </span>
        <span
          aria-hidden
          className={`flex shrink-0 text-ink-faint transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${
            open ? 'rotate-180' : ''
          }`}
        >
          <Icon name="chevron" size={12} className="rotate-90" />
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
