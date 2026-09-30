/**
 * Session rail › Thread messages: what this session sent to and received
 * from other threads, grouped by the thread on the other side. A row names
 * the peer, the direction and first line of the latest exchange, and when;
 * pressing it opens the full back-and-forth with that thread.
 *
 * Follows the rail's rule that an empty chapter renders nothing: no section
 * until the first message arrives. A failed read keeps a one-line retry so a
 * session that did talk to others never silently looks like it did not.
 */

import { memo, useMemo, useState } from 'react';

import { useI18n } from '../../i18n';
import { groupByPeer, messageSummary, acceptedIso, type PeerGroup } from '../../lib/threadMessages';
import { InspectorSection } from '../agent-panel/InspectorSection';
import { Icon } from '../icons';
import { RelativeTime } from '../RelativeTime';
import { EndpointState, LoadOlder, loadedMessages, useEndpointName, useThreadMessages } from './commsShared';
import { ThreadConversationDialog } from './ThreadConversationDialog';

/** Peers shown before the rest fold behind "Show all". */
const PEER_PREVIEW = 5;

export function DirectionMark({ direction }: { readonly direction: 'in' | 'out' }) {
  const { t } = useI18n();
  return (
    <span
      data-comms-direction={direction}
      title={t(direction === 'out' ? 'comms.sent' : 'comms.received')}
      className="flex h-[19px] w-3.5 shrink-0 items-center justify-center text-ink-faint"
    >
      <Icon name="arrowUpRight" size={12} className={direction === 'in' ? 'rotate-180' : undefined} />
      <span className="sr-only">{t(direction === 'out' ? 'comms.sent' : 'comms.received')}</span>
    </span>
  );
}

const PeerRow = memo(function PeerRow({ group, onOpen }: { readonly group: PeerGroup; readonly onOpen: () => void }) {
  const { t } = useI18n();
  const name = useEndpointName();
  const summary = messageSummary(group.latest.content);
  return (
    <li>
      <button
        type="button"
        data-rail-item
        data-comms-peer={group.peer.ref.session_id}
        onClick={onOpen}
        aria-label={t('comms.openWith', { name: name(group.peer) })}
        className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
      >
        <DirectionMark direction={group.latestDirection} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2 leading-[19px]">
            <span className={`min-w-0 truncate text-[13px] ${group.peer.deleted ? 'text-ink-faint italic' : 'text-ink'}`}>{name(group.peer)}</span>
            <EndpointState endpoint={group.peer} />
            <RelativeTime at={acceptedIso(group.latest)} className="ml-auto shrink-0 text-[12px] text-ink-faint tabular-nums" />
          </span>
          <span className="flex min-w-0 items-baseline gap-1.5 text-[12px] leading-[18px] text-ink-faint">
            <span className="min-w-0 flex-1 truncate">{summary}</span>
            {group.messages.length > 1 ? <span className="shrink-0 tabular-nums">{group.messages.length}</span> : null}
          </span>
          {group.undeliverable > 0 ? (
            <span data-comms-undeliverable-count className="block text-[12px] leading-[18px] text-amber-ink">
              {t('comms.undeliverableCount', { count: group.undeliverable })}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
});

export function InspectorComms({ sessionId }: { readonly sessionId: string }) {
  const { t } = useI18n();
  const filter = useMemo(() => ({ session_id: sessionId }), [sessionId]);
  const query = useThreadMessages(filter, sessionId !== '');
  const messages = useMemo(() => loadedMessages(query.data?.pages), [query.data]);
  const groups = useMemo(() => groupByPeer(messages, sessionId), [messages, sessionId]);
  const [showAll, setShowAll] = useState(false);
  const [openPeer, setOpenPeer] = useState<PeerGroup | null>(null);

  if (query.isError && groups.length === 0) {
    return (
      <InspectorSection title={t('comms.title')} collapsible={false} data-inspector-comms="error">
        <p role="alert" className="flex items-center gap-2 text-[12.5px] text-ink-soft">
          <span className="min-w-0 flex-1">{t('comms.loadFailed')}</span>
          <button type="button" onClick={() => { void query.refetch(); }}
            className="h-7 shrink-0 rounded-md px-1.5 text-[12.5px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink">
            {t('common.retry')}
          </button>
        </p>
      </InspectorSection>
    );
  }
  if (groups.length === 0 && !query.hasNextPage) return null;

  const visible = showAll ? groups : groups.slice(0, PEER_PREVIEW);
  return (
    <InspectorSection title={t('comms.title')} count={groups.length} data-inspector-comms="">
      {groups.length === 0 ? (
        <p className="text-[12.5px] text-ink-faint">{t('comms.scanning')}</p>
      ) : (
        <ul className="space-y-0.5">
          {visible.map((group) => (
            <PeerRow key={group.peer.ref.session_id} group={group} onOpen={() => { setOpenPeer(group); }} />
          ))}
        </ul>
      )}
      <div className="mt-0.5 flex items-center gap-3">
        {groups.length > PEER_PREVIEW ? (
          <button type="button" data-comms-show-all onClick={() => { setShowAll((value) => !value); }}
            className="inline-flex h-7 items-center rounded-md px-1.5 -mx-1.5 text-[12.5px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink">
            {showAll ? t('comms.showFewer') : t('comms.showAllPeers', { count: groups.length })}
          </button>
        ) : null}
        {query.hasNextPage ? <LoadOlder busy={query.isFetchingNextPage} onLoad={() => { void query.fetchNextPage(); }} /> : null}
      </div>
      {openPeer !== null ? (
        <ThreadConversationDialog
          sessionId={sessionId}
          peer={openPeer.peer}
          onClose={() => { setOpenPeer(null); }}
        />
      ) : null}
    </InspectorSection>
  );
}
