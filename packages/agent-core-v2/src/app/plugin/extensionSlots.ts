import type {
  PluginGuiSlotContribution,
  PluginHttpRouteDescriptor,
  PluginWsTopicDescriptor,
} from '@kiki/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { CompactionSource } from '#/agent/fullCompaction/types';
import type {
  AgentExecutorDescriptor,
  AgentExecutorProtocol,
  AgentExecutorProvider,
} from '#/app/agentExecutor/agentExecutor';
import type {
  FrozenLLMRequestSnapshot,
  LLMStreamTapObserver,
  PreBaselineRequestPatch,
  SettledLLMResponseSnapshot,
} from '#/kosong/contract/extensionHooks';
import type { ContentPart } from '#/kosong/contract/message';
import type { FinishReason, ThinkingEffort } from '#/kosong/contract/provider';
import type { TokenUsage } from '#/kosong/contract/usage';
import type {
  DynamicProtocolBaseContribution,
  DynamicProviderContribution,
} from '#/kosong/protocol/extensionRegistry';
import type { ExecutableToolContext, ExecutableToolResult, ToolAccesses } from '#/tool/toolContract';

/** Canonical identifiers of Kiki's 12 first-class extension slots. */
export type ExtensionSlotId =
  | 'E1:llm-adapter'
  | 'E2:llm-request'
  | 'E3:llm-stream'
  | 'E4:llm-error-recovery'
  | 'E5:prompt-context'
  | 'E6:context-compaction'
  | 'E7:agent-loop'
  | 'E8:tool-pipeline'
  | 'E9:subagent-dispatch'
  | 'E10:executor-registry'
  | 'E11:session-state'
  | 'E12:server-gui-slots';

/** Delivery phase of a failed model/step attempt observed by E4 recovery policy hooks. */
export type AttemptDeliveryPhase =
  | 'not_sent'
  | 'sent_outcome_unknown'
  | 'partial_output_unclosed'
  | 'tools_already_executed'
  | 'persistence_only_failure';

/** Immutable snapshot of a step failure supplied to E4 recovery policy hooks. */
export interface LoopFailureSnapshot {
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: number;
  readonly step: number;
  readonly logicalStepId: string;
  readonly attempt: number;
  readonly deliveryPhase: AttemptDeliveryPhase;
  readonly errorCode?: string;
  readonly providerErrorCode?: string;
  readonly statusCode?: number;
  readonly errorMessage: string;
  readonly modelAlias: string;
  readonly protocol: string;
  readonly providerType?: string;
  readonly recoveryStreakCount: number;
  readonly maxRecoveryBudget: number;
}

/** Pure algebraic recovery proposal returned by E4 hooks and adjudicated by `AgentLoopService`. */
export type RecoveryProposal =
  | { readonly action: 'pass' }
  | {
      readonly action: 'retry_same_step';
      readonly delayMs: number;
      readonly thinkingEffortOverride?: ThinkingEffort;
      readonly rotateCredentialAccountRef?: string;
      readonly fallbackModelAlias?: string;
    }
  | {
      readonly action: 'enqueue_recovery_continuation';
      readonly delayMs?: number;
      readonly reminderText: string;
      readonly variant: string;
    }
  | {
      readonly action: 'compact_and_retry';
      readonly instruction?: string;
    }
  | {
      readonly action: 'abort_with_diagnostic';
      readonly userFacingMessage: string;
    };

/** Static system-prompt section contribution registered on slot E5. */
export interface PromptSectionContribution {
  readonly pluginId: string;
  readonly sectionId: string;
  readonly order: number;
  readonly suppressRuntimeContext?: boolean;
  render(context: {
    readonly sessionId: string;
    readonly agentId: string;
    readonly profileName?: string;
    readonly modelAlias?: string;
    readonly workspaceRoot?: string;
  }): string | undefined | Promise<string | undefined>;
}

/** Step-head stateful reminder contribution bridged onto `IAgentContextInjectorService` (slot E5). */
export interface StepContextReminderContribution {
  readonly pluginId: string;
  readonly reminderKey: string;
  collect(context: {
    readonly sessionId: string;
    readonly agentId: string;
    readonly turnId: number;
    readonly step: number;
    readonly isNewTurn: boolean;
    readonly signal: AbortSignal;
  }): string | readonly ContentPart[] | undefined | Promise<string | readonly ContentPart[] | undefined>;
}

