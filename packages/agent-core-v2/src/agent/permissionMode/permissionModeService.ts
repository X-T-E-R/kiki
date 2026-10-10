import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { parseBooleanEnv } from '#/_base/utils/env';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { PermissionModeInjection } from '#/agent/permissionMode/injection/permissionModeInjection';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  constrainPermissionMode,
  IAgentPermissionModeService,
  type PermissionModeChangedContext,
} from './permissionMode';
import {
  permissionModeConfiguredKey,
  permissionModeExternalOverrideKey,
  permissionModeKey,
  PermissionSetMode,
} from './permissionModeOps';

export const PERMISSION_MODE_REMINDER_ENV = 'KIKI_PERMISSION_MODE_REMINDER';

export class AgentPermissionModeService extends Service implements IAgentPermissionModeService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChangeMode = this._register(new Emitter<PermissionModeChangedContext>());
  readonly onDidChangeMode: Event<PermissionModeChangedContext> = this._onDidChangeMode.event;
  private ceiling: PermissionMode | undefined;
  readonly interactive: boolean;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IInstantiationService instantiation: IInstantiationService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IBootstrapService bootstrap: IBootstrapService,
  ) {
    super();
    this.interactive = bootstrap.interactive ?? true;
    this.agentState.contributeState(permissionModeKey);
    this.agentState.contributeState(permissionModeConfiguredKey);
    this.agentState.contributeState(permissionModeExternalOverrideKey);
    if (parseBooleanEnv(bootstrap.getEnv(PERMISSION_MODE_REMINDER_ENV)) !== false) {
      this._register(instantiation.createInstance(PermissionModeInjection, this));
    }
  }

  get mode(): PermissionMode {
    return this.agentState.get(permissionModeKey);
  }

  get externalOverride(): PermissionMode | undefined {
    return this.agentState.get(permissionModeExternalOverrideKey) ?? undefined;
  }

  get modeCeiling(): PermissionMode | undefined {
    return this.ceiling;
  }

  setMode(mode: PermissionMode, source: 'runtime' | 'ambient' | 'binding' = 'runtime'): void {
    const effective = this.ceiling === undefined ? mode : constrainPermissionMode(mode, this.ceiling);
    const previousMode = this.mode;
    const changed = effective !== previousMode;
    const override = source === 'runtime' ? effective : source === 'binding' ? undefined : this.externalOverride;
    if (!changed && this.agentState.get(permissionModeConfiguredKey) && override === this.externalOverride) return;
    void this.dispatcher.dispatch(new PermissionSetMode({ mode: effective, source }));
    if (changed) this._onDidChangeMode.fire({ mode: effective, previousMode });
  }

  setModeCeiling(mode: PermissionMode): void {
    this.ceiling = mode;
    this.setMode(this.mode, this.externalOverride === undefined ? 'ambient' : 'runtime');
  }

  setModeAndBroadcast(mode: PermissionMode): void {
    const wasYolo = this.mode === 'yolo';
    const wasAuto = this.mode === 'auto';
    this.setMode(mode);
    if (this.scopeContext.agentId === MAIN_AGENT_ID) {
      this.agentLifecycle.broadcastPermissionMode(mode);
    }
    const yoloEnabled = this.mode === 'yolo';
    if (yoloEnabled !== wasYolo) {
      this.telemetry.track2('yolo_toggle', { enabled: yoloEnabled });
    }
    const afkEnabled = this.mode === 'auto';
    if (afkEnabled !== wasAuto) {
      this.telemetry.track2('afk_toggle', { enabled: afkEnabled });
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionModeService,
  AgentPermissionModeService,
  ScopeActivation.OnScopeCreated,
  'permissionMode',
);
