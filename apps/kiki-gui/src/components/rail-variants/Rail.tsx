/**
 * The right rail: one page per agent, the same component for the main agent
 * and every subagent. Standard mode is two layers:
 *
 *   head       who this page is about, the 标准 / 驾驶舱 switch, close  fixed
 *   现在        profile head, what it is doing, 等你处理, usage figures,
 *               background-task one-liner                              pinned
 *   按需区      four folded chapters named after the reader's question:
 *               智能体 · 它能用什么 · 它记录和安排 · 这个会话         scrolling
 *
 * The pinned block answers now / what waits / what it cost and never folds.
 * Everything else — checklist, notes, roster, cron, channels, session info —
 * lives inside one of the four chapters, default-closed.
 *
 * The cockpit reorders the same sections: its subject is the whole session,
 * so the execution graph comes first, then what waits on the reader, then the
 * shared agent roster, then the same four chapters. Every section is the same
 * component it is in standard mode, so the roster keeps its filtering and its
 * actions and loses nothing when the mode changes.
 *
 * Cockpit temporarily widens this rail into the preview's space. Standard
 * mode restores the original layout. `railVisibility` owns the differences
 * between a main-agent and a subagent rail.
 */

import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { AgentRoster, RAIL_MARK, RailCrumbs, RosterSummary } from '../agent-panel/InspectorAgents';
import { buildRoster } from '../agent-panel/agentRoster';
import { InspectorNow, NowAction, pendingBlocks } from '../agent-panel/InspectorNow';
import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { INSPECTOR_HEAD, INSPECTOR_LINK, InspectorRow, InspectorSection } from '../agent-panel/InspectorSection';
import { DisclosureChevron } from '../icons';
import { ConfirmDialog } from '../ConfirmDialog';
import { useInspectorPeek } from '../inspectorFocus';
import { RelativeTime } from '../RelativeTime';
import { TaskDetailModal } from '../TaskDetailModal';
import { useMediaPreview } from '../mediaPreviewContext';
import { descendantIds, railVisibility, waitingAgentIds as pendingOrigins } from './model';
import { FOCUS_RING, ModeSwitch, useMediaQuery, useRailMode, type RailMode } from './shell';
import type { RailProps } from './types';
import { readExternalClientMark } from '../../lib/externalClients';
import { ActivityFeed, CapabilitiesBlock, NeedsYouList, ProfileHead } from './DefaultSections';
import { RailTodos } from './DefaultRail';
import { SessionCronSection } from './SessionCronSection';
import { SessionChannelsRail } from '../im/SessionChannelsRail';
import { PersonaSettingsUpdate } from '../persona/PersonaSettingsUpdate';

/** Chapters separate by space alone (PRINCIPLES 12); no hairlines, no cards. */
const SECTION = 'pt-5 first:pt-3';
/** The context meter stays neutral until the overview calls it near; near is amber, never the "needs you" accent. */
const OVERVIEW_METER = '[&_[data-overview-context]_[role=meter]>div]:!bg-ink-soft/70 [&_[data-overview-context=warn]_[role=meter]>div]:!bg-amber-rule [&_[data-overview-context=danger]_[role=meter]>div]:!bg-amber-rule [&_[data-overview-context]_span.text-danger]:!text-amber-ink';
/** Cost, tokens and cache as mono figures on one measured row. */
const OVERVIEW_FIGURES = '[&_[data-overview-fact]>div:first-child]:font-mono [&_[data-overview-fact]>div:first-child]:text-[17px] [&_[data-overview-fact]>div:first-child]:font-normal [&_[data-overview-fact]>div:first-child]:tracking-tight [&_[data-overview-context-figures]]:font-mono';
/** Waiting agents are already listed in Needs you: their roster rows keep only the trailing state word. */
const ROSTER_QUIET_WAITING = '[&_[data-roster-waiting]]:!bg-transparent';

