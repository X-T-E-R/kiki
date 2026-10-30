import type { ReactNode } from 'react';

/**
 * One object in a settings list: a clickable summary (name, subtitle, status
 * marks) with trailing controls (a switch, a ⋯ menu), and an editor that opens
 * inline under the row while the rest of the list stays visible. The summary is
 * the only large hit area, and it only opens — every state change lives on an
 * explicit control next to it (batch rule 10; frame copied from the
 * notifications `ChannelListRow`).
 *
 * No chevron: the open state is a quiet tint on the summary line, so the
 * affordance is the row itself rather than a second arrow beside the menu.
 */
export function RowFrame({ name, subtitle, marks, control, open, onToggle, bodyId, expandLabel, data, children }: {
  readonly name: ReactNode;
  /** Second line in ink-faint: where the object runs, a tag, a reason. */
  readonly subtitle?: ReactNode;
  /** Small facts on the name line (status word with dot, 默认 tag). */
  readonly marks?: ReactNode;
  /** Trailing controls: switches, menus. Clicks here never open the row. */
  readonly control?: ReactNode;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly bodyId: string;
  readonly expandLabel: string;
  readonly data: Record<`data-${string}`, string | undefined>;
  readonly children: ReactNode;
}) {
  return (
    <div {...data} data-open={open ? 'true' : undefined} className="rounded-lg transition-colors">
      <div className={`flex min-h-[52px] items-center gap-2 rounded-lg px-1 py-1.5 transition-colors ${open ? 'bg-ink/[0.03]' : ''}`}>
        <button type="button" aria-expanded={open} aria-controls={bodyId} aria-label={expandLabel} onClick={onToggle}
          className="group/row flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-selected-ink/40">
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-[13.5px] font-medium text-ink" data-row-name>{name}</span>
              {marks}
            </span>
            {subtitle === undefined || subtitle === null ? null : (
              <span className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px] text-ink-faint">{subtitle}</span>
            )}
          </span>
        </button>
        {control !== undefined ? <div className="flex shrink-0 items-center gap-2 pl-1">{control}</div> : null}
      </div>
      <div id={bodyId} hidden={!open} data-row-body className="px-2 pb-4 pt-3">
        {children}
      </div>
    </div>
  );
}
