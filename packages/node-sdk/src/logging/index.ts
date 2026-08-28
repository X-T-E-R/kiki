export type {
  DiagnosticLogHost,
  LogContext,
  LogLevel,
  LogPayload,
  Logger,
  RootLogger,
} from './types';

export {
  __resetRootLoggerForTest,
  flushDiagnosticLogs,
  flushDiagnosticLogsSync,
  getRootLogger,
  log,
  redact,
} from './logger';

// The global log's path is the engine's own answer — hosts that need to read
// or bundle the file resolve it the same way `AppLogService` does.
export { resolveGlobalLogPath } from '@moonshot-ai/agent-core-v2';
