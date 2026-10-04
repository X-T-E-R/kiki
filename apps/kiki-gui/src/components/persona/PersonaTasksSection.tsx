/**
 * PersonaTasksSection — 定时任务与房间, for one persona.
 *
 * Attribution comes from the server, never from a guess:
 *
 *  - The persona's conversations are read through `GET /api/sessions?persona=`
 *    (D5) with the cursor, so "her conversations" means all of them, not the
 *    first page that happened to be loaded in the sidebar.
 *  - Scheduled tasks come from `GET /api/cron` (paged, `next_offset`), and a
 *    task belongs to her only when its session is one of hers. A task that
 *    hangs off a workspace rather than a conversation is therefore not claimed
 *    here; it stays visible on the scheduled-tasks page.
 *
 * Reads are separated: still loading, could not read, and nothing configured
 * are three different lines, and a failed read is never drawn as an empty
 * state. Pausing writes the real task (`:pause` / `:resume`) and the row keeps
 * its last known state until the server answers.
 */

import { useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { PersonaSummary, Session } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import type { CronTask } from '../../lib/client';
import { pushToast } from '../../lib/toasts';
import { ROOMS_QUERY_KEY } from '../../lib/botRooms';
import { useConnection } from '../../state/connection';
import { InlineError, SavedTick } from '../controls';
import { CRON_TASKS_QUERY_KEY } from '../GlobalCronPanel';
import { Icon } from '../icons';
import { useGuardedNavigate } from '../dirtyGuard';
import { useNow } from '../RelativeTime';
import { CreateRoomDialog } from '../room/CreateRoomDialog';
import { useSavedTick } from '../settings/useSavedTick';

/** Pages of conversations read for attribution; 100 per page. */
const SESSION_PAGE_SIZE = 100;
const SESSION_PAGE_CAP = 10;
const CRON_PAGE_SIZE = 100;

export interface PersonaTasksSectionProps {
  readonly persona: PersonaSummary;
}

interface PersonaConversations {
  readonly byId: ReadonlyMap<string, Session>;
  /** True when the page cap was reached before the server ran out. */
  readonly truncated: boolean;
}

function usePersonaConversations(personaId: string, enabled: boolean) {
  const { client } = useConnection();
  return useQuery({
    queryKey: ['personas', personaId, 'task-conversations'],
    enabled,
    staleTime: 15_000,
    queryFn: async (): Promise<PersonaConversations> => {
      const byId = new Map<string, Session>();
      let before: string | undefined;
      let truncated = false;
      for (let page = 0; page < SESSION_PAGE_CAP; page += 1) {
        const result = await client.listSessions({
          persona: personaId,
          page_size: SESSION_PAGE_SIZE,
          include_archive: true,
          before_id: before,
        });
        for (const session of result.items) byId.set(session.id, session);
        if (!result.has_more) { truncated = false; break; }
        truncated = true;
        before = result.items.at(-1)?.id;
        if (before === undefined) { truncated = false; break; }
      }
      return { byId, truncated };
    },
  });
}

export function PersonaTasksSection({ persona }: PersonaTasksSectionProps) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();

  const [roomsOpen, setRoomsOpen] = useState(false);
  const [cronSaved, markCronSaved] = useSavedTick();

  const conversationsQuery = usePersonaConversations(persona.id, true);
  const byId = conversationsQuery.data?.byId;

  const tasksQuery = useInfiniteQuery({
    queryKey: [...CRON_TASKS_QUERY_KEY, 'persona', persona.id] as const,
    queryFn: ({ pageParam }) => client.listCronTasks({ page_size: CRON_PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => (lastPage.has_more ? lastPage.next_offset : undefined),
    enabled: byId !== undefined,
    staleTime: 15_000,
  });

  const roomsQuery = useQuery({
    queryKey: [...ROOMS_QUERY_KEY, 'documents'] as const,
    queryFn: () => {
      const rest = client.klient.rest;
      if (rest === undefined) throw new Error(t('persona.conversationsUnavailable'));
      return rest.rooms.list();
    },
    staleTime: 15_000,
  });

  const tasks = useMemo(() => {
    if (byId === undefined) return [];
    const seen = new Set<string>();
    const rows: { task: CronTask; session: Session }[] = [];
    for (const page of tasksQuery.data?.pages ?? []) {
      for (const task of page.items) {
        if (task.session_id === null) continue;
        const session = byId.get(task.session_id);
        if (session === undefined) continue;
        const key = `${task.id}:${task.session_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ task, session });
      }
    }
    // Paused tasks sit together at the end, like the scheduled-tasks page.
    return rows.sort((a, b) => Number(a.task.paused) - Number(b.task.paused));
  }, [tasksQuery.data, byId]);

  const rooms = useMemo(
    () => (roomsQuery.data ?? []).filter((room) =>
      room.members.some((member) => member.kind === 'persona' && member.personaId === persona.id)),
    [roomsQuery.data, persona.id],
  );

  const pauseResume = useMutation({
    mutationFn: ({ task, pause }: { task: CronTask; pause: boolean }) =>
      pause
        ? client.pauseCronTask(task.id, task.session_id ?? undefined)
        : client.resumeCronTask(task.id, task.session_id ?? undefined),
    onSuccess: (_result, { pause }) => {
      markCronSaved();
      pushToast({ tone: 'success', text: pause ? t('cron.toast.paused') : t('cron.toast.resumed') });
      void queryClient.invalidateQueries({ queryKey: CRON_TASKS_QUERY_KEY });
    },
    onError: (error: unknown) => {
      pushToast({ tone: 'error', text: t('persona.tasks.actionFailed', { detail: errorText(locale, error) }) });
      // A task that went away elsewhere should not keep a stale row on screen.
      void queryClient.invalidateQueries({ queryKey: CRON_TASKS_QUERY_KEY });
    },
  });

  const busyTaskId = pauseResume.isPending
    ? `${pauseResume.variables?.task.id}:${pauseResume.variables?.task.session_id ?? ''}`
    : undefined;

  const openDaily = () => { navigate(`/p/${encodeURIComponent(persona.id)}/daily`); };

  return (
    <div data-persona-tasks className="space-y-8">
      {/* 定时任务 */}
      <section data-persona-cron>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pb-2">
          <h4 className="text-[13px] font-medium text-ink">{t('cron.panel.title')}</h4>
          <div className="flex items-center gap-3">
            <SavedTick show={cronSaved && !pauseResume.isPending} />
            <button
              type="button"
              data-persona-cron-new
              onClick={openDaily}
              title={t('persona.tasks.addHint', { name: persona.name })}
              className="inline-flex items-center gap-1 text-[12px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
            >
              <Icon name="plus" size={12} />
              <span>{t('persona.tasks.add')}</span>
            </button>
          </div>
        </div>

        {conversationsQuery.isPending || (byId !== undefined && tasksQuery.isPending) ? (
          <p role="status" data-persona-cron-loading className="py-4 text-[12.5px] text-ink-faint">{t('cron.panel.loading')}</p>
        ) : conversationsQuery.isError ? (
          <div className="space-y-1 py-2" data-persona-cron-error>
            <p className="text-[12.5px] text-ink-soft">{t('persona.tasks.scopeFailed')}</p>
            <InlineError error={conversationsQuery.error} />
            <button type="button" onClick={() => { void conversationsQuery.refetch(); }} className="text-[12px] text-ink-faint underline underline-offset-2 hover:text-ink">
              {t('common.retry')}
            </button>
          </div>
        ) : tasksQuery.isError ? (
          <div className="space-y-1 py-2" data-persona-cron-error>
            <p className="text-[12.5px] text-ink-soft">{t('cron.panel.error.title')}</p>
            <InlineError error={tasksQuery.error} />
            <button type="button" onClick={() => { void tasksQuery.refetch(); }} className="text-[12px] text-ink-faint underline underline-offset-2 hover:text-ink">
              {t('common.retry')}
            </button>
          </div>
        ) : tasks.length === 0 ? (
          <p data-persona-cron-empty className="py-4 text-[13px] text-ink-soft">{t('persona.tasks.empty', { name: persona.name })}</p>
        ) : (
          <ul data-persona-cron-list className="flex flex-col">
            {tasks.map(({ task, session }) => {
              const rowKey = `${task.id}:${task.session_id ?? ''}`;
              const pending = busyTaskId === rowKey;
              return (
                <li
                  key={rowKey}
                  data-persona-cron-task={task.id}
                  aria-busy={pending}
                  className={`flex flex-wrap items-start gap-x-4 gap-y-1.5 border-b border-hairline py-3 last:border-b-0 ${pending ? 'opacity-60' : ''}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-[13px] font-medium text-ink">{task.human_schedule}</span>
                      <span data-cron-status={task.paused ? 'paused' : 'running'} className={`text-[12px] ${task.paused ? 'text-ink-faint' : 'text-ink-soft'}`}>
                        {task.paused ? t('cron.status.paused') : t('cron.status.running')}
                      </span>
                      {task.stale ? <span className="text-[12px] text-amber-ink">{t('cron.status.stale')}</span> : null}
                      <span className="text-[12px] text-ink-faint">{task.recurring ? t('cron.kind.recurring') : t('cron.kind.oneShot')}</span>
                    </div>
                    {task.prompt_preview !== '' ? (
                      <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-ink-soft">{task.prompt_preview}</p>
                    ) : null}
                    <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-ink-faint">
                      <span>
                        {t('cron.nextFire')}: {task.next_fire_at === null
                          ? t('cron.neverRun')
                          : <NextFireAt at={task.next_fire_at} />}
                      </span>
                      <span className="font-mono text-[11.5px]">{task.cron}</span>
                      <button
                        type="button"
                        data-persona-cron-session={session.id}
                        onClick={() => { navigate(`/s/${encodeURIComponent(session.id)}`); }}
                        className="max-w-64 truncate text-left text-ink-soft underline-offset-2 transition-colors hover:text-ink hover:underline"
                        title={session.title}
                      >
                        {session.title.trim() !== '' ? session.title : t('sidebar.untitled')}
                      </button>
                    </p>
                  </div>
                  <button
                    type="button"
                    data-persona-cron-action={task.paused ? 'resume' : 'pause'}
                    disabled={pauseResume.isPending}
                    onClick={() => { pauseResume.mutate({ task, pause: !task.paused }); }}
                    className="shrink-0 self-center rounded-md px-2.5 py-1 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:text-ink-faint"
                  >
                    {task.paused ? t('cron.action.resume') : t('cron.action.pause')}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {tasksQuery.hasNextPage ? (
          <button
            type="button"
            data-persona-cron-more
            onClick={() => { void tasksQuery.fetchNextPage(); }}
            disabled={tasksQuery.isFetchingNextPage}
            className="mt-2 text-[12px] text-ink-faint underline underline-offset-2 transition-colors hover:text-ink disabled:cursor-not-allowed"
          >
            {t('cron.panel.loadMore')}
          </button>
        ) : null}
        {conversationsQuery.data?.truncated === true ? (
          <p className="pt-1 text-[12px] text-ink-faint">{t('persona.tasks.scopeTruncated')}</p>
        ) : null}
      </section>

      {/* 房间 */}
      <section data-persona-rooms>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pb-2">
          <h4 className="text-[13px] font-medium text-ink">{t('persona.rooms.title')}</h4>
          <button
            type="button"
            data-persona-rooms-new
            onClick={() => { setRoomsOpen(true); }}
            className="inline-flex items-center gap-1 text-[12px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
          >
            <Icon name="plus" size={12} />
            <span>{t('room.new')}</span>
          </button>
        </div>

        {roomsQuery.isPending ? (
          <p role="status" className="py-4 text-[12.5px] text-ink-faint">{t('persona.rooms.loading')}</p>
        ) : roomsQuery.isError ? (
          <div className="space-y-1 py-2" data-persona-rooms-error>
            <p className="text-[12.5px] text-ink-soft">{t('room.loadFailed')}</p>
            <InlineError error={roomsQuery.error} />
            <button type="button" onClick={() => { void roomsQuery.refetch(); }} className="text-[12px] text-ink-faint underline underline-offset-2 hover:text-ink">
              {t('common.retry')}
            </button>
          </div>
        ) : rooms.length === 0 ? (
          <p data-persona-rooms-empty className="py-4 text-[13px] text-ink-soft">{t('persona.rooms.empty', { name: persona.name })}</p>
        ) : (
          <ul data-persona-rooms-list className="flex flex-col">
            {rooms.map((room) => (
              <li key={room.id} className="border-b border-hairline last:border-b-0">
                <button
                  type="button"
                  data-persona-room-row={room.id}
                  onClick={() => { navigate(`/rooms/${encodeURIComponent(room.id)}`); }}
                  className="row-interactive flex w-full items-baseline gap-2 py-2.5 text-left"
                >
                  <span aria-hidden className="shrink-0 font-mono text-[12px] text-ink-faint">#</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{room.name}</span>
                  {room.paused ? <span className="shrink-0 text-[12px] text-ink-faint">{t('room.paused')}</span> : null}
                  <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">{t('room.memberCountShort', { count: room.members.length })}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {roomsOpen ? (
        <CreateRoomDialog
          onClose={() => {
            setRoomsOpen(false);
            void queryClient.invalidateQueries({ queryKey: ROOMS_QUERY_KEY });
          }}
        />
      ) : null}
    </div>
  );
}

/** Countdown to the next fire, aging on the shared clock, like the cron page. */
function NextFireAt({ at }: { readonly at: string }) {
  const { time } = useI18n();
  useNow();
  return <span className="tabular-nums" title={time.absoluteTime(at)}>{time.timeUntil(at)}</span>;
}
