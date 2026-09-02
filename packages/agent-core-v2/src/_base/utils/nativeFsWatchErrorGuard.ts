import { watch } from 'node:fs';
import { tmpdir } from 'node:os';

const GUARD_STATE = Symbol.for('kiki.nativeFsWatchErrorGuard');
const GUARDED_PROTOTYPE = Symbol.for('kiki.nativeFsWatchErrorGuard.prototype');

export type NativeFsWatchErrorReporter = (error: NodeJS.ErrnoException) => void;

interface NativeFsWatchErrorGuardState {
  installed: boolean;
  report: NativeFsWatchErrorReporter;
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
      guardState.report(args[0] as NodeJS.ErrnoException);
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

export function isNativeFsWatchErrorGuardInstalled(): boolean {
  return guardState.installed;
}

installNativeFsWatchErrorGuard();
