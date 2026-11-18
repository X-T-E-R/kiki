/**
 * Pure lineage and turn-anchor projection for forked sessions and exploration branches.
 *
 * Keeps `Transcript`, `Header`, and `ForkLaunchPopover` free of ad-hoc graph walks:
 *   1. Resolves the current session's parent fork origin (`session.forked_from`).
 *   2. Collects child sessions forked from this session (`s.forked_from?.session_id === sessionId`)
 *      alongside non-ephemeral exploration branches (`AgentTreeNode` with `isBranch || branchSealed`,
 *      excluding tool-locked quick `/btw` side questions).
 *   3. Anchors each offshoot to the exact `UserBlock` or closing `AssistantBlock` in the timeline
 *      via `through_message_id` / `branchBaseMessageId` first, then 0-based `turn_index` / `branchBaseTurnId`.
 */

import type { Session, SessionSeedMode } from '@kiki/protocol';
import type { AgentForest, Block } from '@kiki/session-core/session';
import { plainInline } from '@kiki/session-core/util';

import {
  branchLifecycleState,
  collectSessionBranches,
  extractBranchFoldSummaries,
  isEphemeralBtwNode,
  type BranchLifecycleState,
} from '../agent-panel/InspectorBranches';

export interface ForkOriginSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly turnIndex?: number;
  readonly throughMessageId?: string;
  readonly seed?: SessionSeedMode;
}

export interface TimelineOffshootItem {
  readonly key: string;
  readonly kind: 'fork' | 'branch';
  readonly id: string;
  readonly title: string;
  readonly seed?: SessionSeedMode;
  readonly turnIndex?: number;
  readonly messageId?: string;
  readonly throughUserMessage?: boolean;
  readonly createdAtMs: number;
  readonly branchState?: BranchLifecycleState;
  readonly summary?: string;
}

export interface SessionForkLineage {
  readonly origin?: ForkOriginSummary;
  readonly allOffshoots: readonly TimelineOffshootItem[];
  readonly byBlockId: ReadonlyMap<string, readonly TimelineOffshootItem[]>;
}

