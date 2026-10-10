import { modelSteeringSourceIds } from '@kiki/protocol';
import { Disposable } from '#/_base/di/lifecycle';
import { IAgentContextInjectorService, type ContextInjectionContent, type ContextInjectionContext } from '#/agent/contextInjector/contextInjector';
import { readCognitionContent } from '#/agent/cognition/cognitionFiles';
import { loadSteeringSources } from '#/agent/cognition/steeringBinding';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { IEventBus } from '#/app/event/eventBus';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAgentModelSteeringService } from './modelSteering';
import { steeringInputSources, type SteeringInputSource } from './modelSteeringSources';

const MODEL_STEERING_INJECTION_VARIANT = 'model_steering';

/** Frozen per-source steering at safe request boundaries. Unconfigured and unknown sources stay off, including turn, interval and compaction triggers. */
export class AgentModelSteeringService extends Disposable implements IAgentModelSteeringService {
  declare readonly _serviceBrand: undefined;
  private lastStepId: string | undefined;
  private inStep = false;
  private cadenceBinding: string | undefined;
  private stepOrdinal = 0;
  private readonly cadence = new Map<SteeringInputSource, { steps: number; lastInjection: number; countedStep?: number }>();
  private activeSources = new Set<SteeringInputSource>();
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
  ) {
    super();
    this._register(events.subscribe(TurnStarted, (event) => {
      this.turnId = event.turnId;
      if (event.origin.kind === 'retry') {
        if (this.activeSources.size === 0) {
          const lastInput = this.context.get().findLast((message) => message.role === 'user' && message.origin?.kind !== 'injection' && message.origin?.kind !== 'compaction_summary' && message.origin?.kind !== 'shell_command');
          this.activeSources = steeringInputSources(lastInput?.origin);
        }
        return;
      }
      this.turnSources = steeringInputSources(event.origin);
    }));
    this._register(loop.hooks.onWillBeginStep.register('model-steering.cadence', async ({ stepId, signal }, next) => {
      signal.throwIfAborted();
      this.inStep = stepId === undefined || stepId !== this.lastStepId;
      if (this.inStep) this.stepOrdinal++;
      this.lastStepId = stepId;
      try { await next(); }
      finally { this.inStep = false; }
    }, { before: 'context-injector' }));
    this._register(injector.register(MODEL_STEERING_INJECTION_VARIANT, (ctx) => this.reminder(ctx)));
  }

  private async reminder({ isNewTurn, lastInjectedAt }: ContextInjectionContext): Promise<ContextInjectionContent | undefined> {
    const binding = await this.profile.getCognitionBinding();
    const bindingKey = `${binding.modelAlias}:${binding.position}:${binding.revision}:${binding.contentRevision}`;
    if (this.cadenceBinding !== bindingKey) {
      this.cadenceBinding = bindingKey;
      this.cadence.clear();
    }
    const { sources: inputSources, hasInput } = this.readInputs(lastInjectedAt);
    if (this.turnSources !== undefined) {
      this.activeSources = this.turnSources;
      this.turnSources = undefined;
    }
    if (hasInput) this.activeSources = inputSources;
    const frozen = binding.steeringSources ?? (binding.slots === undefined ? await loadSteeringSources(this.fs, this.bootstrap.homeDir, binding.config, undefined, this.hostEnv.pathClass) : undefined);
    const texts = new Set<string>();
    for (const source of ['user', ...modelSteeringSourceIds] as const) {
      if (!this.activeSources.has(source)) continue;
      const setting = source === 'user' ? undefined : frozen?.[source];
      if (source !== 'user' && (setting === undefined || setting.mode === 'off')) continue;
      const inherited = source === 'user' || setting?.mode === 'inherit';
      const onTurn = inherited ? binding.config?.steeringOnTurn ?? true : setting?.custom?.steering_on_turn ?? true;
      const onInput = inherited ? binding.config?.steeringOnInput ?? true : setting?.custom?.steering_on_input ?? true;
      const interval = inherited ? binding.config?.steeringIntervalSteps ?? 0 : setting?.custom?.steering_interval_steps ?? 0;
      const counter = this.cadence.get(source) ?? { steps: 0, lastInjection: 0, countedStep: undefined };
      this.cadence.set(source, counter);
      if (this.inStep && counter.countedStep !== this.stepOrdinal) { counter.steps++; counter.countedStep = this.stepOrdinal; }
      if (!(isNewTurn && onTurn) && !(inputSources.has(source) && onInput) && !(this.inStep && interval > 0 && counter.steps - counter.lastInjection >= interval)) continue;
      const text = inherited ? binding.slots === undefined ? await readCognitionContent(this.fs, this.bootstrap.homeDir, 'steering', binding.config?.steering, this.hostEnv.pathClass) : binding.slots.steering : setting?.custom?.steering;
      if (text === undefined || text.trim().length === 0) continue;
      texts.add(text);
      counter.lastInjection = counter.steps;
    }
    if (texts.size === 0) return undefined;
    return { message: { role: 'user', content: [...texts].map((text) => ({ type: 'text', text })) } };
  }

  private readInputs(lastInjectedAt: number | null): { sources: Set<SteeringInputSource>; hasInput: boolean } {
    const history = this.context.get();
    const tailIndex = this.observedTail === undefined ? -1 : history.indexOf(this.observedTail);
    const floor = Math.max(tailIndex, lastInjectedAt ?? -1);
    const sources = new Set<SteeringInputSource>();
    let hasInput = false;
    for (let index = history.length - 1; index > floor; index--) {
      const message = history[index]!;
      if (message.role === 'assistant' && tailIndex < 0) break;
      if (message.role !== 'user' || message.origin?.kind === 'injection' || message.origin?.kind === 'compaction_summary' || message.origin?.kind === 'persona_greeting' || message.origin?.kind === 'shell_command') continue;
      if (this.turnId !== undefined && message.source?.turnId !== undefined && message.source.turnId !== this.turnId) continue;
      hasInput = true;
      for (const source of steeringInputSources(message.origin)) sources.add(source);
    }
    this.observedTail = history.at(-1);
    return { sources, hasInput };
  }
}
