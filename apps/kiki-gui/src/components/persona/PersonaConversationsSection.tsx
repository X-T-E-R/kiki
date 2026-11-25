/**
 * PersonaConversationsSection: one persona's conversations, in full.
 *
 * The list is the server's answer to `GET /api/sessions?persona=<id>` (D5):
 * every conversation this persona owns — its daily one, its topics, its room
 * seats — paged through the cursor until the server says there is no more.
 * Nothing here re-derives ownership from the wire: the server's attribution is
 * the authority, and a client-side guess would silently drop cold rows.
 *
 * The daily pointer moves through `PUT /api/personas/{id}/home` (D4). The move
 * is reversible with the same data — the previous home id is captured before
 * the write — so it applies immediately and the undo toast offers the inverse;
 * it is offered only where the server would accept it: a persistent, idle,
 * same-persona, non-room conversation.
 */

import { useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PersonaSummary, Session, WorkspaceCatalogEntry } from '@kiki/protocol';
import { sessionRowState } from '@kiki/session-core/sessions';
import type { SessionSeenMap } from '@kiki/session-core/settings';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { invalidatePersonaSessionLists } from '../../lib/personaFreshness';
import { pushToast, pushUndoToast } from '../../lib/toasts';
import { ROOM_ITEMS_QUERY_KEY } from '../../lib/useConversationList';
import { useConnection } from '../../state/connection';
import { useGuardedNavigate } from '../dirtyGuard';
import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import type { MiniMenuEntry } from '../MiniContextMenu';
import { RelativeTime } from '../RelativeTime';
import { SearchableSelect } from '../SearchableSelect';
import { useSessionContextMenu } from '../sessionContextMenu';
import { personaNewConversationUrl } from './personaNavigation';
import { personaQueryKey, PERSONAS_QUERY_KEY } from './usePersonas';

/** Pages fetched before the list asks for help loading more. */
const INITIAL_PAGES = 3;
const PAGE_SIZE = 100;

export interface PersonaConversationsSectionProps {
  readonly persona: PersonaSummary;
  readonly workspaceOptions?: readonly WorkspaceCatalogEntry[];
  readonly seen?: SessionSeenMap;
}

interface PersonaConversations {
  readonly items: readonly Session[];
  readonly truncated: boolean;
}

