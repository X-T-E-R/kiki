import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { Turn } from '#/agent/loop/loop';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import type { Hooks } from '#/hooks';
import { defineState } from '#/state/state';

export const pendingSubagentReceiptsKey = defineState('subagent.pendingReceipts', () => 0);

/** External prompts carry unmaterialized logical inputs in `contextMessages`; executors record them after preparing any history handoff and before provider delivery. */
export type AgentRunRequest =
  | { readonly kind: 'prompt'; readonly prompt: string; readonly promptId?: string; readonly input?: readonly import('#/kosong/contract/message').ContentPart[]; readonly origin?: PromptOrigin; readonly contextMessages?: readonly ContextMessage[] }
  | { readonly kind: 'mailbox'; readonly prompt: string; readonly message: ContextMessage }
  | { readonly kind: 'retry'; readonly trigger?: string };

export interface RunAgentOptions {
  readonly parentReceiptManaged?: boolean;
  readonly capacityReservation?: import('#/session/dispatch/capacity').DispatchReservation;
  readonly signal: AbortSignal;
  readonly summaryPolicy?: AgentProfileSummaryPolicy;
  readonly onReady?: () => void;
  readonly onQueued?: () => void;
  /** Persist the delivery-attempt guard before entering an external executor; rejection prevents delivery. */
  readonly onBeforeExternalRun?: () => Promise<void>;
  /** Persist retry eligibility only when the executor confirms the prompt was not accepted remotely. */
  readonly onExternalRunNotSent?: () => Promise<void>;
}

export interface AgentRunHandle {
  readonly agentId: string;
  readonly turn: Turn;
  readonly completion: Promise<{ readonly summary: string; readonly usage?: TokenUsage }>;
}

export interface AgentTaskStartHookContext {
  readonly agentName: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
}

export interface AgentTaskStopHookContext {
  readonly agentName: string;
  readonly response: string;
}

export type AgentTaskHooks = {
  readonly onWillStartAgentTask: AgentTaskStartHookContext;
};

export interface ISessionSubagentService {
  readonly _serviceBrand: undefined;

  readonly hooks: Hooks<AgentTaskHooks>;

  readonly onDidStopAgentTask: Event<AgentTaskStopHookContext>;

  /** Discover saved autonomous results off the restore path, and only while execution is released. */
  startReceiptDiscovery(control: import('#/session/executionControl/executionControl').ISessionExecutionControl): void;
  stopReceiptDiscovery(): Promise<void>;

  run(agentId: string, request: AgentRunRequest, opts: RunAgentOptions): Promise<AgentRunHandle>;

  /** Keep the current agent-scope generation resident during admission and preparation without changing execution state. */
  retain(agentId: string): import('#/_base/di/lifecycle').ISyncDisposable;

  /** Track an admitted prompt run and defer idle release until its completion in the same agent-scope generation. */
  trackPromptRun(agentId: string, completion: Promise<unknown>, signal: AbortSignal): AbortSignal;

  notifyAgentTaskStopped(context: AgentTaskStopHookContext): void;
}

export const ISessionSubagentService: ServiceIdentifier<ISessionSubagentService> =
  createDecorator<ISessionSubagentService>('sessionSubagentService');
