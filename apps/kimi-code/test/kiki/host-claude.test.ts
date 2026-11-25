import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { claimWatcher } from '#/kiki/host-claude';

describe('claimWatcher lock protocol', () => {
  it('grants ownership to only one concurrent contender and verifies token on release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kiki-host-claude-lock-'));
    try {
      const results = await Promise.all([
        claimWatcher(dir),
        claimWatcher(dir),
        claimWatcher(dir),
        claimWatcher(dir),
      ]);
      const winners = results.filter((release): release is () => Promise<void> => release !== undefined);
      expect(winners).toHaveLength(1);

      const lockContent = JSON.parse(await readFile(join(dir, '.watch.lock'), 'utf8')) as { pid: number; token: string };
      expect(lockContent.pid).toBe(process.pid);
      expect(typeof lockContent.token).toBe('string');

      await writeFile(join(dir, '.watch.lock'), JSON.stringify({ pid: process.pid, token: 'other-owner' }), 'utf8');
      await winners[0]!();
      const remaining = JSON.parse(await readFile(join(dir, '.watch.lock'), 'utf8')) as { token: string };
      expect(remaining.token).toBe('other-owner');
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('does not unlink a freshly created empty lock file within the grace window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kiki-host-claude-empty-'));
    try {
      const lockPath = join(dir, '.watch.lock');
      await writeFile(lockPath, '', 'utf8');

      const release = await claimWatcher(dir);
      expect(release).toBeUndefined();
      expect(await readFile(lockPath, 'utf8')).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('reclaims a stale dead-PID lock file cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kiki-host-claude-stale-'));
    try {
      const lockPath = join(dir, '.watch.lock');
      await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: 'dead-owner' }), 'utf8');
      const oldTime = new Date(Date.now() - 10_000);
      await utimes(lockPath, oldTime, oldTime);

      const release = await claimWatcher(dir);
      expect(release).toBeDefined();
      await release!();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
