/**
 * Shared session agent tree. RightRail and the agent-detail page both render
 * this view over the same `buildAgentForest` result.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { I18nKey } from '@kiki/session-core/i18n';
import type { SessionAgentCounts } from '@kiki/protocol';
import {
  agentChildren,
  MAIN_AGENT_ID,
  type AgentForest,
  type AgentStatus,
  type AgentTreeNode,
} from '@kiki/session-core/session';
import { getSubagentScaleConfig } from '../lib/subagentScaleConfig';
import { formatThinkingEffort } from '../lib/thinkingEffort';
import { useI18n } from '../i18n';
import { DisclosureChevron, Icon } from './icons';
import { AgentTurnOutcomeLine } from './timeline/AgentTurnOutcomeLine';
import { useExecutorInstanceLabel } from './timeline/ExecutorNotes';

const STATUS_I18N: Record<AgentStatus, I18nKey> = {
  unknown: 'subagent.status.unknown',
  idle: 'subagent.status.idle',
  lost: 'subagent.status.lost',
  running: 'subagent.status.running',
  suspended: 'subagent.status.suspended',
  completed: 'subagent.status.completed',
  failed: 'subagent.status.failed',
  cancelled: 'subagent.status.cancelled',
  background: 'subagent.status.background',
};

function statusDot(status: AgentStatus): string {
  switch (status) {
    case 'running':
    case 'background':
      return 'bg-ink-soft';
    case 'completed':
      return 'bg-ink-faint';
    case 'failed':
    case 'lost':
      return 'bg-danger';
    case 'cancelled':
    case 'idle':
    case 'unknown':
      return 'bg-ink-faint';
    case 'suspended':
      return 'bg-amber-rule';
  }
}

function isActiveStatus(status: AgentStatus): boolean {
  return status === 'running' || status === 'suspended' || status === 'background';
}

interface AgentTreeRowProps {
  forest: AgentForest;
  node: AgentTreeNode;
  depth: number;
  selectedAgentId: string | undefined;
  onOpen: (agentId: string) => void;
  controlledExpanded?: boolean;
  onToggle?: () => void;
  flatStyle?: CSSProperties;
  measureRef?: (node: HTMLLIElement | null) => void;
  dataIndex?: number;
}

const AgentTreeRow = memo(function AgentTreeRow({
  forest,
  node,
  depth,
  selectedAgentId,
  onOpen,
  controlledExpanded,
  onToggle,
  flatStyle,
  measureRef,
  dataIndex,
}: AgentTreeRowProps) {
  const { t, tp } = useI18n();
  const engineName = useExecutorInstanceLabel(node.executorId);
  const children = agentChildren(forest, node.agentId);
  const hasActiveChild = children.some((child) => isActiveStatus(child.status));
  // The unvirtualized subtree keeps its existing per-row expansion state.
  const [localExpanded, setLocalExpanded] = useState(
    () => children.length > 0 || isActiveStatus(node.status) || hasActiveChild,
  );
  useEffect(() => {
    if (onToggle === undefined && (children.length > 0 || hasActiveChild || isActiveStatus(node.status))) {
      setLocalExpanded(true);
    }
  }, [children.length, hasActiveChild, node.status, onToggle]);
  const expanded = controlledExpanded ?? localExpanded;
  const [refreshing, setRefreshing] = useState(
    () => node.refreshing === true && Date.parse(node.refreshingUntil ?? '') > Date.now(),
  );
  useEffect(() => {
    const deadline = Date.parse(node.refreshingUntil ?? '');
    const active = node.refreshing === true && deadline > Date.now();
    setRefreshing(active);
    if (!active) return;
    const timer = setTimeout(() => { setRefreshing(false); }, deadline - Date.now());
    return () => { clearTimeout(timer); };
  }, [node.refreshing, node.refreshingUntil]);

  const selected = selectedAgentId === node.agentId;
  const label = node.label !== node.agentId || node.agentId === 'main' ? node.label
    : t(node.nameSource === 'unreported' ? 'subagent.name.unreported' : 'subagent.name.loading', { id: node.agentId });
  const indent = Math.min(depth, 6) * 12;

  return (
    <li ref={measureRef} data-index={dataIndex} data-rail-item style={flatStyle}>
      <div className="flex items-stretch">
        {depth > 0 ? (
          <span
            aria-hidden
            className="mr-1 shrink-0 border-l border-hairline"
            style={{ marginLeft: indent - 8 }}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-0.5">
            {children.length > 0 ? (
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? t('subagent.collapseChildren') : t('subagent.expandChildren')}
                onClick={() => {
                  if (onToggle !== undefined) onToggle();
                  else setLocalExpanded((value) => !value);
                }}
                className="flex h-6 w-5 shrink-0 items-center justify-center text-ink-faint transition-colors hover:text-ink"
              >
                <DisclosureChevron open={expanded} className="text-current" />
              </button>
            ) : (
              <span className="w-5 shrink-0" />
            )}
            <div
              className={`agent-tree-row flex min-w-0 flex-1 flex-col rounded-lg px-2 py-1.5 text-left transition-colors duration-[var(--kiki-motion-quick)] ${
                // The rail's own surface is panel, the lightest step, so the
                // selected sheet stays panel and lifts by its ring + shadow
                // (paper here would read as a grey fill).
                selected
                  ? 'bg-panel shadow-[var(--kiki-sheet-shadow)]'
                  : 'hover:bg-ink/[0.04]'
              }`}
            >
              <button
                type="button"
                data-agent-id={node.agentId}
                data-agent-depth={depth}
                data-agent-name-source={node.nameSource}
                data-agent-status-source={node.statusSource}
                aria-current={selected ? 'page' : undefined}
                aria-label={t('subagent.openAgent', { name: label })}
                title={node.error}
                onClick={() => {
                  onOpen(node.agentId);
                }}
                className="flex w-full min-w-0 items-center gap-2 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${refreshing ? 'bg-amber-rule' : statusDot(node.status)} ${
                    refreshing || (isActiveStatus(node.status) && node.busy) ? 'status-dot-busy' : ''
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 truncate text-[12px] font-normal text-ink">
                    <span className="truncate">{label}</span>
                    {node.executorId !== undefined && node.executorId !== '' && node.executorId !== 'native' ? (
                      <span
                        data-tree-engine-badge={node.executorId}
                        title={node.executorProtocol ? `${engineName} (${node.executorProtocol})` : engineName}
                        aria-label={node.executorProtocol ? `${engineName} (${node.executorProtocol})` : engineName}
                        className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[10px] font-normal leading-tight bg-ink/[0.05] text-ink-faint hover:text-ink-soft focus-visible:outline-1 focus-visible:outline-selected-ink"
                      >
                        <Icon name="external" size={12} className="shrink-0 text-ink-faint" />
                        <span className="truncate max-w-16">{engineName}</span>
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-[12px] text-ink-faint">
                    {t(refreshing ? 'subagent.status.refreshing' : STATUS_I18N[node.status])}
                    {node.model !== undefined ? ` · ${node.model}` : ''}
                    {node.thinkingEffort !== undefined && (node.thinkingEffort.toLowerCase() !== 'off' || node.thinkingEffortExplicit === true)
                      ? ` · ${formatThinkingEffort(node.thinkingEffort, t)}`
                      : ''}
                    {node.toolCallCountKnown === true
                      ? ` · ${t('subagent.tools', { count: node.toolCallCount })}`
                      : ''}
                    {children.length > 0 ? ` · ${tp('subagent.children', children.length)}` : ''}
                  </span>
                  {node.turnOutcome === undefined && node.error !== undefined && (node.status === 'failed' || node.status === 'cancelled') ? (
                    <span className="mt-0.5 block truncate text-[12px] text-amber-ink" title={node.error}>{node.error}</span>
                  ) : null}
                </span>
                {node.status === 'failed' && node.error !== undefined ? (
                  <span aria-hidden title={node.error} className="flex shrink-0 text-danger">
                    <Icon name="warning" size={14} />
                  </span>
                ) : null}
              </button>
              {node.turnOutcome === undefined ? null : (
                <div className="pl-4">
                  <AgentTurnOutcomeLine outcome={node.turnOutcome} />
                </div>
              )}
            </div>
          </div>
          {onToggle === undefined && expanded && children.length > 0 ? (
            <ul className="mt-1 space-y-1">
              {children.map((child) => (
                <AgentTreeRow
                  key={child.agentId}
                  forest={forest}
                  node={child}
                  depth={depth + 1}
                  selectedAgentId={selectedAgentId}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </li>
  );
});

type FlattenedTreeRow =
  | { readonly kind: 'node'; readonly node: AgentTreeNode; readonly depth: number }
  | { readonly kind: 'hint'; readonly key: string; readonly depth: number; readonly shown: number; readonly total: number };

function isLiveOrPinnedTreeNode(node: AgentTreeNode, selectedPath: ReadonlySet<string>): boolean {
  return (
    selectedPath.has(node.agentId) ||
    node.busy ||
    node.status === 'running' ||
    node.status === 'suspended' ||
    node.status === 'failed' ||
    (node.isBranch === true && node.branchSealed !== true)
  );
}

function buildSelectedAncestry(forest: AgentForest, selectedAgentId?: string): Set<string> {
  const path = new Set<string>();
  let current = selectedAgentId;
  while (current !== undefined && !path.has(current)) {
    path.add(current);
    current = forest.byId[current]?.parentAgentId;
  }
  return path;
}

/**
 * Flatten a potentially 10,000-node forest into a bounded display slice:
 * active/waiting/failed/selected nodes always stay ahead of settled nodes,
 * and settled siblings per parent are capped to `settledCap` (newest first).
 */