/** Pluggable compaction summary and retention advisor operating inside Kiki's transactional compaction shell (slot E6). */
export interface CompactionPolicyContribution {
  readonly pluginId: string;
  readonly priority?: number;
  matches?(context: {
    readonly modelAlias: string;
    readonly protocol: string;
    readonly providerType?: string;
    readonly source: CompactionSource;
  }): boolean;
  buildSummaryGuidance?(context: {
    readonly sessionId: string;
    readonly agentId: string;
    readonly history: readonly Readonly<ContextMessage>[];
    readonly compactCount: number;
    readonly instruction?: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly additionalInstructions?: string;
    readonly preservedFileIndexMarkdown?: string;
  } | undefined>;
}

/** Loop step boundary snapshot supplied to E7 pre-step and post-step policy hooks. */
export interface LoopBoundarySnapshot {
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: number;
  readonly step: number;
  readonly firstStepOfTurn: boolean;
  readonly modelAlias: string;
  readonly thinkingEffort?: ThinkingEffort;
  readonly finishReason?: FinishReason;
  readonly usage?: Readonly<TokenUsage>;
  readonly stopTurnRequested?: boolean;
  readonly continuationStreakCount: number;
  readonly newMessagesSinceLastStep?: readonly Readonly<ContextMessage>[];
}

/** Pure proposal returned by E7 loop boundary hooks; host enforces cancel, pause, and max-step budgets. */
export type LoopBoundaryProposal =
  | { readonly action: 'continue_normal' }
  | {
      readonly action: 'override_step_thinking';
      readonly thinkingEffort: ThinkingEffort;
    }
  | {
      readonly action: 'prevent_stop_and_continue';
      readonly reminderText: string;
      readonly variant: string;
    }
  | {
      readonly action: 'request_turn_stop';
      readonly reason: string;
    };

/** Pre-approval tool argument/gate proposal on slot E8; any rewritten arguments re-enter host approval. */
export type ToolPreExecuteProposal =
  | { readonly decision: 'pass' }
  | {
      readonly decision: 'propose_args';
      readonly rewrittenArgs: unknown;
      readonly auditReason: string;
    }
  | {
      readonly decision: 'require_ask';
      readonly promptReason: string;
    }
  | {
      readonly decision: 'veto';
      readonly errorOutput: string;
    };

/** Approved post-authorization execution wrapper on slot E8 preserving `timeout-policy` signal/quiescence semantics without mutating approved arguments. */
export interface ApprovedToolExecutionWrapperContext {
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: number;
  readonly step?: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly approvedArgs: unknown;
  readonly declaredTimeoutMs?: number | null;
  readonly execContext: ExecutableToolContext;
}

/** Post-execution tool output shaping and reminder proposal on slot E8 (also invoked on denied calls with `wasDenied: true`). */
export interface ToolPostExecuteProposal {
  readonly shapedResult?: ExecutableToolResult;
  readonly preserveOriginalInAudit?: boolean;
  readonly oneOffSystemReminder?: {
    readonly text: string;
    readonly variant: string;
  };
}

/** Custom spill/budget formatter registered on slot E8 (`IAgentToolResultTruncationService`). */
export interface ToolResultBudgetContribution {
  readonly pluginId: string;
  readonly toolNames?: readonly string[];
  formatPreview?(input: {
    readonly toolName: string;
    readonly toolCallId: string;
    readonly rawText: string;
    readonly maxChars: number;
    readonly spillPath?: string;
  }): string | undefined | Promise<string | undefined>;
}

/** Read-only subagent dispatch snapshot supplied to E9 routing/model advisors before durable launch commit. */
export interface SubagentDispatchSnapshot {
  readonly sessionId: string;
  readonly requesterAgentId: string;
  readonly targetProfileName?: string;
  readonly routeId?: string;
  readonly requestedModelAlias?: string;
  readonly requestedThinkingEffort?: string;
  readonly requestedExecutorInstance?: string;
  readonly allowedModels?: readonly string[];
  readonly deniedModels?: readonly string[];
}

/** Model/instance recommendation returned by E9 dispatch hooks; intersected with host profile/lease ceilings. */
export interface SubagentDispatchProposal {
  readonly recommendedModelAlias?: string;
  readonly recommendedThinkingEffort?: string;
  readonly recommendedExecutorAccountId?: string;
  readonly rationale?: string;
}

/** Subagent return calibration proposal on slot E9 before parent receipt delivery. */
export interface SubagentReturnProposal {
  readonly advisoryNote?: string;
  readonly variant?: string;
}

/** Dynamic external executor registration on slot E10. */
export interface DynamicExecutorContribution {
  readonly pluginId: string;
  readonly protocol: AgentExecutorProtocol;
  readonly descriptor: AgentExecutorDescriptor;
  readonly provider: AgentExecutorProvider;
}

/** Request handler invoked by kap-server's `/api/plugins/:pluginId/*` authenticated HTTP broker (slot E12). */
export interface PluginHttpRouteHandlerContext {
  readonly pluginId: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly subpath: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
  readonly spaceId?: string;
  readonly sessionId?: string;
  readonly signal: AbortSignal;
}

/** Structured HTTP response returned by a plugin route handler through the host envelope broker. */
export interface PluginHttpRouteResult {
  readonly status?: 200 | 201 | 400 | 403 | 404 | 409 | 429 | 500;
  readonly data?: unknown;
  readonly errorMessage?: string;
}

/** Central App-scoped port registry where built-in Features, Tier 1 Cordis plugins, Tier 2 proxies, and `dsh-compat` register E1-E12 handlers. */
export interface IPluginExtensionPortRegistry {
  readonly _serviceBrand: undefined;

