/**
 * Shared session agent tree. RightRail and the agent-detail page both render
 * this view over the same `buildAgentForest` result.
 */

import { memo, useEffect, useMemo, useState } from 'react';

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
}

const AgentTreeRow = memo(function AgentTreeRow({
  forest,
  node,
  depth,
  selectedAgentId,
  onOpen,
}: AgentTreeRowProps) {
  const { t, tp } = useI18n();
  const children = agentChildren(forest, node.agentId);
  const hasActiveChild = children.some((child) => isActiveStatus(child.status));
  // Session rail must list settled children without a click: a completed parent
  // with two named kids is the proof surface. Only auto-expand, never collapse.
  const [expanded, setExpanded] = useState(
    () => children.length > 0 || isActiveStatus(node.status) || hasActiveChild,
  );
  useEffect(() => {
    if (children.length > 0 || hasActiveChild || isActiveStatus(node.status)) setExpanded(true);
  }, [children.length, hasActiveChild, node.status]);

  const selected = selectedAgentId === node.agentId;
  const indent = Math.min(depth, 6) * 12;

  return (
    <li data-rail-item>
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
                  setExpanded((value) => !value);
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
                className={`h-2 w-2 shrink-0 rounded-full ${statusDot(node.status)} ${
                  node.busy ? 'status-dot-busy' : ''
                }`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-ink">{node.label}</span>
                <span className="block truncate text-[10px] text-ink-faint">
                  {t(STATUS_I18N[node.status])}
                  {node.model !== undefined ? ` · ${node.model}` : ''}
                  {node.thinkingEffort !== undefined
                    ? ` · ${t('subagent.effort', { effort: node.thinkingEffort })}`
                    : ''}
                  {` · ${t('subagent.tools', { count: node.toolCallCount })}`}
                  {children.length > 0 ? ` · ${tp('subagent.children', children.length)}` : ''}
                </span>
              </span>
            </button>
          </div>
          {expanded && children.length > 0 ? (
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
}, (previous, next) =>
  previous.node === next.node &&
  previous.depth === next.depth &&
  (previous.selectedAgentId === previous.node.agentId) ===
    (next.selectedAgentId === next.node.agentId) &&
  previous.onOpen === next.onOpen,
);

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
