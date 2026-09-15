// src/cluster/wipe.ts
//
// Wipe a whole cluster directory under EVERY shard's own lock: a cluster holds
// one lock per shard, and a wipe that only took the parent directory's word
// for it would delete shards a peer is still writing.

import fs from 'node:fs/promises';
import path from 'node:path';
import { wipeStoreDir, type WipeOutcome } from '../wipe.js';
import { SHARD_DIR_PREFIX } from './utils.js';

export async function wipeCluster(opts: {
  dir: string;
  lockAcquireTimeoutMs?: number;
}): Promise<WipeOutcome> {
  const entries = await fs.readdir(opts.dir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
    throw error;
  });
  const lockFiles = entries
    .filter((entry) => entry.startsWith(SHARD_DIR_PREFIX))
    .map((entry) => path.join(entry, 'db.lock'));
  return wipeStoreDir({ ...opts, lockFiles });
}
