/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import {
  BranchBase,
  ContextAppendLoopEvent,
  ContextAppendMessage,
  ContextClear,
  ContextUndo,
} from '#/agent/contextMemory/contextEvents';
import type { LoopRecordedEvent } from '#/agent/contextMemory/loopEventFold';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded, TurnPrompt } from '#/agent/loop/turnOps';
import { PromptSteered } from '#/agent/prompt/promptService';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

const agentToolLockChangedSchema = z.object({
  locked: z.boolean(),
}).strict();

export class AgentToolLockChanged extends Event2<z.infer<typeof agentToolLockChangedSchema>> {
  static override readonly type = 'agent.tool_lock_changed';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = agentToolLockChangedSchema;
}
export interface AgentToolLockChanged extends z.infer<typeof agentToolLockChangedSchema> {}

const agentBranchSealedSchema = z.object({
  sealed: z.boolean(),
  foldId: z.string().min(1).optional(),
  workSeq: z.number().int().nonnegative().optional(),
});

export class AgentBranchSealed extends Event2<z.infer<typeof agentBranchSealedSchema>> {
  static override readonly type = 'agent.branch_sealed';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = agentBranchSealedSchema;
}
export interface AgentBranchSealed extends z.infer<typeof agentBranchSealedSchema> {}

const branchTurnMergedSchema = z.object({
  turnId: z.number().int().nonnegative(),
  foldId: z.string().min(1).optional(),
  done: z.boolean().optional(),
  workSeq: z.number().int().nonnegative().optional(),
});

export class BranchTurnMerged extends Event2<z.infer<typeof branchTurnMergedSchema>> {
  static override readonly type = 'agent.branch_turn_merged';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = branchTurnMergedSchema;
}
export interface BranchTurnMerged extends z.infer<typeof branchTurnMergedSchema> {}

/** Returns true when a context message represents newly consumed branch input rather than housekeeping reminders. */
export function isBranchConsumedMessage(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  return message.origin?.kind !== 'injection' && message.origin?.kind !== 'compaction_summary';
}

/** Returns true when a loop event represents new post-checkpoint branch tool work outside the Merge handoff itself. */
export function isBranchConsumedLoopEvent(event: LoopRecordedEvent): boolean {
  return event.type === 'tool.call' && event.name !== 'Merge';
}

const branchCoverageSchema = z.object({
  turnId: z.number().int().nonnegative(),
  workSeq: z.number().int().nonnegative(),
  remainingSeedMessages: z.number().int().nonnegative().optional(),
  hasStartedTurn: z.boolean().optional(),
  coveredTurnId: z.number().int().nonnegative().optional(),
  coveredWorkSeq: z.number().int().nonnegative().optional(),
  throughTurnId: z.number().int().nonnegative().optional(),
  lastFoldId: z.string().min(1).optional(),
  lastFoldDone: z.boolean().optional(),
  completedFoldIds: z.array(z.string().min(1)).optional(),
});

export type BranchCoverageState = z.infer<typeof branchCoverageSchema>;

/** Returns true when the latest final checkpoint covers all consumed work recorded on this branch so far. */
export function isBranchWorkCovered(
  state: Pick<BranchCoverageState, 'turnId' | 'workSeq' | 'coveredTurnId' | 'coveredWorkSeq'>,
): boolean {
  if (state.coveredTurnId === undefined || state.coveredWorkSeq === undefined) return false;
  if (state.turnId < state.coveredTurnId) return true;
  if (state.turnId > state.coveredTurnId) return false;
  return state.workSeq <= state.coveredWorkSeq;
}

