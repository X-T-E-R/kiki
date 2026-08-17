/**
 * Session > Parent > Current breadcrumb for the agent detail header.
 */

import { memo, useState } from 'react';

import { useI18n } from '../i18n';
import {
  agentChildren,
  MAIN_AGENT_ID,
  type AgentForest,
  type AgentTreeNode,
} from '../state/agentTree';

export const RELATED_AGENT_PREVIEW_LIMIT = 4;

function uniqueAgentNodes(nodes: readonly AgentTreeNode[]): readonly AgentTreeNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.agentId)) return false;
    seen.add(node.agentId);
    return true;
  });
}

export function relatedAgentNodes(
  forest: AgentForest,
  currentAgentId: string,
): {
  parent: AgentTreeNode | undefined;
  siblings: readonly AgentTreeNode[];
  children: readonly AgentTreeNode[];
} {
  const current = forest.byId[currentAgentId];
  if (current === undefined) return { parent: undefined, siblings: [], children: [] };
  const parent =
    current.parentAgentId === undefined ? undefined : forest.byId[current.parentAgentId];
  const siblingCandidates =
    current.parentAgentId === undefined ? forest.roots : agentChildren(forest, current.parentAgentId);
  const siblings = uniqueAgentNodes(siblingCandidates).filter(
    (candidate) =>
      candidate.agentId !== currentAgentId &&
      candidate.parentAgentId === current.parentAgentId,
  );
  return {
    parent,
    siblings,
    children: uniqueAgentNodes(agentChildren(forest, currentAgentId)),
  };
}

const RelationGroup = memo(function RelationGroup({
  nodes,
  label,
  moreLabel,
  onOpen,
}: {
  nodes: readonly AgentTreeNode[];
  label: string;
  moreLabel: (count: number) => string;
  onOpen: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? nodes : nodes.slice(0, RELATED_AGENT_PREVIEW_LIMIT);
  const hiddenCount = nodes.length - RELATED_AGENT_PREVIEW_LIMIT;
  return (
    <>
      {visible.map((node) => (
        <button
          key={node.agentId}
          type="button"
          onClick={() => { onOpen(node.agentId); }}
          className="rounded-full border border-hairline px-2 py-0.5 text-ink-soft transition-colors hover:border-accent hover:text-accent"
        >
          {label}: {node.label}
        </button>
      ))}
      {hiddenCount > 0 ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => { setExpanded((value) => !value); }}
          className="rounded-full border border-dashed border-hairline px-2 py-0.5 text-ink-faint transition-colors hover:border-accent hover:text-accent"
        >
          {expanded ? t('sv.showFewerAgents') : moreLabel(hiddenCount)}
        </button>
      ) : null}
    </>
  );
});

export const AgentBreadcrumb = memo(function AgentBreadcrumb({
  crumbs,
  onOpenSession,
  onOpenAgent,
}: {
  crumbs: readonly AgentTreeNode[];
  onOpenSession: () => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <nav data-agent-breadcrumb aria-label={t('sv.sessionCrumb')} className="min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-ink-faint">
        <li>
          <button
            type="button"
            onClick={onOpenSession}
            className="rounded px-0.5 text-ink-soft transition-colors hover:text-accent"
          >
            {t('sv.sessionCrumb')}
          </button>
        </li>
        {crumbs
          .filter((crumb) => crumb.agentId !== MAIN_AGENT_ID)
          .map((crumb, index, visible) => {
          const last = index === visible.length - 1;
          return (
            <li key={crumb.agentId} className="flex min-w-0 items-center gap-1">
              <span aria-hidden>/</span>
              {last ? (
                <span className="truncate font-medium text-ink" aria-current="page">
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => { onOpenAgent(crumb.agentId); }}
                  className="truncate rounded px-0.5 text-ink-soft transition-colors hover:text-accent"
                >
                  {crumb.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
});

export const AgentRelations = memo(function AgentRelations({
  forest,
  currentAgentId,
  onOpen,
}: {
  forest: AgentForest;
  currentAgentId: string;
  onOpen: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const related = relatedAgentNodes(forest, currentAgentId);
  const parent = related.parent?.agentId === MAIN_AGENT_ID ? undefined : related.parent;
  if (parent === undefined && related.siblings.length === 0 && related.children.length === 0) {
    return <p className="text-ink-faint">{t('sv.noRelatedAgents')}</p>;
  }
  return (
    <div data-agent-relations className="flex flex-wrap gap-3">
      {parent !== undefined ? (
        <button
          type="button"
          onClick={() => { onOpen(parent.agentId); }}
          className="rounded-full border border-hairline px-2 py-0.5 text-ink-soft transition-colors hover:border-accent hover:text-accent"
        >
          {t('sv.parentAgents')}: {parent.label}
        </button>
      ) : null}
      <RelationGroup
        nodes={related.siblings}
        label={t('sv.siblingAgents')}
        moreLabel={(count) => t('sv.moreSiblingAgents', { count })}
        onOpen={onOpen}
      />
      <RelationGroup
        nodes={related.children}
        label={t('sv.childAgents')}
        moreLabel={(count) => t('sv.moreChildAgents', { count })}
        onOpen={onOpen}
      />
    </div>
  );
});
