/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import type { KimiErrorPayload } from '#/_base/errors/serialize';
import {
  ContextAppendLoopEvent,
  ContextApplyCompaction,
  ContextClear,
  ContextUndo,
} from '#/agent/contextMemory/contextEvents';
import { isUndoAnchorOrigin } from '#/agent/contextMemory/conversationTime';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { Event2, type SerializedEvent2 } from '#/app/event/event2';
import type { ContentPart } from '#/kosong/contract/message';
import { defineState } from '#/state/state';

import type { TurnInterruptReason } from './turnEvents';

export interface TurnModelState {
  readonly nextTurnId: number;
  readonly cancelledTurnIds: readonly number[];
  readonly anchorTurnIds: readonly number[];
  readonly lastEnded?: {
    readonly turnId: number;
    readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
    readonly durationMs?: number;
  };
}

const turnLineageSchema = z.object({
  replacesMessageId: z.string().optional(),
  parentMessageId: z.string().optional(),
  rewriteId: z.string().optional(),
});

const turnInputShape = {
  turnId: z.number().int().nonnegative().optional(),
  promptId: z.string().min(1).optional(),
  revision: z.number().int().nonnegative().optional(),
  lineage: turnLineageSchema.optional(),
  input: z.custom<readonly ContentPart[]>(),
  origin: z.custom<PromptOrigin>(),
  managed: z.boolean().optional(),
};

const turnPromptSchema = z.object(turnInputShape);

export class TurnPrompt extends Event2<z.infer<typeof turnPromptSchema>> {
  static override readonly type = 'turn.prompt';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = turnPromptSchema;
}
export interface TurnPrompt extends z.infer<typeof turnPromptSchema> {}

const turnSteerSchema = z.object(turnInputShape);

export class TurnSteer extends Event2<z.infer<typeof turnSteerSchema>> {
  static override readonly type = 'turn.steer';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = turnSteerSchema;
}
export interface TurnSteer extends z.infer<typeof turnSteerSchema> {}

const turnCancelSchema = z.object({
  turnId: z.number().optional(),
  target: z.enum(['active', 'queued']).optional(),
  reason: z.enum(['user_cancelled', 'aborted']).optional(),
});

export class TurnCancel extends Event2<z.infer<typeof turnCancelSchema>> {
  static override readonly type = 'turn.cancel';
  static override readonly durable = true;
  static override readonly schema = turnCancelSchema;
}
export interface TurnCancel extends z.infer<typeof turnCancelSchema> {}

const turnEndedSchema = z.object({
  turnId: z.number(),
  reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
  error: z.custom<KimiErrorPayload>().optional(),
  durationMs: z.number().optional(),
});

export interface TurnEndedPayload {
  readonly turnId: number;
  readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
  readonly error?: KimiErrorPayload;
  readonly durationMs?: number;
  readonly interruptReason?: TurnInterruptReason;
}

export class TurnEnded extends Event2<TurnEndedPayload> {
  static override readonly type = 'turn.ended';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = turnEndedSchema;

  override serialize(): SerializedEvent2 {
    const record: Record<string, unknown> = {
      type: this.type,
      turnId: this.turnId,
      reason: this.reason,
    };
    if (this.error !== undefined) record['error'] = this.error;
    if (this.durationMs !== undefined) record['durationMs'] = this.durationMs;
    record['time'] = this.time;
    return record as SerializedEvent2;
  }
}
export interface TurnEnded extends TurnEndedPayload {}

export const turnKey = defineState(
  'turn',
  (): TurnModelState => ({ nextTurnId: 0, cancelledTurnIds: [], anchorTurnIds: [] }),
).replayable({ schema: z.custom<TurnModelState>() })
  .on(ContextAppendLoopEvent, (s, e) => {
    const { event } = e;
    if (event.type === 'tool.result' || event.turnId === undefined) return;
    const turnId = Number.parseInt(event.turnId, 10);
    if (!Number.isInteger(turnId)) return;
    let next: TurnModelState = s;
    if (turnId >= next.nextTurnId) next = advanceTurnClock(next, turnId + 1);
    if (next.lastEnded !== undefined && turnId > next.lastEnded.turnId) {
      next = { ...next, lastEnded: undefined };
    }
    if (next !== s) return next;
  })
  .on(TurnPrompt, (s, e) => {
    const turnId = e.turnId ?? s.nextTurnId;
    const next = advanceTurnClock(s, Math.max(s.nextTurnId, turnId + 1));
    if (!isUndoAnchorOrigin(e.origin)) return next;
    return { ...next, anchorTurnIds: [...s.anchorTurnIds, turnId] };
  })
  .on(TurnSteer, () => {})
  .on(ContextUndo, (s, e) => {
    const firstRemoved = s.anchorTurnIds[s.anchorTurnIds.length - e.count];
    const lastEnded = s.lastEnded;
    return {
      ...s,
      anchorTurnIds: s.anchorTurnIds.slice(0, Math.max(0, s.anchorTurnIds.length - e.count)),
      lastEnded:
        lastEnded !== undefined &&
        (firstRemoved === undefined || lastEnded.turnId >= firstRemoved)
          ? undefined
          : lastEnded,
    };
  })
  .on(ContextApplyCompaction, (s) => ({ ...s, anchorTurnIds: [] }))
  .on(ContextClear, (s) => ({ ...s, anchorTurnIds: [] }))
  .on(TurnCancel, (s, e) => {
    if (e.target === undefined || e.turnId === undefined) return;
    if (e.turnId < s.nextTurnId) return;
    return advanceTurnClock(s, s.nextTurnId, [...s.cancelledTurnIds, e.turnId]);
  })
  .on(TurnEnded, (s, e) => ({
    ...s,
    lastEnded: { turnId: e.turnId, reason: e.reason, durationMs: e.durationMs },
  }));

function advanceTurnClock(
  state: TurnModelState,
  nextTurnId: number,
  cancelledTurnIds: readonly number[] = state.cancelledTurnIds,
): TurnModelState {
  const pendingCancellations = new Set(
    cancelledTurnIds.filter((turnId) => turnId >= nextTurnId),
  );
  while (pendingCancellations.delete(nextTurnId)) nextTurnId += 1;
  return {
    ...state,
    nextTurnId,
    cancelledTurnIds: [...pendingCancellations].toSorted((a, b) => a - b),
  };
}
