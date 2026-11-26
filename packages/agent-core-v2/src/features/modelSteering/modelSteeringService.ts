import { modelSteeringSourceIds } from '@kiki/protocol';
import { Disposable } from '#/_base/di/lifecycle';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
  type ContextInjectionResult,
} from '#/agent/contextInjector/contextInjector';
import { wrapSystemReminder } from '#/agent/systemReminder/systemReminder';
import { readCognitionContent } from '#/agent/cognition/cognitionFiles';
import { loadSteeringSources } from '#/agent/cognition/steeringBinding';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { IEventBus } from '#/app/event/eventBus';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { CREATED_BY_SESSION_ID_KEY } from '#/app/sessionIndex/sessionIndex';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentModelSteeringService } from './modelSteering';
import { steeringInputSource, steeringInputSources, type SteeringInputSource } from './modelSteeringSources';

const MODEL_STEERING_INJECTION_VARIANT = 'model_steering';
export const DEFAULT_SAME_SOURCE_STEER_STEPS = 10;

export interface ModelSteeringDisclosure {
  readonly bindingKey: string;
  readonly sources: readonly SteeringInputSource[];
}

const PASSIVE_META_TOOLS = new Set([
  'TaskWait',
  'TaskOutput',
  'TaskList',
  'AgentList',
  'TodoList',
  'MemoryRead',
  'MemorySearch',
  'MemoryWrite',
  'HistoryList',
  'HistoryRead',
  'HistorySearch',
  'SelectTools',
]);

const READ_INSPECTION_TOOLS = new Set([
  'Read',
  'ReadMediaFile',
  'Grep',
  'Glob',
  'WebSearch',
  'FetchURL',
]);

export function countCoalescedSteps(history: readonly ContextMessage[], startIndex: number): number {
  const toolErrorsByCallId = new Map<string, boolean>();
  for (let i = Math.max(0, startIndex); i < history.length; i++) {
    const msg = history[i]!;
    if (msg.role === 'tool' && msg.toolCallId !== undefined) {
      toolErrorsByCallId.set(msg.toolCallId, msg.isError === true);
    }
  }
  let inReadRun = false;
  let steps = 0;
  for (let i = Math.max(0, startIndex); i < history.length; i++) {
    const message = history[i]!;
    if (message.role !== 'assistant') continue;
    const nonPassiveCalls = message.toolCalls.filter(
      (tc) => !PASSIVE_META_TOOLS.has(tc.name) && !toolErrorsByCallId.get(tc.id),
    );
    const hasVisibleText = message.content.some(
      (part) => part.type === 'text' && part.text.trim().length > 0,
    );
    if (nonPassiveCalls.length === 0 && (!hasVisibleText || message.toolCalls.length > 0)) {
      continue;
    }
    if (nonPassiveCalls.length > 0 && nonPassiveCalls.every((tc) => READ_INSPECTION_TOOLS.has(tc.name))) {
      if (!inReadRun) {
        steps += 1;
        inReadRun = true;
      }
      continue;
    }
    steps += 1;
    inReadRun = false;
  }
  return steps;
}

function hasAssistantMessageSince(history: readonly ContextMessage[], startIndex: number): boolean {
  for (let i = Math.max(0, startIndex); i < history.length; i++) {
    if (history[i]!.role === 'assistant') return true;
  }
  return false;
}

function isNonConversationalOrigin(origin: PromptOrigin | undefined): boolean {
  return (
    origin?.kind === 'injection' ||
    origin?.kind === 'hook_result' ||
    origin?.kind === 'compaction_summary' ||
    origin?.kind === 'persona_greeting' ||
    origin?.kind === 'shell_command'
  );
}

