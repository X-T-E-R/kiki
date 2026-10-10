import { randomUUID } from 'node:crypto';
import { Disposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { Error2 } from '#/_base/errors/errors';
import { createAbortError } from '#/kosong/contract/errors';
import type { RequestAttempt, RequestPermit } from '#/kosong/model/requestAdmission';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { REQUEST_GOVERNANCE_SECTION, RequestGovernanceConfigSchema, type RequestConcurrencyRule, type RequestGovernanceConfig } from './configSection';
import { RequestGovernanceErrors } from './errors';
import { IRequestGovernance, type RequestGovernanceSnapshot } from './requestGovernance';
import type { AgentExecutionAttempt, AgentActivitySnapshot, AgentActivityCounts, AgentActivityDimension } from './agentActivity';

type AdmissionAttempt = RequestAttempt | (AgentExecutionAttempt & { readonly attemptId: string; readonly purpose: 'agent_execution'; readonly waitBudget: { waitedMs: number } });
interface ActiveAdmission { readonly attempt: AdmissionAttempt; references: number; readonly startedAt: string }
interface WaitingRequest {
  readonly attempt: AdmissionAttempt;
  readonly startedAt: number;
  readonly budgetAtStart: number;
  readonly signal?: AbortSignal;
  readonly resolve: (permit: RequestPermit) => void;
  readonly reject: (error: unknown) => void;
  readonly abort: () => void;
  timer?: ReturnType<typeof setTimeout>;
}
function isAgent(attempt: AdmissionAttempt): attempt is Extract<AdmissionAttempt, AgentExecutionAttempt> {
  return 'ancestorAgentIds' in attempt;
}
function counts(): AgentActivityCounts {
  return { active: 0, queued: 0, main: 0, subagent: 0, independent: 0, queuedMain: 0, queuedSubagent: 0, queuedIndependent: 0 };
}

export class RequestGovernanceService extends Disposable implements IRequestGovernance {
  declare readonly _serviceBrand: undefined;
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private readonly epoch = randomUUID();
  private seq = 0;
  private notificationScheduled = false;
  private readonly active = new Map<string, ActiveAdmission>();
  private readonly waiting: WaitingRequest[] = [];
  private settings: RequestGovernanceConfig;
  private closed = false;

  constructor(@IConfigService private readonly config: IConfigService) {
    super();
    this.settings = this.readSettings();
    this._register(config.onDidSectionChange((event) => {
      if (event.domain !== REQUEST_GOVERNANCE_SECTION) return;
      this.settings = this.readSettings();
      this.drain();
      this.emit();
    }));
  }

  private readSettings(): RequestGovernanceConfig {
    return RequestGovernanceConfigSchema.parse(this.config.get(REQUEST_GOVERNANCE_SECTION) ?? {});
  }

  acquire(attempt: RequestAttempt, signal?: AbortSignal): Promise<RequestPermit> {
    return this.acquireAttempt(attempt, signal);
  }

  acquireAgent(attempt: AgentExecutionAttempt, signal?: AbortSignal): Promise<RequestPermit> {
    return this.acquireAttempt({ ...attempt, attemptId: `agent:${JSON.stringify([attempt.sessionId, attempt.agentId])}`, purpose: 'agent_execution', waitBudget: { waitedMs: 0 } }, signal);
  }

  private async acquireAttempt(attempt: AdmissionAttempt, signal?: AbortSignal): Promise<RequestPermit> {
    signal?.throwIfAborted();
    if (this.closed) throw createAbortError();
    this.drain();
    signal?.throwIfAborted();
    if (isAgent(attempt) && this.active.has(attempt.attemptId)) return this.admit(attempt);
    const blocking = this.blocking(attempt);
    const ancestorFailure = this.ancestorFailure(attempt, blocking);
    if (ancestorFailure !== undefined) throw ancestorFailure;
    const rejecting = blocking.filter((rule) => rule.overflow === 'reject');
    if (rejecting.length > 0) throw this.failure('REQUEST_LIMIT_REJECTED', rejecting, attempt);
    if (blocking.length === 0) return this.admit(attempt);
    if (attempt.waitBudget.waitedMs >= this.waitLimit(attempt)) throw this.failure('REQUEST_QUEUE_TIMEOUT', blocking, attempt);
    if (this.waiting.length >= this.settings.maxQueueSize) throw this.failure('REQUEST_QUEUE_FULL', blocking, attempt);
    return new Promise<RequestPermit>((resolve, reject) => {
      const item: WaitingRequest = {
        attempt, signal, resolve, reject,
        startedAt: performance.now(), budgetAtStart: attempt.waitBudget.waitedMs,
        abort: () => { this.remove(item, signal?.reason ?? createAbortError()); this.drain(); },
      };
      this.waiting.push(item);
      signal?.addEventListener('abort', item.abort, { once: true });
      this.armTimeout(item);
      this.emit();
    });
  }

  private matches(rule: RequestConcurrencyRule, attempt: AdmissionAttempt): boolean {
    if (rule.resource !== (isAgent(attempt) ? 'agent_execution' : 'model_request')) return false;
    return (rule.scope !== 'each_session' || attempt.sessionId !== undefined)
      && (rule.models === undefined || (attempt.modelId !== undefined && rule.models.includes(attempt.modelId)))
      && (rule.providers === undefined || (attempt.providerId !== undefined && rule.providers.includes(attempt.providerId)))
      && (!rule.subagentsOnly || (isAgent(attempt) ? attempt.role === 'subagent' : attempt.parentAgentId !== undefined))
      && (rule.executors === undefined || (isAgent(attempt) && attempt.executorId !== undefined && rule.executors.includes(attempt.executorId)))
      && (rule.profiles === undefined || (isAgent(attempt) && attempt.profileId !== undefined && rule.profiles.includes(attempt.profileId)))
      && (rule.roles === undefined || (isAgent(attempt) && rule.roles.includes(attempt.role)));
  }

  private occupants(rule: RequestConcurrencyRule, attempt: AdmissionAttempt): ActiveAdmission[] {
    return [...this.active.values()].filter((entry) => this.matches(rule, entry.attempt) && (rule.scope === 'global' || entry.attempt.sessionId === attempt.sessionId));
  }

  private blocking(attempt: AdmissionAttempt): RequestConcurrencyRule[] {
    if (isAgent(attempt) && this.active.has(attempt.attemptId)) return [];
    return this.settings.rules.filter((rule) => rule.enabled && rule.maxConcurrent !== undefined && this.matches(rule, attempt) && this.occupants(rule, attempt).length >= rule.maxConcurrent);
  }

  private ancestorFailure(attempt: AdmissionAttempt, blocking: readonly RequestConcurrencyRule[]): Error2 | undefined {
    if (!isAgent(attempt)) return undefined;
    const ancestors = blocking.flatMap((rule) => this.occupants(rule, attempt).flatMap(({ attempt: active }) =>
      active.sessionId === attempt.sessionId && active.agentId !== undefined && attempt.ancestorAgentIds.includes(active.agentId)
        ? [{ ruleId: rule.id, sessionId: active.sessionId, agentId: active.agentId }] : []));
    if (ancestors.length === 0) return undefined;
    return new Error2(RequestGovernanceErrors.codes.AGENT_ANCESTOR_LIMIT, 'A running parent occupies the agent limit needed by this child. Select subagents only, separate main and subagent rules, or increase this rule’s limit.', {
      details: { resource: 'agent_execution', rules: [...new Set(ancestors.map((item) => item.ruleId))], occupyingAncestors: ancestors, action: 'separate_main_subagent_rules_or_raise_limit' },
    });
  }

  private waitLimit(attempt: AdmissionAttempt): number {
    return Math.min(this.settings.maxWaitMs, ...this.settings.rules.filter((rule) => rule.enabled && this.matches(rule, attempt)).map((rule) => rule.maxWaitMs ?? Infinity));
  }

  private admit(attempt: AdmissionAttempt): RequestPermit {
    const entry = this.active.get(attempt.attemptId) ?? { attempt, references: 0, startedAt: new Date().toISOString() };
    entry.references += 1;
    this.active.set(attempt.attemptId, entry);
    this.emit();
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      if (this.active.get(attempt.attemptId) !== entry) return;
      entry.references -= 1;
      if (entry.references === 0) this.active.delete(attempt.attemptId);
      this.drain();
      this.emit();
    } };
  }

  private elapsed(item: WaitingRequest): number {
    return item.budgetAtStart + Math.max(0, performance.now() - item.startedAt);
  }

  private detach(item: WaitingRequest): void {
    this.waiting.splice(this.waiting.indexOf(item), 1);
    clearTimeout(item.timer);
    item.signal?.removeEventListener('abort', item.abort);
    item.attempt.waitBudget.waitedMs = this.elapsed(item);
  }

  private remove(item: WaitingRequest, error: unknown): void {
    if (!this.waiting.includes(item)) return;
    this.detach(item);
    item.reject(error);
    this.emit();
  }

  private armTimeout(item: WaitingRequest): void {
    clearTimeout(item.timer);
    item.timer = setTimeout(() => {
      if (this.elapsed(item) < this.waitLimit(item.attempt)) { this.armTimeout(item); return; }
      this.remove(item, this.failure('REQUEST_QUEUE_TIMEOUT', this.blocking(item.attempt), item.attempt));
      this.drain();
    }, Math.min(2_147_483_647, Math.max(0, this.waitLimit(item.attempt) - this.elapsed(item))));
    item.timer.unref?.();
  }

  private drain(): void {
    for (const item of this.waiting.slice()) {
      if (item.signal?.aborted || this.closed) { this.remove(item, item.signal?.reason ?? createAbortError()); continue; }
      const blocking = this.blocking(item.attempt);
      const ancestorFailure = this.ancestorFailure(item.attempt, blocking);
      if (ancestorFailure !== undefined) {
        this.remove(item, ancestorFailure);
      } else if (this.elapsed(item) >= this.waitLimit(item.attempt)) {
        this.remove(item, this.failure('REQUEST_QUEUE_TIMEOUT', blocking, item.attempt));
      } else if (blocking.some((rule) => rule.overflow === 'reject')) {
        this.remove(item, this.failure('REQUEST_LIMIT_REJECTED', blocking, item.attempt));
      } else if (blocking.length === 0) {
        this.detach(item);
        item.resolve(this.admit(item.attempt));
      } else {
        this.armTimeout(item);
      }
    }
  }

  private failure(code: 'REQUEST_LIMIT_REJECTED' | 'REQUEST_QUEUE_TIMEOUT' | 'REQUEST_QUEUE_FULL', rules: readonly RequestConcurrencyRule[], attempt: AdmissionAttempt): Error2 {
    const resource = isAgent(attempt) ? 'agent_execution' : 'model_request';
    const messages = {
      REQUEST_LIMIT_REJECTED: `Local ${resource} concurrency limit reached.`,
      REQUEST_QUEUE_TIMEOUT: `Local ${resource} waiting budget exhausted.`,
      REQUEST_QUEUE_FULL: `Local ${resource} queue is full.`,
    };
    return new Error2(RequestGovernanceErrors.codes[code], messages[code], { details: { resource, rules: rules.map((rule) => rule.id) } });
  }

  private emit(): void {
    this.seq += 1;
    if (this.notificationScheduled) return;
    this.notificationScheduled = true;
    queueMicrotask(() => { this.notificationScheduled = false; if (!this.closed) this.changed.fire(); });
  }

  snapshot(): RequestGovernanceSnapshot {
    const active = [...this.active.values()].map((entry) => entry.attempt).filter((attempt): attempt is RequestAttempt => !isAgent(attempt));
    const waiting = this.waiting.filter((item): item is WaitingRequest & { attempt: RequestAttempt } => !isAgent(item.attempt));
    const dimensions = new Map<string, { dimension: 'model' | 'provider' | 'session' | 'role'; id: string; active: number; queued: number }>();
    const add = (attempt: RequestAttempt, kind: 'active' | 'queued'): void => {
      const values = [['model', attempt.modelId], ['provider', attempt.providerId], ['session', attempt.sessionId ?? 'system'], ['role', attempt.parentAgentId === undefined ? 'root/system' : 'subagent']] as const;
      for (const [dimension, id] of values) {
        const key = `${dimension}\0${id}`;
        const row = dimensions.get(key) ?? { dimension, id, active: 0, queued: 0 };
        row[kind] += 1;
        dimensions.set(key, row);
      }
    };
    for (const attempt of active) add(attempt, 'active');
    for (const item of waiting) add(item.attempt, 'queued');
    return {
      domainId: 'this-service', runtimeEpoch: this.epoch, seq: this.seq, asOf: new Date().toISOString(),
      coverage: { native: 'managed', external: 'unmanaged' }, active: active.length, queued: waiting.length,
      dimensions: [...dimensions.values()], rules: this.settings.rules.map((rule) => structuredClone(rule)),
      waiting: waiting.slice(0, 100).map((item) => ({
        attemptId: item.attempt.attemptId, sessionId: item.attempt.sessionId, agentId: item.attempt.agentId,
        modelId: item.attempt.modelId, providerId: item.attempt.providerId, purpose: item.attempt.purpose,
        waitedMs: this.elapsed(item), blockingRules: this.blocking(item.attempt).map((rule) => rule.id),
      })),
    };
  }

  agentSnapshot(): AgentActivitySnapshot {
    const active = [...this.active.values()].filter((entry): entry is ActiveAdmission & { attempt: Extract<AdmissionAttempt, AgentExecutionAttempt> } => isAgent(entry.attempt));
    const waiting = [...new Map(this.waiting.filter((item) => isAgent(item.attempt)).map((item) => [item.attempt.attemptId, item])).values()];
    const dimensions = new Map<string, AgentActivityCounts & { dimension: AgentActivityDimension; id: string | null }>();
    const total = counts();
    const increment = (target: AgentActivityCounts, attempt: AgentExecutionAttempt, queued: boolean): AgentActivityCounts => ({
      ...target, active: target.active + (queued ? 0 : 1), queued: target.queued + (queued ? 1 : 0),
      main: target.main + (!queued && attempt.role === 'main' ? 1 : 0),
      subagent: target.subagent + (!queued && attempt.role === 'subagent' ? 1 : 0),
      independent: target.independent + (!queued && attempt.role === 'independent' ? 1 : 0),
      queuedMain: target.queuedMain + (queued && attempt.role === 'main' ? 1 : 0),
      queuedSubagent: target.queuedSubagent + (queued && attempt.role === 'subagent' ? 1 : 0),
      queuedIndependent: target.queuedIndependent + (queued && attempt.role === 'independent' ? 1 : 0),
    });
    const add = (attempt: AgentExecutionAttempt, queued: boolean): void => {
      Object.assign(total, increment(total, attempt, queued));
      const values: readonly [AgentActivityDimension, string | null][] = [['executor', attempt.executorId ?? null], ['profile', attempt.profileId ?? null], ['model', attempt.modelId ?? null], ['role', attempt.role], ['session', attempt.sessionId]];
      for (const [dimension, id] of values) {
        const key = JSON.stringify([dimension, id]);
        dimensions.set(key, { ...increment(dimensions.get(key) ?? counts(), attempt, queued), dimension, id });
      }
    };
    active.forEach(({ attempt }) => add(attempt, false));
    waiting.forEach(({ attempt }) => { if (isAgent(attempt)) add(attempt, true); });
    return {
      ...total, domainId: 'this-service', runtimeEpoch: this.epoch, seq: this.seq, asOf: new Date().toISOString(), coverage: 'this_process', unit: 'agent_execution',
      dimensions: [...dimensions.values()],
      agents: active.map(({ attempt, startedAt }) => ({
        sessionId: attempt.sessionId, agentId: attempt.agentId, parentAgentId: attempt.parentAgentId,
        executorId: attempt.executorId, profileId: attempt.profileId, modelId: attempt.modelId, providerId: attempt.providerId,
        role: attempt.role, phase: attempt.readPhase(), startedAt,
      })),
      waiting: waiting.slice(0, 100).flatMap((item) => isAgent(item.attempt) ? [{
        sessionId: item.attempt.sessionId, agentId: item.attempt.agentId, executorId: item.attempt.executorId,
        profileId: item.attempt.profileId, modelId: item.attempt.modelId, role: item.attempt.role,
        waitedMs: this.elapsed(item), blockingRules: this.blocking(item.attempt).map((rule) => rule.id),
      }] : []),
      rules: this.settings.rules.map((rule) => structuredClone(rule)),
    };
  }

  override dispose(): void {
    this.closed = true;
    this.drain();
    this.active.clear();
    super.dispose();
  }
}

registerScopedService(LifecycleScope.App, IRequestGovernance, RequestGovernanceService, ScopeActivation.OnScopeCreated, 'requestGovernance');
