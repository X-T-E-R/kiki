/**
 * InspectorSection — the one chapter shape of the session inspector: a quiet
 * sans label (with an optional count and a collapsed-state summary on the
 * right), a rotating chevron, and the body. Every chapter in the rail and in
 * the agent panel parts uses it, so spacing and weight stay uniform.
 */

import { useState, type ReactNode } from 'react';

export function InspectorChevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      fill="none"
      className={`h-2.5 w-2.5 shrink-0 text-ink-faint transition-transform duration-150 ease-out motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
    >
      <path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function InspectorSection({
  title,
  count,
  summary,
  actions,
  defaultOpen = true,
  onOpenChange,
  children,
  ...data
}: {
  title: string;
  count?: number;
  /** Right-aligned hint shown while collapsed (e.g. "kimi-code/k3 · high"). */
  summary?: ReactNode;
  /** Controls beside the header row, outside the toggle button. */
  actions?: ReactNode;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section {...data}>
      <div className="flex min-h-8 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            onOpenChange?.(!open);
          }}
          className="group -ml-1.5 flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
        >
          <span className="shrink-0 text-[12px] font-medium text-ink-soft transition-colors group-hover:text-ink">
            {title}
          </span>
          {count !== undefined ? <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">{count}</span> : null}
          <InspectorChevron open={open} />
          {!open && summary !== undefined ? (
            <span className="ml-auto min-w-0 truncate pl-2 text-[12px] text-ink-faint">{summary}</span>
          ) : null}
        </button>
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
