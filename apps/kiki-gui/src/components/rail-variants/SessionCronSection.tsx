/**
 * 本对话定时任务 — the scheduled tasks this conversation owns, as its own
 * folded block beside 待办.
 *
 * Rows read like the rail's other rows: the prompt in one line, the schedule
 * and its next fire under it, and the pause/resume control at the end. Three
 * rows show by default; the rest open in place. The block's last line always
 * leads to /cron scoped to this conversation, so the group never hides the way
 * to manage what it lists — including when it lists nothing.
 *
 * The read is scoped at the server (`GET /api/cron?session_id=…`), which
 * filters before it pages, so page N pages this conversation's own tasks
 * instead of a cross-workspace set a client-side filter would have to re-page.
 * The returned rows are checked against the same id once more: a task belonging
 * to another conversation never renders here.
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientContext, useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { cronScheduleLabel } from '@kiki/session-core/util';

import { useI18n } from '../../i18n';
import type { CronTask, KikiClient, ListCronTasksResponse } from '../../lib/client';
import { useOptionalConnection } from '../../state/connection';
import { RAIL_MARK } from '../agent-panel/InspectorAgents';
import { INSPECTOR_HEAD, INSPECTOR_LINK } from '../agent-panel/InspectorSection';
import { DisclosureChevron, Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { useNow } from '../RelativeTime';
import { FOCUS_RING } from './shell';

const FALLBACK_QUERY_CLIENT = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

/** Rows shown before the rest fold behind one control of their own. */
const SHOWN_ROWS = 3;
/** `GET /api/cron`'s page maximum; a conversation rarely needs a second page. */
const PAGE_SIZE = 100;

/**
 * The block's head: the same chapter shape as the rail's other folded blocks
 * (quiet label, count, a summary while closed, the family chevron). Kept here
 * rather than imported from DefaultSections — the rail already closes a cycle
 * through that module, and this block is not the place to add another edge to
 * it.
 */
const HEAD = 'group -ml-1.5 flex h-8 w-[calc(100%+0.375rem)] min-w-0 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-left transition-colors hover:bg-ink/[0.04]';

/**
 * The row's action stays out of sight on hover-capable devices until the row
 * is read, so the list reads as scheduled work rather than a column of
 * buttons. Touch and a paused task keep it. Same rule as the rail's task rows.
 */
const HOVER_REVEAL = 'pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100';

const ROW_ACTION = 'rail-cron-action flex h-7 shrink-0 items-center rounded-md px-1.5 text-[12px] transition-[color,background-color,opacity] hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:opacity-50';

const TAIL_BUTTON = `mt-0.5 h-7 rounded-md px-1.5 text-[12px] text-ink-faint transition-colors hover:text-ink ${FOCUS_RING}`;

/** This conversation's own cron page, as one cache family of the /cron list. */
export function sessionCronQueryKey(sessionId: string): readonly [string, string, string] {
  return ['cron-tasks', 'session', sessionId];
}

const EMPTY_CRON_TASKS: readonly CronTask[] = [];

/**
 * Shared read of this conversation's scheduled tasks over `sessionCronQueryKey`.
 * Reused by both `Run` / `RailLiveTopology` and `Config -> SessionCronSection`
 * so TanStack Query deduplicates requests with zero duplicate polling.
 */
