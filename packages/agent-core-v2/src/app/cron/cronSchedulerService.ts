import { join } from 'node:path';

import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IntervalTimer, TimeoutTimer, MAX_TIMER_DELAY_MS } from '#/_base/utils/timer';
import { IConfigService } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { ISessionManager, type SessionLease } from '#/app/sessionManager/sessionManager';
import { LifecycleScope } from '#/app/scopes';
import { ISessionCronService } from '#/session/cron/sessionCronService';

import { type ClockSources, resolveClockSources, SYSTEM_CLOCKS } from './clock';
import { type CronConfig, CRON_SECTION } from './configSection';
import { computeNextCronRun, parseCronExpression } from './cron-expr';
import { CRON_SESSION_TAG, type CronTask } from './cronTask';
import { ICronTaskPersistence } from './cronTaskPersistence';
import { jitteredNextCronRunMs, oneShotJitteredNextCronRunMs } from './jitter';
import { ICronScheduler } from './cronScheduler';

const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60_000;
const WATCH_DEBOUNCE_MS = 200;
const OVERDUE_RETRY_MS = 60_000;

export class CronSchedulerService extends Disposable implements ICronScheduler {
  declare readonly _serviceBrand: undefined;

  private readonly timer = this._register(new IntervalTimer({ unref: true }));
  private readonly dueTimer = this._register(new TimeoutTimer());
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private tasks: readonly CronTask[] = [];
  private clocks: ClockSources = SYSTEM_CLOCKS;
  private currentTick: Promise<void> | undefined;
  private reloadQueued = false;
  private sigusr1Handler: NodeJS.SignalsListener | undefined;
  private disposed = false;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @ICronTaskPersistence private readonly store: ICronTaskPersistence,
    @ISessionManager private readonly sessions: ISessionManager,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFsWatchService private readonly fsWatch: IHostFsWatchService,
  ) {
    super();
    this._register(
      toDisposable(() => {
        this.disposed = true;
        this.unbindSigusr1();
      }),
    );
    void this.start().catch((error: unknown) => this.debugError('start', error));
  }

  tick(): Promise<void> {
    return this.scheduleTick(true);
  }

  private scheduleTick(reload: boolean): Promise<void> {
    if (this.currentTick !== undefined) {
      if (reload) this.reloadQueued = true;
      return this.currentTick;
    }
    const current = this.runTick(reload).finally(() => {
      if (this.currentTick === current) this.currentTick = undefined;
      if (this.reloadQueued && !this.disposed) {
        this.reloadQueued = false;
        void this.tick().catch((error: unknown) => this.debugError('reload', error));
      }
    });
    this.currentTick = current;
    return current;
  }

  private async start(): Promise<void> {
    await this.config.ready;
    if (this.disposed) return;
    const cfg = this.getCronConfig();
    this.clocks = resolveClockSources(cfg.clock, cfg.debug);
    if (cfg.manualTick) {
      this.bindSigusr1();
      return;
    }
    try {
      const watch = this._register(this.fsWatch.watch(join(this.bootstrap.homeDir, this.bootstrap.scope('cron'))));
      this._register(watch.onDidChange(() => this.requestReload()));
      void watch.ready.catch((error: unknown) => this.debugError('watch', error));
    } catch (error) {
      this.debugError('watch', error);
    }
    if (this.store.onDidChange !== undefined) {
      this._register(this.store.onDidChange(() => this.requestReload()));
    }
    this._register(this.config.onDidSectionChange((event) => {
      if (event.domain !== CRON_SECTION) return;
      this.configureRefresh();
      this.requestReload();
    }));
    this.configureRefresh();
    void this.tick().catch((error: unknown) => this.debugError('initial tick', error));
  }

  private configureRefresh(): void {
    this.timer.cancel();
    this.dueTimer.cancel();
    const cfg = this.getCronConfig();
    if (cfg.manualTick || cfg.disabled || cfg.pollIntervalMs === 0 || cfg.pollIntervalMs === null) return;
    this.timer.cancelAndSet(() => {
      void this.tick().catch((error: unknown) => this.debugError('refresh', error));
    }, cfg.pollIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);
    this.scheduleNextWake(cfg);
  }

  private requestReload(): void {
    if (this.disposed) return;
    this.watchDebounce.cancelAndSet(() => {
      const cfg = this.getCronConfig();
      if (cfg.manualTick || cfg.disabled || cfg.pollIntervalMs === 0 || cfg.pollIntervalMs === null) return;
      void this.tick().catch((error: unknown) => this.debugError('change', error));
    }, WATCH_DEBOUNCE_MS);
  }

  private async loadTasks(): Promise<void> {
    const tasks: CronTask[] = [];
    for (const workspaceId of await this.store.listWorkspaceIds()) {
      tasks.push(...await this.store.list({ workspaceId }));
    }
    this.tasks = tasks;
  }

  private async runTick(reload: boolean): Promise<void> {
    await this.config.ready;
    if (this.disposed) return;
    const cfg = this.getCronConfig();
    if (cfg.disabled) return;
    this.clocks = resolveClockSources(cfg.clock, cfg.debug);
    if (reload) await this.loadTasks();
    const now = this.clocks.wallNow();
    const dueSessionIds = new Set<string>();
    for (const task of this.tasks) {
      const sessionId = task.tags?.[CRON_SESSION_TAG];
      if (sessionId === undefined || task.paused === true) continue;
      if (this.isDue(task, now, cfg.noJitter)) dueSessionIds.add(sessionId);
    }
    for (const sessionId of dueSessionIds) {
      try {
        await this.fireSession(sessionId);
      } catch (error) {
        this.debugError(`session ${sessionId}`, error);
      }
    }
    if (dueSessionIds.size > 0) await this.loadTasks();
    this.scheduleNextWake(cfg);
  }

  private scheduleNextWake(cfg: CronConfig): void {
    this.dueTimer.cancel();
    if (cfg.manualTick || cfg.disabled || cfg.pollIntervalMs === 0 || cfg.pollIntervalMs === null) return;
    const now = this.clocks.wallNow();
    let next = Infinity;
    for (const task of this.tasks) {
      if (task.paused === true || task.tags?.[CRON_SESSION_TAG] === undefined) continue;
      next = Math.min(next, this.nextFireTime(task, now, cfg.noJitter));
    }
    if (!Number.isFinite(next)) return;
    const delay = next <= now ? OVERDUE_RETRY_MS : Math.max(1, Math.min(next - now, MAX_TIMER_DELAY_MS));
    this.dueTimer.cancelAndSet(() => {
      void this.scheduleTick(false).catch((error: unknown) => this.debugError('due', error));
    }, delay);
  }

  private async fireSession(sessionId: string): Promise<void> {
    let lease: SessionLease | undefined;
    try {
      if (this.sessions.acquire !== undefined) {
        lease = await this.sessions.acquire(sessionId, 'cron-fire');
        if (lease === undefined) return;
      } else if ((await this.sessions.resume(sessionId)) === undefined) {
        return;
      }

      await this.sessions.withLifecycleSerialization(sessionId, async () => {
        const handle = this.sessions.get(sessionId);
        if (handle === undefined) return;
        const cron = handle.accessor.get(ISessionCronService);
        await cron.tick();
        await cron.flushPersist();
      });
    } finally {
      lease?.dispose();
    }
  }

  private isDue(task: CronTask, now: number, noJitter: boolean): boolean {
    return this.nextFireTime(task, now, noJitter) <= now;
  }

  private nextFireTime(task: CronTask, now: number, noJitter: boolean): number {
    try {
      const parsed = parseCronExpression(task.cron);
      const cursor =
        task.lastFiredAt !== undefined &&
        Number.isFinite(task.lastFiredAt) &&
        task.lastFiredAt <= now
          ? task.lastFiredAt
          : undefined;
      const base = cursor !== undefined && cursor > task.createdAt ? cursor : task.createdAt;
      const ideal = computeNextCronRun(parsed, base);
      if (ideal === null) return Infinity;
      return task.recurring === false
        ? oneShotJitteredNextCronRunMs(task, ideal, undefined, noJitter)
        : jitteredNextCronRunMs(task, parsed, ideal, undefined, noJitter);
    } catch (error) {
      this.debugError(`task ${task.id}`, error);
      return Infinity;
    }
  }

  private getCronConfig(): CronConfig {
    return this.config.get<CronConfig>(CRON_SECTION);
  }

  private bindSigusr1(): void {
    if (process.platform === 'win32' || this.sigusr1Handler !== undefined) return;
    const handler: NodeJS.SignalsListener = () => {
      void this.tick().catch((error: unknown) => this.debugError('SIGUSR1 tick', error));
    };
    this.sigusr1Handler = handler;
    process.on('SIGUSR1', handler);
  }

  private unbindSigusr1(): void {
    if (this.sigusr1Handler === undefined) return;
    process.off('SIGUSR1', this.sigusr1Handler);
    this.sigusr1Handler = undefined;
  }

  private debugError(operation: string, error: unknown): void {
    let debug = false;
    try {
      debug = this.getCronConfig().debug;
    } catch {
      return;
    }
    if (!debug) return;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[cron/app] ${operation} failed: ${message}\n`);
  }
}

registerScopedService(
  LifecycleScope.App,
  ICronScheduler,
  CronSchedulerService,
  ScopeActivation.OnScopeCreated,
  'cron',
);
