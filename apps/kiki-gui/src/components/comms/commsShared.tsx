/**
 * Shared pieces for the thread-message surfaces (session rail, pair dialog,
 * Activity › Thread messages): endpoint names, the delivery fact, and the
 * cursor-following infinite read.
 *
 * Delivery is stated only when it is news: a delivered message stays quiet,
 * a pending one says it is waiting, an undeliverable one says so in amber
 * with the server's reason. Accent is not spent here — nothing in a message
 * log asks the user to act.
 */

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useI18n } from '../../i18n';
import {
  isThreadSourced,
  readThreadMessagesPage,
  type ThreadEndpoint,
  type ThreadMessage,
  type ThreadMessagesFilter,
  type ThreadToThreadMessage,
} from '../../lib/threadMessages';
import { useOptionalConnection } from '../../state/connection';
import { useThreadTitleResolver } from '../../lib/threadTitles';

export const THREAD_MESSAGES_QUERY_KEY = ['thread-messages'] as const;

/**
 * Infinite read over one filter. Pages follow empty scan-budget pages inside
 * `readThreadMessagesPage`; the filter is part of the key, so a scope change
 * starts a fresh cursor chain instead of reusing one minted for other filters.
 */
export function useThreadMessages(filter: ThreadMessagesFilter, enabled = true) {
  // Optional: the rail also renders in connection-less previews and tests,
  // where the chapter simply stays empty.
  const client = useOptionalConnection()?.client;
  const queryClient = useQueryClient();
  const queryKey = [...THREAD_MESSAGES_QUERY_KEY, filter];
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => readThreadMessagesPage((input) => client!.listThreadMessages(input), filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.history?.state !== undefined && page.history.state !== 'complete' ? undefined : page.nextCursor,
    refetchInterval: (current) => current.state.data?.pages[0]?.history?.state === 'preparing' ? 1000 : false,
    enabled: enabled && typeof client?.listThreadMessages === 'function',
    staleTime: 15_000,
    retry: false,
  });
  useEffect(() => {
    const error = query.error;
    if (error !== null && 'code' in error && error.code === 40931) {
      void queryClient.resetQueries({ queryKey: [...THREAD_MESSAGES_QUERY_KEY, filter], exact: true });
    }
  }, [query.error, queryClient, filter]);
  const history = query.data?.pages[0]?.history;
  return { ...query, history, historyIncomplete: history !== undefined && history.state !== 'complete' };
}

export function HistoryNote({ state }: { readonly state: 'preparing' | 'error' }) {
  const { t } = useI18n();
  return <p role="status" data-comms-history={state} className="text-[12.5px] text-ink-faint">
    {t(state === 'error' ? 'comms.historyFailed' : 'comms.historyPreparing')}
  </p>;
}

/** Loaded rows across pages, in server order (newest first). */
export function loadedMessages(pages: readonly { readonly items: readonly ThreadMessage[] }[] | undefined): ThreadMessage[] {
  return (pages ?? []).flatMap((page) => page.items);
}

/** Thread-to-thread rows only (pair views and per-peer grouping). */
export function loadedPeerMessages(pages: readonly { readonly items: readonly ThreadMessage[] }[] | undefined): ThreadToThreadMessage[] {
  return loadedMessages(pages).filter(isThreadSourced);
}

/** The name a thread goes by here: its title, or what is left of it. */
export function useEndpointName(endpoints: readonly ThreadEndpoint[]): (endpoint: ThreadEndpoint) => string {
  const { t } = useI18n();
  const resolveTitle = useThreadTitleResolver(endpoints.filter((endpoint) => !endpoint.deleted).map((endpoint) => endpoint.title ?? ''));
  return (endpoint) => {
    if (endpoint.deleted) return t('comms.deletedThread');
    const title = endpoint.title?.trim();
    return title !== undefined && title !== '' ? resolveTitle(title) : t('comms.untitled');
  };
}

/** A small tag after a name for a thread that no longer takes part. */
export function EndpointState({ endpoint }: { readonly endpoint: ThreadEndpoint }) {
  const { t } = useI18n();
  if (endpoint.deleted || !endpoint.archived) return null;
  return <span data-comms-archived className="shrink-0 text-[11.5px] text-ink-faint">{t('comms.archived')}</span>;
}

/** Delivery in words, only when it differs from "delivered". */
export function DeliveryNote({ message, always = false }: { readonly message: ThreadMessage; readonly always?: boolean }) {
  const { t } = useI18n();
  if (message.delivery === 'delivered' && !always) return null;
  if (message.delivery === 'undeliverable') {
    const reason = t(`comms.reason.${message.reason_code ?? 'delivery_failed'}`);
    const detail = (message.reason_detail ?? message.reason)?.trim();
    return (
      <span data-comms-delivery="undeliverable" title={detail} className="min-w-0 truncate text-amber-ink">
        {t('comms.undeliverableReason', { reason })}
      </span>
    );
  }
  return (
    <span data-comms-delivery={message.delivery} className="shrink-0 text-ink-faint">
      {t(message.delivery === 'pending' ? 'comms.delivery.pending' : 'comms.delivery.delivered')}
    </span>
  );
}

/** Quiet "load earlier" control under a list. */
export function LoadOlder({ busy, onLoad }: { readonly busy: boolean; readonly onLoad: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-comms-load-older
      disabled={busy}
      aria-busy={busy}
      onClick={onLoad}
      className="inline-flex h-7 items-center rounded-md px-1.5 -mx-1.5 text-[12.5px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-wait disabled:opacity-60 pointer-coarse:h-11"
    >
      {busy ? t('comms.loading') : t('comms.loadOlder')}
    </button>
  );
}
