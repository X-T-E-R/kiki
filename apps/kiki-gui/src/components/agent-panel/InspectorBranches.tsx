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
import type { AgentForest, AgentTreeNode, Block } from '@kiki/session-core/session';
import { plainInline } from '@kiki/session-core/util';
import { useI18n } from '../../i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import { usePromoteAgent } from '../../lib/usePromoteAgent';
import { DisclosureChevron } from '../icons';
import { MiniContextMenu, type MiniMenuEntry } from '../MiniContextMenu';
import {
  branchLifecycleState,
  collectSessionBranches,
  extractBranchFoldSummaries,
  isEphemeralBtwNode,
  isSessionBranchNode,
  MERGED_BRANCH_INLINE_LIMIT,
  type BranchLifecycleState,
  type OrderedBranches,
} from './branchModel';
import { plainFailure } from './failureText';

export {
  branchLifecycleState,
  collectSessionBranches,
  extractBranchFoldSummaries,
  isEphemeralBtwNode,
  isSessionBranchNode,
  MERGED_BRANCH_INLINE_LIMIT,
  type BranchLifecycleState,
  type OrderedBranches,
};

function parseTime(iso: string | undefined): number {
  if (iso === undefined || iso === '') return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
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
  sessionId,
  node,
  state,
  focused,
  peeked,
  preview,
  onSelect,
}: {
  readonly sessionId: string | undefined;
  readonly node: AgentTreeNode;
  readonly state: BranchLifecycleState;
  readonly focused: boolean;
  readonly peeked: boolean;
  readonly preview: string | undefined;
  readonly onSelect: (agentId: string) => void;
}) {
  const { t, time, locale } = useI18n();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const promote = usePromoteAgent(sessionId, node.agentId);
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

  const dotClass = isWaiting
    ? 'bg-attention'
    : isRunning
      ? 'status-dot-busy bg-accent'
      : state === 'open'
        ? 'bg-accent/70'
        : state === 'failed'
          ? 'bg-danger/70'
          : 'border border-ink-faint/60';

  const statusClass = isWaiting
    ? 'text-amber-ink'
    : isRunning
      ? 'text-accent'
      : state === 'open'
        ? 'text-ink-soft'
        : 'text-ink-faint';

  const menuEntries = useMemo<readonly MiniMenuEntry[]>(() => {
    const list: MiniMenuEntry[] = [
      {
        key: 'open-branch',
        label: t('file.openPreview'),
        run: () => { onSelect(node.agentId); },
      },
    ];
    if (promote !== undefined) {
      list.push({
        key: 'promote-branch',
        label: t(promote.pending ? 'agent.promotePending' : 'transcript.branch.promote'),
        disabled: promote.pending,
        run: promote.promote,
      });
    }
    list.push({ separator: true });
    list.push({
      key: 'copy-branch-id',
      label: locale === 'zh' ? '复制分支 ID' : 'Copy branch ID',
      run: () => copyTextToClipboard(node.agentId),
    });
    return list;
  }, [locale, node.agentId, onSelect, promote, t]);

  return (
    <div
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      className="group relative -mx-1.5 w-[calc(100%+0.75rem)] min-w-0"
    >
    <button
      type="button"
      data-branch-row={node.agentId}
      data-branch-state={state}
      data-branch-focused={focused ? '' : undefined}
      aria-current={focused ? 'true' : undefined}
      title={tooltip}
      onClick={() => { onSelect(node.agentId); }}
      className={`flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
        focused
          ? 'bg-accent/[0.08] text-ink'
          : peeked
            ? 'bg-ink/[0.045] text-ink'
            : 'hover:bg-ink/[0.04]'
      }`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
      <span
        className={`min-w-0 flex-1 truncate text-[12.5px] leading-5 ${
          focused ? 'font-normal text-ink' : isMerged ? 'text-ink-soft group-hover:text-ink' : 'text-ink'
        }`}
      >
        {node.label}
      </span>
      <span className={`shrink-0 text-[11.5px] leading-4 ${statusClass}${promote === undefined ? '' : promote.pending ? ' invisible' : ' group-has-[[data-promote-branch-action]:focus-visible]:invisible group-hover:invisible'}`}>
        {statusText}
      </span>
    </button>
    {promote !== undefined ? (
      <button
        type="button"
        data-promote-branch-action={node.agentId}
        disabled={promote.pending}
        title={t('transcript.branch.promote')}
        onClick={promote.promote}
        className={`absolute right-1 top-1/2 h-5 -translate-y-1/2 cursor-pointer rounded bg-panel px-1.5 text-[11.5px] leading-5 text-ink-soft shadow-[0_0_0_1px_rgb(var(--kiki-shadow-ink)/0.08)] transition-opacity hover:text-ink focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-selected-ink group-hover:pointer-events-auto group-hover:opacity-100 disabled:cursor-not-allowed disabled:text-ink-faint ${promote.pending ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
      >
        {t(promote.pending ? 'agent.promotePending' : 'transcript.branch.promote')}
      </button>
    ) : null}
    {menu !== null ? (
      <MiniContextMenu
        x={menu.x}
        y={menu.y}
        entries={menuEntries}
        onClose={() => { setMenu(null); }}
        ariaLabel={node.label}
        overlayId="branch-row-menu"
        dataAttribute="data-branch-row-menu"
      />
    ) : null}
    </div>
  );
});

export const InspectorBranches = memo(function InspectorBranches({
  sessionId,
  branches,
  focusedAgentId,
  peekAgentId,
  waitingAgentIds,
  foldSummaries,
  onSelect,
}: {
  readonly sessionId?: string;
  readonly branches: OrderedBranches;
  readonly focusedAgentId: string;
  readonly peekAgentId?: string;
  readonly waitingAgentIds: ReadonlySet<string>;
  readonly foldSummaries: ReadonlyMap<string, string>;
  readonly onSelect: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const hasOpen = branches.open.length > 0;
  const focusedIsMerged = branches.merged.some((node) => node.agentId === focusedAgentId);
  const [mergedOpen, setMergedOpen] = useState(focusedIsMerged);
  const [showAllMerged, setShowAllMerged] = useState(false);

  const showMergedList = !hasOpen || mergedOpen || focusedIsMerged;
  const { visibleMerged, hiddenMergedCount } = useMemo(() => {
    const merged = branches.merged;
    if (!showMergedList) return { visibleMerged: [] as readonly AgentTreeNode[], hiddenMergedCount: merged.length };
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
  }, [branches.merged, focusedAgentId, showAllMerged, showMergedList]);

  return (
    <div data-branches-list className="space-y-0.5">
      {branches.open.map((node) => {
        const state = branchLifecycleState(node, waitingAgentIds);
        return (
          <BranchRow
            key={node.agentId}
            sessionId={sessionId}
            node={node}
            state={state}
            focused={focusedAgentId === node.agentId}
            peeked={peekAgentId === node.agentId}
            preview={branchPreviewText(node, state, foldSummaries.get(node.agentId))}
            onSelect={onSelect}
          />
        );
      })}
      {hasOpen && branches.merged.length > 0 ? (
        <button
          type="button"
          data-branches-more
          aria-expanded={showMergedList}
          onClick={() => { setMergedOpen((open) => !open); }}
          className="-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
        >
          <DisclosureChevron open={showMergedList} />
          <span className="min-w-0 flex-1 truncate">
            {showMergedList
              ? t('rail.branches.hideMerged')
              : `${t('rail.branches.status.merged')} · ${branches.merged.length}`}
          </span>
        </button>
      ) : null}
      {visibleMerged.map((node) => (
        <BranchRow
          key={node.agentId}
          sessionId={sessionId}
          node={node}
          state="merged"
          focused={focusedAgentId === node.agentId}
          peeked={peekAgentId === node.agentId}
          preview={branchPreviewText(node, 'merged', foldSummaries.get(node.agentId))}
          onSelect={onSelect}
        />
      ))}
      {showMergedList && branches.merged.length > MERGED_BRANCH_INLINE_LIMIT ? (
        <button
          type="button"
          data-branches-more-merged
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
