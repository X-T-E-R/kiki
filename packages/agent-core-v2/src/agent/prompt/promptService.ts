/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { extractImageCompressionCaptions } from '#/agent/media/image-compress';
import { abortable, abortError, userCancellationReason } from '#/_base/utils/abort';
import { toErrorPayload } from '#/_base/errors/serialize';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { newMessageId } from '#/agent/contextMemory/messageId';
import { deliveryOriginOf, newDeliveryId } from '#/agent/contextMemory/messageDelivery';
import { USER_PROMPT_ORIGIN, type BundledSkillActivation, type ContextMessage, type PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService, type EnqueueReceipt, type Turn, type TurnResult } from '#/agent/loop/loop';
import { TurnSteer } from '#/agent/loop/turnOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentTaskService, type AgentTaskInfo } from '#/agent/task/task';
import { TaskSettlementReady } from '#/agent/task/taskOps';
import type { ExecutableToolResult } from '#/tool/toolContract';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IFileService } from '#/app/file/fileService';
import type { ContentPart } from '#/kosong/contract/message';
import { IEventService } from '#/app/event/event';
import { IEventBus } from '#/app/event/eventBus';
import { Event2, registerEvent2Class } from '#/app/event/event2';
import { ErrorCodes, Error2, isError2 } from '#/errors';
import { OrderedHookSlot } from '#/hooks';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';
import { ISessionHistoryMutationService } from '#/session/historyMutation/historyMutation';
import { KeyReservationRegistry } from '#/session/dispatch/reservation';
import type { PartsTransformer, WireRecord } from '#/wire/record';

import {
  IAgentPromptService,
  promptAdmission,
  type DeferredAppendTiming,
  type PromptCompletion,
  type PromptExecutionBinding,
  type PromptHandle,
  type PromptInput,
  type PromptLaunchResult,
  type PromptPayload,
  type PromptQueueHold,
  type PromptQueueSnapshot,
  type PromptReservation,
  type PromptSnapshot,
  type PromptState,
  type PromptSubmitContext,
  type PromptTerminalResult,
  type SteerPayload,
} from './prompt';
import { promptMetadataTextFromContentParts } from './promptMetadataText';
import { capturePromptGoalId, hasPromptRuntimeControls, preparePromptRuntimeControls, readPromptRuntimeControlChanges, validatePromptRuntimeControls } from './runtimeControls';
import { PromptStepRequest, RetryStepRequest, SteerStepRequest } from './promptStepRequests';
import { PromptAccepted, promptAdmissionKey } from './promptOps';
import { daemonFileRefFromPart } from '#/agent/media/mediaRef';
import { materializePromptDaemonRefs } from '#/agent/media/promptMediaIntake';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';

export interface PromptCompletedPayload {
  readonly promptId: string;
  readonly finishedAt: string;
  readonly reason: 'completed' | 'failed' | 'blocked';
}

const promptCompletedSchema = z.object({
  promptId: z.string().min(1),
  finishedAt: z.string(),
  reason: z.union([z.literal('completed'), z.literal('failed'), z.literal('blocked')]),
});

export class PromptCompleted extends Event2<PromptCompletedPayload> {
  static override readonly type = 'prompt.completed';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = promptCompletedSchema;
}
export interface PromptCompleted extends PromptCompletedPayload {}

export interface PromptAbortedPayload {
  readonly promptId: string;
  readonly abortedAt: string;
  readonly beforeStart?: boolean;
}

const promptAbortedSchema = z.object({
  promptId: z.string().min(1),
  abortedAt: z.string(),
  beforeStart: z.boolean().optional(),
});

export class PromptAborted extends Event2<PromptAbortedPayload> {
  static override readonly type = 'prompt.aborted';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = promptAbortedSchema;
}
export interface PromptAborted extends PromptAbortedPayload {}

export interface PromptSteeredPayload {
  readonly activePromptId: string;
  readonly promptIds: string[];
  readonly content: ContentPart[];
  readonly steeredAt: string;
}

const promptSteeredSchema = z.object({
  activePromptId: z.string(),
  promptIds: z.array(z.string()),
  content: z.custom<ContentPart[]>(),
  steeredAt: z.string(),
});

export class PromptSteered extends Event2<PromptSteeredPayload> {
  static override readonly type = 'prompt.steered';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = promptSteeredSchema;
}
export interface PromptSteered extends PromptSteeredPayload {}

export const promptResolutionKey = defineState('promptResolution', (): Map<string, true> => new Map())
  .replayable({ schema: z.map(z.string(), z.literal(true)) })
  .on(PromptCompleted, (state, event) => {
    if (state.has(event.promptId)) return state;
    state.set(event.promptId, true);
  })
  .on(PromptAborted, (state, event) => {
    if (state.has(event.promptId)) return state;
    state.set(event.promptId, true);
  })
  .on(PromptSteered, (state, event) => {
    for (const promptId of event.promptIds) {
      if (!state.has(promptId)) state.set(promptId, true);
    }
  });

const appendTimingSchema = z.enum(['agent_idle', 'subagents_done', 'tasks_done']);

export interface PromptQueuedPayload {
  readonly promptId: string;
  readonly content: ContentPart[];
  readonly queueLength: number;
  readonly appendTiming?: DeferredAppendTiming;
  readonly revision?: number;
}

export class PromptQueued extends Event2<PromptQueuedPayload> {
  static override readonly type = 'prompt.queued';
  static override readonly observable = true;
}
export interface PromptQueued extends PromptQueuedPayload {}

export interface PromptQueueHoldChangedPayload {
  readonly hold: PromptQueueHold | null;
}

export class PromptQueueHoldChanged extends Event2<PromptQueueHoldChangedPayload> {
  static override readonly type = 'prompt.queue_hold_changed';
  static override readonly observable = true;
}
export interface PromptQueueHoldChanged extends PromptQueueHoldChangedPayload {}

export interface PromptEnqueuedPayload {
  readonly schemaVersion: 1;
  readonly promptId: string;
  readonly userMessageId: string;
  readonly createdAt: string;
  readonly message: ContextMessage;
  readonly execution?: PromptExecutionBinding;
  readonly goalId?: string | null;
  readonly deferredDisabledTools?: readonly string[];
  readonly alreadyMaterialized: boolean;
  readonly appendTiming: DeferredAppendTiming;
  readonly revision: number;
  readonly queueIndex: number;
}

const promptEnqueuedSchema = z.object({
  schemaVersion: z.literal(1),
  promptId: z.string().min(1),
  userMessageId: z.string().min(1),
  createdAt: z.string(),
  message: z.custom<ContextMessage>(),
  execution: z.custom<PromptExecutionBinding>().optional(),
  goalId: z.string().nullable().optional(),
  deferredDisabledTools: z.array(z.string()).optional(),
  alreadyMaterialized: z.boolean(),
  appendTiming: appendTimingSchema,
  revision: z.number().int().nonnegative(),
  queueIndex: z.number().int().nonnegative(),
});

