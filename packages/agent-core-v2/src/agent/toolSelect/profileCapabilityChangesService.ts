import { toDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IConfigService } from '#/app/config/config';
import { withDispatchPolicyDefaults } from '#/session/subagent/configSection';
import { subagentDispatchAllowed } from '@kiki/agent-profiles/subagentDispatch';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';

import { IAgentProfileCapabilityChangesService } from './profileCapabilityChanges';

const VARIANT = 'profile_capabilities_changed';
const MIN_INTERVAL_MS = 1_000;
type CapabilityKind = 'skills' | 'subagents';

export class AgentProfileCapabilityChangesService extends Service implements IAgentProfileCapabilityChangesService {
  declare readonly _serviceBrand: undefined;
  private baseline: Record<CapabilityKind, string> | undefined;
  private readonly pending = new Set<CapabilityKind>();
  private readonly disclosedThisGap = new Set<CapabilityKind>();
  private lastObservedTurnId: number | undefined;
  private lastDeliveredAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    @ISessionAgentProfileCatalog private readonly profiles: ISessionAgentProfileCatalog,
    @ISessionSkillCatalog private readonly skills: ISessionSkillCatalog,
    @IAgentToolPolicyService private readonly policy: IAgentToolPolicyService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @IConfigService private readonly configService: IConfigService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IEventBus eventBus: IEventBus,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
  ) {
    super();
    this._register(injector.register(VARIANT, () => {
      const turnId = this.loop.status().activeTurnId;
      if (turnId !== undefined && turnId !== this.lastObservedTurnId) {
        this.lastObservedTurnId = turnId;
        this.disclosedThisGap.clear();
      }
      this.baseline ??= this.snapshot();
      return undefined;
    }));
    this._register(this.profiles.onDidChange(() => this.changed()));
    this._register(this.skills.onDidChange(() => this.changed()));
    this._register(eventBus.subscribe(TurnEnded, () => this.schedule()));
    this._register(toDisposable(() => this.clearTimer()));
  }

  private snapshot(): Record<CapabilityKind, string> {
    const skills = this.policy.isToolActive('Skill')
      ? JSON.stringify(this.skills.catalog.listInvocableSkills()
        .map((skill) => [skill.name, skill.description, skill.path, skill.content])
        .toSorted((a, b) => a[0]!.localeCompare(b[0]!)))
      : '';
    const caller = withDispatchPolicyDefaults(
      this.configService,
      this.profile.data(),
      this.scope.parentAgentId === undefined ? 'main' : 'sub',
    );
    const subagents = this.policy.isToolActive('AgentRun')
      ? JSON.stringify(this.profiles.list()
        .filter((entry) => entry.main !== true && subagentDispatchAllowed(this.profiles, caller, entry.name))
        .map((entry) => [entry.name, entry.definitionId])
        .toSorted((a, b) => a[0]!.localeCompare(b[0]!)))
      : '';
    return { skills, subagents };
  }

  private changed(): void {
    if (this.baseline === undefined) return;
    const next = this.snapshot();
    for (const kind of ['skills', 'subagents'] as const) {
      if (this.disclosedThisGap.has(kind) && this.loop.status().state === 'idle') {
        this.baseline = { ...this.baseline, [kind]: next[kind] };
        this.pending.delete(kind);
      } else if (this.baseline[kind] !== next[kind]) this.pending.add(kind);
      else this.pending.delete(kind);
    }
    if (this.pending.size === 0) this.clearTimer();
    else this.schedule();
  }

  private schedule(): void {
    if (this.pending.size === 0 || this.timer !== undefined || this.loop.status().state !== 'idle') return;
    const delay = Math.max(0, MIN_INTERVAL_MS - (Date.now() - this.lastDeliveredAt));
    if (delay === 0) {
      this.deliver();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.deliver();
    }, delay);
  }

  private deliver(): void {
    if (this.loop.status().state !== 'idle' || this.pending.size === 0) return;
    const next = this.snapshot();
    for (const kind of ['skills', 'subagents'] as const) {
      if (this.baseline?.[kind] !== next[kind]) this.pending.add(kind);
      else this.pending.delete(kind);
    }
    if (this.pending.size === 0) return;
    const kinds = [...this.pending];
    this.pending.clear();
    for (const kind of kinds) this.disclosedThisGap.add(kind);
    this.baseline = next;
    this.lastDeliveredAt = Date.now();
    this.reminders.appendSystemReminder(
      `Available profile capabilities changed (${kinds.join(', ')}). Check the current skill and subagent listings before using them; existing system instructions and tool schemas remain unchanged until context rebuild.`,
      { kind: 'injection', variant: VARIANT },
    );
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentProfileCapabilityChangesService,
  AgentProfileCapabilityChangesService,
  ScopeActivation.OnScopeCreated,
  'toolSelect',
);
