import { z } from 'zod';
import {
  approvalResolveRequestSchema, approvalResolveResultSchema,
  cancelTaskQuerySchema, cancelTaskResultSchema, taskAlreadyFinishedDataSchema,
  editMessageRequestSchema, regenerateMessageRequestSchema, messageActionResponseSchema,
  forkSessionRequestSchema, sessionSchema,
  promptSubmissionSchema, promptSubmitResultSchema, promptAbortResponseSchema,
  promptReplaceRequestSchema, promptReplaceResultSchema, promptSteerResultSchema,
  questionResolveRequestSchema, questionResolveResultSchema, questionDismissResultSchema,
} from '@kiki/protocol';

const target = z.string().min(1);
const bodyInput = <T extends z.ZodType>(body: T) => z.object({ body });
const targetInput = z.object({ target });
const targetBodyInput = <T extends z.ZodType>(body: T) => z.object({ target, body });

export const sessionCommandContract = {
  read: { method: 'GET', suffix: '', input: z.object({}), output: sessionSchema, okCodes: [0] },
  submit: { method: 'POST', suffix: '/prompts', input: bodyInput(promptSubmissionSchema), output: promptSubmitResultSchema, okCodes: [0], timeoutMs: 0 },
  edit: { method: 'POST', suffix: '/messages/{target}:edit', input: targetBodyInput(editMessageRequestSchema), output: messageActionResponseSchema, okCodes: [0] },
  regenerate: { method: 'POST', suffix: '/messages/{target}:regenerate', input: targetBodyInput(regenerateMessageRequestSchema), output: messageActionResponseSchema, okCodes: [0] },
  fork: { method: 'POST', suffix: ':fork', input: bodyInput(forkSessionRequestSchema), output: sessionSchema, okCodes: [0] },
  abort: { method: 'POST', suffix: '/prompts/{target}:abort', input: targetInput, output: promptAbortResponseSchema, okCodes: [0, 40903] },
  replace: { method: 'POST', suffix: '/prompts/{target}:replace', input: targetBodyInput(promptReplaceRequestSchema), output: promptReplaceResultSchema, okCodes: [0] },
  steer: { method: 'POST', suffix: '/prompts/{target}:steer', input: targetInput, output: promptSteerResultSchema, okCodes: [0] },
  approve: { method: 'POST', suffix: '/approvals/{target}', input: targetBodyInput(approvalResolveRequestSchema), output: approvalResolveResultSchema, okCodes: [0] },
  answer: { method: 'POST', suffix: '/questions/{target}', input: targetBodyInput(questionResolveRequestSchema), output: questionResolveResultSchema, okCodes: [0] },
  dismiss: { method: 'POST', suffix: '/questions/{target}:dismiss', input: targetInput, output: questionDismissResultSchema, okCodes: [0, 40909] },
  cancelTask: { method: 'POST', suffix: '/tasks/{target}:cancel', input: z.object({ target, query: cancelTaskQuerySchema.optional() }), output: z.union([cancelTaskResultSchema, taskAlreadyFinishedDataSchema]), okCodes: [0, 40904] },
} as const;

export type SessionCommandName = keyof typeof sessionCommandContract;

export interface SessionCommandChannel {
  execute(sessionId: string, command: SessionCommandName, input: unknown): Promise<unknown>;
}
