import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { IAgentCapabilityRebuildService } from './capabilityRebuild';

const VARIANT = 'capabilities_rebuilt';

export class AgentCapabilityRebuildService extends Service implements IAgentCapabilityRebuildService {
  declare readonly _serviceBrand: undefined;
  private lastTurnId: number | undefined;
  private activeUserTurnId: number | undefined;

  constructor(
    @ICapabilitySnapshotService private readonly capabilities: ICapabilitySnapshotService,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IEventBus eventBus: IEventBus,
  ) {
    super();
    this.capabilities.memoryAvailable(this.session.workspaceId, this.session.sessionId);
    this._register(eventBus.subscribe(TurnStarted, (event) => {
      const origin = event.origin;
      if (origin.kind === 'user' ||
        (origin.kind === 'skill_activation' && origin.trigger === 'user-slash') ||
        origin.kind === 'plugin_command') this.activeUserTurnId = event.turnId;
    }));
    this._register(injector.register(VARIANT, async () => {
      await this.rebuildAtUserTurn();
      return undefined;
    }));
  }

  private async rebuildAtUserTurn(): Promise<void> {
    const turnId = this.loop.status().activeTurnId;
    if (turnId === undefined || turnId !== this.activeUserTurnId || turnId === this.lastTurnId) return;
    this.lastTurnId = turnId;
    await this.capabilities.ready;
    const changed = this.capabilities.refresh(this.session.workspaceId, this.session.sessionId);
    if (!changed.memory && !changed.thread) return;
    if (changed.memory) await this.profile.refreshMemorySnapshot();
    else await this.profile.refreshSystemPrompt();
    const features = [changed.memory ? 'memory' : undefined, changed.thread ? 'thread communication' : undefined]
      .filter((name): name is string => name !== undefined);
    this.reminders.appendSystemReminder(
      `Capability settings changed (${features.join(', ')}). The available tools and system instructions were rebuilt for this user turn.`,
      { kind: 'injection', variant: VARIANT },
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentCapabilityRebuildService,
  AgentCapabilityRebuildService,
  ScopeActivation.OnScopeCreated,
  'capabilityRebuild',
);
