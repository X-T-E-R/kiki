/**
 * Session inspector — the on-demand right panel (closed by default, opened
 * from the header toggle). It describes ONE agent at a time — whichever the
 * user last clicked into or focused (see inspectorFocus.ts) — in the order
 * someone glancing over wants it:
 *
 *   heading   who this is, a one-line "now" status, the way back up
 *             (main agent / spawning parent crumbs)
 *   1. Needs you          pending approvals / questions, each with Review
 *   2. Subagent task      (subagent focus) its brief, result, failure
 *   3. Todo · Plan        the agent's own checklist and plan
 *   4. Subagents          the dispatch tree — the one place to switch agents
 *   5. Background tasks   running shells and jobs, with Stop
 *   6. Recent activity    files touched, recent commands
 *   7. Context            context bar and the usage that is known
 *   8. Memory             reserved slot (`memory` prop), not yet populated
 *   9. Model and capabilities   collapsed
 *  10. Session                  collapsed; directory, counts, workspace links
 *
 * Empty chapters render nothing; nothing reads "Unknown".
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';

import type { Task } from '@kiki/protocol';

import type { I18nKey } from '@kiki/session-core/i18n';
import {
  MAIN_AGENT_ID,
  type AgentForest,
  type AgentTreeNode,
  type SessionViewState,
  type SubagentBlock,
} from '@kiki/session-core/session';
import { sortTasks } from '@kiki/session-core/sessions';
import {
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  writeLayoutPreferences,
} from '@kiki/session-core/settings';
import { useI18n } from '../i18n';
import type { ListCronTasksResponse } from '../lib/client';
import type { LifeState } from '../lib/motion';
import { useCollapsibleOverflow } from '../lib/collapsibleOverflow';
import { useLayoutPreferences, usePaneResize } from '../lib/layoutHooks';
import { pushToast } from '../lib/toasts';
import { VirtualAgentTreeView } from './AgentTreeView';
import { AgentPanelContainer } from './AgentPanelContainer';
import { InspectorNeedsYou, InspectorNowLine, InspectorRecent, pendingBlocks } from './agent-panel/InspectorNow';
import { Icon } from './icons';
import { LifeMark } from './LifeMark';
import { INSPECTOR_LINK, InspectorRow, InspectorSection } from './agent-panel/InspectorSection';
import { ConfirmDialog } from './ConfirmDialog';
import { CRON_TASKS_QUERY_KEY } from './GlobalCronPanel';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from './Dialog';
import { useInspectorPeek } from './inspectorFocus';
import { RelativeTime } from './RelativeTime';
import { TaskDetailModal } from './TaskDetailModal';

/** Additional context for the selected subagent in the shared rail. */
export interface SubagentRailContext {
  readonly agentId: string;
  /** The subagent's own timeline card data from the parent transcript. */
  readonly block: SubagentBlock | undefined;
  /** Pending approvals + questions waiting on this subagent. */
  readonly pendingInteractionCount: number;
  /** Jump back to the parent timeline and locate the spawning card. */
  readonly onJumpToSpawn: (() => void) | undefined;
}

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
  count,
  actions,
  summary,
  defaultOpen,
  children,
  ...data
}: {
  title: string;
  count?: number;
  actions?: React.ReactNode;
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  return (
    <InspectorSection title={title} count={count} actions={actions} summary={summary} defaultOpen={defaultOpen} {...data}>
      {children}
    </InspectorSection>
  );
}

