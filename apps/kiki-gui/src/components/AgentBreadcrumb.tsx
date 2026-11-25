/**
 * Session > Parent > Current breadcrumb for the agent detail header, and the
 * agent's relations (parent, children, siblings) beneath it.
 */

import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Popover } from '@base-ui/react/popover';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { SessionAgentCounts } from '@kiki/protocol';
import {
  agentChildren,
  MAIN_AGENT_ID,
  type AgentForest,
  type AgentTreeNode,
} from '@kiki/session-core/session';
import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../i18n';
import { getSubagentScaleConfig } from '../lib/subagentScaleConfig';
import { useRemoteSubagentSearch, type SubagentSearchFn } from '../lib/subagentSearch';
import { Icon } from './icons';
import { AnchoredPopover, usePopover } from './overlays';

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
  if (current === undefined) {
    const parent = currentAgentId !== MAIN_AGENT_ID ? forest.byId[MAIN_AGENT_ID] : undefined;
    return { parent, siblings: [], children: [] };
  }
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
  /** When true, render only ancestor crumbs + trailing `/` so the inline `<h1>` leaf follows directly. */
  omitLeaf?: boolean;
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

function isBranchNode(node: AgentTreeNode): boolean {
  return node.isBranch === true || node.branchSealed === true;
}

function branchStateI18nKey(node: AgentTreeNode): I18nKey {
  if (node.branchSealed === true) return 'rail.branches.status.merged';
  if (node.status === 'suspended') return 'rail.branches.status.waiting';
  if (node.status === 'running' || node.status === 'background' || node.busy) return 'rail.branches.status.running';
  if (node.status === 'failed') return 'rail.branches.status.failed';
  return 'rail.branches.status.open';
}

export const AgentBreadcrumb = memo(function AgentBreadcrumb({
  crumbs,
  onOpenSession,
  onOpenAgent,
  omitLeaf = false,
}: AgentBreadcrumbProps) {
  const { t } = useI18n();
  const visible = crumbs.filter((crumb) => crumb.agentId !== MAIN_AGENT_ID);
  const ancestors = omitLeaf ? visible.slice(0, -1) : visible;
  return (
    <nav
      data-agent-breadcrumb
      aria-label={t('sv.sessionCrumb')}
      className={`flex items-center ${ancestors.length > 0 ? 'min-w-0 shrink overflow-hidden' : 'shrink-0'}`}
    >
      <ol className={`flex min-w-0 items-center gap-1 ${omitLeaf ? 'flex-nowrap text-[13px] text-ink-faint' : 'flex-wrap text-[11px] text-ink-faint'}`}>
        <li className="shrink-0">
          <button
            type="button"
            onClick={onOpenSession}
            className="rounded px-0.5 text-ink-faint transition-colors hover:text-ink"
          >
            {t('sv.sessionCrumb')}
          </button>
        </li>
        {ancestors.map((crumb, index) => {
          const last = !omitLeaf && index === ancestors.length - 1;
          const branch = isBranchNode(crumb);
          return (
            <li key={crumb.agentId} className="flex min-w-0 items-center gap-1">
              <span aria-hidden className="shrink-0">/</span>
              {last ? (
                <span
                  data-branch-crumb={branch ? (crumb.branchSealed === true ? 'merged' : 'open') : undefined}
                  className="inline-flex min-w-0 items-center gap-1 truncate font-normal text-ink"
                  aria-current="page"
                >
                  {branch ? (
                    <Icon
                      name="branch"
                      size={12}
                      className={`shrink-0 ${crumb.branchSealed === true ? 'text-ink-faint' : 'text-accent'}`}
                    />
                  ) : null}
                  <span className="truncate">{crumb.label}</span>
                </span>
              ) : (
                <button
                  type="button"
                  data-branch-crumb={branch ? (crumb.branchSealed === true ? 'merged' : 'open') : undefined}
                  onClick={() => { onOpenAgent(crumb.agentId); }}
                  className="inline-flex min-w-0 max-w-[10rem] items-center gap-1 truncate rounded px-0.5 text-ink-faint transition-colors hover:text-ink"
                >
                  {branch ? (
                    <Icon
                      name="branch"
                      size={12}
                      className={`shrink-0 ${crumb.branchSealed === true ? 'text-ink-faint' : 'text-accent'}`}
                    />
                  ) : null}
                  <span className="truncate">{crumb.label}</span>
                </button>
              )}
            </li>
          );
        })}
        {omitLeaf ? (
          <li aria-hidden className="shrink-0">/</li>
        ) : null}
      </ol>
    </nav>
  );
}, (previous, next) =>
  visibleCrumbsEqual(previous.crumbs, next.crumbs) &&
  previous.omitLeaf === next.omitLeaf &&
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
    const branch = isBranchNode(node);
    const seedLabel = branch && node.branchSeed !== undefined
      ? t(`transcript.branch.seed.${node.branchSeed}` as I18nKey)
      : undefined;
    const statusWord = branch
      ? t(branchStateI18nKey(node))
      : t(`subagent.status.${node.status}` as I18nKey);
    const state = [statusWord, seedLabel, elapsed].filter((part) => part !== undefined).join(' · ');
    return [node.label, node.description !== node.label ? node.description : undefined, state]
      .filter((part) => part !== undefined && part !== '')
      .join('\n');
  };
}