export function PersonaConversationsSection({
  persona,
  workspaceOptions = [],
  seen = {},
}: PersonaConversationsSectionProps) {
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const { client } = useConnection();
  const sessionMenu = useSessionContextMenu({ portal: true });

  const [workspaceFilter, setWorkspaceFilter] = useState('');
  const [search, setSearch] = useState('');

  const workspaceMap = useMemo(() => new Map(workspaceOptions.map((w) => [w.id, w.name])), [workspaceOptions]);
  // A room seat's own session title is generated, not the room's name; the row
  // says the room, and opens it.
  const roomsQuery = useQuery({
    queryKey: ROOM_ITEMS_QUERY_KEY,
    queryFn: () => {
      const rest = client.klient.rest;
      if (rest === undefined) throw new Error(t('persona.conversationsUnavailable'));
      return rest.rooms.listItems();
    },
    staleTime: 15_000,
    retry: false,
  });
  const roomNames = useMemo(
    () => new Map((roomsQuery.data ?? []).map((room) => [room.id, room.title])),
    [roomsQuery.data],
  );
  const workspaceOptionsList = useMemo(() => [
    { value: '', label: t('sidebar.workspaceAll') },
    ...workspaceOptions.map((workspace) => ({ value: workspace.id, label: workspace.name, hint: workspace.root })),
  ], [t, workspaceOptions]);

  const conversationsQuery = useInfiniteQuery({
    queryKey: ['sessions', 'persona', persona.id, workspaceFilter],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<PersonaConversations & { readonly nextBefore?: string }> => {
      const items: Session[] = [];
      let before = pageParam;
      let truncated = false;
      const pagesPerFetch = pageParam === undefined ? INITIAL_PAGES : 1;
      for (let page = 0; page < pagesPerFetch; page += 1) {
        const result = await client.listSessions({
          persona: persona.id,
          page_size: PAGE_SIZE,
          include_archive: true,
          include_private: true,
          workspace_id: workspaceFilter === '' ? undefined : workspaceFilter,
          before_id: before,
        });
        items.push(...result.items);
        before = result.items.at(-1)?.id;
        truncated = result.has_more;
        if (!truncated || result.items.length === 0) break;
      }
      return { items, truncated, nextBefore: truncated ? before : undefined };
    },
    getNextPageParam: (lastPage) => lastPage.nextBefore,
    staleTime: 15_000,
  });

  const allItems = useMemo(() => {
    const pagesData = conversationsQuery.data?.pages ?? [];
    const seenIds = new Set<string>();
    const deduped: Session[] = [];
    for (const page of pagesData) {
      for (const item of page.items) {
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        deduped.push(item);
      }
    }
    return deduped;
  }, [conversationsQuery.data]);

  const rows = useMemo(() => {
    const items = [...allItems];
    const needle = search.trim().toLocaleLowerCase();
    const matched = needle === ''
      ? items
      : items.filter((session) => (session.title ?? session.last_prompt ?? '').toLocaleLowerCase().includes(needle));
    return matched.sort((a, b) => {
      // The daily conversation stays the first thing you see; the rest is
      // recency, which is also how the sidebar orders them.
      if (a.id === persona.homeSessionId) return -1;
      if (b.id === persona.homeSessionId) return 1;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }, [allItems, persona.homeSessionId, search]);

  // The home id the inverse needs, captured before the write lands.
  const previousHomeRef = useRef<string | undefined>(persona.homeSessionId);
  const changeDaily = useMutation({
    mutationFn: (sessionId: string) => {
      previousHomeRef.current = persona.homeSessionId;
      const rest = client.klient.rest;
      if (rest === undefined) throw new Error(t('persona.conversationsUnavailable'));
      return rest.personas.setHome(persona.id, sessionId);
    },
    onSuccess: () => {
      const previousHome = previousHomeRef.current;
      const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: PERSONAS_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: personaQueryKey(persona.id) });
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        invalidatePersonaSessionLists(queryClient);
        void queryClient.invalidateQueries({ queryKey: ['bots'] });
      };
      pushUndoToast({
        text: t('persona.dailyChangedToast', { name: persona.name }),
        undoFailedText: t('toast.undoFailed'),
        undo: async () => {
          if (previousHome === undefined) return;
          const rest = client.klient.rest;
          if (rest === undefined) throw new Error(t('persona.conversationsUnavailable'));
          await rest.personas.setHome(persona.id, previousHome);
          refresh();
        },
      });
      refresh();
    },
    onError: (error: unknown) => {
      pushToast({ tone: 'error', text: t('persona.dailyChangeFailed', { detail: errorText(locale, error) }) });
    },
  });

  const total = allItems.length;
  const latestLoadedUpdatedAt = useMemo(() => {
    let latestIso: string | undefined;
    let latestMs = -Infinity;
    for (const item of allItems) {
      const parsed = Date.parse(item.updated_at);
      if (Number.isFinite(parsed) && parsed > latestMs) {
        latestMs = parsed;
        latestIso = item.updated_at;
      }
    }
    return latestIso;
  }, [allItems]);

  return (
    <div data-persona-conversations className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <div className="min-w-[136px] flex-1 sm:w-48 sm:flex-none">
          <SearchableSelect
            id="persona-conversations-workspace"
            value={workspaceFilter}
            onChange={(value) => { setWorkspaceFilter(value); }}
            options={workspaceOptionsList}
            ariaLabel={t('persona.filterWorkspace')}
            density="compact"
          />
        </div>
        <div className="relative min-w-[160px] flex-1">
          <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-faint">
            <Icon name="search" size={12} />
          </span>
          <input
            type="text"
            value={search}
            onChange={(event) => { setSearch(event.target.value); }}
            placeholder={t('persona.searchConversations')}
            aria-label={t('persona.searchConversations')}
            className="h-8 w-full rounded-md border border-hairline bg-paper pr-2 pl-6 text-[13px] leading-5 text-ink placeholder:text-ink-faint focus:border-hairline-strong focus:outline-none pointer-coarse:h-11"
          />
        </div>
        <button
          type="button"
          data-persona-new-conversation
          onClick={() => {
            void navigate(personaNewConversationUrl(persona.id, workspaceFilter === '' ? undefined : workspaceFilter));
          }}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-[12px] leading-4 font-normal text-ink transition-colors hover:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
        >
          <Icon name="plus" size={12} />
          <span>{t('persona.newTopic')}</span>
        </button>
      </div>
      {total > 0 ? (
        <div data-persona-conversations-meta className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline pb-2 text-[12px] text-ink-faint tabular-nums">
          <span>
            {conversationsQuery.hasNextPage
              ? t('persona.conversationsCountMore', { count: total })
              : t('persona.conversationsCount', { count: total })}
          </span>
          {latestLoadedUpdatedAt !== undefined ? (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1">
                <span>{t('persona.latestLoadedUpdate')}</span>
                <RelativeTime at={latestLoadedUpdatedAt} className="text-ink-soft" />
              </span>
            </>
          ) : null}
        </div>
      ) : null}

      {conversationsQuery.isPending && conversationsQuery.data === undefined ? (
        <p role="status" className="py-10 text-center text-[13px] text-ink-faint">{t('persona.conversationsLoading')}</p>
      ) : conversationsQuery.isError && conversationsQuery.data === undefined ? (
        <div className="py-10 text-center">
          <p role="alert" className="text-[13px] text-ink-soft">
            {t('persona.conversationsLoadFailed', { detail: errorText(locale, conversationsQuery.error) })}
          </p>
          <button
            type="button"
            onClick={() => { void conversationsQuery.refetch(); }}
            className="mt-3 rounded-md border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
          >
            {t('common.retry')}
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-ink-faint">
          {total === 0 ? t('persona.conversationsNone') : t('persona.noConversations')}
        </p>
      ) : (
        <ul data-persona-conversation-list className="flex flex-col">
          {rows.map((session) => {
            const isDaily = session.id === persona.homeSessionId;
            const roomId = typeof session.metadata?.['room_member_of'] === 'string'
              ? session.metadata['room_member_of'] as string
              : undefined;
            const state = sessionRowState(session, seen);
            const life = state === 'needs-me' ? 'waiting' : state === 'running' ? 'working' : state === 'unread' ? 'done' : 'idle';
            const title = roomId === undefined
              ? (session.title?.trim() !== '' && session.title !== undefined
                ? session.title
                : session.last_prompt?.trim() !== '' && session.last_prompt !== undefined
                  ? session.last_prompt
                  : t('sidebar.untitled'))
              : roomNames.get(roomId) ?? (session.title?.trim() !== '' && session.title !== undefined ? session.title : roomId);
            const workspaceName = session.workspace_id === undefined
              ? undefined
              : workspaceMap.get(session.workspace_id) ?? session.workspace_id;
            // Mirrors D4's server boundary: persistent, idle, not a room seat.
            // Ownership is the query's, not this row's, to judge.
            const canSetDaily = !isDaily && roomId === undefined && !session.archived
              && !session.busy && session.ephemeral !== true;

            const openRowMenu = (x: number, y: number) => {
              const extraTopEntries: MiniMenuEntry[] = canSetDaily
                ? [{
                    key: 'set-daily',
                    label: t('persona.setAsDaily'),
                    run: () => { changeDaily.mutate(session.id); },
                  }]
                : [];
              sessionMenu.openSessionMenu(session, x, y, {
                title,
                copyLinkHref: roomId === undefined ? `/s/${encodeURIComponent(session.id)}` : `/rooms/${encodeURIComponent(roomId)}`,
                extraTopEntries,
              });
            };
            const rowMenuOpen = sessionMenu.menuSessionId === session.id;

            return (
              <li
                key={session.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openRowMenu(event.clientX, event.clientY);
                }}
                className="group grid grid-cols-[minmax(0,1fr)_2.75rem_5.25rem] items-center gap-2 border-b border-hairline py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_8.25rem_5.5rem]"
              >
                <button
                  type="button"
                  data-persona-conversation-row={session.id}
                  onClick={() => { void navigate(roomId === undefined ? `/s/${encodeURIComponent(session.id)}` : `/rooms/${encodeURIComponent(roomId)}`); }}
                  className="flex min-w-0 items-start gap-2.5 rounded-md py-0.5 text-left focus-visible:outline-2 focus-visible:outline-selected-ink"
                >
                  <span className="flex h-[19px] w-[7px] shrink-0 items-center">
                    <LifeMark
                      markId={`persona-conversations:${session.id}`}
                      life={life}
                      still
                      tone={life === 'waiting' ? 'bg-attention' : undefined}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[13px] leading-5">
                      {isDaily ? (
                        <span aria-hidden className="shrink-0 text-ink-faint"><Icon name="pin" size={12} /></span>
                      ) : roomId !== undefined ? (
                        <span aria-hidden className="shrink-0 font-mono text-ink-faint">#</span>
                      ) : null}
                      <span className={`min-w-0 truncate font-normal ${
                        isDaily || life === 'waiting' || life === 'done' ? 'text-ink' : session.archived ? 'text-ink-faint' : 'text-ink-soft'
                      }`}>
                        {title}
                      </span>
                    </span>
                    <span className="mt-px flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-faint">
                      {workspaceName !== undefined ? <span className="min-w-0 truncate">{workspaceName}</span> : null}
                      {isDaily ? <span className="shrink-0">{t('persona.dailyTitle')}</span> : null}
                      {session.archived ? <span className="shrink-0">{t('sidebar.archived')}</span> : null}
                    </span>
                  </span>
                </button>
                <div className="flex items-center justify-end gap-1">
                  {canSetDaily ? (
                    <button
                      type="button"
                      data-persona-set-daily={session.id}
                      aria-label={t('persona.setAsDaily')}
                      title={t('persona.setAsDaily')}
                      onClick={() => { changeDaily.mutate(session.id); }}
                      disabled={changeDaily.isPending}
                      className="max-sm:hidden shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-[12px] text-ink-soft opacity-100 transition-opacity duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:min-h-11 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100"
                    >
                      {t('persona.setDailyShort')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    data-persona-conversation-menu={session.id}
                    aria-haspopup="menu"
                    aria-expanded={rowMenuOpen}
                    aria-label={t('sidebar.sessionActionsFor', { title })}
                    title={t('sidebar.sessionActionsFor', { title })}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (rowMenuOpen) {
                        sessionMenu.closeSessionMenu();
                        return;
                      }
                      const rect = event.currentTarget.getBoundingClientRect();
                      openRowMenu(rect.right + 4, rect.top);
                    }}
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink sm:h-8 sm:w-8 pointer-coarse:h-11 pointer-coarse:w-11 ${
                      rowMenuOpen ? 'bg-ink/[0.06] text-ink' : 'text-ink-faint'
                    }`}
                  >
                    <Icon name="more" size={14} />
                  </button>
                </div>
                <span
                  data-persona-conversation-date={session.id}
                  className="justify-self-end whitespace-nowrap text-right text-[12px] leading-4 text-ink-faint tabular-nums"
                >
                  <RelativeTime at={session.updated_at} />
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {conversationsQuery.hasNextPage ? (
        <div className="mt-2 flex flex-col items-center gap-1.5">
          {conversationsQuery.isFetchNextPageError ? (
            <p role="alert" className="text-[12px] text-danger">
              {t('persona.conversationsLoadFailed', { detail: errorText(locale, conversationsQuery.error) })}
            </p>
          ) : null}
          <button
            type="button"
            data-persona-conversations-more
            onClick={() => { void conversationsQuery.fetchNextPage(); }}
            disabled={conversationsQuery.isFetchingNextPage}
            className="self-center rounded-md px-3 py-1.5 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {conversationsQuery.isFetchNextPageError
              ? t('common.retry')
              : `${t('sidebar.loadMore')} · ${t('persona.conversationsShown', { count: total })}`}
          </button>
        </div>
      ) : null}
      {sessionMenu.menuPortal}
    </div>
  );
}
