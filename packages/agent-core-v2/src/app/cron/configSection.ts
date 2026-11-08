import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { cronTriggerScriptIdSchema, type CronScriptExecution } from '@kiki/protocol';

import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const CRON_SECTION = 'cron';

export const cronScriptSchema = z.strictObject({
  id: cronTriggerScriptIdSchema,
  command: z.string().min(1).refine(isAbsolute, 'command must be an absolute executable path'),
  args: z.array(z.string()).default([]),
  workspaces: z.array(z.string().refine(isAbsolute, 'workspace must be an absolute path')).min(1),
  timeout: z.number().int().min(1).max(60).default(10),
});

export type CronScript = z.infer<typeof cronScriptSchema>;

export function findCronScript(config: CronConfig, id: string, cwd: string): CronScriptExecution | undefined {
  const script = config.scripts?.find((entry) => entry.id === id && entry.workspaces.some((workspace) => resolve(workspace) === resolve(cwd)));
  if (script === undefined || (process.platform === 'win32' && !/\.exe$/i.test(script.command))) return undefined;
  return { command: script.command, args: [...script.args], cwd, timeout: script.timeout, environment: 'isolated' };
}

export function matchesCronScript(approved: CronScriptExecution | undefined, current: CronScriptExecution | undefined): boolean {
  return approved !== undefined && current !== undefined && approved.command === current.command && approved.cwd === current.cwd &&
    approved.timeout === current.timeout && approved.environment === current.environment &&
    approved.args.length === current.args.length && approved.args.every((arg, index) => arg === current.args[index]);
}

export interface CronConfig {
  readonly debug: boolean;
  readonly noJitter: boolean;
  readonly noStale: boolean;
  readonly disabled: boolean;
  readonly manualTick: boolean;
  readonly clock?: string;
  readonly pollIntervalMs?: number | null;
  readonly scripts?: readonly CronScript[];
}

export const DEFAULT_CRON_CONFIG: CronConfig = {
  debug: false,
  noJitter: false,
  noStale: false,
  disabled: false,
  manualTick: false,
};

const cronConfigSchema = z.object({
  debug: z.boolean().default(DEFAULT_CRON_CONFIG.debug),
  noJitter: z.boolean().default(DEFAULT_CRON_CONFIG.noJitter),
  noStale: z.boolean().default(DEFAULT_CRON_CONFIG.noStale),
  disabled: z.boolean().default(DEFAULT_CRON_CONFIG.disabled),
  manualTick: z.boolean().default(DEFAULT_CRON_CONFIG.manualTick),
  clock: z.string().optional(),
  pollIntervalMs: z.number().int().min(0).nullable().optional(),
  scripts: z.array(cronScriptSchema).refine((scripts) => new Set(scripts.map((script) => script.id)).size === scripts.length, 'script IDs must be unique').optional(),
});

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

export const stripCronEnv = stripEnvBoundFields(cronEnvBindings);

registerConfigSection(CRON_SECTION, cronConfigSchema, {
  defaultValue: DEFAULT_CRON_CONFIG,
  env: cronEnvBindings,
  stripEnv: stripCronEnv,
});
