/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace */
import { z } from 'zod';
import { Event2 } from '#/app/event/event2';
import { ContextAppendLoopEvent, ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded, TurnPrompt } from '#/agent/loop/turnOps';
import { PromptSteered } from '#/agent/prompt/promptService';
import { defineState } from '#/state/state';
import {
  BranchTurnMerged,
  isBranchConsumedLoopEvent,
  isBranchConsumedMessage,
} from '#/features/btw/branchOps';

const receiptSchema = z.object({
  turnId: z.number(),
  startedAt: z.number(),
  endedAt: z.number(),
  summary: z.string(),
  workSeq: z.number().int().nonnegative().optional(),
  outcome: z.enum(['failed', 'cancelled']).optional(),
  error: z.string().optional(),
  userPrompt: z.literal(true).optional(),
});
const stateSchema = z.object({
  workTurnId: z.number().int().nonnegative().optional(),
  workSeq: z.number().int().nonnegative().optional(),
  active: z.object({
    turnId: z.number(),
    startedAt: z.number(),
    summary: z.string(),
    workSeq: z.number().int().nonnegative().optional(),
    userPrompt: z.literal(true).optional(),
  }).optional(),
  pending: z.record(z.string(), receiptSchema),
  mergedThrough: z.number().optional(),
  mergedWorkSeq: z.number().int().nonnegative().optional(),
});
export type AutonomousReceipt = z.infer<typeof receiptSchema>;
export type AutonomousReceiptsState = z.infer<typeof stateSchema>;

/** Returns true when a completed branch receipt is already covered by a final Merge checkpoint. */
export function isAutonomousReceiptCovered(
  state: AutonomousReceiptsState,
  receipt: AutonomousReceipt,
): boolean {
  if (state.mergedThrough === undefined) return false;
  if (receipt.turnId < state.mergedThrough) return true;
  if (receipt.turnId > state.mergedThrough) return false;
  if (state.mergedWorkSeq === undefined) return true;
  return (receipt.workSeq ?? 1) <= state.mergedWorkSeq;
}

const deliveredSchema = z.object({ turnId: z.number() });
export class AutonomousReceiptDelivered extends Event2<z.infer<typeof deliveredSchema>> {
  static override readonly type = 'subagent.autonomous_receipt_delivered';
  static override readonly durable = true;
  static override readonly schema = deliveredSchema;
}
export interface AutonomousReceiptDelivered extends z.infer<typeof deliveredSchema> {}

export const autonomousReceiptsKey = defineState('subagent.autonomousReceipts', (): AutonomousReceiptsState => ({ pending: {} }))
  .replayable({ schema: stateSchema })
  .on(TurnPrompt, (state, event) => {
    if (event.turnId !== undefined && state.workTurnId !== event.turnId) {
      state.workTurnId = event.turnId;
      state.workSeq = 1;
    }
    state.active = event.parentReceiptManaged !== false || event.turnId === undefined
      ? undefined
      : { turnId: event.turnId, startedAt: event.time, summary: '', workSeq: state.workSeq ?? 1, userPrompt: event.origin.kind === 'user' ? true : undefined };
  })
  .on(TurnStarted, (state, event) => {
    if (state.workTurnId !== event.turnId) {
      state.workTurnId = event.turnId;
      state.workSeq = 1;
    }
    state.active = event.parentReceiptManaged === true
      ? undefined
      : { turnId: event.turnId, startedAt: event.time, summary: '', workSeq: state.workSeq ?? 1, userPrompt: event.origin.kind === 'user' ? true : undefined };
  })
  .on(PromptSteered, (state) => {
    state.workSeq = (state.workSeq ?? 1) + 1;
    if (state.active !== undefined) state.active.workSeq = state.workSeq;
  })
  .on(ContextAppendLoopEvent, (state, { event }) => {
    if (isBranchConsumedLoopEvent(event)) {
      state.workSeq = (state.workSeq ?? 1) + 1;
      if (state.active !== undefined) state.active.workSeq = state.workSeq;
    }
    if (state.active === undefined || Number(event.type === 'tool.result' ? undefined : event.turnId) !== state.active.turnId) return;
    if (event.type === 'step.begin') state.active.summary = '';
    if (event.type === 'content.part' && event.part.type === 'text') state.active.summary += event.part.text;
  })
  .on(ContextAppendMessage, (state, { message }) => {
    if (isBranchConsumedMessage(message)) {
      state.workSeq = (state.workSeq ?? 1) + 1;
      if (state.active !== undefined) state.active.workSeq = state.workSeq;
    }
    if (state.active === undefined || message.role !== 'assistant' || message.source?.turnId !== state.active.turnId) return;
    state.active.summary = typeof message.content === 'string' ? message.content : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
  })
  .on(TurnEnded, (state, event) => {
    const active = state.active;
    if (event.reason === 'failed' || event.reason === 'cancelled') {
      state.workSeq = (state.workSeq ?? 1) + 1;
      if (state.mergedThrough === event.turnId) {
        state.mergedThrough = undefined;
        state.mergedWorkSeq = undefined;
      }
    }
    if (active?.turnId !== event.turnId) return;
    if (event.reason !== 'blocked') state.pending[String(event.turnId)] = {
      ...active,
      workSeq: state.workSeq ?? active.workSeq ?? 1,
      endedAt: event.time,
      outcome: event.reason === 'completed' ? undefined : event.reason,
      error: event.error?.message,
    };
    state.active = undefined;
  })
  .on(BranchTurnMerged, (state, event) => {
    if (event.done === false) return;
    const coveredSeq = event.workSeq ?? (state.workTurnId === event.turnId ? (state.workSeq ?? 1) : Number.MAX_SAFE_INTEGER);
    if (
      state.mergedThrough === undefined ||
      event.turnId > state.mergedThrough ||
      (event.turnId === state.mergedThrough && coveredSeq > (state.mergedWorkSeq ?? -1))
    ) {
      state.mergedThrough = event.turnId;
      state.mergedWorkSeq = coveredSeq;
    }
  })
  .on(AutonomousReceiptDelivered, (state, event) => { delete state.pending[String(event.turnId)]; });