function parseTimestamp(iso: string | undefined): number {
  if (iso === undefined || iso === '') return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanForkDisplayTitle(
  rawTitle: string,
  parentTitle: string | undefined,
  lastPrompt: string | undefined,
  untitledLabel: string,
): string {
  const trimmed = plainInline(rawTitle).trim();
  const promptText = lastPrompt === undefined ? '' : plainInline(lastPrompt).trim();
  if (trimmed === '') return promptText || untitledLabel;
  if (trimmed.startsWith('Fork: ')) {
    const rest = trimmed.slice(6).trim();
    if (rest !== '' && rest !== parentTitle) return rest;
    if (promptText !== '' && promptText !== parentTitle) return promptText;
    if (rest !== '') return rest;
  }
  return trimmed;
}

function parseTurnIdOrdinal(turnId: string | undefined): number | undefined {
  if (turnId === undefined || !/^t?\d+$/.test(turnId)) return undefined;
  const parsed = Number(turnId.startsWith('t') ? turnId.slice(1) : turnId);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function buildSessionForkLineage(input: {
  readonly currentSessionId: string;
  readonly currentSession: Session | undefined;
  readonly sessions: readonly Session[];
  readonly forest: AgentForest;
  readonly waitingAgentIds: ReadonlySet<string>;
  readonly blocks: readonly Block[];
  readonly hasOlder?: boolean;
  readonly untitledLabel: string;
}): SessionForkLineage {
  const {
    currentSessionId,
    currentSession,
    sessions,
    forest,
    waitingAgentIds,
    blocks,
    hasOlder = false,
    untitledLabel,
  } = input;

  const sessionById = new Map<string, Session>();
  for (const entry of sessions) {
    sessionById.set(entry.id, entry);
  }

  const rawOrigin = currentSession?.forked_from;
  const origin: ForkOriginSummary | undefined =
    rawOrigin !== undefined && rawOrigin.session_id !== '' && rawOrigin.session_id !== currentSessionId
      ? {
          sessionId: rawOrigin.session_id,
          title:
            plainInline(sessionById.get(rawOrigin.session_id)?.title ?? rawOrigin.title ?? '').trim() ||
            untitledLabel,
          turnIndex: rawOrigin.turn_index,
          throughMessageId: rawOrigin.through_message_id,
          seed: rawOrigin.seed,
        }
      : undefined;

  const parentTitle = plainInline(currentSession?.title ?? '').trim() || undefined;

  const forkItems: TimelineOffshootItem[] = [];
  for (const candidate of sessions) {
    if (candidate.id === currentSessionId || candidate.archived === true) continue;
    const from = candidate.forked_from;
    if (from === undefined || from.session_id !== currentSessionId) continue;
    forkItems.push({
      key: `fork:${candidate.id}`,
      kind: 'fork',
      id: candidate.id,
      title: cleanForkDisplayTitle(candidate.title, parentTitle, candidate.last_prompt, untitledLabel),
      seed: from.seed,
      turnIndex: from.turn_index,
      messageId: from.through_message_id,
      throughUserMessage: from.through_user_message,
      createdAtMs: parseTimestamp(from.forked_at ?? candidate.created_at),
      summary: candidate.last_prompt === undefined ? undefined : plainInline(candidate.last_prompt).trim() || undefined,
    });
  }

  const foldSummaries = extractBranchFoldSummaries(blocks);
  const orderedBranches = collectSessionBranches(forest, waitingAgentIds);
  const branchItems: TimelineOffshootItem[] = [];
  for (const node of orderedBranches.all) {
    if (isEphemeralBtwNode(node)) continue;
    const state = branchLifecycleState(node, waitingAgentIds);
    const foldSummary = foldSummaries.get(node.agentId);
    branchItems.push({
      key: `branch:${node.agentId}`,
      kind: 'branch',
      id: node.agentId,
      title: plainInline(node.label).trim() || node.agentId,
      seed: node.branchSeed,
      turnIndex: node.branchBaseTurnId,
      messageId: node.branchBaseMessageId,
      throughUserMessage: false,
      createdAtMs: Math.max(
        parseTimestamp(node.endedAt),
        parseTimestamp(node.startedAt),
        parseTimestamp(node.createdAt),
      ),
      branchState: state,
      summary:
        foldSummary !== undefined && foldSummary !== ''
          ? foldSummary
          : node.summary === undefined
            ? undefined
            : plainInline(node.summary).trim() || undefined,
    });
  }

  const allOffshoots = [...branchItems, ...forkItems].sort((left, right) => {
    const leftActive = left.kind === 'branch' && left.branchState !== 'merged' ? 0 : 1;
    const rightActive = right.kind === 'branch' && right.branchState !== 'merged' ? 0 : 1;
    if (leftActive !== rightActive) return leftActive - rightActive;
    return right.createdAtMs - left.createdAtMs;
  });

  if (allOffshoots.length === 0 || blocks.length === 0) {
    return { origin, allOffshoots, byBlockId: new Map() };
  }

  const blockIdByMessageId = new Map<string, string>();
  const blockTurnOrdinalById = new Map<string, number>();
  const turnClosingBlockByTurnId = new Map<number, { userBlockId?: string; closingBlockId: string }>();
  const sequentialTurns: { userBlockId: string; closingBlockId: string }[] = [];
  let activeSequentialIndex = -1;

  for (const block of blocks) {
    if (block.kind === 'user') {
      blockIdByMessageId.set(block.id, block.id);
      if (block.userMessageId !== undefined && block.userMessageId !== '') {
        blockIdByMessageId.set(block.userMessageId, block.id);
      }
      const turnOrdinal = parseTurnIdOrdinal(block.turnId);
      if (turnOrdinal !== undefined) {
        blockTurnOrdinalById.set(block.id, turnOrdinal);
        if (block.userMessageId !== undefined && block.userMessageId !== '') {
          blockTurnOrdinalById.set(block.userMessageId, turnOrdinal);
        }
        const existing = turnClosingBlockByTurnId.get(turnOrdinal);
        turnClosingBlockByTurnId.set(turnOrdinal, {
          userBlockId: existing?.userBlockId ?? block.id,
          closingBlockId: block.id,
        });
      }
      if (block.branchFold === undefined && block.agentMessage === undefined) {
        sequentialTurns.push({ userBlockId: block.id, closingBlockId: block.id });
        activeSequentialIndex = sequentialTurns.length - 1;
      } else {
        activeSequentialIndex = -1;
      }
    } else if (block.kind === 'assistant') {
      blockIdByMessageId.set(block.id, block.id);
      if (block.messageId !== undefined && block.messageId !== '') {
        blockIdByMessageId.set(block.messageId, block.id);
      }
      const turnOrdinal = parseTurnIdOrdinal(block.turnId);
      if (turnOrdinal !== undefined) {
        blockTurnOrdinalById.set(block.id, turnOrdinal);
        if (block.messageId !== undefined && block.messageId !== '') {
          blockTurnOrdinalById.set(block.messageId, turnOrdinal);
        }
        const existing = turnClosingBlockByTurnId.get(turnOrdinal);
        turnClosingBlockByTurnId.set(turnOrdinal, {
          userBlockId: existing?.userBlockId,
          closingBlockId: block.id,
        });
      }
      if (activeSequentialIndex >= 0) {
        sequentialTurns[activeSequentialIndex]!.closingBlockId = block.id;
      }
    }
  }

  const bucketed = new Map<string, TimelineOffshootItem[]>();
  const appendAt = (blockId: string, item: TimelineOffshootItem) => {
    const list = bucketed.get(blockId);
    if (list !== undefined) {
      list.push(item);
    } else {
      bucketed.set(blockId, [item]);
    }
  };

  for (const item of allOffshoots) {
    let targetBlockId =
      item.messageId !== undefined ? blockIdByMessageId.get(item.messageId) : undefined;

    if (targetBlockId !== undefined && item.kind === 'branch') {
      const matchedTurn = blockTurnOrdinalById.get(targetBlockId) ?? item.turnIndex;
      if (matchedTurn !== undefined) {
        const byTurn = turnClosingBlockByTurnId.get(matchedTurn);
        if (byTurn !== undefined) {
          targetBlockId = byTurn.closingBlockId;
        }
      }
    }

    if (targetBlockId === undefined && item.turnIndex !== undefined) {
      if (item.kind === 'branch') {
        const byTurnId = turnClosingBlockByTurnId.get(item.turnIndex);
        if (byTurnId !== undefined) {
          targetBlockId =
            item.throughUserMessage === true && byTurnId.userBlockId !== undefined
              ? byTurnId.userBlockId
              : byTurnId.closingBlockId;
        } else if (
          !hasOlder &&
          !turnClosingBlockByTurnId.has(0) &&
          item.turnIndex >= 0 &&
          item.turnIndex < sequentialTurns.length
        ) {
          const seq = sequentialTurns[item.turnIndex]!;
          targetBlockId = item.throughUserMessage === true ? seq.userBlockId : seq.closingBlockId;
        }
      } else if (!hasOlder && item.turnIndex >= 0 && item.turnIndex < sequentialTurns.length) {
        const seq = sequentialTurns[item.turnIndex]!;
        targetBlockId = item.throughUserMessage === true ? seq.userBlockId : seq.closingBlockId;
      } else {
        const byTurnId = turnClosingBlockByTurnId.get(item.turnIndex);
        if (byTurnId !== undefined) {
          targetBlockId =
            item.throughUserMessage === true && byTurnId.userBlockId !== undefined
              ? byTurnId.userBlockId
              : byTurnId.closingBlockId;
        }
      }
    }

    if (targetBlockId !== undefined) {
      appendAt(targetBlockId, item);
    }
  }

  return { origin, allOffshoots, byBlockId: bucketed };
}
