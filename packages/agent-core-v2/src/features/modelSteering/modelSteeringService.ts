/**
 * `modelSteering` domain (L4) — `IAgentModelSteeringService` implementation.
 *
 * Owns the `model_steering` context-injection provider. On every new turn
 * (including after compaction re-arm) it appends the bound model's
 * `[models.<alias>.cognition].steering` text as a following user message
 * after the user/task prompt — the dsh near-field shape (`inbox.append`
 * after the real user message), not a `<system-reminder>`. Identical text
 * is re-injected each turn so the cue does not drift away from the latest
 * prompt. File presence is validated at profile bind; a later read failure
 * is skipped by the injector (fail-open at this seam only). Bound at Agent
 * scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import {
  IAgentContextInjectorService,
  type ContextInjectionContent,
  type ContextInjectionContext,
} from '#/agent/contextInjector/contextInjector';
import { cognitionPathRefs, readCognitionSlot } from '#/agent/cognition/cognitionFiles';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IModelService } from '#/kosong/model/model';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { IAgentModelSteeringService } from './modelSteering';

const MODEL_STEERING_INJECTION_VARIANT = 'model_steering';

export class AgentModelSteeringService extends Disposable implements IAgentModelSteeringService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelService private readonly models: IModelService,
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
    const alias = this.profile.data().modelAlias;
    if (alias === undefined || alias.length === 0) return undefined;
    const record = this.models.get(alias);
    const text = await readCognitionSlot(
      this.fs,
      this.bootstrap.homeDir,
      'steering',
      cognitionPathRefs(record?.cognition?.steering),
      this.hostEnv.pathClass,
    );
    if (text === undefined) return undefined;
    return {
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    };
  }
}
