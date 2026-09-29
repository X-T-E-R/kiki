/**
 * The default rail (prototype): the current inspector, reordered for the
 * first screen of a coordinator. Top to bottom:
 *
 *   head       who this page is about, the mode switch, close
 *   等你处理    decision stack (first as a card, the rest one line each)
 *   现在        what the agent is doing, with the todo pointer under it
 *   上下文·费用  context meter, cost, tokens, cache (the resident overview)
 *   智能体      the team roster
 *   待办        the full checklist and notes
 *   profile    folded to one line
 *   动态        activity stream, folded
 *   能力        tools / skills / subagents / extensions, folded
 *   后台任务 · 会话信息
 *
 * Every part except the decision stack, the todo pointer, the activity
 * stream and the capability block is the current rail's own component.
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
import { AgentPanelContainer } from '../AgentPanelContainer';
import { AgentRoster, RAIL_MARK, RailCrumbs } from '../agent-panel/InspectorAgents';
import { InspectorNow, NowAction, pendingBlocks } from '../agent-panel/InspectorNow';
import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { INSPECTOR_LINK, InspectorRow, InspectorSection } from '../agent-panel/InspectorSection';
import { ConfirmDialog } from '../ConfirmDialog';
import { useInspectorPeek } from '../inspectorFocus';
import { RelativeTime } from '../RelativeTime';
import { TaskDetailModal } from '../TaskDetailModal';
import type { ModeProps } from './shell';
import { ModeSwitch } from './shell';
import { ActivityFeed, CapabilitiesBlock, NeedsYouList, TodoPointer } from './DefaultSections';
import { TONES, useRailVariant } from './tone';
import { VariantSwitch } from './VariantSwitch';

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
              className="flex min-w-0 flex-1 cursor-pointer items-start rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
                className="rail-task-stop flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-ink-soft transition-[color,background-color,opacity] hover:bg-danger/10 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
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

export function DefaultRail({
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
  mode,
  onChooseMode,
}: ModeProps) {
  const { t } = useI18n();
  const [variant, chooseVariant] = useRailVariant();
  const tone = TONES[variant];
  const session = state.session;
  const [detailTask, setDetailTask] = useState<Task | null>(null);
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
  const ownPending = useMemo(() => pendingBlocks(state.blocks), [state.blocks]);
  const pending = sessionPending ?? ownPending;
  // Agents waiting on the user: a pending item's origin, plus the focused
  // subagent when its own count says so. Their rows surface first.
  const waitingAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of pending) {
      if (item.originAgentId !== undefined && item.originAgentId !== MAIN_AGENT_ID) ids.add(item.originAgentId);
    }
    if (subagent !== undefined && subagent.pendingInteractionCount > 0) ids.add(subagent.agentId);
    return ids;
  }, [pending, subagent]);
  // Empty sections collapse entirely (header included) in either rail context.
  // Main lists the whole team; a subagent lists the agents it dispatched.
  const rosterCount = useMemo(() => {
    if (focusedAgentId !== MAIN_AGENT_ID) {
      let count = 0;
      const stack = [...(forest.byId[focusedAgentId]?.childIds ?? [])];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        count += 1;
        stack.push(...(forest.byId[id]?.childIds ?? []));
      }
      return count;
    }
    return Object.keys(forest.byId).filter((id) => id !== MAIN_AGENT_ID).length;
  }, [forest, focusedAgentId]);
  const showRoster = rosterCount > 0;
  const showTasks = backgroundTasks.length > 0;
  const showTerminateAll = onStopAgentTask !== undefined && runningSubagentTasks.length > 0;
  const busy = subagent !== undefined ? (focusedNode?.busy === true || state.busy) : state.busy;
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
        ref={railRef}
        onFocus={() => { focusInRail.current = true; }}
        // A removed control blurs with no related target; only a real move
        // out of the rail clears the flag.
        onBlur={(event) => {
          if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget as Node)) focusInRail.current = false;
        }}
      >
      <div data-agent-panel-scroll className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
      <RailCrumbs
        forest={forest}
        focusedAgentId={focusedAgentId}
        onSelect={selectAgent}
        close={(
          <span className="flex shrink-0 items-center gap-1">
            <VariantSwitch variant={variant} onChoose={chooseVariant} />
            <ModeSwitch mode={mode} onChoose={onChooseMode} />
            {onClose === undefined ? null : (
              <button type="button" onClick={onClose} data-rail-close
                title={t('sv.hidePanel')} aria-label={t('sv.hidePanel')}
                className="-mr-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent lg:h-7 lg:w-7">
                <Icon name="close" size={16} />
              </button>
            )}
          </span>
        )}
      />
      {/* One page per agent: switching agents raises the new page into place. */}
      <div key={focusedAgentId} data-rail-variant={variant} className={`rail-page pt-1 ${tone.page}`}>
      {/* 1 · What waits on you, from any depth, oldest first. */}
      {sessionPending !== undefined && sessionPending.length > 0 ? (
        <div className={tone.section}>
          <NeedsYouList
            items={sessionPending}
            forest={forest}
            tone={tone}
            onResolveApproval={onResolveApproval}
            onReview={onReviewPending}
            onInspect={onOpenSubagent}
          />
        </div>
      ) : null}

      {/* 2 · What the agent is doing, and where it is on its own checklist. */}
      <div data-rail-now-block className={tone.section}>
      <InspectorNow
        blocks={state.blocks}
        busy={busy}
        // With the session-wide block above, Now reports the agent's own
        // run; its waiting state comes from the focused agent's own count.
        pending={sessionPending === undefined ? pending : NO_PENDING}
        listPending={sessionPending === undefined}
        onReview={onReviewPending}
        startedAt={runStartedAt}
        subagent={subagent === undefined || subStatus === undefined ? undefined : {
          status: subStatus,
          brief: subBlock?.description ?? subBlock?.instruction ?? focusedNode?.description,
          result: subBlock?.summary ?? focusedNode?.summary,
          error: subBlock?.error ?? focusedNode?.error,
          pendingCount: subagent.pendingInteractionCount,
        }}
        actions={subagent === undefined ? undefined : (
          <div data-subagent-context className="-mt-1 ml-3.5 flex flex-wrap items-center gap-x-4 gap-y-1">
            {/* The routed agent page is already this agent's workspace. */}
            {onInspectMain !== undefined ? (
              <NowAction data-rail-open-agent="" icon="external" label={t('inspector.openAgent')} onClick={() => { onOpenSubagent(subagent.agentId); }} />
            ) : null}
            {subagent.onJumpToSpawn !== undefined ? (
              <NowAction data-rail-locate="" icon="arrowUp" label={t('inspector.locate')} onClick={subagent.onJumpToSpawn} />
            ) : null}
          </div>
        )}
      />
      <TodoPointer todos={state.todos} tone={tone} />
      </div>

      {/* 3 · Context and cost: always read, never folded. Mounts once its
          slot scrolls into view (it starts the capability and
          compaction-point reads). */}
      <div ref={panelSlot.slotRef} data-rail-agent-panel-slot className={`min-h-px ${tone.section} ${tone.overview}`}>
        {panelSlot.mounted ? (
          <AgentPanelContainer key={`overview:${agentPanelKey}`} state={state} forest={forest} agentId={focusedAgentId} visible={panelSlot.visible} part="overview" />
        ) : null}
      </div>

      {/* 4 · The team. */}
      {showRoster ? (
        <div className={tone.section}>
        <RailSection
          title={t('inspector.agents')}
          collapsible={false}
          count={rosterCount}
          data-inspector-agents=""
          actions={
            showTerminateAll && subagent === undefined ? (
              <button
                type="button"
                data-terminate-all-subagents
                onClick={() => { setTerminateSnapshot(runningSubagentTasks); }}
                className="-mr-2 h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
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

      {/* 5 · The full checklist and notes (the pointer above links here). */}
      <div id="rail-todos" className={`scroll-mt-14 empty:hidden ${tone.section}`}>
        <AgentPanelContainer key={`work:${agentPanelKey}`} state={state} forest={forest} agentId={focusedAgentId} part="work" />
      </div>

      {showTasks ? (
        <div className={tone.section}>
        <RailSection title={t('rail.tasks')} collapsible={false} count={backgroundTasks.length}>
          <TasksSection
            tasks={backgroundTasks}
            sessionId={session?.id}
            ownerAgentId={taskOwnerAgentId}
            onCancel={onCancelTask}
            onOpenTask={setDetailTask}
          />
        </RailSection>
        </div>
      ) : null}

      {/* 6 · Reference, folded: who this agent is, what happened, what it can use. */}
      <div data-inspector-tail className={`space-y-1 ${tone.section === '' ? 'border-t border-hairline pt-3' : tone.section}`}>
        <div data-rail-profile-slot className="pb-2">
          <AgentPanelContainer key={`profile:${agentPanelKey}`} state={state} forest={forest} agentId={focusedAgentId} part="profile" />
        </div>
        <ActivityFeed blocks={state.blocks} forest={forest} onOpenFile={onOpenFile} onOpenAgent={onOpenSubagent} />
        <CapabilitiesBlock sessionId={state.sessionId} agentId={focusedAgentId} workspaceId={session?.workspace_id} cwd={session?.metadata.cwd} />
        {memory !== undefined ? (
          <RailSection title={memory.title} count={memory.count} data-inspector-memory="">
            {memory.content}
          </RailSection>
        ) : null}
        {session !== undefined ? (
          <RailSection
            title={t('inspector.sessionInfo')}
            summary={session.metadata.cwd.split(/[\\/]/).filter((part) => part !== '').pop()}
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
          ownerAgentId={taskOwnerAgentId}
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
