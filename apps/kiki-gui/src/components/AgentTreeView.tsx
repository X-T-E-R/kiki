/**
 * Shared session agent tree. RightRail and the agent-detail page both render
 * this view over the same `buildAgentForest` result.
 */

import { memo, useEffect, useMemo, useState, type CSSProperties, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { I18nKey } from '@kiki/session-core/i18n';
import {
  agentChildren,
  type AgentForest,
  type AgentStatus,
  type AgentTreeNode,
} from '@kiki/session-core/session';
import { useI18n } from '../i18n';

const STATUS_I18N: Record<AgentStatus, I18nKey> = {
  unknown: 'subagent.status.unknown',
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
      return 'bg-accent';
    case 'completed':
      return 'bg-success';
    case 'failed':
      return 'bg-danger';
    case 'cancelled':
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
}: AgentTreeRowProps) {
  const { t, tp } = useI18n();
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
  const indent = Math.min(depth, 6) * 12;

  return (
    <li data-rail-item style={flatStyle}>
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
                className="flex h-6 w-5 shrink-0 items-center justify-center text-[9px] text-ink-faint transition-colors hover:text-ink"
              >
                <span aria-hidden className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>
                  ▶
                </span>
              </button>
            ) : (
              <span className="w-5 shrink-0" />
            )}
            <button
              type="button"
              data-agent-id={node.agentId}
              data-agent-depth={depth}
              aria-current={selected ? 'page' : undefined}
              aria-label={t('subagent.openAgent', { name: node.label })}
              title={node.error}
              onClick={() => {
                onOpen(node.agentId);
              }}
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors ${
                selected
                  ? 'border-accent/50 bg-accent-soft/40'
                  : 'border-hairline bg-panel hover:border-accent/50 hover:bg-accent-soft/30'
              }`}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${refreshing ? 'bg-amber-rule' : statusDot(node.status)} ${
                  refreshing || node.busy ? 'status-dot-busy' : ''
                }`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-ink">{node.label}</span>
                <span className="block truncate text-[10px] text-ink-faint">
                  {t(refreshing ? 'subagent.status.refreshing' : STATUS_I18N[node.status])}
                  {node.model !== undefined ? ` · ${node.model}` : ''}
                  {node.thinkingEffort !== undefined
                    ? ` · ${t('subagent.effort', { effort: node.thinkingEffort })}`
                    : ''}
                  {node.toolCallCountKnown === true
                    ? ` · ${t('subagent.tools', { count: node.toolCallCount })}`
                    : ''}
                  {children.length > 0 ? ` · ${tp('subagent.children', children.length)}` : ''}
                </span>
              </span>
              {node.status === 'failed' && node.error !== undefined ? (
                <span
                  aria-hidden
                  title={node.error}
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-danger/10 text-[10px] font-bold text-danger"
                >
                  !
                </span>
              ) : null}
            </button>
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
  const children = agentChildren(forest, agentId);
  if (children.length === 0) return null;
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
}: {
  forest: AgentForest;
  selectedAgentId?: string;
  onOpen: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const roots = useMemo(() => forest.roots, [forest]);
  if (roots.length === 0) {
    return <p className="text-[12px] text-ink-faint">{t('rail.noSubagents')}</p>;
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
}: {
  forest: AgentForest;
  selectedAgentId?: string;
  onOpen: (agentId: string) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  viewportHeight?: number;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(() => {
    const result: { node: AgentTreeNode; depth: number }[] = [];
    const visited = new Set<string>();
    const stack = [...forest.roots].reverse().map((node) => ({ node, depth: 0 }));
    while (stack.length > 0) {
      const entry = stack.pop()!;
      if (visited.has(entry.node.agentId)) continue;
      visited.add(entry.node.agentId);
      result.push(entry);
      if (collapsed.has(entry.node.agentId)) continue;
      for (let index = entry.node.childIds.length - 1; index >= 0; index -= 1) {
        const child = forest.byId[entry.node.childIds[index]!];
        if (child !== undefined) stack.push({ node: child, depth: entry.depth + 1 });
      }
    }
    return result;
  }, [forest, collapsed]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    getItemKey: (index) => rows[index]?.node.agentId ?? index,
    overscan: 5,
    initialRect: { width: 320, height: viewportHeight },
    useFlushSync: false,
  });

  if (rows.length === 0) {
    return <p className="text-[12px] text-ink-faint">{t('rail.noSubagents')}</p>;
  }
  if (Object.keys(forest.byId).length <= 20) {
    return <AgentTreeView forest={forest} selectedAgentId={selectedAgentId} onOpen={onOpen} />;
  }
  return (
    <ul data-agent-tree className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index]!;
        return (
          <AgentTreeRow
            key={row.node.agentId}
            forest={forest}
            node={row.node}
            depth={row.depth}
            selectedAgentId={selectedAgentId}
            onOpen={onOpen}
            controlledExpanded={!collapsed.has(row.node.agentId)}
            onToggle={() => {
              setCollapsed((previous) => {
                const next = new Set(previous);
                if (next.has(row.node.agentId)) next.delete(row.node.agentId);
                else next.add(row.node.agentId);
                return next;
              });
            }}
            flatStyle={{ position: 'absolute', top: 0, left: 0, width: '100%', height: item.size, transform: `translateY(${item.start}px)` }}
          />
        );
      })}
    </ul>
  );
}
