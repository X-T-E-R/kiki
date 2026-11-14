/**
 * Conversation branches in the right rail: parallel side conversations forked
 * from the session (`isBranch` / `branchSealed`), separated from background
 * worker subagents.
 *
 * Open branches lead (waiting -> running -> ready to merge, newest first),
 * followed by up to 5 recent merged branches (`branchSealed === true`) with a
 * quiet disclosure when older merged branches exist.
 */

import { memo, useMemo, useState } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import { MAIN_AGENT_ID, type AgentForest, type AgentTreeNode, type Block } from '@kiki/session-core/session';
import { plainInline } from '@kiki/session-core/util';
import { useI18n } from '../../i18n';
import { displayUserMessageText } from '../message/messageSource';
import { DisclosureChevron, Icon } from '../icons';
import { plainFailure } from './failureText';

export const MERGED_BRANCH_INLINE_LIMIT = 5;

export type BranchLifecycleState = 'waiting' | 'running' | 'open' | 'merged' | 'failed';

export function isSessionBranchNode(node: AgentTreeNode | undefined): node is AgentTreeNode {
  return node !== undefined && node.agentId !== MAIN_AGENT_ID && (node.isBranch === true || node.branchSealed === true);
}

export function branchLifecycleState(node: AgentTreeNode, waiting: ReadonlySet<string>): BranchLifecycleState {
  if (node.branchSealed === true) return 'merged';
  if (waiting.has(node.agentId) || node.status === 'suspended') return 'waiting';
  if (node.status === 'running' || node.status === 'background' || node.busy) return 'running';
  if (node.status === 'failed') return 'failed';
  return 'open';
}

function branchSortRank(state: BranchLifecycleState): number {
  switch (state) {
    case 'waiting':
      return 0;
    case 'running':
      return 1;
    case 'open':
      return 2;
    case 'failed':
      return 3;
    case 'merged':
      return 4;
  }
}

