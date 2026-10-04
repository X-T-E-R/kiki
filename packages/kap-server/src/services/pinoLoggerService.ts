import { pino, type Logger, type LoggerOptions } from 'pino';

export type ServerLogger = Logger;

export type ServerLogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface CreateLoggerOptions {
  level: ServerLogLevel;
}

export function createServerLogger(opts: CreateLoggerOptions): ServerLogger {
  const base: LoggerOptions = {
    level: opts.level,
    base: { name: 'kimi-server-v2' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', 'req.body.code', 'body.code', 'cookie', 'authorization', 'accessCode', 'sessionSecret'], censor: '[redacted]' },
  };
  return pino(base, process.stderr);
}
