/**
 * The right rail: one page per agent, the same component for the main agent
 * and every subagent. Top to bottom:
 *
 *   head       who this page is about, the 标准 / 驾驶舱 switch, close  fixed
 *   现在        profile head, what the agent is doing, its actions  fixed
 *   待办        checklist, notes, plan                             fixed
 *   定时任务    what this conversation scheduled for itself        fixed
 *   等你处理    decision stack, from any depth                     fixed
 *   智能体      the team under this agent                          fixed
 *   后台任务                                                       fixed
 *   概览        standard figures | cockpit instruments             switches
 *   能力 · 动态 · 会话信息, folded                                  fixed
 *
 * Cockpit temporarily widens this rail into the preview's space. Standard
 * mode restores the original layout. `railVisibility` owns the differences
 * between a main-agent and a subagent rail.
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { Task } from '@kiki/protocol';

import {
  MAIN_AGENT_ID,
  type ApprovalBlock,
  type QuestionBlock,
} from '@kiki/session-core/session';
import { sortTasks } from '@kiki/session-core/sessions';
import {
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  writeLayoutPreferences,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useLayoutPreferences, usePaneResize } from '../../lib/layoutHooks';
import { pushToast } from '../../lib/toasts';
import { usageSessionDeepLink } from '../../lib/usageV2';
import { AgentPanelContainer } from '../AgentPanelContainer';
import { InspectorComms } from '../comms/InspectorComms';
import { AgentRoster, RAIL_MARK, RailCrumbs } from '../agent-panel/InspectorAgents';
import { InspectorNow, NowAction, pendingBlocks } from '../agent-panel/InspectorNow';
import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { INSPECTOR_HEAD, INSPECTOR_LINK, InspectorRow, InspectorSection } from '../agent-panel/InspectorSection';
import { ConfirmDialog } from '../ConfirmDialog';
import { useInspectorPeek } from '../inspectorFocus';
import { RelativeTime } from '../RelativeTime';
import { TaskDetailModal } from '../TaskDetailModal';
import { useMediaPreview } from '../mediaPreviewContext';
import { descendantIds, railVisibility, waitingAgentIds as pendingOrigins } from './model';
import { FOCUS_RING, ModeSwitch, useRailMode, type RailMode } from './shell';
import type { RailProps } from './types';
import { readExternalClientMark } from '../../lib/externalClients';
import { ActivityFeed, CapabilitiesBlock, NeedsYouList, ProfileHead, RailTodos } from './DefaultSections';
import { SessionCronSection } from './SessionCronSection';
import { PersonaSettingsUpdate } from '../persona/PersonaSettingsUpdate';
import { useEntityPage } from '../transcriptDetail';

/** Sections sit over hairlines; no cards. */
const SECTION = 'border-t border-hairline py-4 first:border-t-0 first:pt-3';
/** The context meter stays neutral until the overview calls it near; near is amber, never the "needs you" accent. */
const OVERVIEW_METER = '[&_[data-overview-context]_[role=meter]>div]:!bg-ink-soft/70 [&_[data-overview-context=warn]_[role=meter]>div]:!bg-amber-rule [&_[data-overview-context=danger]_[role=meter]>div]:!bg-amber-rule [&_[data-overview-context]_span.text-danger]:!text-amber-ink';
/** Cost, tokens and cache as mono figures on one measured row. */
const OVERVIEW_FIGURES = '[&_[data-overview-fact]>div:first-child]:font-mono [&_[data-overview-fact]>div:first-child]:text-[17px] [&_[data-overview-fact]>div:first-child]:font-normal [&_[data-overview-fact]>div:first-child]:tracking-tight [&_[data-overview-context]_.text-[13px]]:font-mono';
/** Waiting agents are already listed in Needs you: their roster rows keep only the trailing state word. */
const ROSTER_QUIET_WAITING = '[&_[data-roster-waiting]]:!bg-transparent';

const NO_PENDING: readonly (ApprovalBlock | QuestionBlock)[] = [];

