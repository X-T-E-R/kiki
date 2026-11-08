import type { CronDeliveryMode, CronScriptExecution, CronTrigger, CronTriggerCheck } from '@kiki/protocol';

export interface CronTask {
  readonly id: string;
  readonly cron: string;
  readonly prompt: string;
  readonly createdAt: number;
  readonly recurring?: boolean;
  readonly deliveryMode?: CronDeliveryMode;
  readonly trigger?: CronTrigger;
  readonly approvedScript?: CronScriptExecution;
  readonly paused?: boolean;
  readonly lastFiredAt?: number;
  readonly scheduleCursorAt?: number;
  readonly oneShotClaimed?: boolean;
  readonly lastTriggerCheck?: CronTriggerCheck;
  readonly tags?: Readonly<Record<string, string>>;
}

export type CronTaskInit = Omit<CronTask, 'id' | 'createdAt' | 'scheduleCursorAt' | 'oneShotClaimed' | 'lastTriggerCheck'>;

export type CronTaskPatch = Partial<Pick<CronTask, 'cron' | 'prompt' | 'recurring' | 'paused' | 'tags' | 'deliveryMode' | 'trigger' | 'approvedScript'>>;

export function cronScheduleBase(task: CronTask, now: number): number {
  const lastFire = task.lastFiredAt;
  return Math.max(task.createdAt, task.scheduleCursorAt ?? task.createdAt,
    lastFire !== undefined && Number.isFinite(lastFire) && lastFire <= now ? lastFire : task.createdAt);
}

export function isConsumedOneShot(task: CronTask): boolean {
  return task.recurring === false && task.oneShotClaimed === true;
}

export const CRON_SESSION_TAG = 'sessionId';