const BRANCH_CHIP_OPEN =
  'inline-flex h-6 min-w-0 max-w-[16rem] shrink items-center gap-1.5 rounded-full border border-accent/25 bg-accent/[0.06] px-2 text-[12px] leading-none text-ink transition-colors hover:border-accent/40 hover:bg-accent/[0.1] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink pointer-coarse:h-8';

const BRANCH_CHIP_SEALED =
  'inline-flex h-6 min-w-0 max-w-[16rem] shrink items-center gap-1.5 rounded-full border border-hairline bg-ink/[0.025] px-2 text-[12px] leading-none text-ink-soft transition-colors hover:border-hairline-strong hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink pointer-coarse:h-8';

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
  const branch = isBranchNode(node);
  const sealed = node.branchSealed === true;
  const baseChip = branch ? (sealed ? BRANCH_CHIP_SEALED : BRANCH_CHIP_OPEN) : CHIP;
  return (
    <button
      type="button"
      data-relation={kind}
      data-relation-chip=""
      data-branch-chip={branch ? (sealed ? 'merged' : 'open') : undefined}
      data-agent-id={node.agentId}
      title={title}
      aria-label={kind === 'parent' ? `${parentLabel} ${node.label}` : node.label}
      onClick={() => { onOpen(node.agentId); }}
      // The parent may take its whole line: its name is the way back up.
      className={kind === 'parent' ? baseChip.replace('max-w-[16rem]', 'max-w-full') : baseChip}
    >
      {/* The parent's word is its own quiet label beside an up arrow, never a
          "Parent:" prefix glued to the name; the name keeps the width. */}
      {kind === 'parent' ? (
        <span aria-hidden className="-ml-0.5 flex shrink-0 items-center gap-0.5 text-[11px] text-ink-faint">
          <Icon name="arrowUp" size={12} />
          {parentLabel}
        </span>
      ) : null}
      {branch ? (
        <Icon
          name="branch"
          size={12}
          className={`-ml-0.5 shrink-0 ${sealed ? 'text-ink-faint' : 'text-accent'}`}
        />
      ) : (
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${chipDot(node.status)}`} />
      )}
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
const POPOVER_ROW_HEIGHT = 32;
const POPOVER_HEADER_HEIGHT = 24;
const POPOVER_HINT_HEIGHT = 26;

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
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const pop = usePopover();
  const listScrollRef = useRef<HTMLDivElement>(null);
  const scaleConfig = getSubagentScaleConfig();
  const needle = deferredQuery.trim().toLowerCase();
  const shown = useMemo(
    () => (
      !pop.open
        ? []
        : needle === ''
          ? nodes
          : nodes.filter((node) => `${node.label} ${node.description ?? ''} ${node.agentId}`.toLowerCase().includes(needle))
    ),
    [pop.open, needle, nodes],
  );
  const windowed = pop.open && shown.length > scaleConfig.virtualizeThreshold;
  const virtualizer = useVirtualizer({
    count: windowed ? shown.length : 0,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => POPOVER_ROW_HEIGHT,
    getItemKey: (index) => shown[index]?.agentId ?? index,
    overscan: 6,
    initialRect: { width: 280, height: 288 },
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
  const renderListItem = (node: AgentTreeNode) => {
    const branch = isBranchNode(node);
    const sealed = node.branchSealed === true;
    return (
      <button
        type="button"
        data-agent-id={node.agentId}
        data-branch-item={branch ? (sealed ? 'merged' : 'open') : undefined}
        title={titleOf(node)}
        onClick={() => { pop.setOpen(false); onOpen(node.agentId); }}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:py-2"
      >
        {branch ? (
          <Icon
            name="branch"
            size={12}
            className={`shrink-0 ${sealed ? 'text-ink-faint' : 'text-accent'}`}
          />
        ) : (
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${chipDot(node.status)}`} />
        )}
        <span className="min-w-0 flex-1 truncate">{node.label}</span>
        <span className={`shrink-0 text-[11.5px] ${branch && !sealed ? 'text-accent' : 'text-ink-faint'}`}>
          {branch ? t(branchStateI18nKey(node)) : t(`subagent.status.${node.status}` as I18nKey)}
        </span>
      </button>
    );
  };
  return (
    <>
      <button
        {...pop.triggerProps}
        type="button"
        data-relation-chip=""
        data-relations-toggle={kind}
        title={title}
        className={`${CHIP} ${kind === 'children' ? 'border-dashed tabular-nums' : 'text-ink-faint'}`}
      >
        {icon !== undefined ? <Icon name={icon} size={12} className="-ml-0.5 shrink-0" /> : null}
        {label}
      </button>
      <AnchoredPopover
        {...pop.popoverProps}
        label={listLabel}
        widthClassName="w-72"
        data={{ 'data-relations-popover': kind }}
        className="flex max-h-[min(22rem,60vh)] flex-col p-1"
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
        <div ref={listScrollRef} role="list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {windowed ? (
            <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const node = shown[item.index]!;
                return (
                  <div
                    key={item.key}
                    role="listitem"
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {renderListItem(node)}
                  </div>
                );
              })}
            </div>
          ) : shown.map((node) => (
            <div key={node.agentId} role="listitem">
              {renderListItem(node)}
            </div>
          ))}
          {shown.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-ink-faint">{t('sv.noRelatedAgents')}</p>
          ) : null}
        </div>
      </AnchoredPopover>
    </>
  );
}

