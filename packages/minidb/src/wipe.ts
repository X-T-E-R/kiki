// src/wipe.ts
//
// Rebuild-time removal of a store directory, under the store's OWN write
// lock. A bare `rm -rf` on a store dir deletes the live database of whoever
// currently holds it — and the holder may be another process entirely. So a
// wipe first acquires every lock in the directory (the single-file shape owns
// `db.lock`, a cluster owns one per shard) and reports `'locked'` WITHOUT
// touching anything when it cannot: the caller must surface "someone else is
// writing this store" instead of destroying it.
//
// The removal itself renames the directory aside first and deletes the
// isolated copy, so the directory never exists in a half-deleted state: a
// crash mid-delete leaves only the `.wiping-*` sibling, never a store dir
// whose contents are partially gone. Windows needs the same EPERM retry as
// every other rename here (a co-process reader holding a file open blocks the
// rename until Windows releases it).

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LockFile } from './lockfile.js';
import { withWindowsEpermRetry } from './rename-replace.js';

export type WipeOutcome = 'wiped' | 'locked';

export interface WipeStoreDirOptions {
  readonly dir: string;
  /** How long to wait for a held lock before giving up (default: no wait). */
  readonly lockAcquireTimeoutMs?: number;
  /** Lock files relative to `dir` (default: ['db.lock']). */
  readonly lockFiles?: readonly string[];
}

async function acquireWithWait(lock: LockFile, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let delay = 10;
  for (;;) {
    if (await lock.acquire()) return true;
    if (Date.now() + delay > deadline) return false;
    const wait = delay + Math.floor(Math.random() * delay);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, wait);
    });
    delay = Math.min(delay * 2, 250);
  }
}

export async function wipeStoreDir(opts: WipeStoreDirOptions): Promise<WipeOutcome> {
  const lockFiles = opts.lockFiles ?? ['db.lock'];
  const timeoutMs = opts.lockAcquireTimeoutMs ?? 0;
  const locks = lockFiles.map((file) => new LockFile(path.join(opts.dir, file)));
  const releaseAll = (): Promise<unknown[]> =>
    Promise.all(locks.map((lock) => lock.release().catch(() => {})));
  const results = await Promise.allSettled(locks.map((lock) => acquireWithWait(lock, timeoutMs)));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed !== undefined || results.some((r) => r.status === 'fulfilled' && !r.value)) {
    await releaseAll();
    if (failed !== undefined) throw failed.reason;
    return 'locked';
  }
  try {
    const isolated = `${opts.dir}.wiping-${process.pid}-${randomUUID()}`;
    try {
      await withWindowsEpermRetry(() => fs.rename(opts.dir, isolated));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'wiped';
      throw error;
    }
    await fs.rm(isolated, { recursive: true, force: true });
  } finally {
    await releaseAll();
  }
  return 'wiped';
}