/**
 * Counts rows (tagged `data-rail-item`) fully below the scroll viewport.
 * Observes actual size/content changes instead of forcing layout each render.
 */
function useHiddenBelow(ref: React.RefObject<HTMLDivElement | null>, content: unknown): number {
  const [hidden, setHidden] = useState(0);
  useLayoutEffect(() => {
    const container = ref.current;
    if (container === null) return;
    let frame: number | undefined;
    const update = () => {
      const bottom = container.getBoundingClientRect().bottom;
      let count = 0;
      for (const item of container.querySelectorAll('[data-rail-item]')) {
        if (item.getBoundingClientRect().top > bottom + 1) count += 1;
      }
      setHidden((previous) => previous === count ? previous : count);
    };
    const schedule = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        update();
      });
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(container);
    if (container.firstElementChild !== null) observer?.observe(container.firstElementChild);
    container.addEventListener('scroll', schedule, { passive: true });
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer?.disconnect();
      container.removeEventListener('scroll', schedule);
    };
  }, [ref, content]);
  return hidden;
}

/** Sticky "N more below" hint pinned to the bottom of a rail scroll container. */
function OverflowHint({ count }: { count: number }) {
  const { t } = useI18n();
  if (count === 0) return null;
  return (
    <p data-rail-overflow className="pt-1.5 pb-0.5 text-[12px] text-ink-faint">
      {t('rail.moreBelow', { count })}
    </p>
  );
}

/**
 * Collapsible rail chapter — the shared InspectorSection shape (button +
 * aria-expanded + rotating chevron). Starts expanded unless `defaultOpen` is
 * false. `actions` renders beside the header row, outside the toggle button.
 */
function RailSection({
  title,
  collapsible,
  count,
  actions,
  summary,
  defaultOpen,
  children,
  ...data
}: {
  title: string;
  collapsible?: boolean;
  count?: number;
  actions?: React.ReactNode;
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  return (
    <InspectorSection title={title} collapsible={collapsible} count={count} actions={actions} summary={summary} defaultOpen={defaultOpen} {...data}>
      {children}
    </InspectorSection>
  );
}

function taskStatusTone(status: Task['status']): string {
  switch (status) {
    case 'running':
    case 'completed':
      return 'text-ink-soft';
    case 'failed':
    case 'cancelled':
      return 'text-ink-faint';
  }
}

/**
 * The folder name the folded session row shows. A working directory is often
 * named after the thing that created it — a uuid, a hash, a generated slug —
 * and a 32-character id sitting in the rail's resident line says nothing a
 * reader can act on. Those are left out of the folded line (the full path is
 * one click away in the section's own detail) and only a name a person would
 * recognise gets the space.
 */
const OPAQUE_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{24,}$|^[0-9a-z]{20,}$/i;

function residentDirName(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  const leaf = cwd.split(/[\\/]/).filter((part) => part !== '').pop();
  if (leaf === undefined || leaf === '') return undefined;
  return OPAQUE_DIR.test(leaf) ? undefined : leaf;
}

/** The newest non-empty line of a task's output (or its command). */
function lastLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  return lines[lines.length - 1];
}

