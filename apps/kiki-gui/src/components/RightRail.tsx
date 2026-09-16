/**
 * Right rail (collapsible) — todos checklist, background tasks with terminate,
 * and session meta (model, cwd, message count, context/token usage).
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { Task } from '@kiki/protocol';

import type { I18nKey } from '@kiki/session-core/i18n';
import {
  agentChildren,
  agentSiblings,
  compareAgentIds,
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
import { useCollapsibleOverflow } from '../lib/collapsibleOverflow';
import { useLayoutPreferences, usePaneResize } from '../lib/layoutHooks';
import { AgentSubtreeView, AgentTreeView } from './AgentTreeView';
import { AgentPanelContainer } from './AgentPanelContainer';
import { useNow } from './RelativeTime';

/** Differentiated subagent-page rail context (G-3). */
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
 * Counts rows (tagged `data-rail-item`) that sit fully below the scroll
 * container's visible bottom edge. Re-runs every render (the lists are small)
 * plus on scroll and resize, so the "N more below" hint tracks the viewport.
 */
function useHiddenBelow(ref: React.RefObject<HTMLDivElement | null>): number {
  const [hidden, setHidden] = useState(0);
  useLayoutEffect(() => {
    const container = ref.current;
    if (container === null) return;
    const update = () => {
      const bottom = container.getBoundingClientRect().bottom;
      let count = 0;
      for (const item of container.querySelectorAll('[data-rail-item]')) {
        if (item.getBoundingClientRect().top > bottom + 1) count += 1;
      }
      setHidden(count);
    };
    update();
    // jsdom (component tests) has no ResizeObserver; scroll still covered.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(container);
    container.addEventListener('scroll', update, { passive: true });
    return () => {
      observer?.disconnect();
      container.removeEventListener('scroll', update);
    };
  });
  return hidden;
}

/** Sticky "N more below" hint pinned to the bottom of a rail scroll container. */
function OverflowHint({ count }: { count: number }) {
  const { t } = useI18n();
  if (count === 0) return null;
  return (
    <p data-rail-overflow className="pt-1.5 pb-0.5 text-[10.5px] text-ink-faint">
      {t('rail.moreBelow', { count })}
    </p>
  );
}

/**
 * Collapsible rail chapter — button + useState + aria-expanded + rotating
 * chevron (the repo's collapse idiom). Starts expanded.
 */
function RailSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { setOpen((value) => !value); }}
        className="mb-2 flex w-full items-center gap-1.5 text-left"
      >
        <span
          aria-hidden
          className={`inline-block shrink-0 text-[8px] text-ink-faint transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        >
          ▶
        </span>
        <span className="text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
          {title}
        </span>
      </button>
      {open ? children : null}
    </section>
  );
}

function taskStatusTone(status: Task['status']): string {
  switch (status) {
    case 'running':
      return 'bg-accent-soft text-accent';
    case 'completed':
      return 'bg-success/10 text-success';
    case 'failed':
      return 'bg-danger/10 text-danger';
    case 'cancelled':
      return 'bg-paper text-ink-soft';
  }
}

const TasksSection = memo(function TasksSection({
  tasks,
  sessionId,
  onCancel,
}: {
  tasks: readonly Task[];
  sessionId?: string;
  onCancel: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const hiddenBelow = useHiddenBelow(scrollRef);
  // Running work first, then newest-created — same order as the tasks page.
  const sorted = useMemo(() => sortTasks(tasks), [tasks]);
  if (sorted.length === 0) {
    return <p className="text-[12px] text-ink-faint">{t('rail.noTasks')}</p>;
  }
  return (
    <div ref={scrollRef} data-tasks-scroll className="max-h-80 overflow-y-auto pr-1">
      <ul className="space-y-1.5">
        {sorted.map((task) => (
          <li key={task.id} data-rail-item className="rounded-lg border border-hairline bg-panel px-2.5 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className={`rounded-full px-1.5 py-px text-[10px] font-medium ${taskStatusTone(task.status)}`}>
                {t(`rail.taskStatus.${task.status}`)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
                {task.description}
              </span>
              {task.status === 'running' ? (
                <button
                  type="button"
                  onClick={() => { onCancel(task.id); }}
                  title={t('rail.stopTitle')}
                  className="shrink-0 rounded-md border border-hairline px-1.5 py-0.5 text-[10px] text-ink-soft transition-colors hover:border-danger hover:text-danger"
                >
                  {t('rail.stop')}
                </button>
              ) : null}
            </div>
            {task.command !== undefined ? (
              <p className="mt-1 truncate font-mono text-[10.5px] text-ink-faint">{task.command}</p>
            ) : null}
            {task.output_preview !== undefined && task.output_preview !== '' ? (
              <p className="mt-1 line-clamp-2 font-mono text-[10.5px] break-all text-ink-faint">
                {task.output_preview}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {sessionId !== undefined || hiddenBelow > 0 ? (
        <div className="sticky bottom-0 bg-panel pt-1.5 pb-0.5">
          <OverflowHint count={hiddenBelow} />
          {sessionId !== undefined ? (
            <button
              type="button"
              onClick={() => void navigate(`/s/${sessionId}/tasks`)}
              className="text-[10.5px] font-medium text-accent transition-colors hover:text-accent-deep"
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
  onOpen,
}: {
  forest: AgentForest;
  selectedAgentId?: string;
  onOpen: (agentId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hiddenBelow = useHiddenBelow(scrollRef);
  return (
    <div ref={scrollRef} data-subagent-scroll className="max-h-80 overflow-y-auto pr-1">
      <AgentTreeView forest={forest} selectedAgentId={selectedAgentId} onOpen={onOpen} />
      <div className="sticky bottom-0 bg-panel">
        <OverflowHint count={hiddenBelow} />
      </div>
    </div>
  );
});

function subagentStatusChipClass(status: string): string {
  switch (status) {
    case 'running':
    case 'background':
      return 'bg-accent-soft text-accent';
    case 'suspended':
      return 'bg-amber-card text-amber-ink';
    case 'completed':
      return 'bg-success/10 text-success';
    case 'failed':
      return 'bg-danger/10 text-danger';
    default:
      return 'bg-paper text-ink-soft';
  }
}

function railTimelineMs(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
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
          className="mt-0.5 text-[10.5px] text-ink-faint transition-colors hover:text-accent"
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
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${subagentStatusChipClass(status)}`}
        >
          {t(`subagent.status.${status}` as I18nKey)}
        </span>
        {context.pendingInteractionCount > 0 ? (
          <span
            data-needs-input
            className="rounded-full bg-amber-card px-2 py-0.5 text-[10px] font-semibold text-amber-ink"
          >
            {t('rail.needsInput')} · {context.pendingInteractionCount}
          </span>
        ) : null}
      </div>
      {isFailed && error !== undefined ? (
        <div className="mt-2 rounded-lg border border-danger/30 bg-danger/5 p-2.5">
          <ClampText text={error} className="font-mono text-[11.5px] leading-snug text-danger" />
        </div>
      ) : null}
      {description !== undefined ? (
        <div className="mt-2">
          <ClampText
            text={description}
            className={`text-[12px] leading-snug ${isFailed && error !== undefined ? 'text-ink-soft' : 'text-ink'}`}
          />
        </div>
      ) : null}
    </div>
  );
});

/**
 * Subagent navigation chapter: Parent jump-back (locates the spawning card in
 * the parent timeline), chronological Prev/Next sibling steppers, and direct
 * child shortcuts.
 */