export const branchCoverageKey = defineState('branch.coverage', (): BranchCoverageState => ({ turnId: 0, workSeq: 0 }))
  .replayable({ schema: branchCoverageSchema })
  .on(BranchBase, (state, event) => {
    state.remainingSeedMessages = event.inheritedCount;
  })
  .on(TurnPrompt, (state, event) => {
    state.remainingSeedMessages = undefined;
    if (event.turnId !== undefined) {
      if (state.hasStartedTurn === true && state.turnId === event.turnId) return;
      state.hasStartedTurn = true;
      state.turnId = event.turnId;
      state.workSeq = 1;
      return;
    }
    state.workSeq += 1;
  })
  .on(TurnStarted, (state, event) => {
    state.remainingSeedMessages = undefined;
    if (state.hasStartedTurn === true && state.turnId === event.turnId) return;
    state.hasStartedTurn = true;
    state.turnId = event.turnId;
    state.workSeq = 1;
  })
  .on(PromptSteered, (state) => {
    state.workSeq += 1;
  })
  .on(ContextAppendMessage, (state, { message }) => {
    if ((state.remainingSeedMessages ?? 0) > 0) {
      state.remainingSeedMessages = state.remainingSeedMessages! - 1;
      return;
    }
    if (isBranchConsumedMessage(message)) state.workSeq += 1;
  })
  .on(ContextAppendLoopEvent, (state, { event }) => {
    if (isBranchConsumedLoopEvent(event)) state.workSeq += 1;
  })
  .on(ContextUndo, (state) => {
    state.workSeq += 1;
    state.coveredTurnId = undefined;
    state.coveredWorkSeq = undefined;
  })
  .on(ContextClear, (state) => {
    state.workSeq += 1;
    state.coveredTurnId = undefined;
    state.coveredWorkSeq = undefined;
  })
  .on(TurnEnded, (state, event) => {
    if (event.reason === 'failed' || event.reason === 'cancelled') {
      state.workSeq += 1;
      state.coveredTurnId = undefined;
      state.coveredWorkSeq = undefined;
    }
  })
  .on(BranchTurnMerged, (state, event) => {
    state.throughTurnId = Math.max(state.throughTurnId ?? -1, event.turnId);
    if (event.foldId !== undefined) {
      state.lastFoldId = event.foldId;
      const existing = state.completedFoldIds ?? [];
      if (!existing.includes(event.foldId)) {
        state.completedFoldIds = existing.length >= 32
          ? [...existing.slice(-31), event.foldId]
          : [...existing, event.foldId];
      }
    }
    const isFinal = event.done !== false;
    state.lastFoldDone = isFinal;
    if (isFinal) {
      const coveredSeq = event.workSeq ?? (event.turnId === state.turnId ? state.workSeq : Number.MAX_SAFE_INTEGER);
      if (
        state.coveredTurnId === undefined ||
        event.turnId > state.coveredTurnId ||
        (event.turnId === state.coveredTurnId && coveredSeq > (state.coveredWorkSeq ?? -1))
      ) {
        state.coveredTurnId = event.turnId;
        state.coveredWorkSeq = coveredSeq;
      }
    }
  })
  .on(AgentBranchSealed, (state, event) => {
    if (event.sealed) {
      const coveredSeq = event.workSeq ?? state.workSeq;
      if (
        state.coveredTurnId === undefined ||
        state.turnId > state.coveredTurnId ||
        (state.turnId === state.coveredTurnId && coveredSeq > (state.coveredWorkSeq ?? -1))
      ) {
        state.coveredTurnId = state.turnId;
        state.coveredWorkSeq = coveredSeq;
      }
      if (event.foldId !== undefined) state.lastFoldId = event.foldId;
      state.lastFoldDone = true;
    } else if (isBranchWorkCovered(state)) {
      state.coveredTurnId = undefined;
      state.coveredWorkSeq = undefined;
    }
  });

export const branchToolLockKey = defineState('branch.toolsLocked', () => false)
  .replayable({ schema: z.boolean() })
  .on(AgentToolLockChanged, (_state, event) => event.locked);

export const branchSealedKey = defineState('branch.sealed', () => false)
  .replayable({ schema: z.boolean() })
  .on(AgentBranchSealed, (_state, event) => event.sealed);
