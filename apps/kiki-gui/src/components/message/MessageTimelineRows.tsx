/**
 * The quiet rows of the message view: the activity summary between two
 * messages, the presence line at the bottom, a handoff between two Bots,
 * and the one-line outcomes ("没有回复 · 查看过程", a failure). All of them
 * sit on the message text axis (after the face column) in T4 faint type and
 * lift to ink on hover, so the conversation stays the loudest thing.
 */

import { memo, useState, type ReactNode } from 'react';

import type { ActivitySummary, Block, NoticeBlock } from '@kiki/session-core/session';

import { useI18n } from '../../i18n';
import { LifeMark } from '../LifeMark';
import { DisclosureChevron, Icon, Spinner } from '../icons';
import { MESSAGE_FACE } from './MessageRow';

/** Tool calls and shell runs: the same unit the process view's fold counts as steps. */
export function activitySteps(summary: ActivitySummary): number {
  return summary.members.filter((member) => member.kind === 'tool' || member.kind === 'shell').length;
}

/** A settled stretch with nothing to count (only internal prose): it draws no line. */
export function isSilentActivity(summary: ActivitySummary): boolean {
  if (summary.running) return false;
  const { reads, commands, subagents, memories, thinking } = summary.counts;
  return activitySteps(summary) === 0 && reads + commands + subagents + memories + thinking === 0;
}

export function activityParts(
  summary: ActivitySummary,
  t: ReturnType<typeof useI18n>['t'],
  compact: boolean,
): string[] {
  const steps = activitySteps(summary);
  if (compact) return steps > 0 ? [t('message.steps', { count: steps })] : summary.counts.thinking > 0 ? [t('message.thoughts', { count: summary.counts.thinking })] : [];
  const { reads, commands, subagents, memories, thinking } = summary.counts;
  const parts = [
    reads > 0 ? t('message.reads', { count: reads }) : null,
    commands > 0 ? t('message.commands', { count: commands }) : null,
    subagents > 0 ? t('message.subagents', { count: subagents }) : null,
    memories > 0 ? t('message.memories', { count: memories }) : null,
  ].filter((part): part is string => part !== null);
  // Steps the named counts do not cover still count, so the line never
  // claims less work than the process view shows for the same stretch.
  const covered = summary.members.filter((member) =>
    (member.kind === 'tool' && (member.name === 'Read' || member.name === 'Bash' || member.name === 'MemoryWrite'))
    || member.kind === 'shell').length;
  const other = steps - covered;
  if (other > 0) parts.push(parts.length === 0 ? t('message.steps', { count: other }) : t('message.otherSteps', { count: other }));
  if (parts.length === 0 && thinking > 0) parts.push(t('message.thoughts', { count: thinking }));
  return parts;
}