function flattenBoundedTree(
  forest: AgentForest,
  roots: readonly AgentTreeNode[],
  collapsed: ReadonlySet<string>,
  selectedAgentId: string | undefined,
  settledCap: number,
  agentCounts?: SessionAgentCounts,
): readonly FlattenedTreeRow[] {
  const selectedPath = buildSelectedAncestry(forest, selectedAgentId);
  const result: FlattenedTreeRow[] = [];
  const visited = new Set<string>();

  const capChildren = (
    parentId: string | undefined,
    list: readonly AgentTreeNode[],
  ): { readonly kept: readonly AgentTreeNode[]; readonly total: number; readonly truncated: boolean } => {
    const active: AgentTreeNode[] = [];
    const settled: AgentTreeNode[] = [];
    for (const node of list) {
      if (isLiveOrPinnedTreeNode(node, selectedPath)) active.push(node);
      else settled.push(node);
    }
    const serverTotal = parentId === MAIN_AGENT_ID && agentCounts !== undefined
      ? Math.max(list.length, agentCounts.subagents)
      : list.length;
    if (settled.length <= settledCap && serverTotal <= list.length) {
      return { kept: list, total: serverTotal, truncated: false };
    }
    // Keep newest settled items (tail of dispatch order, newest first).
    const recentSettled = settled.length > settledCap
      ? settled.slice(settled.length - settledCap).reverse()
      : settled;
    const kept = [...active, ...recentSettled];
    return {
      kept,
      total: serverTotal,
      truncated: serverTotal > kept.length,
    };
  };

  const stack: Array<FlattenedTreeRow> = [];
  const rootSlice = capChildren(undefined, roots);
  if (rootSlice.truncated) {
    stack.push({ kind: 'hint', key: 'hint:__roots__', depth: 0, shown: rootSlice.kept.length, total: rootSlice.total });
  }
  for (let i = rootSlice.kept.length - 1; i >= 0; i -= 1) {
    stack.push({ kind: 'node', node: rootSlice.kept[i]!, depth: 0 });
  }

  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (entry.kind === 'hint') {
      result.push(entry);
      continue;
    }
    if (visited.has(entry.node.agentId)) continue;
    visited.add(entry.node.agentId);
    result.push(entry);
    if (collapsed.has(entry.node.agentId) || entry.node.childIds.length === 0) continue;
    const children: AgentTreeNode[] = [];
    for (const childId of entry.node.childIds) {
      const child = forest.byId[childId];
      if (child !== undefined && !visited.has(child.agentId)) children.push(child);
    }
    if (children.length === 0) continue;
    const childSlice = capChildren(entry.node.agentId, children);
    if (childSlice.truncated) {
      stack.push({
        kind: 'hint',
        key: `hint:${entry.node.agentId}`,
        depth: entry.depth + 1,
        shown: childSlice.kept.length,
        total: childSlice.total,
      });
    }
    for (let i = childSlice.kept.length - 1; i >= 0; i -= 1) {
      stack.push({ kind: 'node', node: childSlice.kept[i]!, depth: entry.depth + 1 });
    }
  }

  return result;
}

