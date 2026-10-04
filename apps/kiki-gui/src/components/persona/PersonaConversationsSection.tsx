/**
 * PersonaConversationsSection: one persona's conversations, in full.
 *
 * The list is the server's answer to `GET /api/sessions?persona=<id>` (D5):
 * every conversation this persona owns — its daily one, its topics, its room
 * seats — paged through the cursor until the server says there is no more.
 * Nothing here re-derives ownership from the wire: the server's attribution is
 * the authority, and a client-side guess would silently drop cold rows.
 *
 * The daily pointer moves through `PUT /api/personas/{id}/home` (D4) with the
 * consequence spelled out before it happens, and only where the server would
 * accept it: a persistent, idle, same-persona, non-room conversation.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';import type { PersonaSummary, Session, Workspace } from '@kiki/protocol';
import { sessionRowState } from '@kiki/session-core/sessions';
import type { SessionSeenMap } from '@kiki/session-core/settings';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { pushToast } from '../../lib/toasts';
import { ROOM_ITEMS_QUERY_KEY } from '../../lib/useConversationList';
import { useConnection } from '../../state/connection';
import { useGuardedNavigate } from '../dirtyGuard';
import { ConfirmDialog } from '../ConfirmDialog';
import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { RelativeTime } from '../RelativeTime';
import { SearchableSelect } from '../SearchableSelect';
import { personaNewConversationUrl } from './personaNavigation';
import { personaQueryKey, PERSONAS_QUERY_KEY } from './usePersonas';

/** Pages fetched before the list asks for help loading more. */
const INITIAL_PAGES = 3;
const PAGE_SIZE = 100;

export interface PersonaConversationsSectionProps {
  readonly persona: PersonaSummary;
  readonly workspaceOptions?: readonly Workspace[];
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

  const [workspaceFilter, setWorkspaceFilter] = useState('');
  const [search, setSearch] = useState('');
  const [pages, setPages] = useState(INITIAL_PAGES);
  const [target, setTarget] = useState<Session | null>(null);

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

  const conversationsQuery = useQuery({
    queryKey: ['sessions', 'persona', persona.id, workspaceFilter, pages],
    queryFn: async (): Promise<PersonaConversations> => {
      const items: Session[] = [];
      let before: string | undefined;
      let truncated = false;
      for (let page = 0; page < pages; page += 1) {
        const result = await client.listSessions({
          persona: persona.id,
          page_size: PAGE_SIZE,
          include_archive: true,
          workspace_id: workspaceFilter === '' ? undefined : workspaceFilter,
          before_id: before,
        });
        items.push(...result.items);
        before = result.items.at(-1)?.id;
        truncated = result.has_more;
        if (!truncated) break;
      }
      return { items, truncated };
    },
    staleTime: 15_000,
  });

  const rows = useMemo(() => {
    const items = [...(conversationsQuery.data?.items ?? [])];
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
  }, [conversationsQuery.data, persona.homeSessionId, search]);

  const changeDaily = useMutation({
    mutationFn: (sessionId: string) => {
      const rest = client.klient.rest;
      if (rest === undefined) throw new Error(t('persona.conversationsUnavailable'));
      return rest.personas.setHome(persona.id, sessionId);
    },
    onSuccess: () => {
      setTarget(null);
      pushToast({ tone: 'success', text: t('persona.dailyChangedToast', { name: persona.name }) });
      void queryClient.invalidateQueries({ queryKey: PERSONAS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: personaQueryKey(persona.id) });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['bots'] });
    },
    // The failure keeps the confirmation and the user's selection: retrying is
    // the next click, and nothing has moved.
    onError: (error: unknown) => {
      pushToast({ tone: 'error', text: t('persona.dailyChangeFailed', { detail: errorText(locale, error) }) });
    },
  });

  const total = conversationsQuery.data?.items.length ?? 0;

  return (
    <div data-persona-conversations className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <div className="w-48">
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
            className="h-8 w-full rounded-md border border-hairline bg-paper pr-2 pl-6 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-hairline-strong focus:outline-none"
          />
        </div>
        <button
          type="button"
          data-persona-new-conversation
          onClick={() => {
            navigate(personaNewConversationUrl(persona.id, workspaceFilter === '' ? undefined : workspaceFilter));
          }}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium text-ink transition-colors hover:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-selected-ink"
        >
          <Icon name="plus" size={12} />
          <span>{t('persona.newTopic')}</span>
        </button>
      </div>

      {conversationsQuery.isPending ? (
        <p role="status" className="py-10 text-center text-[13px] text-ink-faint">{t('persona.conversationsLoading')}</p>
      ) : conversationsQuery.isError ? (
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

            return (
              <li key={session.id} className="group flex items-center gap-3 border-b border-hairline py-2.5 last:border-b-0">
                <button
                  type="button"
                  data-persona-conversation-row={session.id}
                  onClick={() => { navigate(roomId === undefined ? `/s/${encodeURIComponent(session.id)}` : `/rooms/${encodeURIComponent(roomId)}`); }}
                  className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
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
                    <span className="flex items-center gap-1.5 text-[13px] leading-[19px]">
                      {isDaily ? (
                        <span aria-hidden className="shrink-0 text-ink-faint"><Icon name="pin" size={12} /></span>
                      ) : roomId !== undefined ? (
                        <span aria-hidden className="shrink-0 font-mono text-ink-faint">#</span>
                      ) : null}
                      <span className={`min-w-0 truncate ${
                        isDaily || life === 'waiting' || life === 'done' ? 'font-medium text-ink' : session.archived ? 'text-ink-faint' : 'text-ink-soft'
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
                  <RelativeTime at={session.updated_at} className="shrink-0 text-[12px] leading-4 text-ink-faint tabular-nums" />
                </button>
                {canSetDaily ? (
                  <button
                    type="button"
                    data-persona-set-daily={session.id}
                    onClick={() => { setTarget(session); }}
                    className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-faint opacity-0 transition-opacity duration-[var(--kiki-motion-quick)] group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink [@media(hover:none)]:opacity-100"
                  >
                    {t('persona.setAsDaily')}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {conversationsQuery.data?.truncated === true ? (
        <button
          type="button"
          data-persona-conversations-more
          onClick={() => { setPages((value) => value + INITIAL_PAGES); }}
          disabled={conversationsQuery.isFetching}
          className="mt-2 self-center rounded-md px-3 py-1.5 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('sidebar.loadMore')} · {t('persona.conversationsShown', { count: total })}
        </button>
      ) : null}

      {target !== null ? (
        <ConfirmDialog
          open
          title={t('persona.confirmSetDailyTitle')}
          confirmLabel={t('persona.confirmSetDaily')}
          busy={changeDaily.isPending}
          onCancel={() => { setTarget(null); }}
          onConfirm={() => { changeDaily.mutate(target.id); }}
        >
          <p className="text-[13px] leading-relaxed text-ink-soft">
            {t('persona.confirmSetDailyBody', {
              name: persona.name,
              title: target.title?.trim() !== '' && target.title !== undefined ? target.title : t('sidebar.untitled'),
            })}
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
            {t('persona.confirmSetDailyNote', { name: persona.name })}
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
