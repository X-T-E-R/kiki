/**
 * Session > Parent > Current breadcrumb for the agent detail header, and the
 * agent's relations (parent, children, siblings) beneath it.
 */

import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import {
  agentChildren,
  MAIN_AGENT_ID,
  type AgentForest,
  type AgentTreeNode,
} from '@kiki/session-core/session';
import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../i18n';
import { registerOverlay } from '../lib/uiBusy';
import { Icon } from './icons';

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

/** Most child chips ever laid out inline; the rest always fold into "+N". */
export const CHILD_CHIP_LIMIT = 12;
/** The strip never grows past this many chip lines. */
const MAX_LINES = 2;

const CHIP =
  'inline-flex h-6 min-w-0 max-w-[16rem] shrink items-center gap-1.5 rounded-full border border-hairline px-2 text-[12px] leading-none text-ink-soft transition-colors hover:border-hairline-strong hover:bg-ink/[0.03] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink pointer-coarse:h-8';

/** Status dot: running in the live colour, waiting in the accent, the rest quiet. */
function chipDot(status: string): string {
  switch (status) {
    case 'running':
    case 'background':
      return 'bg-success';
    case 'suspended':
      return 'bg-attention';
    case 'failed':
      return 'bg-ink-soft';
    default:
      return 'bg-ink-faint/60';
  }
}

/** Tooltip: the full name, then what it is doing and for how long. */
function useChipTitle(): (node: AgentTreeNode) => string {
  const { t, time } = useI18n();
  return (node) => {
    const started = node.startedAt === undefined ? Number.NaN : Date.parse(node.startedAt);
    const ended = node.endedAt === undefined ? Date.now() : Date.parse(node.endedAt);
    const elapsed = Number.isFinite(started) && ended >= started ? time.formatDuration(ended - started) : undefined;
    const state = [t(`subagent.status.${node.status}` as I18nKey), elapsed].filter((part) => part !== undefined).join(' · ');
    return [node.label, node.description, state].filter((part) => part !== undefined && part !== '').join('\n');
  };
}

