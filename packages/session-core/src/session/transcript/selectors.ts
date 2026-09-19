import type { Session, SessionPendingInteraction } from '@kiki/protocol';
import type { AgentTranscriptSnapshot, TranscriptItem } from '@kiki/transcript';

import type { AgentTranscriptResponse } from '../../transport';
import { MAIN_AGENT_ID, countToolBlocks, type AgentForest, type AgentTreeNode } from '../agentTree';
import { bump, type ApprovalBlock, type ApprovalResolution, type Block, type FloorEntry, type QueuedPromptPreview, type QuestionBlock, type QuestionOutcome, type SessionViewState, type SubagentBlock, type UserBlock } from './types';

export function queuedPromptPreviews(state: SessionViewState): readonly QueuedPromptPreview[] {
  return state.queuedPromptIds.map((promptId) => {
    const block = state.blocks.find(
      (candidate): candidate is UserBlock => candidate.kind === 'user' && candidate.promptId === promptId,
    );
    const meta = state.queuedPromptMeta[promptId];
    return { promptId, text: block?.text ?? '', appendTiming: meta?.appendTiming ?? 'agent_idle', revision: meta?.revision };
  });
}

export function pendingApprovalCount(state: SessionViewState): number {
  return state.blocks.filter((block) => block.kind === 'approval' && block.resolution === undefined).length;
}

export function pendingQuestionCount(state: SessionViewState): number {
  return state.blocks.filter((block) => block.kind === 'question' && block.outcome === undefined).length;
}

export function derivePendingInteraction(state: SessionViewState): SessionPendingInteraction {
  if (pendingApprovalCount(state) > 0) return 'approval';
  if (pendingQuestionCount(state) > 0) return 'question';
  return 'none';
}

export function subagentBlocksFromState(state: SessionViewState): readonly SubagentBlock[] {
  return state.blocks.filter((block): block is SubagentBlock => block.kind === 'subagent');
}

export function setLoadingOlder(state: SessionViewState, loading: boolean): SessionViewState {
  const olderError = loading ? undefined : state.olderError;
  if (state.loadingOlder === loading && state.olderError === olderError) return state;
  return bump(state, { loadingOlder: loading, olderError });
}

export function setOlderError(state: SessionViewState, error: string | undefined): SessionViewState {
  if (state.olderError === error && !state.loadingOlder) return state;
  return bump(state, { olderError: error, loadingOlder: false });
}

export function setResyncing(state: SessionViewState, resyncing: boolean): SessionViewState {
  if (state.resyncing === resyncing) return state;
  return bump(state, { resyncing });
}

export function setResyncFailed(state: SessionViewState, failed: boolean, attempt: number): SessionViewState {
  if (state.resyncFailed === failed && state.resyncAttempt === attempt) return state;
  return bump(state, { resyncFailed: failed, resyncAttempt: attempt });
}

export function setLoadError(state: SessionViewState, error: string | undefined): SessionViewState {
  return bump(state, { loadError: error, loaded: error === undefined ? state.loaded : false });
}

export function setSessionRecord(state: SessionViewState, session: Session): SessionViewState {
  return bump(state, { session, profile: session.agent_config.profile ?? state.profile });
}

export function setTasks(state: SessionViewState, tasks: SessionViewState['tasks']): SessionViewState {
  return bump(state, { tasks });
}

export function setGoal(
  state: SessionViewState,
  goal: SessionViewState['goal'],
  updatedAt?: string,
): SessionViewState {
  return bump(state, { goal, goalUpdatedAt: updatedAt ?? state.goalUpdatedAt });
}

function replaceBlock(blocks: readonly Block[], updated: Block): Block[] {
  const index = blocks.findIndex((block) => block.id === updated.id);
  if (index < 0) return [...blocks, updated];
  const next = blocks.slice();
  next[index] = updated;
  return next;
}

export function markApprovalResolved(
  state: SessionViewState,
  approvalId: string,
  resolution: ApprovalResolution,
): SessionViewState {
  const key = `approval-${approvalId}`;
  const existing = state.blocks.find((block) => block.id === key) as ApprovalBlock | undefined;
  if (existing === undefined) return state;
  const blocks = replaceBlock(state.blocks, { ...existing, resolution });
  return bump(state, { blocks, pendingInteraction: derivePendingInteraction({ ...state, blocks }) });
}

