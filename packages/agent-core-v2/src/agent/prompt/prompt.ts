import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { Turn, TurnResult } from '#/agent/loop/loop';
import type { ContentPart } from '#/kosong/contract/message';
import type { Hooks } from '#/hooks';
import type { SessionHistoryMutationLease } from '#/session/historyMutation/historyMutation';
import type { GoalFollowUpTiming } from '#/agent/goal/types';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { PlanGate } from '#/features/plan/configSection';

/** One hook invocation per consumed input batch; promptMessage summarizes the batch while original messages retain their identities. */
export interface PromptSubmitContext {
  readonly promptMessage: ContextMessage;
  readonly messages?: readonly ContextMessage[];
  readonly isSteer: boolean;
  readonly appendMessage?: (message: ContextMessage) => void;
  block: boolean;
}

/**
 * Execution selections apply at launch, not while queued. Runtime controls are
 * main-agent-only. State echoes may steer; actual pending control changes
 * require their own turn. Prompts wait for active autonomous turns and take
 * priority over the next goal continuation. Loop admission remains reserved
 * throughout asynchronous execution preparation.
 * Plan and goal changes run after profile/media preparation and submit
 * hooks. A later launch failure reports a failed prompt without rolling back
 * successful domain operations or retrying those controls automatically.
 * Goal operations retain their admitted goal identity; replacing that goal,
 * even with the same objective, fails the stale prompt instead of controlling
 * the replacement. A yielded goal pauses on prompt launch failure and blocks
 * on a blocked prompt; neither case silently restarts its continuation.
 */
export type DeferredAppendTiming = 'agent_idle' | 'subagents_done' | 'tasks_done';

export interface PromptExecutionBinding {
  readonly execution?: import('@kiki/protocol').ExecutionSelection;
  readonly afterModelSwitch?: string;
  readonly modelSwitchMode?: import('#/agent/modelSwitch/modelSwitch').ModelSwitchMode;
  readonly personaGreetingReply?: boolean;
  readonly profile?: string;
  readonly model?: string;
  readonly thinking?: string | null;
  readonly permissionMode?: PermissionMode;
  readonly planGate?: PlanGate;
  /** Applied at prompt launch, after media intake and submit hooks; never while queued. */
  readonly planMode?: boolean;
  readonly goalObjective?: string;
  readonly goalFollowUpTiming?: GoalFollowUpTiming;
  readonly goalInitialStatus?: 'active' | 'paused';
  /** Prompt-bound control; resume does not launch an autonomous continuation. */
  readonly goalControl?: 'pause' | 'resume' | 'cancel';
}