function isAgentRunning(node: AgentTreeNode): boolean {
  return node.status === 'running' || node.status === 'background' || node.busy;
}

function hasAnyFamilyRelation(
  forest: AgentForest,
  currentAgentId: string,
  showBreadcrumb: boolean,
  depth: number,
  agentCounts?: SessionAgentCounts,
): boolean {
  if (agentCounts !== undefined && agentCounts.subagents >= LIST_FILTER_AT) return true;
  const current = forest.byId[currentAgentId];
  if (current === undefined) {
    return currentAgentId !== MAIN_AGENT_ID && forest.byId[MAIN_AGENT_ID] !== undefined && (!showBreadcrumb || depth > 1);
  }
  const parentId = current.parentAgentId;
  if (parentId !== undefined && parentId !== MAIN_AGENT_ID && forest.byId[parentId] !== undefined && (!showBreadcrumb || depth > 1)) {
    return true;
  }
  if (current.childIds.some((id) => forest.byId[id] !== undefined)) return true;
  if (parentId === undefined) {
    return forest.roots.some((root) => root.agentId !== currentAgentId && root.parentAgentId === undefined);
  }
  const parentNode = forest.byId[parentId];
  if (parentNode === undefined) return false;
  return parentNode.childIds.some((id) => {
    if (id === currentAgentId) return false;
    const sibling = forest.byId[id];
    return sibling !== undefined && sibling.parentAgentId === parentId;
  });
}

type FamilyVirtualItem =
  | { readonly kind: 'header'; readonly key: string; readonly section: 'parent' | 'children' | 'siblings' | 'search'; readonly label: string; readonly count?: number }
  | { readonly kind: 'agent'; readonly key: string; readonly section: 'parent' | 'child' | 'sibling'; readonly node: AgentTreeNode }
  | { readonly kind: 'hint'; readonly key: string; readonly text: string };

