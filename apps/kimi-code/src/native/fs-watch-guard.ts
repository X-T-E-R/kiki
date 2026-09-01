import { watch } from 'node:fs';
import { tmpdir } from 'node:os';

const GUARD = Symbol.for('kiki.nativeFsWatchErrorGuard');

type GuardedPrototype = {
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  [GUARD]?: true;
};

let installed = false;

function captureFsWatcherPrototype(): GuardedPrototype | undefined {
  for (const root of [tmpdir(), process.cwd()]) {
    const proto = tryCapture(root);
    if (proto !== undefined) return proto;
  }
  return undefined;
}

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

export function installNativeFsWatchErrorGuard(): void {
  if (installed) return;
  const proto = captureFsWatcherPrototype();
  if (proto === undefined) return;
  if (proto[GUARD] === true) {
    installed = true;
    return;
  }
  const originalEmit = proto.emit;
  proto.emit = function (this: NodeJS.EventEmitter, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'error' && this.listenerCount('error') === 0) {
      onNativeFsWatchError(args[0] as NodeJS.ErrnoException);
      return false;
    }
    return originalEmit.call(this, event, ...args);
  };
  proto[GUARD] = true;
  installed = true;
}

function onNativeFsWatchError(error: NodeJS.ErrnoException): void {
  console.error('[fs.watch]', error);
}

installNativeFsWatchErrorGuard();
