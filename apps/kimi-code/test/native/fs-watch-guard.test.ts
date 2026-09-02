import { watch } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

await import('@moonshot-ai/agent-core-v2/_base/utils/nativeFsWatchErrorGuard');
const earlyWatcher = watch(tmpdir(), { persistent: false });
const earlyEmit = Object.getPrototypeOf(earlyWatcher).emit as unknown;
earlyWatcher.close();
const { isNativeFsWatchErrorGuardInstalled } = await import(
  '@moonshot-ai/agent-core-v2/_base/utils/fsWatchGuard'
);
const { resetUnexpectedErrorHandler, setUnexpectedErrorHandler } = await import(
  '@moonshot-ai/agent-core-v2/_base/errors/unexpectedError'
);

describe('native fs.watch error guard integration', () => {
  let root = '';

  afterEach(async () => {
    resetUnexpectedErrorHandler();
    if (root !== '') await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('keeps the early app guard while core registers its reporter', async () => {
    expect(isNativeFsWatchErrorGuardInstalled()).toBe(true);
    root = await mkdtemp(join(tmpdir(), 'fswatch-guard-'));
    const seen: unknown[] = [];
    setUnexpectedErrorHandler((error) => {
      seen.push(error);
    });
    const watcher = watch(root, { persistent: false });
    expect(Object.getPrototypeOf(watcher).emit).toBe(earlyEmit);
    const error = Object.assign(new Error('watch failed'), {
      code: 'EPERM',
      syscall: 'watch',
      filename: null,
    });

    expect(() => watcher.emit('error', error)).not.toThrow();
    expect(seen).toEqual([error]);
    watcher.close();
  });
});
