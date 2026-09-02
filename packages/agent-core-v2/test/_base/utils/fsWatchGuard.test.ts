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
    if (root !== '') await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('is installed when core loads independently', () => {
    expect(isNativeFsWatchErrorGuardInstalled()).toBe(true);
    installNativeFsWatchErrorGuard();
    expect(isNativeFsWatchErrorGuardInstalled()).toBe(true);
  });

  it('reports through an unexpected-error handler registered later', async () => {
    root = await mkdtemp(join(tmpdir(), 'fswatch-guard-'));
    const seen: unknown[] = [];
    setUnexpectedErrorHandler((error) => {
      seen.push(error);
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
    root = await mkdtemp(join(tmpdir(), 'fswatch-guard-listener-'));
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => {
      unexpected.push(error);
    });
    const watcher = watch(root, { persistent: false });
    const seen: unknown[] = [];
    watcher.on('error', (error) => {
      seen.push(error);
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