const SubagentNavSection = memo(function SubagentNavSection({
  forest,
  context,
  onOpenSubagent,
}: {
  forest: AgentForest;
  context: SubagentRailContext;
  onOpenSubagent: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const node = forest.byId[context.agentId];
  const parentId = node?.parentAgentId ?? context.block?.parentAgentId;
  const parent = parentId === undefined ? undefined : forest.byId[parentId];
  const ordered = useMemo(() => {
    const self = forest.byId[context.agentId];
    const all = [...agentSiblings(forest, context.agentId), ...(self === undefined ? [] : [self])];
    return all.sort((left, right) => {
      const leftMs = railTimelineMs(left.startedAt);
      const rightMs = railTimelineMs(right.startedAt);
      if (leftMs !== undefined && rightMs !== undefined && leftMs !== rightMs) return leftMs - rightMs;
      if (leftMs !== undefined) return -1;
      if (rightMs !== undefined) return 1;
      return compareAgentIds(left.agentId, right.agentId);
    });
  }, [forest, context.agentId]);
  const index = ordered.findIndex((entry) => entry.agentId === context.agentId);
  const prev = index > 0 ? ordered[index - 1] : undefined;
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : undefined;
  const children = agentChildren(forest, context.agentId);
  return (
    <div className="space-y-1.5">
      {parentId !== undefined && context.onJumpToSpawn !== undefined ? (
        <button
          type="button"
          data-jump-to-spawn
          onClick={context.onJumpToSpawn}
          title={t('rail.parentJumpTitle')}
          className="flex w-full items-center gap-1.5 rounded-lg border border-hairline bg-panel px-2.5 py-1.5 text-left text-[11.5px] text-ink-soft transition-colors hover:border-accent hover:text-accent"
        >
          <span aria-hidden className="shrink-0 text-[10px]">↩</span>
          <span className="shrink-0 font-medium">{t('rail.parent')}:</span>
          <span className="min-w-0 truncate">
            {parentId === MAIN_AGENT_ID ? t('sv.sessionCrumb') : (parent?.label ?? parentId)}
          </span>
        </button>
      ) : null}
      {ordered.length > 1 ? (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-sibling-prev
            disabled={prev === undefined}
            title={prev?.label}
            onClick={() => { if (prev !== undefined) onOpenSubagent(prev.agentId); }}
            className="min-w-0 flex-1 truncate rounded-lg border border-hairline bg-panel px-2.5 py-1.5 text-left text-[11px] text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-40 disabled:hover:border-hairline disabled:hover:text-ink-soft"
          >
            ← {prev?.label ?? t('rail.prevSibling')}
          </button>
          <button
            type="button"
            data-sibling-next
            disabled={next === undefined}
            title={next?.label}
            onClick={() => { if (next !== undefined) onOpenSubagent(next.agentId); }}
            className="min-w-0 flex-1 truncate rounded-lg border border-hairline bg-panel px-2.5 py-1.5 text-right text-[11px] text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-40 disabled:hover:border-hairline disabled:hover:text-ink-soft"
          >
            {next?.label ?? t('rail.nextSibling')} →
          </button>
        </div>
      ) : null}
      {children.length > 0 ? (
        <div data-agent-children-nav>
          <AgentSubtreeView
            forest={forest}
            agentId={context.agentId}
            onOpen={onOpenSubagent}
          />
        </div>
      ) : null}
    </div>
  );
});

function MetaRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-[11px] text-ink-faint">{label}</span>
      <span
        className={`min-w-0 truncate text-[11.5px] text-ink ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

export function RightRail({
  state,
  forest,
  selectedAgentId,
  subagent,
  onCancelTask,
  onOpenSubagent,
  className,
}: {
  state: SessionViewState;
  forest: AgentForest;
  selectedAgentId?: string;
  subagent?: SubagentRailContext;
  onCancelTask: (taskId: string) => void;
  onOpenSubagent: (agentId: string) => void;
  className?: string;
}) {
  const { t, time } = useI18n();
  useNow();
  const session = state.session;
  const backgroundTasks = useMemo(
    () => state.tasks.filter((task) => task.kind !== 'subagent' && task.status === 'running'),
    [state.tasks],
  );
  // Empty sections collapse entirely (header included). In subagent mode the
  // task and navigation chapters lead; the child shortcuts live in navigation.
  const showSubagents =
    subagent === undefined &&
    (Object.keys(forest.byId).some((id) => id !== 'main') ||
      forest.roots.some((root) => root.agentId !== 'main'));
  const showTasks = backgroundTasks.length > 0;

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

  return (
    <aside
      className={
        className ?? 'app-rail'
      }
      style={{ '--kiki-rail-width': `${railWidthValue}px`, overflow: 'hidden', display: 'flex', flexDirection: 'column' } as React.CSSProperties}
      data-session-rail
    >
      <div
        data-rail-resizer
        className="app-rail__resizer hidden lg:block"
        aria-hidden
        title={t('rail.resizeAria')}
        onPointerDown={startResize}
        onDoubleClick={reset}
      />
      <div data-agent-panel-scroll className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-4">
      {subagent !== undefined ? (
        <>
          <RailSection title={t('rail.agentTask')}>
            <SubagentTaskSection forest={forest} context={subagent} />
          </RailSection>
          <RailSection title={t('rail.agentNav')}>
            <SubagentNavSection forest={forest} context={subagent} onOpenSubagent={onOpenSubagent} />
          </RailSection>
        </>
      ) : null}

      {showSubagents ? (
        <RailSection title={t('rail.subagents')}>
          <SubagentsSection forest={forest} selectedAgentId={selectedAgentId} onOpen={onOpenSubagent} />
        </RailSection>
      ) : null}

      {showTasks ? (
        <RailSection title={t('rail.tasks')}>
          <TasksSection tasks={backgroundTasks} sessionId={session?.id} onCancel={onCancelTask} />
        </RailSection>
      ) : null}

      <AgentPanelContainer key={`${state.sessionId}:${selectedAgentId ?? MAIN_AGENT_ID}`}
        state={state} forest={forest} agentId={selectedAgentId ?? MAIN_AGENT_ID} />

      <RailSection title={t('rail.session')}>
        <div className="space-y-1.5">
          {session !== undefined ? <>
            <MetaRow label={t('rail.directory')} value={session.metadata.cwd} mono />
            <MetaRow label={t('rail.messages')} value={String(session.message_count)} />
            <MetaRow label={t('rail.updatedRow')} value={time.relativeTime(session.updated_at)} />
          </> : null}
        </div>
      </RailSection>
      </div>
    </aside>
  );
}
