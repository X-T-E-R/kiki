import { join } from 'pathe';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import { parsePositiveIntEnv } from '#/_base/utils/env';

import type { LogLevel } from './log';

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';
export const DEFAULT_GLOBAL_MAX_BYTES = 6 * 1024 * 1024;
export const DEFAULT_GLOBAL_FILES = 5;
export const DEFAULT_SESSION_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_SESSION_FILES = 3;

export interface LoggingConfig {
  readonly level: LogLevel;
  readonly globalLogPath: string;
  readonly globalMaxBytes: number;
  readonly globalFiles: number;
  readonly sessionMaxBytes: number;
  readonly sessionFiles: number;
}

export interface ILogOptions extends LoggingConfig {}

export const ILogOptions: ServiceIdentifier<ILogOptions> =
  createDecorator<ILogOptions>('logOptions');

export interface ResolveLoggingInput {
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
}

export function resolveGlobalLogPath(homeDir: string): string {
  return join(homeDir, 'logs', 'kimi-code.log');
}

export function resolveSessionLogPath(sessionDir: string): string {
  return join(sessionDir, 'logs', 'kimi-code.log');
}

export function resolveLoggingConfig(input: ResolveLoggingInput): LoggingConfig {
  const env = input.env;
  return {
    level: parseLevel(env['KIKI_LOG_LEVEL']) ?? DEFAULT_LOG_LEVEL,
    globalLogPath: resolveGlobalLogPath(input.homeDir),
    globalMaxBytes: parsePositiveIntEnv(env['KIKI_LOG_GLOBAL_MAX_BYTES']) ?? DEFAULT_GLOBAL_MAX_BYTES,
    globalFiles: parsePositiveIntEnv(env['KIKI_LOG_GLOBAL_FILES']) ?? DEFAULT_GLOBAL_FILES,
    sessionMaxBytes:
      parsePositiveIntEnv(env['KIKI_LOG_SESSION_MAX_BYTES']) ?? DEFAULT_SESSION_MAX_BYTES,
    sessionFiles: parsePositiveIntEnv(env['KIKI_LOG_SESSION_FILES']) ?? DEFAULT_SESSION_FILES,
  };
}

export function logSeed(config: LoggingConfig): ScopeSeed {
  return [
    [ILogOptions as ServiceIdentifier<unknown>, config satisfies ILogOptions],
  ];
}

function parseLevel(value: string | undefined): LogLevel | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase().trim();
  if (v === 'off' || v === 'error' || v === 'warn' || v === 'info' || v === 'debug') return v;
  return undefined;
}