export function useSessionCronTasks(sessionId: string, enabled = true): {
  readonly tasks: readonly CronTask[];
  readonly activeTasks: readonly CronTask[];
} {
  const connection = useOptionalConnection();
  const queryClient = useContext(QueryClientContext);
  const queryKey = useMemo(() => sessionCronQueryKey(sessionId), [sessionId]);
  const hasClient = connection !== null && typeof connection.client?.listCronTasks === 'function';
  const canQuery = enabled && hasClient && queryClient !== undefined && Boolean(sessionId && sessionId.trim() !== '');

  const read = useInfiniteQuery(
    {
      queryKey,
      queryFn: ({ pageParam }) =>
        connection!.client.listCronTasks({ session_id: sessionId, page_size: PAGE_SIZE, offset: pageParam }),
      initialPageParam: 0,
      getNextPageParam: (lastPage) => lastPage.next_offset,
      staleTime: 30_000,
      retry: false,
      enabled: canQuery,
    },
    queryClient ?? FALLBACK_QUERY_CLIENT,
  );

  const tasks = useMemo(() => {
    if (!canQuery || read.data === undefined) return EMPTY_CRON_TASKS;
    return read.data.pages.flatMap((page) => page.items).filter((task) => task.session_id === sessionId);
  }, [canQuery, read.data, sessionId]);

  const activeTasks = useMemo(
    () => tasks.filter((task) => !task.paused),
    [tasks],
  );

  return { tasks, activeTasks };
}

/** The block's folding head: title, count, and the next fire while closed. */
function CronHead({
  title,
  count,
  summary,
  open,
  onToggle,
}: {
  readonly title: string;
  readonly count: number | undefined;
  readonly summary: string | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button type="button" id="rail-cron-head" aria-expanded={open} onClick={onToggle} className={`${HEAD} ${FOCUS_RING}`}>
      <span className={`${INSPECTOR_HEAD} transition-colors group-hover:text-ink`}>{title}</span>
      {count === undefined ? null : <span className="text-[12px] text-ink-faint tabular-nums">{count}</span>}
      {!open && summary !== undefined ? <span className="min-w-0 flex-1 truncate text-right text-[12px] text-ink-faint">{summary}</span> : <span className="flex-1" />}
      <DisclosureChevron open={open} />
    </button>
  );
}

/** Countdown to the next fire, aging with the shared clock. */
export function NextFire({ at }: { readonly at: string }) {
  const { time } = useI18n();
  useNow();
  return (
    <span data-rail-cron-next className="shrink-0 tabular-nums" title={time.absoluteTime(at)}>
      {time.timeUntil(at)}
    </span>
  );
}

