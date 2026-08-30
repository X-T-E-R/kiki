/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export const EXECUTOR_LOSS_CODES = [
  'acp_no_step_boundaries',
  'profile_as_user_preamble',
  'tool_input_partial',
  'tool_output_summary_only',
  'message_id_missing',
  'usage_context_only',
  'unknown_update_dropped',
  'resume_new_session_handoff',
  'handoff_truncated',
  'unstable_acp_plan',
  'permission_mode_unverified',
] as const;

export type ExecutorLossCode = (typeof EXECUTOR_LOSS_CODES)[number];
export type ExecutorResumeMode = 'live' | 'resume' | 'load' | 'new' | 'handoff';
export type ExecutorProfileDelivery = 'native' | 'first_prompt_preamble';

export interface ExecutorTurnMetadataPayload {
  readonly turnId: number;
  readonly executorId: string;
  readonly protocol: string;
  readonly resumeMode: ExecutorResumeMode;
  readonly profileDelivery: ExecutorProfileDelivery;
  readonly fidelity: 'full' | 'degraded';
  readonly losses: readonly ExecutorLossCode[];
}

const executorTurnMetadataSchema = z.object({
  turnId: z.number().int().nonnegative(),
  executorId: z.string().min(1),
  protocol: z.string().min(1),
  resumeMode: z.enum(['live', 'resume', 'load', 'new', 'handoff']),
  profileDelivery: z.enum(['native', 'first_prompt_preamble']),
  fidelity: z.enum(['full', 'degraded']),
  losses: z.array(z.enum(EXECUTOR_LOSS_CODES)).readonly(),
});

export class ExecutorTurnMetadata extends Event2<ExecutorTurnMetadataPayload> {
  static override readonly type = 'executor.turn.metadata';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = executorTurnMetadataSchema;
}
export interface ExecutorTurnMetadata extends ExecutorTurnMetadataPayload {}

const executorSessionUpdatedSchema = z.object({
  executorId: z.string().min(1),
  descriptorRevision: z.string().min(1),
  sessionRef: z.object({
    executorId: z.string().min(1),
    version: z.number().int().positive(),
    ref: z.record(z.string(), z.unknown()),
  }),
  sessionEpoch: z.number().int().positive(),
  profileDeliveredSessionId: z.string().optional(),
});

export class ExecutorSessionUpdated extends Event2<z.infer<typeof executorSessionUpdatedSchema>> {
  static override readonly type = 'executor.session.updated';
  static override readonly durable = true;
  static override readonly schema = executorSessionUpdatedSchema;
}
export interface ExecutorSessionUpdated extends z.infer<typeof executorSessionUpdatedSchema> {}

const executorPlanUpdateSchema = z.object({
  turnId: z.number().int().nonnegative(),
  plan: z.unknown(),
  unstable: z.boolean(),
});

export class ExecutorPlanUpdate extends Event2<z.infer<typeof executorPlanUpdateSchema>> {
  static override readonly type = 'executor.plan.update';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = executorPlanUpdateSchema;
}
export interface ExecutorPlanUpdate extends z.infer<typeof executorPlanUpdateSchema> {}

const executorPlanRemoveSchema = z.object({
  turnId: z.number().int().nonnegative(),
  planId: z.string().optional(),
  unstable: z.boolean(),
});

export class ExecutorPlanRemove extends Event2<z.infer<typeof executorPlanRemoveSchema>> {
  static override readonly type = 'executor.plan.remove';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = executorPlanRemoveSchema;
}
export interface ExecutorPlanRemove extends z.infer<typeof executorPlanRemoveSchema> {}

const executorRuntimeUpdateSchema = z.object({
  turnId: z.number().int().nonnegative(),
  kind: z.enum(['commands', 'mode', 'config', 'session', 'usage', 'unknown']),
  value: z.unknown(),
});

export class ExecutorRuntimeUpdate extends Event2<z.infer<typeof executorRuntimeUpdateSchema>> {
  static override readonly type = 'executor.runtime.update';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = executorRuntimeUpdateSchema;
}
export interface ExecutorRuntimeUpdate extends z.infer<typeof executorRuntimeUpdateSchema> {}

export interface ExternalExecutorState {
  readonly executorId?: string;
  readonly descriptorRevision?: string;
  readonly sessionRef?: {
    readonly executorId: string;
    readonly version: number;
    readonly ref: Readonly<Record<string, unknown>>;
  };
  readonly sessionEpoch?: number;
  readonly profileDeliveredSessionId?: string;
}

export const externalExecutorKey = defineState(
  'externalExecutor',
  (): ExternalExecutorState => ({}),
).replayable({ schema: z.custom<ExternalExecutorState>() })
  .on(ExecutorSessionUpdated, (_state, event) => ({
    executorId: event.executorId,
    descriptorRevision: event.descriptorRevision,
    sessionRef: event.sessionRef,
    sessionEpoch: event.sessionEpoch,
    profileDeliveredSessionId: event.profileDeliveredSessionId,
  }))
  .on(ExecutorTurnMetadata, () => {})
  .on(ExecutorPlanUpdate, () => {})
  .on(ExecutorPlanRemove, () => {})
  .on(ExecutorRuntimeUpdate, () => {});