export interface PromptContentRange {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

export interface PromptInput {
  readonly parentReceiptManaged?: boolean;
  readonly id?: string;
  readonly userMessageId?: string;
  readonly retryFingerprint?: string;
  readonly retryContentRanges?: readonly PromptContentRange[];
  readonly message: ContextMessage;
  /** Commits an admitted history rewrite after prompt preparation, before queue publication. */
  readonly commitHistoryRewrite?: (prompt: import('./promptService').PromptEnqueuedPayload) => Promise<void>;
  readonly execution?: PromptExecutionBinding;
  readonly appendTiming?: DeferredAppendTiming;
  readonly deferredDisabledTools?: readonly string[];
  /** When false, enqueue returns the accepted handle without awaiting a turn launch. */
  readonly waitForLaunch?: boolean;
  readonly historyMutationLease?: SessionHistoryMutationLease;
  readonly alreadyMaterialized?: boolean;
  /** Cancels this submission through admission, launch, and its own turn; never a later prompt. */
  readonly signal?: AbortSignal;
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
  readonly execution?: PromptExecutionBinding;
  readonly queueIndex?: number;
  readonly appendTiming?: DeferredAppendTiming;
  readonly revision?: number;
  readonly error?: import('#/_base/errors/serialize').ErrorPayload;
}

export interface PromptHandle extends PromptSnapshot {
  readonly deliveryReason?: 'model_switch_boundary' | 'no_active_turn' | 'executor_deferred' | 'external_retry';
  readonly launched: Promise<Turn | undefined>;
  readonly completion: Promise<PromptCompletion>;
}

/** How long an unrenewed edit hold keeps a queued prompt parked. */
export const PROMPT_EDIT_HOLD_TTL_MS = 5 * 60_000;

export interface PromptQueueHold {
  readonly reason: 'recovery';
  readonly count: number;
}

export interface PromptQueueSnapshot {
  readonly modelSwitches?: readonly (import('./modelSwitchQueueOps').QueuedModelSwitch & { readonly queueIndex: number })[];
  readonly active: PromptSnapshot | undefined;
  readonly pending: readonly PromptSnapshot[];
  /** A prompt past admission that has not been assigned a turn yet. */
  readonly launching?: PromptSnapshot;
  readonly hold?: PromptQueueHold;
}

export interface PromptPayload {
  readonly input: readonly ContentPart[];
  readonly execution?: PromptExecutionBinding;
  readonly appendTiming?: DeferredAppendTiming;
  /**
   * Client-managed session tool denylist (full-replace semantics), applied
   * before the prompt is enqueued. Omit to keep the current value; `[]`
   * clears the client portion.
   */
  readonly disabledTools?: readonly string[];
  /**
   * Client-chosen prompt record id, echoed on the consuming turn's
   * `turn.started` (`promptId`). Direct core submissions reject duplicate ids;
   * the server's bounded native-child text retry path can replay its own durable receipt.
   */
  readonly promptId?: string;
}

export interface SteerPayload {
  readonly input: readonly ContentPart[];
}

export interface PromptInjectOptions {
  readonly promptId?: string;
  readonly userMessageId?: string;
  readonly retryFingerprint?: string;
}

export interface PromptLaunchResult {
  readonly turn_id: number;
  readonly prompt_id?: string;
  readonly created_at?: string;
  readonly state?: 'running' | 'queued' | 'blocked';
  readonly append_timing?: DeferredAppendTiming;
  readonly revision?: number;
}

/** A serializable terminal receipt for this submission, including prompts that never launch. */
export interface PromptTerminalResult {
  readonly promptId: string;
  readonly turnId?: number;
  readonly state: PromptCompletion['state'];
  readonly result?:
    | Extract<TurnResult, { type: 'completed' }>
    | { readonly type: 'failed'; readonly steps: number; readonly error: import('#/_base/errors/serialize').ErrorPayload }
    | { readonly type: 'cancelled'; readonly steps: number; readonly reason: import('#/_base/errors/serialize').ErrorPayload };
}

export interface PromptReservation extends IDisposable {
  readonly id: string;
  submit(
    message: ContextMessage,
    execution?: PromptExecutionBinding,
    deferredDisabledTools?: readonly string[],
    appendTiming?: DeferredAppendTiming,
    signal?: AbortSignal,
  ): Promise<PromptHandle>;
}

export const promptAdmission = Symbol('promptAdmission');

export interface PromptAdmissionOptions {
  readonly waitForLaunch?: boolean;
  readonly contentRanges?: readonly PromptContentRange[];
}

type PromptAdmissionHook = (promptId?: string, durableAcceptance?: boolean, retryFingerprint?: string, options?: PromptAdmissionOptions) => PromptReservation;

export function reservePrompt(service: IAgentPromptService, promptId?: string, durableAcceptance = false, retryFingerprint?: string, options?: PromptAdmissionOptions): PromptReservation {
  return (service as IAgentPromptService & { [promptAdmission]: PromptAdmissionHook })[
    promptAdmission
  ](promptId, durableAcceptance, retryFingerprint, options);
}

export const promptRetry = Symbol('promptRetry');

export interface PromptRetryHook {
  lookup(promptId: string, fingerprint: string): Promise<import('./promptOps').PromptRetryReceipt | undefined>;
  commit(promptId: string, fingerprint: string, receipt: import('./promptOps').PromptRetryReceipt): Promise<void>;
  run<T>(promptId: string, fingerprint: string, operation: () => Promise<T>): Promise<T>;
}

export function promptRetryFor(service: IAgentPromptService): PromptRetryHook {
  return (service as IAgentPromptService & { [promptRetry]: PromptRetryHook })[promptRetry];
}

export interface IAgentPromptService {
  readonly _serviceBrand: undefined;
  switchModel(input: import('#/agent/modelSwitch/modelSwitch').ModelSwitchInput): Promise<import('#/agent/modelSwitch/modelSwitch').ModelSwitchReceipt>;
  getModelSwitch(operationId: string): import('#/agent/modelSwitch/modelSwitch').ModelSwitchReceipt | undefined;
  listModelSwitches(): readonly (import('./modelSwitchQueueOps').QueuedModelSwitch & { readonly queueIndex: number })[];
  updateModelSwitch(input: import('#/agent/modelSwitch/modelSwitch').ModelSwitchInput, expectedRevision?: number): Promise<import('#/agent/modelSwitch/modelSwitch').ModelSwitchReceipt>;
  cancelModelSwitch(operationId: string): Promise<import('#/agent/modelSwitch/modelSwitch').ModelSwitchReceipt>;
  recoverModelSwitch(operationId: string, action: 'retry' | 'keep_original', mode?: import('#/agent/modelSwitch/modelSwitch').ModelSwitchMode): Promise<import('#/agent/modelSwitch/modelSwitch').ModelSwitchReceipt>;
  lookup(promptId: string, input?: PromptInput): import('./promptReplay').PromptLookup | undefined;
  enqueue(input: PromptInput): Promise<PromptHandle>;
  enqueueCron(input: { readonly origin: import('#/agent/contextMemory/types').CronJobOrigin; readonly prompt: string }): Promise<PromptHandle>;
  submit(payload: PromptPayload): Promise<PromptLaunchResult | undefined>;
  /** Abort cancels only the wait; use abort(promptId) to cancel the submitted prompt. */
  submitAndWait(payload: PromptPayload, signal?: AbortSignal): Promise<PromptTerminalResult>;
  submitSteer(payload: SteerPayload): Promise<PromptLaunchResult | undefined>;
  /**
   * The queue as callers may act on it: `active` is the running prompt,
   * `pending` the prompts awaiting a compatible input batch, and `launching`
   * the leading prompt preparing that batch before turn assignment. A
   * launching prompt accepts `abort` only; replace/move/timing/steer cannot
   * address it.
   */
  list(): PromptQueueSnapshot;
  hasReadyPending(): boolean;
  resumeRecoveredQueue(): void;
  /** Replaces caller-visible content in place; text-only edits retain attachments unless replaceAttachments is true. */
  replace(promptId: string, content: readonly ContentPart[], replaceAttachments?: boolean): PromptHandle;
  changeTiming(
    promptId: string,
    appendTiming: DeferredAppendTiming,
    expectedRevision?: number,
  ): PromptHandle;
  move(promptId: string, targetIndex: number): void;
  /**
   * Edit hold: while a client edits a queued prompt, that prompt and every
   * prompt queued after it wait (manual order is kept); prompts ahead of it
   * still launch. The hold lapses on its own after `PROMPT_EDIT_HOLD_TTL_MS`
   * unless renewed, so a client that disappears mid-edit cannot stall the
   * queue. Explicit steer still bypasses it.
   */
  setEditHold(promptId: string, held: boolean): void;
  /** Send selected prompts at the next safe boundary; compatible native inputs share one batch and submit hook while keeping their own handles. Timing and recovery holds are bypassed only for selected prompts. */
  steer(promptIds: readonly string[]): Promise<readonly PromptHandle[]>;
  /**
   * Cancels one prompt and returns whether this call cancelled something.
   * Targeted per state: a pending prompt leaves the queue, a prompt still
   * launching is cancelled before it can start, and a running or steered
   * prompt cancels its turn (a steered prompt shares the turn it joined, so
   * that turn's prompt settles with it). A restored pending identity that has
   * not yet entered the live queue is cancelled durably before it can launch.
   * `false` means a known prompt has already settled or its turn is over;
   * an unknown prompt id throws `prompt.not_found` and never falls back
   * to another prompt.
   */
  abort(promptId: string, reason?: Error): boolean;
  /** Remove an unlaunched queued request without cancelling a turn it has joined. */
  abortQueued(promptId: string): Promise<boolean>;
  /**
   * Stops admission and settles owned launch preparation and recovery hydration.
   * The default cancels durable pending requests. Normal owner shutdown uses
   * `preserve-pending`: local waiters settle without a durable cancellation for
   * unlaunched requests. Restore holds those requests until explicit resume;
   * launched or outcome-unknown requests are never automatically resent.
   */
  drain(reason: Error, mode?: 'cancel' | 'preserve-pending'): Promise<void>;
  inject(message: ContextMessage, options?: PromptInjectOptions): Promise<Turn | undefined>;
  retry(options?: { readonly parentReceiptManaged?: boolean }): Promise<Turn | undefined>;
  clear(): Promise<void>;
  readonly hooks: Hooks<{ onBeforeSubmitPrompt: PromptSubmitContext }>;
}

export const IAgentPromptService = createDecorator<IAgentPromptService>('agentPromptService');