export class PromptEnqueued extends Event2<PromptEnqueuedPayload> {
  static override readonly type = 'prompt.enqueued';
  static override readonly durable = true;
  static override readonly schema = promptEnqueuedSchema;
}
export interface PromptEnqueued extends PromptEnqueuedPayload {}

export interface PromptReplacedPayload {
  readonly promptId: string;
  readonly content: ContentPart[];
  readonly message: ContextMessage;
  readonly execution?: PromptExecutionBinding;
  readonly revision: number;
  readonly replacedAt: string;
}

const promptReplacedSchema = z.object({
  promptId: z.string().min(1),
  content: z.custom<ContentPart[]>(),
  message: z.custom<ContextMessage>(),
  execution: z.custom<PromptExecutionBinding>().optional(),
  revision: z.number().int().nonnegative(),
  replacedAt: z.string(),
});

export class PromptReplaced extends Event2<PromptReplacedPayload> {
  static override readonly type = 'prompt.replaced';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = promptReplacedSchema;
}
export interface PromptReplaced extends PromptReplacedPayload {}

export interface PromptTimingChangedPayload {
  readonly promptId: string;
  readonly appendTiming: DeferredAppendTiming;
  readonly revision: number;
  readonly changedAt: string;
}

const promptTimingChangedSchema = z.object({
  promptId: z.string().min(1),
  appendTiming: appendTimingSchema,
  revision: z.number().int().nonnegative(),
  changedAt: z.string(),
});

export class PromptTimingChanged extends Event2<PromptTimingChangedPayload> {
  static override readonly type = 'prompt.timing_changed';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = promptTimingChangedSchema;
}
export interface PromptTimingChanged extends PromptTimingChangedPayload {}

export interface PromptMovedPayload {
  readonly promptId: string;
  readonly targetIndex: number;
  readonly queuedPromptIds: string[];
  readonly movedAt: string;
}

const promptMovedSchema = z.object({
  promptId: z.string().min(1),
  targetIndex: z.number().int().nonnegative(),
  queuedPromptIds: z.array(z.string().min(1)),
  movedAt: z.string(),
});

export class PromptMoved extends Event2<PromptMovedPayload> {
  static override readonly type = 'prompt.moved';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = promptMovedSchema;
}
export interface PromptMoved extends PromptMovedPayload {}
registerEvent2Class(PromptMoved);

export interface PromptLaunchCommittedPayload {
  readonly launchId: string;
  readonly promptId: string;
  readonly revision: number;
  readonly committedAt: string;
}

const promptLaunchCommittedSchema = z.object({
  launchId: z.string().min(1),
  promptId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  committedAt: z.string(),
});

export class PromptLaunchCommitted extends Event2<PromptLaunchCommittedPayload> {
  static override readonly type = 'prompt.launch_committed';
  static override readonly durable = true;
  static override readonly schema = promptLaunchCommittedSchema;
}
export interface PromptLaunchCommitted extends PromptLaunchCommittedPayload {}

export interface PromptSubmittedPayload {
  readonly agentId: string;
  readonly promptId: string;
  readonly userMessageId: string;
  readonly status: 'running' | 'queued';
  readonly content: ContentPart[];
  readonly createdAt: string;
  readonly appendTiming: DeferredAppendTiming;
  readonly revision: number;
}

export class PromptSubmitted extends Event2<PromptSubmittedPayload> {
  static override readonly type = 'prompt.submitted';
  static override readonly observable = true;
}
export interface PromptSubmitted extends PromptSubmittedPayload {}

export interface PromptStartedPayload {
  readonly agentId: string;
  readonly promptId: string;
}

export class PromptStarted extends Event2<PromptStartedPayload> {
  static override readonly type = 'prompt.started';
  static override readonly observable = true;
}
export interface PromptStarted extends PromptStartedPayload {}

interface PersistedPromptQueueState {
  readonly entries: Map<string, unknown>;
  readonly order: string[];
}

async function transformPromptRecord(
  record: WireRecord,
  transform: PartsTransformer,
): Promise<WireRecord> {
  if (record.type !== PromptEnqueued.type && record.type !== PromptReplaced.type) return record;
  const message = record['message'] as ContextMessage | undefined;
  if (message === undefined) return record;
  const content = await transform(message.content);
  if (content === message.content) return record;
  return { ...record, message: { ...message, content: [...content] } };
}

async function transformPromptQueueState(
  state: PersistedPromptQueueState,
  transform: PartsTransformer,
): Promise<PersistedPromptQueueState> {
  let changed = false;
  const entries = new Map<string, unknown>();
  for (const [promptId, raw] of state.entries) {
    const entry = raw as PromptEnqueuedPayload;
    const content = await transform(entry.message.content);
    if (content === entry.message.content) {
      entries.set(promptId, entry);
      continue;
    }
    changed = true;
    entries.set(promptId, {
      ...entry,
      message: { ...entry.message, content: [...content] },
    });
  }
  return changed ? { entries, order: state.order } : state;
}

export const promptQueueKey = defineState<PersistedPromptQueueState>(
  'prompt.queue',
  () => ({ entries: new Map(), order: [] }),
).replayable({
  schema: z.custom<PersistedPromptQueueState>(),
  blobs: {
    dehydrate: transformPromptRecord,
    rehydrate: transformPromptQueueState,
  },
})
  .on(PromptEnqueued, (state, event) => {
    state.entries.set(event.promptId, { ...event });
    const existing = state.order.indexOf(event.promptId);
    if (existing >= 0) state.order.splice(existing, 1);
    state.order.splice(Math.min(event.queueIndex, state.order.length), 0, event.promptId);
  })
  .on(PromptReplaced, (state, event) => {
    const entry = state.entries.get(event.promptId) as PromptEnqueuedPayload | undefined;
    if (entry === undefined) return;
    state.entries.set(event.promptId, {
      ...entry,
      message: event.message,
      execution: event.execution ?? entry.execution,
      revision: event.revision,
    });
  })
  .on(PromptTimingChanged, (state, event) => {
    const entry = state.entries.get(event.promptId) as PromptEnqueuedPayload | undefined;
    if (entry === undefined) return;
    state.entries.set(event.promptId, {
      ...entry,
      appendTiming: event.appendTiming,
      revision: event.revision,
    });
  })
  .on(PromptMoved, (state, event) => {
    state.order.splice(0, state.order.length, ...event.queuedPromptIds.filter((id) => state.entries.has(id)));
  })
  .on(PromptLaunchCommitted, (state, event) => {
    state.entries.delete(event.promptId);
    const index = state.order.indexOf(event.promptId);
    if (index >= 0) state.order.splice(index, 1);
  })
  .on(PromptAborted, (state, event) => {
    state.entries.delete(event.promptId);
    const index = state.order.indexOf(event.promptId);
    if (index >= 0) state.order.splice(index, 1);
  })
  .on(PromptCompleted, (state, event) => {
    state.entries.delete(event.promptId);
    const index = state.order.indexOf(event.promptId);
    if (index >= 0) state.order.splice(index, 1);
  })
  .on(PromptSteered, (state, event) => {
    for (const promptId of event.promptIds) {
      state.entries.delete(promptId);
      const index = state.order.indexOf(promptId);
      if (index >= 0) state.order.splice(index, 1);
    }
  });

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
interface Record extends PromptSnapshot {
  state: PromptState;
  message: ContextMessage;
  appendTiming: DeferredAppendTiming;
  revision: number;
  execution?: PromptExecutionBinding;
  readonly goalId?: string | null;
  readonly deferredDisabledTools?: readonly string[];
  readonly alreadyMaterialized: boolean;
  readonly launchedDeferred: Deferred<Turn | undefined>;
  readonly completionDeferred: Deferred<PromptCompletion>;
  handle: PromptHandle;
}