const NO_PENDING: readonly (ApprovalBlock | QuestionBlock)[] = [];

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
  // Running work first, then newest-created — same order as the tasks page.
  const sorted = useMemo(() => sortTasks(tasks), [tasks]);
  if (sorted.length === 0) {
    return <p className="text-[13px] text-ink-faint">{t('rail.noTasks')}</p>;
  }
  return (
    <div data-tasks-scroll className="max-h-80 overflow-y-auto pr-1">
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
      {sessionId !== undefined ? (
        <div className="pt-1">
          <button
            type="button"
            onClick={() => void navigate(`/s/${sessionId}/tasks`)}
            className={`${INSPECTOR_LINK} ml-2`}
          >
            {t('tasks.viewAll')}
            <Icon name="arrowRight" size={12} className="text-ink-faint" />
          </button>
        </div>
      ) : null}
    </div>
  );
});

/**
 * Standard mode's roster chapter: closed it is the bucket summary alone —
 * 智能体 65, then the waiting / running / ended chips — so a 65-agent fleet
 * costs one line. Pressing the chips unfolds the full roster filtered to that
 * bucket; pressing the heading does the same unfiltered. The cockpit keeps
 * the ordinary fixed chapter instead.
 */
function RosterSummaryChapter({
  forest,
  rootId,
  waitingAgentIds,
  rosterCount,
  actions,
  children,
}: {
  forest: Parameters<typeof buildRoster>[0]['forest'];
  rootId: string;
  waitingAgentIds: ReadonlySet<string>;
  rosterCount: number;
  actions?: React.ReactNode;
  children: (openFilter: Parameters<typeof buildRoster>[0]['filter'] | 'all') => React.ReactNode;
}) {
  const { t } = useI18n();
  const [expanded] = useState<ReadonlySet<string>>(() => new Set());
  // Server rendering and the first client paint keep the full roster: a
  // static read (SSR markup, a printed page) is never summary-only. The
  // summary line takes over after hydration, when the fold is a real toggle.
  const [openFilter, setOpenFilter] = useState<Parameters<typeof buildRoster>[0]['filter'] | 'all' | null>('all');
  useEffect(() => { setOpenFilter(null); }, [rootId]);
  const model = useMemo(
    () => buildRoster({ forest, rootId, waiting: waitingAgentIds, expanded, filter: 'all', query: '', doneOpen: false }),
    [forest, rootId, waitingAgentIds, expanded],
  );
  const open = openFilter !== null;
  return (
    <section data-inspector-agents="">
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => { setOpenFilter(open ? null : 'all'); }}
          className="group -mx-1.5 flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
        >
          <span className={INSPECTOR_HEAD}>{t('rail.group.agents')}</span>
          <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">{rosterCount}</span>
        </button>
        {!open ? (
          <RosterSummary
            counts={model.counts}
            filter="all"
            onFilter={(bucket) => { setOpenFilter(bucket); }}
          />
        ) : null}
        {actions !== undefined ? <span className="ml-auto">{actions}</span> : <span className="ml-auto" />}
        <button
          type="button"
          aria-expanded={open}
          aria-label={t(open ? 'inspector.collapseAgent' : 'inspector.expandAgent', { name: t('rail.group.agents') })}
          onClick={() => { setOpenFilter(open ? null : 'all'); }}
          className="-mr-1.5 flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
        >
          <DisclosureChevron open={open} />
        </button>
      </div>
      {open ? (
        <div className="pt-1">
          {children(openFilter)}
        </div>
      ) : null}
    </section>
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
  const nodeStatus = focusedNode?.status;
  const nodeStatusKnown = focusedNode !== undefined && nodeStatus !== 'unknown';
  const sessionExecuting = state.session?.executing ?? state.session?.main_turn_active;
  const sessionBusy = state.session === undefined ? state.busy : sessionExecuting === true;
  const busy = show.isMain
    ? sessionBusy
    : nodeStatusKnown ? (focusedNode?.busy ?? false) : (focusedNode?.busy === true || sessionBusy);
  const taskOwner = taskOwnerAgentId ?? show.taskOwner;
  // Choosing cockpit lifts its overview into view when it sits outside the
  // rail's scroll viewport; the standard mode never scrolls. The cockpit
  // overview mounts with the mode (the pinned head keeps the standard one, so
  // the slot remounts), so the lift runs in a layout effect once the fresh
  // node has landed rather than against the node that is leaving.
  const liftIntoView = (slot: HTMLElement | null) => {
    if (slot === null || typeof slot.scrollIntoView !== 'function') return;
    const view = slot.closest('[data-agent-panel-scroll]')?.getBoundingClientRect();
    const rect = slot.getBoundingClientRect();
    const viewTop = view?.top ?? 0;
    const viewBottom = view?.bottom ?? window.innerHeight;
    if (rect.top < viewTop || rect.bottom > viewBottom) {
      slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };
  const chooseOverviewMode = (next: RailMode) => {
    chooseMode(next);
    if (next !== 'cockpit') return;
    liftIntoView(panelSlot.slotRef.current);
  };

  useLayoutEffect(() => {
    if (mode === 'cockpit') liftIntoView(panelSlot.slotRef.current);
  }, [mode]);
  // Turning a tab. Inside the session view the document-level focus tracker
  // pins on click (inspectorFocus.ts); main is also handed back explicitly,
  // and the routed agent page (no onInspectMain) navigates instead.
  const selectAgent = (agentId: string) => {
    if (agentId === focusedAgentId) return;
    if (agentId === MAIN_AGENT_ID && onInspectMain !== undefined) onInspectMain();
    else if (onInspectMain === undefined) onOpenSubagent(agentId);
  };
  const subBlock = subagent?.block;
  // The timeline card can lag behind an authoritative runtime tree status;
  // retain it only while the tree has no explicit status for this agent.
  const subStatus = subagent === undefined
    ? undefined
    : nodeStatusKnown
      ? nodeStatus
      : sessionExecuting === false
        ? (nodeStatus ?? 'unknown')
        : subBlock !== undefined && subBlock.status !== 'unknown'
          ? subBlock.status
          : (nodeStatus ?? subBlock?.status ?? 'unknown');
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
  // Which first-level branches the reader opened. The rail owns this rather
  // than the overview body, so the graph comes back the way it was left after
  // drilling into an agent's preview and coming back.
  const [expandedBranches, setExpandedBranches] = useState<ReadonlySet<string>>(() => new Set());
  const toggleBranch = (branchId: string) => {
    setExpandedBranches((current) => {
      const next = new Set(current);
      if (next.has(branchId)) next.delete(branchId);
      else next.add(branchId);
      return next;
    });
  };
  const narrow = useMediaQuery('(max-width: 1023px)');
  const renderOverview = (body: React.ReactNode, scopeSwitch: React.ReactNode) => (
    <>
      <header data-rail-switchable-head className="flex h-9 min-w-0 flex-nowrap items-baseline gap-1.5 py-1">
        <h3 id="rail-overview-title" className={`${INSPECTOR_HEAD} whitespace-nowrap leading-7`}>
          {mode === 'cockpit' ? t('rail.cockpit.title') : t('inspector.overview')}
        </h3>
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

  // Background tasks are session work, so they sit with the record chapter
  // (checklist, notes, cron, feed) instead of a chapter of their own.
  const backgroundTasksSection = backgroundTasks.length > 0 ? (
    <div>
      <h4 className="flex min-h-6 items-center gap-1.5 pb-0.5">
        <span className={INSPECTOR_HEAD}>{t('rail.tasksLine')}</span>
        <span className="text-[12px] text-ink-faint tabular-nums">{backgroundTasks.length}</span>
      </h4>
      <TasksSection
        tasks={backgroundTasks}
        sessionId={session?.id}
        ownerAgentId={taskOwner}
        onCancel={onCancelTask}
        onOpenTask={setDetailTask}
      />
    </div>
  ) : null;
  // The chapters the two modes share, assembled once and ordered differently.
  // Every one of these is the same component standard mode renders, so the
  // shared roster keeps its selection, its filter and its actions.
  // Checklist, notes, hooks and plan all belong to "它记录和安排".
  const recordSection = (
    <div
      id="rail-todos"
      className={`space-y-3 empty:hidden [&:not(:has(>:not(:empty)))]:hidden [&_[data-agent-notes-state=empty]]:hidden [&_[data-agent-panel-part=work]:has([data-agent-notes-state=empty]):not(:has([data-agent-hooks-section],[data-agent-plan],[data-agent-plan-error]))]:hidden [&:has([data-agent-notes-state=empty]):not(:has([data-rail-todos],[data-agent-hooks-section],[data-agent-plan],[data-agent-plan-error]))]:hidden [&_[data-agent-todo-section]]:hidden [&_[data-agent-todos-status]]:hidden`}
    >
      <RailSection title={t('rail.group.record')} data-rail-group="record">
        <RailTodos sessionId={state.sessionId} agentId={focusedAgentId} state={state} />
        <AgentPanelContainer key={`work:${agentPanelKey}`} state={state} forest={forest} agentId={focusedAgentId} part="work" />
        {backgroundTasksSection}
        <div className="empty:hidden">
          <SessionCronSection sessionId={state.sessionId} />
        </div>
        <ActivityFeed blocks={state.blocks} forest={forest} onOpenFile={onOpenFile} onOpenAgent={onOpenSubagent} />
        {memory !== undefined ? (
          <RailSection title={memory.title} count={memory.count} data-inspector-memory="">
            {memory.content}
          </RailSection>
        ) : null}
      </RailSection>
    </div>
  );
  // What the focused agent may use: observation tabs beside the session's own
  // plugin / system / MCP switches (see the merged fold in DefaultSections).
  const capabilitySection = (
    <CapabilitiesBlock sessionId={state.sessionId} agentId={focusedAgentId} workspaceId={session?.workspace_id} cwd={session?.metadata.cwd} />
  );
  // Who is on the team. Standard mode opens to a one-line bucket summary and
  // unfolds the full roster on demand; the cockpit keeps it open.
  const terminateAllAction = showTerminateAll ? (
    <button
      type="button"
      data-terminate-all-subagents
      onClick={() => { setTerminateSnapshot(runningSubagentTasks); }}
      className="-mr-2 h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
    >
      {t('rail.terminateAll')}
    </button>
  ) : undefined;
  const agentsSection = showRoster ? (
    <div className={ROSTER_QUIET_WAITING}>
      {mode === 'cockpit' ? (
        <RailSection
          title={t('rail.group.agents')}
          count={rosterCount}
          collapsible={false}
          data-inspector-agents=""
          actions={terminateAllAction}
        >
          <AgentRoster
            forest={forest}
            rootId={focusedAgentId}
            peekAgentId={peekAgentId}
            waitingAgentIds={waitingAgentIds}
            onSelect={onOpenSubagent}
          />
        </RailSection>
      ) : (
        <RosterSummaryChapter
          forest={forest}
          rootId={focusedAgentId}
          waitingAgentIds={waitingAgentIds}
          rosterCount={rosterCount}
          actions={terminateAllAction}
        >
          {(openFilter) => (
            <AgentRoster
              forest={forest}
              rootId={focusedAgentId}
              peekAgentId={peekAgentId}
              waitingAgentIds={waitingAgentIds}
              initialFilter={openFilter}
              onSelect={onOpenSubagent}
            />
          )}
        </RosterSummaryChapter>
      )}
    </div>
  ) : null;
  const sessionSection = session !== undefined ? (
    <div className="space-y-3">
      <RailSection title={t('rail.group.session')} data-rail-group="session">
        <div className="space-y-3">
          {/* The session's facts are plain label/value lines here — no fold
              inside the chapter's fold. */}
          <dl data-inspector-session="">
            <InspectorRow label={t('rail.directory')} title={session.metadata.cwd} mono>{session.metadata.cwd}</InspectorRow>
            {session.message_count > 0 ? <InspectorRow label={t('rail.messages')}>{String(session.message_count)}</InspectorRow> : null}
            <InspectorRow label={t('rail.updatedRow')}><RelativeTime at={session.updated_at} /></InspectorRow>
          </dl>
          <div className="empty:hidden">
            <PersonaSettingsUpdate sessionId={state.sessionId} />
          </div>
          {show.comms ? <InspectorComms sessionId={session.id} /> : null}
          <div className="empty:hidden">
            <SessionChannelsRail
              sessionId={state.sessionId}
              sessionTitle={session?.title}
              personaId={session.agent_config?.persona?.name ? session.agent_config.profile : undefined}
              personaName={session.agent_config?.persona?.name}
              onOpenSettings={() => { void navigate('/settings/notifications'); }}
            />
          </div>
        </div>
      </RailSection>
    </div>
  ) : null;
  const needsYouSection = sessionPending !== undefined && sessionPending.length > 0 ? (
    <div className="pt-3">
      <NeedsYouList
        items={sessionPending}
        forest={forest}
        onResolveApproval={onResolveApproval}
        onReview={onReviewPending}
        onInspect={onOpenSubagent}
      />
    </div>
  ) : null;
  const overviewSection = (
    <section
      ref={panelSlot.slotRef}
      data-rail-agent-panel-slot
      data-rail-switchable={mode}
      aria-labelledby="rail-overview-title"
      className={`min-h-px ${OVERVIEW_METER} ${OVERVIEW_FIGURES} ${mode === 'cockpit' ? SECTION : ''}`}
    >
      <div data-rail-overview-well className={mode === 'cockpit' ? 'pt-1 pb-3' : 'pt-1'}>
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
            expandedBranches={expandedBranches}
            onToggleBranch={toggleBranch}
            sessionPending={pending}
            mainLabel={t('rail.ownerMain')}
          />
        ) : renderOverview(null, null)}
      </div>
    </section>
  );
  // What is running behind the conversation joins the pinned "现在" block as
  // one compact line; the full list stays in 它记录和安排.
  const latestTask = backgroundTasks[0];
  const latestTaskText = lastLine(latestTask?.output_preview ?? latestTask?.command) ?? latestTask?.description;
  const backgroundLine = latestTask !== undefined ? (
    <p data-rail-background className="flex min-w-0 items-baseline gap-1.5 text-[12px] leading-[18px] text-ink-faint">
      <span aria-hidden className="status-dot-busy h-1.5 w-1.5 shrink-0 self-center rounded-full bg-ink-soft" />
      <span className="shrink-0">
        {backgroundTasks.length > 1 ? t('rail.backgroundMany', { count: backgroundTasks.length }) : t('rail.backgroundOne')}
      </span>
      {latestTaskText !== undefined ? (
        <span data-rail-background-preview className="min-w-0 truncate font-mono text-[11.5px]" title={latestTaskText}>
          · {latestTaskText}
        </span>
      ) : null}
    </p>
  ) : null;
  // The four folded chapters, named after the reader's question. Standard mode
  // leads with nothing but the pinned "现在" block; the cockpit leads with the
  // session execution graph, then what waits on the reader.
  const orderedSections = (mode === 'cockpit'
    ? [
      ['agents', agentsSection],
      ['capabilities', capabilitySection],
      ['record', recordSection],
      ['session', sessionSection],
    ] as const
    : [
      ['agents', agentsSection],
      ['capabilities', capabilitySection],
      ['record', recordSection],
      ['session', sessionSection],
    ] as const
  ).filter(([, section]) => section !== null);
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
            {narrow ? null : <ModeSwitch mode={mode} onChoose={chooseOverviewMode} />}
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
        // Only the main is driven; a sub agent under it runs a real model.
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
      {needsYouSection}
      {mode === 'default' ? overviewSection : null}
      {backgroundLine}
      </div>
      </div>

      {/* One page per agent: switching agents raises the new page into place.
          The pinned "现在" block above never folds; the four chapters below
          answer one question each and start closed. The cockpit leads with the
          session execution graph inside the same page transition — same slot
          node, no remount, so an agent switch keeps its scroll. */}
      <div key={focusedAgentId} className="rail-page">
      {mode === 'cockpit' ? overviewSection : null}
      {orderedSections.map(([key, section]) => (
        <Fragment key={key}>{section}</Fragment>
      ))}
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
