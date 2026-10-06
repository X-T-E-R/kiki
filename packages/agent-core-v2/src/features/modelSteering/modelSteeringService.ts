import { Disposable } from '#/_base/di/lifecycle';
import {
  IAgentContextInjectorService,
  type ContextInjectionContent,
  type ContextInjectionContext,
} from '#/agent/contextInjector/contextInjector';
import { cognitionPathRefs, readCognitionSlot } from '#/agent/cognition/cognitionFiles';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { IAgentModelSteeringService } from './modelSteering';

const MODEL_STEERING_INJECTION_VARIANT = 'model_steering';

/** `modelSteering` domain (L4) — `IAgentModelSteeringService` implementation (Agent scope). Owns the
 *  `model_steering` context-injection provider: each turn, after newly materialized human input,
 *  and after compaction re-arm, it appends the bound model's `[models.<alias>.cognition].steering`
 *  text as a following user message, not a `<system-reminder>`. Human input uses explicit user,
 *  plugin-command, or user-slash skill origins; peer and background deliveries do not re-arm it.
 *  The last injection position consumes all preceding inputs without changing their order.
 *  Text stays frozen at binding. Legacy bindings without saved slots read the file;
 *  a read failure is skipped by the injector. */
export class AgentModelSteeringService extends Disposable implements IAgentModelSteeringService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
  ) {
    super();
    this._register(
      injector.register(MODEL_STEERING_INJECTION_VARIANT, (ctx) => this.reminder(ctx)),
    );
  }

  private async reminder({
    isNewTurn,
    lastInjectedAt,
  }: ContextInjectionContext): Promise<ContextInjectionContent | undefined> {
    if (!isNewTurn && !this.hasNewHumanInput(lastInjectedAt)) return undefined;
    const binding = await this.profile.getCognitionBinding();
    const text = binding.slots === undefined ? await readCognitionSlot(
      this.fs,
      this.bootstrap.homeDir,
      'steering',
      cognitionPathRefs(binding.config?.steering),
      this.hostEnv.pathClass,
    ) : binding.slots.steering;
    if (text === undefined) return undefined;
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