export function markQuestionOutcome(
  state: SessionViewState,
  questionId: string,
  outcome: QuestionOutcome,
): SessionViewState {
  const key = `question-${questionId}`;
  const existing = state.blocks.find((block) => block.id === key) as QuestionBlock | undefined;
  if (existing === undefined) return state;
  const blocks = replaceBlock(state.blocks, { ...existing, outcome });
  return bump(state, { blocks, pendingInteraction: derivePendingInteraction({ ...state, blocks }) });
}

const FLOOR_PREVIEW_CODEPOINTS = 24;

export function floorPreview(text: string): string {
  const firstLine = text.split('\n', 1)[0] ?? '';
  const points = Array.from(firstLine.trim());
  return points.length > FLOOR_PREVIEW_CODEPOINTS
    ? `${points.slice(0, FLOOR_PREVIEW_CODEPOINTS).join('')}…`
    : points.join('');
}

export function buildFloorEntries(blocks: readonly Block[]): FloorEntry[] {
  const entries: FloorEntry[] = [];
  for (const block of blocks) {
    if (block.kind !== 'user') continue;
    entries.push({ blockId: block.id, preview: floorPreview(block.text) });
  }
  return entries;
}

export function resolveActiveFloorId(
  positions: readonly { blockId: string; top: number }[],
  viewportTop: number,
  slack = 80,
): string | undefined {
  const threshold = viewportTop + slack;
  let low = 0;
  let high = positions.length - 1;
  let active = -1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const position = positions[middle];
    if (position !== undefined && position.top <= threshold) {
      active = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return active < 0 ? undefined : positions[active]?.blockId;
}

export function visibleSubagentIdsForParent(forest: AgentForest, parentAgentId: string): ReadonlySet<string> {
  return new Set(forest.byId[parentAgentId]?.childIds ?? []);
}

export function filterBlocksToDirectChildren(
  blocks: readonly Block[],
  forest: AgentForest,
  parentAgentId: string,
): Block[] {
  const parent = forest.byId[parentAgentId];
  const visible = parent === undefined ? undefined : new Set(parent.childIds);
  return blocks.filter((block) => {
    if (block.kind !== 'subagent' && block.kind !== 'subagent-event') return true;
    if (visible !== undefined) return visible.has(block.subagentId);
    const hinted = forest.byId[block.subagentId]?.parentAgentId ?? block.parentAgentId;
    return hinted === undefined || hinted === parentAgentId;
  });
}

export function nodeForAgent(forest: AgentForest, agentId: string): AgentTreeNode | undefined {
  return forest.byId[agentId];
}

function transcriptItemId(item: TranscriptItem): string {
  if (item.kind === 'turn') return item.turnId;
  if (item.kind === 'marker') return item.markerId;
  return item.refId;
}

export function emptyOlderSnapshot(): AgentTranscriptSnapshot {
  return {
    items: [],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
    hasMoreOlder: false,
  };
}

export function agentTranscriptPageFromResponse(
  response: AgentTranscriptResponse,
  blocks: readonly Block[],
): {
  readonly blocks: readonly Block[];
  readonly hasMore: boolean;
  readonly oldestTurnId: string | undefined;
  readonly seq: number | undefined;
  readonly model: string | undefined;
  readonly thinkingEffort: string | undefined;
  readonly contextTokens: number | undefined;
  readonly maxContextTokens: number | undefined;
  readonly usage: unknown;
  readonly busy: undefined;
  readonly toolCallCount: number;
  readonly toolCallCountKnown?: boolean;
} {
  const firstTurn = response.items.find((item) => item.kind === 'turn');
  const visibleToolCallCount = countToolBlocks(blocks);
  const suppliedToolCallCount = response.tool_call_count;
  return {
    blocks,
    hasMore: response.has_more,
    oldestTurnId: firstTurn?.kind === 'turn' ? firstTurn.turnId : undefined,
    seq: response.seq,
    model: response.meta?.agent?.model,
    thinkingEffort: response.meta?.agent?.thinkingEffort,
    contextTokens: response.meta?.agent?.contextTokens,
    maxContextTokens: response.meta?.agent?.maxContextTokens,
    usage: response.meta?.agent?.usage,
    busy: undefined,
    toolCallCount: Math.max(suppliedToolCallCount ?? 0, visibleToolCallCount),
    toolCallCountKnown: suppliedToolCallCount !== undefined,
  };
}

export function oldestTurnIdFromResponse(response: AgentTranscriptResponse | undefined): string | undefined {
  if (response === undefined) return undefined;
  const firstTurn = response.items.find((item) => item.kind === 'turn');
  return firstTurn?.kind === 'turn' ? firstTurn.turnId : undefined;
}

export { MAIN_AGENT_ID, transcriptItemId };
