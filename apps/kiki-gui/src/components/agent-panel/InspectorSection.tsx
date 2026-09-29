/**
 * InspectorSection — the one chapter shape of the session inspector: a quiet
 * sans label with an optional count, and the body. A chapter that folds is a
 * button with the family chevron beside its label (and a summary on the right
 * while folded); a fixed chapter is just the label. No icons: in a column of
 * short chapters the label alone reads, and a glyph per head is noise.
 */

import { useState, type ReactNode } from 'react';

import { DisclosureChevron } from '../icons';

export function InspectorChevron({ open }: { open: boolean }) {
  // The family chevron (icons.tsx), so every rail chapter, the plan and the
  // todo heads share one mark with the timeline and the settings lists.
  return <DisclosureChevron open={open} />;
}

/** Chapter label type: one size and weight for every inspector head. */
export const INSPECTOR_HEAD = 'shrink-0 text-[12px] font-medium text-ink-soft';

export function InspectorSection({
  title,
  count,
  summary,
  actions,
  collapsible = true,
  defaultOpen = true,
  onOpenChange,
  children,
  ...data
}: {
  title: string;
  count?: number;
  /** Right-aligned hint shown while folded (e.g. "kimi-code/k3 · high"). */
  summary?: ReactNode;
  /** Controls beside the header row, outside the toggle button. */
  actions?: ReactNode;
  /** False: a fixed chapter, label only, always open. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  const [openState, setOpen] = useState(defaultOpen);
  const open = !collapsible || openState;
  const label = (
    <>
      <span className={INSPECTOR_HEAD}>{title}</span>
      {count !== undefined ? <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">{count}</span> : null}
    </>
  );
  return (
    <section {...data}>
      <div className="flex min-h-7 items-center gap-1">
        {collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
              onOpenChange?.(!open);
            }}
            className="group -mx-1.5 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
          >
            {label}
            <InspectorChevron open={open} />
            {!open && summary !== undefined ? (
              <span className="ml-auto min-w-0 truncate pl-2 text-[12px] text-ink-faint">{summary}</span>
            ) : null}
          </button>
        ) : (
          <h3 className="flex h-7 min-w-0 flex-1 items-center gap-1.5">{label}</h3>
        )}
        {actions}
      </div>
      {open ? <div className="pt-1">{children}</div> : null}
    </section>
  );
}

/** Label / value row for inspector definition lists. */
export function InspectorRow({
  label,
  children,
  title,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  title?: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)] items-baseline gap-3 py-0.5">
      <dt className="truncate text-[12.5px] text-ink-faint">{label}</dt>
      <dd
        className={`min-w-0 truncate text-right text-ink tabular-nums ${mono ? 'font-mono text-[11.5px]' : 'text-[12.5px]'}`}
        title={title}
      >
        {children}
      </dd>
    </div>
  );
}

/** Quiet inline action inside the inspector (no underline, accent on hover). */
export const INSPECTOR_LINK =
  'inline-flex h-7 items-center gap-1 rounded-md px-1.5 -mx-1.5 text-[12.5px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent';
