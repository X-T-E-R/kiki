import { randomUUID } from 'node:crypto';

import { IInstantiationService, ref, type LiveRef } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentLoopService, type BeforeStepContext } from '#/agent/loop/loop';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IEventBus } from '#/app/event/eventBus';
import { IModelService } from '#/kosong/model/model';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IHookRulesSession, ISessionHookWorkspace } from '../session/hookRules';
import { hookHash, matchesHook, renderHookInjection, type EffectiveHookRule, type HookBinding, type HookEvent, type HookEventName, type HookRulesSnapshot } from '../internal/rules';
import { hookPartition, hookStateKey, HookRulesConfigured, HookStepPrepared, HookObserved, semanticRevision, type HookReceipt } from './hookState';
import { IAgentHookRules } from './hookRules';
import { IAgentExternalHooksService } from './agentExternalHooks';

export class AgentHookRules extends Service implements IAgentHookRules {
  declare readonly _serviceBrand: undefined;
  private readonly providers = this._register(new DisposableStore());
  private providerRevision = '';
  private stepEvent?: HookEvent;
  private stepInjectionActive = false;

  constructor(
    @IHookRulesSession private readonly rules: IHookRulesSession,
    @IAgentContextInjectorService private readonly injector: IAgentContextInjectorService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ISessionContext private readonly session: ISessionContext,
    @IModelService private readonly models: IModelService,
    @ILogService private readonly log: ILogService,
    @IEventBus bus: IEventBus,
    @IInstantiationService instantiation: IInstantiationService,
    @IAgentExternalHooksService _externalHooks: IAgentExternalHooksService,
    @ref(ISessionHookWorkspace) private readonly workspace: LiveRef<ISessionHookWorkspace>,
  ) {
    super();
    this.states.contributeState(hookStateKey);
    this._register(loop.hooks.onWillBeginStep.register('hook-rules', async (ctx, next) => {
      await this.beforeStep(ctx);
      this.stepInjectionActive = true;
      try { await next(); }
      finally { this.stepInjectionActive = false; }
    }, { before: 'context-injector' }));
    this._register(loop.hooks.onDidFinishStep.register('hook-rules', async (ctx, next) => {
      if (this.stepEvent !== undefined) {
        const clock = this.states.get(hookStateKey);
        const snapshot = this.rules.snapshot();
        const event = { ...this.stepEvent, configRevision: snapshot.revision, completedSteps: Object.values(clock.completed).reduce((a, b) => a + b, 0), stepInTurn: Object.values(clock.completedInTurn).reduce((a, b) => a + b, 0) };
        this.observe({ ...event, event: 'step.after', eventId: `${event.eventId}/after`, allowedActions: ['observe'], outcome: 'completed', usage: ctx.usage, finishReason: ctx.finishReason }, snapshot);
        if (ctx.finishReason !== 'tool_calls' && ctx.finishReason !== 'filtered' && !loop.hasPendingRequests() && !ctx.signal.aborted) {
          this.observe({ ...event, event: 'turn.stopping', eventId: `${event.eventId}/stopping`, allowedActions: ['observe'], finishReason: ctx.finishReason }, snapshot);
        }
      }
      await next();
    }, { before: 'externalHooks' }));
    this._register(bus.subscribe(TurnEnded, (event) => {
      void this.event('turn.after', `turn/${event.turnId}/after`, { turnId: event.turnId, outcome: event.reason }).then(({ event: hookEvent, snapshot }) => { this.observe(hookEvent, snapshot); });
    }));
    const prompt = instantiation.invokeFunction((accessor) => accessor.get(IAgentPromptService));
    this._register(prompt.hooks.onBeforeSubmitPrompt.register('hook-rules', async (ctx, next) => {
      await next();
      if (ctx.block) return;
      const origin = ctx.promptMessage.origin?.kind ?? 'user';
      const promptId = ctx.promptMessage.id ?? randomUUID();
      const { event, snapshot } = await this.event('prompt.submit', `prompt/${promptId}`, {
        promptId, source: ctx.isSteer ? 'steering' : origin === 'task' ? 'task' : origin === 'agent_message' || origin === 'peer_thread' ? 'mailbox' : origin === 'user' ? 'user' : undefined,
      });
      this.configure(snapshot);
      for (const rule of snapshot.rules) {
        const receipt = this.receipt(rule, event);
        if (receipt === undefined) continue;
        if (rule.rule.action.type === 'observe') this.observeRule(rule, event, receipt);
        else {
          try { this.reminders.appendSystemReminder(renderHookInjection(rule), { kind: 'injection', variant: `hook_rule/${rule.id}`, ownerPromptId: promptId, disclosure: receipt }); }
          catch (error) { this.log.error('hook prompt injection failed; skipping it', { hookId: rule.id, error }); }
        }
      }
    }));
    const tools = instantiation.invokeFunction((accessor) => accessor.get(IAgentToolExecutorService));
    this._register(tools.onBeforeExecuteTool(async (ctx) => {
      const { event, snapshot } = await this.event('tool.before', `tool/${ctx.toolCall.id}/before`, { turnId: ctx.turnId, tool: ctx.toolCall.name, toolCallId: ctx.toolCall.id });
      this.observe(event, snapshot);
    }));
    this._register(tools.hooks.onDidExecuteTool.register('hook-rules', async (ctx, next) => {
      const status = ctx.outcome === 'vetoed' ? 'denied' : ctx.outcome === 'aborted' ? 'cancelled' : ctx.result.isError ? 'error' : 'success';
      const { event, snapshot } = await this.event('tool.after', `tool/${ctx.toolCall.id}/after`, { turnId: ctx.turnId, tool: ctx.toolCall.name, toolCallId: ctx.toolCall.id, status });
      this.observe(event, snapshot);
      await next();
    }));
  }

