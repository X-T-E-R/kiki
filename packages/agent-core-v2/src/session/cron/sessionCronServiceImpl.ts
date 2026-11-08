import { ulid } from 'ulid';
import { cronTriggerSchema, type CronRunResult, type CronScriptExecution, type CronTrigger, type CronTriggerCheck } from '@kiki/protocol';

import { ILogService } from '#/_base/log/log';
import { IHostProcessService } from '#/os/interface/hostProcess';

import type { ContentPart } from '#/kosong/contract/message';
import type {
  ContextMessage,
  CronJobOrigin,
  CronMissedOrigin,
} from '#/agent/contextMemory/types';

import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { type IAgentScopeHandle, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';

import { IConfigService } from '#/app/config/config';
import type { CronDeletedEvent, CronScheduledEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { type ClockSources, resolveClockSources, SYSTEM_CLOCKS } from '#/app/cron/clock';
import { type CronConfig, CRON_SECTION, findCronScript, matchesCronScript } from '#/app/cron/configSection';
import { computeNextCronRun, parseCronExpression, type ParsedCronExpression } from '#/app/cron/cron-expr';
import { CRON_SESSION_TAG, cronScheduleBase, isConsumedOneShot, type CronTask, type CronTaskInit, type CronTaskPatch } from '#/app/cron/cronTask';
import { runCronScript, type CronScriptResult } from '#/app/cron/runCronScript';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { jitteredNextCronRunMs, oneShotJitteredNextCronRunMs } from '#/app/cron/jitter';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { Turn } from '#/agent/loop/loop';
import { BugIndicatingError, Error2, ErrorCodes } from '#/errors';

import '#/agent/tools/cron/cron-create/cronCreateTool';
import '#/agent/tools/cron/cron-list/cronListTool';
import '#/agent/tools/cron/cron-delete/cronDeleteTool';
import '#/agent/tools/cron/cronTool';
import { CronAdd, CronDelete, CronCursor, CronFired, cronKey } from './cronOps';
import { ISessionCronService, type CronLoadOptions } from './sessionCronService';

export const CRON_SCHEDULED = 'cron_scheduled' as const;
export const CRON_FIRED = 'cron_fired' as const;
export const CRON_MISSED = 'cron_missed' as const;
export const CRON_DELETED = 'cron_deleted' as const;

export const cronTasksKey = defineState<Map<string, CronTask>>('cron.tasks', () => new Map());
export const cronParsedCacheKey = defineState<Map<string, ParsedCronExpression>>(
  'cron.parsedCache',
  () => new Map(),
);
export const cronLastSeenAtKey = defineState<Map<string, number>>('cron.lastSeenAt', () => new Map());
export const cronSeededFromStoreKey = defineState<Set<string>>('cron.seededFromStore', () => new Set());
export const cronInFlightKey = defineState<Set<string>>('cron.inFlight', () => new Set());
export const cronStartedKey = defineState<boolean>('cron.started', () => false);

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_COALESCE_ITERATIONS = 10_000;
const CRON_ID_REGEX: RegExp = /^(?:[0-9a-f]{8}|[0-9A-HJKMNP-TV-Z]{26})$/i;
const MAX_ID_ATTEMPTS = 8;

type CronFire = { readonly coalescedCount: number; readonly firedAt: number };

function hasTrigger(task: CronTask): boolean {
  return task.trigger?.probability !== undefined || task.trigger?.script !== undefined;
}

export class SessionCronServiceImpl extends Disposable implements ISessionCronService {
  declare readonly _serviceBrand: undefined;

  private readonly persistQueues = new Map<string, Promise<void>>();
  private readonly activeChecks = new Map<string, { controller: AbortController; work: Promise<CronScriptResult> }>();
  private stopping = false;

  private clocks: ClockSources = SYSTEM_CLOCKS;
  readonly isEnabled: boolean = true;

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ICronTaskPersistence private readonly store: ICronTaskPersistence,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IConfigService private readonly config: IConfigService,
    @IHostProcessService private readonly processes: IHostProcessService,
    @ILogService private readonly log: ILogService,
  ) {
    super();

    this.states.contributeState(cronTasksKey);
    this.states.contributeState(cronParsedCacheKey);
    this.states.contributeState(cronLastSeenAtKey);
    this.states.contributeState(cronSeededFromStoreKey);
    this.states.contributeState(cronInFlightKey);
    this.states.contributeState(cronStartedKey);

    this._register(
      this.agentLifecycle.onWillCreate((handle) => {
        handle.accessor.get(IAgentStateService).contributeState(cronKey);
        if (handle.id !== 'main') return;
        this.bindMainAgent(handle);
      }),
    );

    for (const handle of this.agentLifecycle.list()) {
      handle.accessor.get(IAgentStateService).contributeState(cronKey);
    }
    const existingMain = this.agentLifecycle.get('main');
    if (existingMain) {
      this.bindMainAgent(existingMain);
    }

    this._register(this.config.onDidSectionChange((event) => {
      if (event.domain !== CRON_SECTION) return;
      for (const [id, { controller }] of this.activeChecks) {
        const task = this.tasks.get(id);
        const scriptId = task?.trigger?.script;
        if (this.isDisabled() || scriptId === undefined || !matchesCronScript(task?.approvedScript, this.getScriptExecution(scriptId))) {
          controller.abort('not_authorized');
        }
      }
    }));
    this._register(toDisposable(() => this.stop()));
  }

  private get tasks(): Map<string, CronTask> {
    return this.states.get(cronTasksKey);
  }

  private get parsedCache(): Map<string, ParsedCronExpression> {
    return this.states.get(cronParsedCacheKey);
  }

  private get lastSeenAt(): Map<string, number> {
    return this.states.get(cronLastSeenAtKey);
  }

  private get seededFromStore(): Set<string> {
    return this.states.get(cronSeededFromStoreKey);
  }

  private get inFlight(): Set<string> {
    return this.states.get(cronInFlightKey);
  }

  private get started(): boolean {
    return this.states.get(cronStartedKey);
  }

  private set started(value: boolean) {
    this.states.set(cronStartedKey, value);
  }

  private bindMainAgent(handle: IAgentScopeHandle): void {
    const dispatcher = handle.accessor.get(IEventDispatcher);
    const agentState = handle.accessor.get(IAgentStateService);
    this._register(
      dispatcher.hooks.onDidRestore.register('cron', async (_ctx, next) => {
        await this.config.ready;
        this.resolveClocks();
        this.tasks.clear();
        for (const [id, task] of agentState.get(cronKey)) {
          this.tasks.set(id, task as CronTask);
        }
        await this.loadFromStore({ replace: false });
        await this.start();
        await next();
      }),
    );

  }

  now(): number {
    return this.clocks.wallNow();
  }

  private resolveClocks(): void {
    const cfg = this.getCronConfig();
    this.clocks = resolveClockSources(cfg.clock, cfg.debug) ?? SYSTEM_CLOCKS;
  }

  private getCronConfig(): CronConfig {
    return this.config.get<CronConfig>(CRON_SECTION);
  }

  isDisabled(): boolean {
    return this.getCronConfig().disabled;
  }

  getScriptExecution(id: string): CronScriptExecution | undefined {
    return findCronScript(this.getCronConfig(), id, this.ctx.cwd);
  }

  private validateTrigger(trigger: CronTrigger | undefined, approved: CronScriptExecution | undefined): void {
    if (trigger !== undefined) cronTriggerSchema.parse(trigger);
    if (trigger?.script !== undefined && !matchesCronScript(approved, this.getScriptExecution(trigger.script))) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Approve the current script execution for this workspace before scheduling it.');
    }
  }

  async addTask(init: CronTaskInit): Promise<CronTask> {
    if (this.ctx.ephemeral === true) throw new Error('temporary sessions cannot schedule cron tasks');
    this.validateTrigger(init.trigger, init.approvedScript);
    const task: CronTask = {
      ...init,
      deliveryMode: init.deliveryMode ?? 'idle',
      id: this.generateUniqueId(),
      createdAt: this.clocks.wallNow(),
      tags: { ...init.tags, [CRON_SESSION_TAG]: this.ctx.sessionId },
    };
    await this.persistEnqueue(task.id, async () => {
      await this.store.save(this.ctx.workspaceId, task);
      this.tasks.set(task.id, task);
      this.dispatchCron(new CronAdd({ task }));
    });
    return task;
  }

  async removeTasks(ids: readonly string[]): Promise<readonly string[]> {
    if (this.ctx.ephemeral === true) throw new Error('temporary sessions cannot modify cron tasks');
    const results = await Promise.all([...new Set(ids)].map(async (id) => {
      let removed = false;
      await this.persistEnqueue(id, async () => {
        if (!this.tasks.has(id)) return;
        await this.store.delete(this.ctx.workspaceId, id);
        this.activeChecks.get(id)?.controller.abort('cancelled');
        const deleted = this.removeByIds([id]);
        this.dispatchCron(new CronDelete({ ids: deleted }));
        removed = deleted.length > 0;
      });
      return removed ? id : undefined;
    }));
    return results.filter((id): id is string => id !== undefined);
  }

  setTaskPaused(id: string, paused: boolean): Promise<CronTask | undefined> {
    return this.updateTask(id, { paused });
  }

  async updateTask(id: string, patch: CronTaskPatch): Promise<CronTask | undefined> {
    if (this.ctx.ephemeral === true) throw new Error('temporary sessions cannot modify cron tasks');
    if (patch.cron !== undefined) parseCronExpression(patch.cron);
    let updated: CronTask | undefined;
    await this.persistEnqueue(id, async () => {
      const existing = this.tasks.get(id);
      if (existing === undefined) return;
      updated = { ...existing, ...patch };
      if (patch.paused === false) this.validateTrigger(updated.trigger, updated.approvedScript);
      if (Object.hasOwn(patch, 'trigger') || Object.hasOwn(patch, 'approvedScript')) {
        this.validateTrigger(updated.trigger, updated.approvedScript);
        updated = { ...updated, lastTriggerCheck: undefined };
      }
      await this.store.save(this.ctx.workspaceId, updated);
      this.syncTask(updated, id);
    });
    return updated;
  }

  async syncTaskFromStore(id: string): Promise<void> {
    await this.persistEnqueue(id, async () => {
      this.syncTask(await this.store.get(this.ctx.workspaceId, id), id);
    });
  }

  private syncTask(task: CronTask | undefined, id: string): void {
    this.activeChecks.get(id)?.controller.abort('cancelled');
    if (task === undefined || task.tags?.[CRON_SESSION_TAG] !== this.ctx.sessionId) {
      this.removeByIds([id]);
      this.lastSeenAt.delete(id);
      this.seededFromStore.delete(id);
      this.dispatchCron(new CronDelete({ ids: [id] }));
      return;
    }
    this.tasks.set(id, task);
    this.dispatchCron(new CronAdd({ task }));
  }

  async fireTaskNow(id: string): Promise<CronRunResult | undefined> {
    const task = this.tasks.get(id);
    if (this.stopping || task === undefined || this.inFlight.has(id) || isConsumedOneShot(task)) return undefined;
    this.inFlight.add(id);
    try {
      const fire = { coalescedCount: 1, firedAt: this.clocks.wallNow() };
      if (hasTrigger(task)) return await this.deliverConditional(task, fire);
      return await this.deliverFire(task, fire) ? { triggered: true } : undefined;
    } finally {
      this.inFlight.delete(id);
    }
  }

  getTask(id: string): CronTask | undefined {
    return this.tasks.get(id);
  }

  list(): readonly CronTask[] {
    return Array.from(this.tasks.values());
  }

  isStale(task: CronTask): boolean {
    return this.isStaleAt(task, this.clocks.wallNow());
  }

  getNextFireTime(): number | null {
    if (this.tasks.size === 0) return null;
    let min: number | null = null;
    for (const task of this.tasks.values()) {
      const next = this.nextFireFor(task);
      if (next === null) continue;
      if (min === null || next < min) min = next;
    }
    return min;
  }

  getNextFireForTask(taskId: string): number | null {
    const task = this.tasks.get(taskId);
    if (task === undefined) return null;
    return this.nextFireFor(task);
  }

  async loadFromStore(options: CronLoadOptions = {}): Promise<void> {
    if (options.replace !== false) {
      this.tasks.clear();
    }
    const allTasks = await this.store.list({ workspaceId: this.ctx.workspaceId });
    for (const task of allTasks) {
      const owner = task.tags?.[CRON_SESSION_TAG];
      if (owner !== undefined && owner !== this.ctx.sessionId) continue;
      if (owner === undefined) {
        const claimed: CronTask = {
          ...task,
          tags: { ...task.tags, [CRON_SESSION_TAG]: this.ctx.sessionId },
        };
        await this.persistEnqueue(claimed.id, () =>
          this.store.save(this.ctx.workspaceId, claimed),
        );
        this.adopt(claimed);
        continue;
      }
      this.adopt(task);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.config.ready;
    this.stopping = false;
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const { controller } of this.activeChecks.values()) controller.abort('cancelled');
    await Promise.allSettled([...this.activeChecks.values()].map(({ work }) => work));
    this.inFlight.clear();
    this.lastSeenAt.clear();
    this.seededFromStore.clear();
    this.parsedCache.clear();
    await this.flushPersist();
    this.started = false;
  }

  async tick(): Promise<void> {
    await this.config.ready;
    if (this.stopping || this.getCronConfig().disabled || this.tasks.size === 0) return;

    const mainHandle = this.agentLifecycle.get('main');
    if (!mainHandle) return;

    const now = this.clocks.wallNow();

    const work: Promise<void>[] = [];
    for (const task of this.list().toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
      work.push(this.processDue(task, now));
    }
    await Promise.all(work);
  }

  private async processDue(task: CronTask, now: number): Promise<void> {
    if (task.paused === true || this.inFlight.has(task.id)) return;
    if (isConsumedOneShot(task)) {
      await this.removeTasks([task.id]);
      return;
    }

    let parsed: ParsedCronExpression;
    try {
      parsed = this.getParsed(task.cron);
    } catch (error) {
      this.debugLog(
        `tick failed to parse cron for task ${task.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    if (
      !this.seededFromStore.has(task.id) &&
      task.lastFiredAt !== undefined &&
      Number.isFinite(task.lastFiredAt) &&
      task.lastFiredAt <= now &&
      !this.lastSeenAt.has(task.id)
    ) {
      this.lastSeenAt.set(task.id, task.lastFiredAt);
    }
    this.seededFromStore.add(task.id);

    const seen = this.lastSeenAt.get(task.id);
    const baseFromMs = Math.max(cronScheduleBase(task, now), seen ?? task.createdAt);

    const nextFireAt = this.computeJitteredNext(task, parsed, baseFromMs);
    if (nextFireAt === null) return;
    if (now < nextFireAt) return;

    const ideal = computeNextCronRun(parsed, baseFromMs);
    let coalescedCount = 1;
    let lastDueMs: number | null = null;
    if (task.recurring !== false && ideal !== null) {
      const result = this.countCoalesced(task, parsed, ideal, now);
      coalescedCount = Math.max(1, result.count);
      lastDueMs = result.lastDueMs;
    }

    this.inFlight.add(task.id);
    try {
      const advancedTo = lastDueMs ?? ideal ?? now;
      if (hasTrigger(task)) {
        const claimed = await this.writeIfCurrent(task, { scheduleCursorAt: advancedTo, oneShotClaimed: task.recurring === false ? true : undefined });
        if (claimed === undefined || this.stopping) return;
        const fire = { coalescedCount, firedAt: this.clocks.wallNow() };
        const result = await this.deliverConditional(claimed, fire, advancedTo);
        const current = this.tasks.get(task.id);
        if (current?.paused !== true && current !== undefined && (isConsumedOneShot(current) ||
          (result !== undefined && this.isStaleAt(current, fire.firedAt)))) {
          const removed = await this.removeTasks([task.id]);
          if (removed.length > 0 && current.recurring !== false) this.emitDeleted(task.id);
        }
        return;
      }
      const delivered = await this.deliverDue(task, coalescedCount);
      if (!delivered) return;
      if (task.recurring === false) {
        await this.removeTasks([task.id]);
        this.lastSeenAt.delete(task.id);
        this.seededFromStore.delete(task.id);
      } else {
        this.lastSeenAt.set(task.id, advancedTo);
        await this.advanceCursor(task.id, advancedTo);
      }
    } finally {
      this.inFlight.delete(task.id);
    }
  }

  async flushPersist(): Promise<void> {
    const inFlight = Array.from(this.persistQueues.values());
    await Promise.all(inFlight);
  }

  handleMissed(
    tasks: readonly CronTask[],
    renderMissedNotification: (tasks: readonly CronTask[]) => readonly ContentPart[],
  ): Turn | undefined {
    if (tasks.length === 0) return undefined;

    const mainHandle = this.agentLifecycle.get('main');
    if (!mainHandle) return undefined;

    const promptService = mainHandle.accessor.get(IAgentPromptService);

    const origin: CronMissedOrigin = {
      kind: 'cron_missed',
      count: tasks.length,
    };
    const message: ContextMessage = {
      role: 'user',
      content: [...renderMissedNotification(tasks)],
      toolCalls: [],
      origin,
    };
    void promptService.enqueue({ message }).catch(() => {});
    this.telemetry.track2(CRON_MISSED, { count: tasks.length });
    return undefined;
  }

  emitScheduled(task: CronTask, agentId?: string): void {
    const properties: CronScheduledEvent = {
      recurring: task.recurring !== false,
      agent_id: agentId,
    };
    this.telemetry.track2(CRON_SCHEDULED, properties);
  }

  emitDeleted(taskId: string, agentId?: string): void {
    const properties: CronDeletedEvent = { task_id: taskId, agent_id: agentId };
    this.telemetry.track2(CRON_DELETED, properties);
  }

  private async deliverDue(task: CronTask, coalescedCount: number): Promise<boolean> {
    const firedAt = this.clocks.wallNow();
    const stale = this.isStaleAt(task, firedAt);
    const delivered = await this.deliverFire(task, { coalescedCount, firedAt });
    if (delivered && stale && task.recurring !== false) {
      const removed = await this.removeTasks([task.id]);
      if (removed.length > 0) this.emitDeleted(task.id);
    }
    return delivered;
  }

  private async deliverConditional(task: CronTask, fire: CronFire, scheduledAt?: number): Promise<CronRunResult | undefined> {
    const result = await this.evaluateTrigger(task, fire.coalescedCount);
    const check: CronTriggerCheck = { checkedAt: fire.firedAt, outcome: result.outcome, reason: result.reason, exitCode: result.exitCode };
    if (result.outcome === 'error') this.log.warn('Cron trigger check failed', { taskId: task.id, reason: result.reason });
    if (this.stopping) return undefined;
    const recorded = await this.writeIfCurrent(task, { lastTriggerCheck: check });
    if (result.outcome !== 'allowed') return { triggered: false, check };
    const canAdmit = (): boolean => !this.stopping && recorded !== undefined && this.tasks.get(task.id) === recorded &&
      (task.trigger?.script === undefined || matchesCronScript(task.approvedScript, this.getScriptExecution(task.trigger.script)));
    if (recorded === undefined || !canAdmit()) {
      return { triggered: false, check: { checkedAt: fire.firedAt, outcome: 'error', reason: 'cancelled' } };
    }
    if (!(await this.deliverFire(recorded, fire, result.stdout, canAdmit))) return undefined;
    if (scheduledAt !== undefined) await this.advanceCursor(task.id, scheduledAt);
    return { triggered: true };
  }

  private async evaluateTrigger(task: CronTask, coalescedCount: number): Promise<CronScriptResult> {
    const probability = task.trigger?.probability;
    if (probability === 0 || (probability !== undefined && probability !== 1 && Math.random() >= probability)) {
      return { outcome: 'skipped', reason: 'probability' };
    }
    const scriptId = task.trigger?.script;
    if (scriptId === undefined) return { outcome: 'allowed' };
    const approved = task.approvedScript;
    if (approved === undefined || !matchesCronScript(approved, this.getScriptExecution(scriptId))) {
      return { outcome: 'error', reason: 'not_authorized' };
    }
    const controller = new AbortController();
    const work = runCronScript(this.processes, approved, { jobId: task.id, cron: task.cron, coalescedCount }, controller.signal);
    this.activeChecks.set(task.id, { controller, work });
    try {
      const result = await work;
      if (result.reason === 'cleanup_failed') return result;
      if (!controller.signal.aborted) return result;
      return { outcome: 'error', reason: controller.signal.reason === 'not_authorized' ? 'not_authorized' : 'cancelled' };
    } finally {
      this.activeChecks.delete(task.id);
    }
  }

  private async writeIfCurrent(task: CronTask, patch: Partial<CronTask>): Promise<CronTask | undefined> {
    let updated: CronTask | undefined;
    await this.persistEnqueue(task.id, async () => {
      if (this.stopping || this.tasks.get(task.id) !== task) return;
      updated = { ...task, ...patch };
      await this.store.save(this.ctx.workspaceId, updated);
      this.tasks.set(task.id, updated);
      this.dispatchCron(new CronAdd({ task: updated }));
    });
    return updated;
  }

  private async deliverFire(
    task: CronTask,
    ctx: CronFire,
    scriptOutput?: string,
    canAdmit?: () => boolean,
  ): Promise<boolean> {
    const mainHandle = this.agentLifecycle.get('main');
    if (!mainHandle) return false;

    const promptService = mainHandle.accessor.get(IAgentPromptService);

    const origin: CronJobOrigin = {
      kind: 'cron_job',
      jobId: task.id,
      cron: task.cron,
      recurring: task.recurring !== false,
      coalescedCount: ctx.coalescedCount,
      stale: this.isStaleAt(task, ctx.firedAt),
      deliveryMode: task.deliveryMode ?? 'idle',
    };

    try {
      const handle = await promptService.enqueueCron({ origin, prompt: task.prompt, scriptOutput, canAdmit });
      this.signalCron(new CronFired({ origin, prompt: task.prompt }));
      this.telemetry.track2(CRON_FIRED, {
        recurring: task.recurring !== false,
        coalesced_count: ctx.coalescedCount,
        stale: origin.stale,
        buffered: handle.state === 'pending',
      });
      return true;
    } catch (error) {
      this.debugLog(
        `prompt admission rejected for task ${task.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private async advanceCursor(id: string, lastFiredAt: number): Promise<void> {
    await this.persistEnqueue(id, async () => {
      const existing = this.tasks.get(id);
      if (existing === undefined) return;
      const updated = { ...existing, lastFiredAt };
      await this.store.save(this.ctx.workspaceId, updated);
      this.tasks.set(id, updated);
      this.dispatchCron(new CronCursor({ id, lastFiredAt }));
    });
  }

  private dispatchCron(event: CronAdd | CronDelete | CronCursor): void {
    const mainHandle = this.agentLifecycle.get('main');
    if (!mainHandle) return;
    void mainHandle.accessor.get(IEventDispatcher).dispatch(event);
  }

  private signalCron(event: CronFired): void {
    const mainHandle = this.agentLifecycle.get('main');
    if (!mainHandle) return;
    void mainHandle.accessor.get(IEventDispatcher).dispatch(event);
  }

  private getParsed(expr: string): ParsedCronExpression {
    const cached = this.parsedCache.get(expr);
    if (cached !== undefined) return cached;
    const parsed = parseCronExpression(expr);
    this.parsedCache.set(expr, parsed);
    return parsed;
  }

  private computeJitteredNext(
    task: CronTask,
    parsed: ParsedCronExpression,
    baseMs: number,
  ): number | null {
    const ideal = computeNextCronRun(parsed, baseMs);
    if (ideal === null) return null;
    if (task.recurring === false) {
      return oneShotJitteredNextCronRunMs(task, ideal, undefined, this.getCronConfig().noJitter);
    }
    return jitteredNextCronRunMs(task, parsed, ideal, undefined, this.getCronConfig().noJitter);
  }

  computeDisplayNextFire(
    task: CronTask,
    parsed: ParsedCronExpression,
    idealMs: number,
  ): number | null {
    const noJitter = this.getCronConfig().noJitter;
    if (task.recurring === false) {
      return oneShotJitteredNextCronRunMs(task, idealMs, undefined, noJitter);
    }
    return jitteredNextCronRunMs(task, parsed, idealMs, undefined, noJitter);
  }

  private countCoalesced(
    task: CronTask,
    parsed: ParsedCronExpression,
    firstFireMs: number,
    nowMs: number,
  ): { count: number; lastDueMs: number } {
    let count = 1;
    let cursor = firstFireMs;
    let lastDueMs = firstFireMs;
    while (count < MAX_COALESCE_ITERATIONS) {
      const next = computeNextCronRun(parsed, cursor);
      if (next === null) break;
      if (next > nowMs) break;
      const jitteredNext =
        task.recurring === false
          ? oneShotJitteredNextCronRunMs(task, next, undefined, this.getCronConfig().noJitter)
          : jitteredNextCronRunMs(task, parsed, next, undefined, this.getCronConfig().noJitter);
      if (jitteredNext > nowMs) break;
      count++;
      cursor = next;
      lastDueMs = next;
    }
    return { count, lastDueMs };
  }

  private nextFireFor(task: CronTask): number | null {
    if (task.paused === true || isConsumedOneShot(task)) return null;
    try {
      const parsed = this.getParsed(task.cron);
      const base = Math.max(this.lastSeenAt.get(task.id) ?? task.createdAt, cronScheduleBase(task, this.clocks.wallNow()));
      return this.computeJitteredNext(task, parsed, base);
    } catch (error) {
      this.debugLog(
        `nextFireFor skipping task ${task.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private debugLog(message: string): void {
    if (this.getCronConfig().debug) {
      process.stderr.write(`[cron/session] ${message}\n`);
    }
  }

  private adopt(task: CronTask): void {
    this.tasks.set(task.id, task);
  }

  private removeByIds(ids: readonly string[]): readonly string[] {
    const removed: string[] = [];
    for (const id of ids) {
      if (this.tasks.delete(id)) {
        removed.push(id);
      }
    }
    return removed;
  }

  private generateUniqueId(): string {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const candidate = ulid();
      if (!CRON_ID_REGEX.test(candidate)) continue;
      if (!this.tasks.has(candidate)) return candidate;
    }
    throw new BugIndicatingError(
      `SessionCronService: failed to generate a unique ULID after ${MAX_ID_ATTEMPTS} attempts`,
    );
  }

  private isStaleAt(task: CronTask, now: number): boolean {
    if (this.getCronConfig().noStale) return false;
    if (task.recurring === false) return false;
    const age = now - task.createdAt;
    return Number.isFinite(age) && age >= STALE_THRESHOLD_MS;
  }

  private persistEnqueue(id: string, work: () => Promise<void>): Promise<void> {
    const prev = this.persistQueues.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => work())
      .finally(() => {
        if (this.persistQueues.get(id) === next) {
          this.persistQueues.delete(id);
        }
      });
    this.persistQueues.set(id, next);
    return next;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionCronService,
  SessionCronServiceImpl,
  ScopeActivation.OnScopeCreated,
  'cron',
);
