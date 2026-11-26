/**
 * /cron — the one scheduled-tasks page (`GET /api/cron`, every workspace).
 *
 * Workspace is a client-side filter: `?workspace=<id>` (pre-filled when the
 * sidebar nav or the inspector link opens it from a session) narrows the
 * list; the scope bar under the title widens back to all workspaces. Every row
 * keeps its workspace tag either way. `?session=<id>` (the rail's per-
 * conversation entry) is a server-side filter instead: the server narrows to
 * that conversation before it pages, so page N is page N of this
 * conversation's own tasks. Neither filter is a substitute for the other.
 * Rows split into Active / Paused sections on the server's paused-last order,
 * next fire time leading.
 *
 * A row leads with what a person reads a schedule by: the human cadence, in
 * the active locale. The engine's English string ("at minute 0 of every
 * hour") and the raw expression are facts about the rule, not the interface,
 * so they live in the row's expanded panel instead of standing in for the
 * schedule. `next_fire_at` is the only timing this page ever plots or counts
 * down to, and it is the server's number, never a schedule phrase re-evaluated
 * in browser local time into multiple future runs.
 *
 * Row actions ride the per-task routes (`:pause` / `:resume` / `:run` /
 * PATCH / DELETE); the list's `session_id` always travels back as the
 * disambiguating query so a shared id never trips 40001. Pause/resume patch
 * the row from the returned task and invalidate, so the server's paused-last
 * ordering settles on the same pass. Delete goes through a ConfirmDialog.
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { CronDeliveryMode, Session, WorkspaceCatalogEntry } from '@kiki/protocol';
import { ErrorCode } from '@kiki/protocol';
import { useSearchParams } from 'react-router-dom';
import type { To } from 'react-router-dom';

import { errorText, type I18nKey, type I18nParams, type Locale } from '@kiki/session-core/i18n';
import { cronScheduleLabel, localizedCronSchedule } from '@kiki/session-core/util';

import { useI18n } from '../i18n';
import {
  ApiError,
  type CronTask,
  type CronTaskDetail,
  type ListCronTasksResponse,
  type UpdateCronTaskRequest,
} from '../lib/client';
import { pushToast } from '../lib/toasts';
import { useThreadTitle } from '../lib/threadTitles';
import { useConnection } from '../state/connection';
import { ConfirmDialog } from './ConfirmDialog';
import { CronTaskEditor } from './CronTaskEditor';
import { PAGE_WIDTH, PageHeader, useWorkspaceScope } from './PageChrome';
import { useNow } from './RelativeTime';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';
import { usePhoneMode } from '../lib/layoutHooks';
import { WorkspaceScopeControl } from './WorkspaceScopeControl';

export const CRON_TASKS_QUERY_KEY = ['cron-tasks'] as const;

export type CronTimelineWindow = '24h' | '7d';

const TIMELINE_WINDOW_MS: Record<CronTimelineWindow, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

const MAX_TIMELINE_LANES = 3;
const LANE_MIN_GAP_FRACTION = 0.022;

export interface CronPageProps {
  readonly sessions: readonly Session[];
  readonly workspaceOptions: readonly WorkspaceCatalogEntry[];
  readonly onNavigate: (target: To) => void;
  readonly onToggleSidebar: () => void;
}

/** Collision-safe task identity across workspaces and sessions. */
export function cronTaskKey(task: Pick<CronTask, 'workspace_id' | 'session_id' | 'id'>): string {
  return `${task.workspace_id}:${task.session_id ?? ''}:${task.id}`;
}

/** Client-side workspace scope for the cross-workspace list. */
export function filterCronTasks<T extends { readonly workspace_id: string }>(
  tasks: readonly T[],
  workspaceId: string | undefined,
): T[] {
  return workspaceId === undefined ? [...tasks] : tasks.filter((task) => task.workspace_id === workspaceId);
}

export interface CronTimelineMarker {
  readonly key: string;
  readonly task: CronTask;
  readonly nextMs: number;
  readonly fraction: number;
  readonly lane: number;
}

export interface CronTimelineProjection {
  readonly overdue: readonly CronTask[];
  readonly inWindow: readonly CronTimelineMarker[];
  readonly later: readonly CronTask[];
}

/**
 * Projects at most the single server-returned `next_fire_at` instant per
 * eligible loaded task into the chosen preview window. Never parses cron
 * expressions or clamps out-of-range instants to window edges.
 */
export function projectNextCheckTimeline(
  tasks: readonly CronTask[],
  nowMs: number,
  window: CronTimelineWindow,
): CronTimelineProjection {
  const durationMs = TIMELINE_WINDOW_MS[window];
  const windowEndMs = nowMs + durationMs;
  const overdue: { readonly task: CronTask; readonly nextMs: number }[] = [];
  const rawInWindow: { readonly key: string; readonly task: CronTask; readonly nextMs: number; readonly fraction: number }[] = [];
  const later: CronTask[] = [];

  for (const task of tasks) {
    if (task.paused || task.next_fire_at === null) continue;
    const nextMs = Date.parse(task.next_fire_at);
    if (!Number.isFinite(nextMs)) continue;
    if (nextMs < nowMs) {
      overdue.push({ task, nextMs });
    } else if (nextMs <= windowEndMs) {
      rawInWindow.push({
        key: cronTaskKey(task),
        task,
        nextMs,
        fraction: (nextMs - nowMs) / durationMs,
      });
    } else {
      later.push(task);
    }
  }

  overdue.sort((a, b) => a.nextMs - b.nextMs);
  rawInWindow.sort((a, b) => a.nextMs - b.nextMs);

  const laneLastFraction = Array.from({ length: MAX_TIMELINE_LANES }, () => -1);
  const inWindow: CronTimelineMarker[] = rawInWindow.map((item) => {
    let chosenLane = -1;
    for (let lane = 0; lane < MAX_TIMELINE_LANES; lane += 1) {
      if (item.fraction - laneLastFraction[lane]! >= LANE_MIN_GAP_FRACTION) {
        chosenLane = lane;
        break;
      }
    }
    if (chosenLane === -1) {
      let minVal = Infinity;
      chosenLane = 0;
      for (let lane = 0; lane < MAX_TIMELINE_LANES; lane += 1) {
        if (laneLastFraction[lane]! < minVal) {
          minVal = laneLastFraction[lane]!;
          chosenLane = lane;
        }
      }
    }
    laneLastFraction[chosenLane] = item.fraction;
    return { ...item, lane: chosenLane };
  });

  return {
    overdue: overdue.map((entry) => entry.task),
    inWindow,
    later,
  };
}

