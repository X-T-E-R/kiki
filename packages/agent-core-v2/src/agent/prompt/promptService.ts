/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { extractImageCompressionCaptions } from '#/agent/media/image-compress';
import { abortable, abortError, userCancellationReason } from '#/_base/utils/abort';
import { toErrorPayload, type ErrorPayload } from '#/_base/errors/serialize';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { newMessageId } from '#/agent/contextMemory/messageId';
import { deliveryOriginOf, newDeliveryId } from '#/agent/contextMemory/messageDelivery';
import { USER_PROMPT_ORIGIN, type BundledSkillActivation, type ContextMessage, type PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { ExecutorHintDelivery } from '#/agent/execution/externalExecutorOps';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService, TurnPersistenceError, type EnqueueReceipt, type Turn, type TurnResult } from '#/agent/loop/loop';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { TurnPrompt, TurnSteer } from '#/agent/loop/turnOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentTaskService, type AgentTaskInfo } from '#/agent/task/task';
import { TaskSettlementReady } from '#/agent/task/taskOps';
import type { ExecutableToolResult } from '#/tool/toolContract';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPlanService } from '#/features/plan/plan';
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
import { IWireService } from '#/wire/wire';

import {
  IAgentPromptService,
  promptAdmission,
  promptRetry,
  type DeferredAppendTiming,
  type PromptCompletion,
  type PromptExecutionBinding,
  type PromptHandle,
  type PromptInput,
  type PromptLaunchResult,
  type PromptPayload,
  type PromptQueueHold,
  type PromptQueueSnapshot,
  PROMPT_EDIT_HOLD_TTL_MS,
  type PromptReservation,
  type PromptSnapshot,
  type PromptState,
  type PromptSubmitContext,
  type PromptTerminalResult,
  type SteerPayload,
} from './prompt';
import { IAgentModelSwitchService, type ModelSwitchInput, type ModelSwitchReceipt } from '#/agent/modelSwitch/modelSwitch';
import { ModelSwitchQueued, ModelSwitchQueueStatus, modelSwitchQueueKey } from './modelSwitchQueueOps';
import { promptFingerprint, PromptOutcomeCommitted, type PromptLookup } from './promptReplay';
import { promptMetadataTextFromContentParts } from './promptMetadataText';
import { promptLaunchFailure } from './promptFailure';
import { capturePromptGoalId, hasPromptRuntimeControls, preparePromptRuntimeControls, readPromptRuntimeControlChanges, validatePromptRuntimeControls } from './runtimeControls';
import { PromptStepRequest, RetryStepRequest, SteerStepRequest } from './promptStepRequests';
import { PromptAccepted, PromptRetryCommitted, promptAdmissionKey, promptRetryReceiptKey, type PromptRetryReceipt } from './promptOps';
import { daemonFileRefFromPart } from '#/agent/media/mediaRef';
import { materializePromptDaemonRefs } from '#/agent/media/promptMediaIntake';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';

export interface PromptCompletedPayload {
  readonly promptId: string;
  readonly finishedAt: string;
  readonly reason: 'completed' | 'failed' | 'blocked';
  readonly error?: ErrorPayload;
}

