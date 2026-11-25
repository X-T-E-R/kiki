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
import { plainFailure } from '../agent-panel/failureText';
import { LifeMark } from '../LifeMark';
import { DisclosureChevron, Icon, Spinner } from '../icons';
import { TimelineErrorCallout, type TimelineErrorAction } from '../timeline/TimelineErrorCallout';
import { MESSAGE_FACE } from './MessageRow';

/** Tool calls and shell runs: the same unit the process view's fold counts as steps. */
export function activitySteps(summary: ActivitySummary): number {
  return summary.members.filter((member) => member.kind === 'tool' || member.kind === 'shell').length;
}

/** A settled stretch with nothing to count (only internal prose): it draws no line. */
export function isSilentActivity(summary: ActivitySummary): boolean {
  if (summary.running || summary.failed > 0) return false;
  const { reads, commands, subagents, memories, thinking } = summary.counts;
  return activitySteps(summary) === 0 && reads + commands + subagents + memories + thinking === 0;
}

export function activityParts(
  summary: ActivitySummary,
  t: ReturnType<typeof useI18n>['t'],
  compact: boolean,
): string[] {
  const steps = activitySteps(summary);
  const sentParts = (summary.sentMessages ?? []).map((item) =>
    t('transcript.fold.sentTo', { name: item.name, count: item.count }),
  );
  if (compact) {
    const parts: string[] = [];
    if (steps > 0) parts.push(t('message.steps', { count: steps }));
    if (summary.counts.subagents > 0) parts.push(t('message.subagents', { count: summary.counts.subagents }));
    parts.push(...sentParts);
    if (parts.length === 0 && summary.counts.thinking > 0) parts.push(t('message.thoughts', { count: summary.counts.thinking }));
    return parts.filter((part) => part.trim() !== '');
  }
  const { reads, commands, subagents, memories, thinking } = summary.counts;
  const parts = [
    reads > 0 ? t('message.reads', { count: reads }) : null,
    commands > 0 ? t('message.commands', { count: commands }) : null,
    subagents > 0 ? t('message.subagents', { count: subagents }) : null,
    ...sentParts,
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
  openReader,
}: {
  readonly summary: ActivitySummary;
  readonly renderMember: (member: Block) => ReactNode;
  readonly onOpenProcess?: () => void;
  /** Mounted only while the summary is open, so the stretch's full steps are read on demand and released on collapse. */
  readonly openReader?: ReactNode;
}) {
  const { t, time } = useI18n();
  const [open, setOpen] = useState(false);
  const full = activityParts(summary, t, false);
  const compact = activityParts(summary, t, true);
  if (full.length === 0 && summary.failed === 0 && !summary.running) return null;
  const duration = summary.durationMs !== undefined && summary.durationMs >= 1000 ? time.formatDuration(summary.durationMs) : undefined;
  const failed = summary.failed > 0 ? t('transcript.fold.failed', { count: summary.failed }) : undefined;
  const fullText = full.filter((part) => part.trim() !== '').join(' · ');
  const compactText = compact.filter((part) => part.trim() !== '').join(' · ');
  return (
    <div data-activity-summary={summary.id} data-activity-summary-open={open || undefined} className="min-w-0">
      <div className="flex items-center gap-2">
        <span className={MESSAGE_FACE} />
        <button
          type="button"
          aria-expanded={open}
          data-activity-summary-toggle
          onClick={() => { setOpen((value) => !value); }}
          className="group/sum -ml-1.5 flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[12.5px] text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="min-w-0 truncate">
            {fullText !== '' ? <span className="max-sm:hidden">{fullText}</span> : null}
            {compactText !== '' ? <span className="sm:hidden">{compactText}</span> : null}
            {failed !== undefined ? (
              <span className="text-danger">
                {fullText !== '' ? <span className="max-sm:hidden"> · </span> : null}
                {compactText !== '' ? <span className="sm:hidden"> · </span> : null}
                {failed}
              </span>
            ) : null}
            {duration !== undefined ? (
              <span className="tabular-nums">
                {fullText !== '' || failed !== undefined ? <span className="max-sm:hidden"> · </span> : null}
                {compactText !== '' || failed !== undefined ? <span className="sm:hidden"> · </span> : null}
                {duration}
              </span>
            ) : null}
          </span>
          <span className="flex-1" />
          {summary.running ? <Spinner label={t('inspector.running')} size={12} /> : null}
          <DisclosureChevron open={open} className="shrink-0 text-ink-faint group-hover/sum:text-ink-soft" />
        </button>
      </div>
      {open ? (
        <div data-activity-summary-members className="mt-1 ml-8 min-w-0 max-sm:ml-7">
          {openReader}
          <div className="flex min-w-0 flex-col gap-0.5 border-l border-hairline pl-[17px] max-sm:pl-3">
            {summary.members.map((member) => {
              const rendered = renderMember(member);
              return rendered === null || rendered === undefined ? null : (
                <div key={member.id} data-block-id={member.id} className="min-w-0 overflow-hidden">{rendered}</div>
              );
            })}
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

/** "小柚 正在处理 · 读了 2 个文件" — one still line, never a breathing card. */
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

/** A Bot-to-Bot handoff, identical on both sides: `小柚 → 豆豆：…`. */
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

function cleanOutcomeText(raw: string, danger: boolean): string {
  const deduped = raw
    .replaceAll(/(\s[—–-]\s*)(?:Error:\s*){2,}/gi, '$1Error: ')
    .replace(/^(?:Error:\s*){2,}/i, 'Error: ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (!danger) return deduped;
  return plainFailure(deduped) ?? deduped;
}

export function OutcomeLine({
  notice,
  onOpenProcess,
  superseded = false,
}: {
  readonly notice: NoticeBlock;
  readonly onOpenProcess?: () => void;
  readonly superseded?: boolean;
}) {
  const { t } = useI18n();
  const rawText = notice.i18n !== undefined ? t(notice.i18n.key, notice.i18n.params) : notice.text;
  const danger = notice.tone === 'danger';
  const noReply = notice.reasonCodes?.includes('message.no_reply') === true;

  if (danger) {
    const actions: TimelineErrorAction[] = onOpenProcess === undefined ? [] : [{
      id: 'open-process',
      label: t('room.openProcess'),
      onClick: onOpenProcess,
      dataAttr: 'data-message-outcome-action',
      navigation: true,
    }];
    const cleanedMessage = (notice.text !== '' ? notice.text : rawText)
      .replaceAll(/(\s[—–-]\s*)(?:Error:\s*){2,}/gi, '$1Error: ')
      .replace(/^(?:Error:\s*){2,}/i, 'Error: ');
    return (
      <div data-message-outcome="danger" className="flex min-w-0 items-start gap-2">
        <span className={MESSAGE_FACE} />
        <div className="min-w-0 flex-1">
          <TimelineErrorCallout
            incidentId={`message-outcome-${notice.id}`}
            severity="error"
            message={cleanedMessage}
            errorDetails={notice.errorDetails}
            createdAt={notice.createdAt}
            superseded={superseded}
            actions={actions}
          />
        </div>
      </div>
    );
  }

  const text = cleanOutcomeText(rawText, false);
  return (
    <div data-message-outcome={noReply ? 'no-reply' : notice.tone} className="flex min-w-0 items-center gap-2">
      <span className={MESSAGE_FACE} />
      <button
        type="button"
        onClick={onOpenProcess}
        disabled={onOpenProcess === undefined}
        title={rawText}
        className="-ml-1.5 flex max-w-full min-h-7 min-w-0 items-center rounded-[6px] px-1.5 text-left text-[13px] leading-[20px] font-normal text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default pointer-coarse:min-h-11"
      >
        <span data-message-outcome-text className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
      </button>
    </div>
  );
}
