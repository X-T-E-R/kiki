/**
 * Session > Parent > Current breadcrumb for the agent detail header, and the
 * agent's relations (parent, children, siblings) beneath it.
 */

import { memo, useState } from 'react';

import {
  agentChildren,
  MAIN_AGENT_ID,
  type AgentForest,
  type AgentTreeNode,
} from '@kiki/session-core/session';
import { useI18n } from '../i18n';
import { RelatedAgentRow, useMinuteClock } from './agent-panel/InspectorAgents';
import { DisclosureChevron } from './icons';

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

/**
 * An agent's neighbours. The parent and the children are the ways up and
 * down, so both are always listed, one roster row each. Siblings can run to
 * hundreds; they fold behind a one-line count and page in once opened.
 * Every row opens through `onOpen`, the same entry the timeline card uses.
 */
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
  const now = useMinuteClock();
  const related = relatedAgentNodes(forest, currentAgentId);
  const parent = related.parent?.agentId === MAIN_AGENT_ID ? undefined : related.parent;
  const [siblingsOpen, setSiblingsOpen] = useState(false);
  const [siblingsAll, setSiblingsAll] = useState(false);
  if (parent === undefined && related.siblings.length === 0 && related.children.length === 0) {
    return <p className="text-ink-faint">{t('sv.noRelatedAgents')}</p>;
  }
  const siblings = siblingsAll ? related.siblings : related.siblings.slice(0, SIBLING_PAGE);
  const hiddenSiblings = related.siblings.length - siblings.length;
  return (
    <div data-agent-relations className="space-y-1">
      {parent !== undefined ? (
        <RelationList kind="parent" label={t('sv.parentAgents')} nodes={[parent]} now={now} onOpen={onOpen} />
      ) : null}
      {related.children.length > 0 ? (
        <RelationList
          kind="children" label={t('sv.childAgents')} count={related.children.length}
          nodes={related.children} now={now} onOpen={onOpen}
        />
      ) : null}
      {related.siblings.length > 0 ? (
        <div data-relations-group="siblings">
          <button
            type="button"
            aria-expanded={siblingsOpen}
            data-relations-toggle="siblings"
            onClick={() => { setSiblingsOpen((value) => !value); }}
            className={GROUP_HEAD_BUTTON}
          >
            <DisclosureChevron open={siblingsOpen} className="text-current" />
            <span className="font-medium">{t('sv.siblingAgents')}</span>
            <span className="tabular-nums">{related.siblings.length}</span>
          </button>
          {siblingsOpen ? (
            <div role="list" className="mt-0.5">
              {siblings.map((node) => (
                <div key={node.agentId} role="listitem">
                  <RelatedAgentRow node={node} now={now} onSelect={onOpen} />
                </div>
              ))}
              {hiddenSiblings > 0 ? (
                <button
                  type="button"
                  data-relations-more="siblings"
                  onClick={() => { setSiblingsAll(true); }}
                  className="ml-3.5 h-8 rounded-md px-1.5 text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                >
                  {t('sv.moreSiblingAgents', { count: hiddenSiblings })}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/** Siblings shown once the fold is opened, before "Show N more". */
export const SIBLING_PAGE = 20;

const GROUP_HEAD_BUTTON =
  '-ml-1 flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1 text-ink-faint transition-colors hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent pointer-coarse:h-9';

function RelationList({
  kind,
  label,
  count,
  nodes,
  now,
  onOpen,
}: {
  kind: 'parent' | 'children';
  label: string;
  count?: number;
  nodes: readonly AgentTreeNode[];
  now: number;
  onOpen: (agentId: string) => void;
}) {
  return (
    <section data-relations-group={kind} aria-label={label}>
      <h3 className="flex h-6 items-center gap-1.5 text-ink-faint">
        <span className="font-medium">{label}</span>
        {count !== undefined ? <span className="tabular-nums">{count}</span> : null}
      </h3>
      <div role="list">
        {nodes.map((node) => (
          <div key={node.agentId} role="listitem">
            <RelatedAgentRow node={node} now={now} onSelect={onOpen} />
          </div>
        ))}
      </div>
    </section>
  );
}
