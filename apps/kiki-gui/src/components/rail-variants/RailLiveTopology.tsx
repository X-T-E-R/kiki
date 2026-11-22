/**
 * Compact graphical live-topology strip rendered at the top of the `Config` tab.
 *
 * Keeps live execution visible while adjusting session controls so the user
 * never has to flip back and forth just to check running subagents or open
 * conversation branches. Collapses to `null` (0px) when completely idle.
 */

import { memo, useMemo } from 'react';

import type { Task } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import { MAIN_AGENT_ID, type AgentForest, type AgentTreeNode } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import type { CronTask } from '../../lib/client';
import {
  branchLifecycleState,
  isEphemeralBtwNode,
  isSessionBranchNode,
  type BranchLifecycleState,
} from '../agent-panel/InspectorBranches';
import { Icon } from '../icons';
import { age, useNow } from './model';
import { NextFire } from './SessionCronSection';
import { FOCUS_RING, StateMark } from './shell';

const ROW_HEIGHT = 28;
const ROW_GAP = 4;
const ROW_STEP = ROW_HEIGHT + ROW_GAP;
const SVG_WIDTH = 20;

interface TopologyBranchNode {
  readonly kind: 'branch';
  readonly id: string;
  readonly label: string;
  readonly state: BranchLifecycleState;
  readonly priority: number;
  readonly startedAt: number | undefined;
}

interface TopologySubagentNode {
  readonly kind: 'subagent';
  readonly id: string;
  readonly label: string;
  readonly state: 'waiting' | 'running';
  readonly priority: number;
  readonly startedAt: number | undefined;
}

interface TopologyCronNode {
  readonly kind: 'cron';
  readonly id: 'cron';
  readonly label: string;
  readonly count: number;
  readonly nextFireAt: string | null;
  readonly state: 'running';
  readonly priority: number;
  readonly startedAt: number | undefined;
}

type TopologyChildNode = TopologyBranchNode | TopologySubagentNode | TopologyCronNode;

function earliestFireAt(tasks: readonly CronTask[]): string | null {
  let bestIso: string | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const task of tasks) {
    if (task.next_fire_at === null) continue;
    const ms = Date.parse(task.next_fire_at);
    if (Number.isFinite(ms) && ms < bestMs) {
      bestMs = ms;
      bestIso = task.next_fire_at;
    }
  }
  return bestIso;
}

function parseTimestamp(iso: string | undefined): number | undefined {
  if (iso === undefined || iso === '') return undefined;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : undefined;
}

export interface RailLiveTopologyProps {
  readonly busy: boolean;
  readonly turnStartedAt?: number;
  readonly mainLabel: string;
  readonly rootAgentId: string;
  readonly forest: AgentForest;
  readonly openBranches: readonly AgentTreeNode[];
  readonly runningSubagentTasks: readonly Task[];
  readonly activeCronTasks?: readonly CronTask[];
  readonly waitingAgentIds: ReadonlySet<string>;
  readonly pendingCount: number;
  readonly onSwitchToRun: () => void;
  readonly onOpenAgent: (agentId: string) => void;
  readonly onOpenCron?: () => void;
}