  private binding(): HookBinding {
    const data = this.profile.data();
    return {
      modelAlias: data.modelAlias, modelId: data.modelAlias === undefined ? undefined : this.models.resolveId(data.modelAlias),
      profileId: data.profileDefinitionId ?? data.profileName, routeId: data.routeId,
      executorId: data.executorId ?? 'native', agentRole: this.agent.parentAgentId === undefined ? 'root' : 'subagent',
    };
  }

  private async event(name: HookEventName, eventId: string, fields: Partial<HookEvent> = {}): Promise<{ event: HookEvent; snapshot: HookRulesSnapshot }> {
    await this.rules.ready;
    const snapshot = this.rules.snapshot();
    const live = this.binding();
    const step = this.stepEvent;
    const binding: HookBinding = step !== undefined && (name === 'tool.before' || name === 'tool.after') ? {
      modelAlias: step.modelAlias, modelId: step.modelId, profileId: step.profileId, routeId: step.routeId, executorId: step.executorId, agentRole: step.agentRole,
    } : live;
    const event: HookEvent = {
      schemaVersion: 2, event: name, eventId, occurredAt: new Date().toISOString(),
      sessionId: this.session.sessionId, agentId: this.agent.agentId, parentAgentId: this.agent.parentAgentId,
      cwd: this.session.cwd, workspaceId: this.workspace.current?.runtime.identity.workspaceId,
      executionTarget: this.workspace.current?.runtime.identity.runtimeId,
      configRevision: snapshot.revision, bindingRevision: hookHash(binding),
      ...binding, hookDepth: 0, isReplay: false,
      allowedActions: name === 'step.before' || name === 'prompt.submit' ? ['inject', 'observe'] : ['observe'],
      ...fields,
    };
    return { event, snapshot };
  }

  private configure(snapshot: HookRulesSnapshot): void {
    const state = this.states.get(hookStateKey);
    if (snapshot.rules.length === Object.keys(state.rules).length && snapshot.rules.every((rule) => state.rules[rule.id]?.semanticHash === rule.semanticHash)) return;
    void this.dispatcher.dispatch(new HookRulesConfigured({ rules: snapshot.rules.map((rule) => ({ id: rule.id, semanticHash: rule.semanticHash, counterScope: rule.rule.cadence?.counterScope ?? 'agent' })) }));
  }

