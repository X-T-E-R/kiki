/**
 * The timeline's two lanes.
 *
 * Conversation (user bubbles, assistant prose) owns the full content column.
 * Everything the agent *did* — tool steps, file writes, dispatches, markers,
 * memory, stops — is an ACTIVITY row: inset by one glyph column so every
 * glyph lands on the same x. That shared column IS the hierarchy; no rail is
 * drawn, because an aligned column already reads as one lane and a drawn line
 * would collide with the step group's own spine.
 *
 * Trailing facts (±stats, duration, outcome, disclosure) sit in fixed-width
 * columns, so a dense stretch reads as a table of what happened rather than a
 * ragged list. Chosen over a panel-tone "activity block" after rendering both:
 * the block frame violates the no-card-inside-card rule and its boundaries
 * imply grouping the data does not have.
 *
 * Settled actions stay in place at their timestamp and are never folded behind
 * a bare counter — the aggregate row is exactly what draws complaints in the
 * reference apps, so a quiet line that still names its file or command wins
 * over a tidy "N actions".
 */

import type { ReactNode } from 'react';

import { DisclosureChevron } from '../icons';

/** Glyph column + gap: the one measurement every activity row shares. */
export const ACTIVITY_GUTTER = 'pl-[26px]';

export type ActivityTone = 'plain' | 'danger' | 'warn' | 'accent';

/**
 * The verb's weight. A settled line speaks at ink-soft so a dense stretch of
 * completed work reads as one quiet column; a live, failed, stopped or
 * waiting line is lifted back to ink so the eye lands on what still matters.
 */
const LABEL_TONE: Record<ActivityTone, string> = {
  plain: 'text-ink-soft',
  danger: 'text-ink',
  warn: 'text-ink',
  accent: 'text-ink',
};

const DETAIL_TONE: Record<ActivityTone, string> = {
  plain: 'text-ink-faint',
  danger: 'text-danger',
  warn: 'text-amber-ink',
  accent: 'text-accent-ink',
};

const GLYPH_TONE: Record<ActivityTone, string> = {
  plain: 'text-ink-faint',
  danger: 'text-danger',
  warn: 'text-amber-rule',
  accent: 'text-accent',
};

/**
 * A failure is a lit line, not a red card: the wash spans the row (gutter
 * included) so a scan catches it, while the type stays the size of its
 * neighbours so it does not shout.
 */
const ROW_TONE: Record<ActivityTone, string> = {
  plain: 'hover:bg-ink/[0.04]',
  danger: 'bg-danger/[0.05] hover:bg-danger/[0.09]',
  warn: 'hover:bg-amber-card/60',
  accent: 'hover:bg-ink/[0.04]',
};

/** Fixed trailing columns — the axis the dense stretches align to. */
const STATS_COLUMN = 'min-w-[52px] shrink-0 text-right font-mono text-[12px] tabular-nums text-ink-faint';
const META_COLUMN = 'min-w-[46px] shrink-0 text-right text-[12px] tabular-nums whitespace-nowrap text-ink-faint';
const META_COLUMN_AUTO = 'shrink-0 text-right text-[12px] whitespace-nowrap text-ink-faint';
const STATUS_COLUMN = 'flex h-3.5 w-3.5 shrink-0 items-center justify-center';

export interface ActivityRowProps {
  /** Single character or small node, centred in the glyph column. */
  readonly glyph: ReactNode;
  /** The verb: what happened. Sentence case; never a bare tool identifier. */
  readonly label: ReactNode;
  /** The object: path, command, query, agent name. Carries the tone. */
  readonly detail?: ReactNode;
  readonly tone?: ActivityTone;
  /** Counting column: diff stats (`+n −n`) or a short count ("3 tool calls"). */
  readonly stats?: ReactNode;
  /** Duration / relative time column. */
  readonly meta?: ReactNode;
  readonly metaTitle?: string;
  /**
   * `fixed` (default) keeps the numeric column width so durations align down
   * the run. `auto` is for a named state ("Pending delivery") that must stay
   * readable words rather than being clipped into the numeric column.
   */
  readonly metaWidth?: 'fixed' | 'auto';
  /** Outcome mark column. */
  readonly status?: ReactNode;
  /** Present = the row discloses a body; absent = no chevron column. */
  readonly expanded?: boolean;
  readonly onToggle?: () => void;
  /** Set when the glyph column itself is the disclosure affordance. */
  readonly chevronInGlyph?: boolean;
  /** Row click when the row is a jump rather than a disclosure. */
  readonly onOpen?: () => void;
  readonly title?: string;
  readonly ariaLabel?: string;
  /** data-* hooks that must land on the clickable element itself. */
  readonly buttonAttrs?: Record<string, string | number | boolean | undefined>;
  /** Body revealed under the row, already inset to the gutter. */
  readonly children?: ReactNode;
  /** Trailing controls outside the row button (a second affordance). */
  readonly aside?: ReactNode;
  /** data-* hooks and ids the tests and proofs address. */
  readonly attrs?: Record<string, string | number | boolean | undefined>;
  readonly className?: string;
  /** Rendered inside a read-run's spine: the hover wash stops at the spine. */
  readonly nested?: boolean;
}

