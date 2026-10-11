/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace */
import { z } from 'zod';
import { castDraft } from 'immer';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';
import { ContextUndo } from '#/agent/contextMemory/contextEvents';
import type { ContextMessage } from '#/agent/contextMemory/types';

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
  })
  .on(ContextUndo, (state, { replacementPrompt }) => {
    if (replacementPrompt !== undefined) state.set(replacementPrompt.promptId, true);
  });

export const promptRetryReceiptSchema = z.object({
  status: z.enum(['running', 'queued', 'blocked']),
  createdAt: z.string(),
  appendTiming: z.enum(['agent_idle', 'subagents_done', 'tasks_done']),
  revision: z.number().int().nonnegative(),
  userMessageId: z.string().optional(),
  message: z.custom<ContextMessage>().optional(),
  execution: z.custom<import('./prompt').PromptExecutionBinding>().optional(),
  deferredDisabledTools: z.array(z.string()).optional(),
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
  .replayable({
    schema: z.map(z.string(), z.object({ fingerprint: z.string(), receipt: promptRetryReceiptSchema })),
    blobs: {
      dehydrate: async (record, transform) => {
        if (record.type === 'prompt.enqueued') {
          const message = record['message'] as ContextMessage;
          const content = await transform(message.content);
          return content === message.content ? record : { ...record, message: { ...message, content: [...content] } };
        }
        const prompt = record['replacementPrompt'] as import('./promptService').PromptEnqueuedPayload | undefined;
        if (record.type !== ContextUndo.type || prompt === undefined) return record;
        const content = await transform(prompt.message.content);
        return content === prompt.message.content ? record : { ...record,
          replacementPrompt: { ...prompt, message: { ...prompt.message, content: [...content] } } };
      },
      rehydrate: async (state, transform) => {
        const restored = new Map(state);
        for (const [id, entry] of state) {
          const message = entry.receipt.message;
          if (message === undefined) continue;
          const content = await transform(message.content);
          if (content !== message.content) restored.set(id, { ...entry,
            receipt: { ...entry.receipt, message: { ...message, content: [...content] as ContextMessage['content'] } } });
        }
        return restored;
      },
    },
  })
  .on(PromptRetryCommitted, (state, event) => {
    if (state.has(event.promptId)) return state;
    state.set(event.promptId, { fingerprint: event.fingerprint, receipt: castDraft(event.receipt) });
  })
  .on(ContextUndo, (state, { replacementPrompt: prompt }) => {
    if (prompt?.retryFingerprint === undefined || state.has(prompt.promptId)) return;
    state.set(prompt.promptId, { fingerprint: prompt.retryFingerprint, receipt: {
      status: 'queued', createdAt: prompt.createdAt, appendTiming: prompt.appendTiming, revision: prompt.revision,
      userMessageId: prompt.userMessageId, message: castDraft(prompt.message),
      execution: castDraft(prompt.execution), deferredDisabledTools: castDraft(prompt.deferredDisabledTools),
    } });
  });
