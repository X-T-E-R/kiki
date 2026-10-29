import { memoryAdvisorFirstStepWaitMs, type MemoryAdvisorFailure, type MemoryAdvisorStatus } from '@kiki/protocol';
import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { abortable } from '#/_base/utils/abort';
import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentLoopService, type BeforeStepContext } from '#/agent/loop/loop';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ConfigUpdate } from '#/agent/profile/profileOps';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentUsageService } from '#/agent/usage/usage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IModelService } from '#/kosong/model/model';
import {
  assertRoleBindingConstraints,
  roleModelAllowed,
} from '#/session/subagent/modelConstraints';
import { IModelCatalog } from '#/kosong/model/catalog';
import { ILogService } from '#/_base/log/log';
import { MEMORY_SECTION, memoryEnabled, type MemoryConfig } from './configSection';
import { IAgentMemorySnapshot } from './memorySnapshot';
import { IMemoryStore, memoryApplicability } from './memoryStore';
import {
  IMemorySelector,
  selectorFailure,
  selectorStats,
  selectorThinkingEffort,
} from './memorySelector';
import { runMemoryAdvice } from './memoryAdvisorCatalog';
import { advisorStatus, memoryAdviceKey, type MemoryAdvice } from './memoryAdvisorTypes';
import { renderMemoryWorkingSet } from './memoryContext';
import { redactMemorySecrets } from './memorySafety';

