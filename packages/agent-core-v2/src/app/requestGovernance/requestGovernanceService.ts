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

interface WaitingRequest {
  readonly attempt: RequestAttempt;
  readonly startedAt: number;
  readonly budgetAtStart: number;
  readonly signal?: AbortSignal;
  readonly resolve: (permit: RequestPermit) => void;
  readonly reject: (error: unknown) => void;
  readonly abort: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class RequestGovernanceService extends Disposable implements IRequestGovernance {
  declare readonly _serviceBrand: undefined;
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private readonly epoch = randomUUID();
  private seq = 0;
  private notificationScheduled = false;
  private readonly active = new Map<string, RequestAttempt>();
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

  async acquire(attempt: RequestAttempt, signal?: AbortSignal): Promise<RequestPermit> {
    signal?.throwIfAborted();
    if (this.closed) throw createAbortError();
    this.drain();
    signal?.throwIfAborted();
    const blocking = this.blocking(attempt);
    const rejecting = blocking.filter((rule) => rule.overflow === 'reject');
    if (rejecting.length > 0) throw this.failure('REQUEST_LIMIT_REJECTED', rejecting);
    if (blocking.length === 0) return this.admit(attempt);
    if (attempt.waitBudget.waitedMs >= this.waitLimit(attempt)) throw this.failure('REQUEST_QUEUE_TIMEOUT', blocking);
    if (this.waiting.length >= this.settings.maxQueueSize) throw this.failure('REQUEST_QUEUE_FULL', blocking);
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

  private matches(rule: RequestConcurrencyRule, attempt: RequestAttempt): boolean {
    return (rule.scope !== 'each_session' || attempt.sessionId !== undefined)
      && (rule.models === undefined || rule.models.includes(attempt.modelId))
      && (rule.providers === undefined || rule.providers.includes(attempt.providerId))
      && (!rule.subagentsOnly || attempt.parentAgentId !== undefined);
  }

  private blocking(attempt: RequestAttempt): RequestConcurrencyRule[] {
    return this.settings.rules.filter((rule) => {
      if (rule.maxConcurrent === undefined || !this.matches(rule, attempt)) return false;
      let count = 0;
      for (const active of this.active.values()) {
        if (this.matches(rule, active) && (rule.scope === 'global' || active.sessionId === attempt.sessionId)) count += 1;
      }
      return count >= rule.maxConcurrent;
    });
  }

  private waitLimit(attempt: RequestAttempt): number {
    return Math.min(this.settings.maxWaitMs, ...this.settings.rules.filter((rule) => this.matches(rule, attempt)).map((rule) => rule.maxWaitMs ?? Infinity));
  }

  private admit(attempt: RequestAttempt): RequestPermit {
    this.active.set(attempt.attemptId, attempt);
    this.emit();
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      this.active.delete(attempt.attemptId);
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
      if (this.elapsed(item) < this.waitLimit(item.attempt)) {
        this.armTimeout(item);
        return;
      }
      this.remove(item, this.failure('REQUEST_QUEUE_TIMEOUT', this.blocking(item.attempt)));
      this.drain();
    }, Math.min(2_147_483_647, Math.max(0, this.waitLimit(item.attempt) - this.elapsed(item))));
    item.timer.unref?.();
  }

  private drain(): void {
    for (const item of this.waiting.slice()) {
      if (item.signal?.aborted || this.closed) {
        this.remove(item, item.signal?.reason ?? createAbortError());
        continue;
      }
      const blocking = this.blocking(item.attempt);
      if (this.elapsed(item) >= this.waitLimit(item.attempt)) {
        this.remove(item, this.failure('REQUEST_QUEUE_TIMEOUT', blocking));
      } else if (blocking.some((rule) => rule.overflow === 'reject')) {
        this.remove(item, this.failure('REQUEST_LIMIT_REJECTED', blocking));
      } else if (blocking.length === 0) {
        this.detach(item);
        item.resolve(this.admit(item.attempt));
      } else {
        this.armTimeout(item);
      }
    }
  }

  private failure(code: keyof typeof RequestGovernanceErrors.codes, rules: readonly RequestConcurrencyRule[]): Error2 {
    const messages = {
      REQUEST_LIMIT_REJECTED: 'Local model request concurrency limit reached.',
      REQUEST_QUEUE_TIMEOUT: 'Local model request waiting budget exhausted.',
      REQUEST_QUEUE_FULL: 'Local model request queue is full.',
    };
    return new Error2(RequestGovernanceErrors.codes[code], messages[code], { details: { rules: rules.map((rule) => rule.id) } });
  }

  private emit(): void {
    this.seq += 1;
    if (this.notificationScheduled) return;
    this.notificationScheduled = true;
    queueMicrotask(() => {
      this.notificationScheduled = false;
      if (!this.closed) this.changed.fire();
    });
  }

  snapshot(): RequestGovernanceSnapshot {
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
    for (const attempt of this.active.values()) add(attempt, 'active');
    for (const item of this.waiting) add(item.attempt, 'queued');
    return {
      domainId: 'this-service', runtimeEpoch: this.epoch, seq: this.seq, asOf: new Date().toISOString(),
      coverage: { native: 'managed', external: 'unmanaged' },
      active: this.active.size, queued: this.waiting.length,
      dimensions: [...dimensions.values()], rules: this.settings.rules.map((rule) => ({ ...rule, models: rule.models?.slice(), providers: rule.providers?.slice() })),
      waiting: this.waiting.slice(0, 100).map((item) => ({
        attemptId: item.attempt.attemptId, sessionId: item.attempt.sessionId, agentId: item.attempt.agentId,
        modelId: item.attempt.modelId, providerId: item.attempt.providerId, purpose: item.attempt.purpose,
        waitedMs: this.elapsed(item), blockingRules: this.blocking(item.attempt).map((rule) => rule.id),
      })),
    };
  }

  override dispose(): void {
    this.closed = true;
    this.drain();
    super.dispose();
  }
}

registerScopedService(LifecycleScope.App, IRequestGovernance, RequestGovernanceService, ScopeActivation.OnScopeCreated, 'requestGovernance');