function BoundedVirtualTree({
  forest,
  roots,
  selectedAgentId,
  onOpen,
  scrollRef: externalScrollRef,
  viewportHeight = 420,
  attrName = 'data-agent-tree',
  attrValue = '',
  agentCounts,
}: {
  forest: AgentForest;
  roots: readonly AgentTreeNode[];
  selectedAgentId?: string;
  onOpen: (agentId: string) => void;
  scrollRef?: RefObject<HTMLDivElement | null>;
  viewportHeight?: number;
  attrName?: 'data-agent-tree' | 'data-agent-subtree';
  attrValue?: string;
  agentCounts?: SessionAgentCounts;
}) {
  const { t, locale } = useI18n();
  const scaleConfig = getSubagentScaleConfig();
  const internalScrollRef = useRef<HTMLDivElement>(null);
  const activeScrollRef = externalScrollRef ?? internalScrollRef;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(
    () => flattenBoundedTree(forest, roots, collapsed, selectedAgentId, scaleConfig.settledRosterWindow, agentCounts),
    [forest, roots, collapsed, selectedAgentId, scaleConfig.settledRosterWindow, agentCounts],
  );
  const handleToggle = useCallback((agentId: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLLIElement>({
    count: rows.length,
    getScrollElement: () => activeScrollRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (row?.kind === 'hint') return 28;
      if (row === undefined) return 52;
      const hasThirdLine =
        row.node.turnOutcome !== undefined ||
        (row.node.error !== undefined && (row.node.status === 'failed' || row.node.status === 'cancelled'));
      return hasThirdLine ? 72 : 52;
    },
    measureElement: (element, _entry, instance) => {
      const rectHeight = Math.ceil(element.getBoundingClientRect().height);
      if (rectHeight > 0) return rectHeight;
      const index = Number(element.getAttribute('data-index'));
      return Number.isFinite(index) ? instance.options.estimateSize(index) : 52;
    },
    getItemKey: (index) => {
      const row = rows[index];
      if (row === undefined) return index;
      return row.kind === 'hint' ? row.key : row.node.agentId;
    },
    overscan: 6,
    initialRect: { width: 320, height: viewportHeight },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement;
      if (el === null) return;
      const emit = () => {
        const rect = el.getBoundingClientRect();
        const height = Math.round(rect.height || el.clientHeight);
        const width = Math.round(rect.width || el.clientWidth);
        if (height > 0) cb({ width, height });
      };
      emit();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(emit);
      observer.observe(el);
      return () => { observer.disconnect(); };
    },
    useFlushSync: false,
  });

  if (rows.length === 0) {
    return <p className="text-[12px] text-ink-faint">{t('rail.noSubagents')}</p>;
  }

  const listAttrs = attrName === 'data-agent-subtree'
    ? { 'data-agent-subtree': attrValue }
    : { 'data-agent-tree': '' };

  const listContent = (
    <ul {...listAttrs} className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index]!;
        if (row.kind === 'hint') {
          return (
            <li
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              data-agent-tree-window-hint=""
              className="flex min-h-7 items-center px-2 text-[11px] text-ink-faint"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                paddingLeft: `${8 + Math.min(row.depth, 4) * 12}px`,
                transform: `translateY(${item.start}px)`,
              }}
            >
              {locale === 'zh'
                ? `显示最近 ${row.shown} 项 · 搜索可定位全部`
                : `Showing latest ${row.shown} · Search to find any`}
            </li>
          );
        }
        return (
          <AgentTreeRow
            key={row.node.agentId}
            forest={forest}
            node={row.node}
            depth={row.depth}
            selectedAgentId={selectedAgentId}
            onOpen={onOpen}
            controlledExpanded={!collapsed.has(row.node.agentId)}
            onToggle={() => { handleToggle(row.node.agentId); }}
            measureRef={virtualizer.measureElement}
            dataIndex={item.index}
            flatStyle={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${item.start}px)`,
            }}
          />
        );
      })}
    </ul>
  );

  if (externalScrollRef !== undefined) return listContent;
  return (
    <div ref={internalScrollRef} className="max-h-[min(60vh,520px)] overflow-y-auto overscroll-contain">
      {listContent}
    </div>
  );
}

/**
 * One agent's children as a recursive tree (status dot, label, click to open;
 * rows auto-expand so deep nesting is visible). Used by the subagent rail to
 * replace the old flat child chips.
 */
export const AgentSubtreeView = memo(function AgentSubtreeView({
  forest,
  agentId,
  selectedAgentId,
  onOpen,
}: {
  forest: AgentForest;
  agentId: string;
  selectedAgentId?: string;
  onOpen: (agentId: string) => void;
}) {
  const children = useMemo(() => agentChildren(forest, agentId), [forest, agentId]);
  if (children.length === 0) return null;
  if (children.length > getSubagentScaleConfig().virtualizeThreshold) {
    return (
      <BoundedVirtualTree
        forest={forest}
        roots={children}
        selectedAgentId={selectedAgentId}
        onOpen={onOpen}
        attrName="data-agent-subtree"
        attrValue={agentId}
      />
    );
  }
  return (
    <ul data-agent-subtree={agentId} className="space-y-1">
      {children.map((child) => (
        <AgentTreeRow
          key={child.agentId}
          forest={forest}
          node={child}
          depth={0}
          selectedAgentId={selectedAgentId}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
});

export const AgentTreeView = memo(function AgentTreeView({
  forest,
  selectedAgentId,
  onOpen,
  agentCounts,
}: {
  forest: AgentForest;
  selectedAgentId?: string;
  onOpen: (agentId: string) => void;
  agentCounts?: SessionAgentCounts;
}) {
  const { t } = useI18n();
  const roots = useMemo(() => forest.roots, [forest]);
  const nodeCount = useMemo(() => Object.keys(forest.byId).length, [forest.byId]);
  if (roots.length === 0) {
    return <p className="text-[12px] text-ink-faint">{t('rail.noSubagents')}</p>;
  }
  if (nodeCount > getSubagentScaleConfig().virtualizeThreshold) {
    return (
      <BoundedVirtualTree
        forest={forest}
        roots={roots}
        selectedAgentId={selectedAgentId}
        onOpen={onOpen}
        agentCounts={agentCounts}
      />
    );
  }
  return (
    <ul data-agent-tree className="space-y-1.5">
      {roots.map((root) => (
        <AgentTreeRow
          key={root.agentId}
          forest={forest}
          node={root}
          depth={0}
          selectedAgentId={selectedAgentId}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
});

/** Windowed tree for scrollable rails: retain every branch in the model, but mount only nearby rows. */
export function VirtualAgentTreeView({
  forest,
  selectedAgentId,
  onOpen,
  scrollRef,
  viewportHeight = 320,
  agentCounts,
}: {
  forest: AgentForest;
  selectedAgentId?: string;
  onOpen: (agentId: string) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  viewportHeight?: number;
  agentCounts?: SessionAgentCounts;
}) {
  const nodeCount = useMemo(() => Object.keys(forest.byId).length, [forest.byId]);
  if (nodeCount <= getSubagentScaleConfig().virtualizeThreshold) {
    return <AgentTreeView forest={forest} selectedAgentId={selectedAgentId} onOpen={onOpen} agentCounts={agentCounts} />;
  }
  return (
    <BoundedVirtualTree
      forest={forest}
      roots={forest.roots}
      selectedAgentId={selectedAgentId}
      onOpen={onOpen}
      scrollRef={scrollRef}
      viewportHeight={viewportHeight}
      agentCounts={agentCounts}
    />
  );
}