export const AgentFamilyPopover = memo(function AgentFamilyPopover({
  forest,
  currentAgentId,
  name,
  isBranch = false,
  branchSealed = false,
  showBreadcrumb,
  depth = 1,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  filterRunning = false,
  onFilterRunningChange,
  onOpen,
  title,
  agentCounts,
  onSearchSubagents,
}: {
  forest: AgentForest;
  currentAgentId: string;
  name: string;
  isBranch?: boolean;
  branchSealed?: boolean;
  showBreadcrumb: boolean;
  depth?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  filterRunning?: boolean;
  onFilterRunningChange?: (runningOnly: boolean) => void;
  onOpen: (agentId: string) => void;
  title?: string;
  /** Exact server-side counts when local forest holds a bounded recent window. */
  agentCounts?: SessionAgentCounts;
  /** Optional server-backed search callback (`controller.searchSubagents`). */
  onSearchSubagents?: SubagentSearchFn;
}) {
  const { t, locale } = useI18n();
  const titleOf = useChipTitle();
  const scaleConfig = getSubagentScaleConfig();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOnOpenChange !== undefined) controlledOnOpenChange(next);
    else setUncontrolledOpen(next);
    if (!next) {
      setQuery('');
      onFilterRunningChange?.(false);
    }
  };
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const remoteSearch = useRemoteSubagentSearch(
    deferredQuery,
    onSearchSubagents,
    open,
    scaleConfig.searchResultLimit,
  );

  // Cheap O(1) relation presence check while closed: never sort or filter
  // 10,000 children/siblings on every header render.
  const hasFamily = useMemo(
    () => hasAnyFamilyRelation(forest, currentAgentId, showBreadcrumb, depth, agentCounts),
    [forest, currentAgentId, showBreadcrumb, depth, agentCounts],
  );

  const familyData = useMemo(() => {
    if (!open) return null;
    const related = relatedAgentNodes(forest, currentAgentId);
    const parent = related.parent?.agentId === MAIN_AGENT_ID ? undefined : related.parent;
    const showParentSection = parent !== undefined && (!showBreadcrumb || depth > 1);
    const sortedChildren = [...related.children].sort((a, b) => Number(isAgentRunning(b)) - Number(isAgentRunning(a)));
    const sortedSiblings = [...related.siblings].sort((a, b) => Number(isAgentRunning(b)) - Number(isAgentRunning(a)));
    const totalLocal = (showParentSection ? 1 : 0) + sortedChildren.length + sortedSiblings.length;
    const serverSubagents = agentCounts?.subagents ?? 0;
    const showSearch =
      sortedChildren.length >= LIST_FILTER_AT ||
      sortedSiblings.length >= LIST_FILTER_AT ||
      totalLocal >= LIST_FILTER_AT ||
      serverSubagents >= LIST_FILTER_AT;
    return { parent, showParentSection, sortedChildren, sortedSiblings, showSearch };
  }, [open, forest, currentAgentId, showBreadcrumb, depth, agentCounts?.subagents]);

  const items = useMemo((): readonly FamilyVirtualItem[] => {
    if (!open || familyData === null) return [];
    const { parent, showParentSection, sortedChildren, sortedSiblings } = familyData;
    const needle = deferredQuery.trim().toLowerCase();
    const matches = (node: AgentTreeNode): boolean =>
      needle === '' || `${node.label} ${node.description ?? ''} ${node.agentId}`.toLowerCase().includes(needle);
    const cap = scaleConfig.settledRosterWindow;
    const hintText = (shown: number) =>
      locale === 'zh'
        ? `显示最近 ${shown} 项 · 搜索可定位全部`
        : `Showing latest ${shown} · Search to find any`;

    const out: FamilyVirtualItem[] = [];
    const seenIds = new Set<string>([currentAgentId]);

    const visibleParent = !filterRunning && showParentSection && parent !== undefined && matches(parent) ? parent : undefined;
    if (visibleParent !== undefined) {
      seenIds.add(visibleParent.agentId);
      out.push({ kind: 'header', key: 'hdr:parent', section: 'parent', label: t('sv.parentAgents') });
      out.push({ kind: 'agent', key: `parent:${visibleParent.agentId}`, section: 'parent', node: visibleParent });
    }

    const matchedChildren = sortedChildren.filter((node) => (!filterRunning || isAgentRunning(node)) && matches(node));
    const displayChildrenCount =
      needle === '' && !filterRunning && currentAgentId === MAIN_AGENT_ID && agentCounts !== undefined
        ? Math.max(matchedChildren.length, agentCounts.subagents)
        : matchedChildren.length;
    const shownChildren = needle === ''
      ? (() => {
          const active: AgentTreeNode[] = [];
          const settled: AgentTreeNode[] = [];
          for (const node of matchedChildren) {
            if (isAgentRunning(node) || node.status === 'suspended' || (isBranchNode(node) && node.branchSealed !== true)) {
              active.push(node);
            } else if (settled.length < cap) {
              settled.push(node);
            }
          }
          return [...active, ...settled];
        })()
      : matchedChildren;
    if (shownChildren.length > 0) {
      out.push({ kind: 'header', key: 'hdr:children', section: 'children', label: t('sv.childAgents'), count: displayChildrenCount });
      for (const node of shownChildren) {
        seenIds.add(node.agentId);
        out.push({ kind: 'agent', key: `child:${node.agentId}`, section: 'child', node });
      }
      if (needle === '' && displayChildrenCount > shownChildren.length) {
        out.push({ kind: 'hint', key: 'hint:children', text: hintText(shownChildren.length) });
      }
    }

    const matchedSiblings = filterRunning ? [] : sortedSiblings.filter(matches);
    const isDirectMainChild = forest.byId[currentAgentId]?.parentAgentId === MAIN_AGENT_ID;
    const displaySiblingsCount =
      needle === '' && !filterRunning && isDirectMainChild && agentCounts !== undefined
        ? Math.max(matchedSiblings.length, Math.max(0, agentCounts.subagents - 1))
        : matchedSiblings.length;
    const shownSiblings = needle === ''
      ? (() => {
          const active: AgentTreeNode[] = [];
          const settled: AgentTreeNode[] = [];
          for (const node of matchedSiblings) {
            if (isAgentRunning(node) || node.status === 'suspended' || (isBranchNode(node) && node.branchSealed !== true)) {
              active.push(node);
            } else if (settled.length < cap) {
              settled.push(node);
            }
          }
          return [...active, ...settled];
        })()
      : matchedSiblings;
    if (shownSiblings.length > 0) {
      out.push({ kind: 'header', key: 'hdr:siblings', section: 'siblings', label: t('sv.siblingAgents'), count: displaySiblingsCount });
      for (const node of shownSiblings) {
        seenIds.add(node.agentId);
        out.push({ kind: 'agent', key: `sibling:${node.agentId}`, section: 'sibling', node });
      }
      if (needle === '' && displaySiblingsCount > shownSiblings.length) {
        out.push({ kind: 'hint', key: 'hint:siblings', text: hintText(shownSiblings.length) });
      }
    }

    // Merge server-backed search hits not already present locally (deduped by agentId).
    if (needle !== '' && remoteSearch.results.length > 0) {
      const remoteOnly: AgentTreeNode[] = [];
      for (const node of remoteSearch.results) {
        if (seenIds.has(node.agentId)) continue;
        if (filterRunning && !isAgentRunning(node)) continue;
        seenIds.add(node.agentId);
        remoteOnly.push(node);
      }
      if (remoteOnly.length > 0) {
        out.push({
          kind: 'header',
          key: 'hdr:search',
          section: 'search',
          label: locale === 'zh' ? '搜索结果' : 'Search results',
          count: remoteOnly.length,
        });
        for (const node of remoteOnly) {
          out.push({
            kind: 'agent',
            key: `remote:${node.agentId}`,
            section: node.parentAgentId === currentAgentId ? 'child' : 'sibling',
            node,
          });
        }
      }
    }

    return out;
  }, [open, familyData, deferredQuery, filterRunning, currentAgentId, agentCounts, forest.byId, remoteSearch.results, scaleConfig.settledRosterWindow, locale, t]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const windowed = open && items.length > scaleConfig.virtualizeThreshold;
  const virtualizer = useVirtualizer({
    count: windowed ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const entry = items[index];
      if (entry === undefined) return POPOVER_ROW_HEIGHT;
      if (entry.kind === 'header') return POPOVER_HEADER_HEIGHT;
      if (entry.kind === 'hint') return POPOVER_HINT_HEIGHT;
      return POPOVER_ROW_HEIGHT;
    },
    getItemKey: (index) => items[index]?.key ?? index,
    overscan: 6,
    initialRect: { width: 280, height: 304 },
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

  const headingContent = (
    <>
      {isBranch ? (
        <Icon
          name="branch"
          size={14}
          className={`shrink-0 ${branchSealed ? 'text-ink-faint' : 'text-accent'}`}
        />
      ) : null}
      <h1 className="min-w-0 truncate font-display text-[14px] leading-tight font-bold text-ink">
        {name}
      </h1>
    </>
  );

  if (!hasFamily) {
    return (
      <div
        data-branch-crumb={isBranch ? (branchSealed ? 'merged' : 'open') : undefined}
        title={title}
        className="flex min-w-0 items-center gap-1.5"
      >
        {headingContent}
      </div>
    );
  }

  const renderNodeRow = (node: AgentTreeNode, section: 'parent' | 'child' | 'sibling') => {
    const branch = isBranchNode(node);
    const sealed = node.branchSealed === true;
    return (
      <button
        type="button"
        data-agent-id={node.agentId}
        data-family-item={section}
        data-branch-item={branch ? (sealed ? 'merged' : 'open') : undefined}
        title={titleOf(node)}
        onClick={() => { setOpen(false); onOpen(node.agentId); }}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:py-2"
      >
        {section === 'parent' ? (
          <Icon name="arrowUp" size={12} className="shrink-0 text-ink-faint" />
        ) : branch ? (
          <Icon
            name="branch"
            size={12}
            className={`shrink-0 ${sealed ? 'text-ink-faint' : 'text-accent'}`}
          />
        ) : (
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${chipDot(node.status)}`} />
        )}
        <span className="min-w-0 flex-1 truncate">{node.label}</span>
        <span className={`shrink-0 text-[11px] ${branch && !sealed ? 'text-accent' : 'text-ink-faint'}`}>
          {branch ? t(branchStateI18nKey(node)) : t(`subagent.status.${node.status}` as I18nKey)}
        </span>
      </button>
    );
  };

  const renderItem = (item: FamilyVirtualItem) => {
    if (item.kind === 'header') {
      return (
        <div
          data-family-section={item.section}
          className="flex items-center justify-between px-2 py-1 text-[11px] font-normal text-ink-faint"
        >
          <span>{item.label}</span>
          {item.count !== undefined ? <span className="tabular-nums">{item.count}</span> : null}
        </div>
      );
    }
    if (item.kind === 'hint') {
      return (
        <p data-family-window-hint className="px-2 py-1 text-[11px] text-ink-faint">
          {item.text}
        </p>
      );
    }
    return renderNodeRow(item.node, item.section);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        type="button"
        data-agent-family-trigger=""
        data-branch-crumb={isBranch ? (branchSealed ? 'merged' : 'open') : undefined}
        title={title}
        className={`group inline-flex h-8 min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 ${showBreadcrumb ? '-ml-1' : '-ml-1.5'} text-left transition-colors hover:bg-ink/[0.04] aria-expanded:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-selected-ink`}
      >
        {headingContent}
        <Icon
          name="chevron"
          size={12}
          className={`shrink-0 text-ink-faint transition-transform group-hover:text-ink-soft ${open ? '-rotate-90' : 'rotate-90'}`}
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50 outline-none">
          <Popover.Popup
            data-agent-family-popover=""
            aria-label={name}
            className="anim-enter flex w-72 max-h-[min(24rem,var(--available-height,60vh))] flex-col rounded-[10px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_12px_32px_-12px_rgb(var(--kiki-shadow-ink)/0.22)] outline-none"
          >
            {familyData?.showSearch ? (
              <input
                type="search"
                data-agent-family-search=""
                value={query}
                onChange={(event) => { setQuery(event.target.value); }}
                aria-label={t('inspector.searchAgentsAria')}
                placeholder={t('inspector.searchAgents')}
                className="m-1 h-8 shrink-0 rounded-md border border-hairline bg-transparent px-2 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-hairline-strong focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-selected-ink"
              />
            ) : null}
            {filterRunning ? (
              <div className="flex items-center justify-between gap-2 px-2 py-1 text-[11px] text-ink-faint">
                <span>{locale === 'zh' ? '仅看运行中的子智能体' : 'Running children only'}</span>
                <button
                  type="button"
                  onClick={() => { onFilterRunningChange?.(false); }}
                  className="cursor-pointer rounded px-1 text-ink-soft underline-offset-2 hover:text-ink hover:underline"
                >
                  {locale === 'zh' ? '显示全部' : 'Show all'}
                </button>
              </div>
            ) : null}
            <div ref={scrollRef} role="list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {items.length === 0 ? (
                <p className="px-2 py-2 text-[12px] text-ink-faint">
                  {remoteSearch.loading ? (locale === 'zh' ? '搜索中…' : 'Searching…') : t('sv.noRelatedAgents')}
                </p>
              ) : windowed ? (
                <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
                  {virtualizer.getVirtualItems().map((virtualItem) => {
                    const entry = items[virtualItem.index]!;
                    return (
                      <div
                        key={virtualItem.key}
                        role={entry.kind === 'agent' ? 'listitem' : undefined}
                        className="absolute top-0 left-0 w-full"
                        style={{ transform: `translateY(${virtualItem.start}px)` }}
                      >
                        {renderItem(entry)}
                      </div>
                    );
                  })}
                </div>
              ) : (
                items.map((entry) => (
                  <div key={entry.key} role={entry.kind === 'agent' ? 'listitem' : undefined}>
                    {renderItem(entry)}
                  </div>
                ))
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});
