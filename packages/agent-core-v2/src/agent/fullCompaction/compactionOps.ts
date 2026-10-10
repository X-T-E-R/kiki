/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { CompactionBeginData, CompactionResult, CompactionSource } from './types';

export type CompactionPhase = 'idle' | 'queued' | 'running' | 'cancelled' | 'completed';

export interface CompactionState {
  readonly phase: CompactionPhase;
  readonly pendingManual?: boolean;
}

const fullCompactionBeginSchema = z.custom<CompactionBeginData>();

export class FullCompactionBegin extends Event2<z.infer<typeof fullCompactionBeginSchema>> {
  static override readonly type = 'full_compaction.begin';
  static override readonly durable = true;
  static override readonly schema = fullCompactionBeginSchema;
}
export interface FullCompactionBegin extends z.infer<typeof fullCompactionBeginSchema> {}

const fullCompactionCancelSchema = z.object({ queued: z.boolean().optional() });

export class FullCompactionCancel extends Event2<z.infer<typeof fullCompactionCancelSchema>> {
  static override readonly type = 'full_compaction.cancel';
  static override readonly durable = true;
  static override readonly schema = fullCompactionCancelSchema;
}
export interface FullCompactionCancel extends z.infer<typeof fullCompactionCancelSchema> {}

const fullCompactionCompleteSchema = z.object({});

export class FullCompactionComplete extends Event2<z.infer<typeof fullCompactionCompleteSchema>> {
  static override readonly type = 'full_compaction.complete';
  static override readonly durable = true;
  static override readonly schema = fullCompactionCompleteSchema;
}
export interface FullCompactionComplete extends z.infer<typeof fullCompactionCompleteSchema> {}

export interface CompactionStartedPayload {
  readonly trigger: CompactionSource;
  readonly instruction?: string;
  readonly phase?: 'queued' | 'running';
}

export class CompactionStarted extends Event2<CompactionStartedPayload> {
  static override readonly type = 'compaction.started';
  static override readonly observable = true;
}
export interface CompactionStarted extends CompactionStartedPayload {}

export interface CompactionBlockedPayload {
  readonly turnId?: number;
}

export class CompactionBlocked extends Event2<CompactionBlockedPayload> {
  static override readonly type = 'compaction.blocked';
  static override readonly observable = true;
}
export interface CompactionBlocked extends CompactionBlockedPayload {}

export interface CompactionCancelledPayload {
  readonly trigger?: CompactionSource;
  readonly reason?: string;
}

export class CompactionCancelled extends Event2<CompactionCancelledPayload> {
  static override readonly type = 'compaction.cancelled';
  static override readonly observable = true;
}
export interface CompactionCancelled extends CompactionCancelledPayload {}

export interface CompactionCompletedPayload {
  readonly trigger?: CompactionSource;
  readonly result: CompactionResult;
}

export class CompactionCompleted extends Event2<CompactionCompletedPayload> {
  static override readonly type = 'compaction.completed';
  static override readonly observable = true;
}
export interface CompactionCompleted extends CompactionCompletedPayload {}

export const fullCompactionKey = defineState(
  'fullCompaction',
  (): CompactionState => ({ phase: 'idle' }),
).replayable({ schema: z.custom<CompactionState>() })
  .on(FullCompactionBegin, (s, e, ctx) => {
    if (e.queued) {
      s.pendingManual = true;
      if (s.phase !== 'running') s.phase = 'queued';
    } else {
      if (e.source === 'manual') s.pendingManual = false;
      s.phase = 'running';
    }
    ctx.emit(new CompactionStarted({ trigger: e.source, instruction: e.instruction, phase: e.queued ? 'queued' : 'running' }));
  })
  .on(FullCompactionCancel, (s, e) => {
    if (e.queued) {
      s.pendingManual = false;
      if (s.phase === 'queued') s.phase = 'idle';
    } else {
      s.phase = s.pendingManual ? 'queued' : 'idle';
    }
  })
  .on(FullCompactionComplete, (s) => {
    s.phase = s.pendingManual ? 'queued' : 'idle';
  });
