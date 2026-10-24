import { createDecorator } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import type {
  ExecutableTool,
  ToolDisclosure,
  ToolInfo,
  ToolSource,
} from '#/tool/toolContract';

export interface ToolRegistrationOptions {
  readonly source?: ToolSource;
  readonly disclosure?: ToolDisclosure;
}

export interface ToolReference {
  readonly name: string;
  readonly source: ToolSource;
}

export interface IAgentToolRegistryService {
  readonly _serviceBrand: undefined;

  register(tool: ExecutableTool, options?: ToolRegistrationOptions): IDisposable;
  registerPreparation(prepare: () => Promise<void>): IDisposable;
  prepare(signal?: AbortSignal): Promise<void>;
  list(): readonly ToolInfo[];
  listReferences(): readonly ToolReference[];
  resolve(name: string): ExecutableTool | undefined;
}

export const IAgentToolRegistryService = createDecorator<IAgentToolRegistryService>('agentToolRegistryService');
