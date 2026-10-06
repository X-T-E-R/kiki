import { Disposable } from '#/_base/di/lifecycle';
import {
  IAgentContextInjectorService,
  type ContextInjectionContent,
  type ContextInjectionContext,
} from '#/agent/contextInjector/contextInjector';
import { cognitionPathRefs, readCognitionSlot } from '#/agent/cognition/cognitionFiles';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { IAgentModelSteeringService } from './modelSteering';

const MODEL_STEERING_INJECTION_VARIANT = 'model_steering';

/** `modelSteering` domain (L4) — `IAgentModelSteeringService` implementation (Agent scope). Owns the
 *  `model_steering` context-injection provider: each turn (including after compaction re-arm) it
 *  appends the bound model's `[models.<alias>.cognition].steering` text as a following user message
 *  after the user/task prompt — the dsh near-field shape, not a `<system-reminder>` — and re-injects
 *  the text frozen at binding on each turn. Legacy bindings without saved slots read the file;
 *  a read failure is skipped by the injector. */
export class AgentModelSteeringService extends Disposable implements IAgentModelSteeringService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
  ) {
    super();
    this._register(
      injector.register(MODEL_STEERING_INJECTION_VARIANT, (ctx) => this.reminder(ctx)),
    );
  }

  private async reminder({
    isNewTurn,
  }: ContextInjectionContext): Promise<ContextInjectionContent | undefined> {
    if (!isNewTurn) return undefined;
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
}
