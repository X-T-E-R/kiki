import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Hooks } from '#/hooks';
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
  status(): AgentExecutionStatus;
  steer?(message: ContextMessage): Promise<boolean>;
  cancel(reason?: unknown): boolean;
  settled(): Promise<void>;
  shutdown(reason?: unknown): Promise<void>;

  readonly hooks: Hooks<{ onWillRun: AgentExecutionRunContext }>;
}

export const IAgentExecutionService: ServiceIdentifier<IAgentExecutionService> =
  createDecorator<IAgentExecutionService>('agentExecutionService');
