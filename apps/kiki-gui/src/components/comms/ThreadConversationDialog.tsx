/**
 * The full exchange between this session and one other thread, oldest at the
 * top like a chat log (the server pages newest-first; older pages load at the
 * top). What this session sent sits on the right in the user-bubble ground,
 * what the other thread sent sits on the left on paper — the same sides the
 * timeline uses for "you" and "someone else".
 *
 * Every delivered message links to the recipient's prompt ("Show in …"),
 * located by message id in the recipient session. A deleted recipient, or a
 * message that never reached a prompt, has no link.
 */

import { useMemo } from 'react';

import { useI18n } from '../../i18n';
import {
  acceptedIso,
  endpointHref,
  messageJumpHref,
  peerOf,
  type ThreadEndpoint,
  type ThreadToThreadMessage,
} from '../../lib/threadMessages';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { useGuardedNavigate } from '../dirtyGuard';
import { Icon } from '../icons';
import { RelativeTime } from '../RelativeTime';
import { DeliveryNote, EndpointState, HistoryNote, LoadOlder, loadedPeerMessages, useEndpointName, useThreadMessages } from './commsShared';

const LINK =
  'inline-flex h-7 items-center gap-1 rounded-md px-1.5 -mx-1.5 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-11';

function MessageItem({
  message,
  sessionId,
  onNavigate,
}: {
  readonly message: ThreadToThreadMessage;
  readonly sessionId: string;
  readonly onNavigate: (href: string) => void;
}) {
  const { t, time } = useI18n();
  const name = useEndpointName();
  const { direction } = peerOf(message, sessionId);
  const out = direction === 'out';
  const jump = messageJumpHref(message);
  return (
    <li data-comms-message={message.message_id} data-comms-direction={direction}
      className={`flex flex-col ${out ? 'items-end' : 'items-start'}`}>
      <div className={`max-w-[88%] rounded-xl px-3 py-2 text-[13px] leading-[1.55] text-ink ${
        out ? 'bg-bubble-user' : 'border border-hairline bg-paper'}`}>
        <p className="break-words whitespace-pre-wrap">{message.content}</p>
      </div>
      <div className={`mt-0.5 flex max-w-[88%] min-w-0 flex-wrap items-center gap-x-2 px-1 text-[11.5px] leading-7 text-ink-faint ${out ? 'justify-end' : ''}`}>
        <span title={time.absoluteTime(acceptedIso(message))} className="tabular-nums"><RelativeTime at={acceptedIso(message)} /></span>
        <DeliveryNote message={message} />
        {jump !== undefined ? (
          <button type="button" data-comms-jump={message.message_id} className={LINK}
            onClick={() => { onNavigate(jump); }}>
            {t('comms.showIn', { name: name(message.target) })}
            <Icon name="arrowRight" size={12} className="text-ink-faint" />
          </button>
        ) : null}
      </div>
    </li>
  );
}

export function ThreadConversationDialog({
  sessionId,
  peer,
  onClose,
}: {
  readonly sessionId: string;
  readonly peer: ThreadEndpoint;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const name = useEndpointName();
  const filter = useMemo(
    () => ({ session_id: sessionId, peer_session_id: peer.ref.session_id }),
    [sessionId, peer.ref.session_id],
  );
  const query = useThreadMessages(filter);
  // Oldest first for reading; the server's newest-first pages stack upward.
  const messages = useMemo(() => loadedPeerMessages(query.data?.pages).toReversed(), [query.data]);
  const title = t('comms.pairTitle', { name: name(peer) });
  const peerHref = endpointHref(peer);
  const go = (href: string) => {
    onClose();
    void navigate(href);
  };

  return (
    <Dialog
      onClose={onClose}
      ariaLabel={title}
      overlayId="comms-thread-conversation"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} flex max-h-[min(86vh,760px)] flex-col !p-0`}
    >
      <header data-comms-pair-head className="flex shrink-0 items-start gap-3 border-b border-hairline px-5 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex min-w-0 items-baseline gap-2 font-display text-[18px] font-semibold tracking-tight text-ink">
            <span className="min-w-0 truncate">{title}</span>
            <EndpointState endpoint={peer} />
          </h2>
          <p className="mt-0.5 text-[12px] text-ink-faint">{t('comms.pairHint')}</p>
        </div>
        {peerHref !== undefined ? (
          <button type="button" data-comms-open-peer className={`${LINK} mt-0.5 shrink-0`} onClick={() => { go(peerHref); }}>
            {t('comms.openThread')}
            <Icon name="arrowRight" size={12} className="text-ink-faint" />
          </button>
        ) : null}
        <button type="button" onClick={onClose} aria-label={t('common.close')} data-autofocus
          className="-mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11">
          <Icon name="close" size={16} />
        </button>
      </header>
      <div data-comms-pair-body className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {query.hasNextPage ? (
          <div className="mb-3 flex justify-center">
            <LoadOlder busy={query.isFetchingNextPage} onLoad={() => { void query.fetchNextPage(); }} />
          </div>
        ) : null}
        {query.isPending ? <p className="text-[13px] text-ink-faint">{t('comms.loading')}</p> : null}
        {query.isError ? <p role="alert" className="text-[13px] text-danger">{t('comms.loadFailed')}</p> : null}
        {query.historyIncomplete ? <HistoryNote state={query.history?.state === 'error' ? 'error' : 'preparing'} /> : null}
        {query.isSuccess && messages.length === 0 && !query.hasNextPage && !query.historyIncomplete ? (
          <p data-comms-pair-empty className="text-[13px] text-ink-soft">{t('comms.pairEmpty')}</p>
        ) : null}
        <ol className="space-y-3">
          {messages.map((message) => (
            <MessageItem key={message.message_id} message={message} sessionId={sessionId} onNavigate={go} />
          ))}
        </ol>
      </div>
    </Dialog>
  );
}
