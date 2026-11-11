import type { Event } from '#/_base/event';
import { refineServiceDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import { IPluginExtensionPortRegistry } from '#/app/plugin/extensionSlots';
import type {
  ApprovedToolExecutionWrapperContext,
  CompactionPolicyContribution,
  DynamicExecutorContribution,
  LoopBoundaryProposal,
  LoopBoundarySnapshot,
  LoopFailureSnapshot,
  PromptSectionContribution,
  RecoveryProposal,
  StepContextReminderContribution,
  SubagentDispatchProposal,
  SubagentDispatchSnapshot,
  SubagentReturnProposal,
  ToolPostExecuteProposal,
  ToolPreExecuteProposal,
} from '#/app/plugin/extensionSlots';
import type { AgentExecutorContext, AgentExecutorProtocol, AgentExecutorSession } from '#/app/agentExecutor/agentExecutor';
import type { FrozenLLMRequestSnapshot, LLMStreamTapObserver, PreBaselineRequestPatch, SettledLLMResponseSnapshot } from '#/kosong/contract/extensionHooks';
import type { ContentPart } from '#/kosong/contract/message';
import type { ExecutableToolResult, ToolAccesses } from '#/tool/toolContract';

export interface ExtensionPortInvocationError {
  readonly pluginId: string;
  readonly error: unknown;
}

export interface RenderedPromptSections {
  readonly text: string;
  readonly suppressRuntimeContext: boolean;
}

export interface CompactionGuidance {
  readonly additionalInstructions?: string;
  readonly preservedFileIndexMarkdown?: string;
}

export interface ToolPreExecuteDecision {
  readonly args: unknown;
  readonly changed: boolean;
  readonly auditReasons: readonly string[];
  readonly requireAskReason?: string;
  readonly veto?: ExecutableToolResult;
}

export interface ToolPostExecuteDecision {
  readonly result: ExecutableToolResult;
  readonly preserveOriginalInAudit: boolean;
  readonly reminders: readonly { readonly text: string; readonly variant: string }[];
}

export interface IPluginExtensionPortRegistryReader extends IPluginExtensionPortRegistry {
  readonly onDidChange: Event<void>;
  readonly hasRequestPolicies: boolean;
  readonly hasSettledResponseObservers: boolean;
  readonly hasCompactionPolicies: boolean;
  readonly hasRecoveryPolicies: boolean;
  readonly hasLoopPolicies: boolean;
  readonly hasToolPreExecutePolicies: boolean;
  readonly hasToolPostExecutePolicies: boolean;
  readonly hasToolExecutionWrappers: boolean;
  readonly hasSubagentDispatchAdvisors: boolean;
  readonly hasSubagentReturnAdvisors: boolean;
  collectPreBaselinePatch(snapshot: FrozenLLMRequestSnapshot, signal: AbortSignal): Promise<PreBaselineRequestPatch>;
  activeStreamTaps(): readonly LLMStreamTapObserver[];
  dispatchSettledResponse(snapshot: SettledLLMResponseSnapshot, signal: AbortSignal): Promise<readonly ExtensionPortInvocationError[]>;
  proposeRecovery(snapshot: LoopFailureSnapshot, signal: AbortSignal): Promise<RecoveryProposal>;
  renderPromptSections(context: Parameters<PromptSectionContribution['render']>[0]): Promise<RenderedPromptSections>;
  activeStepContextReminders(): readonly StepContextReminderContribution[];
  collectStepContextReminder(contribution: StepContextReminderContribution,
    context: Parameters<StepContextReminderContribution['collect']>[0]): Promise<StepReminderResult>;
  buildCompactionGuidance(
    selection: Parameters<NonNullable<CompactionPolicyContribution['matches']>>[0],
    context: Parameters<NonNullable<CompactionPolicyContribution['buildSummaryGuidance']>>[0],
  ): Promise<CompactionGuidance>;
  proposePreStep(snapshot: LoopBoundarySnapshot, signal: AbortSignal): Promise<LoopBoundaryProposal>;
  proposePostStep(snapshot: LoopBoundarySnapshot, signal: AbortSignal): Promise<LoopBoundaryProposal>;
  proposeToolPreExecute(context: {
    readonly sessionId: string;
    readonly agentId: string;
    readonly turnId: number;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: unknown;
    readonly accesses?: ToolAccesses;
    readonly signal: AbortSignal;
  }): Promise<ToolPreExecuteDecision>;
  executeApprovedTool(
    context: ApprovedToolExecutionWrapperContext,
    terminal: (signal: AbortSignal) => Promise<ExecutableToolResult>,
  ): Promise<ExecutableToolResult>;
  proposeToolPostExecute(context: {
    readonly sessionId: string;
    readonly agentId: string;
    readonly turnId: number;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: unknown;
    readonly result: ExecutableToolResult;
    readonly wasDenied?: boolean;
    readonly signal: AbortSignal;
  }): Promise<ToolPostExecuteDecision>;
  formatToolResultPreview(input: {
    readonly toolName: string;
    readonly toolCallId: string;
    readonly rawText: string;
    readonly maxChars: number;
    readonly spillPath?: string;
  }): Promise<string | undefined>;
  proposeSubagentDispatch(snapshot: SubagentDispatchSnapshot, signal: AbortSignal): Promise<SubagentDispatchProposal>;
  proposeSubagentReturn(context: {
    readonly sessionId: string;
    readonly parentAgentId: string;
    readonly childAgentId: string;
    readonly profileName?: string;
    readonly summary: string;
    readonly signal: AbortSignal;
  }): Promise<SubagentReturnProposal>;
  dynamicExecutor(protocol: AgentExecutorProtocol): DynamicExecutorContribution | undefined;
  dynamicExecutors(): readonly DynamicExecutorContribution[];
  createDynamicExecutorSession(contribution: DynamicExecutorContribution, context: AgentExecutorContext): AgentExecutorSession;
}

export const IPluginExtensionPortRegistryReader = refineServiceDecorator<
  IPluginExtensionPortRegistry,
  IPluginExtensionPortRegistryReader
>(IPluginExtensionPortRegistry);

export type RequestPolicyHandler = Parameters<IPluginExtensionPortRegistry['registerRequestPolicy']>[1];
export type RecoveryPolicyHandler = Parameters<IPluginExtensionPortRegistry['registerRecoveryPolicy']>[1];
export type LoopPolicyHandler = Parameters<IPluginExtensionPortRegistry['registerPreStepPolicy']>[1];
export type ToolPreExecuteHandler = Parameters<IPluginExtensionPortRegistry['registerToolPreExecutePolicy']>[1];
export type ApprovedToolExecutionWrapper = Parameters<IPluginExtensionPortRegistry['registerApprovedToolExecutionWrapper']>[1];
export type ToolPostExecuteHandler = Parameters<IPluginExtensionPortRegistry['registerToolPostExecutePolicy']>[1];
export type SubagentDispatchAdvisor = Parameters<IPluginExtensionPortRegistry['registerSubagentDispatchAdvisor']>[1];
export type SubagentReturnAdvisor = Parameters<IPluginExtensionPortRegistry['registerSubagentReturnAdvisor']>[1];
export type SettledResponseObserver = Parameters<IPluginExtensionPortRegistry['registerSettledResponseObserver']>[1];
export type HttpRouteHandler = Parameters<IPluginExtensionPortRegistry['registerHttpRoute']>[1];
export type PromptContext = Parameters<PromptSectionContribution['render']>[0];
export type StepReminderResult = string | readonly ContentPart[] | undefined;
export type ToolProposal = ToolPreExecuteProposal | ToolPostExecuteProposal;
export type Registration = IDisposable;