function parseTime(iso: string | undefined): number {
  if (iso === undefined || iso === '') return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function branchRecency(node: AgentTreeNode): number {
  return Math.max(parseTime(node.endedAt), parseTime(node.startedAt), parseTime(node.createdAt));
}

export interface OrderedBranches {
  readonly all: readonly AgentTreeNode[];
  readonly open: readonly AgentTreeNode[];
  readonly merged: readonly AgentTreeNode[];
}

export function collectSessionBranches(
  forest: AgentForest,
  waitingAgentIds: ReadonlySet<string>,
): OrderedBranches {
  const entries = Object.values(forest.byId)
    .filter(isSessionBranchNode)
    .map((node, index) => ({
      node,
      state: branchLifecycleState(node, waitingAgentIds),
      stamp: branchRecency(node),
      index,
    }));

  entries.sort((left, right) => {
    const rankDiff = branchSortRank(left.state) - branchSortRank(right.state);
    if (rankDiff !== 0) return rankDiff;
    const timeDiff = right.stamp - left.stamp;
    if (timeDiff !== 0) return timeDiff;
    return right.index - left.index;
  });

  const all = entries.map((entry) => entry.node);
  const open = entries.filter((entry) => entry.state !== 'merged').map((entry) => entry.node);
  const merged = entries.filter((entry) => entry.state === 'merged').map((entry) => entry.node);
  return { all, open, merged };
}

/** Extract merged/folded branch summary previews from projected timeline blocks. */
export function extractBranchFoldSummaries(blocks: readonly Block[]): ReadonlyMap<string, string> {
  const summaries = new Map<string, string>();
  for (const block of blocks) {
    if (block.kind !== 'user' || block.branchFold === undefined) continue;
    const cleaned = plainInline(displayUserMessageText(block).text).trim();
    if (cleaned !== '') summaries.set(block.branchFold.branchId, cleaned);
  }
  return summaries;
}

function branchPreviewText(
  node: AgentTreeNode,
  state: BranchLifecycleState,
  foldSummary: string | undefined,
): string | undefined {
  if (state === 'failed' && node.error !== undefined) {
    return plainFailure(node.error) ?? plainInline(node.error);
  }
  if (state === 'merged' && foldSummary !== undefined && foldSummary !== '') {
    return foldSummary;
  }
  const summary = node.summary === undefined ? undefined : plainInline(node.summary).trim();
  if (summary !== undefined && summary !== '' && summary !== node.label && summary !== node.agentId) {
    return summary;
  }
  const desc = node.description === undefined ? undefined : plainInline(node.description).trim();
  if (desc !== undefined && desc !== '' && desc !== node.label && desc !== node.agentId) {
    return desc;
  }
  return foldSummary;
}

const BranchRow = memo(function BranchRow({
  node,
  state,
  focused,
  peeked,
  preview,
  onSelect,
}: {
  readonly node: AgentTreeNode;
  readonly state: BranchLifecycleState;
  readonly focused: boolean;
  readonly peeked: boolean;
  readonly preview: string | undefined;
  readonly onSelect: (agentId: string) => void;
}) {
  const { t, time } = useI18n();
  const isMerged = state === 'merged';
  const isRunning = state === 'running';
  const isWaiting = state === 'waiting';

  const statusText = t(`rail.branches.status.${state}` as I18nKey);
  const seedLabel = node.branchSeed !== undefined
    ? t(`transcript.branch.seed.${node.branchSeed}` as I18nKey)
    : undefined;
  const readOnlyLabel = !isMerged && node.toolsLocked === true
    ? t('transcript.branch.toolsLocked')
    : undefined;

  const started = parseTime(node.startedAt);
  const ended = node.endedAt === undefined ? Date.now() : parseTime(node.endedAt);
  const duration = started > 0 && ended >= started ? time.formatDuration(ended - started) : undefined;
  const tooltip = [
    node.label,
    [statusText, seedLabel, readOnlyLabel, node.model, duration].filter((item) => item !== undefined && item !== '').join(' · '),
    preview,
  ].filter((line) => line !== undefined && line !== '').join('\n');

  const guideBarClass = isWaiting
    ? 'bg-attention'
    : isRunning || state === 'open'
      ? 'bg-accent'
      : state === 'failed'
        ? 'bg-danger/70'
        : 'bg-hairline-strong';

  const iconClass = isWaiting
    ? 'text-amber-ink'
    : isRunning || state === 'open'
      ? 'text-accent'
      : 'text-ink-faint';

  const statusClass = isWaiting
    ? 'font-medium text-amber-ink'
    : isRunning
      ? 'font-medium text-accent'
      : state === 'open'
        ? 'text-ink-soft'
        : 'text-ink-faint';

  return (
    <button
      type="button"
      data-branch-row={node.agentId}
      data-branch-state={state}
      data-branch-focused={focused ? '' : undefined}
      aria-current={focused ? 'true' : undefined}
      title={tooltip}
      onClick={() => { onSelect(node.agentId); }}
      className={`group relative -mx-2 flex w-[calc(100%+1rem)] min-w-0 items-stretch gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
        focused
          ? 'bg-accent/[0.08] text-ink'
          : peeked
            ? 'bg-ink/[0.045] text-ink'
            : 'hover:bg-ink/[0.035]'
      }`}
    >
      <span
        aria-hidden
        className={`my-0.5 w-0.5 shrink-0 rounded-full transition-colors ${
          focused ? 'bg-accent' : guideBarClass
        }`}
      />
      <span aria-hidden className={`mt-0.5 flex h-4 w-3.5 shrink-0 items-center justify-center ${iconClass}`}>
        <Icon name="branch" size={14} />
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-[13px] leading-5 ${
              focused ? 'font-medium text-ink' : isMerged ? 'text-ink-soft group-hover:text-ink' : 'text-ink'
            }`}
          >
            {node.label}
          </span>
          <span className={`shrink-0 inline-flex items-center gap-1 text-[11.5px] leading-4 ${statusClass}`}>
            {isRunning ? <span aria-hidden className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" /> : null}
            {statusText}
          </span>
        </span>
        {(seedLabel !== undefined || readOnlyLabel !== undefined || preview !== undefined) ? (
          <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] leading-4 text-ink-faint">
            {seedLabel !== undefined ? (
              <span
                data-branch-seed={node.branchSeed}
                className="shrink-0 rounded border border-hairline px-1 py-px text-[10.5px] leading-3.5 text-ink-soft"
              >
                {seedLabel}
              </span>
            ) : null}
            {readOnlyLabel !== undefined ? (
              <span className="shrink-0 text-[11px] text-ink-faint">{readOnlyLabel}</span>
            ) : null}
            {preview !== undefined ? (
              <span className="min-w-0 flex-1 truncate">{preview}</span>
            ) : null}
          </span>
        ) : null}
      </span>
    </button>
  );
});

export const InspectorBranches = memo(function InspectorBranches({
  branches,
  focusedAgentId,
  peekAgentId,
  waitingAgentIds,
  foldSummaries,
  onSelect,
}: {
  readonly branches: OrderedBranches;
  readonly focusedAgentId: string;
  readonly peekAgentId?: string;
  readonly waitingAgentIds: ReadonlySet<string>;
  readonly foldSummaries: ReadonlyMap<string, string>;
  readonly onSelect: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const [showAllMerged, setShowAllMerged] = useState(false);

  const { visibleMerged, hiddenMergedCount } = useMemo(() => {
    const merged = branches.merged;
    if (showAllMerged || merged.length <= MERGED_BRANCH_INLINE_LIMIT) {
      return { visibleMerged: merged, hiddenMergedCount: 0 };
    }
    const head = merged.slice(0, MERGED_BRANCH_INLINE_LIMIT);
    if (!head.some((node) => node.agentId === focusedAgentId)) {
      const focusedMerged = merged.find((node) => node.agentId === focusedAgentId);
      if (focusedMerged !== undefined) {
        return {
          visibleMerged: [...head.slice(0, MERGED_BRANCH_INLINE_LIMIT - 1), focusedMerged],
          hiddenMergedCount: merged.length - MERGED_BRANCH_INLINE_LIMIT,
        };
      }
    }
    return {
      visibleMerged: head,
      hiddenMergedCount: merged.length - MERGED_BRANCH_INLINE_LIMIT,
    };
  }, [branches.merged, focusedAgentId, showAllMerged]);

  return (
    <div data-branches-list className="space-y-0.5">
      {branches.open.map((node) => {
        const state = branchLifecycleState(node, waitingAgentIds);
        return (
          <BranchRow
            key={node.agentId}
            node={node}
            state={state}
            focused={focusedAgentId === node.agentId}
            peeked={peekAgentId === node.agentId}
            preview={branchPreviewText(node, state, foldSummaries.get(node.agentId))}
            onSelect={onSelect}
          />
        );
      })}
      {visibleMerged.map((node) => (
        <BranchRow
          key={node.agentId}
          node={node}
          state="merged"
          focused={focusedAgentId === node.agentId}
          peeked={peekAgentId === node.agentId}
          preview={branchPreviewText(node, 'merged', foldSummaries.get(node.agentId))}
          onSelect={onSelect}
        />
      ))}
      {branches.merged.length > MERGED_BRANCH_INLINE_LIMIT ? (
        <button
          type="button"
          data-branches-more
          aria-expanded={showAllMerged}
          onClick={() => { setShowAllMerged((open) => !open); }}
          className="-mx-1.5 flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
        >
          <DisclosureChevron open={showAllMerged} />
          <span>
            {showAllMerged
              ? t('rail.branches.hideMerged')
              : t('rail.branches.moreMerged', { count: hiddenMergedCount })}
          </span>
        </button>
      ) : null}
    </div>
  );
});