export interface IAgentMemoryAdvisor {
  readonly _serviceBrand: undefined;
  status(): MemoryAdvisorStatus;
}
export const IAgentMemoryAdvisor = createDecorator<IAgentMemoryAdvisor>('agentMemoryAdvisor');
export class AgentMemoryAdvisor extends Service implements IAgentMemoryAdvisor {
  declare readonly _serviceBrand: undefined;
  private controller?: AbortController;
  private pending?: Promise<void>;
  private completed?: MemoryAdvice;
  private fingerprint = '';
  private currentStatus = advisorStatus('unconfigured');
  private turnId?: number;
  private calls = 0;
  private toolEvent = '';
  private readonly toolErrors = new Set<string>();
  private failures = 0;
  private failureReason?: MemoryAdvisorFailure;
  private backoffUntil = 0;
  private disposed = false;
  private epoch = 0;
  constructor(
    @IConfigService private readonly memoryConfig: IConfigService,
    @IAgentLoopService loop: IAgentLoopService,
    @IAgentContextInjectorService _injector: IAgentContextInjectorService,
    @IAgentToolExecutorService tools: IAgentToolExecutorService,
    @IAgentMemorySnapshot private readonly snapshot: IAgentMemorySnapshot,
    @IMemoryStore private readonly store: IMemoryStore,
    @IMemorySelector private readonly selector: IMemorySelector,
    @IOptionalCapabilityPolicy private readonly policy: IOptionalCapabilityPolicy,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelService private readonly models: IModelService,
    @IModelCatalog private readonly catalog: IModelCatalog,
    @IAgentUsageService private readonly usage: IAgentUsageService,
    @IEventBus events: IEventBus,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(
      loop.hooks.onWillBeginStep.register(
        'memory-advisor',
        async (context, next) => {
          try {
            await this.beforeStep(context);
          } catch (error) {
            this.cancel();
            this.currentStatus = advisorStatus('failed', { reason: selectorFailure(error) });
          }
          await next();
        },
        { before: 'context-injector' },
      ),
    );
    this._register(
      tools.hooks.onDidExecuteTool.register('memory-advisor', async (context, next) => {
        if (
          context.result.isError === true &&
          context.outcome !== 'aborted' &&
          this.toolErrors.size < 10
        ) {
          const output = context.result.output;
          const text =
            typeof output === 'string'
              ? output
              : Array.isArray(output)
              ? output.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
              : '';
          const event = redactMemorySecrets(`${context.toolCall.name}: ${text.slice(0, 600)}`);
          if (!this.toolErrors.has(event)) {
            this.toolErrors.add(event);
            this.toolEvent = event;
          }
        }
        await next();
      }),
    );
    this._register(
      memoryConfig.onDidChangeConfiguration((event) => {
        if ([MEMORY_SECTION, 'models', 'providers'].includes(event.domain)) this.reset();
      }),
    );
    this._register(
      policy.onDidChange((event) => {
        if (event.sessionId === undefined || event.sessionId === this.session.sessionId)
          this.reset();
      }),
    );
    this._register(events.subscribe(ConfigUpdate, () => this.reset()));
    this._register(
      toDisposable(() => {
        this.disposed = true;
        this.cancel();
      }),
    );
  }
  private cancel(): void {
    this.controller?.abort('aborted');
    this.controller = undefined;
    this.pending = undefined;
    this.completed = undefined;
    this.snapshot.setAdvice?.(undefined);
  }
  private reset(): void {
    this.epoch++;
    this.cancel();
    this.fingerprint = '';
    this.failures = 0;
    this.failureReason = undefined;
    this.backoffUntil = 0;
    this.currentStatus = advisorStatus('unconfigured');
  }
  private permitted(model: string, protocol: string): boolean {
    const data = this.profile.data();
    if (
      data.driver === 'external' ||
      (data.executorId !== undefined && data.executorId !== 'native')
    )
      return false;
    const constraints = [data.boundProfile, data.appliedLease, data.spawnPolicy];
    if (!constraints.every((constraint) => roleModelAllowed(model, constraint, this.models)))
      return false;
    if (protocol !== 'chat_json') return true;
    try {
      const thinking = selectorThinkingEffort(this.catalog.get(model));
      for (const constraint of constraints)
        assertRoleBindingConstraints({
          model,
          thinking,
          constraints: constraint,
          models: this.models,
          ruleSource: 'memory.advisor',
          modelValueSource: 'runtime-explicit',
        });
      return true;
    } catch {
      return false;
    }
  }
  private async beforeStep(context: BeforeStepContext): Promise<void> {
    const epoch = this.epoch;
    const settings = this.memoryConfig.get<MemoryConfig>(MEMORY_SECTION);
    const config = settings?.advisor;
    if (!memoryEnabled(settings, this.session.workspaceId) || settings.budget === 0) {
      this.cancel();
      this.currentStatus = advisorStatus('disabled');
      return;
    }
    if (config?.mode === 'off') {
      this.cancel();
      this.currentStatus = advisorStatus('off');
      return;
    }
    if (config === undefined || (config.source === undefined && config.selector === undefined)) {
      this.cancel();
      this.currentStatus = advisorStatus('unconfigured', { reason: 'unconfigured' });
      return;
    }
    if (this.agent.agentId !== 'main' && !config.apply_to_children) {
      this.cancel();
      this.currentStatus = advisorStatus('disabled');
      return;
    }
    const described = this.selector.describe(config, this.session.workspaceId);
    if (described.state === 'failed') {
      this.cancel();
      this.currentStatus = { ...described, state: 'failed' };
      return;
    }
    await this.policy.load(this.session.sessionId);
    if (this.disposed || epoch !== this.epoch) return;
    if (
      !this.policy.admit('memory', {
        sessionId: this.session.sessionId,
        workspaceId: this.session.workspaceId,
        agentId: this.agent.agentId,
      }).admitted ||
      !this.permitted(config.source?.kind === 'connection' ? `connection:${config.source.connection}/${described.model ?? ''}` : config.source?.model ?? config.selector!.model, described.protocol ?? config.selector?.protocol ?? 'chat_json')
    ) {
      this.cancel();
      this.currentStatus = { ...described, state: 'failed', reason: 'not_permitted' };
      return;
    }
    await this.store.prepare?.();
    if (this.disposed || epoch !== this.epoch) return;
    if (this.store.snapshot === undefined) {
      this.cancel();
      this.currentStatus = advisorStatus('unsupported_store', { reason: 'unsupported_store' });
      return;
    }
    await (this.snapshot.refreshView?.() ?? this.snapshot.refreshIfDirty());
    if (this.disposed || epoch !== this.epoch) return;
    const view = this.snapshot.projectionView;
    if (view === undefined) return;
    if (this.turnId !== context.turnId) {
      this.turnId = context.turnId;
      this.calls = 0;
      this.toolErrors.clear();
      this.toolEvent = '';
    }
    const query = [this.snapshot.advisorRequest, this.toolEvent].filter(Boolean).join('\n');
    if (query.trim() === '') return;
    const fingerprint = JSON.stringify([
      query,
      this.snapshot.advisorRequestIdentity,
      config,
      view.scopes,
      this.profile.data().boundProfile,
      described.destination,
    ]);
    if (fingerprint !== this.fingerprint) {
      this.cancel();
      this.fingerprint = fingerprint;
      if (
        this.calls >= config.max_calls_per_turn ||
        this.failures >= 3 ||
        Date.now() < this.backoffUntil
      ) {
        this.currentStatus = { ...described, state: 'limited', logical_calls: this.calls };
        return;
      }
      const controller = new AbortController();
      this.controller = controller;
      const timer = setTimeout(() => controller.abort('timeout'), config.timeout_ms);
      const stats = selectorStats();
      this.calls++;
      this.currentStatus = { ...described, state: 'pending', logical_calls: this.calls };
      const operation = runMemoryAdvice({
        config,
        view,
        query,
        fingerprint,
        selector: this.selector,
        store: this.store,
        signal: controller.signal,
        attribution: {
          sessionId: this.session.sessionId,
          agentId: this.agent.agentId,
          parentAgentId: this.agent.parentAgentId,
          purpose: 'memory_advice',
          logicalRequestId: crypto.randomUUID(),
          waitBudget: { waitedMs: 0 },
        },
        stats,
        status: this.currentStatus,
        record: (model, usage, usageKnown) =>
          this.usage.record(
            model.name,
            usage,
            { type: 'operation', requestKind: 'memory_advice' },
            { provider: model.providerName, modelAlias: model.id, usageKnown },
          ),
      });
      this.pending = abortable(operation, controller.signal)
        .then(
          (advice) => {
            if (
              !this.disposed &&
              !controller.signal.aborted &&
              this.controller === controller &&
              this.fingerprint === fingerprint
            ) {
              this.failures = 0;
              this.failureReason = undefined;
              this.backoffUntil = 0;
              this.completed = advice;
            }
          },
          (error: unknown) => {
            if (this.controller !== controller || this.disposed) return;
            const reason = selectorFailure(error, controller.signal);
            this.currentStatus = {
              ...described,
              state: 'failed',
              reason,
              logical_calls: this.calls,
              requests: stats.requests,
              retries: stats.retries,
            };
            if (['auth', 'protocol', 'capability_mismatch', 'not_permitted'].includes(reason)) {
              this.failures = this.failureReason === reason ? this.failures + 1 : 1;
              this.failureReason = reason;
            } else {
              this.failures = 0;
              this.failureReason = undefined;
            }
            if (reason === 'timeout' || reason === 'rate_limited')
              this.backoffUntil = Date.now() + 5_000;
            this.log.debug('memory advisor failed', {
              reason,
              requests: stats.requests,
              retries: stats.retries,
            });
          },
        )
        .finally(() => {
          clearTimeout(timer);
          if (this.controller === controller) this.pending = undefined;
        });
    }
    const wait = memoryAdvisorFirstStepWaitMs(config, described.protocol ?? config.selector?.protocol);
    if (context.firstStepOfTurn && this.pending !== undefined && wait > 0)
      await waitForAdvice(this.pending, wait, context.signal);
    if (this.completed !== undefined && this.completed.fingerprint === this.fingerprint) {
      this.snapshot.setAdvice?.(this.completed);
      this.currentStatus = this.completed.status;
    }
  }
  status(): MemoryAdvisorStatus {
    const configured = this.memoryConfig.get<MemoryConfig>(MEMORY_SECTION);
    if (!memoryEnabled(configured, this.session.workspaceId)) return advisorStatus('disabled');
    if (configured.advisor?.mode === 'off') return advisorStatus('off');
    if (configured.advisor === undefined || (configured.advisor.source === undefined && configured.advisor.selector === undefined))
      return advisorStatus('unconfigured', { reason: 'unconfigured' });
    if (this.completed === undefined)
      return this.currentStatus.state === 'unconfigured'
        ? this.selector.describe(configured.advisor, this.session.workspaceId)
        : this.currentStatus;
    const view = this.snapshot.projectionView;
    if (view === undefined) return this.currentStatus;
    const current = new Map(
      view.entries
        .filter((entry) => entry.status === 'active' && memoryApplicability(entry) !== 'expired')
        .map((entry) => [memoryAdviceKey(entry), entry]),
    );
    const items = this.completed.items.filter(
      (item) => current.get(item.key)?.revision === item.revision,
    );
    const count = items.filter((item) => item.use !== 'skip').length;
    const settings = this.memoryConfig.get<MemoryConfig>(MEMORY_SECTION);
    const baseline = renderMemoryWorkingSet(
      view,
      this.snapshot.advisorRequest ?? '',
      settings.budget,
      Math.min(1_000, settings.budget),
    );
    const delivered = new Set(view.workset?.entries.map(memoryAdviceKey));
    return {
      ...this.currentStatus,
      state: count === 0 ? 'none' : 'selected',
      recommended_count: count,
      enumeration:
        view.generation === this.completed.generation ? this.currentStatus.enumeration : 'partial',
      displaced_ids: baseline.entries
        .filter((entry) => !delivered.has(memoryAdviceKey(entry)))
        .map((entry) => entry.id),
      unjudged_count: current.size - items.length,
    };
  }
}
async function waitForAdvice(
  pending: Promise<void>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
        abort = () => resolve();
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort !== undefined) signal.removeEventListener('abort', abort);
  }
}
registerScopedService(
  LifecycleScope.Agent,
  IAgentMemoryAdvisor,
  AgentMemoryAdvisor,
  ScopeActivation.OnScopeCreated,
  'memory',
);
