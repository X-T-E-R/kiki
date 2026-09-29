import { mkdtemp, mkdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupOrphanedEphemeralSessions } from '#/persistence/backends/node-fs/ephemeralCleanup';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';

describe('ephemeral session startup cleanup', () => {
  let home: string | undefined;
  afterEach(async () => {
    if (home !== undefined) await rm(home, { recursive: true, force: true });
    home = undefined;
  });

  it('keeps an active owner and removes only dead or unlocked session directories', async () => {
    home = await mkdtemp(join(tmpdir(), 'ephemeral-cleanup-'));
    const liveScope = 'ephemeral/workspace/live';
    const deadScope = 'ephemeral/workspace/orphan';
    await mkdir(join(home, liveScope), { recursive: true });
    await mkdir(join(home, deadScope), { recursive: true });
    const lockKey = `${createHash('sha256').update(liveScope).digest('hex')}.lock`;
    const lock = await new FileStorageService(home).acquireLock('session-locks', lockKey, {
      owner: { sessionId: 'live', scope: liveScope },
    });
    try {
      expect(await cleanupOrphanedEphemeralSessions(home)).toBe(1);
      expect((await stat(join(home, liveScope))).isDirectory()).toBe(true);
      await expect(stat(join(home, deadScope))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await lock.release();
    }
  });
});