  private async beforeStep(ctx: BeforeStepContext): Promise<void> {
    const { event, snapshot } = await this.event('step.before', `step/${ctx.logicalStepId ?? `${ctx.turnId}/${ctx.step}`}`, {
      turnId: ctx.turnId, stepId: ctx.logicalStepId, engineStep: ctx.step, attempt: ctx.attempt,
    });
    this.configure(snapshot);
    const modelId = event.modelId ?? '';
    const state = this.states.get(hookStateKey);
    this.stepEvent = { ...event, completedSteps: Object.values(state.completed).reduce((a, b) => a + b, 0), stepInTurn: state.turnId === ctx.turnId ? Object.values(state.completedInTurn).reduce((a, b) => a + b, 1) : 1 };
    if (snapshot.rules.length > 0) {
      void this.dispatcher.dispatch(new HookStepPrepared({
        stepId: ctx.stepId ?? `${ctx.turnId}/${ctx.step}`, logicalStepId: ctx.logicalStepId ?? `${ctx.turnId}/${ctx.step}`, turnId: ctx.turnId, modelId,
        targets: snapshot.rules.filter((rule) => rule.rule.cadence !== undefined && matchesHook(rule, { ...event, event: rule.rule.event, outcome: rule.rule.event === 'step.after' ? 'completed' : undefined })).map((rule) => ({ id: rule.id, semanticRevision: semanticRevision(this.states.get(hookStateKey).rules[rule.id]!), partition: hookPartition(modelId, ctx.turnId, rule.rule.cadence!.counterScope) })),
      }));
    }
    if (this.providerRevision !== snapshot.revision) {
      this.providers.clear();
      for (const rule of snapshot.rules.filter((entry) => entry.rule.event === 'step.before' && entry.rule.action.type === 'inject')) {
        this.providers.add(this.injector.register(`hook_rule/${rule.id}`, () => {
          const current = this.stepEvent;
          if (current === undefined || !this.stepInjectionActive) return undefined;
          const receipt = this.receipt(rule, current);
          return receipt === undefined ? undefined : { content: renderHookInjection(rule), disclosure: receipt };
        }));
      }
      this.providerRevision = snapshot.revision;
    }
    this.observe(this.stepEvent, snapshot);
  }

  private receipt(rule: EffectiveHookRule, event: HookEvent): HookReceipt | undefined {
    if (!matchesHook(rule, event)) return undefined;
    if (event.executorId !== undefined && event.executorId !== 'native' && ['step.before', 'step.after', 'tool.before', 'tool.after'].includes(event.event)) return undefined;
    const state = this.states.get(hookStateKey).rules[rule.id];
    if (state === undefined || state.semanticHash !== rule.semanticHash) return undefined;
    const cadence = rule.rule.cadence;
    const partition = hookPartition(event.modelId ?? '', event.turnId, cadence?.counterScope ?? 'agent');
    const bucket = state.buckets[partition];
    const milestone = cadence === undefined ? 0 : Math.floor((bucket?.completed ?? 0) / cadence.everyCompletedSteps) * cadence.everyCompletedSteps;
    if (cadence !== undefined && (milestone === 0 || milestone <= (bucket?.delivered ?? 0))) return undefined;
    if (cadence === undefined && bucket?.lastEventId === event.eventId) return undefined;
    const revision = semanticRevision(state);
    return {
      hookId: rule.id, semanticRevision: revision, partition, milestone, eventId: event.eventId,
      key: JSON.stringify([rule.id, revision, this.agent.agentId, partition, cadence === undefined ? event.eventId : milestone]),
    };
  }

  private observe(event: HookEvent, snapshot: HookRulesSnapshot): void {
    this.configure(snapshot);
    for (const rule of snapshot.rules) {
      if (rule.rule.action.type !== 'observe') continue;
      const receipt = this.receipt(rule, event);
      if (receipt !== undefined) this.observeRule(rule, event, receipt);
    }
  }

  private observeRule(rule: EffectiveHookRule, event: HookEvent, receipt: HookReceipt): void {
    void this.dispatcher.dispatch(new HookObserved(receipt));
    this.rules.observe(event, rule.id);
  }

  async inspect(): ReturnType<IAgentHookRules['inspect']> {
    await this.rules.ready;
    const snapshot = this.rules.snapshot();
    const binding = this.binding();
    const clock = this.states.get(hookStateKey);
    return { revision: snapshot.revision, sources: [...snapshot.sources ?? []], diagnostics: [...snapshot.diagnostics], binding: { ...binding, executorId: binding.executorId ?? 'native' }, rules: snapshot.rules.map((rule, order) => {
      const unsupported = binding.executorId !== 'native' && ['step.before', 'step.after', 'tool.before', 'tool.after'].includes(rule.rule.event);
      const cadence = rule.rule.cadence;
      const stored = clock.rules[rule.id];
      const state = stored?.semanticHash === rule.semanticHash ? stored : undefined;
      const bucket = state?.buckets[hookPartition(binding.modelId ?? '', clock.turnId, cadence?.counterScope ?? 'agent')];
      const reason = rule.reason ?? (unsupported ? 'unsupported_executor' : undefined);
      return { id: rule.id, path: rule.path, namespace: rule.namespace, event: rule.rule.event, action: { type: rule.rule.action.type }, active: rule.active && !unsupported, reason, order,
        resetPending: stored !== undefined && state === undefined,
        semanticRevision: state === undefined ? undefined : semanticRevision(state),
        completedSteps: bucket?.completed ?? 0,
        nextDue: cadence === undefined ? undefined : (Math.floor((bucket?.delivered ?? 0) / cadence.everyCompletedSteps) + 1) * cadence.everyCompletedSteps,
      };
    }) };
  }
}