export const RailLiveTopology = memo(function RailLiveTopology({
  busy,
  turnStartedAt,
  mainLabel,
  rootAgentId,
  forest,
  openBranches,
  runningSubagentTasks,
  activeCronTasks,
  waitingAgentIds,
  pendingCount,
  onSwitchToRun,
  onOpenAgent,
  onOpenCron,
}: RailLiveTopologyProps) {
  const { t, tp, locale } = useI18n();

  const liveChildren = useMemo<readonly TopologyChildNode[]>(() => {
    const items: TopologyChildNode[] = [];
    const seen = new Set<string>();

    if (rootAgentId === MAIN_AGENT_ID) {
      for (const branch of openBranches) {
        if (seen.has(branch.agentId)) continue;
        seen.add(branch.agentId);
        const state = branchLifecycleState(branch, waitingAgentIds);
        const priority = state === 'waiting' ? 0 : state === 'running' ? 1 : state === 'open' ? 2 : 3;
        items.push({
          kind: 'branch',
          id: branch.agentId,
          label: branch.label,
          state,
          priority,
          startedAt: parseTimestamp(branch.startedAt ?? branch.createdAt),
        });
      }
    }

    const pushSubagent = (id: string, fallbackLabel: string, fallbackStart?: string, forceRunning = false) => {
      if (id === rootAgentId || id === MAIN_AGENT_ID || seen.has(id)) return;
      const node: AgentTreeNode | undefined = forest.byId[id];
      const skipNode = node !== undefined && (Boolean(isSessionBranchNode(node)) || isEphemeralBtwNode(node));
      if (skipNode) return;
      const isWaiting = waitingAgentIds.has(id) || node?.status === 'suspended';
      const isRunning = forceRunning || node?.status === 'running' || node?.status === 'background' || node?.busy === true;
      if (!isWaiting && !isRunning) return;
      seen.add(id);
      items.push({
        kind: 'subagent',
        id,
        label: node?.label ?? fallbackLabel,
        state: isWaiting ? 'waiting' : 'running',
        priority: isWaiting ? 0 : 2,
        startedAt: parseTimestamp(node?.startedAt ?? fallbackStart),
      });
    };

    for (const task of runningSubagentTasks) {
      if (task.agent_id === undefined) continue;
      if (rootAgentId !== MAIN_AGENT_ID) {
        const node = forest.byId[task.agent_id];
        if (node?.parentAgentId !== rootAgentId) continue;
      }
      pushSubagent(task.agent_id, task.description || task.agent_id, task.created_at, true);
    }

    for (const node of Object.values(forest.byId)) {
      if (rootAgentId !== MAIN_AGENT_ID && node.parentAgentId !== rootAgentId) continue;
      pushSubagent(node.agentId, node.label);
    }

    const activeCrons = rootAgentId === MAIN_AGENT_ID
      ? (activeCronTasks ?? []).filter((task) => !task.paused)
      : [];
    if (activeCrons.length > 0) {
      const nextFireAt = earliestFireAt(activeCrons);
      items.push({
        kind: 'cron',
        id: 'cron',
        label: activeCrons.length === 1
          ? activeCrons[0]!.prompt_preview
          : t('rail.topology.cronNode', { count: activeCrons.length }),
        count: activeCrons.length,
        nextFireAt,
        state: 'running',
        priority: 3,
        startedAt: undefined,
      });
    }

    items.sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      if (left.kind !== right.kind) {
        if (left.kind === 'branch') return -1;
        if (right.kind === 'branch') return 1;
        return left.kind === 'subagent' ? -1 : 1;
      }
      return (right.startedAt ?? 0) - (left.startedAt ?? 0);
    });
    return items;
  }, [activeCronTasks, forest.byId, openBranches, rootAgentId, runningSubagentTasks, t, waitingAgentIds]);

  const activeCronCount = rootAgentId === MAIN_AGENT_ID
    ? (activeCronTasks ?? []).filter((task) => !task.paused).length
    : 0;
  const isActive = busy || liveChildren.length > 0 || pendingCount > 0 || activeCronCount > 0;
  const now = useNow(30_000, isActive);

  if (!isActive) return null;

  const renderedRows = Math.max(1, liveChildren.length);
  const svgHeight = renderedRows * ROW_HEIGHT + Math.max(0, renderedRows - 1) * ROW_GAP;
  const rootY = svgHeight / 2;

  const mainElapsed = busy && turnStartedAt !== undefined && Number.isFinite(turnStartedAt)
    ? age(now - turnStartedAt, locale)
    : undefined;

  const branchCount = liveChildren.filter((item) => item.kind === 'branch').length;
  const runningSubagentCount = liveChildren.filter((item) => item.kind === 'subagent' && item.state === 'running').length;
  const summaryParts = [
    pendingCount > 0 ? tp('inspector.waiting', pendingCount) : undefined,
    branchCount > 0 ? `${branchCount} ${t('rail.group.branches')}` : undefined,
    runningSubagentCount > 0 ? `${runningSubagentCount} ${t('inspector.running')}` : undefined,
    activeCronCount > 0 ? t('rail.topology.cronSummary', { count: activeCronCount }) : undefined,
  ].filter((part): part is string => part !== undefined);

  return (
    <section
      data-rail-config-topology=""
      aria-label={t('rail.topology.aria')}
      className="mb-3 border-b border-hairline pb-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium tracking-[0.02em] text-ink-faint">
          {t('rail.topology.title')}
        </span>
        {summaryParts.length > 0 ? (
          <button
            type="button"
            data-topology-summary=""
            onClick={onSwitchToRun}
            className={`truncate rounded text-[11px] text-ink-faint tabular-nums transition-colors hover:text-ink ${FOCUS_RING}`}
          >
            {summaryParts.join(' · ')}
          </button>
        ) : null}
      </div>

      <div className="flex items-center">
        <button
          type="button"
          data-topology-root=""
          title={mainElapsed === undefined ? mainLabel : `${mainLabel} · ${mainElapsed}`}
          onClick={onSwitchToRun}
          className={`inline-flex h-7 max-w-[88px] shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-hairline-strong bg-paper px-2 text-left text-[11.5px] font-medium text-ink transition-colors hover:border-ink-faint hover:bg-canvas ${FOCUS_RING}`}
        >
          <StateMark
            state={pendingCount > 0 ? 'waiting' : busy ? 'running' : 'done'}
            className="h-[7px] w-[7px]"
          />
          <span className="min-w-0 truncate">{mainLabel}</span>
        </button>

        <svg
          aria-hidden
          data-topology-connectors=""
          width={SVG_WIDTH}
          height={svgHeight}
          viewBox={`0 0 ${SVG_WIDTH} ${svgHeight}`}
          className="shrink-0 overflow-visible"
        >
          {liveChildren.length === 0 ? (
            <g className={pendingCount > 0 ? 'text-attention/70' : 'text-hairline-strong'}>
              <path
                d={`M 0 ${rootY} L ${SVG_WIDTH - 1} ${rootY}`}
                stroke="currentColor"
                strokeWidth="1"
                fill="none"
              />
              <circle cx={SVG_WIDTH - 1} cy={rootY} r="1.5" fill="currentColor" />
            </g>
          ) : (
            liveChildren.map((item, index) => {
              const targetY = index * ROW_STEP + ROW_HEIGHT / 2;
              const isWaiting = item.state === 'waiting';
              return (
                <g key={item.id} className={isWaiting ? 'text-attention/75' : 'text-hairline-strong'}>
                  <path
                    d={`M 0 ${rootY} C 9 ${rootY}, 11 ${targetY}, ${SVG_WIDTH - 1} ${targetY}`}
                    stroke="currentColor"
                    strokeWidth="1"
                    fill="none"
                  />
                  <circle cx={SVG_WIDTH - 1} cy={targetY} r="1.5" fill="currentColor" />
                </g>
              );
            })
          )}
        </svg>

        <div className="min-w-0 flex-1 space-y-1">
          {liveChildren.length === 0 ? (
            <button
              type="button"
              data-topology-main-status=""
              onClick={onSwitchToRun}
              className={`flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-hairline bg-paper/70 px-2 text-left transition-colors hover:border-hairline-strong hover:bg-canvas ${FOCUS_RING}`}
            >
              <span className={`min-w-0 flex-1 truncate text-[11.5px] ${pendingCount > 0 ? 'font-medium text-attention' : 'text-ink-soft'}`}>
                {pendingCount > 0
                  ? `${t('inspector.nowWaiting')} (${pendingCount})`
                  : t('inspector.nowWorking')}
              </span>
              {mainElapsed !== undefined ? (
                <span className="shrink-0 font-mono text-[10.5px] text-ink-faint tabular-nums">
                  {mainElapsed}
                </span>
              ) : null}
              <Icon name="arrowRight" size={12} className="shrink-0 text-ink-faint" />
            </button>
          ) : (
            liveChildren.map((item) => {
              const isWaiting = item.state === 'waiting';
              if (item.kind === 'cron') {
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-topology-node="cron"
                    data-topology-kind="cron"
                    title={item.label}
                    onClick={() => { (onOpenCron ?? onSwitchToRun)(); }}
                    className={`flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-hairline bg-paper/70 px-2 text-left transition-colors hover:border-hairline-strong hover:bg-canvas ${FOCUS_RING}`}
                  >
                    <Icon name="clock" size={12} className="shrink-0 text-ink-soft" />
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink">
                      {item.label}
                    </span>
                    {item.nextFireAt !== null ? (
                      <span className="shrink-0 font-mono text-[10.5px] text-ink-faint tabular-nums">
                        <NextFire at={item.nextFireAt} />
                      </span>
                    ) : (
                      <span className="shrink-0 text-[10.5px] text-ink-faint">
                        {t('cron.status.running')}
                      </span>
                    )}
                  </button>
                );
              }
              if (item.kind === 'branch') {
                const statusText = t(`rail.branches.status.${item.state}` as I18nKey);
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-topology-node={item.id}
                    data-topology-kind="branch"
                    title={`${item.label} · ${statusText}`}
                    onClick={() => { onOpenAgent(item.id); }}
                    className={`flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-hairline bg-paper/70 px-2 text-left transition-colors hover:border-hairline-strong hover:bg-canvas ${FOCUS_RING}`}
                  >
                    <Icon
                      name="branch"
                      size={12}
                      className={isWaiting ? 'shrink-0 text-attention' : 'shrink-0 text-ink-soft'}
                    />
                    <span className={`min-w-0 flex-1 truncate text-[11.5px] ${isWaiting ? 'font-medium text-attention' : 'text-ink'}`}>
                      {item.label}
                    </span>
                    <span
                      className={`shrink-0 text-[10.5px] ${
                        isWaiting
                          ? 'font-medium text-attention'
                          : item.state === 'running'
                            ? 'text-accent'
                            : 'text-ink-faint'
                      }`}
                    >
                      {statusText}
                    </span>
                  </button>
                );
              }

              const elapsed = item.startedAt !== undefined ? age(now - item.startedAt, locale) : undefined;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-topology-node={item.id}
                  data-topology-kind="subagent"
                  title={elapsed === undefined ? item.label : `${item.label} · ${elapsed}`}
                  onClick={() => { onOpenAgent(item.id); }}
                  className={`flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-hairline bg-paper/70 px-2 text-left transition-colors hover:border-hairline-strong hover:bg-canvas ${FOCUS_RING}`}
                >
                  <StateMark state={item.state} className="h-[7px] w-[7px]" />
                  <span className={`min-w-0 flex-1 truncate text-[11.5px] ${isWaiting ? 'font-medium text-attention' : 'text-ink'}`}>
                    {item.label}
                  </span>
                  {isWaiting ? (
                    <span className="shrink-0 text-[10.5px] font-medium text-attention">
                      {t('rail.needsInput')}
                    </span>
                  ) : elapsed !== undefined ? (
                    <span className="shrink-0 font-mono text-[10.5px] text-ink-faint tabular-nums">
                      {elapsed}
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
});
