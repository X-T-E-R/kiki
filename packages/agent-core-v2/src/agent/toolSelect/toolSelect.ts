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

export interface ShapedToolHistory {
  readonly messages: readonly ContextMessage[];
  readonly sourceIndexes?: readonly number[];
}

export interface IAgentToolSelectService {
  readonly _serviceBrand: undefined;

  enabled(): boolean;

  shapeTools(entries: readonly ToolInfo[]): readonly ShapedToolEntry[];

  isLoadable(name: string): boolean;

  /** Every name for which `isLoadable` holds, computed once for callers that test many names. */
  loadableNames(): ReadonlySet<string>;

  shapeHistory(messages: readonly ContextMessage[]): ShapedToolHistory;

  load(names: readonly string[]): LoadToolsResult;

  resolveBridgeCall(call: ToolCall): ToolCall;

  /** Whether loaded tools must be run through `CallTool` rather than called by their own name. */
  usesCallTool(): boolean;

  /** Explains why `CallTool` could not route `name`, loading it first when it was loadable but not yet loaded. */
  describeCallToolTarget(name: string): string;

  drainPendingToolSchemas(): readonly Tool[] | undefined;

  loadableToolsAnnouncement(): string | undefined;
}

export const IAgentToolSelectService: ServiceIdentifier<IAgentToolSelectService> =
  createDecorator<IAgentToolSelectService>('agentToolSelectService');
