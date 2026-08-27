/**
 * The cron task view the SDK's `getCronTasks` returns. The engine owns
 * scheduling; this is the wire-facing projection hosts render.
 */
export interface CronTaskSnapshot {
  readonly id: string;
  readonly cron: string;
  readonly recurring: boolean;
  readonly createdAt: number;
  readonly lastFiredAt: number | undefined;
  /** Post-jitter next fire (epoch ms), or null when no future fire exists. */
  readonly nextFireAt: number | null;
}
