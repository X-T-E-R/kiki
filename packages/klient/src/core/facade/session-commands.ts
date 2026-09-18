import type {
  ApprovalResolveRequest, ApprovalResolveResult, CancelTaskQuery, EditMessageRequest, ForkSessionRequest,
  PromptAbortResponse, PromptReplaceRequest, PromptReplaceResult, PromptSteerResult,
  PromptSubmission, PromptSubmitResult, QuestionDismissResult, QuestionResolveRequest,
  QuestionResolveResult, RegenerateMessageRequest, Session,
} from '@kiki/protocol';
import type { z } from 'zod';
import { sessionCommandContract, type SessionCommandChannel, type SessionCommandName } from '../../contract/session/commands.js';
import { KlientValidationError } from '../validation.js';

export interface SessionCommandsFacade {
  read(): Promise<Session>;
  submit(body: PromptSubmission): Promise<PromptSubmitResult>;
  edit(messageId: string, body: EditMessageRequest): Promise<PromptSubmitResult>;
  regenerate(messageId: string, body: RegenerateMessageRequest): Promise<PromptSubmitResult>;
  fork(body?: ForkSessionRequest): Promise<Session>;
  abort(promptId: string): Promise<PromptAbortResponse>;
  replace(promptId: string, body: PromptReplaceRequest): Promise<PromptReplaceResult>;
  steer(promptId: string): Promise<PromptSteerResult>;
  approve(approvalId: string, body: ApprovalResolveRequest): Promise<ApprovalResolveResult>;
  answer(questionId: string, body: QuestionResolveRequest): Promise<QuestionResolveResult>;
  dismiss(questionId: string): Promise<QuestionDismissResult>;
  cancelTask(taskId: string, query?: CancelTaskQuery): Promise<{ cancelled: boolean }>;
}

export function createSessionCommandsFacade(channel: SessionCommandChannel | undefined, sessionId: string, validate: boolean): SessionCommandsFacade {
  const parse = (phase: 'input' | 'output', name: string, schema: z.ZodType, value: unknown): unknown => {
    const result = schema.safeParse(value);
    if (!result.success) throw new KlientValidationError(phase, name, result.error.issues, value);
    return result.data;
  };
  const invoke = async <T>(command: SessionCommandName, input: unknown): Promise<T> => {
    if (channel === undefined) throw new Error('session commands are unavailable on this transport');
    const contract = sessionCommandContract[command];
    const name = `session.commands.${command}`;
    const wireInput = validate ? parse('input', name, contract.input, input) : input;
    const result = await channel.execute(sessionId, command, wireInput);
    return (validate ? parse('output', name, contract.output, result) : result) as T;
  };
  return {
    read: () => invoke('read', {}),
    submit: (body) => invoke('submit', { body }),
    edit: (target, body) => invoke('edit', { target, body }),
    regenerate: (target, body) => invoke('regenerate', { target, body }),
    fork: (body = {}) => invoke('fork', { body }),
    abort: (target) => invoke('abort', { target }),
    replace: (target, body) => invoke('replace', { target, body }),
    steer: (target) => invoke('steer', { target }),
    approve: (target, body) => invoke('approve', { target, body }),
    answer: (target, body) => invoke('answer', { target, body }),
    dismiss: (target) => invoke('dismiss', { target }),
    cancelTask: (target, query = {}) => invoke('cancelTask', { target, query }),
  };
}
