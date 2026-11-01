import { AsyncLocalStorage } from 'node:async_hooks';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';

const GUARD_STATE = Symbol.for('kiki.nativeFsWatchErrorGuard');
const GUARDED_PROTOTYPE = Symbol.for('kiki.nativeFsWatchErrorGuard.prototype');

export type NativeFsWatchErrorReporter = (error: NodeJS.ErrnoException) => void;

interface NativeFsWatchErrorGuardState {
  installed: boolean;
  report: NativeFsWatchErrorReporter;
  owner?: AsyncLocalStorage<NativeFsWatchErrorReporter>;
}

type GuardGlobal = typeof globalThis & {
  [GUARD_STATE]?: NativeFsWatchErrorGuardState;
};

type GuardedPrototype = {
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  [GUARDED_PROTOTYPE]?: true;
};

const guardGlobal = globalThis as GuardGlobal;
const guardState = guardGlobal[GUARD_STATE] ??= {
  installed: false,
  report: (error) => { console.error('[fs.watch]', error); },
};
const ownerStorage = guardState.owner ??= new AsyncLocalStorage<NativeFsWatchErrorReporter>();

function tryCapture(root: string): GuardedPrototype | undefined {
  try {
    const watcher = watch(root, { persistent: false });
    const proto = Object.getPrototypeOf(watcher) as GuardedPrototype;
    watcher.close();
    return proto;
  } catch {
    return undefined;
  }
}

function captureFsWatcherPrototype(): GuardedPrototype | undefined {
  for (const root of [tmpdir(), process.cwd()]) {
    const proto = tryCapture(root);
    if (proto !== undefined) return proto;
  }
  return undefined;
}

export function installNativeFsWatchErrorGuard(): void {
  if (guardState.installed) return;
  const proto = captureFsWatcherPrototype();
  if (proto === undefined) return;
  if (proto[GUARDED_PROTOTYPE] === true) {
    guardState.installed = true;
    return;
  }
  const originalEmit = proto.emit;
  proto.emit = function (this: NodeJS.EventEmitter, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'error' && this.listenerCount('error') === 0) {
      const error = args[0] as NodeJS.ErrnoException;
      const owner = ownerStorage.getStore();
      if (owner === undefined) guardState.report(error);
      else owner(error);
      return false;
    }
    return originalEmit.call(this, event, ...args);
  };
  proto[GUARDED_PROTOTYPE] = true;
  guardState.installed = true;
}

export function setNativeFsWatchErrorReporter(reporter: NativeFsWatchErrorReporter): void {
  guardState.report = reporter;
}

/**
 * Runs `fn` so that native `fs.watch` instances created inside it, including
 * ones created later from its asynchronous continuations, report listener-less
 * errors to `report` instead of the process-wide reporter.
 */
export function runWithNativeFsWatchErrorOwner<T>(report: NativeFsWatchErrorReporter, fn: () => T): T {
  return ownerStorage.run(report, fn);
}

export function isNativeFsWatchErrorGuardInstalled(): boolean {
  return guardState.installed;
}

installNativeFsWatchErrorGuard();
