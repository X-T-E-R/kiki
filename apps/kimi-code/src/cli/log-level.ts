import type { ServerLogLevel } from '@kiki/kap-server';

export const DEFAULT_LOG_LEVEL: ServerLogLevel = 'info';

export const VALID_LOG_LEVELS: readonly ServerLogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

export function parseLogLevel(raw: string | undefined): ServerLogLevel {
  if (raw === undefined) return DEFAULT_LOG_LEVEL;
  if ((VALID_LOG_LEVELS as readonly string[]).includes(raw)) return raw as ServerLogLevel;
  throw new Error(
    `error: invalid --log-level value: ${raw} (allowed: ${VALID_LOG_LEVELS.join(', ')})`,
  );
}
