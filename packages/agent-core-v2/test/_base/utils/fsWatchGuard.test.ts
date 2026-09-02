import { afterEach, describe, expect, it } from 'vitest';

import { isNativeFsWatchErrorGuardInstalled } from '#/_base/utils/fsWatchGuard';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';

const GUARD_STATE = Symbol.for('kiki.nativeFsWatchErrorGuard');

interface NativeFsWatchErrorGuardState {
  installed: boolean;
  report: (error: NodeJS.ErrnoException) => void;
}

type GuardGlobal = typeof globalThis & {
  [GUARD_STATE]?: NativeFsWatchErrorGuardState;
};

function guardState(): NativeFsWatchErrorGuardState {
  return (globalThis as GuardGlobal)[GUARD_STATE]!;
}

describe('native fs.watch error guard reporter', () => {
  afterEach(() => {
    resetUnexpectedErrorHandler();
  });

  it('does not install a second fs.watch prototype guard', () => {
    expect(isNativeFsWatchErrorGuardInstalled()).toBe(false);
  });

  it('reports through an unexpected-error handler registered later', () => {
    const seen: unknown[] = [];
    setUnexpectedErrorHandler((error) => {
      seen.push(error);
    });
    const error = Object.assign(new Error('watch failed'), {
      code: 'EPERM',
      syscall: 'watch',
      filename: null,
    });

    guardState().report(error);

    expect(seen).toEqual([error]);
  });
});
