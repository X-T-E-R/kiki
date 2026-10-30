import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { ILogService } from '#/_base/log/log';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentModelSwitchService, type ModelSwitchReceipt } from '#/agent/modelSwitch/modelSwitch';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentPluginService } from '#/agent/plugin/agentPlugin';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentFullCompactionService, type FullCompactionTask } from '#/agent/fullCompaction/fullCompaction';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionContextSourceReloader } from '#/session/contextRebuild/contextSourceReloader';
import { ISessionPluginUsageService } from '#/session/pluginUsage/sessionPluginUsageService';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  CONTEXT_REBUILD_SURFACES,
  IAgentContextRebuildService,
  type ContextRebuildChanges,
  type ContextRebuildControl,
  type ContextRebuildResult,
  type ContextRebuildSurface,
  type ContextRebuildTrigger,
  type ContextRebuildUnsupported,
} from './contextRebuild';
import {
  ContextRebuildPreferenceChanged,
  ContextRebuildReported,
  contextRebuildControlKey,
} from './contextRebuildOps';

export class AgentContextRebuildService extends Disposable implements IAgentContextRebuildService {
  declare readonly _serviceBrand: undefined;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentContextInjectorService private readonly injector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentLLMRequesterService private readonly requester: IAgentLLMRequesterService,
    @IAgentPluginService private readonly plugin: IAgentPluginService,
    @IAgentMcpService private readonly mcp: IAgentMcpService,
    @ISessionAgentProfileCatalog private readonly profiles: ISessionAgentProfileCatalog,
    @ISessionSkillCatalog private readonly skills: ISessionSkillCatalog,
    @ISessionContextSourceReloader private readonly sources: ISessionContextSourceReloader,
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentFullCompactionService private readonly compaction: IAgentFullCompactionService,
    @IAgentModelSwitchService private readonly modelSwitch: IAgentModelSwitchService,
    @ILogService private readonly log: ILogService,
    @ISessionPluginUsageService private readonly pluginUsage?: ISessionPluginUsageService,
  ) {
    super();
    this._register(this.states.contributeState(contextRebuildControlKey));
    this._register(this.compaction.hooks.onDidCommit.register('context-rebuild', async (task, next) => {
      try {
        await this.rebuildAfterBoundary(compactionTrigger(task), task.abortController.signal);
      } finally {
        await next();
      }
    }));
    this._register(this.modelSwitch.hooks.onDidCommitContextWindow.register('context-rebuild', async (receipt, next) => {
      try {
        const trigger = contextWindowTrigger(receipt);
        if (trigger !== undefined) await this.rebuildAfterBoundary(trigger);
      } finally {
        await next();
      }
    }));
    this._register(this.context.hooks.onDidClear.register('context-rebuild', async (_cleared, next) => {
      try {
        if (this.canRebuildAfterClear()) await this.rebuildAfterBoundary('context_clear');
      } catch (error) {
        this.log.error('failed to rebuild after clearing context', { error, committed: true });
      } finally {
        await next();
      }
    }));
    this._register(this.dispatcher.hooks.onDidRestore.register('context-rebuild', async (_ctx, next) => {
      try {
        await this.rebuildAfterBoundary('restore');
      } finally {
        await next();
      }
    }));
  }

  control(): ContextRebuildControl {
    const state = this.states.get(contextRebuildControlKey);
    return {
      enabled: state.enabled,
      outcome: state.outcome,
      trigger: state.trigger,
      at: state.at,
      error: state.error,
      changes: state.changes === undefined ? undefined : { ...state.changes },
      rebuilt: [...state.rebuilt],
      unsupported: state.unsupported.map((item) => ({ ...item })),
    };
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Context rebuild enablement must be a boolean.');
    }
    if (this.control().enabled === enabled) return;
    await this.dispatcher.dispatch(new ContextRebuildPreferenceChanged({ enabled }));
  }

  rebuild(): Promise<ContextRebuildResult> {
    return this.exclusive(() => this.execute('quiescence', 'manual', undefined, true));
  }

  private canRebuildAfterClear(): boolean {
    const status = this.loop.status();
    return status.state === 'idle' && status.pendingTurnIds.length === 0
      && status.finalizing !== true && !this.compaction.isCompacting();
  }

  private rebuildAfterBoundary(trigger: Exclude<ContextRebuildTrigger, 'manual'>, signal?: AbortSignal): Promise<void> {
    if (this.control().enabled !== true) return Promise.resolve();
    return this.exclusive(async () => {
      if (this.control().enabled !== true) return;
      await this.execute('boundary', trigger, signal, false);
    });
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.pending.then(work, work);
    this.pending = run.then(() => undefined, () => undefined);
    return run;
  }

  private async execute(
    admission: 'quiescence' | 'boundary',
    trigger: ContextRebuildTrigger,
    signal: AbortSignal | undefined,
    propagate: boolean,
  ): Promise<ContextRebuildResult> {
    if (admission === 'quiescence') {
      if (this.scope.agentId !== MAIN_AGENT_ID) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'Context rebuild is only available for the main agent.');
      }
      const quiescence = this.loop.tryAcquireQuiescence({ pendingSteps: 'preserve' });
      if (quiescence === undefined) {
        throw new Error2(
          ErrorCodes.REQUEST_INVALID,
          'The session is busy. Wait for the current turn to finish, then rebuild context again.',
        );
      }
      try {
        return await this.stages(trigger, signal, propagate);
      } finally {
        await quiescence.dispose();
      }
    }
    return this.stages(trigger, signal, propagate);
  }

  private async stages(
    trigger: ContextRebuildTrigger,
    signal: AbortSignal | undefined,
    propagate: boolean,
  ): Promise<ContextRebuildResult> {
    const completed: ContextRebuildSurface[] = [];
    const unsupported = this.limits();
    const skipped = new Set(unsupported.map((item) => item.surface));
    let sourceChanges: { instructionsChanged: boolean; pluginsChanged: boolean } | undefined;
    let beforeProfile: ReturnType<IAgentProfileService['data']> | undefined;
    let beforeContext = '';
    let beforeFields: ReturnType<IAgentProfileService['getPromptFieldSnapshot']> | undefined;
    let beforeSkills = '';
    let beforeMcp: string | undefined;
    const toolSnapshot = () => this.mcp.list().map(({ name }) => ({
      name,
      tools: this.mcp.resolved(name)?.rawTools,
      enabledNames: [...(this.mcp.resolved(name)?.enabledNames ?? [])].sort(),
    }));
    let changes: ContextRebuildChanges | undefined;
    let readiness: ContextRebuildResult['readiness'] | undefined;
    try {
      this.throwIfCancelled(signal);
      beforeProfile = snapshotProfile(this.profile.data());
      beforeContext = JSON.stringify(this.context.get());
      beforeFields = this.profile.getPromptFieldSnapshot();
      await this.skills.ready;
      beforeSkills = JSON.stringify(this.skills.catalog.listSkills());
      beforeMcp = JSON.stringify({ capabilities: await this.mcp.listMcpSessionCapabilities(), tools: toolSnapshot() });
      this.throwIfCancelled(signal);
      sourceChanges = await this.sources.reload();
      completed.push('instructions');
      this.throwIfCancelled(signal);
      await this.profiles.reload();
      this.throwIfCancelled(signal);
      await this.skills.reload();
      completed.push('skills');
      this.throwIfCancelled(signal);
      try {
        await this.profile.rebuildPromptContext();
      } catch (error) {
        if (beforeProfile !== undefined && this.profileCommitted(beforeProfile)) completed.push('profile', 'prompt_fields');
        throw error;
      }
      completed.push('profile', 'prompt_fields');
      this.requester.invalidatePromptSnapshots();
      this.throwIfCancelled(signal);
      if (!skipped.has('plugins')) {
        await this.plugin.refreshSessionStartAtSafeBoundary();
        completed.push('plugins');
        this.throwIfCancelled(signal);
      }
      await this.mcp.refreshCapabilities();
      completed.push('mcp');
      this.throwIfCancelled(signal);
      if (!skipped.has('injections')) {
        await this.injector.reconcileAllAtSafeBoundary();
        completed.push('injections');
        this.throwIfCancelled(signal);
      }
      const capabilities = await this.mcp.listMcpSessionCapabilities();
      const afterMcp = JSON.stringify({ capabilities, tools: toolSnapshot() });
      const pluginUsage = await this.pluginUsage?.read();
      changes = this.diffChanges({
        completed, skipped, sourceChanges, beforeProfile, beforeContext, beforeFields, beforeSkills, beforeMcp, afterMcp,
      });
      readiness = {
        mcp: capabilities.map(({ runtimeName, connection, error }) => ({ runtimeName, connection, error })),
        plugins: {
          state: pluginUsage?.applyState === 'applied' ? 'ready' : pluginUsage?.applyState ?? 'unavailable',
          errors: pluginUsage?.errors ?? [],
        },
      };
      const result = this.result('applied', completed, unsupported, changes, readiness);
      await this.report(trigger, result);
      return result;
    } catch (error) {
      if (completed.includes('prompt_fields')) this.requester.invalidatePromptSnapshots();
      const outcome = completed.length === 0 ? 'failed' : 'partial';
      let observed = changes;
      if (observed === undefined && outcome === 'partial') {
        let afterMcp: string | undefined;
        if (completed.includes('mcp') && beforeMcp !== undefined) {
          try {
            afterMcp = JSON.stringify({ capabilities: await this.mcp.listMcpSessionCapabilities(), tools: toolSnapshot() });
          } catch {
            afterMcp = undefined;
          }
        }
        try {
          observed = this.diffChanges({
            completed, skipped, sourceChanges, beforeProfile, beforeContext, beforeFields, beforeSkills, beforeMcp, afterMcp,
          });
        } catch (diffError) {
          this.log.error('failed to read context rebuild changes', { error: diffError, committed: true });
          observed = undefined;
        }
      }
      const result = this.result(outcome, completed, unsupported, observed, readiness);
      await this.report(trigger, result, messageOf(error));
      if (propagate) throw error;
      return result;
    }
  }

  private diffChanges(input: {
    completed: readonly ContextRebuildSurface[];
    skipped: ReadonlySet<ContextRebuildUnsupported['surface']>;
    sourceChanges: { instructionsChanged: boolean; pluginsChanged: boolean } | undefined;
    beforeProfile: ReturnType<IAgentProfileService['data']> | undefined;
    beforeContext: string;
    beforeFields: ReturnType<IAgentProfileService['getPromptFieldSnapshot']> | undefined;
    beforeSkills: string;
    beforeMcp: string | undefined;
    afterMcp: string | undefined;
  }): ContextRebuildChanges {
    const afterProfile = this.profile.data();
    const finished = (surface: ContextRebuildSurface) => input.completed.includes(surface);
    return {
      profile: finished('profile') && input.beforeProfile !== undefined && (
        JSON.stringify(input.beforeProfile.boundProfile) !== JSON.stringify(afterProfile.boundProfile)
        || input.beforeProfile.systemPrompt !== afterProfile.systemPrompt
      ),
      promptFields: finished('prompt_fields') && input.beforeFields !== undefined
        && JSON.stringify(input.beforeFields) !== JSON.stringify(this.profile.getPromptFieldSnapshot()),
      skills: finished('skills') && input.beforeSkills !== JSON.stringify(this.skills.catalog.listSkills()),
      instructions: finished('instructions') && input.sourceChanges?.instructionsChanged === true,
      plugins: finished('plugins') && !input.skipped.has('plugins') && input.sourceChanges?.pluginsChanged === true,
      mcp: finished('mcp') && input.beforeMcp !== undefined && input.afterMcp !== undefined && input.beforeMcp !== input.afterMcp,
      injections: finished('injections') && !input.skipped.has('injections')
        && input.beforeContext !== JSON.stringify(this.context.get()),
    };
  }

  private limits(): readonly ContextRebuildUnsupported[] {
    const executor = this.profile.data().executorId;
    if (executor === undefined || executor === 'native') return [];
    return [
      {
        surface: 'executor_session',
        reason: `The running ${executor} session is not restarted or sent a new prompt. Host binding updates stay on the host.`,
      },
      {
        surface: 'plugins',
        reason: 'Plugin session-start reminders are native context and are not pushed into this executor.',
      },
      {
        surface: 'injections',
        reason: 'Native context injections are not applied to this executor session.',
      },
    ];
  }

  private profileCommitted(before: ReturnType<IAgentProfileService['data']>): boolean {
    const after = this.profile.data();
    return before.systemPrompt !== after.systemPrompt
      || before.profileName !== after.profileName
      || JSON.stringify(before.boundProfile) !== JSON.stringify(after.boundProfile)
      || before.modelAlias !== after.modelAlias
      || before.thinkingLevel !== after.thinkingLevel;
  }

  private result(
    outcome: ContextRebuildResult['outcome'],
    completed: readonly ContextRebuildSurface[],
    unsupported: readonly ContextRebuildUnsupported[],
    changes: ContextRebuildChanges | undefined,
    readiness: ContextRebuildResult['readiness'] | undefined,
  ): ContextRebuildResult {
    return {
      rebuilt: CONTEXT_REBUILD_SURFACES.filter((surface) => completed.includes(surface)),
      changed: changes === undefined ? completed.length > 0 : Object.values(changes).some(Boolean),
      ...(changes === undefined ? {} : { changes }),
      outcome,
      unsupported: unsupported.map((item) => ({ ...item })),
      appliesOn: 'next_request',
      readiness: readiness ?? {
        mcp: [],
        plugins: { state: 'unavailable', errors: [] },
      },
    };
  }

  private async report(
    trigger: ContextRebuildTrigger,
    result: ContextRebuildResult,
    error?: string,
  ): Promise<void> {
    await this.dispatcher.dispatch(new ContextRebuildReported({
      outcome: result.outcome,
      trigger,
      at: new Date().toISOString(),
      ...(error === undefined ? {} : { error: error.slice(0, 500) }),
      ...(result.changes === undefined ? {} : { changes: result.changes }),
      rebuilt: [...result.rebuilt],
      unsupported: result.unsupported.map((item) => ({ surface: item.surface, reason: item.reason.slice(0, 300) })),
    }));
  }

  private throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted !== true) return;
    const reason = signal.reason;
    const message = reason instanceof Error && reason.name !== 'AbortError' && reason.message.length > 0
      ? reason.message
      : 'Context rebuild was cancelled.';
    throw new Error2(ErrorCodes.REQUEST_INVALID, message);
  }
}

function compactionTrigger(task: FullCompactionTask): Exclude<ContextRebuildTrigger, 'manual'> {
  if (task.committedStrategy === 'relay') return 'fresh_start';
  if (task.committedStrategy === 'summarize') return 'summary';
  return 'compaction';
}

function contextWindowTrigger(receipt: ModelSwitchReceipt): 'model_switch_fresh' | 'model_switch_compact' | undefined {
  if (receipt.state !== 'completed') return undefined;
  if (receipt.mode === 'fresh') return 'model_switch_fresh';
  if (receipt.mode === 'compact') return 'model_switch_compact';
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

function snapshotProfile(data: ReturnType<IAgentProfileService['data']>): ReturnType<IAgentProfileService['data']> {
  return {
    ...data,
    systemPrompt: data.systemPrompt,
    profileName: data.profileName,
    modelAlias: data.modelAlias,
    thinkingLevel: data.thinkingLevel,
    boundProfile: data.boundProfile === undefined ? undefined : JSON.parse(JSON.stringify(data.boundProfile)) as typeof data.boundProfile,
  };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextRebuildService,
  AgentContextRebuildService,
  ScopeActivation.OnScopeCreated,
  'contextRebuild',
);
