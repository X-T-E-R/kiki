/**
 * Thread reference chip — a link to another Kiki thread, shown the same way in
 * the composer (tray, removable) and in the sent user bubble (inline, opens the
 * thread). Reads as a quiet token: status dot, title (short id when untitled),
 * the workspace in faint type. It sits inside prose, so it stays one line high
 * and never takes more width than a long title needs.
 *
 * Right-click (or the context-menu key) opens the chip menu: "Open a room
 * with these threads" takes every thread linked in the same message, plus
 * the conversation it sits in when that is known.
 */

import { useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';

import { findThreadRefs, shortThreadId, threadRefLink, threadRefStatusOf } from '@kiki/session-core/composer';
import { useI18n } from '../i18n';
import { lifeOf } from '../lib/motion';
import { useThreadRefDirectory, type ThreadRefEntry } from '../lib/threadRefs';
import { useGuardedNavigate } from './dirtyGuard';
import { Icon } from './icons';
import { LifeMark } from './LifeMark';
import { MiniContextMenu } from './MiniContextMenu';
import { NewThreadRoomDialog } from './room/ThreadRoomDialogs';
import { roomEligibleThreads, useThreadCommsEnabled } from './room/threadRooms';

export function ThreadRefChip({
  sessionId,
  entry,
  onRemove,
  inline = false,
  group,
}: {
  sessionId: string;
  entry: ThreadRefEntry;
  /** Every thread linked alongside this one (the same draft or message). */
  group?: readonly ThreadRefEntry[];
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
  const room = useChipRoomMenu(entry, group);
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
      <span data-thread-ref-chip={sessionId} data-thread-ref-status={status} title={tooltip} className={`${shape} pr-1`} onContextMenu={room.onContextMenu}>
        <Icon name="thread" size={12} className="shrink-0 text-ink-faint" />
        {body}
        <span className="sr-only">{statusText}</span>
        <button
          type="button"
          aria-label={t('threadRef.remove', { title: label })}
          title={t('threadRef.remove', { title: label })}
          onClick={onRemove}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
        >
          <Icon name="close" size={12} />
        </button>
        {room.overlay}
      </span>
    );
  }
  return (
    <>
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
      onContextMenu={room.onContextMenu}
      className={`${shape} ${inline ? '' : 'pr-2.5'} no-underline transition-colors hover:bg-paper focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none`}
    >
      {body}
    </a>
    {room.overlay}
    </>
  );
}

/** The chip's context menu; the menu and its dialog mount only once opened. */
function useChipRoomMenu(entry: ThreadRefEntry, group: readonly ThreadRefEntry[] | undefined) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  };
  const overlay = menu === null ? null : <ChipRoomMenu x={menu.x} y={menu.y} entry={entry} group={group} onClose={() => { setMenu(null); }} />;
  return { onContextMenu, overlay };
}

function ChipRoomMenu({ x, y, entry, group, onClose }: {
  readonly x: number;
  readonly y: number;
  readonly entry: ThreadRefEntry;
  readonly group: readonly ThreadRefEntry[] | undefined;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const { id: currentId } = useParams();
  const [dialog, setDialog] = useState(false);
  const commsEnabled = useThreadCommsEnabled();
  const current = useThreadRefDirectory(currentId === undefined ? [] : [currentId]).lookup(currentId ?? '').session;
  const linked = [...(group ?? [entry]), entry].flatMap((item) => item.session === undefined ? [] : [item.session]);
  const threads = roomEligibleThreads([...new Map([...(current === undefined ? [] : [current]), ...linked].map((item) => [item.id, item])).values()]);
  if (dialog) return <NewThreadRoomDialog threads={threads} onClose={onClose} />;
  return (
    <MiniContextMenu x={x} y={y} ariaLabel={t('room.withThreads')} overlayId="thread-ref-chip-menu" dataAttribute="data-thread-ref-chip-menu"
      onClose={() => { if (!dialog) onClose(); }}
      entries={commsEnabled === false
        ? [{ key: 'room-comms-off', label: t('room.commsOffShort'), run: () => undefined }]
        : [{ key: 'room-with-threads', label: t('room.withThreads'), run: () => { setDialog(true); } }]} />
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
  const group = refs.map((ref) => directory.lookup(ref.sessionId));
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const ref of refs) {
    if (ref.start > cursor) parts.push(<span key={`t-${cursor}`}>{projectSegment(text.slice(cursor, ref.start))}</span>);
    parts.push(<ThreadRefChip key={`r-${ref.start}`} sessionId={ref.sessionId} entry={directory.lookup(ref.sessionId)} group={group} inline />);
    cursor = ref.end;
  }
  if (cursor < text.length) parts.push(<span key={`t-${cursor}`}>{projectSegment(text.slice(cursor))}</span>);
  return <>{parts}</>;
}
