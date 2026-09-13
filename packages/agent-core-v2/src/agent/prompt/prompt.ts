import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { Turn, TurnResult } from '#/agent/loop/loop';
import type { ContentPart } from '#/kosong/contract/message';
import type { Hooks } from '#/hooks';
import type { SessionHistoryMutationLease } from '#/session/historyMutation/historyMutation';

export interface PromptSubmitContext {
  readonly promptMessage: ContextMessage;
  readonly isSteer: boolean;
  block: boolean;
}

/**
 * Execution selections apply at launch, not while queued. Runtime controls are
 * main-agent-only. State echoes may steer; actual pending control changes
 * require their own turn. Prompts wait for active autonomous turns and take
 * priority over the next goal continuation. Loop admission remains reserved
 * throughout asynchronous execution preparation.
 * Plan, swarm and goal changes run after profile/media preparation and submit
 * hooks. A later launch failure reports a failed prompt without rolling back
 * successful domain operations or retrying those controls automatically.
 * Goal operations retain their admitted goal identity; replacing that goal,
 * even with the same objective, fails the stale prompt instead of controlling
 * the replacement. A yielded goal pauses on prompt launch failure and blocks
 * on a blocked prompt; neither case silently restarts its continuation.
 */
export interface PromptExecutionBinding {
  readonly profile?: string;
  readonly model?: string;
  readonly thinking?: string;
  /** Applied at prompt launch, after media intake and submit hooks; never while queued. */
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly goalObjective?: string;
  /** Prompt-bound control; resume does not launch an autonomous continuation. */
  readonly goalControl?: 'pause' | 'resume' | 'cancel';
}

export interface PromptInput {
  readonly id?: string;
  readonly message: ContextMessage;
  readonly execution?: PromptExecutionBinding;
  readonly deferredDisabledTools?: readonly string[];
  readonly historyMutationLease?: SessionHistoryMutationLease;
  readonly alreadyMaterialized?: boolean;
}

export type PromptState =
  | 'pending'
  | 'running'
  | 'steered'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export interface PromptCompletion {
  readonly promptId: string;
  readonly result: TurnResult | undefined;
  readonly state: Extract<PromptState, 'completed' | 'failed' | 'cancelled' | 'blocked'>;
}

export interface PromptSnapshot {
  readonly id: string;
  readonly userMessageId: string;
  readonly createdAt: string;
  readonly state: PromptState;
  readonly message: ContextMessage;
}

export interface PromptHandle extends PromptSnapshot {
  readonly launched: Promise<Turn | undefined>;
  readonly completion: Promise<PromptCompletion>;
}

export interface PromptQueueSnapshot {
  readonly active: PromptSnapshot | undefined;
  readonly pending: readonly PromptSnapshot[];
}

export interface PromptPayload {
  readonly input: readonly ContentPart[];
  readonly execution?: PromptExecutionBinding;
  /**
   * Client-managed session tool denylist (full-replace semantics), applied
   * before the prompt is enqueued. Omit to keep the current value; `[]`
   * clears the client portion.
   */
  readonly disabledTools?: readonly string[];
  /**
   * Client-chosen prompt record id, echoed on the consuming turn's
   * `turn.started` (`promptId`). A duplicate id rejects the submission before
   * any session state is touched.
   */
  readonly promptId?: string;
}

export interface SteerPayload {
  readonly input: readonly ContentPart[];
}

export interface PromptLaunchResult {
  readonly turn_id: number;
}

export interface PromptReservation extends IDisposable {
  readonly id: string;
  submit(
    message: ContextMessage,
    execution?: PromptExecutionBinding,
    deferredDisabledTools?: readonly string[],
  ): Promise<PromptHandle>;
}

export const promptAdmission = Symbol('promptAdmission');

type PromptAdmissionHook = (promptId?: string) => PromptReservation;

export function reservePrompt(service: IAgentPromptService, promptId?: string): PromptReservation {
  return (service as IAgentPromptService & { [promptAdmission]: PromptAdmissionHook })[
    promptAdmission
  ](promptId);
}

export interface IAgentPromptService {
  readonly _serviceBrand: undefined;
  enqueue(input: PromptInput): Promise<PromptHandle>;
  submit(payload: PromptPayload): Promise<PromptLaunchResult | undefined>;
  submitSteer(payload: SteerPayload): Promise<PromptLaunchResult | undefined>;
  list(): PromptQueueSnapshot;
  /** Replaces caller-visible content in place; text-only edits retain existing non-text attachments. */
  replace(promptId: string, content: readonly ContentPart[]): PromptHandle;
  steer(promptIds: readonly string[]): Promise<readonly PromptHandle[]>;
  abort(promptId: string, reason?: Error): boolean;
  drain(reason?: Error): Promise<void>;
  inject(message: ContextMessage): Promise<Turn | undefined>;
  retry(): Promise<Turn | undefined>;
  clear(): void;
  readonly hooks: Hooks<{ onBeforeSubmitPrompt: PromptSubmitContext }>;
}

export const IAgentPromptService = createDecorator<IAgentPromptService>('agentPromptService');
