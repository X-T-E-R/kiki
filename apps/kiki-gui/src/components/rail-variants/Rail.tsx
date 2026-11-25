/**
 * The right inspector rail: one page per agent, split cleanly into two hairline
 * tabs (`Run` | `Config`).
 *
 *   Run        Live work & telemetry — Needs you, ProfileHead + Now, Usage,
 *              Branches, Todos (+ Plan), active Background tasks (only while
 *              running), Agents, and a bottom quiet history fold group
 *              (Working notes, settled Background tasks, Activity, Thread comms).
 *   Config     Live topology strip (0px when idle), unfolded session controls
 *              (System capabilities, Session plugins, MCP, Channels, Cron,
 *              Persona, Memory — strictly main-session scoped), and folded
 *              agent foundation rows (Automatic rules, Capabilities, Session).
 */

import { Fragment, memo, useContext, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import type { Task } from '@kiki/protocol';

import {
  MAIN_AGENT_ID,
  mergeAgentViewIntoForest,
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
import { placeSessionPath } from '../../lib/placeRoutes';
import { pushToast } from '../../lib/toasts';
import { cssZoomFactor, unzoomedViewport } from '../../lib/uiZoom';
import { usePromoteAgent } from '../../lib/usePromoteAgent';
import { usageSessionDeepLink } from '../../lib/usageV2';
import { useOptionalConnection } from '../../state/connection';
import { AgentPanelContainer } from '../AgentPanelContainer';
import { InspectorComms } from '../comms/InspectorComms';
import { AgentRoster, RAIL_MARK, RailCrumbs } from '../agent-panel/InspectorAgents';
import {
  collectSessionBranches,
  extractBranchFoldSummaries,
  InspectorBranches,
  isSessionBranchNode,
} from '../agent-panel/InspectorBranches';
import { InspectorNow, NowAction, pendingBlocks } from '../agent-panel/InspectorNow';
import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { INSPECTOR_HEAD, INSPECTOR_LINK, InspectorChevron, InspectorRow, InspectorSection } from '../agent-panel/InspectorSection';
import { ConfirmDialog } from '../ConfirmDialog';
import { useInspectorPeek } from '../inspectorFocus';
import { RelativeTime } from '../RelativeTime';
import { TaskDetailModal } from '../TaskDetailModal';
import { conversationCenterFloor } from '../preview/shared';
import { descendantIds, railVisibility, waitingAgentIds as pendingOrigins } from './model';
import { FOCUS_RING } from './shell';
import type { RailProps } from './types';
import { readExternalClientMark } from '../../lib/externalClients';
import { ActivityFeed, CapabilitiesBlock, NeedsYouList, ProfileHead, SessionEnvironmentControls } from './DefaultSections';
import { RailTodos } from './DefaultRail';
import { RailLiveTopology } from './RailLiveTopology';
import { RunCronSection, SessionCronSection, useSessionCronTasks } from './SessionCronSection';
import { SessionChannelsRail } from '../im/SessionChannelsRail';
import { PersonaSettingsUpdate } from '../persona/PersonaSettingsUpdate';

export type RailTab = 'run' | 'config';

const FALLBACK_QUERY_CLIENT = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

/** One section of the scrolling page: a hairline above it, no card. */
const SECTION = 'border-t border-hairline py-3';
/** The context meter stays neutral until the overview calls it near; near is amber, never the "needs you" accent. */
const OVERVIEW_METER = '[&_[data-overview-context]_[role=meter]>div]:!bg-ink-soft/70 [&_[data-overview-context=warn]_[role=meter]>div]:!bg-amber-rule [&_[data-overview-context=danger]_[role=meter]>div]:!bg-amber-rule [&_[data-overview-context]_span.text-danger]:!text-amber-ink';
/** Cost, tokens and cache as mono figures on one measured row. */
const OVERVIEW_FIGURES = '[&_[data-overview-fact]>div:first-child]:font-mono [&_[data-overview-fact]>div:first-child]:text-[17px] [&_[data-overview-fact]>div:first-child]:font-normal [&_[data-overview-context-figures]]:font-mono';
/** Waiting agents are already listed in Needs you: their roster rows keep only the trailing state word. */
const ROSTER_QUIET_WAITING = '[&_[data-roster-waiting]]:!bg-transparent';

const NO_PENDING: readonly (ApprovalBlock | QuestionBlock)[] = [];

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

const OPAQUE_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{24,}$|^[0-9a-z]{20,}$/i;

function residentDirName(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  const leaf = cwd.split(/[\\/]/).filter((part) => part !== '').pop();
  if (leaf === undefined || leaf === '') return undefined;
  return OPAQUE_DIR.test(leaf) ? undefined : leaf;
}

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
  onOpenTask: (task: Task) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const connection = useOptionalConnection();
  const [settledOpen, setSettledOpen] = useState(false);
  const sorted = useMemo(() => sortTasks(tasks), [tasks]);
  const runningTasks = useMemo(() => sorted.filter((task) => task.status === 'running'), [sorted]);
  const settledTasks = useMemo(() => sorted.filter((task) => task.status !== 'running'), [sorted]);
  if (sorted.length === 0) {
    return <p className="text-[13px] text-ink-faint">{t('rail.noTasks')}</p>;
  }
  const renderTaskRow = (task: Task) => (
    <li key={task.id} data-rail-item className="rail-task-row -mx-2 flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-ink/[0.04]">
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
  );
  const showDirectSettled = runningTasks.length === 0;
  return (
    <div data-tasks-scroll className="max-h-80 overflow-y-auto pr-1">
      {runningTasks.length > 0 ? (
        <ul className="space-y-0.5">
          {runningTasks.map(renderTaskRow)}
        </ul>
      ) : null}
      {settledTasks.length > 0 ? (
        showDirectSettled ? (
          <ul data-tasks-settled-list className="space-y-0.5">
            {settledTasks.map(renderTaskRow)}
          </ul>
        ) : (
          <div className="mt-1.5">
            <button
              type="button"
              data-tasks-settled-toggle
              aria-expanded={settledOpen}
              onClick={() => { setSettledOpen((open) => !open); }}
              className="-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
            >
              <InspectorChevron open={settledOpen} />
              <span className="min-w-0 flex-1 truncate">{t('rail.tasks.settledSummary', { count: settledTasks.length })}</span>
            </button>
            {settledOpen ? (
              <ul data-tasks-settled-list className="mt-0.5 space-y-0.5">
                {settledTasks.map(renderTaskRow)}
              </ul>
            ) : null}
          </div>
        )
      ) : null}
      {sessionId !== undefined ? (
        <div className="pt-1">
          <button
            type="button"
            onClick={() => void navigate(placeSessionPath(connection?.connectionId, sessionId, '/tasks'))}
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

/** Mounts its children only once the slot scrolls into the rail's view. */
function useLazyPanelSlot() {
  const [slotNode, setSlotNode] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (slotNode === null) {
      setVisible(false);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      setMounted(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      const next = entry?.isIntersecting === true;
      setVisible(next);
      if (next) setMounted(true);
    }, { root: slotNode.closest('[data-agent-panel-scroll]') ?? slotNode.parentElement });
    observer.observe(slotNode);
    return () => observer.disconnect();
  }, [slotNode]);
  return { slotRef: setSlotNode, visible, mounted };
}

export const Rail = memo(function Rail({
  state,
  forest: forestProp,
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
  onSearchSubagents,
  onClose,
  className,
}: RailProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const connection = useOptionalConnection();
  const queryClient = useContext(QueryClientContext);
  const [activeTab, setActiveTab] = useState<RailTab>('run');
  const railTabIdPrefix = useId();
  const session = state.session;
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [terminateSnapshot, setTerminateSnapshot] = useState<readonly Task[] | null>(null);
  const [terminatingAll, setTerminatingAll] = useState(false);
  const panelSlot = useLazyPanelSlot();
  const peekAgentId = useInspectorPeek();
  const focusedAgentId = selectedAgentId ?? MAIN_AGENT_ID;
  const isMainAgent = focusedAgentId === MAIN_AGENT_ID;
  const sameAsCenter =
    onInspectMain === undefined || (focusedAgentId === MAIN_AGENT_ID && subagent === undefined);
  const isRoutedChildPage = focusedAgentId !== MAIN_AGENT_ID && sameAsCenter;
  const railScrollRef = useRef<HTMLDivElement>(null);

  const personaAttentionQuery = useQuery(
    {
      queryKey: ['sessions', state.sessionId, 'persona-settings'] as const,
      queryFn: () => connection!.client.getPersonaSettings(state.sessionId),
      enabled:
        queryClient !== undefined &&
        isMainAgent &&
        Boolean(state.sessionId) &&
        typeof connection?.client?.getPersonaSettings === 'function',
      staleTime: 15_000,
      retry: false,
    },
    queryClient ?? FALLBACK_QUERY_CLIENT,
  );
  const hasConfigAttention = isMainAgent && personaAttentionQuery.data?.hasUpdate === true;
  const sessionCron = useSessionCronTasks(state.sessionId, isMainAgent);
  const activeCronTasks = sessionCron.activeTasks;

  const forest = useMemo(
    () => (isRoutedChildPage ? mergeAgentViewIntoForest(forestProp, focusedAgentId, state) : forestProp),
    [forestProp, focusedAgentId, isRoutedChildPage, state],
  );
  const deferredForest = useDeferredValue(forest);
  const externalDriver = useMemo(
    () => readExternalClientMark(session?.metadata)?.clientName,
    [session?.metadata],
  );
  const focusedNode = forest.byId[focusedAgentId];
  const focusedFallbackLabel = subagent?.block?.label ?? subagent?.block?.name;
  const focusedDisplayLabel = focusedNode?.label ?? (focusedFallbackLabel !== undefined && focusedFallbackLabel !== '' ? focusedFallbackLabel : focusedAgentId);
  const promote = usePromoteAgent(state.sessionId, subagent?.agentId);
  const show = railVisibility(focusedAgentId, onInspectMain === undefined ? focusedAgentId : MAIN_AGENT_ID);
  const backgroundTasks = useMemo(() => {
    const nonSubagent = state.tasks.filter((task) => task.kind !== 'subagent');
    const running = nonSubagent.filter((task) => task.status === 'running');
    const recentSettled = sortTasks(nonSubagent.filter((task) => task.status !== 'running')).slice(0, 5);
    return [...running, ...recentSettled];
  }, [state.tasks]);
  const runningSubagentTasks = useMemo(
    () =>
      state.tasks.filter(
        (task) =>
          task.kind === 'subagent' &&
          task.status === 'running' &&
          task.agent_id !== undefined &&
          !isSessionBranchNode(forest.byId[task.agent_id]),
      ),
    [forest.byId, state.tasks],
  );
  const runningSubagentTasksRef = useRef(runningSubagentTasks);
  runningSubagentTasksRef.current = runningSubagentTasks;
  const ownPending = useMemo(() => pendingBlocks(state.blocks), [state.blocks]);
  const pending = sessionPending ?? ownPending;
  const waitingAgentIds = useMemo(() => {
    const ids = pendingOrigins(pending);
    if (subagent !== undefined && subagent.pendingInteractionCount > 0) ids.add(subagent.agentId);
    return ids;
  }, [pending, subagent]);
  const topologyPendingCount = useMemo(() => {
    if (isMainAgent) return pending.length;
    const scopeIds = new Set<string>([focusedAgentId, ...descendantIds(deferredForest, focusedAgentId)]);
    const scopedFromPending = pending.filter((item) => scopeIds.has(item.originAgentId ?? MAIN_AGENT_ID)).length;
    const ownSubagentCount = subagent !== undefined && subagent.agentId === focusedAgentId ? subagent.pendingInteractionCount : 0;
    return Math.max(scopedFromPending, ownSubagentCount);
  }, [deferredForest, focusedAgentId, isMainAgent, pending, subagent]);
  const sessionBranches = useMemo(
    () => collectSessionBranches(deferredForest, waitingAgentIds),
    [deferredForest, waitingAgentIds],
  );
  const localRosterCount = useMemo(() => descendantIds(deferredForest, focusedAgentId).length, [deferredForest, focusedAgentId]);
  const rosterAgentCounts = useMemo(() => {
    if (focusedAgentId !== MAIN_AGENT_ID || state.agentCounts === undefined) return undefined;
    if (sessionBranches.all.length === 0) return state.agentCounts;
    const next = {
      ...state.agentCounts,
      subagents: Math.max(0, state.agentCounts.subagents - sessionBranches.all.length),
      idle: state.agentCounts.idle ?? 0,
    };
    let unmatched = 0;
    for (const branch of sessionBranches.all) {
      if (branch.status === 'running' || branch.status === 'background' || branch.status === 'suspended') {
        if (next.active > 0) next.active -= 1;
        else unmatched += 1;
      } else if (branch.status === 'idle') {
        if (next.idle > 0) next.idle -= 1;
        else unmatched += 1;
      } else if (branch.status === 'unknown') {
        if (next.unknown > 0) next.unknown -= 1;
        else unmatched += 1;
      } else if (branch.status === 'failed' || branch.status === 'lost') {
        if (next.failed > 0) next.failed -= 1;
        else unmatched += 1;
      } else if (branch.status === 'cancelled') {
        if (next.cancelled > 0) next.cancelled -= 1;
        else unmatched += 1;
      } else if (next.completed > 0) {
        next.completed -= 1;
      } else {
        unmatched += 1;
      }
    }
    for (const key of ['completed', 'failed', 'cancelled', 'unknown', 'idle', 'active'] as const) {
      if (unmatched <= 0) break;
      const take = Math.min(unmatched, next[key]);
      next[key] -= take;
      unmatched -= take;
    }
    return next;
  }, [focusedAgentId, state.agentCounts, sessionBranches.all]);
  const rosterCount = rosterAgentCounts !== undefined
    ? Math.max(localRosterCount, rosterAgentCounts.subagents)
    : localRosterCount;
  const showRoster = rosterCount > 0;
  const branchFoldSummaries = useMemo(
    () => extractBranchFoldSummaries(state.blocks),
    [state.blocks],
  );
  const viewingBranch = isSessionBranchNode(focusedNode);
  const showBranches = (!isRoutedChildPage || viewingBranch) && sessionBranches.all.length > 0;
  const showTerminateAll = show.stopAll && onStopAgentTask !== undefined && runningSubagentTasks.length > 0;
  const nodeStatus = focusedNode?.status;
  const nodeStatusKnown = focusedNode !== undefined && nodeStatus !== 'unknown';
  const sessionExecuting = state.session?.executing ?? state.session?.main_turn_active;
  const sessionBusy = state.session === undefined ? state.busy : sessionExecuting === true;
  const busy = show.isMain
    ? sessionBusy
    : nodeStatusKnown ? (focusedNode?.busy ?? false) : (focusedNode?.busy === true || sessionBusy);
  const taskOwner = taskOwnerAgentId ?? show.taskOwner;

  const selectAgent = (agentId: string) => {
    setActiveTab('run');
    if (agentId === focusedAgentId) return;
    if (agentId === MAIN_AGENT_ID && onInspectMain !== undefined) onInspectMain();
    else onOpenSubagent(agentId);
  };
  const openAgentInRun = (agentId: string) => {
    setActiveTab('run');
    onOpenSubagent(agentId);
  };

  const subBlock = subagent?.block;
  const subBlockIsLive = subBlock !== undefined && (subBlock.status === 'running' || subBlock.status === 'suspended');
  const subStatus = subagent === undefined
    ? undefined
    : nodeStatusKnown
      ? nodeStatus
      : subBlock !== undefined && subBlock.status !== 'unknown' && !(sessionExecuting === false && subBlockIsLive)
        ? subBlock.status
        : (nodeStatus ?? 'unknown');
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
          onStopAgentTask(forest.byId[task.agent_id ?? '']?.parentAgentId ?? focusedAgentId, task.id),
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
  const railRef = useRef<HTMLElement>(null);
  const { startResize, reset } = usePaneResize({
    value: railWidthValue,
    min: RAIL_MIN_WIDTH,
    max: RAIL_MAX_WIDTH,
    direction: -1,
    resolveBounds: () => {
      const railEl = railRef.current;
      if (railEl === null) return undefined;
      const zoom = cssZoomFactor();
      const renderedWidth = railEl.getBoundingClientRect().width / zoom;
      const startValue = renderedWidth > 0 ? Math.round(renderedWidth) : undefined;
      const rowEl = railEl.closest<HTMLElement>('.conversation-row');
      if (rowEl === null) return { startValue };
      const rowWidth = rowEl.getBoundingClientRect().width / zoom;
      if (!(rowWidth > 0)) return { startValue };
      const railSlot = railEl.closest<HTMLElement>('.conversation-rail-slot');
      const isOverlayRail = (railSlot?.querySelector('[data-rail-backdrop]') ?? null) !== null;
      if (isOverlayRail) {
        return {
          min: RAIL_MIN_WIDTH,
          max: Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, Math.floor(rowWidth - 48))),
          startValue,
        };
      }
      const viewportWidth = unzoomedViewport().width;
      const style = typeof window !== 'undefined' ? window.getComputedStyle(rowEl) : null;
      const parsedGap = style === null ? Number.NaN : Number.parseFloat(style.columnGap || style.gap || '');
      const rowGap = Number.isFinite(parsedGap) ? parsedGap : 8;
      const previewEl = rowEl.querySelector<HTMLElement>(
        '[data-preview-workspace]:not([hidden]):not([data-preview-fullscreen])',
      );
      const dockedPreviewWidth =
        previewEl !== null ? Math.max(0, previewEl.getBoundingClientRect().width / zoom) : 0;
      const totalGaps = dockedPreviewWidth > 0 ? rowGap * 2 : rowGap;
      const availableForRail =
        rowWidth - conversationCenterFloor(viewportWidth) - dockedPreviewWidth - totalGaps;
      return {
        min: RAIL_MIN_WIDTH,
        max: Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, Math.floor(availableForRail))),
        startValue,
      };
    },
    onChange: (value, final) => {
      setRailWidthValue(value);
      if (final) writeLayoutPreferences({ railWidth: value });
    },
    onReset: () => {
      setRailWidthValue(RAIL_DEFAULT_WIDTH);
      writeLayoutPreferences({ railWidth: RAIL_DEFAULT_WIDTH });
    },
  });

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
        <h3 id="rail-overview-title" className={`${INSPECTOR_HEAD} whitespace-nowrap leading-7`}>
          {t('rail.usageSection')}
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

  const runningBackgroundCount = useMemo(
    () => backgroundTasks.filter((task) => task.status === 'running').length,
    [backgroundTasks],
  );
  const settledBackgroundCount = backgroundTasks.length - runningBackgroundCount;

  const runningTasksSection = runningBackgroundCount > 0 ? (
    <div className={SECTION} data-rail-section="tasks">
      <RailSection
        key="tasks-running"
        title={t('rail.tasks')}
        collapsible={false}
        defaultOpen
        count={runningBackgroundCount}
      >
        <TasksSection
          tasks={backgroundTasks}
          sessionId={session?.id}
          ownerAgentId={taskOwner}
          onCancel={onCancelTask}
          onOpenTask={setDetailTask}
        />
      </RailSection>
    </div>
  ) : null;

  const cronTurnActive = useMemo(() => {
    if (!busy || !isMainAgent) return false;
    if (state.activePromptId !== undefined && state.queuedPromptMeta[state.activePromptId]?.originKind === 'cron_job') {
      return true;
    }
    let activeTurnId: string | undefined = state.abortableTurnId !== undefined ? String(state.abortableTurnId) : undefined;
    for (let index = state.blocks.length - 1; index >= 0; index -= 1) {
      const block = state.blocks[index];
      if (block === undefined) continue;
      const blockTurnId = 'turnId' in block ? block.turnId : undefined;
      if (activeTurnId === undefined && blockTurnId !== undefined) {
        activeTurnId = blockTurnId;
      } else if (activeTurnId !== undefined && blockTurnId !== undefined && blockTurnId !== activeTurnId) {
        return false;
      }
      if (block.kind === 'system') {
        if (block.variant === 'cron_job') return true;
        if (block.variant === 'task' || block.variant === 'agent_message' || block.variant === 'system_trigger') {
          return false;
        }
      }
      if (block.kind === 'user') return false;
    }
    return false;
  }, [busy, isMainAgent, state.abortableTurnId, state.activePromptId, state.blocks, state.queuedPromptMeta]);

  const runCronSection = isMainAgent && activeCronTasks.length > 0 ? (
    <div className={SECTION} data-rail-section="run-cron">
      <RunCronSection
        sessionId={state.sessionId}
        activeTasks={activeCronTasks}
        cronTurnActive={cronTurnActive}
        turnStartedAt={runStartedAt}
      />
    </div>
  ) : null;

  const settledTasksHistoryRow = runningBackgroundCount === 0 && settledBackgroundCount > 0 ? (
    <RailSection
      key="tasks-settled"
      title={t('rail.tasks')}
      collapsible
      defaultOpen={false}
      summary={t('rail.tasks.settledSummary', { count: settledBackgroundCount })}
      data-rail-section="tasks"
    >
      <TasksSection
        tasks={backgroundTasks}
        sessionId={session?.id}
        ownerAgentId={taskOwner}
        onCancel={onCancelTask}
        onOpenTask={setDetailTask}
      />
    </RailSection>
  ) : null;

  const todosSection = (
    <div
      id="rail-todos"
      data-rail-section="todos"
      className={`${SECTION} space-y-3 empty:hidden [&:not(:has(>:not(:empty)))]:hidden [&_[data-rail-todos-loading]]:hidden [&:has([data-rail-todos-loading]):not(:has([data-agent-plan],[data-agent-plan-error]))]:hidden`}
    >
      <RailTodos sessionId={state.sessionId} agentId={focusedAgentId} state={state} />
      <AgentPanelContainer key={`plan:${agentPanelKey}`} state={state} forest={forest} agentId={focusedAgentId} visible={panelSlot.visible} part="plan" />
    </div>
  );

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
  const backToMainAction = viewingBranch ? (
    <button
      type="button"
      data-branches-back-to-main
      aria-label={t('rail.branches.backToMainAria')}
      title={t('rail.branches.backToMainAria')}
      onClick={() => { selectAgent(MAIN_AGENT_ID); }}
      className="-mr-2 inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
    >
      <Icon name="arrowLeft" size={12} />
      <span>{t('rail.branches.backToMain')}</span>
    </button>
  ) : undefined;
  const hasOpenBranches = sessionBranches.open.length > 0;
  const branchesSummary = !hasOpenBranches && sessionBranches.merged.length > 0
    ? `${sessionBranches.merged.length} ${t('rail.branches.status.merged')}`
    : undefined;
  const branchesSection = showBranches ? (
    <div className={SECTION} data-rail-section="branches">
      <RailSection
        key={hasOpenBranches || viewingBranch ? 'branches-active' : 'branches-settled'}
        title={t('rail.group.branches')}
        count={hasOpenBranches ? sessionBranches.open.length : undefined}
        summary={branchesSummary}
        collapsible
        defaultOpen={hasOpenBranches || viewingBranch}
        data-inspector-branches=""
        actions={backToMainAction}
      >
        <InspectorBranches
          sessionId={state.sessionId}
          branches={sessionBranches}
          focusedAgentId={focusedAgentId}
          peekAgentId={peekAgentId}
          waitingAgentIds={waitingAgentIds}
          foldSummaries={branchFoldSummaries}
          onSelect={openAgentInRun}
        />
      </RailSection>
    </div>
  ) : null;

  const agentsSection = showRoster ? (
    <div className={`${SECTION} ${ROSTER_QUIET_WAITING}`} data-rail-section="agents">
      <RailSection
        title={t('rail.group.agents')}
        count={rosterCount}
        collapsible={false}
        data-inspector-agents=""
        actions={terminateAllAction}
      >
        <AgentRoster
          forest={deferredForest}
          rootId={focusedAgentId}
          peekAgentId={peekAgentId}
          waitingAgentIds={waitingAgentIds}
          onSelect={openAgentInRun}
          agentCounts={rosterAgentCounts}
          onSearchSubagents={onSearchSubagents}
        />
      </RailSection>
    </div>
  ) : null;

  const historyTailSection = (
    <div
      data-inspector-tail
      data-rail-section="history"
      className={`${SECTION} space-y-0.5 empty:hidden [&:not(:has(>:not(:empty)))]:hidden [&_[data-agent-notes-quiet-empty]]:hidden [&_[data-agent-panel-part=notes]:not(:has([data-agent-notes-section]:not([data-agent-notes-quiet-empty])))]:hidden [contain:layout_style]`}
    >
      <AgentPanelContainer key={`notes:${agentPanelKey}`} state={state} forest={forest} agentId={focusedAgentId} visible={panelSlot.visible} part="notes" />
      {settledTasksHistoryRow}
      <ActivityFeed blocks={state.blocks} forest={deferredForest} onOpenFile={onOpenFile} onOpenAgent={openAgentInRun} />
      {show.comms && session !== undefined ? <InspectorComms sessionId={session.id} /> : null}
    </div>
  );

  const needsYouSection = sessionPending !== undefined && sessionPending.length > 0 ? (
    <div className="pt-1">
      <NeedsYouList
        items={sessionPending}
        forest={forest}
        onResolveApproval={onResolveApproval}
        onReview={onReviewPending}
        onInspect={openAgentInRun}
      />
    </div>
  ) : null;

  const overviewSection = (
    <section
      ref={panelSlot.slotRef}
      data-rail-agent-panel-slot
      aria-labelledby="rail-overview-title"
      className={`min-h-px ${SECTION} ${OVERVIEW_METER} ${OVERVIEW_FIGURES}`}
    >
      <div data-rail-overview-well>
        {panelSlot.mounted ? (
          <AgentPanelContainer
            key={`overview:${agentPanelKey}`}
            state={state}
            forest={deferredForest}
            agentId={focusedAgentId}
            visible={panelSlot.visible}
            part="overview"
            renderOverview={renderOverview}
            scopeRootId={isRoutedChildPage ? focusedAgentId : MAIN_AGENT_ID}
          />
        ) : renderOverview(null, null)}
      </div>
    </section>
  );

  const runSections = ([
    ['overview', overviewSection],
    ['branches', branchesSection],
    ['todos', todosSection],
    ['tasks', runningTasksSection],
    ['cron', runCronSection],
    ['agents', agentsSection],
    ['history', historyTailSection],
  ] as const).filter(([, section]) => section !== null);

  const railTabId = (tab: RailTab) => `${railTabIdPrefix}-tab-${tab}`;
  const railPanelId = (tab: RailTab) => `${railTabIdPrefix}-panel-${tab}`;

  const renderTabStrip = (heightClass: string) => (
    <div
      role="tablist"
      aria-label={t('rail.tabs.aria')}
      data-rail-tabs=""
      className={`flex ${heightClass} min-w-0 items-stretch gap-4`}
    >
      {(['run', 'config'] as const).map((tab) => {
        const selected = activeTab === tab;
        const otherTab: RailTab = tab === 'run' ? 'config' : 'run';
        return (
          <button
            key={tab}
            id={railTabId(tab)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={railPanelId(tab)}
            tabIndex={selected ? 0 : -1}
            data-rail-tab={tab}
            onClick={() => { setActiveTab(tab); }}
            onKeyDown={(event) => {
              let next: RailTab | undefined;
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = otherTab;
              else if (event.key === 'Home') next = 'run';
              else if (event.key === 'End') next = 'config';
              if (next === undefined) return;
              event.preventDefault();
              setActiveTab(next);
              const nextEl = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-rail-tab="${next}"]`);
              nextEl?.focus();
            }}
            className={`relative flex h-full shrink-0 cursor-pointer items-center gap-1.5 text-[13px] font-normal transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
              selected ? 'text-ink' : 'text-ink-faint hover:text-ink-soft'
            }`}
          >
            <span>{t(tab === 'run' ? 'rail.tab.run' : 'rail.tab.config')}</span>
            {tab === 'config' && hasConfigAttention ? (
              <span
                aria-hidden
                data-rail-config-attention=""
                className="h-[5px] w-[5px] shrink-0 rounded-full bg-attention"
              />
            ) : null}
            {selected ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-[1.5px] bg-ink"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );

  const railHeaderControls = (
    <span className="flex shrink-0 items-center gap-1.5">
      {sessionPending !== undefined && sessionPending.length > 0 ? (
        <button
          type="button"
          data-rail-pending-jump=""
          title={t('inspector.needsYou')}
          aria-label={`${t('inspector.needsYou')} (${sessionPending.length})`}
          onClick={() => {
            setActiveTab('run');
            const scroller = railScrollRef.current;
            if (scroller !== null) scroller.scrollTop = 0;
          }}
          className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-attention px-1.5 text-[11px] font-normal tabular-nums text-on-accent transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink"
        >
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-on-accent" />
          <span>{sessionPending.length}</span>
        </button>
      ) : null}
      {onClose === undefined ? null : (
        <button
          type="button"
          onClick={onClose}
          data-rail-close
          title={t('sv.hidePanel')}
          aria-label={t('sv.hidePanel')}
          className="-mr-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-7 lg:w-7"
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </span>
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
        className={className ?? 'app-rail'}
        style={{ '--kiki-rail-width': `${railWidthValue}px`, overflow: 'hidden', display: 'flex', flexDirection: 'column' } as React.CSSProperties}
        data-session-rail
        data-rail-active-tab={activeTab}
        data-inspector-agent={focusedAgentId}
        ref={railRef}
        onFocus={() => { focusInRail.current = true; }}
        onBlur={(event) => {
          if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget as Node)) focusInRail.current = false;
        }}
      >
        <div ref={railScrollRef} data-agent-panel-scroll className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 [contain:layout_style]">
          {/* Strict h-12 sticky bar aligning across all 3 panes. */}
          <div data-rail-pinned className="sticky top-0 z-20 -mx-4 flex h-12 items-center justify-between gap-2 border-b border-hairline bg-panel px-4">
            {sameAsCenter ? (
              <div data-rail-owner className="flex h-full min-w-0 flex-1 items-center justify-between gap-2">
                <h2
                  aria-current="page"
                  tabIndex={-1}
                  data-rail-owner-heading=""
                  className="sr-only"
                >
                  {t('rail.ownerOverview')}
                </h2>
                {renderTabStrip('h-full')}
                {railHeaderControls}
              </div>
            ) : (
              <RailCrumbs
                forest={forest}
                focusedAgentId={focusedAgentId}
                fallbackLabel={focusedFallbackLabel}
                onSelect={selectAgent}
                close={railHeaderControls}
              />
            )}
          </div>

          {!sameAsCenter ? (
            <div
              data-rail-sub-tabs=""
              className="sticky top-12 z-20 -mx-4 flex h-8 items-stretch border-b border-hairline bg-panel px-4"
            >
              {renderTabStrip('h-full')}
            </div>
          ) : null}

          {activeTab === 'run' ? (
            <div
              key={`run:${focusedAgentId}`}
              id={railPanelId('run')}
              role="tabpanel"
              aria-labelledby={railTabId('run')}
              data-rail-panel="run"
              className="rail-page flex flex-col pt-3"
            >
              {needsYouSection !== null ? <div className="pb-3">{needsYouSection}</div> : null}
              <div data-rail-now-block className="space-y-3 pb-3">
                <ProfileHead
                  sessionId={state.sessionId}
                  agentId={focusedAgentId}
                  label={focusedDisplayLabel}
                  fallbackModel={focusedNode?.model ?? subagent?.block?.model ?? (focusedAgentId === MAIN_AGENT_ID || isRoutedChildPage ? state.model : undefined)}
                  workspaceId={session?.workspace_id}
                  cwd={session?.metadata.cwd}
                  externalDriver={focusedAgentId === MAIN_AGENT_ID ? externalDriver : undefined}
                />
                <InspectorNow
                  blocks={state.blocks}
                  busy={busy}
                  pending={sessionPending === undefined ? pending : NO_PENDING}
                  listPending={sessionPending === undefined}
                  onReview={onReviewPending}
                  startedAt={runStartedAt}
                  subagent={(() => {
                    if (!show.subagentStory || subagent === undefined || subStatus === undefined) return undefined;
                    const rawBrief = subBlock?.description ?? subBlock?.instruction ?? focusedNode?.description;
                    const ownerLabel = (focusedNode?.label ?? '').trim();
                    const brief =
                      rawBrief !== undefined && rawBrief.trim() !== '' && rawBrief.trim() !== ownerLabel
                        ? rawBrief
                        : undefined;
                    return {
                      status: subStatus,
                      brief,
                      result: subBlock?.summary ?? focusedNode?.summary,
                      error: subBlock?.error ?? focusedNode?.error,
                      pendingCount: subagent.pendingInteractionCount,
                    };
                  })()}
                  actions={subagent === undefined || (!show.openAgent && !show.locateSpawn && promote === undefined) ? undefined : (() => {
                    const nowHasMark =
                      Math.max(sessionPending === undefined ? pending.length : 0, subagent.pendingInteractionCount) > 0
                      || busy
                      || subStatus === 'running'
                      || subStatus === 'background'
                      || subStatus === 'failed'
                      || subStatus === 'completed';
                    return (
                      <div data-subagent-context className={`-mt-1 ${nowHasMark ? 'ml-3 ' : ''}flex flex-wrap items-center gap-x-4 gap-y-1`}>
                        {show.openAgent ? (
                          <NowAction data-rail-open-agent="" icon="external" label={t('inspector.openAgent')} onClick={() => { openAgentInRun(subagent.agentId); }} />
                        ) : null}
                        {show.locateSpawn && subagent.onJumpToSpawn !== undefined ? (
                          <NowAction data-rail-locate="" icon="arrowUp" label={t('inspector.locate')} onClick={subagent.onJumpToSpawn} />
                        ) : null}
                        {promote !== undefined ? (
                          <NowAction
                            data-rail-promote=""
                            icon="arrowUpRight"
                            label={t(promote.pending ? 'agent.promotePending' : (viewingBranch ? 'transcript.branch.promote' : 'agent.promote'))}
                            disabled={promote.pending}
                            onClick={promote.promote}
                          />
                        ) : null}
                      </div>
                    );
                  })()}
                />
              </div>
              {runSections.map(([key, section]) => (
                <Fragment key={key}>{section}</Fragment>
              ))}
            </div>
          ) : (
            <div
              key={`config:${focusedAgentId}`}
              id={railPanelId('config')}
              role="tabpanel"
              aria-labelledby={railTabId('config')}
              data-rail-panel="config"
              className="rail-page flex flex-col pt-3"
            >
              <RailLiveTopology
                busy={busy}
                turnStartedAt={runStartedAt}
                mainLabel={
                  isMainAgent
                    ? (focusedDisplayLabel === 'agent' || focusedDisplayLabel === MAIN_AGENT_ID
                        ? t('rail.ownerMain')
                        : focusedDisplayLabel)
                    : focusedDisplayLabel
                }
                rootAgentId={focusedAgentId}
                forest={deferredForest}
                openBranches={sessionBranches.open}
                runningSubagentTasks={runningSubagentTasks}
                activeCronTasks={isMainAgent ? activeCronTasks : undefined}
                waitingAgentIds={waitingAgentIds}
                pendingCount={topologyPendingCount}
                onSwitchToRun={() => { setActiveTab('run'); }}
                onOpenAgent={openAgentInRun}
                onOpenCron={() => {
                  const target = railScrollRef.current?.querySelector<HTMLElement>('[data-rail-section="cron"]');
                  if (target !== null && target !== undefined && typeof target.scrollIntoView === 'function') {
                    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                  } else {
                    setActiveTab('run');
                  }
                }}
              />

              {isMainAgent ? (
                <>
                  <div className="pb-3" data-rail-section="environment">
                    <SessionEnvironmentControls sessionId={state.sessionId} />
                  </div>
                  <div
                    data-rail-section="session-integrations"
                    className={`${SECTION} space-y-0.5 empty:hidden [&:not(:has(>:not(:empty)))]:hidden`}
                  >
                    {session !== undefined ? (
                      <div className="empty:hidden">
                        <SessionChannelsRail
                          sessionId={state.sessionId}
                          sessionTitle={session.title}
                          personaId={session.agent_config?.persona?.name ? session.agent_config.profile : undefined}
                          personaName={session.agent_config?.persona?.name}
                          onOpenSettings={() => { void navigate('/settings/notifications'); }}
                        />
                      </div>
                    ) : null}
                    <div className="empty:hidden" data-rail-section="cron">
                      <SessionCronSection sessionId={state.sessionId} />
                    </div>
                    <div className="empty:hidden">
                      <PersonaSettingsUpdate sessionId={state.sessionId} />
                    </div>
                    {memory !== undefined ? (
                      <RailSection title={memory.title} count={memory.count} defaultOpen={false} data-inspector-memory="">
                        {memory.content}
                      </RailSection>
                    ) : null}
                  </div>
                </>
              ) : null}

              <div
                data-rail-config-foundation=""
                data-rail-section="foundation"
                className={`${isMainAgent ? SECTION : 'space-y-0.5'} space-y-0.5 empty:hidden [&:not(:has(>:not(:empty)))]:hidden [&_[data-agent-hooks-state=loading]]:hidden [&_[data-agent-panel-part=hooks]:not(:has([data-agent-hooks-section]:not([data-agent-hooks-state=loading])))]:hidden`}
              >
                <AgentPanelContainer key={`hooks:${agentPanelKey}`} state={state} forest={forest} agentId={focusedAgentId} visible part="hooks" />
                <CapabilitiesBlock sessionId={state.sessionId} agentId={focusedAgentId} workspaceId={session?.workspace_id} cwd={session?.metadata.cwd} />
                {isMainAgent && session !== undefined ? (
                  <RailSection
                    title={t('rail.group.session')}
                    summary={residentDirName(session.metadata.cwd) ?? t('rail.sessionNoName')}
                    defaultOpen={false}
                    data-rail-group="session"
                    data-inspector-session=""
                  >
                    <dl>
                      <InspectorRow label={t('rail.directory')} title={session.metadata.cwd}><span className="truncate" style={{ direction: 'rtl', unicodeBidi: 'plaintext' }}>{session.metadata.cwd}</span></InspectorRow>
                      {session.message_count > 0 ? <InspectorRow label={t('rail.messages')}>{String(session.message_count)}</InspectorRow> : null}
                      <InspectorRow label={t('rail.updatedRow')}><RelativeTime at={session.updated_at} /></InspectorRow>
                    </dl>
                  </RailSection>
                ) : null}
              </div>
            </div>
          )}
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
});
