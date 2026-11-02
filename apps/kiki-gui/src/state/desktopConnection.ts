import { API_CODES, ApiError } from '@kiki/session-core/transport';

export type DesktopBootStage = 'spawning' | 'waiting';

export interface DesktopBootStatus {
  readonly stage: DesktopBootStage;
  readonly startedAtMs: number;
}

export type DesktopFailureKind = 'identity' | 'authentication' | 'protocol';

export interface DesktopRecovery {
  readonly status: 'retrying' | 'blocked';
  readonly failure: DesktopFailureInfo | null;
}

export class DesktopConnectionFailure extends Error {
  constructor(readonly kind: DesktopFailureKind, message: string) { super(message); }
}

export interface DesktopFailureInfo {
  readonly kind?: DesktopFailureKind;
  readonly message: string;
  readonly stderrTail: readonly string[];
  readonly logPath: string | null;
}

export function normalizeDesktopFailure(error: unknown): DesktopFailureInfo {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const raw = error as { message?: unknown; stderrTail?: unknown; logPath?: unknown; kind?: unknown };
    if (typeof raw.message === 'string') {
      return {
        message: raw.message,
        stderrTail: Array.isArray(raw.stderrTail)
          ? raw.stderrTail.filter((line): line is string => typeof line === 'string')
          : [],
        logPath: typeof raw.logPath === 'string' ? raw.logPath : null,
        kind: raw.kind === 'identity' || raw.kind === 'authentication' || raw.kind === 'protocol' ? raw.kind
          : error instanceof ApiError && error.code === API_CODES.UNAUTHORIZED ? 'authentication'
          : error instanceof ApiError && error.code === API_CODES.INVALID_RESPONSE ? 'protocol' : undefined,
      };
    }
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    stderrTail: [],
    logPath: null,
  };
}