import { type ConfigStripEnv, type EnvBindings, envBindings } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const CRON_SECTION = 'cron';

export interface CronConfig {
  readonly debug: boolean;
  readonly noJitter: boolean;
  readonly noStale: boolean;
  readonly disabled: boolean;
  readonly manualTick: boolean;
  readonly clock?: string;
  readonly pollIntervalMs?: number | null;
}

export const DEFAULT_CRON_CONFIG: CronConfig = {
  debug: false,
  noJitter: false,
  noStale: false,
  disabled: false,
  manualTick: false,
};

const cronConfigSchema = { parse: (value: unknown): CronConfig => value as CronConfig };

const on = (raw: string): boolean => raw === '1';

function parsePollIntervalMs(raw: string): number | null | undefined {
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value === 'null') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

export const cronEnvBindings: EnvBindings<CronConfig> = envBindings(cronConfigSchema, {
  debug: { env: 'KIKI_CRON_DEBUG', parse: on },
  noJitter: { env: 'KIKI_CRON_NO_JITTER', parse: on },
  noStale: { env: 'KIKI_CRON_NO_STALE', parse: on },
  disabled: { env: 'KIKI_DISABLE_CRON', parse: on },
  manualTick: { env: 'KIKI_CRON_MANUAL_TICK', parse: on },
  clock: 'KIKI_CRON_CLOCK',
  pollIntervalMs: { env: 'KIKI_CRON_POLL_INTERVAL_MS', parse: parsePollIntervalMs },
});

export const stripCronEnv: ConfigStripEnv<CronConfig> = () => undefined;

registerConfigSection(CRON_SECTION, cronConfigSchema, {
  defaultValue: DEFAULT_CRON_CONFIG,
  env: cronEnvBindings,
  stripEnv: stripCronEnv,
});