const promptCompletedSchema = z.object({
  promptId: z.string().min(1),
  finishedAt: z.string(),
  reason: z.union([z.literal('completed'), z.literal('failed'), z.literal('blocked')]),
  error: z.custom<ErrorPayload>().optional(),
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
    state.entries.set(event.promptId, Object.assign({}, event));
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
  .on(ModelSwitchQueued, (state, event) => {
    const id = modelSwitchQueueId(event.entry.input.operationId);
    const existing = state.order.indexOf(id);
    if (existing >= 0) state.order.splice(existing, 1);
    state.order.splice(Math.min(event.queueIndex, state.order.length), 0, id);
  })
  .on(ModelSwitchQueueStatus, (state, event) => {
    if (event.receipt.state === 'pending' || event.receipt.state === 'preparing') return;
    const index = state.order.indexOf(modelSwitchQueueId(event.operationId));
    if (index >= 0) state.order.splice(index, 1);
  })
  .on(PromptMoved, (state, event) => {
    state.order.splice(0, state.order.length, ...event.queuedPromptIds);
  })
  .on(PromptOutcomeCommitted, (state, event) => {
    state.entries.delete(event.terminal.promptId);
    const index = state.order.indexOf(event.terminal.promptId);
    if (index >= 0) state.order.splice(index, 1);
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

export const promptIdentityKey = defineState('prompt.identity', (): Map<string, PromptLookup & { readonly fingerprint: string }> => new Map())
  .replayable({ schema: z.custom<Map<string, PromptLookup & { readonly fingerprint: string }>>() })
  .on(PromptEnqueued, (state, event) => {
    if (!state.has(event.promptId)) state.set(event.promptId, { promptId: event.promptId, phase: 'pending', fingerprint: promptFingerprint(event) });
  })
  .on(PromptLaunchCommitted, (state, event) => {
    const entry = state.get(event.promptId);
    if (entry !== undefined) state.set(event.promptId, { ...entry, phase: 'launched' });
  })
  .on(TurnPrompt, (state, event) => {
    const entry = event.promptId === undefined ? undefined : state.get(event.promptId);
    if (entry !== undefined) state.set(entry.promptId, { ...entry, phase: 'launched', turnId: event.turnId });
  })
  .on(PromptOutcomeCommitted, (state, event) => {
    const entry = state.get(event.terminal.promptId);
    if (entry !== undefined) state.set(event.terminal.promptId, { ...entry, phase: 'terminal', turnId: event.terminal.turnId, terminal: event.terminal });
  });

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
interface Record extends PromptSnapshot {
  state: PromptState;
  error?: ErrorPayload;
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
  detachedForClose?: boolean;
  outcomeCommitted?: boolean;
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
  replaceAttachments: boolean,
): ContentPart[] {
  const skillBlockCount = bundledSkillBlockCount(message);
  const skillBlocks = message.content.slice(0, skillBlockCount);
  if (replaceAttachments || replacement.some((part) => part.type !== 'text')) return [...skillBlocks, ...replacement];
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
    id: records[0]?.message.id,
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
  private readonly queuedExternalSteerIds = new Set<string>();
  private readonly steered = new Map<string, Record[]>();
  private readonly steeredTurnIds = new Map<string, number>();
  private readonly steeringFlights = new Map<
    string,
    { readonly record: Record; readonly receipt: EnqueueReceipt; readonly turnId: number; reason?: Error }
  >();
  private launchingPrompt: {
    readonly record: Record;
    readonly controller: AbortController;
    readonly settled: Promise<void>;
    receipt?: EnqueueReceipt;
  } | undefined;
  private readonly promptIds = new KeyReservationRegistry<string>();
  private readonly steeringPromptIds = new Set<string>();
  private readonly recoveryPendingIds = new Set<string>();
  private steering = 0;
  private waitingForLoop = false;
  private recoveryHold = false;
  /** The single queued prompt a client is editing; it and everything after it wait. */
  private editHold: { readonly promptId: string; timer: ReturnType<typeof setTimeout> } | undefined;
  private fullCompactionService: IAgentFullCompactionService | undefined;
  readonly hooks = { onBeforeSubmitPrompt: new OrderedHookSlot<PromptSubmitContext>() };

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
    @IAgentPlanService private readonly plan: IAgentPlanService,
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
    @IWireService private readonly wire: IWireService,
  ) {
    this.states.contributeState(promptLaunchingKey);
    this.states.contributeState(promptAdmissionKey);
    this.states.contributeState(promptRetryReceiptKey);
    this.states.contributeState(promptResolutionKey);
    this.states.contributeState(promptQueueKey);
    this.states.contributeState(modelSwitchQueueKey);
    this.states.contributeState(promptIdentityKey);
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

  private switchFlight?: { operationId: string; controller: AbortController; receipt: ModelSwitchReceipt; promise?: Promise<ModelSwitchReceipt> };
  private readonly immediateModelSwitchIds = new Set<string>();
  private readonly boundaryPromptIds = new Set<string>();
  private readonly acceptedBoundaryPromptIds = new Set<string>();
  private readonly boundarySteeringIds = new Set<string>();

  private get switchEngine(): IAgentModelSwitchService {
    return this.instantiation.invokeFunction((accessor) => accessor.get(IAgentModelSwitchService));
  }

  private get queueOrder(): readonly string[] {
    return this.states.get(promptQueueKey).order;
  }

  getModelSwitch(operationId: string): ModelSwitchReceipt | undefined {
    const entry = this.states.get(modelSwitchQueueKey).get(operationId);
    if (entry === undefined) return undefined;
    if (this.switchFlight?.operationId === operationId) return this.switchFlight.receipt;
    if (entry.receipt.state === 'preparing') return entry.receipt;
    return this.switchEngine.get(operationId) ?? entry.receipt;
  }

  listModelSwitches(): ReturnType<IAgentPromptService['listModelSwitches']> {
    return [...this.states.get(modelSwitchQueueKey).values()].map((entry) => ({
      ...entry, receipt: this.getModelSwitch(entry.input.operationId) ?? entry.receipt,
      queueIndex: this.queueOrder.indexOf(modelSwitchQueueId(entry.input.operationId)),
    }));
  }

  async switchModel(input: ModelSwitchInput): Promise<ModelSwitchReceipt> {
    await this.historyMutation.runAdmission(undefined, async () => {
      if (!input.operationId.trim() || !input.model.trim() || !['direct', 'compact', 'fresh'].includes(input.mode)) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'Model switching requires an operationId, model and explicit mode.');
      }
      const existing = this.states.get(modelSwitchQueueKey).get(input.operationId);
      if (existing !== undefined) {
        if (existing.input.model !== input.model || existing.input.mode !== input.mode || existing.input.thinking !== input.thinking) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, 'This operationId already belongs to another model switch.');
        }
        await this.wire.flush();
        return;
      }
      const originalBinding = { model: this.profile.getModel(), thinking: this.profile.data().thinkingLevel };
      const receipt: ModelSwitchReceipt = { operationId: input.operationId, agentId: this.scopeContext.agentId,
        state: 'pending', fromModel: originalBinding.model, toModel: input.model, mode: input.mode };
      await this.dispatcher.dispatch(new ModelSwitchQueued({ entry: { input: { ...input }, receipt, revision: 0, originalBinding }, queueIndex: this.queueOrder.length }));
      await this.wire.flush();
    });
    if (this.getModelSwitch(input.operationId)?.state === 'preparing' && !this.queueOrder.includes(modelSwitchQueueId(input.operationId))) {
      return this.recoverModelSwitch(input.operationId, 'retry');
    }
    await this.startNext();
    return this.getModelSwitch(input.operationId)!;
  }

  async updateModelSwitch(input: ModelSwitchInput, expectedRevision?: number): Promise<ModelSwitchReceipt> {
    const entry = this.requireModelSwitch(input.operationId);
    if (entry.receipt.state !== 'pending' || this.switchFlight?.operationId === input.operationId ||
        (expectedRevision !== undefined && expectedRevision !== entry.revision)) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Only an unchanged pending model switch can be edited.');
    }
    if (!input.model.trim() || !['direct', 'compact', 'fresh'].includes(input.mode)) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Invalid model switch target or mode.');
    const receipt = { ...entry.receipt, toModel: input.model, mode: input.mode };
    await this.dispatcher.dispatch(new ModelSwitchQueued({ entry: { ...entry, input: { ...input }, receipt, revision: entry.revision + 1 }, queueIndex: this.queueOrder.indexOf(modelSwitchQueueId(input.operationId)) }));
    await this.wire.flush();
    void this.startNext();
    return receipt;
  }

  private requireModelSwitch(operationId: string) {
    const entry = this.states.get(modelSwitchQueueKey).get(operationId);
    if (entry === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, `Model switch ${operationId} does not exist.`);
    return entry;
  }

  async cancelModelSwitch(operationId: string): Promise<ModelSwitchReceipt> {
    const entry = this.requireModelSwitch(operationId);
    const flight = this.switchFlight;
    if (flight?.operationId === operationId) {
      flight.controller.abort(userCancellationReason());
      return await flight.promise ?? this.getModelSwitch(operationId)!;
    }
    const current = this.getModelSwitch(operationId)!;
    if (current.state === 'completed' || current.state === 'cancelled') return current;
    if (current.state === 'preparing') throw new Error2(ErrorCodes.REQUEST_INVALID, 'Recover this switch by operationId before cancelling; its commit may already exist.');
    const receipt: ModelSwitchReceipt = { ...entry.receipt, state: 'cancelled' };
    await this.dispatcher.dispatch(new ModelSwitchQueueStatus({ operationId, receipt }));
    await this.wire.flush();
    this.syncRecoveryHold();
    void this.startNext();
    return receipt;
  }

  async recoverModelSwitch(operationId: string, action: 'retry' | 'keep_original', mode?: import('#/agent/modelSwitch/modelSwitch').ModelSwitchMode): Promise<ModelSwitchReceipt> {
    let retained: ModelSwitchReceipt | undefined;
    let joinFlight = false;
    await this.historyMutation.runAdmission(undefined, async () => {
      const entry = this.requireModelSwitch(operationId);
      const current = this.getModelSwitch(operationId)!;
      if (mode !== undefined && (!['direct', 'compact', 'fresh'].includes(mode) || action !== 'retry' || current.state === 'cancelled')) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'A recovery mode is only supported by retry of a non-cancelled model switch.');
      }
      const changedMode = mode !== undefined && mode !== entry.input.mode;
      if (changedMode && current.state !== 'failed') {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'Only a failed model switch can select a different recovery mode; an accepted or committed mode cannot be changed.');
      }
      if (current.state === 'completed') {
        retained = current;
        return;
      }
      if (action === 'keep_original') {
        if (current.state !== 'failed' && current.state !== 'cancelled') throw new Error2(ErrorCodes.REQUEST_INVALID, 'Only a failed or cancelled switch can retain the original binding.');
        for (const item of this.pending) {
          if (item.execution?.afterModelSwitch !== operationId) continue;
          item.execution = { ...item.execution, afterModelSwitch: undefined, model: current.fromModel, thinking: entry.originalBinding.thinking };
          await this.dispatcher.dispatch(new PromptReplaced({ promptId: item.id, content: stripBundledSkillBlocks(item.message), message: item.message,
            execution: item.execution, revision: item.revision, replacedAt: new Date().toISOString() }));
        }
        await this.wire.flush();
        retained = current;
        return;
      }
      if (this.switchFlight?.operationId === operationId) {
        joinFlight = true;
        return;
      }
      if (current.state === 'cancelled') throw new Error2(ErrorCodes.REQUEST_INVALID, 'A cancelled switch requires a new operationId.');
      const input = changedMode ? { ...entry.input, mode: mode! } : entry.input;
      const receipt: ModelSwitchReceipt = { ...current, mode: input.mode, state: current.state === 'preparing' ? 'preparing' : 'pending', error: undefined };
      const oldIndex = this.queueOrder.indexOf(modelSwitchQueueId(operationId));
      await this.dispatcher.dispatch(new ModelSwitchQueued({ entry: { ...entry, input, receipt, revision: entry.revision + (changedMode ? 1 : 0) }, queueIndex: oldIndex < 0 ? this.queueOrder.length : oldIndex }));
      await this.wire.flush();
      this.immediateModelSwitchIds.add(operationId);
    });
    if (retained !== undefined) {
      if (action === 'keep_original') void this.startNext();
      return retained;
    }
    const accepted = this.pending.filter(item => item.execution?.afterModelSwitch === operationId && this.acceptedBoundaryPromptIds.has(item.id));
    if (accepted.length > 0 && this.switchFlight?.promise === undefined) {
      await this.scheduleSwitchBoundary(accepted);
      return this.getModelSwitch(operationId)!;
    }
    if (joinFlight) return this.runModelSwitch(operationId);
    await this.startNext();
    return this.getModelSwitch(operationId)!;
  }

  private async runModelSwitch(operationId: string, boundary?: import('#/agent/loop/loop').StepBoundary): Promise<ModelSwitchReceipt> {
    if (this.switchFlight?.promise !== undefined) return this.switchFlight.promise;
    const entry = this.requireModelSwitch(operationId);
    const flight = this.switchFlight ?? { operationId, controller: new AbortController(), receipt: { ...entry.receipt, state: 'preparing' as const } };
    this.switchFlight = flight;
    this.immediateModelSwitchIds.delete(operationId);
    const promise = (async () => {
      const originalBinding = entry.receipt.state === 'preparing' ? entry.originalBinding : { model: this.profile.getModel(), thinking: this.profile.data().thinkingLevel };
      const preparing: ModelSwitchReceipt = { ...entry.receipt, state: 'preparing', fromModel: originalBinding.model };
      await this.dispatcher.dispatch(new ModelSwitchQueued({ entry: { ...entry, receipt: preparing, originalBinding }, queueIndex: Math.max(0, this.queueOrder.indexOf(modelSwitchQueueId(operationId))) }));
      let receipt: ModelSwitchReceipt;
      try {
        const executor = this.profile.data().executorId ?? 'native';
        receipt = executor === 'native'
          ? await this.switchEngine.execute(entry.input, { signal: flight.controller.signal, boundary })
          : { ...preparing, state: 'failed', error: { code: ErrorCodes.REQUEST_INVALID,
            message: `Model switching for executor "${executor}" requires a verified remote model/context adapter; the current executor has none.` } };
      } catch (error) {
        if (!isError2(error) || error.code !== ErrorCodes.TURN_AGENT_BUSY) throw error;
        receipt = { ...preparing, state: 'pending' };
        this.waitingForLoop = true;
        void this.loop.settled().then(() => { this.waitingForLoop = false; void this.startNext(); });
      }
      await this.dispatcher.dispatch(new ModelSwitchQueueStatus({ operationId, receipt }));
      await this.wire.flush();
      flight.receipt = receipt;
      if (receipt.state !== 'preparing') this.switchFlight = undefined;
      return receipt;
    })().catch((error: unknown) => {
      flight.receipt = { ...flight.receipt, state: 'preparing', error: { code: isError2(error) ? error.code : ErrorCodes.STORAGE_IO_FAILED,
        message: error instanceof Error ? error.message : String(error) } };
      return flight.receipt;
    });
    flight.promise = promise;
    try {
      return await promise;
    } finally {
      flight.promise = undefined;
      this.syncRecoveryHold();
      if (this.switchFlight === undefined) void this.startNext();
    }
  }

  private isDependencyReady(execution: PromptExecutionBinding | undefined): boolean {
    return execution?.afterModelSwitch === undefined || this.getModelSwitch(execution.afterModelSwitch)?.state === 'completed';
  }

  private resolveExecutionBinding(execution: PromptExecutionBinding | undefined): PromptExecutionBinding | undefined {
    if (execution?.afterModelSwitch === undefined) return execution;
    const completed = this.getModelSwitch(execution.afterModelSwitch);
    if (completed?.state !== 'completed' || completed.binding === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'The referenced model switch has not completed.');
    return { ...execution, model: completed.binding.model, thinking: completed.binding.thinking };
  }

  private providerType(): string | undefined {
    return this.profile.getModelProviderType();
  }

  private assertNativePromptExecutor(): void {
    const executorId = this.profile.data().executorId;
    if (executorId !== undefined && executorId !== 'native') {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        `Direct prompts and steering are unsupported for external executor "${executorId}"; use AgentSend to deliver a mailbox message instead`,
      );
    }
  }

  readonly [promptRetry] = {
    lookup: async (promptId: string, fingerprint: string): Promise<PromptRetryReceipt | undefined> => {
      const committed = this.states.get(promptRetryReceiptKey).get(promptId);
      if (committed === undefined) {
        if (this.states.get(promptAdmissionKey).has(promptId)) {
          throw new Error2(
            ErrorCodes.PROMPT_ID_CONFLICT,
            `prompt_id '${promptId}' was accepted without a replayable receipt; inspect the child before resubmitting`,
          );
        }
        return undefined;
      }
      if (committed.fingerprint !== fingerprint) {
        throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt_id '${promptId}' is already in use`);
      }
      await this.wire.flush();
      return committed.receipt;
    },
    commit: async (promptId: string, fingerprint: string, receipt: PromptRetryReceipt): Promise<void> => {
      const existing = this.states.get(promptRetryReceiptKey).get(promptId);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint || JSON.stringify(existing.receipt) !== JSON.stringify(receipt)) {
          throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt_id '${promptId}' is already in use`);
        }
        await this.wire.flush();
        return;
      }
      if (!this.states.get(promptAdmissionKey).has(promptId)) {
        throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt_id '${promptId}' is not accepted`);
      }
      await this.dispatcher.dispatch(new PromptRetryCommitted({ promptId, fingerprint, receipt }));
      await this.wire.flush();
    },
  };

  [promptAdmission](promptId?: string, durableAcceptance = false): PromptReservation {
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
        if (durableAcceptance) await this.wire.flush();
        if (signal?.aborted) throw submissionCancelled(id);
        return this.enqueue({ id, message, execution, appendTiming, deferredDisabledTools, signal });
      },
      dispose: () => {
        reservation.release();
      },
    };
  }

  private readonly promptHandles = new Map<string, PromptHandle>();
  private readonly enqueueFlights = new Map<string, { fingerprint: string; promise: Promise<PromptHandle> }>();

  lookup(promptId: string, input?: PromptInput): PromptLookup | undefined {
    const persisted = this.states.get(promptIdentityKey).get(promptId);
    const identity = persisted ?? this.enqueueFlights.get(promptId);
    if (input !== undefined && identity !== undefined && identity.fingerprint !== promptFingerprint(input)) {
      throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt_id '${promptId}' already belongs to another request`);
    }
    if (persisted === undefined) return undefined;
    const turnId = this.active?.id === promptId ? this.active.turn.id : persisted.turnId;
    return { promptId, phase: persisted.phase, turnId, terminal: persisted.terminal };
  }

  async enqueue(input: PromptInput): Promise<PromptHandle> {
    if (input.execution?.afterModelSwitch !== undefined && this.getModelSwitch(input.execution.afterModelSwitch) === undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Unknown model switch dependency.');
    }
    const id = input.id ?? input.message.id;
    if (id === undefined) return this.historyMutation.runAdmission(input.historyMutationLease, () => this.enqueueNow(input));
    if (id.startsWith(MODEL_SWITCH_QUEUE_PREFIX)) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Reserved prompt ID prefix.');
    const fingerprint = promptFingerprint(input);
    const flight = this.enqueueFlights.get(id);
    if (flight !== undefined) {
      if (flight.fingerprint !== fingerprint) throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt_id '${id}' already belongs to another request`);
      return flight.promise;
    }
    const identity = this.states.get(promptIdentityKey).get(id);
    if (identity !== undefined) {
      if (identity.fingerprint !== fingerprint) throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt_id '${id}' already belongs to another request`);
      const handle = this.promptHandles.get(id);
      if (handle !== undefined) { await this.wire.flush(); return handle; }
      if (identity.terminal !== undefined) {
        await this.wire.flush();
        return { id, userMessageId: id, createdAt: new Date(0).toISOString(), state: identity.terminal.state,
          message: { ...input.message, id }, execution: input.execution, appendTiming: input.appendTiming ?? 'agent_idle', revision: 0,
          launched: Promise.resolve(undefined), completion: Promise.resolve({ promptId: id, state: identity.terminal.state, result: identity.terminal.result }) };
      }
      throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt_id '${id}' was already launched; its result is not confirmed. Inspect lookup before recovery.`);
    }
    const promise = this.historyMutation.runAdmission(input.historyMutationLease, () => this.enqueueNow(input));
    this.enqueueFlights.set(id, { fingerprint, promise });
    try { return await promise; } finally { this.enqueueFlights.delete(id); }
  }

  private async enqueueNow(input: PromptInput): Promise<PromptHandle> {
    const mailboxMessageId =
      input.message.origin?.kind === 'peer_thread' || input.message.origin?.kind === 'bridged_peer' || input.message.origin?.kind === 'room_message'
        ? input.message.origin.messageId
        : undefined;
    if (mailboxMessageId !== undefined) {
      const existing = this.findMailboxOriginHandle(mailboxMessageId);
      if (existing !== undefined) return existing;
    }
    const id = input.id ?? input.message.id ?? newMessageId();
    const signal = input.signal;
    if (signal?.aborted || this.closing !== undefined) throw submissionCancelled(id);
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
      queueIndex: this.queueOrder.length,
    }));
    if (signal?.aborted) {
      this.cancelUnlaunched(record, true);
      throw submissionCancelled(record.id);
    }
    if (this.closing !== undefined) {
      if (this.closing === 'preserve-pending') this.detachPendingForClose(record);
      else this.cancelUnlaunched(record, true);
      await this.wire.flush();
      return record.handle;
    }
    this.pending.push(record);
    this.bindSubmissionSignal(record, signal);
    const idle = this.active === undefined && !this.launching && this.switchFlight === undefined;
    const queued = !this.isDependencyReady(record.execution) || this.recoveryHold || this.isEditHeld(this.pending.length - 1) || !idle || !this.isTimingReady(record.appendTiming) || this.loop.status().state === 'running' || this.fullCompaction.compacting !== null;
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

  private findMailboxOriginHandle(messageId: string): PromptHandle | undefined {
    const live = [this.active, ...this.pending]
      .filter((item): item is Record => item !== undefined)
      .find(
        (item) =>
          (item.message.origin?.kind === 'peer_thread' || item.message.origin?.kind === 'bridged_peer' || item.message.origin?.kind === 'room_message') &&
          item.message.origin.messageId === messageId,
      );
    if (live !== undefined) return live.handle;
    const persisted = this.context
      .get()
      .find(
        (message) =>
          (message.origin?.kind === 'peer_thread' || message.origin?.kind === 'bridged_peer' || message.origin?.kind === 'room_message') &&
          message.origin.messageId === messageId,
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
      throw promptLaunchFailure(handle);
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
      pending: this.pending.map((item) => ({ ...snapshot(item), execution: item.execution, queueIndex: this.queueOrder.indexOf(item.id) })),
      modelSwitches: this.states.get(modelSwitchQueueKey).size === 0 ? undefined : this.listModelSwitches(),
      launching: this.launchingPrompt === undefined ? undefined : snapshot(this.launchingPrompt.record),
      hold: this.queueHold(),
    };
  }

  hasReadyPending(): boolean {
    return this.switchFlight !== undefined || this.nextReadyQueueId() !== undefined;
  }

  private nextReadyQueueId(): string | undefined {
    return this.queueOrder.find((id) => {
      const prompt = this.pending.find((item) => item.id === id);
      if (prompt !== undefined) return this.isReadyPending(prompt, this.pending.indexOf(prompt));
      return id.startsWith(MODEL_SWITCH_QUEUE_PREFIX) && (this.immediateModelSwitchIds.has(id.slice(MODEL_SWITCH_QUEUE_PREFIX.length)) || (!this.recoveryHold && !this.isQueueSlotEditHeld(id)));
    });
  }

  private isReadyPending(item: Record, index: number): boolean {
    if (!this.isDependencyReady(item.execution)) return false;
    if (this.immediatePromptIds.has(item.id)) return true;
    return !this.recoveryHold && !this.isEditHeld(index) && this.isTimingReady(item.appendTiming);
  }

  private isQueueSlotEditHeld(id: string): boolean {
    if (this.editHold === undefined) return false;
    const heldIndex = this.queueOrder.indexOf(this.editHold.promptId);
    return heldIndex >= 0 && this.queueOrder.indexOf(id) >= heldIndex;
  }

  private isEditHeld(index: number): boolean {
    const item = this.pending[index];
    return item !== undefined && this.isQueueSlotEditHeld(item.id);
  }

  setEditHold(promptId: string, held: boolean): void {
    if (!this.pending.some((item) => item.id === promptId) && this.states.get(modelSwitchQueueKey).has(promptId)) promptId = modelSwitchQueueId(promptId);
    if (!held) {
      if (this.editHold?.promptId !== promptId) return;
      this.releaseEditHold();
      void this.startNext();
      return;
    }
    if ((!this.pending.some((candidate) => candidate.id === promptId) && !this.queueOrder.includes(promptId)) ||
        this.steeringPromptIds.has(promptId) || modelSwitchQueueId(this.switchFlight?.operationId ?? '') === promptId) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, `queue item ${promptId} is not holdable`);
    }
    if (this.editHold !== undefined) clearTimeout(this.editHold.timer);
    const timer = setTimeout(() => {
      if (this.editHold?.promptId !== promptId) return;
      this.editHold = undefined;
      void this.startNext();
    }, PROMPT_EDIT_HOLD_TTL_MS);
    (timer as { unref?: () => void }).unref?.();
    this.editHold = { promptId, timer };
  }

  private releaseEditHold(): void {
    if (this.editHold === undefined) return;
    clearTimeout(this.editHold.timer);
    this.editHold = undefined;
  }

  /** Drop a hold whose prompt left the queue (launched, steered, aborted). */
  private syncEditHold(): void {
    if (this.editHold === undefined) return;
    const id = this.editHold.promptId;
    if (!this.pending.some((candidate) => candidate.id === id) && !(id.startsWith(MODEL_SWITCH_QUEUE_PREFIX) && this.queueOrder.includes(id))) this.releaseEditHold();
  }

  resumeRecoveredQueue(): void {
    if (!this.recoveryHold) return;
    this.recoveryHold = false;
    this.publishQueueHoldChanged();
    void this.startNext();
  }

  private queueHold(): PromptQueueHold | undefined {
    return this.recoveryHold ? { reason: 'recovery', count: this.pending.length + this.queueOrder.filter((id) => id.startsWith(MODEL_SWITCH_QUEUE_PREFIX)).length } : undefined;
  }

  private isTimingReady(timing: DeferredAppendTiming): boolean {
    if (timing === 'agent_idle') return true;
    const active = this.tasks.list(true);
    if (active.some((task) => task.kind === 'agent')) return false;
    if (timing === 'subagents_done') return true;
    return !active.some(isBlockingFiniteTask);
  }

  private createHandle(record: Record): PromptHandle {
    const handle: PromptHandle = {
      get id() { return record.id; },
      get userMessageId() { return record.userMessageId; },
      get createdAt() { return record.createdAt; },
      get state() { return record.state; },
      get message() { return record.message; },
      get execution() { return record.execution; },
      get appendTiming() { return record.appendTiming; },
      get revision() { return record.revision; },
      get error() { return record.error; },
      launched: record.launchedDeferred.promise,
      completion: record.completionDeferred.promise,
    };
    this.promptHandles.set(record.id, handle);
    void record.completionDeferred.promise.then((completion) => {
      void record.launchedDeferred.promise.then((turn) => {
        if (record.detachedForClose) return;
        this.commitOutcome(record, completion, turn);
      });
    });
    return handle;
  }

  private commitOutcome(record: Record, completion: PromptCompletion, turn: Turn | undefined): void {
    if (record.outcomeCommitted) return;
    record.outcomeCommitted = true;
    const result = completion.result;
    const terminal: PromptTerminalResult = { promptId: record.id, turnId: turn?.id, state: completion.state,
      result: result?.type === 'failed' ? { ...result, error: toErrorPayload(result.error) }
        : result?.type === 'cancelled' ? { ...result, reason: toErrorPayload(result.reason) } : result };
    void this.dispatcher.dispatch(new PromptOutcomeCommitted({ terminal }));
  }

  private restorePendingQueue(): void {
    if (this.closing !== undefined) return;
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
        message: { ...entry.message, id: entry.promptId },
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
    this.recoveryHold = persisted.order.length > 0;
    if (this.recoveryHold) this.publishQueueHoldChanged();
  }

  replace(promptId: string, content: readonly ContentPart[], replaceAttachments = false): PromptHandle {
    const item = this.pending.find((candidate) => candidate.id === promptId);
    if (item === undefined || this.steeringPromptIds.has(promptId)) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, `prompt ${promptId} is not replaceable`);
    }
    item.message = {
      ...item.message,
      id: item.id,
      content: replacePromptContent(item.message, content, replaceAttachments),
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
    const id = this.pending.some((item) => item.id === promptId) ? promptId : modelSwitchQueueId(promptId);
    const order = [...this.queueOrder].filter((candidate) => candidate.startsWith(MODEL_SWITCH_QUEUE_PREFIX) || this.pending.some((item) => item.id === candidate));
    const sourceIndex = order.indexOf(id);
    if (sourceIndex < 0 || this.steeringPromptIds.has(promptId) || this.switchFlight?.operationId === promptId) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, `queue item ${promptId} is not movable`);
    }
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= order.length) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'target_index is outside the queued item range');
    }
    if (sourceIndex === targetIndex) return;
    order.splice(sourceIndex, 1);
    order.splice(targetIndex, 0, id);
    this.pending.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
    void this.dispatcher.dispatch(new PromptMoved({ promptId: id, targetIndex, queuedPromptIds: order, movedAt: new Date().toISOString() }));
  }

  private scheduleSwitchBoundary(selected: readonly Record[]): Promise<void> {
    const fresh = selected.filter(item => !this.boundaryPromptIds.has(item.id));
    if (fresh.length === 0) return Promise.resolve();
    for (const item of fresh) this.boundaryPromptIds.add(item.id);
    return this.loop.atStepBoundary(async boundary => {
      try {
        for (const item of fresh) {
          if (!this.pending.includes(item)) continue;
          const operationId = item.execution?.afterModelSwitch;
          const index = operationId === undefined ? -1 : this.queueOrder.indexOf(modelSwitchQueueId(operationId));
          const operations = operationId === undefined ? [] : index < 0 ? [operationId] : this.queueOrder.slice(0, index + 1)
            .filter(id => id.startsWith(MODEL_SWITCH_QUEUE_PREFIX)).map(id => id.slice(MODEL_SWITCH_QUEUE_PREFIX.length));
          for (const id of operations) {
            const receipt = this.getModelSwitch(id);
            if (receipt?.state === 'cancelled') return;
            if (receipt?.state !== 'completed' && (await this.runModelSwitch(id, boundary)).state !== 'completed') return;
          }
          if (!this.isDependencyReady(item.execution)) return;
          const execution = this.resolveExecutionBinding(item.execution);
          if (execution !== undefined && this.hasExecutionBindingChange({ ...execution, afterModelSwitch: undefined, model: undefined, thinking: undefined })) {
            this.immediatePromptIds.add(item.id);
            void this.startNext();
            continue;
          }
          if (this.hasExecutionBindingChange(execution)) {
            const lease = this.loop.tryAcquireQuiescence({ pendingSteps: 'preserve', boundary });
            if (lease === undefined) return;
            try {
              const changed = this.instantiation.invokeFunction(accessor => readPromptRuntimeControlChanges(accessor, execution));
              if (await changed()) return;
              const { message: rerouted } = this.extractCompressionCaptions(mergeSteerMessages([item]));
              await this.materializeDaemonRefs(rerouted);
              if (!this.pending.includes(item)) continue;
              let bindingCommitted = false;
              const assertCurrent = () => {
                if (bindingCommitted) return;
                if (!this.pending.includes(item)) throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, `prompt ${item.id} was cancelled before binding commit`);
                bindingCommitted = true;
              };
              try { await this.applyExecutionBinding(execution, assertCurrent); }
              catch (error) {
                if (!bindingCommitted && !this.pending.includes(item)) continue;
                throw error;
              }
              this.instantiation.invokeFunction(accessor => accessor.get(IAgentLLMRequesterService)).invalidatePromptSnapshots();
            } finally { await lease.dispose(); }
          }
          const pending = fresh.filter(candidate => this.pending.includes(candidate) &&
            candidate.execution?.afterModelSwitch === operationId && !this.hasExecutionBindingChange(candidate.execution));
          for (const candidate of pending) this.boundarySteeringIds.add(candidate.id);
          try { if (pending.length > 0) await this.steer(pending.map(candidate => candidate.id)); }
          finally { for (const candidate of pending) this.boundarySteeringIds.delete(candidate.id); }
          const remaining = fresh.filter(candidate => this.pending.includes(candidate) && !pending.includes(candidate));
          queueMicrotask(() => this.scheduleSwitchBoundary(remaining));
          return;
        }
      } finally { for (const item of fresh) this.boundaryPromptIds.delete(item.id); }
    }).catch(error => {
      for (const item of fresh) this.boundaryPromptIds.delete(item.id);
      onUnexpectedError(error);
    });
  }

  async steer(promptIds: readonly string[]): Promise<readonly PromptHandle[]> {
    if ((this.profile.data().executorId ?? 'native') !== 'native') return this.steerExternal(promptIds);
    this.assertNativePromptExecutor();
    if (promptIds.length === 0) throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_ids must not be empty');
    const targetTurnId = this.active?.turn.id ?? this.loop.status().activeTurnId;
    const ids = new Set(promptIds);
    if (ids.size !== promptIds.length || this.pending.filter((item) => ids.has(item.id)).length !== ids.size) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are not pending');
    }
    const selected = this.pending.filter((item) => ids.has(item.id));
    const directBindingBoundary = targetTurnId !== undefined && selected.some(item =>
      !this.boundarySteeringIds.has(item.id) && this.hasExecutionBindingChange(item.execution)) &&
      selected.every(item => item.execution === undefined || !this.hasExecutionBindingChange({ ...item.execution, model: undefined, thinking: undefined }));
    if (directBindingBoundary || selected.some(item => item.execution?.afterModelSwitch !== undefined && !this.boundarySteeringIds.has(item.id))) {
      for (const item of selected) this.acceptedBoundaryPromptIds.add(item.id);
      void this.scheduleSwitchBoundary(selected);
      return selected.map(item => item.handle);
    }
    if (targetTurnId === undefined) {
      for (const item of selected) this.immediatePromptIds.add(item.id);
      void this.startNext();
      return selected.map((item) => item.handle);
    }
    for (const item of selected) this.steeringPromptIds.add(item.id);
    try {
      const activeAtEntry = this.active;
      for (const item of selected) {
        if (this.hasExecutionBindingChange(item.execution)) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, 'Prompts with a different profile, model, thinking, permission or plan gate must run as their own turn');
        }
        if (!hasPromptRuntimeControls(item.execution)) continue;
        const changed = this.instantiation.invokeFunction((accessor) => readPromptRuntimeControlChanges(accessor, item.execution));
        if (await changed()) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, 'Prompts with pending plan or goal changes must run as their own turn');
        }
      }
      const { message: rerouted, captions } = this.extractCompressionCaptions(mergeSteerMessages(selected));
      await this.materializeDaemonRefs(rerouted);
      if (selected.some((item) => !this.pending.includes(item)) || this.active !== activeAtEntry ||
          this.loop.status().activeTurnId !== targetTurnId) {
        throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are no longer pending');
      }
      if (selected.some((item) => this.hasExecutionBindingChange(item.execution))) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'Prompt execution settings changed during steering; run it as its own turn');
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
        this.syncRecoveryHold();
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
        this.whenTurnDurable(turn, (result) => {
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
      this.syncRecoveryHold();
      return selected.map((item) => item.handle);
    } finally {
      for (const item of selected) {
        this.steeringPromptIds.delete(item.id);
        this.steeringFlights.delete(item.id);
      }
      if (this.active === undefined) void this.startNext();
    }
  }

  private async steerExternal(promptIds: readonly string[]): Promise<readonly PromptHandle[]> {
    if (promptIds.length === 0) throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_ids must not be empty');
    const ids = new Set(promptIds);
    if (ids.size !== promptIds.length || this.pending.filter((item) => ids.has(item.id)).length !== ids.size) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are not pending');
    }
    const selected = this.pending.filter((item) => ids.has(item.id));
    if (selected.some((item) => item.execution?.afterModelSwitch !== undefined || this.hasExecutionBindingChange(item.execution))) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Prompts with a model-switch dependency or different execution binding must run as their own turn');
    }
    const active = this.active;
    for (const item of selected) this.steeringPromptIds.add(item.id);
    try {
      const message = mergeSteerMessages(selected);
      const execution = this.instantiation.invokeFunction((accessor) => accessor.get(IAgentExecutionService));
      const textOnly = message.content.every((part) => part.type === 'text');
      const delivered = active !== undefined && textOnly &&
        await (execution.steer?.(message) ?? Promise.resolve(false));
      if (delivered && selected.every((item) => this.pending.includes(item))) {
        for (const item of selected) {
          this.pending.splice(this.pending.indexOf(item), 1);
          item.state = 'steered';
          item.launchedDeferred.resolve(active.turn);
          this.steeredTurnIds.set(item.id, active.turn.id);
        }
        this.steered.set(active.id, [...(this.steered.get(active.id) ?? []), ...selected]);
        await this.dispatcher.dispatch(new PromptSteered({
          activePromptId: active.id, promptIds: selected.map((item) => item.id),
          content: selected.flatMap((item) => stripBundledSkillBlocks(item.message)), steeredAt: new Date().toISOString(),
        }));
        for (const item of selected) await this.dispatcher.dispatch(new ExecutorHintDelivery({
          turnId: active.turn.id, executorId: this.profile.data().executorId, promptId: item.id, origin: item.message.origin?.kind ?? 'user',
          method: 'native_steer', status: 'delivered',
        }));
        this.syncRecoveryHold();
      } else {
        for (const item of selected) {
          this.queuedExternalSteerIds.add(item.id);
          await this.dispatcher.dispatch(new ExecutorHintDelivery({
            executorId: this.profile.data().executorId, promptId: item.id, origin: item.message.origin?.kind ?? 'user',
            method: 'next_turn_preamble', status: 'queued',
          }));
        }
      }
      return selected.map((item) => item.handle);
    } finally {
      for (const item of selected) this.steeringPromptIds.delete(item.id);
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
    this.syncRecoveryHold();
    return true;
  }

  private syncRecoveryHold(): void {
    this.syncEditHold();
    if (!this.recoveryHold) return;
    if (this.pending.length === 0 && !this.queueOrder.some((id) => id.startsWith(MODEL_SWITCH_QUEUE_PREFIX))) this.recoveryHold = false;
    this.publishQueueHoldChanged();
  }

  private cancelUnlaunched(item: Record, beforeStart: boolean): void {
    this.immediatePromptIds.delete(item.id);
    this.recoveryPendingIds.delete(item.id);
    if (this.queuedExternalSteerIds.delete(item.id)) void this.dispatcher.dispatch(new ExecutorHintDelivery({
      executorId: this.profile.data().executorId, promptId: item.id, origin: item.message.origin?.kind ?? 'user', method: 'undelivered', status: 'undelivered',
    }));
    item.state = 'cancelled';
    item.launchedDeferred.resolve(undefined);
    const completion: PromptCompletion = { promptId: item.id, result: undefined, state: 'cancelled' };
    item.completionDeferred.resolve(completion);
    this.publishAborted(item, beforeStart);
    this.commitOutcome(item, completion, undefined);
  }

  private closing: 'cancel' | 'preserve-pending' | undefined;

  private detachPendingForClose(item: Record): void {
    item.detachedForClose = true;
    item.state = 'cancelled';
    this.immediatePromptIds.delete(item.id);
    this.recoveryPendingIds.delete(item.id);
    item.launchedDeferred.resolve(undefined);
    item.completionDeferred.resolve({ promptId: item.id, result: undefined, state: 'cancelled' });
  }

  async drain(reason: Error = userCancellationReason(), mode: 'cancel' | 'preserve-pending' = 'cancel'): Promise<void> {
    this.closing = mode;
    this.releaseEditHold();
    for (const flight of this.steeringFlights.values()) {
      this.cancelLivePrompt(flight.record.id, reason);
    }
    if (mode === 'preserve-pending') {
      for (const item of this.pending.splice(0)) this.detachPendingForClose(item);
    } else {
      for (const item of this.pending.slice()) this.abort(item.id, reason);
    }
    const launching = this.launchingPrompt;
    if (launching !== undefined) {
      if (mode === 'preserve-pending' && this.states.get(promptIdentityKey).get(launching.record.id)?.phase === 'pending') {
        this.detachPendingForClose(launching.record);
        launching.controller.abort(reason);
      } else this.abort(launching.record.id, reason);
    }
    await launching?.settled;
    const active = this.active;
    if (active !== undefined) {
      this.abort(active.id, reason);
      await active.turn.result;
    }
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
    if (this.closing || this.active !== undefined || this.launching || this.switchFlight !== undefined || this.waitingForLoop || this.steering > 0) return;
    if (this.fullCompaction.compacting !== null && this.loop.status().state !== 'running') return;
    const candidateId = this.nextReadyQueueId();
    if (candidateId === undefined) return;
    if (candidateId.startsWith(MODEL_SWITCH_QUEUE_PREFIX)) {
      if (this.loop.status().state !== 'idle') {
        if (!this.waitingForLoop) {
          this.waitingForLoop = true;
          void this.loop.settled().then(() => { this.waitingForLoop = false; void this.startNext(); });
        }
        return;
      }
      await this.runModelSwitch(candidateId.slice(MODEL_SWITCH_QUEUE_PREFIX.length));
      return;
    }
    const candidateIndex = this.pending.findIndex((candidate) => candidate.id === candidateId);
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
    this.syncRecoveryHold();
    const controller = new AbortController();
    const launchSettled = deferred<void>();
    const launching: NonNullable<AgentPromptService['launchingPrompt']> = { record: item, controller, settled: launchSettled.promise };
    this.launchingPrompt = launching;
    this.launching = true;
    try {
      this.instantiation.invokeFunction((accessor) => validatePromptRuntimeControls(accessor, item.execution));
      await this.applyExecutionBinding(this.resolveExecutionBinding(item.execution));
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
      await this.wire.flush();
      controller.signal.throwIfAborted();
      const applyControls = this.instantiation.invokeFunction((accessor) =>
        preparePromptRuntimeControls(accessor, item.execution, item.goalId));
      await applyControls();
      controller.signal.throwIfAborted();
      if (item.execution?.permissionMode !== undefined) this.permissionMode.setMode(item.execution.permissionMode);
      if (item.execution?.planGate !== undefined) this.plan.setGate(item.execution.planGate);
      const recovered = this.recoveryPendingIds.delete(item.id);
      let turn: Turn | undefined;
      if ((this.profile.data().executorId ?? 'native') === 'native') {
        const receipt = this.loop.enqueue(
          new PromptStepRequest(message, captions, this.reminders, this.providerType(), item.alreadyMaterialized, recovered ? 'recovery' : undefined),
          { at: 'head' },
        );
        launching.receipt = receipt;
        admission.dispose();
        turn = (await receipt.assigned).turn;
      } else {
        const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
        admission.dispose();
        const execution = this.instantiation.invokeFunction((accessor) => accessor.get(IAgentExecutionService));
        turn = (await execution.run({ kind: 'prompt', prompt: text, promptId: item.id, input: message.content, origin: message.origin }, { signal: controller.signal })).turn;
        if (this.queuedExternalSteerIds.delete(item.id)) {
          await this.dispatcher.dispatch(new ExecutorHintDelivery({
            executorId: this.profile.data().executorId, turnId: turn.id,
            promptId: item.id, origin: message.origin?.kind ?? 'user',
            method: 'next_turn_preamble', status: 'delivered',
          }));
        }
      }
      if (turn === undefined) {
        throw new Error2(ErrorCodes.INTERNAL, 'Prompt launch was not assigned after launch commit');
      }
      item.state = 'running'; item.launchedDeferred.resolve(turn); this.active = Object.assign(item, { turn });
      if (controller.signal.aborted) turn.cancel(controller.signal.reason);
      else this.publishStarted(item);
      this.whenTurnDurable(turn, (result) => this.settle(item, result));
    } catch (error) {
      if (this.queuedExternalSteerIds.delete(item.id)) await this.dispatcher.dispatch(new ExecutorHintDelivery({
        executorId: this.profile.data().executorId, promptId: item.id, origin: item.message.origin?.kind ?? 'user', method: 'undelivered', status: 'undelivered',
      }));
      if (controller.signal.aborted) {
        if (item.state !== 'cancelled') this.cancelUnlaunched(item, true);
      } else {
        item.state = 'failed';
        const payload = toErrorPayload(error);
        const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : payload.code;
        item.error = { ...payload, details: { ...payload.details, reason_code: payload.details?.['reason_code'] ?? code } };
        item.launchedDeferred.resolve(undefined);
        item.completionDeferred.resolve({ promptId: item.id, result: { type: 'failed', steps: 0, error }, state: 'failed' });
        this.publishCompleted(item, 'failed');
      }
    } finally {
      try { await admission.dispose(); }
      finally {
        this.launchingPrompt = undefined;
        this.launching = false;
        launchSettled.resolve();
        if (this.active === undefined) void this.startNext();
      }
    }
  }

  private whenTurnDurable(turn: Turn, complete: (result: TurnResult) => void): void {
    void turn.result.then(complete, (error: unknown) => {
      if (error instanceof TurnPersistenceError) {
        void this.loop.settled().then(() => complete(error.executionResult));
      } else {
        complete({ type: 'failed', steps: 0, error });
      }
    });
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

  private hasExecutionBindingChange(execution: PromptExecutionBinding | undefined): boolean {
    if (execution === undefined) return false;
    if (execution.afterModelSwitch !== undefined && this.isDependencyReady(execution)) execution = this.resolveExecutionBinding(execution)!;
    const profile = this.profile.data();
    return (execution.profile !== undefined && execution.profile !== profile.profileName) ||
      (execution.model !== undefined && execution.model !== profile.modelAlias) ||
      (execution.thinking !== undefined && execution.thinking !== profile.thinkingLevel) ||
      (execution.permissionMode !== undefined && execution.permissionMode !== this.permissionMode.mode) ||
      (execution.planGate !== undefined && execution.planGate !== this.plan.planGate);
  }

  private async applyExecutionBinding(execution: PromptExecutionBinding | undefined, assertCurrent?: () => void): Promise<void> {
    const binding = this.profile.data();
    if (
      execution?.execution === undefined &&
      binding.driver !== 'external' &&
      (binding.executorId ?? 'native') === 'native' &&
      binding.execution === undefined &&
      binding.profileName === undefined &&
      binding.modelAlias === undefined
    ) {
      await this.profile.bind({
        profile: execution?.profile,
        model: execution?.model,
        thinking: execution?.thinking,
        strictThinking: execution?.thinking !== undefined,
      }, assertCurrent);
      await this.syncProfileBindingMetadata();
      return;
    }
    if (execution === undefined) return;
    if (execution.execution !== undefined) {
      await this.profile.bind({ execution: { ...execution.execution, overrides: {
        ...execution.execution.overrides,
        permission_mode: execution.permissionMode ?? execution.execution.overrides?.permission_mode,
      } }, model: execution.model, thinking: execution.thinking }, assertCurrent);
      const permission = this.profile.data().execution?.effective.permission_mode;
      if (permission !== undefined) this.permissionMode.setMode(permission);
      await this.syncProfileBindingMetadata();
      return;
    }
    const currentExecution = this.profile.data().execution;
    if (currentExecution !== undefined && execution.profile === undefined && (execution.model !== undefined || execution.thinking !== undefined)) {
      await this.profile.bind({ execution: currentExecution.selection, model: execution.model, thinking: execution.thinking }, assertCurrent);
      await this.syncProfileBindingMetadata();
      return;
    }
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
      }, assertCurrent);
      profileChanged = true;
      thinkingConsumed = execution.thinking !== undefined;
    }
    if (execution.model !== undefined) await this.profile.setModel(execution.model, assertCurrent);
    if (execution.thinking !== undefined && !thinkingConsumed) {
      assertCurrent?.();
      this.profile.setThinking(execution.thinking);
    }
    if (profileChanged || execution.thinking !== undefined) await this.syncProfileBindingMetadata();
  }

  private async syncProfileBindingMetadata(): Promise<void> {
    const binding = this.profile.data();
    const executor = binding.executorId ?? 'native';
    await this.metadata.updateAgent(this.scopeContext.agentId, (current) => ({
      ...current,
      displayName: binding.routeId ?? binding.profileName,
      model: binding.modelAlias,
      thinkingEffort: binding.thinkingLevel,
      executor,
      executorProtocol: binding.executorProtocol,
      negotiated: (current.executor ?? 'native') === executor ? current.negotiated : undefined,
      allowKikiSubagents: binding.allowKikiSubagents,
    }));
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
    this.acceptedBoundaryPromptIds.delete(record.id);
    if ((record.message.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return;
    void this.dispatcher.dispatch(new PromptCompleted({ promptId: record.id, finishedAt: new Date().toISOString(), reason, error: record.error }));
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
    this.acceptedBoundaryPromptIds.delete(record.id);
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
    error: item.error,
  };
}
const MODEL_SWITCH_QUEUE_PREFIX = '\u0000model-switch:';
function modelSwitchQueueId(operationId: string): string { return `${MODEL_SWITCH_QUEUE_PREFIX}${operationId}`; }

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
