export type DesktopBootStage = 'spawning' | 'waiting';

export interface DesktopBootStatus {
  readonly stage: DesktopBootStage;
  readonly startedAtMs: number;
}

export interface DesktopFailureInfo {
  readonly message: string;
  readonly stderrTail: readonly string[];
  readonly logPath: string | null;
}

export function normalizeDesktopFailure(error: unknown): DesktopFailureInfo {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const raw = error as { message?: unknown; stderrTail?: unknown; logPath?: unknown };
    if (typeof raw.message === 'string') {
      return {
        message: raw.message,
        stderrTail: Array.isArray(raw.stderrTail)
          ? raw.stderrTail.filter((line): line is string => typeof line === 'string')
          : [],
        logPath: typeof raw.logPath === 'string' ? raw.logPath : null,
      };
    }
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    stderrTail: [],
    logPath: null,
  };
}