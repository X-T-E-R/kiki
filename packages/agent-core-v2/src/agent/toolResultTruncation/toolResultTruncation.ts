import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ExecutableToolResult } from '#/tool/toolContract';

export interface ToolResultTruncationInput<
  T extends ExecutableToolResult = ExecutableToolResult,
> {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly host?: string;
  readonly path?: string;
  readonly cwd?: string;
  readonly runtimeId?: string;
  readonly activeRuntimeId?: string;
  readonly result: T;
}

export interface IAgentToolResultTruncationService {
  readonly _serviceBrand: undefined;

  truncateForModel<T extends ExecutableToolResult>(
    input: ToolResultTruncationInput<T>,
  ): Promise<T>;

  preserveOriginal?(input: ToolResultTruncationInput): Promise<string | undefined>;
}

export const IAgentToolResultTruncationService: ServiceIdentifier<
  IAgentToolResultTruncationService
> = createDecorator<IAgentToolResultTruncationService>('agentToolResultTruncationService');
