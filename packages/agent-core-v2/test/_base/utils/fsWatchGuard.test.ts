import { watch } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  installNativeFsWatchErrorGuard,
  isNativeFsWatchErrorGuardInstalled,
} from '#/_base/utils/fsWatchGuard';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';

describe('native fs.watch error guard', () => {
  let root = '';

  afterEach(async () => {
    resetUnexpectedErrorHandler();
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('is installed before chokidar-backed watchers load', () => {
    expect(isNativeFsWatchErrorGuardInstalled()).toBe(true);
    installNativeFsWatchErrorGuard();
    expect(isNativeFsWatchErrorGuardInstalled()).toBe(true);
  });

  it('does not throw when a native watcher emits an error without listeners', async () => {
    installNativeFsWatchErrorGuard();
    root = await mkdtemp(join(tmpdir(), 'fswatch-guard-'));
    const seen: unknown[] = [];
    setUnexpectedErrorHandler((err) => {
      seen.push(err);
    });

    const watcher = watch(root, { persistent: false });
    const error = Object.assign(new Error('watch failed'), {
      code: 'EPERM',
      syscall: 'watch',
      filename: null,
    });

    expect(() => watcher.emit('error', error)).not.toThrow();
    expect(seen).toEqual([error]);
    watcher.close();
  });

  it('still delivers errors to an attached listener', async () => {
    installNativeFsWatchErrorGuard();
    root = await mkdtemp(join(tmpdir(), 'fswatch-guard-listener-'));
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((err) => {
      unexpected.push(err);
    });

    const watcher = watch(root, { persistent: false });
    const seen: unknown[] = [];
    watcher.on('error', (err) => {
      seen.push(err);
    });
    const error = Object.assign(new Error('watch failed'), {
      code: 'EPERM',
      syscall: 'watch',
      filename: null,
    });

    expect(() => watcher.emit('error', error)).not.toThrow();
    expect(seen).toEqual([error]);
    expect(unexpected).toEqual([]);
    watcher.close();
  });
});
