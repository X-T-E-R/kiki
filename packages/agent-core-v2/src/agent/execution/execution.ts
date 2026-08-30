import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Hooks } from '#/hooks';
import type {
  AgentRunHandle,
  AgentRunRequest,
  RunAgentOptions,
} from '#/session/subagent/subagent';
import type { AgentExecutionStatus } from '#/app/agentExecutor/agentExecutor';

export interface AgentExecutionRunContext {
  readonly signal: AbortSignal;
}

export interface IAgentExecutionService {
  readonly _serviceBrand: undefined;

  run(
    request: AgentRunRequest,
    options: RunAgentOptions,
  ): Promise<AgentRunHandle>;

  status(): AgentExecutionStatus;
  cancel(reason?: unknown): boolean;
  settled(): Promise<void>;
  shutdown(reason?: unknown): Promise<void>;

  readonly hooks: Hooks<{ onWillRun: AgentExecutionRunContext }>;
}

export const IAgentExecutionService: ServiceIdentifier<IAgentExecutionService> =
  createDecorator<IAgentExecutionService>('agentExecutionService');