const TasksSection = memo(function TasksSection({
  tasks,
  sessionId,
  ownerAgentId,
  onCancel,
  onOpenTask,
}: {
  tasks: readonly Task[];
  sessionId?: string;
  ownerAgentId?: string;
  onCancel: (taskId: string, ownerAgentId?: string) => void;
  /** Opens the terminal-style detail modal for one task. */
  onOpenTask: (task: Task) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Running work first, then newest-created — same order as the tasks page.
  const sorted = useMemo(() => sortTasks(tasks), [tasks]);
  const hiddenBelow = useHiddenBelow(scrollRef, sorted);
  if (sorted.length === 0) {
    return <p className="text-[13px] text-ink-faint">{t('rail.noTasks')}</p>;
  }
  return (
    <div ref={scrollRef} data-tasks-scroll className="max-h-80 overflow-y-auto pr-1">
      <ul className="space-y-0.5">
        {sorted.map((task) => (
          <li key={task.id} data-rail-item className="rail-task-row -mx-2 flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-ink/[0.04]">
            {/* Name + the latest output line. The whole row opens the detail. */}
            <button
              type="button"
              data-task-open={task.id}
              title={task.command ?? t('rail.viewDetails')}
              onClick={() => { onOpenTask(task); }}
              className="flex min-w-0 flex-1 cursor-pointer items-start rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
            >
              <span className={RAIL_MARK}>
                <LifeMark markId={`task:${task.id}`} life={task.status === 'running' ? 'working' : task.status === 'failed' ? 'failed' : 'idle'} tone={task.status === 'running' ? 'bg-success' : task.status === 'failed' ? 'bg-ink-faint' : undefined} still />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-2 leading-5">
                  <span className="min-w-0 truncate text-[13px] text-ink">{task.description}</span>
                  {task.status !== 'running' ? (
                    <span className={`ml-auto shrink-0 text-[12px] ${taskStatusTone(task.status)}`}>{t(`rail.taskStatus.${task.status}`)}</span>
                  ) : null}
                </span>
                {lastLine(task.output_preview ?? task.command) !== undefined ? (
                  <span className="block truncate font-mono text-[11.5px] leading-[18px] text-ink-faint">
                    {lastLine(task.output_preview ?? task.command)}
                  </span>
                ) : null}
              </span>
            </button>
            {task.status === 'running' ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onCancel(task.id, ownerAgentId);
                }}
                title={t('rail.stopTitle')}
                aria-label={`${t('rail.stop')} · ${task.description}`}
                className="rail-task-stop flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-ink-soft transition-[color,background-color,opacity] hover:bg-danger/10 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
              >
                <Icon name="stop" size={12} />
                {t('rail.stop')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {sessionId !== undefined || hiddenBelow > 0 ? (
        <div className="sticky bottom-0 bg-panel pt-1 pb-0.5">
          <OverflowHint count={hiddenBelow} />
          {sessionId !== undefined ? (
            <button
              type="button"
              onClick={() => void navigate(`/s/${sessionId}/tasks`)}
              className={`${INSPECTOR_LINK} ml-2`}
            >
              {t('tasks.viewAll')}
              <Icon name="arrowRight" size={12} className="text-ink-faint" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/**
 * The windowed reset carried only the newest finished tasks (running ones are
 * always included, so the list above is complete). Say how many earlier ones
 * the session holds; the tasks page behind "View all" lists every one.
 */
function TasksNotLoadedHint({
  coverage,
}: {
  coverage: { readonly returned: number; readonly total: number; readonly hasMore: boolean } | undefined;
}) {
  const { t, tp } = useI18n();
  // The window carried only the newest finished tasks; the rest are one page
  // away, read on request into the same canonical store (never all at once).
  const page = useEntityPage('task');
  if (coverage === undefined || !coverage.hasMore) return null;
  const missing = Math.max(0, coverage.total - coverage.returned);
  if (missing === 0) return null;
  const status = page.status?.status;
  return (
    <div
      data-rail-tasks-not-loaded={missing}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1.5 text-[12px] leading-5 text-ink-faint"
    >
      <span className="min-w-0 truncate">{tp('rail.tasksNotLoaded', missing)}</span>
      {status === 'error' ? (
        <span role="alert" className="text-danger">{t('transcript.content.entitiesFailed')}</span>
      ) : null}
      <button
        type="button"
        data-rail-tasks-not-loaded-action
        onClick={page.request}
        disabled={status === 'loading'}
        aria-busy={status === 'loading'}
        className="inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-md px-2 font-medium text-ink-soft underline-offset-2 transition-colors hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:cursor-default disabled:opacity-80 motion-reduce:transition-none"
      >
        {status === 'loading' ? (
          <>
            <span aria-hidden className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-soft" />
            {t('transcript.content.loading')}
          </>
        ) : status === 'error' ? t('transcript.detail.retry') : t('transcript.content.more')}
      </button>
    </div>
  );
}

/** Mounts its children only once the slot scrolls into the rail's view. */
function useLazyPanelSlot() {
  const slotRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const slot = slotRef.current;
    if (slot === null) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      setMounted(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      const next = entry?.isIntersecting === true;
      setVisible(next);
      if (next) setMounted(true);
    }, { root: slot.closest('[data-agent-panel-scroll]') ?? slot.parentElement });
    observer.observe(slot);
    return () => observer.disconnect();
  }, []);
  return { slotRef, visible, mounted };
}

export function Rail({
  state,
  forest,
  selectedAgentId,
  subagent,
  taskOwnerAgentId,
  onCancelTask,
  onStopAgentTask,
  onOpenSubagent,
  onInspectMain,
  onReviewPending,
  sessionPending,
  onResolveApproval,
  onOpenFile,
  memory,
  onClose,
  className,
}: RailProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [mode, chooseMode] = useRailMode();
  const preview = useMediaPreview();
  const session = state.session;
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [terminateSnapshot, setTerminateSnapshot] = useState<readonly Task[] | null>(null);
  const [terminatingAll, setTerminatingAll] = useState(false);
  const panelSlot = useLazyPanelSlot();
  const peekAgentId = useInspectorPeek();
  const focusedAgentId = selectedAgentId ?? MAIN_AGENT_ID;
  // A session driven from outside Kiki names that client instead of a model.
  const externalDriver = useMemo(
    () => readExternalClientMark(session?.metadata)?.clientName,
    [session?.metadata],
  );
  const focusedNode = forest.byId[focusedAgentId];
  // The routed agent page (no onInspectMain) is already this agent's timeline.
  const show = railVisibility(focusedAgentId, onInspectMain === undefined ? focusedAgentId : MAIN_AGENT_ID);
  const backgroundTasks = useMemo(
    () => state.tasks.filter((task) => task.kind !== 'subagent' && task.status === 'running'),
    [state.tasks],
  );
  const runningSubagentTasks = useMemo(
    () =>
      state.tasks.filter(
        (task) => task.kind === 'subagent' && task.status === 'running' && task.agent_id !== undefined,
      ),
    [state.tasks],
  );
  const runningSubagentTasksRef = useRef(runningSubagentTasks);
  runningSubagentTasksRef.current = runningSubagentTasks;
  const ownPending = useMemo(() => pendingBlocks(state.blocks), [state.blocks]);
  const pending = sessionPending ?? ownPending;
  // Agents waiting on the user: a pending item's origin, plus the focused
  // subagent when its own count says so. Their rows surface first.
  const waitingAgentIds = useMemo(() => {
    const ids = pendingOrigins(pending);
    if (subagent !== undefined && subagent.pendingInteractionCount > 0) ids.add(subagent.agentId);
    return ids;
  }, [pending, subagent]);
  // Empty sections collapse entirely (header included) on every page.
  // Main lists the whole team; a subagent lists the agents under it.
  const rosterCount = useMemo(() => descendantIds(forest, focusedAgentId).length, [forest, focusedAgentId]);
  const showRoster = rosterCount > 0;
  const showTasks = backgroundTasks.length > 0;
  const showTerminateAll = show.stopAll && onStopAgentTask !== undefined && runningSubagentTasks.length > 0;
  const busy = show.isMain ? state.busy : (focusedNode?.busy === true || state.busy);
  const taskOwner = taskOwnerAgentId ?? show.taskOwner;
  // Choosing cockpit lifts its overview into view when it sits outside the
  // rail's scroll viewport; the standard mode never scrolls.
  const chooseOverviewMode = (next: RailMode) => {
    chooseMode(next);
    if (next !== 'cockpit') return;
    const slot = panelSlot.slotRef.current;
    if (slot === null || typeof slot.scrollIntoView !== 'function') return;
    const view = slot.closest('[data-agent-panel-scroll]')?.getBoundingClientRect();
    const rect = slot.getBoundingClientRect();
    const viewTop = view?.top ?? 0;
    const viewBottom = view?.bottom ?? window.innerHeight;
    if (rect.top < viewTop || rect.bottom > viewBottom) {
      slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };
  // Turning a tab. Inside the session view the document-level focus tracker
  // pins on click (inspectorFocus.ts); main is also handed back explicitly,
  // and the routed agent page (no onInspectMain) navigates instead.
  const selectAgent = (agentId: string) => {
    if (agentId === focusedAgentId) return;
    if (agentId === MAIN_AGENT_ID && onInspectMain !== undefined) onInspectMain();
    else if (onInspectMain === undefined) onOpenSubagent(agentId);
  };
  const subBlock = subagent?.block;
  // The timeline card carries the task-entity terminal status; the tree node
  // can lag at 'unknown' on cold open — prefer a known card status.
  const subStatus = subagent === undefined
    ? undefined
    : subBlock !== undefined && subBlock.status !== 'unknown'
      ? subBlock.status
      : (focusedNode?.status ?? subBlock?.status ?? 'unknown');
  const startedIso = subagent === undefined ? undefined : (subBlock?.startedAt ?? focusedNode?.startedAt);
  const runStartedAt = subagent === undefined
    ? state.turnStartedAt
    : startedIso === undefined ? undefined : Date.parse(startedIso);
  const terminateAllSubagents = async () => {
    const snapshot = terminateSnapshot;
    if (onStopAgentTask === undefined || snapshot === null) return;
    setTerminatingAll(true);
    try {
      const results = await Promise.allSettled(
        snapshot.map((task) =>
          onStopAgentTask(forest.byId[task.agent_id ?? '']?.parentAgentId ?? MAIN_AGENT_ID, task.id),
        ),
      );
      const failed = results.filter((result) => result.status === 'rejected');
      const snapshotIds = new Set(snapshot.map((task) => task.id));
      const failedIds = new Set(
        results.flatMap((result, index) =>
          result.status === 'rejected' && snapshot[index] !== undefined
            ? [snapshot[index].id]
            : [],
        ),
      );
      const remaining = runningSubagentTasksRef.current.filter(
        (task) => !snapshotIds.has(task.id) || failedIds.has(task.id),
      ).length;
      if (failed.length > 0) {
        const first = failed[0] as PromiseRejectedResult;
        pushToast({
          tone: 'error',
          text: t('rail.terminateAllFailed', {
            count: failed.length,
            detail: first.reason instanceof Error ? first.reason.message : String(first.reason),
            remaining,
          }),
        });
      } else if (remaining > 0) {
        pushToast({
          tone: 'info',
          text: t('rail.terminateAllRemaining', { count: snapshot.length, remaining }),
        });
      } else {
        pushToast({
          tone: 'success',
          text: t('rail.terminateAllDone', { count: snapshot.length }),
        });
      }
    } finally {
      setTerminatingAll(false);
      setTerminateSnapshot(null);
    }
  };

  const layoutPrefs = useLayoutPreferences();
  const [railWidthValue, setRailWidthValue] = useState(layoutPrefs.railWidth);
  useEffect(() => {
    setRailWidthValue(layoutPrefs.railWidth);
  }, [layoutPrefs.railWidth]);
  const [cockpitWidth, setCockpitWidth] = useState<number | undefined>();
  useEffect(() => { if (mode === 'default') setCockpitWidth(undefined); }, [mode]);
  const effectiveWidth = mode === 'cockpit'
    ? cockpitWidth ?? Math.min(760, Math.max(480, railWidthValue + (preview?.previewPanelWidth ?? 0)))
    : railWidthValue;
  const { startResize, reset } = usePaneResize({
    value: effectiveWidth,
    min: mode === 'cockpit' ? 360 : RAIL_MIN_WIDTH,
    max: mode === 'cockpit' ? 760 : RAIL_MAX_WIDTH,
    direction: -1,
    onChange: (value, final) => {
      if (mode === 'cockpit') { setCockpitWidth(value); return; }
      setRailWidthValue(value);
      if (final) writeLayoutPreferences({ railWidth: value });
    },
    onReset: () => {
      if (mode === 'cockpit') { setCockpitWidth(undefined); return; }
      setRailWidthValue(RAIL_DEFAULT_WIDTH);
      writeLayoutPreferences({ railWidth: RAIL_DEFAULT_WIDTH });
    },
  });


  // Turning the page remounts every control on it, so a press that turned it
  // (opening an agent from a row or a Needs-you link) would leave focus on
  // <body>. Keep keyboard users in place: the new page's heading takes it.
  const railRef = useRef<HTMLElement>(null);
  const focusInRail = useRef(false);
  useLayoutEffect(() => {
    if (!focusInRail.current) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    railRef.current?.querySelector<HTMLElement>('[data-rail-owner-heading]')?.focus({ preventScroll: true });
  }, [focusedAgentId]);

  const agentPanelKey = `${state.sessionId}:${focusedAgentId}`;
  const renderOverview = (body: React.ReactNode, scopeSwitch: React.ReactNode) => (
    <>
      <header data-rail-switchable-head className="flex h-9 min-w-0 flex-nowrap items-baseline gap-1.5 py-1">
        <h3 id="rail-overview-title" className={`${INSPECTOR_HEAD} whitespace-nowrap leading-7`}>{t('inspector.overview')}</h3>
        <button
          type="button"
          data-rail-open-usage
          onClick={() => { void navigate(usageSessionDeepLink(state.sessionId)); }}
          title={t('inspector.usage')}
          aria-label={t('inspector.usage')}
          className={`flex h-6 w-6 shrink-0 items-center justify-center self-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink pointer-coarse:h-9 pointer-coarse:w-9 ${FOCUS_RING}`}
        >
          <Icon name="arrowUpRight" size={12} />
        </button>
        {scopeSwitch}
      </header>
      <div id="rail-overview-body" data-rail-switchable-body>{body}</div>
    </>
  );
  return (
    <div className="app-rail-shell">
      <div
        data-rail-resizer
        className="app-rail__resizer hidden lg:block"
        aria-hidden
        title={t('rail.resizeAria')}
        onPointerDown={startResize}
        onDoubleClick={reset}
      />
      <aside
        className={
          className ?? 'app-rail'
        }
        style={{ '--kiki-rail-width': `${effectiveWidth}px`, overflow: 'hidden', display: 'flex', flexDirection: 'column' } as React.CSSProperties}
        data-session-rail
        data-rail-mode-active={mode}
        data-inspector-agent={focusedAgentId}
        ref={railRef}
        onFocus={() => { focusInRail.current = true; }}
        // A removed control blurs with no related target; only a real move
        // out of the rail clears the flag.
        onBlur={(event) => {
          if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget as Node)) focusInRail.current = false;
        }}
      >
      <div data-agent-panel-scroll className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
      {/* Pinned head: crumbs, who this agent is, and what it is doing. Shares
          the rail's ground, with a hairline over the scrolling page. */}
      <div data-rail-pinned className="sticky top-0 z-20 -mx-4 border-b border-hairline bg-panel px-4 pb-3">
      <RailCrumbs
        forest={forest}
        focusedAgentId={focusedAgentId}
        onSelect={selectAgent}
        close={(
          <span className="flex shrink-0 items-center gap-1.5">
            <ModeSwitch mode={mode} onChoose={chooseOverviewMode} />
            {onClose === undefined ? null : (
              <button type="button" onClick={mode === 'cockpit' ? () => { chooseMode('default'); } : onClose} data-rail-close
                title={t(mode === 'cockpit' ? 'rail.cockpit.close' : 'sv.hidePanel')} aria-label={t(mode === 'cockpit' ? 'rail.cockpit.close' : 'sv.hidePanel')}
                className="-mr-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-7 lg:w-7">
                <Icon name="close" size={16} />
              </button>
            )}
          </span>
        )}
      />
      <div key={focusedAgentId} data-rail-now-block className="rail-page space-y-3 pt-1">
      <ProfileHead
        sessionId={state.sessionId}
        agentId={focusedAgentId}
        label={focusedNode?.label ?? focusedAgentId}
        fallbackModel={state.model}
        workspaceId={session?.workspace_id}
        cwd={session?.metadata.cwd}
        externalDriver={focusedAgentId === MAIN_AGENT_ID ? externalDriver : undefined}
      />
      <InspectorNow
        blocks={state.blocks}
        busy={busy}
        // With the session-wide block above, Now reports the agent's own
        // run; its waiting state comes from the focused agent's own count.
        pending={sessionPending === undefined ? pending : NO_PENDING}
        listPending={sessionPending === undefined}
        onReview={onReviewPending}
        startedAt={runStartedAt}
        subagent={!show.subagentStory || subagent === undefined || subStatus === undefined ? undefined : {
          status: subStatus,
          brief: subBlock?.description ?? subBlock?.instruction ?? focusedNode?.description,
          result: subBlock?.summary ?? focusedNode?.summary,
          error: subBlock?.error ?? focusedNode?.error,
          pendingCount: subagent.pendingInteractionCount,
        }}
        actions={subagent === undefined || (!show.openAgent && !show.locateSpawn) ? undefined : (
          <div data-subagent-context className="-mt-1 ml-3 flex flex-wrap items-center gap-x-4 gap-y-1">
            {show.openAgent ? (
              <NowAction data-rail-open-agent="" icon="external" label={t('inspector.openAgent')} onClick={() => { onOpenSubagent(subagent.agentId); }} />
            ) : null}
            {show.locateSpawn && subagent.onJumpToSpawn !== undefined ? (
              <NowAction data-rail-locate="" icon="arrowUp" label={t('inspector.locate')} onClick={subagent.onJumpToSpawn} />
            ) : null}
          </div>
        )}
      />
      </div>
      </div>

      {/* One page per agent: switching agents raises the new page into place. */}
      <div key={focusedAgentId} className="rail-page">
      {/* 2 · The agent's own checklist (finished items folded), then its notes and plan. */}
      {/* Either child may render nothing (no todos, an empty work part);
          the section and its rule go with them. */}
      <div id="rail-todos" className={`space-y-3 empty:hidden [&:not(:has(>:not(:empty)))]:hidden ${SECTION} [&_[data-agent-todo-section]]:hidden`}>
        <RailTodos sessionId={state.sessionId} agentId={focusedAgentId} />
        <AgentPanelContainer key={`work:${agentPanelKey}`} state={state} forest={forest} agentId={focusedAgentId} part="work" />
      </div>

      {/* 3 · What this conversation has scheduled for itself (session-wide
          facts, the same page for main and every subagent). */}
      <div className={`${SECTION} empty:hidden`}>
        <SessionCronSection sessionId={state.sessionId} />
      </div>

      {/* 3b · The persona copy this conversation runs, folded to one word of
          state until someone opens it (session-wide as well). */}
      <div className={`${SECTION} empty:hidden`}>
        <PersonaSettingsUpdate sessionId={state.sessionId} />
      </div>

      {/* 4 · What waits on you, from any depth, oldest first. */}
      {sessionPending !== undefined && sessionPending.length > 0 ? (
        <div className={SECTION}>
          <NeedsYouList
            items={sessionPending}
            forest={forest}
            onResolveApproval={onResolveApproval}
            onReview={onReviewPending}
            onInspect={onOpenSubagent}
          />
        </div>
      ) : null}

      {/* 5 · The team. */}
      {showRoster ? (
        <div className={`${SECTION} ${ROSTER_QUIET_WAITING}`}>
        <RailSection
          title={t('inspector.agents')}
          collapsible={false}
          count={rosterCount}
          data-inspector-agents=""
          actions={
            showTerminateAll ? (
              <button
                type="button"
                data-terminate-all-subagents
                onClick={() => { setTerminateSnapshot(runningSubagentTasks); }}
                className="-mr-2 h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
              >
                {t('rail.terminateAll')}
              </button>
            ) : undefined
          }
        >
          <AgentRoster
            forest={forest}
            rootId={focusedAgentId}
            peekAgentId={peekAgentId}
            waitingAgentIds={waitingAgentIds}
            onSelect={onOpenSubagent}
          />
        </RailSection>
        </div>
      ) : null}

      {showTasks ? (
        <div className={SECTION}>
        <RailSection title={t('rail.tasks')} collapsible={false} count={backgroundTasks.length}>
          <TasksSection
            tasks={backgroundTasks}
            sessionId={session?.id}
            ownerAgentId={taskOwner}
            onCancel={onCancelTask}
            onOpenTask={setDetailTask}
          />
          <TasksNotLoadedHint coverage={state.globalCoverage?.tasks} />
        </RailSection>
        </div>
      ) : null}

      {/* 6 · 概览, the one block that follows the 标准 / 驾驶舱 preference.
          The mode switch lives in the rail head (always visible); this head
          keeps the title, usage link and scope switch. The body mounts once the slot
          scrolls into view (it starts the capability and compaction-point
          reads). */}
      <section
        ref={panelSlot.slotRef}
        data-rail-agent-panel-slot
        data-rail-switchable={mode}
        aria-labelledby="rail-overview-title"
        className={`min-h-px ${SECTION} ${OVERVIEW_METER} ${OVERVIEW_FIGURES}`}
      >
        <div data-rail-overview-well className="pt-1 pb-3">
          {panelSlot.mounted ? (
            <AgentPanelContainer
              key={`overview:${agentPanelKey}`}
              state={state}
              forest={forest}
              agentId={focusedAgentId}
              visible={panelSlot.visible}
              part="overview"
              overviewMode={mode}
              renderOverview={renderOverview}
              waitingIds={waitingAgentIds}
              onOpenAgent={onOpenSubagent}
            />
          ) : renderOverview(null, null)}
        </div>
      </section>

      {/* 7 · Reference, folded: what it can use, what happened. */}
      <div data-inspector-tail className={`space-y-1 ${SECTION}`}>
        <CapabilitiesBlock sessionId={state.sessionId} agentId={focusedAgentId} workspaceId={session?.workspace_id} cwd={session?.metadata.cwd} />
        <ActivityFeed blocks={state.blocks} forest={forest} onOpenFile={onOpenFile} onOpenAgent={onOpenSubagent} />
        {show.comms && session !== undefined ? <InspectorComms sessionId={session.id} /> : null}
        {memory !== undefined ? (
          <RailSection title={memory.title} count={memory.count} data-inspector-memory="">
            {memory.content}
          </RailSection>
        ) : null}
        {session !== undefined ? (
          <RailSection
            title={t('inspector.sessionInfo')}
            summary={residentDirName(session.metadata.cwd) ?? t('rail.sessionNoName')}
            defaultOpen={false}
            data-inspector-session=""
          >
            <dl>
              <InspectorRow label={t('rail.directory')} title={session.metadata.cwd} mono>{session.metadata.cwd}</InspectorRow>
              {session.message_count > 0 ? <InspectorRow label={t('rail.messages')}>{String(session.message_count)}</InspectorRow> : null}
              <InspectorRow label={t('rail.updatedRow')}><RelativeTime at={session.updated_at} /></InspectorRow>
            </dl>
          </RailSection>
        ) : null}
      </div>
      </div>
      </div>

      {detailTask !== null && session !== undefined ? (
        <TaskDetailModal
          sessionId={session.id}
          ownerAgentId={taskOwner}
          task={detailTask}
          onClose={() => { setDetailTask(null); }}
          onCancelTask={onCancelTask}
        />
      ) : null}

      <ConfirmDialog
        open={terminateSnapshot !== null}
        title={t('rail.terminateAllTitle')}
        body={t('rail.terminateAllBody', { count: terminateSnapshot?.length ?? 0 })}
        confirmLabel={t('rail.terminateAllConfirm')}
        tone="danger"
        busy={terminatingAll}
        overlayId="confirm-terminate-subagents"
        onConfirm={() => { void terminateAllSubagents(); }}
        onCancel={() => { setTerminateSnapshot(null); }}
      />
      </aside>
    </div>
  );
}