function taskStatusTone(status: Task['status']): string {
  switch (status) {
    case 'running':
      return 'text-ink-soft';
    case 'completed':
      return 'text-success';
    case 'failed':
      return 'text-danger';
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
          <li key={task.id} data-rail-item className="-mx-2 rounded-lg px-2 py-1 transition-colors hover:bg-ink/[0.04]">
            <div className="flex min-h-7 items-center gap-2">
              <button
                type="button"
                data-task-open={task.id}
                title={t('rail.viewDetails')}
                onClick={() => { onOpenTask(task); }}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
              >
                <span className={`flex shrink-0 items-center gap-1 text-[12px] ${taskStatusTone(task.status)}`}>
                  {task.status === 'running' ? <span aria-hidden className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-soft" /> : null}
                  {t(`rail.taskStatus.${task.status}`)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                  {task.description}
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
                  className="h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                >
                  {t('rail.stop')}
                </button>
              ) : null}
            </div>
            {task.command !== undefined ? (
              <p className="truncate font-mono text-[12px] text-ink-faint">{task.command}</p>
            ) : null}
            {task.output_preview !== undefined && task.output_preview !== '' ? (
              <p className="mt-0.5 line-clamp-2 font-mono text-[12px] break-all text-ink-faint">
                {task.output_preview}
              </p>
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
              className={INSPECTOR_LINK}
            >
              {t('tasks.viewAll')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const SubagentsSection = memo(function SubagentsSection({
  forest,
  selectedAgentId,
  peekAgentId,
  onOpen,
  onViewAll,
}: {
  forest: AgentForest;
  selectedAgentId?: string;
  /** Hover preview: marks that agent's row without retargeting the rail. */
  peekAgentId?: string;
  onOpen: (agentId: string) => void;
  /** Opens the full-tree dialog (the rail list clamps at max-h-80). */
  onViewAll: () => void;
}) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Peek is a presentation-only mark on the one matching row (index.css
  // styles `[data-agent-peek]`), applied outside React so hover churn never
  // re-renders the tree.
  useEffect(() => {
    const root = scrollRef.current;
    if (root === null || peekAgentId === undefined || peekAgentId === selectedAgentId) return;
    const row = root.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(peekAgentId)}"]`);
    if (row === null) return;
    row.dataset['agentPeek'] = '';
    return () => { delete row.dataset['agentPeek']; };
  }, [peekAgentId, selectedAgentId, forest]);
  return (
    <div>
      <div ref={scrollRef} data-subagent-scroll className="max-h-80 overflow-y-auto pr-1">
        <VirtualAgentTreeView forest={forest} selectedAgentId={selectedAgentId} onOpen={onOpen} scrollRef={scrollRef} />
      </div>
      <button
        type="button"
        data-subagents-view-all
        onClick={onViewAll}
        className={`${INSPECTOR_LINK} mt-1`}
      >
        {t('tasks.viewAll')}
      </button>
    </div>
  );
});

function subagentStatusChipClass(status: string): string {
  switch (status) {
    case 'running':
    case 'background':
      return 'bg-panel text-ink-soft';
    case 'suspended':
      return 'bg-amber-card text-amber-ink';
    // A settled subagent is neutral: success tone is only for "just finished,
    // you should know", which the inbox and the row dots already carry.
    case 'completed':
      return 'bg-ink/[0.05] text-ink-soft';
    case 'failed':
      return 'bg-danger/10 text-danger';
    default:
      return 'bg-panel text-ink-faint';
  }
}

/**
 * Clamped rail prose (task description / result summary): three lines by
 * default with an on-demand show more/less toggle when content overflows.
 */
function ClampText({ text, className }: { text: string; className: string }) {
  const { t } = useI18n();
  const { contentRef, contentId, isOverflowing, expanded, toggle } =
    useCollapsibleOverflow<HTMLParagraphElement>(text);
  return (
    <div>
      <p
        ref={contentRef}
        id={contentId}
        className={`${className} ${expanded ? '' : 'line-clamp-3'}`}
      >
        {text}
      </p>
      {isOverflowing || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={toggle}
          className="mt-0.5 text-[12px] text-ink-faint transition-colors hover:text-ink"
        >
          {expanded ? t('transcript.showLess') : t('transcript.showMore')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Subagent task chapter: status chip (+ Needs-input badge), the owning task's
 * description and result summary, and the run's own elapsed / tools / tokens
 * rows — everything the main-agent rail cannot answer for a child.
 */
const SubagentTaskSection = memo(function SubagentTaskSection({
  forest,
  context,
}: {
  forest: AgentForest;
  context: SubagentRailContext;
}) {
  const { t } = useI18n();
  const node: AgentTreeNode | undefined = forest.byId[context.agentId];
  const block = context.block;
  // The timeline card carries the task-entity terminal status; the tree node
  // can lag at 'unknown' on cold open — prefer a known card status.
  const status =
    block !== undefined && block.status !== 'unknown'
      ? block.status
      : (node?.status ?? block?.status ?? 'unknown');
  const error = block?.error ?? node?.error;
  const description = block?.description ?? block?.instruction ?? node?.description;
  const isFailed = status === 'failed';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          data-agent-status={status}
          className={`rounded-sm px-1.5 py-px text-[12px] font-medium ${subagentStatusChipClass(status)}`}
        >
          {t(`subagent.status.${status}` as I18nKey)}
        </span>
        {context.pendingInteractionCount > 0 ? (
          <span
            data-needs-input
            className="px-0.5 text-[12px] font-medium text-accent-ink"
          >
            {t('rail.needsInput')} · {context.pendingInteractionCount}
          </span>
        ) : null}
      </div>
      {isFailed && error !== undefined ? (
        <div className="border-l-2 border-danger pl-2.5">
          <ClampText text={error} className="font-mono text-[12px] leading-snug text-danger" />
        </div>
      ) : null}
      {description !== undefined ? (
        <div className="mt-2">
          <ClampText
            text={description}
            className={`text-[13px] leading-relaxed ${isFailed && error !== undefined ? 'text-ink-soft' : 'text-ink'}`}
          />
        </div>
      ) : null}
    </div>
  );
});

/**
 * Heading life state for an agent status, on the shared motion language
 * (`LifeMark`): a running agent breathes (the heading is this panel's one
 * aggregate mark), one waiting on a human beckons, a just-finished one
 * settles once when it lands, idle draws nothing.
 */
function subagentLife(status: string): LifeState {
  switch (status) {
    case 'running':
    case 'background':
      return 'working';
    case 'suspended':
      return 'waiting';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

/**
 * Inspector heading — the first row of the panel. Names who the panel is
 * describing (serif name, status dot) with a one-step way back to main when a
 * subagent is in focus, and the close action. The "now" line sits beneath.
 */
function RailOwnerBadge({
  subagent,
  forest,
  onClose,
  onInspectMain,
  onOpenSubagent,
}: {
  subagent: SubagentRailContext | undefined;
  forest: AgentForest;
  onClose?: () => void;
  onInspectMain?: () => void;
  onOpenSubagent?: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const node = subagent === undefined ? undefined : forest.byId[subagent.agentId];
  const closeButton = onClose === undefined ? null : (
    <button type="button" onClick={onClose} data-rail-close
      title={t('sv.hidePanel')} aria-label={t('sv.hidePanel')}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[17px] text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent lg:h-7 lg:w-7">
      <Icon name="close" size={16} />
    </button>
  );
  const isSub = subagent !== undefined;
  const status = isSub ? (node?.status ?? subagent.block?.status ?? 'unknown') : undefined;
  const name = isSub ? (node?.label ?? subagent.block?.name ?? subagent.agentId) : t('rail.ownerMain');
  // Ancestry step. Main is already the leftmost crumb, so a deeper agent gets
  // one more crumb for its spawning parent: the tree below can clamp or
  // virtualize that row out of view, and this keeps the way up always visible.
  const parentId = isSub ? (node?.parentAgentId ?? subagent.block?.parentAgentId) : undefined;
  const parentLabel =
    parentId === undefined || parentId === MAIN_AGENT_ID
      ? undefined
      : (forest.byId[parentId]?.label ?? parentId);
  const jumpToParent =
    subagent?.onJumpToSpawn ??
    (parentId === undefined ? undefined : () => { onOpenSubagent?.(parentId); });
  return (
    <div
      data-rail-owner
      data-rail-owner-name={isSub ? name : undefined}
      className="sticky top-0 z-10 -mx-4 flex h-12 items-center gap-2 bg-panel px-4"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {isSub && onInspectMain !== undefined ? (
          <>
            <button
              type="button"
              data-inspect-main
              onClick={onInspectMain}
              title={t('inspector.backToMainAria')}
              aria-label={t('inspector.backToMainAria')}
              className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 -ml-1.5 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
            >
              <Icon name="arrowRight" size={12} className="rotate-180" />
              {t('inspector.backToMain')}
            </button>
            <span aria-hidden className="text-[12px] text-hairline-strong">/</span>
          </>
        ) : null}
        {parentLabel !== undefined && jumpToParent !== undefined ? (
          <>
            <button
              type="button"
              data-inspect-parent
              onClick={jumpToParent}
              title={t('subagent.openAgent', { name: parentLabel })}
              aria-label={t('subagent.openAgent', { name: parentLabel })}
              className="flex h-7 min-w-0 max-w-[7.5rem] shrink items-center rounded-md px-1.5 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
            >
              <span className="truncate">{parentLabel}</span>
            </button>
            <span aria-hidden className="text-[12px] text-hairline-strong">/</span>
          </>
        ) : null}
        {status !== undefined ? (
          <LifeMark
            markId={`rail:${subagent?.agentId ?? MAIN_AGENT_ID}`}
            life={subagentLife(status)}
            className="h-1.5 w-1.5"
          />
        ) : null}
        <p className="min-w-0 truncate font-display text-[15px] font-semibold tracking-tight text-ink" title={name}>
          <span className="sr-only">{t('inspector.viewing')}: </span>
          {name}
        </p>
      </div>
      {closeButton}
    </div>
  );
}

/**
 * Quiet links to the workspace-wide pages, pre-filtered to this session's
 * workspace. The scheduled-task count reads the cron list only when it is
 * already cached (the /cron page or nav badge loaded it) — the inspector
 * never fetches it just to decorate a link.
 */
function WorkspaceLinks({ workspaceId }: { workspaceId: string }) {
  const { t, tp } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const cached = queryClient.getQueryData<InfiniteData<ListCronTasksResponse, number>>(CRON_TASKS_QUERY_KEY);
  const cronHere = cached?.pages.flatMap((page) => page.items).filter((task) => task.workspace_id === workspaceId).length;
  const scope = `?workspace=${encodeURIComponent(workspaceId)}`;
  const link = 'group -mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 text-left text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent';
  return (
    <div data-rail-workspace-links className="pt-1">
      <p className="flex h-7 items-center text-[12px] text-ink-faint">{t('inspector.elsewhere')}</p>
      <button type="button" data-session-task-board onClick={() => { void navigate(`/board${scope}`); }} className={link}>
        <span className="min-w-0 flex-1 truncate">{t('inspector.boardLink')}</span>
        <Icon name="arrowRight" size={12} className="text-ink-faint transition-transform group-hover:translate-x-0.5" />
      </button>
      <button type="button" data-session-cron-panel onClick={() => { void navigate(`/cron${scope}`); }} className={link}>
        <span className="min-w-0 flex-1 truncate">{t('inspector.cronLink')}</span>
        {cronHere !== undefined && cronHere > 0 ? (
          <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">{tp('inspector.cronSummary', cronHere)}</span>
        ) : null}
        <Icon name="arrowRight" size={12} className="text-ink-faint transition-transform group-hover:translate-x-0.5" />
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

/**
 * Reserved inspector chapter for session memory (entries this session read or
 * wrote). The rail renders whatever the caller passes; with nothing passed
 * the slot stays empty and takes no space.
 */
export interface InspectorMemorySlot {
  readonly title: string;
  readonly count?: number;
  readonly content: React.ReactNode;
}

export function RightRail({
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
  onOpenFile,
  memory,
  onClose,
  className,
}: {
  state: SessionViewState;
  forest: AgentForest;
  selectedAgentId?: string;
  subagent?: SubagentRailContext;
  taskOwnerAgentId?: string;
  onClose?: () => void;
  onCancelTask: (taskId: string, ownerAgentId?: string) => void;
  /**
   * Stops one running subagent task through its owning agent's scope
   * (`ownerAgentId` = the agent the task is registered under). When absent
   * the bulk-terminate affordance stays hidden.
   */
  onStopAgentTask?: (ownerAgentId: string, taskId: string) => Promise<void>;
  onOpenSubagent: (agentId: string) => void;
  /** Heading's "← Main agent" — hand the inspector back to main. */
  onInspectMain?: () => void;
  /** Needs-you Review: focus the item where it is answered. */
  onReviewPending?: (kind: 'approval' | 'question', id: string) => void;
  /** Recent-activity file rows open the file in the preview workspace. */
  onOpenFile?: (path: string) => void;
  /** Reserved memory chapter (see InspectorMemorySlot). */
  memory?: InspectorMemorySlot;
  className?: string;
}) {
  const { t } = useI18n();
  const session = state.session;
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [subagentsAllOpen, setSubagentsAllOpen] = useState(false);
  const allAgentsScrollRef = useRef<HTMLDivElement>(null);
  const [terminateSnapshot, setTerminateSnapshot] = useState<readonly Task[] | null>(null);
  const [terminatingAll, setTerminatingAll] = useState(false);
  const panelSlot = useLazyPanelSlot();
  const peekAgentId = useInspectorPeek();
  const focusedAgentId = selectedAgentId ?? MAIN_AGENT_ID;
  const focusedNode = forest.byId[focusedAgentId];
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
  const pending = useMemo(() => pendingBlocks(state.blocks), [state.blocks]);
  // Empty sections collapse entirely (header included) in either rail context.
  const showSubagents =
    Object.keys(forest.byId).some((id) => id !== MAIN_AGENT_ID) ||
    forest.roots.some((root) => root.agentId !== MAIN_AGENT_ID);
  const showTasks = backgroundTasks.length > 0;
  const showTerminateAll = onStopAgentTask !== undefined && runningSubagentTasks.length > 0;
  const busy = subagent !== undefined ? (focusedNode?.busy === true || state.busy) : state.busy;
  const setupSummary = [state.model ?? focusedNode?.model, state.thinkingEffort ?? focusedNode?.thinkingEffort]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
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
  const { startResize, reset } = usePaneResize({
    value: railWidthValue,
    min: RAIL_MIN_WIDTH,
    max: RAIL_MAX_WIDTH,
    direction: -1,
    onChange: (value, final) => {
      setRailWidthValue(value);
      if (final) writeLayoutPreferences({ railWidth: value });
    },
    onReset: () => {
      setRailWidthValue(RAIL_DEFAULT_WIDTH);
      writeLayoutPreferences({ railWidth: RAIL_DEFAULT_WIDTH });
    },
  });


  const agentPanelKey = `${state.sessionId}:${focusedAgentId}`;
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
        style={{ '--kiki-rail-width': `${railWidthValue}px`, overflow: 'hidden', display: 'flex', flexDirection: 'column' } as React.CSSProperties}
        data-session-rail
        data-inspector-agent={focusedAgentId}
      >
      <div data-agent-panel-scroll className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6">
      <RailOwnerBadge subagent={subagent} forest={forest} onClose={onClose} onInspectMain={onInspectMain} onOpenSubagent={onOpenSubagent} />
      <div className="-mt-3">
        <InspectorNowLine blocks={state.blocks} busy={busy} pendingCount={Math.max(pending.length, subagent?.pendingInteractionCount ?? 0)} />
      </div>

      <InspectorNeedsYou items={pending} onReview={onReviewPending} />

      {subagent !== undefined ? (
        <section data-subagent-context className="space-y-5">
          <RailSection title={t('rail.agentTask')}>
            <SubagentTaskSection forest={forest} context={subagent} />
          </RailSection>
        </section>
      ) : null}

      <AgentPanelContainer key={`work:${agentPanelKey}`} state={state} forest={forest} agentId={focusedAgentId} part="work" />

      {showSubagents ? (
        <RailSection
          title={t('rail.subagents')}
          count={Object.keys(forest.byId).filter((id) => id !== MAIN_AGENT_ID).length}
          actions={
            showTerminateAll ? (
              <button
                type="button"
                data-terminate-all-subagents
                onClick={() => { setTerminateSnapshot(runningSubagentTasks); }}
                className="h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
              >
                {t('rail.terminateAll')}
              </button>
            ) : undefined
          }
        >
          <SubagentsSection
            forest={forest}
            selectedAgentId={selectedAgentId}
            peekAgentId={peekAgentId}
            onOpen={onOpenSubagent}
            onViewAll={() => { setSubagentsAllOpen(true); }}
          />
        </RailSection>
      ) : null}

      {showTasks ? (
        <RailSection title={t('rail.tasks')} count={backgroundTasks.length}>
          <TasksSection
            tasks={backgroundTasks}
            sessionId={session?.id}
            ownerAgentId={taskOwnerAgentId}
            onCancel={onCancelTask}
            onOpenTask={setDetailTask}
          />
        </RailSection>
      ) : null}

      <InspectorRecent blocks={state.blocks} onOpenFile={onOpenFile} />

      {/* Context + known usage. The slot collapses to nothing (no heading,
          no gap) until the read returns something worth showing. */}
      <div ref={panelSlot.slotRef} data-rail-agent-panel-slot className="min-h-px [&:not(:has(section))]:-mt-5">
        {panelSlot.mounted ? (
          <AgentPanelContainer key={`usage:${agentPanelKey}`} state={state} forest={forest} agentId={focusedAgentId} visible={panelSlot.visible} part="usage" />
        ) : null}
      </div>

      {memory !== undefined ? (
        <RailSection title={memory.title} count={memory.count} data-inspector-memory="">
          {memory.content}
        </RailSection>
      ) : null}

      {/* Collapsed by default; its capability read starts only once opened. */}
      <RailSection title={t('inspector.agentSetup')} summary={setupSummary || undefined} defaultOpen={false} data-inspector-setup="">
        <AgentPanelContainer key={`setup:${agentPanelKey}`} state={state} forest={forest} agentId={focusedAgentId} part="setup" />
      </RailSection>

      {session !== undefined ? (
        <RailSection
          title={t('inspector.sessionInfo')}
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

      {session !== undefined ? <WorkspaceLinks workspaceId={session.workspace_id} /> : null}
      </div>

      {detailTask !== null && session !== undefined ? (
        <TaskDetailModal
          sessionId={session.id}
          ownerAgentId={taskOwnerAgentId}
          task={detailTask}
          onClose={() => { setDetailTask(null); }}
          onCancelTask={onCancelTask}
        />
      ) : null}

      {subagentsAllOpen ? (
        <Dialog
          onClose={() => { setSubagentsAllOpen(false); }}
          ariaLabel={t('rail.subagents')}
          overlayId="subagents-all"
          panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} flex max-h-[80vh] flex-col`}
        >
          <h3 className="shrink-0 font-display text-[17px] font-semibold text-ink">
            {t('rail.subagents')}
          </h3>
          <div ref={allAgentsScrollRef} data-subagents-all-scroll className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
            <VirtualAgentTreeView
              forest={forest}
              scrollRef={allAgentsScrollRef}
              viewportHeight={640}
              selectedAgentId={selectedAgentId}
              onOpen={(agentId) => {
                setSubagentsAllOpen(false);
                onOpenSubagent(agentId);
              }}
            />
          </div>
        </Dialog>
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
