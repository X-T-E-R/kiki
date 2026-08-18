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

/**
 * Whole-block auto-collapse: with more related agents than this the relations
 * strip starts folded to a one-line summary (each group still expands on its
 * own once the block is opened).
 */
export const RELATED_AGENTS_AUTO_COLLAPSE = RELATED_AGENT_PREVIEW_LIMIT;

function agentPillClass(): string {
  return 'inline-flex min-w-0 max-w-56 items-baseline rounded-full border border-hairline px-2 py-0.5 text-ink-soft transition-colors hover:border-accent hover:text-accent';
}

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
          title={node.label}
          className={agentPillClass()}
        >
          <span className="shrink-0">{label}:</span>{' '}
          <span className="min-w-0 truncate">{node.label}</span>
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

interface AgentBreadcrumbProps {
  crumbs: readonly AgentTreeNode[];
  onOpenSession: () => void;
  onOpenAgent: (agentId: string) => void;
}

function visibleCrumbsEqual(
  previous: readonly AgentTreeNode[],
  next: readonly AgentTreeNode[],
): boolean {
  const previousVisible = previous.filter((crumb) => crumb.agentId !== MAIN_AGENT_ID);
  const nextVisible = next.filter((crumb) => crumb.agentId !== MAIN_AGENT_ID);
  return (
    previousVisible.length === nextVisible.length &&
    previousVisible.every((crumb, index) => crumb === nextVisible[index])
  );
}

export const AgentBreadcrumb = memo(function AgentBreadcrumb({
  crumbs,
  onOpenSession,
  onOpenAgent,
}: AgentBreadcrumbProps) {
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
}, (previous, next) =>
  visibleCrumbsEqual(previous.crumbs, next.crumbs) &&
  previous.onOpenSession === next.onOpenSession &&
  previous.onOpenAgent === next.onOpenAgent,
);

export const AgentRelations = memo(function AgentRelations({
  forest,
  currentAgentId,
  onOpen,
  defaultOpen,
}: {
  forest: AgentForest;
  currentAgentId: string;
  onOpen: (agentId: string) => void;
  /** Test/embedding override; defaults to expanded for small relation sets. */
  defaultOpen?: boolean;
}) {
  const { t } = useI18n();
  const related = relatedAgentNodes(forest, currentAgentId);
  const parent = related.parent?.agentId === MAIN_AGENT_ID ? undefined : related.parent;
  const totalCount =
    (parent === undefined ? 0 : 1) + related.siblings.length + related.children.length;
  const [open, setOpen] = useState(defaultOpen ?? totalCount <= RELATED_AGENTS_AUTO_COLLAPSE);
  if (totalCount === 0) {
    return <p className="text-ink-faint">{t('sv.noRelatedAgents')}</p>;
  }
  const summary = [
    parent === undefined ? undefined : `${t('sv.parentAgents')} 1`,
    related.siblings.length > 0 ? `${t('sv.siblingAgents')} ${related.siblings.length}` : undefined,
    related.children.length > 0 ? `${t('sv.childAgents')} ${related.children.length}` : undefined,
  ].filter((part) => part !== undefined);
  return (
    <div data-agent-relations>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { setOpen((value) => !value); }}
        className="flex min-w-0 items-center gap-1.5 text-ink-faint transition-colors hover:text-ink-soft"
      >
        <span
          aria-hidden
          className={`inline-block shrink-0 text-[9px] transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        >
          ▶
        </span>
        <span className="shrink-0 font-medium">{t('sv.relatedAgents')}</span>
        {!open ? (
          <span className="min-w-0 truncate text-ink-faint/70">{summary.join(' · ')}</span>
        ) : null}
      </button>
      {open ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {parent !== undefined ? (
            <button
              type="button"
              onClick={() => { onOpen(parent.agentId); }}
              title={parent.label}
              className={agentPillClass()}
            >
              <span className="shrink-0">{t('sv.parentAgents')}:</span>{' '}
              <span className="min-w-0 truncate">{parent.label}</span>
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
      ) : null}
    </div>
  );
});