function bundledSkillBlockCount(message: ContextMessage): number {
  return message.origin?.kind === 'user' ? (message.origin.skillActivations?.length ?? 0) : 0;
}

function stripBundledSkillBlocks(message: ContextMessage): ContentPart[] {
  return message.content.slice(bundledSkillBlockCount(message));
}

function replacePromptContent(
  message: ContextMessage,
  replacement: readonly ContentPart[],
): ContentPart[] {
  const skillBlockCount = bundledSkillBlockCount(message);
  const skillBlocks = message.content.slice(0, skillBlockCount);
  if (replacement.some((part) => part.type !== 'text')) return [...skillBlocks, ...replacement];
  const content: ContentPart[] = [];
  let replacedText = false;
  for (const part of message.content.slice(skillBlockCount)) {
    if (part.type !== 'text') {
      content.push(part);
    } else if (!replacedText) {
      content.push(...replacement);
      replacedText = true;
    }
  }
  if (!replacedText) content.unshift(...replacement);
  return [...skillBlocks, ...content];
}

function mergeSteerMessages(records: readonly Record[]): ContextMessage {
  const skillActivations = records.flatMap((item) =>
    item.message.origin?.kind === 'user' ? (item.message.origin.skillActivations ?? []) : [],
  );
  return {
    role: 'user',
    content: [
      ...records.flatMap((item) => item.message.content.slice(0, bundledSkillBlockCount(item.message))),
      ...records.flatMap((item) => stripBundledSkillBlocks(item.message)),
    ],
    toolCalls: [],
    origin: sharedSteerOrigin(records, skillActivations),
  };
}

function sharedSteerOrigin(
  records: readonly Record[],
  skillActivations: readonly BundledSkillActivation[],
): PromptOrigin {
  if (skillActivations.length > 0) return { kind: 'user', skillActivations };
  const [first] = records;
  if (
    first === undefined ||
    first.message.origin === undefined ||
    first.message.origin.kind === 'user'
  ) {
    return USER_PROMPT_ORIGIN;
  }
  const origin = first.message.origin;
  for (const item of records) {
    if (JSON.stringify(item.message.origin) !== JSON.stringify(origin)) {
      return USER_PROMPT_ORIGIN;
    }
  }
  return origin;
}

export const promptLaunchingKey = defineState<boolean>('prompt.launching', () => false);

