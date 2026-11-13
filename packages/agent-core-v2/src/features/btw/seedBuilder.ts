import { z } from 'zod';

import { createCompactionSummaryMessage, isRealUserInput } from '#/agent/contextMemory/compactionHandoff';
import { trimToSettledContextMessages } from '#/agent/contextMemory/settledTrim';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { relayFileReads, renderRelay, type RelayInput } from '#/agent/fullCompaction/relayPackage';
import type { TodoItem } from '#/session/todo/todoItem';
import type { NotesMeta, TodoNotes } from '#/session/todo/todoNotes';

export const SessionSeedModeSchema = z.enum(['fresh', 'compact', 'verbatim']);

export type SessionSeedMode = z.infer<typeof SessionSeedModeSchema>;

export const SessionSeedCarrySchema = z.union([
  z.object({ last: z.number().int().nonnegative() }).strict(),
  z.object({ fromMessageId: z.string().trim().min(1) }).strict(),
]);

export type SessionSeedCarry = z.infer<typeof SessionSeedCarrySchema>;

export const DEFAULT_FRESH_CARRY_USER_TURNS = 2;

export interface BuildBranchSeedInput {
  readonly mode: SessionSeedMode;
  readonly carry?: SessionSeedCarry;
  readonly sourceHistory: readonly ContextMessage[];
  readonly sourceAgentId: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly notes?: TodoNotes;
  readonly meta?: NotesMeta;
  readonly todos: readonly TodoItem[];
  readonly estimateText: (text: string) => number;
  readonly summarize?: (history: readonly ContextMessage[], compactCount: number) => Promise<string | undefined>;
}

export interface BuiltBranchSeed {
  readonly messages: readonly ContextMessage[];
  readonly inheritedCount: number;
  readonly baseAnchor?: {
    readonly turnId?: number;
    readonly messageId?: string;
  };
}

export function resolveSeedCarryStartIndex(
  settled: readonly ContextMessage[],
  carry: SessionSeedCarry | undefined,
  defaultLastUserTurns = DEFAULT_FRESH_CARRY_USER_TURNS,
): number {
  if (settled.length === 0) return 0;
  if (carry !== undefined && 'fromMessageId' in carry) {
    const idx = settled.findIndex((msg) => msg.id === carry.fromMessageId);
    return idx >= 0 ? idx : settled.length;
  }
  const last = carry !== undefined && 'last' in carry ? carry.last : defaultLastUserTurns;
  if (last <= 0) return settled.length;
  let found = 0;
  for (let i = settled.length - 1; i >= 0; i--) {
    const msg = settled[i]!;
    if (isRealUserInput(msg)) {
      found++;
      if (found >= last) {
        let start = i;
      while (start > 0) {
        const prevOrigin = settled[start - 1]?.origin;
        if (prevOrigin?.kind === 'injection' && prevOrigin.ownerPromptId === msg.id) {
          start--;
          continue;
        }
        break;
      }
      return start;
      }
    }
  }
  return 0;
}

export function extractSeedBaseAnchor(
  settled: readonly ContextMessage[],
): { readonly turnId?: number; readonly messageId?: string } | undefined {
  for (let i = settled.length - 1; i >= 0; i--) {
    const msg = settled[i]!;
    const turnId = msg.source?.turnId;
    const messageId = msg.id;
    if (turnId !== undefined || messageId !== undefined) {
      return { turnId, messageId };
    }
  }
  return undefined;
}

export async function buildBranchSeedMessages(input: BuildBranchSeedInput): Promise<BuiltBranchSeed> {
  const settled = trimToSettledContextMessages(input.sourceHistory);
  const baseAnchor = extractSeedBaseAnchor(settled);
  if (input.mode === 'verbatim') {
    const messages = settled.map((msg) => msg.inheritedSeed === true ? msg : { ...msg, inheritedSeed: true });
    return {
      messages,
      inheritedCount: messages.length,
      baseAnchor,
    };
  }
  const carryStart = resolveSeedCarryStartIndex(settled, input.carry, DEFAULT_FRESH_CARRY_USER_TURNS);
  const compactCount = carryStart;
  const carriedTail = settled.slice(carryStart).map((msg) => msg.inheritedSeed === true ? msg : { ...msg, inheritedSeed: true });
  if (compactCount === 0 && input.notes === undefined && input.todos.length === 0) {
    return {
      messages: carriedTail,
      inheritedCount: carriedTail.length,
      baseAnchor,
    };
  }
  const relayInput: RelayInput = {
    history: settled,
    compactCount,
    agentId: input.sourceAgentId,
    sessionId: input.sessionId,
    epoch: input.epoch,
    notes: input.notes,
    meta: input.meta,
    todos: input.todos,
    estimateText: input.estimateText,
  };
  let summaryText: string | undefined;
  if (input.mode === 'compact' && compactCount > 0 && input.summarize !== undefined) {
    summaryText = await input.summarize(settled, compactCount);
  }
  if (summaryText === undefined) {
    summaryText = renderRelay(relayInput);
  }
  const fileReads = relayFileReads(relayInput);
  const handoffMessage: ContextMessage = {
    ...createCompactionSummaryMessage(summaryText),
    origin: {
      kind: 'compaction_summary',
      fileReads: fileReads.entries.length > 0 || fileReads.omitted > 0 ? fileReads : undefined,
    },
    inheritedSeed: true,
  };
  const messages = [handoffMessage, ...carriedTail];
  return {
    messages,
    inheritedCount: messages.length,
    baseAnchor,
  };
}
