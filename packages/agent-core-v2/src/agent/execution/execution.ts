import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Hooks } from '#/hooks';
import { Error2, ErrorCodes } from '#/errors';
import type {
  AgentRunHandle,
  AgentRunRequest,
  RunAgentOptions,
} from '#/session/subagent/subagent';
import type { AgentExecutionStatus } from '#/app/agentExecutor/agentExecutor';
import type { ContextMessage } from '#/agent/contextMemory/types';

export interface AgentExecutionRunContext {
  readonly signal: AbortSignal;
  request?: AgentRunRequest;
  readonly replaceRequest?: (request: AgentRunRequest) => void;
  readonly afterStart?: (callback: () => Promise<void>) => void;
}

export interface IAgentExecutionService {
  readonly _serviceBrand: undefined;

  run(
    request: AgentRunRequest,
    options: RunAgentOptions,
  ): Promise<AgentRunHandle>;

  /** Retain execution capacity until completion; pass the returned cancellation signal to the admitted prompt. */
  trackPromptRun(completion: Promise<unknown>, signal: AbortSignal): AbortSignal;
  /** Reports cancelling once all tracked runs receive cancellation, until they settle; a stop request alone does not release capacity. */
  status(): AgentExecutionStatus;
  /** True only when a broken ACP client can open its saved remote session again without creating a new one. */
  canResumeBrokenOriginal(): boolean;
  /** True when external construction can be retried after no session was opened or its failed wrapper was fully released. */
  canRetryBrokenExecution(): boolean;
  attachLocalSession(source: import('#/app/agentExecutor/localSessionRef').LocalExecutorSessionSource): Promise<void>;
  steer?(message: ContextMessage): Promise<boolean | 'unknown'>;
  cancel(reason?: unknown): boolean;
  settled(): Promise<void>;
  shutdown(reason?: unknown): Promise<void>;

  readonly hooks: Hooks<{ onWillRun: AgentExecutionRunContext }>;
}

export const IAgentExecutionService: ServiceIdentifier<IAgentExecutionService> =
  createDecorator<IAgentExecutionService>('agentExecutionService');

export function brokenOriginalResumeRefusal(agentId: string, messageId?: string): Error2 {
  return new Error2(
    ErrorCodes.INTERNAL,
    `Agent instance "${agentId}" is broken and its original remote session cannot be resumed. The saved message stays queued. Do not call AgentSend again. Do not open a new remote session.`,
    { details: messageId === undefined ? { agentId } : { agentId, messageId } },
  );
}