/**
 * One activity line. The interactive surface bleeds 8px past the content
 * column on both sides, so the hover wash reads as a full-width log line
 * while the text stays on the column's grid.
 */
export function ActivityRow({
  glyph,
  label,
  detail,
  tone = 'plain',
  stats,
  meta,
  metaTitle,
  metaWidth = 'fixed',
  status,
  expanded,
  onToggle,
  chevronInGlyph = false,
  onOpen,
  title,
  ariaLabel,
  buttonAttrs,
  children,
  aside,
  attrs,
  className = '',
  nested = false,
}: ActivityRowProps) {
  const interactive = onToggle ?? onOpen;
  const inner = (
    <>
      {/* The glyph column is a fixed 18px box so drawn icons, status dots and
          the step chevron all centre on one vertical axis. */}
      <span aria-hidden className={`flex h-4 w-[18px] shrink-0 items-center justify-center ${GLYPH_TONE[tone]}`}>
        {glyph}
      </span>
      <span className={`shrink-0 font-sans text-[13px] font-medium ${LABEL_TONE[tone]}`}>{label}</span>
      {detail === undefined ? (
        <span className="min-w-0 flex-1" />
      ) : (
        <span className={`min-w-0 flex-1 truncate font-sans text-[12px] ${DETAIL_TONE[tone]}`}>{detail}</span>
      )}
      {stats === undefined ? null : <span className={STATS_COLUMN}>{stats}</span>}
      {meta === undefined ? null : (
        <span
          title={metaTitle}
          className={metaWidth === 'auto' ? META_COLUMN_AUTO : META_COLUMN}
        >
          {meta}
        </span>
      )}
      {status === undefined ? null : <span className={STATUS_COLUMN}>{status}</span>}
      {/* The disclosure chevron is an interaction hint, not a state: it keeps
          its column but only shows on hover, keyboard focus, or while open. */}
      {onToggle === undefined || chevronInGlyph ? null : (
        <DisclosureChevron
          open={expanded === true}
          className={`text-ink-faint ${expanded === true ? '' : 'opacity-0 group-hover/act:opacity-100 group-focus-visible/act:opacity-100'}`}
        />
      )}
    </>
  );
  // Top-level rows bleed 8px past the content column's left edge (34px back
  // over the 26px gutter). A nested row sits on the read-run spine instead:
  // its wash starts one pixel right of the spine and never crosses it.
  const bleed = nested
    ? '-ml-[17px] w-[calc(100%+25px)] pl-[17px]'
    : '-ml-[34px] w-[calc(100%+42px)] pl-[34px]';
  const shell = `group/act flex min-h-[26px] items-center gap-2 rounded-md py-0.5 text-left transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${ROW_TONE[tone]} ${bleed} pr-2`;
  return (
    <div data-activity-row title={title} className={`anim-enter ${className}`} {...attrs}>
      <div className="flex items-center gap-1">
        {interactive === undefined ? (
          <div className={shell}>{inner}</div>
        ) : (
          <button
            type="button"
            onClick={interactive}
            aria-expanded={onToggle === undefined ? undefined : expanded === true}
            aria-label={ariaLabel}
            data-activity-toggle
            className={shell}
            {...buttonAttrs}
          >
            {inner}
          </button>
        )}
        {aside}
      </div>
      {children === undefined ? null : <div className="pt-1 pb-1.5">{children}</div>}
    </div>
  );
}

/** Diff stats in the stats column: additions then deletions, never zero-filled. */
export function ActivityStats({ insertions, deletions }: { insertions: number; deletions: number }) {
  return (
    <>
      <span className="text-success">+{insertions}</span>{' '}
      <span className="text-danger">−{deletions}</span>
    </>
  );
}

/**
 * A boundary in the log rather than an event in it: compaction, the start of
 * history, a resume. Centred hairline rule with the fact set into it — the one
 * shape allowed to span the whole column, because it separates regions.
 */
export function TimelineDivider({
  children,
  tone = 'plain',
  attrs,
  title,
}: {
  children: ReactNode;
  tone?: 'plain' | 'warn';
  attrs?: Record<string, string | number | boolean | undefined>;
  title?: string;
}) {
  const rule = tone === 'warn' ? 'bg-amber-rule/40' : 'bg-hairline';
  const text = tone === 'warn' ? 'text-amber-ink' : 'text-ink-faint';
  return (
    <div data-timeline-divider className="anim-enter flex items-center gap-3 py-1" title={title} {...attrs}>
      <span className={`h-px flex-1 ${rule}`} />
      <span className={`shrink-0 text-[12px] ${text}`}>{children}</span>
      <span className={`h-px flex-1 ${rule}`} />
    </div>
  );
}

/**
 * The activity lane: every child row hangs off the shared glyph column.
 * Applied per row (not to a wrapper) because the virtualizer gives each
 * display node its own row box — a lane wrapper would have to span rows.
 */
export const ACTIVITY_LANE = ACTIVITY_GUTTER;