type Translate = (key: I18nKey, params?: I18nParams) => string;

/** Friendly text for the cron route's actionable error codes. */
function cronErrorText(error: unknown, t: Translate, locale?: Locale): string {
  if (error instanceof ApiError) {
    if (error.code === ErrorCode.TASK_NOT_FOUND) return t('cron.error.notFound');
    if (error.code === ErrorCode.VALIDATION_FAILED) return t('cron.error.ambiguous');
  }
  if (locale !== undefined) return errorText(locale, error);
  return error instanceof Error ? error.message : String(error);
}

function ClockGlyph({ className }: { readonly className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      className={className}
    >
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6V8l2.3 1.6" />
    </svg>
  );
}

/** Countdown to the next fire ("in 5m"), aging with the shared 1s clock. */
function NextFire({ at }: { readonly at: string }) {
  const { time } = useI18n();
  useNow();
  return (
    <span className="tabular-nums" title={time.absoluteTime(at)}>
      {time.timeUntil(at)}
    </span>
  );
}

function LastFire({ at }: { readonly at: string | null }) {
  const { t, time } = useI18n();
  useNow();
  if (at === null) return <>{t('cron.neverRun')}</>;
  return (
    <span className="tabular-nums" title={time.absoluteTime(at)}>
      {time.relativeTime(at)}
    </span>
  );
}

const CHIP_BASE =
  'shrink-0 rounded-sm border border-transparent px-1.5 py-px text-[12px] leading-4 font-normal';

/** Fine-hover reveal rule: visible on touch and keyboard focus, quiet at rest on hover-capable desktops. */
const ROW_ACTION_QUIET =
  'opacity-100 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100 focus-visible:opacity-100';

/**
 * The delivery mode a row advertises. Absent on an older host, and on a task
 * that predates modes: both read as the default the host will apply on the
 * next fire, so the label never claims a distinction the server is not making.
 */
export function cronDeliveryMode(task: CronTask): CronDeliveryMode {
  return task.delivery_mode ?? 'idle';
}

function formatOffsetTick(window: CronTimelineWindow, step: number, locale: Locale): string {
  if (window === '24h') {
    const hours = step * 6;
    return locale === 'zh' ? `+${hours}小时` : `+${hours}h`;
  }
  return locale === 'zh' ? `+${step}天` : `+${step}d`;
}

interface CronNextCheckTimelineProps {
  readonly tasks: readonly CronTask[];
  readonly hasMorePages: boolean;
  readonly window: CronTimelineWindow;
  readonly onChangeWindow: (next: CronTimelineWindow) => void;
  readonly hoveredKey: string | null;
  readonly onHoverKey: (key: string | null) => void;
  readonly onFocusTask: (task: CronTask) => void;
  readonly resolveOwner: (task: CronTask) => string;
}

/**
 * Desktop-only horological ribbon showing at most the single server-returned
 * `next_fire_at` instant per eligible loaded task inside the selected window.
 * Narrow viewports omit this bead field and keep the text ledger below.
 */