function CronRow({
  task,
  pending,
  onOpen,
  onToggle,
  onDelete,
}: {
  readonly task: CronTask;
  readonly pending: boolean;
  readonly onOpen: () => void;
  readonly onToggle: (resume: boolean) => void;
  readonly onDelete?: () => void;
}) {
  const { t, locale } = useI18n();
  const [deleteArmed, setDeleteArmed] = useState(false);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
  }, []);
  const next = task.next_fire_at;
  // The rail reads in the active locale like every other surface: the
  // engine's English phrase would be the one untranslated line in a Chinese
  // rail, and a schedule is the only thing this row is for.
  const schedule = cronScheduleLabel(locale, task.cron, task.human_schedule, t);
  // A paused task advertises how to wake it; an active one keeps its control
  // out of the way until the row is read.
  const reveal = task.paused || pending || deleteArmed ? '' : HOVER_REVEAL;
  return (
    <li
      data-rail-item
      data-rail-cron-row={task.id}
      data-cron-paused={task.paused ? '' : undefined}
      aria-busy={pending}
      className={`rail-cron-row group -mx-2 flex items-center gap-1 rounded-lg px-2 py-1 transition-opacity hover:bg-ink/[0.04] ${pending ? 'opacity-60' : ''}`}
    >
      <button
        type="button"
        data-cron-open={task.id}
        title={task.prompt_preview}
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-start rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
      >
        <span className={RAIL_MARK}>
          <Icon name={task.paused ? 'hold' : 'clock'} size={12} className="text-ink-faint" />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[13px] leading-5 ${task.paused ? 'text-ink-soft' : 'text-ink'}`}>
            {task.prompt_preview}
          </span>
          <span className="flex min-w-0 items-baseline gap-1.5 text-[11.5px] leading-[17px] text-ink-faint">
            <span data-rail-cron-schedule className="min-w-0 truncate" title={schedule}>{schedule}</span>
            {task.paused ? (
              <>
                <span aria-hidden>·</span>
                <span data-rail-cron-state="paused" className="shrink-0">{t('cron.status.paused')}</span>
              </>
            ) : next === null ? null : (
              <>
                <span aria-hidden>·</span>
                <NextFire at={next} />
              </>
            )}
            {/* What firing this does to a busy conversation. It is one word
                here and the full sentence on the page, so the rail can say
                which of the three without opening anything. */}
            <span aria-hidden>·</span>
            <span data-rail-cron-delivery className="shrink-0">{t(`cron.delivery.${task.delivery_mode ?? 'idle'}`)}</span>
          </span>
        </span>
      </button>
      <button
        type="button"
        data-rail-cron-toggle={task.id}
        aria-label={`${t(task.paused ? 'cron.action.resume' : 'cron.action.pause')} · ${task.prompt_preview}`}
        disabled={pending}
        // The control asks for the state the task is not in: a live task
        // pauses, a paused one resumes.
        onClick={() => { onToggle(task.paused); }}
        className={`${ROW_ACTION} ${reveal} ${task.paused ? 'text-ink-soft' : 'text-ink-faint'}`}
      >
        {t(task.paused ? 'cron.action.resume' : 'cron.action.pause')}
      </button>
      {onDelete !== undefined ? (
        <button
          type="button"
          data-rail-cron-delete={task.id}
          data-rail-cron-delete-armed={deleteArmed ? 'true' : undefined}
          aria-label={deleteArmed ? (locale === 'zh' ? '确认删除' : 'Confirm delete') : (locale === 'zh' ? '删除定时任务' : 'Delete scheduled prompt')}
          disabled={pending}
          onClick={() => {
            if (!deleteArmed) {
              setDeleteArmed(true);
              if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
              armTimerRef.current = setTimeout(() => { setDeleteArmed(false); }, 5_000);
              return;
            }
            setDeleteArmed(false);
            if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
            onDelete();
          }}
          className={`${ROW_ACTION} ${reveal} ${deleteArmed ? 'bg-danger/10 text-danger hover:bg-danger/15 hover:text-danger' : 'text-ink-faint hover:bg-danger/10 hover:text-danger'}`}
        >
          {deleteArmed ? (locale === 'zh' ? '确认?' : 'Delete?') : <Icon name="close" size={12} />}
        </button>
      ) : null}
    </li>
  );
}

/**
 * Without a connected client the block makes no claim at all: it stays out
 * rather than reading as "this conversation has nothing scheduled".
 */
export function SessionCronSection({ sessionId }: { readonly sessionId: string }) {
  const connection = useOptionalConnection();
  if (connection === null || !sessionId || sessionId.trim() === '') return null;
  return <SessionCronList sessionId={sessionId} client={connection.client} />;
}

function SessionCronList({ sessionId, client }: { readonly sessionId: string; readonly client: KikiClient }) {
  const { t, time } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [failed, setFailed] = useState<{ readonly id: string; readonly resume: boolean } | null>(null);
  const queryKey = useMemo(() => sessionCronQueryKey(sessionId), [sessionId]);
  const hasValidSession = Boolean(sessionId && sessionId.trim() !== '');

  const read = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => client.listCronTasks({ session_id: sessionId, page_size: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.next_offset,
    staleTime: 30_000,
    retry: false,
    enabled: hasValidSession,
  });

  const toggle = useMutation({
    mutationFn: ({ id, resume }: { readonly id: string; readonly resume: boolean }) =>
      resume ? client.resumeCronTask(id, sessionId) : client.pauseCronTask(id, sessionId),
    onMutate: () => { setFailed(null); },
    onSuccess: (result) => {
      queryClient.setQueryData<InfiniteData<ListCronTasksResponse, number>>(queryKey, (old) =>
        old === undefined ? undefined : {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.map((entry) =>
              entry.id === result.task.id && entry.workspace_id === result.task.workspace_id ? result.task : entry),
          })),
        },
      );
    },
    // A refused pause leaves the row exactly as the server reports it: the
    // state is never guessed from the click.
    onError: (_error, variables) => { setFailed({ id: variables.id, resume: variables.resume }); },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey }); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => client.deleteCronTask(id, sessionId),
    onMutate: () => { setFailed(null); },
    onSuccess: (_result, id) => {
      queryClient.setQueryData<InfiniteData<ListCronTasksResponse, number>>(queryKey, (old) =>
        old === undefined ? undefined : {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.filter((entry) => entry.id !== id),
          })),
        },
      );
    },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey }); },
  });

  const loaded = read.data !== undefined;
  const tasks = useMemo(
    () => (read.data?.pages ?? []).flatMap((page) => page.items).filter((task) => task.session_id === sessionId),
    [read.data, sessionId],
  );
  const shown = showAll ? tasks : tasks.slice(0, SHOWN_ROWS);
  const hidden = tasks.length - shown.length;
  const nextAt = tasks.find((task) => !task.paused && task.next_fire_at !== null)?.next_fire_at ?? null;
  const summary = !loaded
    ? undefined
    : tasks.length === 0
      ? t('rail.cron.empty')
      : nextAt === null ? t('cron.status.paused') : time.timeUntil(nextAt);
  // A folded summary that counts down has to age with the shared clock.
  useNow();
  const busyId = toggle.isPending ? toggle.variables.id : remove.isPending ? remove.variables : undefined;
  const manage = useCallback(() => {
    void navigate(`/cron?session=${encodeURIComponent(sessionId)}`);
  }, [navigate, sessionId]);
  if (loaded && tasks.length === 0 && !read.hasNextPage && !read.isError && failed === null) {
    return null;
  }
  return (
    <section data-rail-cron="" aria-labelledby="rail-cron-head">
      <CronHead
        title={t('rail.cron.title')}
        count={loaded ? tasks.length : undefined}
        summary={summary}
        open={open}
        onToggle={() => { setOpen((value) => !value); }}
      />
      {open ? (
        <div data-rail-cron-body className="pt-1">
          {read.isError && !loaded ? (
            <p role="status" data-rail-cron-unavailable className="pb-0.5 text-[12px] leading-relaxed text-ink-faint">
              {t('rail.cron.unavailable')}
              <button
                type="button"
                data-rail-cron-retry
                onClick={() => { void read.refetch(); }}
                className={`ml-1.5 rounded font-normal text-ink-soft transition-colors hover:text-ink ${FOCUS_RING}`}
              >
                {t('common.retry')}
              </button>
            </p>
          ) : !loaded || tasks.length === 0 ? null : (
            <>
              <ul className="space-y-0.5">
                {shown.map((task) => (
                  <CronRow
                    key={task.id}
                    task={task}
                    pending={busyId === task.id}
                    onOpen={manage}
                    onToggle={(resume) => { toggle.mutate({ id: task.id, resume }); }}
                    onDelete={typeof client.deleteCronTask === 'function' ? () => { remove.mutate(task.id); } : undefined}
                  />
                ))}
              </ul>
              {hidden > 0 || read.hasNextPage ? (
                <div className="flex flex-wrap items-center gap-x-2">
                  {hidden > 0 ? (
                    <button type="button" data-rail-cron-more onClick={() => { setShowAll(true); }} className={TAIL_BUTTON}>
                      {t('rail.cron.more', { count: hidden })}
                    </button>
                  ) : null}
                  {read.hasNextPage ? (
                    <button
                      type="button"
                      data-rail-cron-load-more
                      disabled={read.isFetchingNextPage}
                      onClick={() => { void read.fetchNextPage(); }}
                      className={`${TAIL_BUTTON} disabled:opacity-50`}
                    >
                      {t('rail.cron.loadMore')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
          {failed !== null ? (
            <p
              role="status"
              data-rail-cron-error={failed.id}
              className="flex items-baseline gap-1.5 pt-0.5 text-[12px] leading-relaxed text-ink-faint"
            >
              <span className="min-w-0">{t(failed.resume ? 'rail.cron.resumeFailed' : 'rail.cron.pauseFailed')}</span>
              <button
                type="button"
                data-rail-cron-error-retry
                onClick={() => { toggle.mutate(failed); }}
                className={`shrink-0 rounded font-normal text-ink-soft transition-colors hover:text-ink ${FOCUS_RING}`}
              >
                {t('common.retry')}
              </button>
            </p>
          ) : null}
          {/* The way to manage what this block lists — the page keeps paging,
              deleting and full schedules. Never behind the fold. */}
          <div className="pt-0.5">
            <button type="button" data-rail-cron-manage onClick={manage} className={`${INSPECTOR_LINK} ml-2`}>
              {t('rail.cron.manage')}
              <Icon name="arrowRight" size={12} className="text-ink-faint" />
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function isTaskRecentlyTriggered(task: CronTask, turnStartedAt: number | undefined): boolean {
  if (turnStartedAt === undefined || !Number.isFinite(turnStartedAt)) return false;
  const windowStart = turnStartedAt - 15_000;
  if (task.last_fired_at !== null) {
    const firedAt = Date.parse(task.last_fired_at);
    if (Number.isFinite(firedAt) && firedAt >= windowStart) return true;
  }
  const check = task.last_trigger_check;
  if (check !== undefined && check.outcome === 'allowed' && check.checkedAt >= windowStart) {
    return true;
  }
  return false;
}

/**
 * Quiet active-only scheduled tasks section inside the `Run` tab.
 * Renders `null` (0px) when zero active (non-paused) cron tasks exist so an
 * idle `Run` rail stays completely uncluttered.
 */
export function RunCronSection({
  sessionId,
  activeTasks,
  cronTurnActive = false,
  turnStartedAt,
}: {
  readonly sessionId: string;
  readonly activeTasks: readonly CronTask[];
  readonly cronTurnActive?: boolean;
  readonly turnStartedAt?: number;
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const connection = useOptionalConnection();
  const queryClient = useContext(QueryClientContext);
  const [showAll, setShowAll] = useState(false);
  const [failedId, setFailedId] = useState<string | null>(null);
  const queryKey = useMemo(() => sessionCronQueryKey(sessionId), [sessionId]);

  const pause = useMutation(
    {
      mutationFn: (id: string) => connection!.client.pauseCronTask(id, sessionId),
      onMutate: () => { setFailedId(null); },
      onSuccess: (result) => {
        queryClient?.setQueryData<InfiniteData<ListCronTasksResponse, number>>(queryKey, (old) =>
          old === undefined ? undefined : {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              items: page.items.map((entry) =>
                entry.id === result.task.id && entry.workspace_id === result.task.workspace_id ? result.task : entry),
            })),
          },
        );
      },
      onError: (_error, id) => { setFailedId(id); },
      onSettled: () => { void queryClient?.invalidateQueries({ queryKey }); },
    },
    queryClient ?? FALLBACK_QUERY_CLIENT,
  );

  const manage = useCallback(() => {
    void navigate(`/cron?session=${encodeURIComponent(sessionId)}`);
  }, [navigate, sessionId]);

  if (activeTasks.length === 0) return null;

  const canPause = connection !== null && typeof connection.client?.pauseCronTask === 'function';
  const shown = showAll ? activeTasks : activeTasks.slice(0, SHOWN_ROWS);
  const hidden = activeTasks.length - shown.length;
  const matchedRunningIds = new Set<string>();
  if (cronTurnActive) {
    for (const task of activeTasks) {
      if (isTaskRecentlyTriggered(task, turnStartedAt)) matchedRunningIds.add(task.id);
    }
    if (matchedRunningIds.size === 0 && activeTasks.length === 1) {
      matchedRunningIds.add(activeTasks[0]!.id);
    }
  }
  const headerRunning = cronTurnActive && matchedRunningIds.size === 0;

  return (
    <section data-rail-run-cron="" aria-labelledby="rail-run-cron-head">
      <header className="flex h-7 min-w-0 items-center gap-1.5">
        <h3 id="rail-run-cron-head" className={`${INSPECTOR_HEAD} whitespace-nowrap`}>
          {t('cron.panel.title')}
        </h3>
        <span className="text-[12px] text-ink-faint tabular-nums">{activeTasks.length}</span>
        {headerRunning ? (
          <span data-rail-run-cron-live="" className="inline-flex items-center gap-1 text-[11px] font-normal text-accent">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
            {t('rail.cron.running')}
          </span>
        ) : null}
        <button
          type="button"
          data-rail-run-cron-manage=""
          onClick={manage}
          title={t('rail.cron.manage')}
          aria-label={t('rail.cron.manage')}
          className={`ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink pointer-coarse:h-9 pointer-coarse:w-9 ${FOCUS_RING}`}
        >
          <Icon name="arrowUpRight" size={12} />
        </button>
      </header>
      <ul className="mt-0.5 space-y-0.5">
        {shown.map((task) => {
          const pending = pause.isPending && pause.variables === task.id;
          const running = matchedRunningIds.has(task.id);
          const schedule = cronScheduleLabel(locale, task.cron, task.human_schedule, t);
          const reveal = pending ? '' : HOVER_REVEAL;
          return (
            <li
              key={task.id}
              data-rail-item
              data-rail-run-cron-row={task.id}
              data-rail-cron-running={running ? '' : undefined}
              aria-busy={pending}
              className={`rail-cron-row group -mx-2 flex items-center gap-1 rounded-lg px-2 py-1 transition-opacity hover:bg-ink/[0.04] ${pending ? 'opacity-60' : ''}`}
            >
              <button
                type="button"
                data-cron-open={task.id}
                title={task.prompt_preview}
                onClick={manage}
                className="flex min-w-0 flex-1 cursor-pointer items-start rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
              >
                <span className={RAIL_MARK}>
                  {running ? (
                    <LifeMark markId={`cron:${task.id}`} life="working" tone="bg-success" still />
                  ) : (
                    <Icon name="clock" size={12} className="text-ink-faint" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-5 text-ink">
                    {task.prompt_preview}
                  </span>
                  <span className="flex min-w-0 items-baseline gap-1.5 text-[11.5px] leading-[17px] text-ink-faint">
                    <span data-rail-cron-schedule className="min-w-0 truncate" title={schedule}>{schedule}</span>
                    {running ? (
                      <>
                        <span aria-hidden>·</span>
                        <span data-rail-run-cron-live="" className="shrink-0 font-normal text-accent">{t('rail.cron.running')}</span>
                      </>
                    ) : task.next_fire_at !== null ? (
                      <>
                        <span aria-hidden>·</span>
                        <NextFire at={task.next_fire_at} />
                      </>
                    ) : null}
                  </span>
                </span>
              </button>
              {canPause ? (
                <button
                  type="button"
                  data-rail-cron-toggle={task.id}
                  aria-label={`${t('cron.action.pause')} · ${task.prompt_preview}`}
                  disabled={pending}
                  onClick={() => { pause.mutate(task.id); }}
                  className={`${ROW_ACTION} ${reveal} text-ink-faint`}
                >
                  {t('cron.action.pause')}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <button type="button" data-rail-run-cron-more="" onClick={() => { setShowAll(true); }} className={TAIL_BUTTON}>
          {t('rail.cron.more', { count: hidden })}
        </button>
      ) : null}
      {failedId !== null ? (
        <p
          role="status"
          data-rail-cron-error={failedId}
          className="flex items-baseline gap-1.5 pt-0.5 text-[12px] leading-relaxed text-ink-faint"
        >
          <span className="min-w-0">{t('rail.cron.pauseFailed')}</span>
          <button
            type="button"
            data-rail-cron-error-retry
            onClick={() => { pause.mutate(failedId); }}
            className={`shrink-0 rounded font-normal text-ink-soft transition-colors hover:text-ink ${FOCUS_RING}`}
          >
            {t('common.retry')}
          </button>
        </p>
      ) : null}
    </section>
  );
}
