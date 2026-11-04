/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace */
import { z } from 'zod';
import { Event2 } from '#/app/event/event2';
import { ContextAppendLoopEvent, ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded, TurnPrompt } from '#/agent/loop/turnOps';
import { defineState } from '#/state/state';

const receiptSchema = z.object({ turnId: z.number(), startedAt: z.number(), endedAt: z.number(), summary: z.string() });
const stateSchema = z.object({
  active: z.object({ turnId: z.number(), startedAt: z.number(), summary: z.string() }).optional(),
  pending: z.record(z.string(), receiptSchema),
});
export type AutonomousReceipt = z.infer<typeof receiptSchema>;

const deliveredSchema = z.object({ turnId: z.number() });
export class AutonomousReceiptDelivered extends Event2<z.infer<typeof deliveredSchema>> {
  static override readonly type = 'subagent.autonomous_receipt_delivered';
  static override readonly durable = true;
  static override readonly schema = deliveredSchema;
}
export interface AutonomousReceiptDelivered extends z.infer<typeof deliveredSchema> {}

export const autonomousReceiptsKey = defineState('subagent.autonomousReceipts', (): z.infer<typeof stateSchema> => ({ pending: {} }))
  .replayable({ schema: stateSchema })
  .on(TurnPrompt, (state, event) => {
    state.active = event.parentReceiptManaged !== false || event.turnId === undefined ? undefined : { turnId: event.turnId, startedAt: event.time, summary: '' };
  })
  .on(TurnStarted, (state, event) => {
    state.active = event.parentReceiptManaged === true ? undefined : { turnId: event.turnId, startedAt: event.time, summary: '' };
  })
  .on(ContextAppendLoopEvent, (state, { event }) => {
    if (state.active === undefined || Number(event.type === 'tool.result' ? undefined : event.turnId) !== state.active.turnId) return;
    if (event.type === 'step.begin') state.active.summary = '';
    if (event.type === 'content.part' && event.part.type === 'text') state.active.summary += event.part.text;
  })
  .on(ContextAppendMessage, (state, { message }) => {
    if (state.active === undefined || message.role !== 'assistant' || message.source?.turnId !== state.active.turnId) return;
    state.active.summary = typeof message.content === 'string' ? message.content : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
  })
  .on(TurnEnded, (state, event) => {
    const active = state.active;
    if (active?.turnId !== event.turnId) return;
    if (event.reason === 'completed' && active.summary.trim() !== '') state.pending[String(event.turnId)] = { ...active, endedAt: event.time };
    state.active = undefined;
  })
  .on(AutonomousReceiptDelivered, (state, event) => { delete state.pending[String(event.turnId)]; });
