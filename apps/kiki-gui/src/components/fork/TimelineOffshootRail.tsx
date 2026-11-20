/**
 * Inline departure rail rendered directly beneath a conversation turn from
 * which child `Fork` sessions or in-session `Branch` lanes diverged.
 *
 * Uses a restrained 1.5px curved paper-ink elbow (`╰─`) with compact pills
 * (`fit-content`, zero horizontal viewport theft) and collapses past 2 items.
 */

import { memo, useState } from 'react';

import { useI18n } from '../../i18n';
import type { BranchLifecycleState } from '../agent-panel/InspectorBranches';
import { Icon } from '../icons';
import type { TimelineOffshootItem } from './forkLineageModel';

const INLINE_VISIBLE_CAP = 2;

function branchDotClass(state: BranchLifecycleState | undefined): string | undefined {
  switch (state) {
    case 'waiting':
      return 'bg-attention';
    case 'running':
      return 'bg-accent animate-pulse';
    case 'failed':
      return 'bg-danger';
    default:
      return undefined;
  }
}

export const TimelineOffshootRail = memo(function TimelineOffshootRail({
  items,
  align = 'left',
  onOpenFork,
  onOpenBranch,
}: {
  items: readonly TimelineOffshootItem[] | undefined;
  align?: 'left' | 'right';
  onOpenFork: (sessionId: string) => void;
  onOpenBranch: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  if (items === undefined || items.length === 0) return null;

  const hiddenCount = items.length - INLINE_VISIBLE_CAP;
  const visible = expanded || hiddenCount <= 0 ? items : items.slice(0, INLINE_VISIBLE_CAP);

  return (
    <div
      data-timeline-offshoot-rail
      className={`mt-5 flex items-start gap-1.5 ${align === 'right' ? 'justify-end pr-0.5' : 'pl-2'}`}
    >
      {align === 'left' ? (
        <span
          aria-hidden
          className="mt-0.5 h-3 w-3 shrink-0 rounded-bl-[6px] border-b border-l border-hairline-strong"
        />
      ) : null}
      <div className="flex max-w-full flex-wrap items-center gap-1.5">
        {visible.map((item) => {
          const dotClass = item.kind === 'branch' ? branchDotClass(item.branchState) : undefined;
          const isMerged = item.kind === 'branch' && item.branchState === 'merged';
          return (
            <button
              key={item.key}
              type="button"
              data-offshoot-pill={item.kind}
              data-offshoot-id={item.id}
              title={item.summary !== undefined ? `${item.title} — ${item.summary}` : item.title}
              onClick={() => {
                if (item.kind === 'fork') {
                  onOpenFork(item.id);
                } else {
                  onOpenBranch(item.id);
                }
              }}
              className="group/pill inline-flex max-w-[17rem] items-center gap-1.5 rounded-full border border-hairline bg-paper/75 px-2.5 py-0.5 text-[12px] leading-5 text-ink-soft transition-colors hover:border-hairline-strong hover:bg-paper hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink"
            >
              <Icon
                name="branch"
                size={12}
                className={`shrink-0 ${isMerged ? 'text-ink-faint' : 'text-ink-soft'}`}
              />
              {dotClass !== undefined ? (
                <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
              ) : null}
              <span className={`min-w-0 truncate ${isMerged ? 'text-ink-faint' : ''}`}>
                {item.title}
              </span>
              {isMerged ? (
                <span className="shrink-0 text-[11px] text-ink-faint">
                  {t('transcript.branch.sealed')}
                </span>
              ) : null}
              <Icon
                name="arrowRight"
                size={12}
                className="shrink-0 text-ink-faint transition-transform group-hover/pill:translate-x-0.5 group-hover/pill:text-ink-soft"
              />
            </button>
          );
        })}
        {hiddenCount > 0 ? (
          <button
            type="button"
            data-offshoot-more
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((current) => !current);
            }}
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] leading-5 text-ink-faint tabular-nums transition-colors hover:bg-ink/[0.04] hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink"
          >
            {expanded ? t('fork.rail.collapse') : t('fork.rail.moreCount', { count: hiddenCount })}
          </button>
        ) : null}
      </div>
    </div>
  );
});
