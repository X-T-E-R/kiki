import { Disposable } from '#/_base/di/lifecycle';
import {
  IAgentContextInjectorService,
  type ContextInjectionContent,
  type ContextInjectionContext,
} from '#/agent/contextInjector/contextInjector';
import { readCognitionContent } from '#/agent/cognition/cognitionFiles';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { IAgentModelSteeringService } from './modelSteering';

const MODEL_STEERING_INJECTION_VARIANT = 'model_steering';

/** `modelSteering` domain (L4) — Agent-scoped owner of the `model_steering` injector provider.
 *  Frozen cognition settings independently enable all new turns/compaction re-arm (default true),
 *  materialized human input (default true), and every N model step heads of this agent (default 0/off).
 *  Coinciding triggers append one plain user message; any injection restarts the step interval.
 *  Human input uses explicit user, plugin-command, or user-slash skill origins, not peer/task input.
 *  The last injection position consumes preceding inputs without changing their order.
 *  Binding changes and cold recovery restart the provider-local counter, not frozen text/settings.
 *  Legacy bindings without saved slots read the file; a read failure is skipped by the injector. */
export class AgentModelSteeringService extends Disposable implements IAgentModelSteeringService {
  declare readonly _serviceBrand: undefined;
  private stepOrdinal = 0;
  private lastInjectionStep = 0;
  private lastStepId: string | undefined;
  private inStep = false;
  private cadenceBinding: string | undefined;

  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLoopService loop: IAgentLoopService,
  ) {
    super();
    this._register(loop.hooks.onWillBeginStep.register('model-steering.cadence', async ({ stepId, signal }, next) => {
      signal.throwIfAborted();
      if (stepId === undefined || stepId !== this.lastStepId) this.stepOrdinal++;
      this.lastStepId = stepId;
      this.inStep = true;
      try {
        await next();
      } finally {
        this.inStep = false;
      }
    }, { before: 'context-injector' }));
    this._register(
      injector.register(MODEL_STEERING_INJECTION_VARIANT, (ctx) => this.reminder(ctx)),
    );
  }

  private async reminder({
    isNewTurn,
    lastInjectedAt,
  }: ContextInjectionContext): Promise<ContextInjectionContent | undefined> {
    const binding = await this.profile.getCognitionBinding();
    const bindingKey = `${binding.modelAlias}:${binding.position}:${binding.revision}:${binding.contentRevision}`;
    if (this.cadenceBinding !== bindingKey) {
      this.cadenceBinding = bindingKey;
      this.stepOrdinal = this.inStep ? 1 : 0;
      this.lastInjectionStep = 0;
    }
    const interval = binding.config?.steeringIntervalSteps ?? 0;
    const onTurn = isNewTurn && (binding.config?.steeringOnTurn ?? true);
    const onInput = (binding.config?.steeringOnInput ?? true) && this.hasNewHumanInput(lastInjectedAt);
    const onInterval = this.inStep && interval > 0 && this.stepOrdinal - this.lastInjectionStep >= interval;
    if (!onTurn && !onInput && !onInterval) return undefined;
    const text = binding.slots === undefined ? await readCognitionContent(
      this.fs,
      this.bootstrap.homeDir,
      'steering',
      binding.config?.steering,
      this.hostEnv.pathClass,
    ) : binding.slots.steering;
    if (text === undefined || text.trim().length === 0) return undefined;
    this.lastInjectionStep = this.stepOrdinal;
    return {
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    };
  }

  private hasNewHumanInput(lastInjectedAt: number | null): boolean {
    const history = this.context.get();
    for (let index = history.length - 1; index > (lastInjectedAt ?? -1); index--) {
      const message = history[index]!;
      if (message.role !== 'user') continue;
      const origin = message.origin;
      if (origin?.kind === 'user' || origin?.kind === 'plugin_command' ||
        (origin?.kind === 'skill_activation' && origin.trigger === 'user-slash')) return true;
    }
    return false;
  }
}
