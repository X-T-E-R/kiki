import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ToolCall } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import type { ToolInfo } from '#/tool/toolContract';

export const SELECT_TOOLS_TOOL_NAME = 'SelectTools';
export const CALL_TOOL_NAME = 'CallTool';

export interface ShapedToolEntry extends ToolInfo {
  readonly deferred?: true;
}

export interface LoadToolsResult {
  readonly toLoad: readonly string[];
  readonly alreadyAvailable: readonly string[];
  readonly unknown: readonly string[];
}

export interface IAgentToolSelectService {
  readonly _serviceBrand: undefined;

  enabled(): boolean;

  shapeTools(entries: readonly ToolInfo[]): readonly ShapedToolEntry[];

  shapeHistory(messages: readonly ContextMessage[]): readonly ContextMessage[];

  load(names: readonly string[]): LoadToolsResult;

  resolveBridgeCall(call: ToolCall): ToolCall;

  drainPendingToolSchemas(): readonly Tool[] | undefined;

  loadableToolsAnnouncement(): string | undefined;
}

export const IAgentToolSelectService: ServiceIdentifier<IAgentToolSelectService> =
  createDecorator<IAgentToolSelectService>('agentToolSelectService');