export class AgentPromptService implements IAgentPromptService {
  declare readonly _serviceBrand: undefined;
  private active: (Record & { turn: Turn }) | undefined;
  private readonly pending: Record[] = [];
  private readonly immediatePromptIds = new Set<string>();
  private readonly steered = new Map<string, Record[]>();
  private readonly steeredTurnIds = new Map<string, number>();
  private readonly steeringFlights = new Map<
    string,
    { readonly record: Record; readonly receipt: EnqueueReceipt; readonly turnId: number; reason?: Error }
  >();
  private launchingPrompt: {
    readonly record: Record;
    readonly controller: AbortController;
    receipt?: EnqueueReceipt;
  } | undefined;
  private readonly promptIds = new KeyReservationRegistry<string>();
  private readonly steeringPromptIds = new Set<string>();
  private readonly recoveryPendingIds = new Set<string>();
  private steering = 0;
  private waitingForLoop = false;
  private recoveryHold = false;
  private fullCompactionService: IAgentFullCompactionService | undefined;
  readonly hooks = { onBeforeSubmitPrompt: new OrderedHookSlot<PromptSubmitContext>() };

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventBus eventBus: IEventBus,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionHistoryMutationService
    private readonly historyMutation: ISessionHistoryMutationService,
  ) {
    this.states.contributeState(promptLaunchingKey);
    this.states.contributeState(promptAdmissionKey);
    this.states.contributeState(promptResolutionKey);
    this.states.contributeState(promptQueueKey);
    this.dispatcher.hooks.onDidRestore.register('prompt-queue', async (_ctx, next) => {
      this.restorePendingQueue();
      await next();
    });
    eventBus.subscribe(TaskSettlementReady, () => {
      void this.startNext();
    });
    toolExecutor.hooks.onDidExecuteTool.register('prompt-service-delivery', async (ctx, next) => {
      await this.deliverToolResult(ctx);
      await next();
    });
  }

  private get launching(): boolean {
    return this.states.get(promptLaunchingKey);
  }

  private set launching(value: boolean) {
    this.states.set(promptLaunchingKey, value);
  }

  private providerType(): string | undefined {
    return this.profile.getModelProviderType();
  }

  [promptAdmission](promptId?: string): PromptReservation {
    if (promptId !== undefined && promptId.length === 0) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_id must not be empty');
    }
    const accepted = this.states.get(promptAdmissionKey);
    let id = promptId ?? newMessageId();
    let reservation = this.promptIds.reserve(
      id,
      id,
      accepted.has(id) ? { fingerprint: id, result: id } : undefined,
      false,
    );
    while (reservation.kind === 'conflict') {
      if (promptId !== undefined) {
        throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt_id '${id}' is already in use`);
      }
      id = newMessageId();
      reservation = this.promptIds.reserve(
        id,
        id,
        accepted.has(id) ? { fingerprint: id, result: id } : undefined,
        false,
      );
    }
    if (reservation.kind !== 'reserved') {
      throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt_id '${id}' is already in use`);
    }
    let submitted = false;
    return {
      id,
      submit: async (message, execution, deferredDisabledTools, appendTiming, signal) => {
        if (submitted) throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt reservation already submitted');
        this.instantiation.invokeFunction((accessor) => validatePromptRuntimeControls(accessor, execution));
        submitted = true;
        reservation.commit(id);
        if (signal?.aborted) throw submissionCancelled(id);
        await this.dispatcher.dispatch(new PromptAccepted({ promptId: id }));
        if (signal?.aborted) throw submissionCancelled(id);
        return this.enqueue({ id, message, execution, appendTiming, deferredDisabledTools, signal });
      },
      dispose: () => {
        reservation.release();
      },
    };
  }

  async enqueue(input: PromptInput): Promise<PromptHandle> {
    return this.historyMutation.runAdmission(input.historyMutationLease, () => this.enqueueNow(input));
  }

  private async enqueueNow(input: PromptInput): Promise<PromptHandle> {
    const peerMessageId =
      input.message.origin?.kind === 'peer_thread' ? input.message.origin.messageId : undefined;
    if (peerMessageId !== undefined) {
      const existing = this.findPeerOriginHandle(peerMessageId);
      if (existing !== undefined) return existing;
    }
    const id = input.id ?? input.message.id ?? newMessageId();
    const signal = input.signal;
    if (signal?.aborted) throw submissionCancelled(id);
    const message = { ...input.message, id };
    const launchedDeferred = deferred<Turn | undefined>();
    const completionDeferred = deferred<PromptCompletion>();
    const goalId = this.instantiation.invokeFunction((accessor) => capturePromptGoalId(accessor, input.execution));
    const appendTiming = input.appendTiming ?? 'agent_idle';
    const record = {} as Record;
    Object.assign(record, {
      id,
      userMessageId: id,
      createdAt: new Date().toISOString(),
      state: 'pending',
      message,
      execution: input.execution,
      goalId,
      appendTiming,
      revision: 0,
      deferredDisabledTools: input.deferredDisabledTools,
      alreadyMaterialized: input.alreadyMaterialized === true,
      launchedDeferred,
      completionDeferred,
    });
    record.handle = this.createHandle(record);
    await this.dispatcher.dispatch(new PromptEnqueued({
      schemaVersion: 1,
      promptId: record.id,
      userMessageId: record.userMessageId,
      createdAt: record.createdAt,
      message: record.message,
      execution: record.execution,
      goalId: record.goalId,
      deferredDisabledTools: record.deferredDisabledTools,
      alreadyMaterialized: record.alreadyMaterialized,
      appendTiming: record.appendTiming,
      revision: record.revision,
      queueIndex: this.pending.length,
    }));
    if (signal?.aborted) {
      this.cancelUnlaunched(record, true);
      throw submissionCancelled(record.id);
    }
    this.pending.push(record);
    this.bindSubmissionSignal(record, signal);
    const idle = this.active === undefined && !this.launching;
    const queued = this.recoveryHold || !idle || !this.isTimingReady(record.appendTiming) || this.loop.status().state === 'running' || this.fullCompaction.compacting !== null;
    this.publishSubmitted(record, queued ? 'queued' : 'running');
    if (queued) {
      this.publishQueued(record);
      if (this.recoveryHold) this.publishQueueHoldChanged();
      void this.startNext();
      return record.handle;
    }
    void this.startNext();
    await Promise.race([record.launchedDeferred.promise, record.completionDeferred.promise]);
    return record.handle;
  }

  private bindSubmissionSignal(record: Record, signal: AbortSignal | undefined): void {
    if (signal === undefined || signal.aborted) return;
    const onAbort = (): void => {
      this.cancelLivePrompt(record.id, signalReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void record.completionDeferred.promise.then(() =>
      signal.removeEventListener('abort', onAbort),
    );
  }

  private findPeerOriginHandle(messageId: string): PromptHandle | undefined {
    const live = [this.active, ...this.pending]
      .filter((item): item is Record => item !== undefined)
      .find(
        (item) =>
          item.message.origin?.kind === 'peer_thread' &&
          item.message.origin.messageId === messageId,
      );
    if (live !== undefined) return live.handle;
    const persisted = this.context
      .get()
      .find(
        (message) =>
          message.origin?.kind === 'peer_thread' && message.origin.messageId === messageId,
      );
    if (persisted === undefined) return undefined;
    const id = persisted.id ?? messageId;
    const completion: PromptCompletion = {
      promptId: id,
      result: undefined,
      state: 'completed',
    };
    return {
      id,
      userMessageId: id,
      createdAt: new Date(0).toISOString(),
      state: 'completed',
      message: persisted,
      appendTiming: 'agent_idle',
      revision: 0,
      launched: Promise.resolve(undefined),
      completion: Promise.resolve(completion),
    };
  }

  async submit(payload: PromptPayload): Promise<PromptLaunchResult | undefined> {
    const handle = await this.submitPrompt(payload);
    if (handle.state === 'pending') return undefined;
    const turn = await handle.launched;
    if (turn === undefined && handle.state !== 'blocked') {
      throw new Error2(ErrorCodes.INTERNAL, `Prompt ${handle.id} failed to launch; inspect prompt completion events`);
    }
    return turn === undefined ? undefined : { turn_id: turn.id };
  }

  async submitAndWait(payload: PromptPayload, signal?: AbortSignal): Promise<PromptTerminalResult> {
    signal?.throwIfAborted();
    const handle = await this.submitPrompt(payload);
    const completion = await (signal === undefined ? handle.completion : abortable(handle.completion, signal));
    const turn = await handle.launched;
    const result = completion.result;
    return {
      promptId: completion.promptId,
      turnId: turn?.id,
      state: completion.state,
      result: result?.type === 'failed'
        ? { ...result, error: toErrorPayload(result.error) }
        : result?.type === 'cancelled'
          ? { ...result, reason: toErrorPayload(result.reason) }
          : result,
    };
  }

  private async submitPrompt(payload: PromptPayload): Promise<PromptHandle> {
    const reservation = this[promptAdmission](payload.promptId);
    try {
      this.instantiation.invokeFunction((accessor) => validatePromptRuntimeControls(accessor, payload.execution));
      let deferredDisabledTools: readonly string[] | undefined;
      if (payload.disabledTools !== undefined) {
        if (payload.execution !== undefined && !this.profile.isRunnable()) {
          deferredDisabledTools = payload.disabledTools;
        } else {
          try {
            await this.toolPolicy.setSessionDisabledTools(payload.disabledTools);
          } catch (error) {
            throw new Error2(
              ErrorCodes.REQUEST_INVALID,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      }
      await this.updatePromptMetadata(promptMetadataTextFromContentParts(payload.input));
      return await reservation.submit({
        role: 'user',
        content: [...payload.input],
        toolCalls: [],
        origin: { kind: 'user' },
      }, payload.execution, deferredDisabledTools, payload.appendTiming);
    } finally {
      reservation.dispose();
    }
  }

  async submitSteer(payload: SteerPayload): Promise<PromptLaunchResult | undefined> {
    this.telemetry.track2('input_steer', { parts: payload.input.length });
    await this.updatePromptMetadata(promptMetadataTextFromContentParts(payload.input));
    const queued = await this.enqueue({ message: {
      role: 'user',
      content: [...payload.input],
      toolCalls: [],
    } });
    if (queued.state !== 'pending') {
      const turn = await queued.launched;
      return turn === undefined ? undefined : { turn_id: turn.id };
    }
    try {
      const [steered] = await this.steer([queued.id]);
      const turn = await steered?.launched;
      return turn === undefined ? undefined : { turn_id: turn.id };
    } catch (error) {
      if (isError2(error) && error.code === ErrorCodes.PROMPT_NOT_FOUND) return undefined;
      throw error;
    }
  }

  private async updatePromptMetadata(text: string | undefined): Promise<void> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    await applyPromptMetadataUpdate(
      {
        metadata: this.metadata,
        eventService: this.eventService,
        sessionId: this.sessionContext.sessionId,
      },
      text,
    );
  }

  list(): PromptQueueSnapshot {
    return {
      active: this.active === undefined ? undefined : snapshot(this.active),
      pending: this.pending.map(snapshot),
      launching: this.launchingPrompt === undefined ? undefined : snapshot(this.launchingPrompt.record),
      hold: this.queueHold(),
    };
  }

  hasReadyPending(): boolean {
    return this.pending.some((item) => this.isReadyPending(item));
  }

  private isReadyPending(item: Record): boolean {
    return this.immediatePromptIds.has(item.id) || (!this.recoveryHold && this.isTimingReady(item.appendTiming));
  }

  resumeRecoveredQueue(): void {
    if (!this.recoveryHold) return;
    this.recoveryHold = false;
    this.publishQueueHoldChanged();
    void this.startNext();
  }

  private queueHold(): PromptQueueHold | undefined {
    return this.recoveryHold ? { reason: 'recovery', count: this.pending.length } : undefined;
  }

  private isTimingReady(timing: DeferredAppendTiming): boolean {
    if (timing === 'agent_idle') return true;
    const active = this.tasks.list(true);
    if (active.some((task) => task.kind === 'agent')) return false;
    if (timing === 'subagents_done') return true;
    return !active.some(isBlockingFiniteTask);
  }

  private createHandle(record: Record): PromptHandle {
    return {
      get id() { return record.id; },
      get userMessageId() { return record.userMessageId; },
      get createdAt() { return record.createdAt; },
      get state() { return record.state; },
      get message() { return record.message; },
      get appendTiming() { return record.appendTiming; },
      get revision() { return record.revision; },
      launched: record.launchedDeferred.promise,
      completion: record.completionDeferred.promise,
    };
  }

  private restorePendingQueue(): void {
    if (this.pending.length > 0 || this.active !== undefined) return;
    const persisted = this.states.get(promptQueueKey);
    for (const promptId of persisted.order) {
      const entry = persisted.entries.get(promptId) as PromptEnqueuedPayload | undefined;
      if (entry === undefined) continue;
      const launchedDeferred = deferred<Turn | undefined>();
      const completionDeferred = deferred<PromptCompletion>();
      const record = {
        id: entry.promptId,
        userMessageId: entry.userMessageId,
        createdAt: entry.createdAt,
        state: 'pending' as const,
        message: entry.message,
        execution: entry.execution,
        goalId: entry.goalId,
        deferredDisabledTools: entry.deferredDisabledTools,
        alreadyMaterialized: entry.alreadyMaterialized,
        appendTiming: entry.appendTiming,
        revision: entry.revision,
        launchedDeferred,
        completionDeferred,
      } as Record;
      record.handle = this.createHandle(record);
      this.pending.push(record);
      this.recoveryPendingIds.add(record.id);
    }
    this.recoveryHold = this.pending.length > 0;
    if (this.recoveryHold) this.publishQueueHoldChanged();
  }

  replace(promptId: string, content: readonly ContentPart[]): PromptHandle {
    const item = this.pending.find((candidate) => candidate.id === promptId);
    if (item === undefined || this.steeringPromptIds.has(promptId)) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, `prompt ${promptId} is not replaceable`);
    }
    item.message = {
      ...item.message,
      id: item.id,
      content: replacePromptContent(item.message, content),
    };
    item.revision += 1;
    const execution = this.syncGoalCreationObjective(item, content);
    void this.dispatcher.dispatch(
      new PromptReplaced({
        promptId: item.id,
        content: stripBundledSkillBlocks(item.message),
        message: item.message,
        execution,
        revision: item.revision,
        replacedAt: new Date().toISOString(),
      }),
    );
    return item.handle;
  }

  private syncGoalCreationObjective(
    item: Record,
    content: readonly ContentPart[],
  ): PromptExecutionBinding | undefined {
    if (item.execution?.goalObjective === undefined || item.goalId !== null) return undefined;
    const objective = promptMetadataTextFromContentParts(content);
    if (objective === undefined) return undefined;
    const execution = { ...item.execution, goalObjective: objective };
    item.execution = execution;
    return execution;
  }

  changeTiming(
    promptId: string,
    appendTiming: DeferredAppendTiming,
    expectedRevision?: number,
  ): PromptHandle {
    const item = this.pending.find((candidate) => candidate.id === promptId);
    if (item === undefined || this.steeringPromptIds.has(promptId)) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, `prompt ${promptId} timing is not changeable`);
    }
    if (expectedRevision !== undefined && expectedRevision !== item.revision) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, `prompt ${promptId} revision changed`);
    }
    if (item.appendTiming === appendTiming) return item.handle;
    item.appendTiming = appendTiming;
    item.revision += 1;
    void this.dispatcher.dispatch(new PromptTimingChanged({
      promptId,
      appendTiming,
      revision: item.revision,
      changedAt: new Date().toISOString(),
    }));
    void this.startNext();
    return item.handle;
  }

  move(promptId: string, targetIndex: number): void {
    const sourceIndex = this.pending.findIndex((candidate) => candidate.id === promptId);
    if (sourceIndex < 0 || this.steeringPromptIds.has(promptId)) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, `prompt ${promptId} is not movable`);
    }
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= this.pending.length) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'target_index is outside the queued prompt range');
    }
    if (sourceIndex === targetIndex) return;
    const [item] = this.pending.splice(sourceIndex, 1) as [Record];
    this.pending.splice(targetIndex, 0, item);
    void this.dispatcher.dispatch(
      new PromptMoved({
        promptId,
        targetIndex,
        queuedPromptIds: this.pending.map((candidate) => candidate.id),
        movedAt: new Date().toISOString(),
      }),
    );
  }

  async steer(promptIds: readonly string[]): Promise<readonly PromptHandle[]> {
    if (promptIds.length === 0) throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_ids must not be empty');
    const targetTurnId = this.active?.turn.id ?? this.loop.status().activeTurnId;
    const ids = new Set(promptIds);
    if (ids.size !== promptIds.length || this.pending.filter((item) => ids.has(item.id)).length !== ids.size) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are not pending');
    }
    const selected = this.pending.filter((item) => ids.has(item.id));
    if (targetTurnId === undefined) {
      for (const item of selected) this.immediatePromptIds.add(item.id);
      void this.startNext();
      return selected.map((item) => item.handle);
    }
    for (const item of selected) this.steeringPromptIds.add(item.id);
    try {
      const activeAtEntry = this.active;
      for (const item of selected) {
        if (!hasPromptRuntimeControls(item.execution)) continue;
        const changed = this.instantiation.invokeFunction((accessor) => readPromptRuntimeControlChanges(accessor, item.execution));
        if (await changed()) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, 'Prompts with pending plan, swarm or goal changes must run as their own turn');
        }
      }
      const { message: rerouted, captions } = this.extractCompressionCaptions(mergeSteerMessages(selected));
      await this.materializeDaemonRefs(rerouted);
      if (selected.some((item) => !this.pending.includes(item)) || this.active !== activeAtEntry ||
          this.loop.status().activeTurnId !== targetTurnId) {
        throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are no longer pending');
      }
      this.steering++;
      const removed: { readonly item: Record; readonly index: number }[] = [];
      for (const item of selected) {
        const index = this.pending.indexOf(item);
        removed.push({ item, index });
        this.pending.splice(index, 1);
      }
      const request = new SteerStepRequest(rerouted, captions, this.reminders, this.providerType(), (materialized) => {
        void this.dispatcher.dispatch(
          new TurnSteer({
            turnId: targetTurnId,
            promptId: materialized.id,
            revision: undefined,
            lineage: undefined,
            input: materialized.content,
            origin: materialized.origin ?? USER_PROMPT_ORIGIN,
            managed: true,
          }),
        );
      }, () => {}, 'activeTurnOnly', 'queue');
      let turn: Turn | undefined;
      try {
        const receipt = this.loop.enqueue(request);
        for (const { item } of removed) {
          this.steeringFlights.set(item.id, { record: item, receipt, turnId: targetTurnId });
        }
        turn = (await receipt.assigned).turn;
      } catch {
        turn = undefined;
      } finally {
        this.steering--;
      }
      const cancelled = selected.some((item) => this.steeringFlights.get(item.id)?.reason !== undefined);
      if (cancelled && turn?.id === targetTurnId) {
        const result = await turn.result;
        for (const item of selected) {
          item.launchedDeferred.resolve(turn);
          item.state = 'cancelled';
          item.completionDeferred.resolve({ promptId: item.id, result, state: 'cancelled' });
          this.publishAborted(item, false);
        }
        return selected.map((item) => item.handle);
      }
      if (turn === undefined || turn.id !== targetTurnId || this.active !== activeAtEntry) {
        for (const { item, index } of removed.reverse()) {
          if (this.steeringFlights.get(item.id)?.reason !== undefined) this.cancelUnlaunched(item, true);
          else this.pending.splice(index, 0, item);
        }
        if (this.active === undefined) void this.startNext();
        throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'no active turn to steer into');
      }
      for (const item of selected) {
        this.immediatePromptIds.delete(item.id);
        item.state = 'steered';
        item.launchedDeferred.resolve(turn);
        this.steeredTurnIds.set(item.id, turn.id);
      }
      if (activeAtEntry !== undefined) {
        this.steered.set(activeAtEntry.id, [...(this.steered.get(activeAtEntry.id) ?? []), ...selected]);
      } else {
        void turn.result.then((result) => {
          const state = result.type === 'cancelled' ? 'cancelled' : result.type === 'failed' ? 'failed' : 'completed';
          for (const item of selected) {
            item.state = state;
            item.completionDeferred.resolve({ promptId: item.id, result, state });
            this.steeredTurnIds.delete(item.id);
            if (state === 'cancelled') this.publishAborted(item, false);
            else this.publishCompleted(item, state);
          }
        });
      }
      void this.dispatcher.dispatch(
        new PromptSteered({ activePromptId: activeAtEntry?.id ?? selected[0]!.id, promptIds: selected.map((x) => x.id), content: selected.flatMap((item) => stripBundledSkillBlocks(item.message)), steeredAt: new Date().toISOString() }),
      );
      if (this.recoveryHold) this.publishQueueHoldChanged();
      return selected.map((item) => item.handle);
    } finally {
      for (const item of selected) {
        this.steeringPromptIds.delete(item.id);
        this.steeringFlights.delete(item.id);
      }
      if (this.active === undefined) void this.startNext();
    }
  }

  abort(promptId: string, reason: Error = userCancellationReason()): boolean {
    const cancelled = this.cancelLivePrompt(promptId, reason);
    if (cancelled === undefined) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, `prompt ${promptId} not found`);
    }
    return cancelled;
  }

  private cancelLivePrompt(promptId: string, reason: Error): boolean | undefined {
    if (this.active?.id === promptId) return this.loop.cancel(this.active.turn.id, reason);
    const flight = this.steeringFlights.get(promptId);
    if (flight !== undefined) {
      if (flight.reason !== undefined) return false;
      flight.reason = reason;
      flight.receipt.abort(reason);
      this.loop.cancel(flight.turnId, reason);
      return true;
    }
    const steeredTurnId = this.steeredTurnIds.get(promptId);
    if (steeredTurnId !== undefined) return this.loop.cancel(steeredTurnId, reason);
    const launching = this.launchingPrompt;
    if (launching?.record.id === promptId) {
      if (launching.controller.signal.aborted) return false;
      launching.controller.abort(reason);
      if (launching.receipt !== undefined) launching.receipt.abort(reason);
      else this.cancelUnlaunched(launching.record, true);
      return true;
    }
    const index = this.pending.findIndex((item) => item.id === promptId);
    if (index < 0) return undefined;
    const [item] = this.pending.splice(index, 1) as [Record];
    this.cancelUnlaunched(item, true);
    if (this.recoveryHold) this.publishQueueHoldChanged();
    return true;
  }

  private cancelUnlaunched(item: Record, beforeStart: boolean): void {
    this.immediatePromptIds.delete(item.id);
    item.state = 'cancelled';
    item.launchedDeferred.resolve(undefined);
    item.completionDeferred.resolve({ promptId: item.id, result: undefined, state: 'cancelled' });
    this.publishAborted(item, beforeStart);
  }

  async drain(reason: Error = userCancellationReason()): Promise<void> {
    for (const flight of this.steeringFlights.values()) {
      this.cancelLivePrompt(flight.record.id, reason);
    }
    for (const item of this.pending.slice()) this.abort(item.id, reason);
    if (this.launchingPrompt !== undefined) this.abort(this.launchingPrompt.record.id, reason);
    if (this.active !== undefined) this.abort(this.active.id, reason);
  }

  async inject(message: ContextMessage): Promise<Turn | undefined> {
    const { message: rerouted, captions } = this.extractCompressionCaptions(message);
    await this.materializeDaemonRefs(rerouted);
    const request = new SteerStepRequest(rerouted, captions, this.reminders, this.providerType(), (materialized) => {
      void this.dispatcher.dispatch(
        new TurnSteer({
          turnId: this.loop.status().activeTurnId ?? this.active?.turn.id ?? 0,
          promptId: materialized.id,
          revision: undefined,
          lineage: undefined,
          input: materialized.content,
          origin: materialized.origin ?? USER_PROMPT_ORIGIN,
          managed: true,
        }),
      );
    }, () => {}, 'activeOrNewTurn');
    return (await this.loop.enqueue(request).assigned).turn;
  }

  async retry(): Promise<Turn | undefined> { return (await this.loop.enqueue(new RetryStepRequest()).assigned).turn; }

  clear(): void {
    for (const item of this.pending.slice()) this.abort(item.id);
    if (this.launchingPrompt !== undefined) this.abort(this.launchingPrompt.record.id);
    if (this.active !== undefined) this.abort(this.active.id);
    this.context.clear();
  }

  private async startNext(): Promise<void> {
    if (this.active !== undefined || this.launching || this.steering > 0 || this.pending.length === 0) return;
    if (this.fullCompaction.compacting !== null && this.loop.status().state !== 'running') return;
    const candidateIndex = this.pending.findIndex((candidate) => this.isReadyPending(candidate));
    if (candidateIndex < 0) return;
    let admission: ReturnType<IAgentLoopService['tryAcquireQuiescence']>;
    try {
      admission = this.loop.tryAcquireQuiescence({ pendingSteps: 'preserve' });
    } catch (error) {
      for (const pending of this.pending.slice()) {
        this.abort(pending.id, error instanceof Error ? error : undefined);
      }
      return;
    }
    if (admission === undefined) {
      if (!this.waitingForLoop) {
        this.waitingForLoop = true;
        void this.loop.settled().then(() => { this.waitingForLoop = false; void this.startNext(); });
      }
      return;
    }
    const [item] = this.pending.splice(candidateIndex, 1) as [Record];
    const immediate = this.immediatePromptIds.delete(item.id);
    if (this.recoveryHold) {
      if (this.pending.length === 0) this.recoveryHold = false;
      this.publishQueueHoldChanged();
    }
    const controller = new AbortController();
    const launching: NonNullable<AgentPromptService['launchingPrompt']> = { record: item, controller };
    this.launchingPrompt = launching;
    this.launching = true;
    try {
      this.instantiation.invokeFunction((accessor) => validatePromptRuntimeControls(accessor, item.execution));
      await this.applyExecutionBinding(item.execution);
      controller.signal.throwIfAborted();
      if (item.deferredDisabledTools !== undefined) {
        await this.toolPolicy.setSessionDisabledTools(item.deferredDisabledTools);
        controller.signal.throwIfAborted();
      }
      const { message, captions } = this.extractCompressionCaptions(item.message);
      await this.materializeDaemonRefs(message);
      controller.signal.throwIfAborted();
      const blocked = await this.blockedByHook(message, false);
      controller.signal.throwIfAborted();
      if (blocked) {
        if (!item.alreadyMaterialized) this.appendPrompt(message, captions);
        item.state = 'blocked'; item.launchedDeferred.resolve(undefined);
        item.completionDeferred.resolve({ promptId: item.id, result: undefined, state: 'blocked' });
        this.publishCompleted(item, 'blocked'); return;
      }
      if (!immediate && !this.isTimingReady(item.appendTiming)) {
        this.pending.splice(Math.min(candidateIndex, this.pending.length), 0, item);
        return;
      }
      await this.dispatcher.dispatch(new PromptLaunchCommitted({
        launchId: randomUUID(),
        promptId: item.id,
        revision: item.revision,
        committedAt: new Date().toISOString(),
      }));
      controller.signal.throwIfAborted();
      const applyControls = this.instantiation.invokeFunction((accessor) =>
        preparePromptRuntimeControls(accessor, item.execution, item.goalId));
      await applyControls();
      controller.signal.throwIfAborted();
      const recovered = this.recoveryPendingIds.delete(item.id);
      const receipt = this.loop.enqueue(
        new PromptStepRequest(message, captions, this.reminders, this.providerType(), item.alreadyMaterialized, recovered ? 'recovery' : undefined),
        { at: 'head' },
      );
      launching.receipt = receipt;
      admission.dispose();
      const turn = (await receipt.assigned).turn;
      if (turn === undefined) {
        throw new Error2(ErrorCodes.INTERNAL, 'Prompt launch was not assigned after launch commit');
      }
      item.state = 'running'; item.launchedDeferred.resolve(turn); this.active = Object.assign(item, { turn });
      if (controller.signal.aborted) turn.cancel(controller.signal.reason);
      else this.publishStarted(item);
      void turn.result.then((result) => this.settle(item, result));
    } catch (error) {
      if (controller.signal.aborted) {
        if (item.state !== 'cancelled') this.cancelUnlaunched(item, true);
      } else {
        item.state = 'failed';
        item.launchedDeferred.resolve(undefined);
        item.completionDeferred.resolve({ promptId: item.id, result: { type: 'failed', steps: 0, error }, state: 'failed' });
        this.publishCompleted(item, 'failed');
      }
    } finally {
      admission.dispose();
      this.launchingPrompt = undefined;
      this.launching = false;
      if (this.active === undefined) void this.startNext();
    }
  }

  private settle(item: Record, result: TurnResult): void {
    if (this.active?.id !== item.id) return;
    this.active = undefined;
    const state = result.type === 'cancelled' ? 'cancelled' : result.type === 'failed' ? 'failed' : 'completed';
    item.state = state; item.completionDeferred.resolve({ promptId: item.id, result, state });
    for (const child of this.steered.get(item.id) ?? []) {
      child.state = state;
      child.completionDeferred.resolve({ promptId: child.id, result, state });
      this.steeredTurnIds.delete(child.id);
    }
    this.steered.delete(item.id);
    if (state === 'cancelled') this.publishAborted(item, false); else this.publishCompleted(item, state);
    void this.startNext();
  }

  private async applyExecutionBinding(execution: PromptExecutionBinding | undefined): Promise<void> {
    if (execution === undefined) return;
    let profileChanged = false;
    let thinkingConsumed = false;
    if (
      execution.profile !== undefined &&
      this.profile.data().profileName !== execution.profile
    ) {
      await this.profile.bind({
        profile: execution.profile,
        model: execution.model,
        thinking: execution.thinking,
        strictThinking: execution.thinking !== undefined,
      });
      profileChanged = true;
      thinkingConsumed = execution.thinking !== undefined;
    }
    if (execution.model !== undefined) await this.profile.setModel(execution.model);
    if (execution.thinking !== undefined && !thinkingConsumed) {
      this.profile.setThinking(execution.thinking);
    }
    if (profileChanged) await this.syncProfileBindingMetadata();
  }

  private async syncProfileBindingMetadata(): Promise<void> {
    const current = (await this.metadata.read()).agents?.[this.scopeContext.agentId];
    const binding = this.profile.data();
    await this.metadata.registerAgent(this.scopeContext.agentId, {
      ...current,
      displayName: binding.routeId ?? binding.profileName,
      model: binding.modelAlias,
      thinkingEffort: binding.thinkingLevel,
      executor: binding.executorId,
      executorProtocol: binding.executorProtocol,
    });
  }

  private async materializeDaemonRefs(message: ContextMessage): Promise<void> {
    if (!message.content.some((part) => daemonFileRefFromPart(part) !== undefined)) return;
    const files = this.instantiation.invokeFunction((accessor) => accessor.get(IFileService));
    const mediaStore = this.instantiation.invokeFunction((accessor) => accessor.get(ISessionMediaStore));
    await materializePromptDaemonRefs(message.content, { files, mediaStore });
  }

  private async blockedByHook(promptMessage: ContextMessage, isSteer: boolean): Promise<boolean> {
    const ctx = { promptMessage, isSteer, block: false }; await this.hooks.onBeforeSubmitPrompt.run(ctx); return ctx.block;
  }
  private get fullCompaction(): IAgentFullCompactionService {
    if (this.fullCompactionService === undefined) {
      this.fullCompactionService = this.instantiation.invokeFunction((a) => a.get(IAgentFullCompactionService));
      this.fullCompactionService.onDidFinishCompaction(() => { void this.startNext(); });
    }
    return this.fullCompactionService;
  }
  private extractCompressionCaptions(message: ContextMessage): { message: ContextMessage; captions: readonly string[] } {
    if ((message.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return { message, captions: [] };
    const captions: string[] = []; const parts: ContentPart[] = [];
    for (const part of message.content) {
      if (part.type !== 'text') { parts.push(part); continue; }
      const extracted = extractImageCompressionCaptions(part.text); captions.push(...extracted.captions);
      if (extracted.text.trim().length > 0) parts.push({ type: 'text', text: extracted.text });
    }
    return { message: captions.length === 0 ? message : { ...message, content: parts }, captions };
  }
  private appendPrompt(message: ContextMessage, captions: readonly string[]): void {
    const ownerPromptId = message.id ?? newMessageId();
    for (const caption of captions) {
      this.reminders.appendSystemReminder(caption, {
        kind: 'injection',
        variant: 'image_compression',
        ownerPromptId,
      });
    }
    if (message.content.length > 0) {
      this.context.appendManaged({ ...message, id: ownerPromptId }, {
        deliveryId: newDeliveryId(),
        messageId: ownerPromptId,
        deliveredAt: new Date().toISOString(),
        origin: deliveryOriginOf(message.origin),
      });
    }
  }
  private async deliverToolResult(ctx: ToolDidExecuteContext): Promise<void> {
    const delivery = ctx.result.delivery; if (delivery === undefined) return;
    const { delivery: _delivery, ...rest } = ctx.result; ctx.result = rest as ExecutableToolResult;
    if (delivery.kind === 'steer') await this.inject(delivery.message as ContextMessage);
  }
  private publishCompleted(record: Record, reason: 'completed' | 'failed' | 'blocked'): void {
    if ((record.message.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return;
    void this.dispatcher.dispatch(new PromptCompleted({ promptId: record.id, finishedAt: new Date().toISOString(), reason }));
  }
  private publishQueued(record: Record): void {
    if ((record.message.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return;
    void this.dispatcher.dispatch(new PromptQueued({
      promptId: record.id,
      content: stripBundledSkillBlocks(record.message),
      queueLength: this.pending.length,
      appendTiming: record.appendTiming,
      revision: record.revision,
    }));
  }
  private publishSubmitted(record: Record, status: 'running' | 'queued'): void {
    if ((record.message.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return;
    void this.dispatcher.dispatch(new PromptSubmitted({
      agentId: this.scopeContext.agentId,
      promptId: record.id,
      userMessageId: record.userMessageId,
      status,
      content: stripBundledSkillBlocks(record.message),
      createdAt: record.createdAt,
      appendTiming: record.appendTiming,
      revision: record.revision,
    }));
  }
  private publishStarted(record: Record): void {
    if ((record.message.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return;
    void this.dispatcher.dispatch(new PromptStarted({ agentId: this.scopeContext.agentId, promptId: record.id }));
  }
  private publishQueueHoldChanged(): void {
    void this.dispatcher.dispatch(new PromptQueueHoldChanged({ hold: this.queueHold() ?? null }));
  }
  private publishAborted(record: Record, beforeStart: boolean): void {
    if ((record.message.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return;
    void this.dispatcher.dispatch(new PromptAborted({ promptId: record.id, abortedAt: new Date().toISOString(), beforeStart }));
  }
}

function snapshot(item: Record): PromptSnapshot {
  return {
    id: item.id,
    userMessageId: item.userMessageId,
    createdAt: item.createdAt,
    state: item.state,
    message: item.message,
    appendTiming: item.appendTiming,
    revision: item.revision,
  };
}
function isBlockingFiniteTask(task: AgentTaskInfo): boolean {
  return task.kind === 'agent' || (task.kind === 'process' && task.lifetime !== 'service');
}
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
function submissionCancelled(promptId: string): Error2 {
  return new Error2(
    ErrorCodes.PROMPT_ALREADY_COMPLETED,
    `prompt ${promptId} was cancelled before it could start`,
  );
}
function signalReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : abortError('Prompt submission cancelled');
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPromptService,
  AgentPromptService,
  ScopeActivation.OnScopeCreated,
  'prompt',
);