/** Frozen per-source steering at safe request boundaries. Verified child completions and, when the thread source is unconfigured, a new thread's first instruction and later messages from the thread that created it inherit steering; other non-user sources require configuration. */
export class AgentModelSteeringService extends Disposable implements IAgentModelSteeringService {
  declare readonly _serviceBrand: undefined;
  private lastStepId: string | undefined;
  private inStep = false;
  private unmaterializedSteps = 0;
  private trackedInjectedAt: number | null | undefined = undefined;
  private firedInCurrentStep = false;
  private activeSources = new Set<SteeringInputSource>();
  private completedSubagentInput = false;
  private threadOrigins: readonly PromptOrigin[] = [];
  private observedTail: ContextMessage | undefined;
  private turnSources: Set<SteeringInputSource> | undefined;
  private turnId: number | undefined;

  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLoopService loop: IAgentLoopService,
    @IEventBus events: IEventBus,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
  ) {
    super();
    this._register(events.subscribe(TurnStarted, (event) => {
      this.turnId = event.turnId;
      if (event.origin.kind === 'retry') {
        if (this.activeSources.size === 0) {
          const lastInput = this.context.get().findLast((message) => message.role === 'user' && !isNonConversationalOrigin(message.origin));
          this.activeSources = steeringInputSources(lastInput?.origin);
          this.completedSubagentInput = this.isCompletedSubagentInput(lastInput?.origin);
          this.threadOrigins = threadInputOrigins(lastInput?.origin);
        }
        return;
      }
      this.turnSources = steeringInputSources(event.origin);
      this.completedSubagentInput = this.isCompletedSubagentInput(event.origin);
      this.threadOrigins = threadInputOrigins(event.origin);
    }));
    this._register(loop.hooks.onWillBeginStep.register('model-steering.cadence', async ({ stepId, signal }, next) => {
      signal.throwIfAborted();
      const uniqueStep = stepId === undefined || stepId !== this.lastStepId;
      this.inStep = uniqueStep;
      this.firedInCurrentStep = false;
      this.lastStepId = stepId;
      try {
        await next();
      } finally {
        if (uniqueStep) {
          this.unmaterializedSteps = this.firedInCurrentStep ? 1 : this.unmaterializedSteps + 1;
        }
        this.inStep = false;
      }
    }, { before: 'context-injector' }));
    this._register(injector.register<ModelSteeringDisclosure>(MODEL_STEERING_INJECTION_VARIANT, (ctx) => this.reminder(ctx)));
  }

  private async reminder({
    isNewTurn,
    lastInjectedAt,
    lastDisclosure,
  }: ContextInjectionContext<ModelSteeringDisclosure>): Promise<ContextInjectionResult<ModelSteeringDisclosure> | undefined> {
    if (this.trackedInjectedAt !== undefined && this.trackedInjectedAt !== lastInjectedAt) {
      this.unmaterializedSteps = 0;
    }
    this.trackedInjectedAt = lastInjectedAt;
    const binding = await this.profile.getCognitionBinding();
    const bindingKey = `${binding.modelAlias}:${binding.position}:${binding.revision}:${binding.contentRevision}`;
    const { sources: inputSources, hasInput } = this.readInputs(lastInjectedAt);
    if (this.turnSources !== undefined) {
      this.activeSources = this.turnSources;
      this.turnSources = undefined;
    }
    if (hasInput) this.activeSources = inputSources;
    const history = this.context.get();
    const sliceStart = lastInjectedAt === null ? 0 : lastInjectedAt + 1;
    const hasAssistant = hasAssistantMessageSince(history, sliceStart);
    const stepsSinceLast =
      lastInjectedAt === null
        ? hasAssistant
          ? countCoalescedSteps(history, 0) + (this.inStep ? 1 : 0)
          : this.unmaterializedSteps + (this.inStep ? 1 : 0)
        : hasAssistant
          ? countCoalescedSteps(history, sliceStart)
          : this.unmaterializedSteps;
    const frozen = binding.steeringSources ?? (binding.slots === undefined ? await loadSteeringSources(this.fs, this.bootstrap.homeDir, binding.config, undefined, this.hostEnv.pathClass) : undefined);
    const texts = new Set<string>();
    const emittedSources: SteeringInputSource[] = [];
    for (const source of ['user', ...modelSteeringSourceIds] as const) {
      if (!this.activeSources.has(source)) continue;
      const setting = source === 'user' ? undefined : frozen?.[source];
      const inheritCompletion = source === 'task' && setting === undefined && this.completedSubagentInput;
      const inheritThreadCreate = source === 'thread' && setting === undefined && await this.fromThreadCreator(this.threadOrigins);
      if (source !== 'user' && !inheritCompletion && !inheritThreadCreate && (setting === undefined || setting.mode === 'off')) continue;
      const inherited = source === 'user' || inheritCompletion || inheritThreadCreate || setting?.mode === 'inherit';
      const onTurn = inherited ? binding.config?.steeringOnTurn ?? true : setting?.custom?.steering_on_turn ?? true;
      const onInput = inherited ? binding.config?.steeringOnInput ?? true : setting?.custom?.steering_on_input ?? true;
      const interval = inherited ? binding.config?.steeringIntervalSteps ?? 0 : setting?.custom?.steering_interval_steps ?? 0;
      if (!onTurn && !onInput && interval <= 0) continue;

      const intervalOnly = !onTurn && !onInput && interval > 0;
      const hasTurnOrInputTrigger = (isNewTurn && onTurn) || (inputSources.has(source) && onInput);
      const hasIntervalTrigger = this.inStep && interval > 0 && stepsSinceLast >= interval;
      const isFirstFire = lastInjectedAt === null;
      const isBindingChanged = lastDisclosure !== undefined && lastDisclosure.bindingKey !== bindingKey;
      const isProvenanceSwitch = lastDisclosure !== undefined && !lastDisclosure.sources.includes(source);

      let shouldFire = false;
      if (intervalOnly) {
        shouldFire = hasIntervalTrigger;
      } else if (isFirstFire || isBindingChanged || isProvenanceSwitch) {
        shouldFire = hasTurnOrInputTrigger || (this.inStep && interval > 0);
      } else {
        const cooldown = interval > 0 ? interval : DEFAULT_SAME_SOURCE_STEER_STEPS;
        if (hasTurnOrInputTrigger && stepsSinceLast >= cooldown) {
          shouldFire = true;
        } else if (hasIntervalTrigger) {
          shouldFire = true;
        }
      }
      if (!shouldFire) continue;

      const text = inherited ? binding.slots === undefined ? await readCognitionContent(this.fs, this.bootstrap.homeDir, 'steering', binding.config?.steering, this.hostEnv.pathClass) : binding.slots.steering : setting?.custom?.steering;
      if (text === undefined || text.trim().length === 0) continue;
      texts.add(wrapSystemReminder(text));
      emittedSources.push(source);
    }
    if (texts.size === 0) return undefined;
    this.firedInCurrentStep = true;
    this.unmaterializedSteps = 0;
    this.trackedInjectedAt = undefined;
    return {
      content: { message: { role: 'user', content: [...texts].map((text) => ({ type: 'text', text })) } },
      disclosure: { bindingKey, sources: emittedSources },
    };
  }

  private readInputs(lastInjectedAt: number | null): { sources: Set<SteeringInputSource>; hasInput: boolean } {
    const history = this.context.get();
    const tailIndex = this.observedTail === undefined ? -1 : history.indexOf(this.observedTail);
    const floor = Math.max(tailIndex, lastInjectedAt ?? -1);
    const sources = new Set<SteeringInputSource>();
    let hasInput = false;
    let completedSubagentInput = false;
    const threadOrigins: PromptOrigin[] = [];
    for (let index = history.length - 1; index > floor; index--) {
      const message = history[index]!;
      if (message.role === 'assistant' && tailIndex < 0) break;
      if (message.role !== 'user' || isNonConversationalOrigin(message.origin)) continue;
      if (this.turnId !== undefined && message.source?.turnId !== undefined && message.source.turnId !== this.turnId) continue;
      hasInput = true;
      completedSubagentInput ||= this.isCompletedSubagentInput(message.origin);
      threadOrigins.push(...threadInputOrigins(message.origin));
      for (const source of steeringInputSources(message.origin)) sources.add(source);
    }
    if (hasInput) {
      this.completedSubagentInput = completedSubagentInput;
      this.threadOrigins = threadOrigins;
    }
    this.observedTail = history.at(-1);
    return { sources, hasInput };
  }

  private isCompletedSubagentInput(origin: PromptOrigin | undefined): boolean {
    if (origin?.kind === 'merged') return origin.origins.some((item) => this.isCompletedSubagentInput(item));
    if (origin?.kind !== 'task' || origin.status !== 'completed') return false;
    const task = this.tasks.getTask(origin.taskId);
    return task?.kind === 'agent' && task.status === 'completed' && task.receiptVerification === 'verified';
  }

  private async fromThreadCreator(origins: readonly PromptOrigin[]): Promise<boolean> {
    if (origins.some((origin) => origin.kind === 'system_trigger' && origin.name === 'thread_create')) return true;
    if (!origins.some((origin) => origin.kind === 'peer_thread' || origin.kind === 'bridged_peer')) return false;
    const creator = (await this.metadata.read()).custom?.[CREATED_BY_SESSION_ID_KEY];
    if (typeof creator !== 'string' || creator === '') return false;
    return origins.some((origin) => origin.kind === 'peer_thread'
      ? origin.source.sessionId === creator
      : origin.kind === 'bridged_peer' && `${origin.source.hostId}:${origin.source.sessionId}` === creator);
  }
}

function threadInputOrigins(origin: PromptOrigin | undefined): PromptOrigin[] {
  if (origin === undefined) return [];
  if (origin.kind === 'merged') return origin.origins.flatMap((item) => threadInputOrigins(item));
  return steeringInputSource(origin) === 'thread' ? [origin] : [];
}
