/**
 * Activity › Thread messages: the most recent cross-thread messages across
 * workspaces, newest first, optionally scoped to one workspace. One row per
 * message: sender → recipient, first line, delivery when it is news, time.
 * The row opens the recipient's prompt; each name opens that thread. Deleted
 * threads read as such and never link. A room delivery reads `# room → thread`
 * with the room line that woke the thread; the room name opens the room.
 */

import { useMemo } from 'react';

import { useI18n } from '../../i18n';
import {
  acceptedIso,
  endpointHref,
  messageJumpHref,
  messageSummary,
  roomMessageSummary,
  type ThreadEndpoint,
  type ThreadMessage,
} from '../../lib/threadMessages';
import { roomHref, useRoomNames } from './roomNames';
import { Icon } from '../icons';
import { RelativeTime } from '../RelativeTime';
import { DeliveryNote, HistoryNote, LoadOlder, loadedMessages, useEndpointName, useThreadMessages } from './commsShared';

function EndpointLink({ endpoint, onOpen }: { readonly endpoint: ThreadEndpoint; readonly onOpen: (href: string) => void }) {
  const name = useEndpointName();
  const href = endpointHref(endpoint);
  if (href === undefined) return <span className="min-w-0 truncate text-ink-faint italic">{name(endpoint)}</span>;
  return (
    <button
      type="button"
      data-comms-endpoint={endpoint.ref.session_id}
      onClick={(event) => { event.stopPropagation(); onOpen(href); }}
      className="min-w-0 truncate rounded-sm text-left font-medium text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink"
    >
      {name(endpoint)}
    </button>
  );
}

function RoomSource({ roomId, onOpen }: { readonly roomId: string; readonly onOpen: (href: string) => void }) {
  const room = useRoomNames(true)(roomId);
  if (!room.exists) return <span className="min-w-0 truncate text-ink-faint italic"># {room.name}</span>;
  return (
    <button type="button" data-comms-room={roomId}
      onClick={(event) => { event.stopPropagation(); onOpen(roomHref(roomId)); }}
      className="min-w-0 truncate rounded-sm text-left font-medium text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink">
      <span aria-hidden className="font-mono font-normal text-ink-faint"># </span>{room.name}
    </button>
  );
}

function MessageRow({
  message,
  workspaceName,
  onOpen,
}: {
  readonly message: ThreadMessage;
  readonly workspaceName: string | undefined;
  readonly onOpen: (href: string) => void;
}) {
  const { t } = useI18n();
  const jump = messageJumpHref(message);
  return (
    <li
      data-activity-comms-item={message.message_id}
      data-comms-delivery-state={message.delivery}
      className="group flex min-h-11 items-start gap-2 rounded-lg px-3 py-1.5 transition-colors hover:bg-ink/[0.04]"
    >
      <span aria-hidden className="flex h-[19px] w-3.5 shrink-0 items-center justify-center text-ink-faint">
        <Icon name="thread" size={12} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[19px]">
          {message.source.kind === 'thread'
            ? <EndpointLink endpoint={message.source.thread} onOpen={onOpen} />
            : <RoomSource roomId={message.source.room_id} onOpen={onOpen} />}
          <Icon name="arrowRight" size={12} className="shrink-0 text-ink-faint" />
          <span className="sr-only">{t('comms.to')}</span>
          <EndpointLink endpoint={message.target} onOpen={onOpen} />
          <RelativeTime at={acceptedIso(message)} className="ml-auto shrink-0 pl-2 text-[12px] leading-4 text-ink-faint tabular-nums" />
        </span>
        <span className="mt-px block truncate text-[12px] leading-4 text-ink-soft">{message.source.kind === 'room' ? roomMessageSummary(message.content, (author, text) => t('comms.roomLine', { author, text })) : messageSummary(message.content)}</span>
        <span className="mt-px flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-faint">
          <DeliveryNote message={message} />
          {workspaceName !== undefined ? (
            <span className="min-w-0 truncate">{message.delivery === 'delivered' ? '' : '· '}{workspaceName}</span>
          ) : null}
        </span>
      </span>
      {jump !== undefined ? (
        <button
          type="button"
          data-comms-jump={message.message_id}
          onClick={() => { onOpen(jump); }}
          aria-label={t('comms.showInConversation')}
          title={t('comms.showInConversation')}
          className="-my-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint opacity-60 transition-[opacity,color,background-color] group-hover:opacity-100 hover:bg-ink/[0.05] hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:opacity-100"
        >
          <Icon name="arrowRight" size={12} />
        </button>
      ) : <span aria-hidden className="w-7 shrink-0" />}
    </li>
  );
}

export function ActivityComms({
  workspaceId,
  workspaceNames,
  onOpen,
}: {
  readonly workspaceId: string | undefined;
  readonly workspaceNames: ReadonlyMap<string, string>;
  readonly onOpen: (href: string) => void;
}) {
  const { t } = useI18n();
  const filter = useMemo(() => (workspaceId === undefined ? {} : { workspace_id: workspaceId }), [workspaceId]);
  const query = useThreadMessages(filter);
  const messages = useMemo(() => loadedMessages(query.data?.pages), [query.data]);
  // Name the workspace only when the list spans several of them.
  const nameOf = (message: ThreadMessage) => workspaceId !== undefined ? undefined
    : workspaceNames.get(message.target.ref.workspace_id)
      ?? (message.source.kind === 'thread' ? workspaceNames.get(message.source.thread.ref.workspace_id) : undefined);

  return (
    <section data-activity-group="comms" aria-label={t('comms.title')} className="flex flex-col gap-0.5">
      <div className="flex h-7 items-center gap-1.5 px-3 text-[12px] leading-4">
        <h2 className="shrink-0 font-medium text-ink-soft">{t('comms.title')}</h2>
        {messages.length > 0 ? <span className="shrink-0 text-ink-faint tabular-nums">{messages.length}{query.hasNextPage ? '+' : ''}</span> : null}
        <span aria-hidden className="text-ink-faint">·</span>
        <span className="min-w-0 flex-1 truncate text-ink-faint">{t('activity.unreadOrder')}</span>
      </div>
      {query.isPending ? <p className="px-3 py-2 text-[12.5px] text-ink-faint">{t('comms.loading')}</p> : null}
      {query.isError ? (
        <p role="alert" className="flex items-center gap-2 px-3 py-2 text-[12.5px] text-ink-soft">
          <span>{t('comms.loadFailed')}</span>
          <button type="button" onClick={() => { void query.refetch(); }}
            className="h-7 rounded-md px-1.5 text-[12.5px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink">
            {t('common.retry')}
          </button>
        </p>
      ) : null}
      {query.historyIncomplete ? <HistoryNote state={query.history?.state === 'error' ? 'error' : 'preparing'} /> : null}
      {query.isSuccess && messages.length === 0 && !query.hasNextPage && !query.historyIncomplete ? (
        <div data-activity-comms-empty className="px-3 pt-8">
          <p className="text-[14px] text-ink">{t('comms.emptyTitle')}</p>
          <p className="mt-1 text-[12.5px] text-ink-soft">{t(workspaceId === undefined ? 'comms.emptyBody' : 'comms.emptyScoped')}</p>
        </div>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {messages.map((message) => (
          <MessageRow key={message.message_id} message={message} workspaceName={nameOf(message)} onOpen={onOpen} />
        ))}
      </ul>
      {query.hasNextPage ? (
        <div className="px-3 pt-1">
          <LoadOlder busy={query.isFetchingNextPage} onLoad={() => { void query.fetchNextPage(); }} />
        </div>
      ) : null}
    </section>
  );
}
