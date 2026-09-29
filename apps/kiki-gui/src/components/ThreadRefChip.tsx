/**
 * Thread reference chip — a link to another Kiki thread, shown the same way in
 * the composer (tray, removable) and in the sent user bubble (inline, opens the
 * thread). Reads as a quiet token: status dot, title (short id when untitled),
 * the workspace in faint type. It sits inside prose, so it stays one line high
 * and never takes more width than a long title needs.
 */

import type { ReactNode } from 'react';

import { findThreadRefs, shortThreadId, threadRefLink, threadRefStatusOf } from '@kiki/session-core/composer';
import { useI18n } from '../i18n';
import { lifeOf } from '../lib/motion';
import { useThreadRefDirectory, type ThreadRefEntry } from '../lib/threadRefs';
import { useGuardedNavigate } from './dirtyGuard';
import { Icon } from './icons';
import { LifeMark } from './LifeMark';

export function ThreadRefChip({
  sessionId,
  entry,
  onRemove,
  inline = false,
}: {
  sessionId: string;
  entry: ThreadRefEntry;
  /** Composer tray: the × removes the link from the draft. */
  onRemove?: () => void;
  /** Inside a user bubble: sized to the running text. */
  inline?: boolean;
}) {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const session = entry.session;
  const title = session !== undefined && session.title.trim() !== '' ? session.title.trim() : undefined;
  const label = title ?? t('threadRef.unknown', { id: shortThreadId(sessionId) });
  const status = threadRefStatusOf(session);
  const statusText = t(`threadRef.status.${status}`);
  const workspace = entry.workspace?.name;
  const life = session === undefined ? 'idle' : lifeOf(session);
  const tooltip = [label, workspace, session === undefined ? t('threadRef.notLoaded') : statusText, sessionId]
    .filter((part) => part !== undefined)
    .join(' · ');
  const body = (
    <>
      {/* Status dot slot: always reserved so chips line up; idle draws a
          hollow ring, so the dot never means "nothing here". */}
      <span aria-hidden className="flex h-3 w-3 shrink-0 items-center justify-center">
        {life === 'idle' ? (
          <span className="h-[6px] w-[6px] rounded-full border border-ink-faint/70" />
        ) : (
          <LifeMark markId={`ref:${sessionId}`} life={life} still className="h-[6px] w-[6px]" tone={life === 'waiting' ? 'bg-attention' : undefined} />
        )}
      </span>
      <span className="min-w-0 truncate font-medium text-ink">{label}</span>
      {workspace !== undefined ? <span className="shrink-0 text-ink-faint">{workspace}</span> : null}
    </>
  );
  const shape = inline
    ? 'mx-0.5 inline-flex h-[22px] max-w-[18rem] translate-y-[-1px] items-center gap-1 rounded-md bg-paper/80 px-1.5 align-middle text-[12.5px] leading-none shadow-[inset_0_0_0_1px_var(--color-hairline)]'
    : 'context-chip anim-enter flex h-8 max-w-[18rem] min-w-0 items-center gap-1.5 rounded-[10px] bg-ink/[0.045] pl-2 text-[12px]';
  if (onRemove !== undefined) {
    return (
      <span data-thread-ref-chip={sessionId} data-thread-ref-status={status} title={tooltip} className={`${shape} pr-1`}>
        <Icon name="thread" size={12} className="shrink-0 text-ink-faint" />
        {body}
        <span className="sr-only">{statusText}</span>
        <button
          type="button"
          aria-label={t('threadRef.remove', { title: label })}
          title={t('threadRef.remove', { title: label })}
          onClick={onRemove}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
        >
          <Icon name="close" size={12} />
        </button>
      </span>
    );
  }
  return (
    <a
      href={threadRefLink(sessionId)}
      data-thread-ref-chip={sessionId}
      data-thread-ref-status={status}
      title={tooltip}
      aria-label={`${t('threadRef.open', { title: label })} · ${statusText}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(threadRefLink(sessionId));
      }}
      className={`${shape} ${inline ? '' : 'pr-2.5'} no-underline transition-colors hover:bg-paper focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none`}
    >
      {body}
    </a>
  );
}

/**
 * User-bubble projection: every thread link in `text` becomes an inline chip;
 * the text between links goes through `projectSegment` (the `@agent` chips).
 */
export function ThreadRefText({
  text,
  projectSegment,
}: {
  text: string;
  projectSegment: (segment: string) => ReactNode;
}) {
  const refs = findThreadRefs(text);
  const directory = useThreadRefDirectory(refs.map((ref) => ref.sessionId));
  if (refs.length === 0) return <>{projectSegment(text)}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const ref of refs) {
    if (ref.start > cursor) parts.push(<span key={`t-${cursor}`}>{projectSegment(text.slice(cursor, ref.start))}</span>);
    parts.push(<ThreadRefChip key={`r-${ref.start}`} sessionId={ref.sessionId} entry={directory.lookup(ref.sessionId)} inline />);
    cursor = ref.end;
  }
  if (cursor < text.length) parts.push(<span key={`t-${cursor}`}>{projectSegment(text.slice(cursor))}</span>);
  return <>{parts}</>;
}