const AgentChip = memo(function AgentChip({
  node,
  kind,
  title,
  onOpen,
}: {
  node: AgentTreeNode;
  kind: 'parent' | 'child';
  title: string;
  onOpen: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const parentLabel = t('sv.parentAgents');
  return (
    <button
      type="button"
      data-relation={kind}
      data-relation-chip=""
      data-agent-id={node.agentId}
      title={title}
      aria-label={kind === 'parent' ? `${parentLabel} ${node.label}` : node.label}
      onClick={() => { onOpen(node.agentId); }}
      // The parent may take its whole line: its name is the way back up.
      className={kind === 'parent' ? CHIP.replace('max-w-[16rem]', 'max-w-full') : CHIP}
    >
      {/* The parent's word is its own quiet label beside an up arrow, never a
          "Parent:" prefix glued to the name; the name keeps the width. */}
      {kind === 'parent' ? (
        <span aria-hidden className="-ml-0.5 flex shrink-0 items-center gap-0.5 text-[11px] text-ink-faint">
          <Icon name="arrowUp" size={12} />
          {parentLabel}
        </span>
      ) : null}
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${chipDot(node.status)}`} />
      <span className="min-w-0 truncate">{node.label}</span>
    </button>
  );
});

/**
 * An agent's neighbours as one strip of chips, never more than MAX_LINES
 * tall: the parent (marked with an up arrow), a gap, the children, then the
 * siblings behind one count chip that opens a list (they can run to
 * hundreds). Children that do not fit fold into "+N", which opens the same
 * kind of list. Every chip opens through `onOpen`, the same entry the
 * timeline card uses.
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
  const titleOf = useChipTitle();
  const related = relatedAgentNodes(forest, currentAgentId);
  const parent = related.parent?.agentId === MAIN_AGENT_ID ? undefined : related.parent;
  const allChildren = related.children;
  const stripRef = useRef<HTMLDivElement>(null);
  // Chips laid out inline; measured down until the strip fits MAX_LINES.
  const [shownCount, setShownCount] = useState(() => Math.min(allChildren.length, CHILD_CHIP_LIMIT));
  const childKey = allChildren.map((node) => node.agentId).join('\u0000');
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    setShownCount(Math.min(allChildren.length, CHILD_CHIP_LIMIT));
  }, [childKey, width, allChildren.length]);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip === null || shownCount === 0) return;
    const chips = [...strip.querySelectorAll<HTMLElement>('[data-relation-chip]')];
    const tops = new Set(chips.map((chip) => chip.offsetTop));
    if (tops.size > MAX_LINES) setShownCount((count) => Math.max(0, count - 1));
  });
  useEffect(() => {
    const strip = stripRef.current;
    if (strip === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      setWidth((current) => (Math.abs(current - next) > 4 ? next : current));
    });
    observer.observe(strip);
    return () => { observer.disconnect(); };
  }, []);
  if (parent === undefined && related.siblings.length === 0 && allChildren.length === 0) {
    return <p className="text-ink-faint">{t('sv.noRelatedAgents')}</p>;
  }
  const children = allChildren.slice(0, shownCount);
  const overflow = allChildren.slice(shownCount);
  return (
    <div ref={stripRef} data-agent-relations className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {parent !== undefined ? (
        <span data-relations-group="parent" className="contents">
          <AgentChip node={parent} kind="parent" title={titleOf(parent)} onOpen={onOpen} />
        </span>
      ) : null}
      {allChildren.length > 0 ? (
        <span data-relations-group="children" role="group" aria-label={t('sv.childAgents')} className="contents">
          {parent !== undefined ? <span aria-hidden className="w-1.5" /> : null}
          {children.map((node) => (
            <AgentChip key={node.agentId} node={node} kind="child" title={titleOf(node)} onOpen={onOpen} />
          ))}
          {overflow.length > 0 ? (
            <AgentListChip
              kind="children"
              label={`+${overflow.length}`}
              title={t('sv.moreChildAgents', { count: overflow.length })}
              listLabel={t('sv.childAgents')}
              nodes={overflow}
              titleOf={titleOf}
              onOpen={onOpen}
            />
          ) : null}
        </span>
      ) : null}
      {related.siblings.length > 0 ? (
        <>
          {parent !== undefined || allChildren.length > 0 ? <span aria-hidden className="w-1.5" /> : null}
          <AgentListChip
            kind="siblings"
            icon="branch"
            label={<><span>{t('sv.siblingAgents')}</span><span className="tabular-nums">{related.siblings.length}</span></>}
            listLabel={t('sv.siblingAgents')}
            nodes={related.siblings}
            titleOf={titleOf}
            onOpen={onOpen}
          />
        </>
      ) : null}
    </div>
  );
});

/** Past this many agents a chip's list offers a filter field. */
const LIST_FILTER_AT = 12;

/** A count chip that opens a list of agents (siblings, or children that did not fit). */
function AgentListChip({
  kind,
  icon,
  label,
  title,
  listLabel,
  nodes,
  titleOf,
  onOpen,
}: {
  kind: 'siblings' | 'children';
  icon?: 'branch';
  label: ReactNode;
  title?: string;
  listLabel: string;
  nodes: readonly AgentTreeNode[];
  titleOf: (node: AgentTreeNode) => string;
  onOpen: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [query, setQuery] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const open = anchor !== null;
  const closeRef = useRef((restoreFocus: boolean) => {
    setAnchor(null);
    setQuery('');
    if (restoreFocus) buttonRef.current?.focus();
  });
  useEffect(() => {
    if (!open) return;
    const close = closeRef.current;
    const unregister = registerOverlay(`relations-${kind}`);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target !== null && (listRef.current?.contains(target) === true || buttonRef.current?.contains(target) === true)) return;
      close(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    listRef.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, kind]);
  const needle = query.trim().toLowerCase();
  const shown = needle === ''
    ? nodes
    : nodes.filter((node) => `${node.label} ${node.description ?? ''}`.toLowerCase().includes(needle));
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-relation-chip=""
        data-relations-toggle={kind}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={title}
        onClick={() => {
          if (open) closeRef.current(false);
          else setAnchor(buttonRef.current?.getBoundingClientRect() ?? null);
        }}
        className={`${CHIP} ${kind === 'children' ? 'border-dashed tabular-nums' : 'text-ink-faint'}`}
      >
        {icon !== undefined ? <Icon name={icon} size={12} className="-ml-0.5 shrink-0" /> : null}
        {label}
      </button>
      {anchor !== null ? createPortal(
        <div
          ref={listRef}
          role="dialog"
          aria-label={listLabel}
          data-relations-popover={kind}
          className="anim-enter fixed z-50 flex max-h-[min(22rem,60vh)] w-72 max-w-[calc(100vw-16px)] flex-col rounded-[10px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]"
          style={{ left: Math.max(8, Math.min(anchor.left, window.innerWidth - 296)), top: anchor.bottom + 4 }}
        >
          {nodes.length >= LIST_FILTER_AT ? (
            <input
              type="search"
              value={query}
              onChange={(event) => { setQuery(event.target.value); }}
              aria-label={t('inspector.searchAgentsAria')}
              placeholder={t('inspector.searchAgents')}
              className="m-1 h-8 shrink-0 rounded-md border border-hairline bg-transparent px-2 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-hairline-strong focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-selected-ink"
            />
          ) : null}
          <div role="list" className="min-h-0 overflow-y-auto">
            {shown.map((node) => (
              <div key={node.agentId} role="listitem">
                <button
                  type="button"
                  data-agent-id={node.agentId}
                  title={titleOf(node)}
                  onClick={() => { closeRef.current(false); onOpen(node.agentId); }}
                  className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:py-2.5"
                >
                  <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${chipDot(node.status)}`} />
                  <span className="min-w-0 flex-1 truncate">{node.label}</span>
                  <span className="shrink-0 text-[11.5px] text-ink-faint">{t(`subagent.status.${node.status}` as I18nKey)}</span>
                </button>
              </div>
            ))}
            {shown.length === 0 ? (
              <p className="px-2 py-1.5 text-[12px] text-ink-faint">{t('sv.noRelatedAgents')}</p>
            ) : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
