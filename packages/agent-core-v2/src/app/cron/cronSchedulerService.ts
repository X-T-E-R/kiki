import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IntervalTimer } from '#/_base/utils/timer';
import { IConfigService } from '#/app/config/config';
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

const DEFAULT_POLL_INTERVAL_MS = 1_000;

export class CronSchedulerService extends Disposable implements ICronScheduler {
  declare readonly _serviceBrand: undefined;

  private readonly timer = this._register(new IntervalTimer({ unref: true }));
  private clocks: ClockSources = SYSTEM_CLOCKS;
  private currentTick: Promise<void> | undefined;
  private sigusr1Handler: NodeJS.SignalsListener | undefined;
  private disposed = false;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @ICronTaskPersistence private readonly store: ICronTaskPersistence,
    @ISessionManager private readonly sessions: ISessionManager,
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
    if (this.currentTick !== undefined) return this.currentTick;
    const current = this.runTick().finally(() => {
      if (this.currentTick === current) this.currentTick = undefined;
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
    const interval = cfg.pollIntervalMs === undefined ? DEFAULT_POLL_INTERVAL_MS : cfg.pollIntervalMs;
    if (interval !== null && interval !== 0) {
      this.timer.cancelAndSet(() => {
        void this.tick().catch((error: unknown) => this.debugError('tick', error));
      }, interval);
    }
    void this.tick().catch((error: unknown) => this.debugError('initial tick', error));
  }

  private async runTick(): Promise<void> {
    await this.config.ready;
    const cfg = this.getCronConfig();
    if (cfg.disabled) return;
    this.clocks = resolveClockSources(cfg.clock, cfg.debug);

    const now = this.clocks.wallNow();
    const dueSessionIds = new Set<string>();
    const workspaceIds = await this.store.listWorkspaceIds();
    for (const workspaceId of workspaceIds) {
      const tasks = await this.store.list({ workspaceId });
      for (const task of tasks) {
        const sessionId = task.tags?.[CRON_SESSION_TAG];
        if (sessionId === undefined || task.paused === true) continue;
        if (this.isDue(task, now, cfg.noJitter)) dueSessionIds.add(sessionId);
      }
    }

    for (const sessionId of dueSessionIds) {
      try {
        await this.fireSession(sessionId);
      } catch (error) {
        this.debugError(`session ${sessionId}`, error);
      }
    }
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
      if (ideal === null) return false;
      const next = task.recurring === false
        ? oneShotJitteredNextCronRunMs(task, ideal, undefined, noJitter)
        : jitteredNextCronRunMs(task, parsed, ideal, undefined, noJitter);
      return next <= now;
    } catch (error) {
      this.debugError(`task ${task.id}`, error);
      return false;
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
