import { onUnexpectedError } from '#/_base/errors/unexpectedError';

const GUARD_STATE = Symbol.for('kiki.nativeFsWatchErrorGuard');

interface NativeFsWatchErrorGuardState {
  installed: boolean;
  report: (error: NodeJS.ErrnoException) => void;
}

type GuardGlobal = typeof globalThis & {
  [GUARD_STATE]?: NativeFsWatchErrorGuardState;
};

const guardGlobal = globalThis as GuardGlobal;
const guardState = guardGlobal[GUARD_STATE] ??= {
  installed: false,
  report: onUnexpectedError,
};
guardState.report = onUnexpectedError;

export function isNativeFsWatchErrorGuardInstalled(): boolean {
  return guardState.installed;
}