  registerProtocolBase(contribution: DynamicProtocolBaseContribution): IDisposable;
  registerProviderAdapter(contribution: DynamicProviderContribution): IDisposable;

  registerRequestPolicy(
    pluginId: string,
    handler: (
      snapshot: FrozenLLMRequestSnapshot,
      signal: AbortSignal,
    ) => PreBaselineRequestPatch | undefined | Promise<PreBaselineRequestPatch | undefined>,
  ): IDisposable;

  registerStreamTap(pluginId: string, tap: LLMStreamTapObserver): IDisposable;
  registerSettledResponseObserver(
    pluginId: string,
    observer: (
      snapshot: SettledLLMResponseSnapshot,
      signal: AbortSignal,
    ) => void | Promise<void>,
  ): IDisposable;

  registerRecoveryPolicy(
    pluginId: string,
    handler: (
      snapshot: LoopFailureSnapshot,
      signal: AbortSignal,
    ) => RecoveryProposal | Promise<RecoveryProposal>,
  ): IDisposable;

  registerPromptSection(contribution: PromptSectionContribution): IDisposable;
  registerStepContextReminder(contribution: StepContextReminderContribution): IDisposable;
  registerCompactionPolicy(contribution: CompactionPolicyContribution): IDisposable;

  registerPreStepPolicy(
    pluginId: string,
    handler: (
      snapshot: LoopBoundarySnapshot,
      signal: AbortSignal,
    ) => LoopBoundaryProposal | Promise<LoopBoundaryProposal>,
  ): IDisposable;

  registerPostStepPolicy(
    pluginId: string,
    handler: (
      snapshot: LoopBoundarySnapshot,
      signal: AbortSignal,
    ) => LoopBoundaryProposal | Promise<LoopBoundaryProposal>,
  ): IDisposable;

  registerToolPreExecutePolicy(
    pluginId: string,
    handler: (
      context: {
        readonly sessionId: string;
        readonly agentId: string;
        readonly turnId: number;
        readonly toolCallId: string;
        readonly toolName: string;
        readonly args: unknown;
        readonly accesses?: ToolAccesses;
        readonly signal: AbortSignal;
      },
    ) => ToolPreExecuteProposal | Promise<ToolPreExecuteProposal>,
  ): IDisposable;

  registerApprovedToolExecutionWrapper(
    pluginId: string,
    wrapper: (
      context: ApprovedToolExecutionWrapperContext,
      next: (overrideSignal?: AbortSignal) => Promise<ExecutableToolResult>,
    ) => Promise<ExecutableToolResult>,
    options?: { readonly order?: number },
  ): IDisposable;

  registerToolPostExecutePolicy(
    pluginId: string,
    handler: (
      context: {
        readonly sessionId: string;
        readonly agentId: string;
        readonly turnId: number;
        readonly toolCallId: string;
        readonly toolName: string;
        readonly args: unknown;
        readonly result: ExecutableToolResult;
        readonly wasDenied?: boolean;
        readonly signal: AbortSignal;
      },
    ) => ToolPostExecuteProposal | undefined | Promise<ToolPostExecuteProposal | undefined>,
  ): IDisposable;

  registerToolResultBudget(contribution: ToolResultBudgetContribution): IDisposable;

  registerSubagentDispatchAdvisor(
    pluginId: string,
    handler: (
      snapshot: SubagentDispatchSnapshot,
      signal: AbortSignal,
    ) => SubagentDispatchProposal | undefined | Promise<SubagentDispatchProposal | undefined>,
  ): IDisposable;

  registerSubagentReturnAdvisor(
    pluginId: string,
    handler: (
      context: {
        readonly sessionId: string;
        readonly parentAgentId: string;
        readonly childAgentId: string;
        readonly profileName?: string;
        readonly summary: string;
        readonly signal: AbortSignal;
      },
    ) => SubagentReturnProposal | undefined | Promise<SubagentReturnProposal | undefined>,
  ): IDisposable;

  registerDynamicExecutor(contribution: DynamicExecutorContribution): IDisposable;

  registerHttpRoute(
    descriptor: PluginHttpRouteDescriptor,
    handler: (ctx: PluginHttpRouteHandlerContext) => Promise<PluginHttpRouteResult>,
  ): IDisposable;

  registerWsTopic(descriptor: PluginWsTopicDescriptor): IDisposable;
  publishWsTopicEvent(input: {
    readonly pluginId: string;
    readonly topic: string;
    readonly sessionId?: string;
    readonly spaceId?: string;
    readonly payload: unknown;
  }): void;

  registerGuiSlot(contribution: PluginGuiSlotContribution): IDisposable;
  listGuiSlots(filter?: {
    readonly workspaceId?: string;
    readonly sessionId?: string;
  }): readonly PluginGuiSlotContribution[];
}

export const IPluginExtensionPortRegistry: ServiceIdentifier<IPluginExtensionPortRegistry> =
  createDecorator<IPluginExtensionPortRegistry>('pluginExtensionPortRegistry');