function CronNextCheckTimeline({
  tasks,
  hasMorePages,
  window,
  onChangeWindow,
  hoveredKey,
  onHoverKey,
  onFocusTask,
  resolveOwner,
}: CronNextCheckTimelineProps) {
  const { t, tp, locale, time } = useI18n();
  const nowMs = useNow();
  const projection = useMemo(
    () => projectNextCheckTimeline(tasks, nowMs, window),
    [tasks, nowMs, window],
  );
  const ticks = useMemo(
    () => window === '24h'
      ? [1, 2, 3, 4].map((step) => ({ fraction: step / 4, label: formatOffsetTick('24h', step, locale) }))
      : [1, 2, 3, 4, 5, 6, 7].map((step) => ({ fraction: step / 7, label: formatOffsetTick('7d', step, locale) })),
    [window, locale],
  );
  const hoveredMarker = hoveredKey === null
    ? undefined
    : projection.inWindow.find((marker) => marker.key === hoveredKey);

  return (
    <section
      data-cron-timeline
      data-cron-timeline-window={window}
      aria-label={t('cron.timeline.heading')}
      className="hidden border-b border-hairline pb-4 md:block"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h2 className="text-[12px] leading-4 font-bold text-section-ink">{t('cron.timeline.heading')}</h2>
          <span className="text-[12px] leading-4 text-ink-faint">{t('cron.timeline.nextOnly')}</span>
          <span className="text-[12px] leading-4 text-ink-faint tabular-nums" data-cron-timeline-in-window>
            · {tp('cron.timeline.inWindow', projection.inWindow.length)}
          </span>
          {projection.overdue.length > 0 ? (
            <button
              type="button"
              data-cron-timeline-overdue
              onClick={() => { onFocusTask(projection.overdue[0]!); }}
              className="rounded-sm bg-amber-card px-1.5 py-px text-[12px] leading-4 font-normal text-amber-ink tabular-nums transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-selected-ink"
            >
              {tp('cron.timeline.overdue', projection.overdue.length)}
            </button>
          ) : null}
          {projection.later.length > 0 ? (
            <span data-cron-timeline-later className="text-[12px] leading-4 text-ink-faint tabular-nums">
              · {tp('cron.timeline.later', projection.later.length)}
            </span>
          ) : null}
          {hasMorePages ? (
            <span data-cron-timeline-more className="text-[12px] leading-4 text-ink-faint">
              · {t('cron.timeline.morePages')}
            </span>
          ) : null}
        </div>
        <div
          role="group"
          aria-label={t('cron.timeline.windowAria')}
          className="ml-auto inline-flex items-center gap-0.5 rounded-md bg-ink/[0.04] p-0.5"
        >
          {(['24h', '7d'] as const).map((candidate) => {
            const active = candidate === window;
            return (
              <button
                key={candidate}
                type="button"
                data-cron-window={candidate}
                aria-pressed={active}
                onClick={() => { onChangeWindow(candidate); }}
                className={`h-6 rounded-[4px] px-2 text-[12px] leading-4 tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink ${
                  active ? 'bg-panel font-normal text-ink shadow-[var(--kiki-sheet-shadow)]' : 'text-ink-soft hover:text-ink'
                }`}
              >
                {t(candidate === '24h' ? 'cron.timeline.window24h' : 'cron.timeline.window7d')}
              </button>
            );
          })}
        </div>
      </div>

      <div data-cron-timeline-track className="relative mt-3 h-[58px] select-none">
        {/* Horizontal datum hairline */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-[18px] h-px bg-hairline" />

        {/* Vermilion Now vertical needle */}
        <div aria-hidden className="pointer-events-none absolute top-0 bottom-[18px] left-0 w-[1.5px] bg-accent" />
        <span
          data-cron-timeline-now
          className="pointer-events-none absolute bottom-0 left-0 text-[12px] leading-4 font-normal text-accent-ink tabular-nums"
        >
          {t('cron.timeline.now')}
        </span>

        {/* Offset tick hairlines (timezone-independent deltas from Now) */}
        {ticks.map((tick) => (
          <div
            key={tick.label}
            aria-hidden
            style={{ left: `${tick.fraction * 100}%` }}
            className="pointer-events-none absolute top-1 bottom-[18px] w-px bg-hairline/70"
          >
            <span
              className={`absolute top-[calc(100%+4px)] text-[12px] leading-4 whitespace-nowrap text-ink-faint tabular-nums ${
                tick.fraction >= 0.98 ? 'right-0' : '-translate-x-1/2'
              }`}
            >
              {tick.label}
            </span>
          </div>
        ))}

        {projection.inWindow.length === 0 ? (
          <p
            data-cron-timeline-empty
            className="pointer-events-none absolute inset-x-0 top-2.5 text-center text-[12px] leading-4 text-ink-faint"
          >
            {t('cron.timeline.emptyWindow')}
          </p>
        ) : (
          projection.inWindow.map((marker) => {
            const { task } = marker;
            const active = hoveredKey === marker.key;
            const conditional = task.trigger !== undefined;
            const friendly = localizedCronSchedule(locale, task.cron, t) ?? t('cron.schedule.custom');
            const kindLabel = task.recurring
              ? `${t('cron.kind.recurring')} (${t('cron.timeline.nextOnly')})`
              : t('cron.kind.oneShot');
            const whenLabel = task.next_fire_at !== null ? time.timeUntil(task.next_fire_at) : '';
            const aria = t('cron.timeline.markerAria', {
              schedule: friendly,
              kind: conditional ? `${kindLabel}, ${t('cron.status.conditional')}` : kindLabel,
              when: whenLabel,
              owner: resolveOwner(task),
            });
            const dotClass = conditional
              ? task.stale
                ? 'border-[1.5px] border-amber-ink bg-paper'
                : 'border-[1.5px] border-selected-ink bg-paper'
              : task.stale
                ? 'bg-amber-ink'
                : 'bg-selected-ink';
            return (
              <button
                key={marker.key}
                type="button"
                data-cron-marker={marker.key}
                data-cron-marker-task={task.id}
                data-cron-marker-session={task.session_id ?? ''}
                data-cron-marker-conditional={conditional ? 'true' : undefined}
                aria-label={aria}
                title={aria}
                onMouseEnter={() => { onHoverKey(marker.key); }}
                onMouseLeave={() => { onHoverKey(null); }}
                onFocus={() => { onHoverKey(marker.key); }}
                onBlur={() => { onHoverKey(null); }}
                onClick={() => { onFocusTask(task); }}
                style={{
                  left: `clamp(6px, ${marker.fraction * 100}%, calc(100% - 6px))`,
                  top: `${marker.lane * 11 + 2}px`,
                }}
                className="group/marker absolute flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-selected-ink"
              >
                <span
                  className={`block rounded-full transition-transform duration-[var(--kiki-motion-quick)] ${dotClass} ${
                    active ? 'h-2.5 w-2.5 scale-110 ring-2 ring-selected-ink/30' : 'h-[7px] w-[7px] group-hover/marker:scale-125'
                  }`}
                />
              </button>
            );
          })
        )}
      </div>

      <div className="mt-1.5 min-h-[18px]">
        {hoveredMarker !== undefined && hoveredMarker.task.next_fire_at !== null ? (
          <p data-cron-timeline-readout className="flex min-w-0 items-center gap-x-2 truncate text-[12px] leading-4 text-ink-soft tabular-nums">
            <span className="font-normal text-ink">
              {localizedCronSchedule(locale, hoveredMarker.task.cron, t) ?? t('cron.schedule.custom')}
            </span>
            <span aria-hidden>·</span>
            <span>{time.timeUntil(hoveredMarker.task.next_fire_at)} ({time.absoluteTime(hoveredMarker.task.next_fire_at)})</span>
            <span aria-hidden>·</span>
            <span className="truncate text-ink-faint">{resolveOwner(hoveredMarker.task)}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** A label, a field: the two-line shape every value row in the panel uses. */
function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0 sm:grid sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3 sm:py-0.5">
      <dt className="text-[12px] text-ink-faint sm:pt-px">{label}</dt>
      <dd className="min-w-0 text-[13px] leading-5 text-ink-soft">{children}</dd>
    </div>
  );
}

interface CronDetailProps {
  readonly task: CronTask;
  readonly sessionTitle: string | undefined;
  readonly workspaceName: string | undefined;
  readonly pending: boolean;
  readonly onEdit: () => void;
  readonly onRun: (task: CronTask) => void;
  readonly onDelete: (task: CronTask) => void;
  readonly onOpenSession: (sessionId: string) => void;
}

/**
 * The row opened. It shows the two things the collapsed row cannot: the
 * prompt in full, and the expression behind the schedule. The full prompt is
 * read from the server on open, because the list row only ever carries a
 * truncated preview. The row's remaining verbs (edit, run now, delete) live
 * in this footer's quiet line, so the collapsed row carries only the one
 * state control a schedule is managed by.
 */
function CronDetail({ task, sessionTitle, workspaceName, pending, onEdit, onRun, onDelete, onOpenSession }: CronDetailProps) {
  const { t, time } = useI18n();
  return (
    <div
      data-cron-detail
      className="mt-3 space-y-3 border-t border-hairline/80 pt-3"
    >
      <div className="min-w-0">
        <p className="text-[12px] leading-4 text-ink-faint">{t('cron.detail.prompt')}</p>
        <CronDetailPrompt task={task} />
      </div>
      <dl className="space-y-1.5">
        <Fact label={t('cron.detail.schedule')}>
          {task.next_fire_at === null
            ? <span className="text-ink-faint">{t('cron.status.paused')}</span>
            : <span className="tabular-nums">{time.absoluteTime(task.next_fire_at)}</span>}
        </Fact>
        {/* The detail says what firing the prompt does to a busy conversation,
            because that is the one fact the schedule itself cannot carry. */}
        <Fact label={t('cron.detail.delivery')}>
          {t(`cron.delivery.${cronDeliveryMode(task)}`)}
          <span className="mt-0.5 block text-[12px] leading-4 text-ink-faint">
            {t(`cron.delivery.hint.${cronDeliveryMode(task)}`)}
          </span>
        </Fact>
        <Fact label={t('cron.detail.expression')}>
          <span className="font-mono text-[12px] text-ink">{task.cron}</span>
          <span className="mt-0.5 block text-[12px] leading-4 text-ink-faint">
            {t('cron.detail.expressionHint')}
          </span>
        </Fact>
        <Fact label={t('cron.detail.owner')}>
          {task.session_id === null ? (
            <>
              <span className="text-ink-faint">{t('cron.detail.unbound')}</span>
              <span className="mt-0.5 block text-[12px] leading-4 text-ink-faint">
                {t('cron.detail.unboundHint')}
              </span>
            </>
          ) : sessionTitle === undefined ? (
            <span className="font-mono text-[12px] leading-4">{task.session_id}</span>
          ) : (
            <button
              type="button"
              data-cron-detail-session={task.session_id}
              onClick={() => { onOpenSession(task.session_id as string); }}
              className="max-w-full truncate text-left font-normal text-ink-soft underline-offset-2 transition-colors hover:text-ink hover:underline"
              title={sessionTitle}
            >
              {sessionTitle}
            </button>
          )}
        </Fact>
        <Fact label={t('cron.detail.workspace')}>{workspaceName ?? task.workspace_id}</Fact>
        <Fact label={t('cron.detail.created')}>{time.absoluteTime(task.created_at)}</Fact>
      </dl>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1">
        <button
          type="button"
          data-cron-action="edit"
          disabled={pending}
          onClick={onEdit}
          className="text-[13px] leading-5 font-normal text-ink-soft underline-offset-2 transition-colors hover:text-ink hover:underline disabled:opacity-50"
        >
          {t('cron.action.edit')}
        </button>
        <button
          type="button"
          data-cron-action="run"
          disabled={pending}
          onClick={() => { onRun(task); }}
          className="text-[13px] leading-5 font-normal text-ink-soft underline-offset-2 transition-colors hover:text-ink hover:underline disabled:opacity-50"
        >
          {t('cron.action.run')}
        </button>
        <button
          type="button"
          data-cron-action="delete"
          disabled={pending}
          onClick={() => { onDelete(task); }}
          className="text-[13px] leading-5 text-danger underline-offset-2 transition-colors hover:text-danger hover:underline disabled:opacity-50"
        >
          {t('cron.action.delete')}
        </button>
      </div>
    </div>
  );
}

interface CronTaskRowProps {
  readonly task: CronTask;
  readonly taskKey: string;
  readonly sessionTitle: string | undefined;
  readonly workspaceName: string | undefined;
  readonly schedule: string;
  /** The localizer had no friendly shape for this rule; the raw expression is the fact. */
  readonly customSchedule: boolean;
  readonly pending: boolean;
  readonly expanded: boolean;
  readonly highlighted: boolean;
  readonly nowMs: number;
  readonly registerRow: (key: string, node: HTMLLIElement | null) => void;
  readonly registerExpandButton: (key: string, node: HTMLButtonElement | null) => void;
  readonly onHover: (key: string | null) => void;
  readonly onToggleDetail: () => void;
  readonly onEdit: () => void;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onPauseResume: (task: CronTask, pause: boolean) => void;
  readonly onRun: (task: CronTask) => void;
  readonly onDelete: (task: CronTask) => void;
}

function CronTaskRow({
  task,
  taskKey,
  sessionTitle,
  workspaceName,
  schedule,
  customSchedule,
  pending,
  expanded,
  highlighted,
  nowMs,
  registerRow,
  registerExpandButton,
  onHover,
  onToggleDetail,
  onEdit,
  onOpenSession,
  onPauseResume,
  onRun,
  onDelete,
}: CronTaskRowProps) {
  const { t } = useI18n();
  const phone = usePhoneMode();
  const sessionId = task.session_id;
  const shownTitle = useThreadTitle(sessionTitle ?? '');
  const nextMs = task.next_fire_at === null ? Number.NaN : Date.parse(task.next_fire_at);
  const overdue = !task.paused && Number.isFinite(nextMs) && nextMs < nowMs;
  const conditional = task.trigger !== undefined;

  // The section heading already says Enabled or Paused, so the row does not
  // repeat it; how the plan repeats and how it lands is one fact, not two chips.
  const cadence = `${task.recurring ? t('cron.kind.recurring') : t('cron.kind.oneShot')} · ${t(`cron.delivery.${cronDeliveryMode(task)}`)}`;
  const pauseButton = (
    <button
      type="button"
      data-cron-action="pause"
      disabled={pending}
      onClick={() => { onPauseResume(task, !task.paused); }}
      className={`inline-flex h-8 shrink-0 items-center justify-center rounded-md px-2.5 text-[13px] leading-5 font-normal text-ink-soft transition-all hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${
        expanded || pending ? 'opacity-100' : ROW_ACTION_QUIET
      }`}
    >
      {task.paused ? t('cron.action.resume') : t('cron.action.pause')}
    </button>
  );
  const scheduleButton = (
    <button
      ref={(node) => { registerExpandButton(taskKey, node); }}
      type="button"
      data-cron-action="expand"
      aria-expanded={expanded}
      aria-label={t(expanded ? 'cron.action.collapseAria' : 'cron.action.expandAria', { schedule })}
      onClick={onToggleDetail}
      className="inline-flex min-w-0 items-center gap-1.5 rounded text-left transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
    >
      <Chevron open={expanded} />
      <span data-cron-schedule className="min-w-0 text-[13px] leading-5 font-normal text-ink">
        {schedule}
      </span>
    </button>
  );
  const conditionalChip = conditional ? (
    <span data-cron-conditional className={`${CHIP_BASE} bg-selected/60 text-selected-ink`}>
      {t('cron.status.conditional')}
    </span>
  ) : null;
  const staleChip = task.stale ? (
    <span data-cron-status="stale" title={t('cron.status.staleTitle')} className={`${CHIP_BASE} bg-amber-card text-amber-ink`}>
      {t('cron.status.stale')}
    </span>
  ) : null;
  const cadenceFact = (
    <span data-cron-delivery={cronDeliveryMode(task)} className="shrink-0 text-[12px] text-ink-faint">
      {cadence}
    </span>
  );
  const target = (
    <>
      <span data-cron-workspace className="inline-flex max-w-44 items-center gap-1 truncate" title={task.workspace_id}>
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-hairline-strong" />
        <span className={`truncate ${workspaceName === undefined ? 'font-mono' : ''}`}>{workspaceName ?? task.workspace_id}</span>
      </span>
      {sessionId !== null ? (
        sessionTitle !== undefined ? (
          <button
            type="button"
            data-cron-session={sessionId}
            onClick={() => { onOpenSession(sessionId); }}
            className="max-w-56 truncate font-normal text-ink-soft underline-offset-2 transition-colors hover:text-ink hover:underline"
            title={shownTitle}
          >
            {shownTitle}
          </button>
        ) : (
          <span className="max-w-48 truncate font-mono" title={sessionId}>
            {sessionId}
          </span>
        )
      ) : null}
    </>
  );
  const detail = expanded ? (
    <CronDetail
      task={task}
      sessionTitle={sessionTitle}
      workspaceName={workspaceName}
      pending={pending}
      onEdit={onEdit}
      onRun={onRun}
      onDelete={onDelete}
      onOpenSession={onOpenSession}
    />
  ) : null;

  // A phone row is three lines — when it fires next, which rule for what,
  // and the prompt cut to one line — with pause/resume reachable at the end of
  // the first line, keeping the text ledger scannable on 390px viewports.
  if (phone) {
    return (
      <li
        ref={(node) => { registerRow(taskKey, node); }}
        data-cron-task={task.id}
        data-cron-session-id={task.session_id ?? ''}
        data-cron-key={taskKey}
        aria-busy={pending}
        className={`py-3 transition-colors ${pending ? 'opacity-60' : ''} ${highlighted ? 'bg-selected/25' : ''}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            {task.next_fire_at !== null ? (
              <>
                <span className="sr-only">{t('cron.nextFire')} </span>
                <span className={`font-sans text-[16px] leading-6 font-normal tabular-nums ${overdue ? 'text-amber-ink' : 'text-ink'}`}>
                  <NextFire at={task.next_fire_at} />
                </span>
                {overdue ? (
                  <span data-cron-overdue className="ml-1.5 text-[12px] leading-4 font-normal text-amber-ink">{t('cron.status.overdue')}</span>
                ) : null}
              </>
            ) : (
              <span className="text-[12px] text-ink-faint">
                <span className="sr-only">{t('cron.lastFire')}: </span>
                <LastFire at={task.last_fired_at} />
              </span>
            )}
          </span>
          {pauseButton}
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-faint">
          {scheduleButton}
          {cadenceFact}
          {conditionalChip}
          {staleChip}
          {target}
        </div>
        <p className="mt-1 truncate text-[13px] text-ink-soft">
          {task.prompt_preview.replace('…(truncated)', '…')}
        </p>
        {detail}
      </li>
    );
  }

  return (
    <li
      ref={(node) => { registerRow(taskKey, node); }}
      data-cron-task={task.id}
      data-cron-session-id={task.session_id ?? ''}
      data-cron-key={taskKey}
      aria-busy={pending}
      onMouseEnter={() => { onHover(taskKey); }}
      onMouseLeave={() => { onHover(null); }}
      className={`group -mx-2 rounded-md px-2 py-3.5 transition-colors ${pending ? 'opacity-60' : ''} ${
        highlighted ? 'bg-selected/25' : 'hover:bg-ink/[0.025]'
      }`}
    >
      <div className="grid grid-cols-1 gap-x-6 gap-y-2 lg:grid-cols-[9.5rem_minmax(0,1fr)_5.5rem] lg:items-start">
        {/* When: next scheduled instant + muted last run, under shared column heading. */}
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 lg:flex-col lg:gap-0.5">
          {task.next_fire_at !== null ? (
            <span className={`font-sans text-[16px] leading-6 font-normal tabular-nums ${overdue ? 'text-amber-ink' : 'text-ink'}`}>
              <span className="sr-only">{t('cron.nextFire')} </span>
              <NextFire at={task.next_fire_at} />
            </span>
          ) : (
            <span className="text-[13px] leading-5 font-normal text-ink-faint">{t('cron.status.paused')}</span>
          )}
          {overdue ? (
            <span data-cron-overdue className="text-[12px] leading-4 font-normal text-amber-ink">{t('cron.status.overdue')}</span>
          ) : null}
          <span className="text-[12px] leading-4 text-ink-faint tabular-nums">
            <span className="sr-only">{t('cron.lastFire')}: </span>
            <LastFire at={task.last_fired_at} />
          </span>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* The schedule, in the reader's language; clicking it opens the
                row, the row's one click target. Pause/resume stays the only
                control that changes state from the collapsed row. */}
            {scheduleButton}
            {cadenceFact}
            {conditionalChip}
            {staleChip}
          </div>
          {/* A rule the localizer cannot name reads as a custom schedule with
              the raw expression as the fact under it, never as the bold title. */}
          {customSchedule ? (
            <p className="mt-0.5 font-mono text-[12px] leading-4 text-ink-faint" title={task.cron}>{task.cron}</p>
          ) : null}
          <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-soft">
            {task.prompt_preview.replace('…(truncated)', '…')}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-faint">
            {target}
          </div>
          {detail}
        </div>

        {/* Fixed right action slot: collapsed row's one state control; other verbs live in detail. */}
        <div className="flex items-start justify-start lg:justify-end">
          {pauseButton}
        </div>
      </div>
    </li>
  );
}

/** The same chevron the rail's folded blocks use, at row-button size. */
function Chevron({ open }: { readonly open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3 w-3 shrink-0 transition-transform duration-[var(--kiki-motion-quick)] ${open ? 'rotate-90' : ''}`}
    >
      <path d="m4.5 2.5 3 3.5-3 3.5" />
    </svg>
  );
}

/**
 * The full prompt for one opened row.
 *
 * The list carries a truncated preview precisely so a page of 100 rows stays
 * small; pulling every prompt up front would undo that. Each opened row reads
 * its own detail, keyed by workspace, id and owning session, so a task id
 * shared across workspaces or sessions can never show another one's prompt.
 */
function CronDetailPrompt({ task }: { readonly task: CronTask }) {
  const { client } = useConnection();
  const { t } = useI18n();
  const detail = useQuery({
    queryKey: ['cron-task-detail', task.workspace_id, task.id, task.session_id],
    queryFn: async (): Promise<CronTaskDetail> =>
      (await client.getCronTask(task.id, task.session_id ?? undefined)).task,
    staleTime: 30_000,
    retry: false,
  });
  if (detail.isError) {
    return (
      <p role="status" data-cron-detail-error className="mt-0.5 text-[13px] leading-5 text-ink-faint">
        {t('cron.form.detailUnavailable')}
      </p>
    );
  }
  if (detail.data === undefined) {
    return <p data-cron-detail-loading className="mt-0.5 text-[13px] leading-5 text-ink-faint">{t('cron.panel.loading')}</p>;
  }
  return (
    <p
      data-cron-detail-prompt
      className="mt-0.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-5 text-ink-soft"
    >
      {detail.data.prompt}
    </p>
  );
}

export function CronPage({ sessions, workspaceOptions, onNavigate, onToggleSidebar }: CronPageProps) {
  const { client } = useConnection();
  const { t, tp, locale } = useI18n();
  const queryClient = useQueryClient();
  const nowMs = useNow();
  const [pendingDelete, setPendingDelete] = useState<CronTask | null>(null);
  const [editing, setEditing] = useState<{ readonly task: CronTask | undefined } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [timelineWindow, setTimelineWindow] = useState<CronTimelineWindow>('24h');
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const expandButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const { scope, setScope } = useWorkspaceScope(workspaceOptions);
  // `?session=<id>` (the rail's "manage" entry) narrows the list to one
  // conversation at the server, so it pages that conversation's own tasks.
  const [params, setParams] = useSearchParams();
  const rawSession = params.get('session');
  const sessionScope = rawSession !== null && rawSession.trim() !== '' ? rawSession.trim() : undefined;
  const tasksQueryKey = useMemo(
    () => [...CRON_TASKS_QUERY_KEY, 'filter', sessionScope ?? null] as const,
    [sessionScope],
  );
  const clearSessionScope = useCallback(() => {
    const updated = new URLSearchParams(params);
    updated.delete('session');
    setParams(updated, { replace: true });
  }, [params, setParams]);

  const tasksQuery = useInfiniteQuery({
    queryKey: tasksQueryKey,
    queryFn: ({ pageParam }) => client.listCronTasks({ session_id: sessionScope, page_size: 100, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.next_offset,
  });

  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const workspacesById = useMemo(
    () => new Map(workspaceOptions.map((workspace) => [workspace.id, workspace])),
    [workspaceOptions],
  );

  const reportError = useCallback(
    (error: unknown) => {
      pushToast({ tone: 'error', text: cronErrorText(error, t) });
    },
    [t],
  );

  const pauseResumeMutation = useMutation({
    mutationFn: ({ task, pause }: { task: CronTask; pause: boolean }) =>
      pause
        ? client.pauseCronTask(task.id, task.session_id ?? undefined)
        : client.resumeCronTask(task.id, task.session_id ?? undefined),
    onSuccess: (result, { pause }) => {
      queryClient.setQueryData<InfiniteData<ListCronTasksResponse, number>>(tasksQueryKey, (old) =>
        old === undefined ? undefined : {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.map((entry) =>
              cronTaskKey(entry) === cronTaskKey(result.task) ? result.task : entry),
          })),
        },
      );
      pushToast({ tone: 'success', text: pause ? t('cron.toast.paused') : t('cron.toast.resumed') });
    },
    onError: reportError,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: CRON_TASKS_QUERY_KEY });
    },
  });

  const runMutation = useMutation({
    mutationFn: (task: CronTask) => client.runCronTask(task.id, task.session_id ?? undefined),
    onSuccess: (result) => {
      if (result.triggered) {
        pushToast({ tone: 'success', text: t('cron.toast.triggered') });
      } else if (result.check.outcome === 'skipped') {
        pushToast({ tone: 'info', text: t('cron.toast.skipped') });
      } else {
        pushToast({ tone: 'error', text: t('cron.toast.failed') });
      }
    },
    onError: reportError,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: CRON_TASKS_QUERY_KEY });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (task: CronTask) => client.deleteCronTask(task.id, task.session_id ?? undefined),
    onSuccess: (_result, task) => {
      const removedKey = cronTaskKey(task);
      queryClient.setQueryData<InfiniteData<ListCronTasksResponse, number>>(tasksQueryKey, (old) =>
        old === undefined ? undefined : {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.filter((entry) => cronTaskKey(entry) !== removedKey),
          })),
        },
      );
      pushToast({ tone: 'success', text: t('cron.toast.deleted') });
      setPendingDelete(null);
    },
    onError: (error) => {
      reportError(error);
      setPendingDelete(null);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: CRON_TASKS_QUERY_KEY });
    },
  });

  const createMutation = useMutation({
    mutationFn: (input: {
      readonly session_id: string;
      readonly cron: string;
      readonly prompt: string;
      readonly recurring: boolean;
      readonly delivery_mode: CronDeliveryMode;
      /** Whether the form states the mode; a create always sends it. */
      readonly sendDeliveryMode: boolean;
    }): Promise<{ readonly task: CronTaskDetail }> => client.createCronTask({
      session_id: input.session_id,
      cron: input.cron,
      prompt: input.prompt,
      recurring: input.recurring,
      delivery_mode: input.delivery_mode,
    }),
    onSuccess: () => {
      pushToast({ tone: 'success', text: t('cron.toast.created') });
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: CRON_TASKS_QUERY_KEY });
    },
    // The editor stays open with its draft; the message says what to do.
    onError: () => { /* surfaced in the editor */ },
  });

  const updateMutation = useMutation({
    mutationFn: ({ task, patch }: { task: CronTask; patch: UpdateCronTaskRequest }) =>
      client.updateCronTask(task.id, patch, task.session_id ?? undefined),
    onSuccess: () => {
      pushToast({ tone: 'success', text: t('cron.toast.updated') });
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: CRON_TASKS_QUERY_KEY });
    },
    onError: () => { /* surfaced in the editor */ },
  });

  const busyTaskKey = pauseResumeMutation.isPending
    ? cronTaskKey(pauseResumeMutation.variables.task)
    : runMutation.isPending
      ? cronTaskKey(runMutation.variables)
      : deleteMutation.isPending
        ? cronTaskKey(deleteMutation.variables)
        : undefined;

  const openSession = useCallback(
    (sessionId: string) => {
      onNavigate(`/s/${sessionId}`);
    },
    [onNavigate],
  );

  const toggleDetail = useCallback((task: CronTask) => {
    const key = cronTaskKey(task);
    setFocusedKey(key);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const focusTask = useCallback((task: CronTask) => {
    const key = cronTaskKey(task);
    setFocusedKey(key);
    setExpanded((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
    const row = rowRefs.current.get(key);
    row?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    expandButtonRefs.current.get(key)?.focus({ preventScroll: true });
  }, []);

  const registerRow = useCallback((key: string, node: HTMLLIElement | null) => {
    if (node === null) rowRefs.current.delete(key);
    else rowRefs.current.set(key, node);
  }, []);

  const registerExpandButton = useCallback((key: string, node: HTMLButtonElement | null) => {
    if (node === null) expandButtonRefs.current.delete(key);
    else expandButtonRefs.current.set(key, node);
  }, []);

  const openEditor = useCallback((task: CronTask) => {
    setEditing({ task });
  }, []);

  const allTasks = useMemo(
    () => tasksQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [tasksQuery.data],
  );
  const tasks = useMemo(() => filterCronTasks(allTasks, scope), [allTasks, scope]);
  // The server already orders paused plans last; split on that boundary so the
  // "what will run next" list is never interleaved with dormant ones.
  const activeTasks = useMemo(() => tasks.filter((task) => !task.paused), [tasks]);
  const pausedTasks = useMemo(() => tasks.filter((task) => task.paused), [tasks]);

  const resolveOwner = useCallback((task: CronTask): string => {
    const ws = workspacesById.get(task.workspace_id)?.name ?? task.workspace_id;
    if (task.session_id === null) return ws;
    const session = sessionsById.get(task.session_id)?.title;
    return session ? `${ws} · ${session}` : `${ws} · ${task.session_id}`;
  }, [sessionsById, workspacesById]);

  const renderRow = (task: CronTask) => {
    const key = cronTaskKey(task);
    const isOpen = expanded.has(key);
    const sessionTitle = task.session_id === null ? undefined : sessionsById.get(task.session_id)?.title;
    // A rule the localizer cannot name reads as a custom schedule with the raw
    // expression under it; it never falls back to the engine's English string.
    const friendly = localizedCronSchedule(locale, task.cron, t);
    return (
      <CronTaskRow
        key={key}
        task={task}
        taskKey={key}
        sessionTitle={sessionTitle}
        workspaceName={workspacesById.get(task.workspace_id)?.name}
        schedule={friendly ?? t('cron.schedule.custom')}
        customSchedule={friendly === undefined}
        pending={busyTaskKey === key}
        expanded={isOpen}
        highlighted={hoveredKey === key || focusedKey === key}
        nowMs={nowMs}
        registerRow={registerRow}
        registerExpandButton={registerExpandButton}
        onHover={setHoveredKey}
        onToggleDetail={() => { toggleDetail(task); }}
        onEdit={() => { openEditor(task); }}
        onOpenSession={openSession}
        onPauseResume={(target, pause) => { pauseResumeMutation.mutate({ task: target, pause }); }}
        onRun={(target) => { runMutation.mutate(target); }}
        onDelete={(target) => { setPendingDelete(target); }}
      />
    );
  };
  const section = (key: 'active' | 'paused', rows: readonly CronTask[]) => (rows.length === 0 ? null : (
    <section data-cron-section={key} aria-labelledby={`cron-section-${key}`}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 id={`cron-section-${key}`} className="flex items-baseline gap-2 text-[12px] leading-4 font-bold text-section-ink">
          {t(key === 'active' ? 'cron.section.active' : 'cron.section.paused')}
          <span className="text-ink-faint tabular-nums">{rows.length}</span>
        </h2>
      </div>
      {key === 'active' ? (
        <div
          aria-hidden
          className="hidden pb-1.5 text-[12px] leading-4 font-normal text-ink-faint lg:grid lg:grid-cols-[9.5rem_minmax(0,1fr)_5.5rem] lg:gap-x-6"
        >
          <span>{t('cron.column.timing')}</span>
          <span>{t('cron.column.rule')}</span>
          <span />
        </div>
      ) : null}
      <ul className="divide-y divide-hairline border-t border-hairline">
        {rows.map(renderRow)}
      </ul>
    </section>
  ));

  const editorTask = editing?.task;
  const editingBusy = createMutation.isPending || updateMutation.isPending;
  const editorError = editing?.task === undefined
    ? (createMutation.isError ? t('cron.form.error.createFailed') : undefined)
    : (updateMutation.isError ? t('cron.form.error.saveFailed') : undefined);

  return (
    <div data-cron-page className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
      <PageHeader title={t('cron.panel.title')} onToggleSidebar={onToggleSidebar} width="split">
        <button
          type="button"
          data-cron-create
          onClick={() => { setEditing({ task: undefined }); }}
          className={`${PRIMARY_BUTTON} h-8 pointer-coarse:min-h-11`}
        >
          {t('cron.panel.create')}
        </button>
      </PageHeader>
      <div className="shrink-0 border-b border-hairline px-4 py-2 lg:px-6">
        <div className={`mx-auto flex w-full ${PAGE_WIDTH.split} flex-wrap items-center gap-x-4 gap-y-2`}>
          <WorkspaceScopeControl workspaces={workspaceOptions} value={scope} onChange={setScope} />
          {sessionScope !== undefined ? (
            <span data-cron-session-scope={sessionScope} className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-ink-faint">
              <span className="shrink-0">{t('cron.scope.session')}</span>
              <span className="min-w-0 max-w-56 truncate text-ink-soft" title={sessionScope}>
                {sessionsById.get(sessionScope)?.title ?? sessionScope}
              </span>
              <button
                type="button"
                data-cron-session-clear
                onClick={clearSessionScope}
                className="shrink-0 font-normal text-ink-soft underline-offset-2 transition-colors hover:text-ink hover:underline"
              >
                {t('cron.scope.sessionClear')}
              </button>
            </span>
          ) : null}
          {tasksQuery.data !== undefined ? (
            <p data-cron-summary className="ml-auto text-[12px] text-ink-faint tabular-nums">
              {tp('cron.panel.count', tasks.length)}
              {tasks.length > 0 ? ` · ${tp('cron.summary.active', activeTasks.length)} · ${tp('cron.summary.paused', pausedTasks.length)}` : ''}
            </p>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-8 lg:px-6" data-cron-panel-body>
        {tasksQuery.isPending ? (
          <div
            role="status"
            className="flex h-full items-center justify-center gap-2 text-[13px] leading-5 text-ink-faint"
          >
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('cron.panel.loading')}
          </div>
        ) : tasksQuery.isError ? (
          <p className={`mx-auto ${PAGE_WIDTH.split} py-10 text-[13px] leading-5 text-ink-soft`} data-cron-error>
            {t('cron.panel.error.title')}
            {' · '}
            {cronErrorText(tasksQuery.error, t, locale)}
            {' · '}
            <button
              type="button"
              onClick={() => { void tasksQuery.refetch(); }}
              className="font-normal text-ink underline underline-offset-2"
            >
              {t('common.retry')}
            </button>
          </p>
        ) : tasks.length === 0 && sessionScope !== undefined ? (
          <div data-cron-session-empty className={`mx-auto ${PAGE_WIDTH.split} py-10`}>
            <p className="text-[13px] text-ink-soft">{t('cron.scope.sessionEmpty')}</p>
            <button type="button" onClick={clearSessionScope} className="mt-1 text-[13px] font-normal text-ink underline underline-offset-2">
              {t('cron.scope.sessionClear')}
            </button>
          </div>
        ) : tasks.length === 0 && scope !== undefined && allTasks.length > 0 ? (
          <div data-cron-scope-empty className={`mx-auto ${PAGE_WIDTH.split} py-10`}>
            <p className="text-[13px] text-ink-soft">{t('cron.scope.empty')}</p>
            <button type="button" onClick={() => { setScope(undefined); }} className="mt-1 text-[13px] font-normal text-ink underline underline-offset-2">
              {t('cron.scope.showAll')}
            </button>
          </div>
        ) : tasks.length === 0 ? (
          <div
            data-cron-empty
            className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-panel text-ink-faint">
              <ClockGlyph className="h-5 w-5" />
            </span>
            <p className="text-[13px] font-normal text-ink">{t('cron.panel.empty.title')}</p>
            <p className="max-w-md text-[12px] leading-relaxed text-ink-soft">
              {t('cron.panel.empty.description')}
            </p>
            <button
              type="button"
              data-cron-empty-create
              onClick={() => { setEditing({ task: undefined }); }}
              className={`mt-1 h-8 ${SECONDARY_BUTTON}`}
            >
              {t('cron.panel.create')}
            </button>
          </div>
        ) : (
          <>
            <div className={`mx-auto ${PAGE_WIDTH.split} space-y-6`} data-cron-list>
              <CronNextCheckTimeline
                tasks={tasks}
                hasMorePages={Boolean(tasksQuery.hasNextPage)}
                window={timelineWindow}
                onChangeWindow={setTimelineWindow}
                hoveredKey={hoveredKey}
                onHoverKey={setHoveredKey}
                onFocusTask={focusTask}
                resolveOwner={resolveOwner}
              />
              {section('active', activeTasks)}
              {section('paused', pausedTasks)}
            </div>
            {tasksQuery.hasNextPage ? (
              <button type="button" disabled={tasksQuery.isFetchingNextPage}
                onClick={() => { void tasksQuery.fetchNextPage(); }}
                className="mx-auto mt-4 block h-8 rounded-md border border-hairline px-3 text-[13px] text-ink-soft disabled:opacity-50">
                {t('cron.panel.loadMore')}
              </button>
            ) : null}
          </>
        )}
      </div>

      {editing !== null ? (
        <CronTaskEditor
          key={editorTask === undefined ? 'create' : cronTaskKey(editorTask)}
          mode={editorTask === undefined ? 'create' : 'edit'}
          task={editorTask === undefined ? undefined : {
            id: editorTask.id,
            session_id: editorTask.session_id,
            workspace_id: editorTask.workspace_id,
            cron: editorTask.cron,
            // No prompt is passed: the list row holds a truncated preview,
            // and the editor opens with the field empty and disabled, then
            // seeds it from its own detail read. Handing the preview down
            // would let a save write the truncation over the real prompt.
            recurring: editorTask.recurring,
            delivery_mode: editorTask.delivery_mode,
          }}
          sessions={sessions}
          workspaceOptions={workspaceOptions}
          sourceSessionId={editorTask?.session_id ?? undefined}
          preferredSessionId={sessionScope}
          busy={editingBusy}
          onSubmit={(input) => {
            if (editorTask === undefined) {
              createMutation.mutate(input);
              return;
            }
            const patch: UpdateCronTaskRequest = {
              cron: input.cron,
              prompt: input.prompt,
              recurring: input.recurring,
              session_id: input.session_id,
              // An untouched control sends no field, so the host keeps the
              // mode the task already has. Sending a value the form merely
              // displayed would rewrite a `queue` task the user never touched.
              delivery_mode: input.sendDeliveryMode ? input.delivery_mode : undefined,
            };
            updateMutation.mutate({ task: editorTask, patch });
          }}
          onClose={() => {
            if (!editingBusy) setEditing(null);
          }}
          {...(editorError === undefined ? {} : { error: editorError })}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('cron.delete.title')}
        body={pendingDelete === null
          ? undefined
          : t('cron.delete.body', { schedule: cronScheduleLabel(locale, pendingDelete.cron, pendingDelete.human_schedule, t) })}
        confirmLabel={t('cron.action.delete')}
        tone="danger"
        busy={deleteMutation.isPending}
        overlayId="cron-delete-confirm"
        onCancel={() => { setPendingDelete(null); }}
        onConfirm={() => {
          if (pendingDelete !== null) deleteMutation.mutate(pendingDelete);
        }}
      />
    </div>
  );
}