export const ActivitySummaryRow = memo(function ActivitySummaryRow({
  summary,
  renderMember,
  onOpenProcess,
}: {
  readonly summary: ActivitySummary;
  readonly renderMember: (member: Block) => ReactNode;
  readonly onOpenProcess?: () => void;
}) {
  const { t, time } = useI18n();
  const [open, setOpen] = useState(false);
  const full = activityParts(summary, t, false);
  const compact = activityParts(summary, t, true);
  if (full.length === 0 && !summary.running) return null;
  const duration = summary.durationMs !== undefined && summary.durationMs >= 1000 ? time.formatDuration(summary.durationMs) : undefined;
  const failed = summary.failed > 0 ? t('transcript.fold.failed', { count: summary.failed }) : undefined;
  return (
    <div data-activity-summary={summary.id} data-activity-summary-open={open || undefined} className="min-w-0">
      <div className="flex items-center gap-2">
        <span className={MESSAGE_FACE} />
        <button
          type="button"
          aria-expanded={open}
          data-activity-summary-toggle
          onClick={() => { setOpen((value) => !value); }}
          className="group/sum -ml-1.5 flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[12.5px] text-ink-faint transition-colors duration-150 hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span aria-hidden className="shrink-0">·</span>
          <span className="min-w-0 truncate">
            <span className="max-sm:hidden">{full.join(' · ')}</span>
            <span className="sm:hidden">{compact.join(' · ')}</span>
            {failed !== undefined ? <span className="text-danger"> · {failed}</span> : null}
            {duration !== undefined ? <span className="tabular-nums"> · {duration}</span> : null}
          </span>
          <span className="flex-1" />
          {summary.running ? <Spinner label={t('inspector.running')} size={12} /> : null}
          <DisclosureChevron open={open} className="shrink-0 text-ink-faint group-hover/sum:text-ink-soft" />
        </button>
      </div>
      {open ? (
        <div data-activity-summary-members className="mt-1 ml-8 min-w-0 max-sm:ml-7">
          <div className="flex min-w-0 flex-col gap-0.5 border-l border-hairline pl-[17px] max-sm:pl-2.5">
            {summary.members.map((member) => (
              <div key={member.id} data-block-id={member.id} className="min-w-0 overflow-hidden">{renderMember(member)}</div>
            ))}
          </div>
          {onOpenProcess !== undefined ? (
            <button
              type="button"
              data-activity-summary-process
              onClick={onOpenProcess}
              className="mt-1 ml-[18px] inline-flex min-h-7 items-center gap-1 rounded-md px-1 text-[12px] font-medium text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
            >
              {t('message.openProcess')}
              <Icon name="arrowRight" size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/** "林岚 正在处理 · 读了 2 个文件" — one still line, never a breathing card. */
export function PresenceLine({ text, detail }: { readonly text: string; readonly detail?: string }) {
  return (
    <div role="status" aria-live="polite" data-message-presence className="anim-enter flex min-h-6 items-center gap-2">
      <span className={`${MESSAGE_FACE} flex justify-center`}>
        <LifeMark markId="message:presence" life="working" still className="h-1.5 w-1.5" />
      </span>
      <span className="min-w-0 truncate text-[12.5px] text-ink-faint">
        {text}
        {detail !== undefined && detail !== '' ? <span> · {detail}</span> : null}
      </span>
    </div>
  );
}

/** A Bot-to-Bot handoff, identical on both sides: `林岚 → 阿澈：…`. */
export function HandoffRow({
  from,
  to,
  text,
  onOpen,
  openLabel,
}: {
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly onOpen?: () => void;
  readonly openLabel: string;
}) {
  const { t } = useI18n();
  const line = t('message.handoff', { from, to, text: text.replace(/\s+/g, ' ').trim() });
  return (
    <div data-message-handoff className="flex min-w-0 items-center gap-2">
      <span className={`${MESSAGE_FACE} flex justify-center text-ink-faint`}><Icon name="thread" size={12} /></span>
      {onOpen === undefined ? (
        <span className="min-w-0 truncate text-[12.5px] text-ink-faint">{line}</span>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          title={openLabel}
          aria-label={`${line} — ${openLabel}`}
          className="-ml-1.5 flex min-h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-left text-[12.5px] text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="min-w-0 truncate">{line}</span>
          <Icon name="chevron" size={12} className="shrink-0" />
        </button>
      )}
    </div>
  );
}

/** A turn's outcome in the message view: no reply (neutral) or a failure (danger). */
export function OutcomeLine({ notice, onOpenProcess }: { readonly notice: NoticeBlock; readonly onOpenProcess?: () => void }) {
  const { t } = useI18n();
  const text = notice.i18n !== undefined ? t(notice.i18n.key, notice.i18n.params) : notice.text;
  const danger = notice.tone === 'danger';
  const noReply = notice.reasonCodes?.includes('message.no_reply') === true;
  return (
    <div data-message-outcome={noReply ? 'no-reply' : notice.tone} className="flex items-center gap-2">
      <span className={MESSAGE_FACE} />
      <button
        type="button"
        onClick={onOpenProcess}
        disabled={onOpenProcess === undefined}
        className={`-ml-1.5 min-h-7 min-w-0 truncate rounded-md px-1.5 text-left text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default ${
          danger ? 'font-medium text-danger hover:bg-danger/[0.06]' : 'text-ink-faint hover:bg-ink/[0.04] hover:text-ink'
        }`}
      >
        {text}
        {danger ? <span className="font-normal"> · {t('room.openProcess')}</span> : null}
      </button>
    </div>
  );
}
