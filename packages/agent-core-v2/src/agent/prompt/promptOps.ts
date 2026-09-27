/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace */
import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

const promptAcceptedSchema = z.object({ promptId: z.string().min(1) });

export class PromptAccepted extends Event2<z.infer<typeof promptAcceptedSchema>> {
  static override readonly type = 'prompt.accepted';
  static override readonly durable = true;
  static override readonly schema = promptAcceptedSchema;
}
export interface PromptAccepted extends z.infer<typeof promptAcceptedSchema> {}

export const promptAdmissionKey = defineState('promptAdmission', (): Map<string, true> => new Map())
  .replayable({ schema: z.map(z.string(), z.literal(true)) })
  .on(PromptAccepted, (state, event) => {
    if (state.has(event.promptId)) return state;
    state.set(event.promptId, true);
  });

export const promptRetryReceiptSchema = z.object({
  status: z.enum(['running', 'queued', 'blocked']),
  createdAt: z.string(),
  appendTiming: z.enum(['agent_idle', 'subagents_done', 'tasks_done']),
  revision: z.number().int().nonnegative(),
});

export type PromptRetryReceipt = z.infer<typeof promptRetryReceiptSchema>;

const promptRetryCommittedSchema = z.object({
  promptId: z.string().min(1),
  fingerprint: z.string().min(1),
  receipt: promptRetryReceiptSchema,
});

export class PromptRetryCommitted extends Event2<z.infer<typeof promptRetryCommittedSchema>> {
  static override readonly type = 'prompt.retry_committed';
  static override readonly durable = true;
  static override readonly schema = promptRetryCommittedSchema;
}
export interface PromptRetryCommitted extends z.infer<typeof promptRetryCommittedSchema> {}

export const promptRetryReceiptKey = defineState('promptRetryReceipt', (): Map<string, {
  readonly fingerprint: string;
  readonly receipt: PromptRetryReceipt;
}> => new Map())
  .replayable({ schema: z.map(z.string(), z.object({ fingerprint: z.string(), receipt: promptRetryReceiptSchema })) })
  .on(PromptRetryCommitted, (state, event) => {
    if (state.has(event.promptId)) return state;
    state.set(event.promptId, { fingerprint: event.fingerprint, receipt: event.receipt });
  });
