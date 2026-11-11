import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ManagedWriterOwner, RuntimeStore } from '../src/runtime/runtimeStore';
import type { ServerExitReceipt } from '../src/start';
import type { RuntimeRelease } from '../src/runtime/controller';
import { installedRuntimeReleases, verifiedRuntimeRelease } from '../src/runtime/releases';

const identity = { serverId: 'example-server', homeId: 'example-home', pid: process.pid, startedAt: 1,
  host: '127.0.0.1', port: 0, serverVersion: '1.0.0' };
const clean: ServerExitReceipt = { operationId: 'example-close', owner: 'backend', exitReason: 'requested',
  callerOutcome: 'resolved', cleanupOutcome: 'closed', resourcesAfter: 0, settledAt: 2 };

describe('durable managed writer ownership', () => {
  it('rejects a second writer and preserves the exact receipt and generation across reopen', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-runtime-owner-'));
    const owner = ManagedWriterOwner.acquire(home, identity);
    try {
      owner.update({ phase: 'ready', port: 1234 });
      expect(() => ManagedWriterOwner.acquire(home, identity)).toThrow('already owned');
      const reader = new RuntimeStore(home);
      try { expect(reader.writer()).toMatchObject({ generation: 1, phase: 'ready', port: 1234 }); }
      finally { reader.close(); }
      owner.finish(clean);
      const next = ManagedWriterOwner.acquire(home, { ...identity, serverId: 'next-example' });
      try {
        expect(next.state()).toMatchObject({ generation: 2, phase: 'starting', serverId: 'next-example' });
        expect(next.store.read(`writers/${owner.state().ownerId}`)).toMatchObject({ phase: 'exited', exitReceipt: clean });
      } finally { next.finish(clean); }
    } finally { await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });

  it('retains the writer lease after failed or unknown cleanup until cleanup is confirmed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-runtime-failed-'));
    const owner = ManagedWriterOwner.acquire(home, identity);
    try {
      for (const cleanupOutcome of ['cleanup_failed', 'unknown'] as const) {
        const badOwner = cleanupOutcome === 'cleanup_failed' ? owner : ManagedWriterOwner.acquire(home, identity);
        badOwner.finish({ ...clean, cleanupOutcome, resourcesAfter: undefined, callerOutcome: 'rejected' });
        expect(badOwner.store.writer()).toMatchObject({ phase: 'failed', exitReceipt: { cleanupOutcome } });
        expect(() => ManagedWriterOwner.acquire(home, identity)).toThrow('already owned');
        break;
      }
    } finally {
      (owner as unknown as { lease: { close(): void }; store: { close(): void } }).lease.close();
      owner.store.close();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('keeps controller and writer leases independent and rolls back an interrupted state update', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-runtime-controller-'));
    const store = new RuntimeStore(home);
    const writer = store.lease('writer'), controller = store.lease('controller');
    try {
      expect(() => store.lease('controller')).toThrow('already owned');
      store.write('operation', { phase: 'draining' });
      expect(() => store.transaction(() => { store.write('operation', { phase: 'starting' }); throw new Error('example interruption'); })).toThrow('example interruption');
      expect(store.read('operation')).toEqual({ phase: 'draining' });
    } finally { controller.close(); writer.close(); store.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });

  it('reads desktop-release current.json and build-info.txt releases without runtime-release.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-runtime-releases-'));
    const releaseId = `${'a'.repeat(24)}-${'b'.repeat(24)}`;
    const secondId = `${'c'.repeat(24)}-${'d'.repeat(24)}`;
    try {
      const firstDir = join(root, 'releases', releaseId);
      const secondDir = join(root, 'releases', secondId);
      await mkdir(firstDir, { recursive: true });
      await mkdir(secondDir, { recursive: true });
      const serverBytes = Buffer.from('example-server-binary');
      const desktopBytes = Buffer.from('example-desktop-binary');
      const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
      await writeFile(join(firstDir, 'kiki-server.exe'), serverBytes);
      await writeFile(join(firstDir, 'kiki-desktop.exe'), desktopBytes);
      await writeFile(join(root, 'current.json'), JSON.stringify({
        schemaVersion: 1,
        releaseId,
        gitSha: '1234567890abcdef',
        promotedAtUtc: '2026-11-11T00:00:00Z',
        files: {
          'kiki-server.exe': { sha256: sha(serverBytes), bytes: serverBytes.length },
          'kiki-desktop.exe': { sha256: sha(desktopBytes), bytes: desktopBytes.length },
        },
      }));
      await writeFile(join(secondDir, 'kiki-server.exe'), serverBytes);
      await writeFile(join(secondDir, 'kiki-desktop.exe'), desktopBytes);
      await writeFile(join(secondDir, 'build-info.txt'), 'gitSha: fedcba0987654321\n');
      const listed = await installedRuntimeReleases(root);
      expect(listed.map(item => item.releaseId).toSorted()).toEqual([releaseId, secondId].toSorted());
      const verified = await verifiedRuntimeRelease(root, releaseId);
      expect(verified.releaseId).toBe(releaseId);
      expect(verified.executable).toBe(join(firstDir, 'kiki-server.exe'));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});

async function controllerFixture() {
  const { RuntimeController } = await import('../src/runtime/controller');
  const home = await mkdtemp(join(tmpdir(), 'kiki-runtime-reconcile-'));
  const live = new Set<number>();
  const launches: string[] = [];
  let owner: ManagedWriterOwner | undefined;
  let sequence = 0;
  let rejectRelease: string | undefined;
  const release = (releaseId: string): RuntimeRelease => ({ releaseId, serverVersion: releaseId, executable: 'example-server', args: [], rollbackVerifiedWith: [] });
  const driver = {
    alive: (pid: number) => live.has(pid),
    probe: async () => true,
    prepare: async (_writer: unknown, operationId: string, action: 'prepare' | 'cancel') => {
      owner!.update({ phase: action === 'prepare' ? 'draining' : 'ready', operationId: action === 'prepare' ? operationId : undefined });
    },
    start: async (target: ReturnType<typeof release>) => {
      launches.push(target.releaseId);
      if (target.releaseId === rejectRelease) throw new Error('example startup failure');
      owner = ManagedWriterOwner.acquire(home, { ...identity, pid: ++sequence, serverId: `example-${sequence}`, serverVersion: target.serverVersion });
      owner.update({ phase: 'ready' });
      live.add(sequence);
    },
  };
  let controller = new RuntimeController(home, driver);
  await controller.ensure(release('old'));
  return { home, launches, release, get owner() { return owner!; }, get controller() { return controller; },
    reject: (id: string) => { rejectRelease = id; },
    stop: (receipt = clean) => { live.delete(owner!.state().pid); owner!.finish(receipt); },
    restart: async () => { await controller.close(); controller = new RuntimeController(home, driver); },
    close: async () => {
      if (owner !== undefined && owner.state().phase !== 'exited') {
        live.delete(owner.state().pid);
        if (owner.state().phase === 'failed') {
          (owner as unknown as { lease: { close(): void }; store: { close(): void } }).lease.close();
          owner.store.close();
        } else {
          owner.finish(clean);
        }
      }
      await controller.close();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    },
  };
}

describe('durable natural switch reconciliation', () => {
  it('reattaches the surviving writer after controller restart without starting or interrupting it', async () => {
    const f = await controllerFixture();
    try {
      const original = f.owner.state();
      await f.restart();
      await f.controller.reconcile();
      expect(f.launches).toEqual(['old']);
      expect(f.controller.status().writer?.ownerId).toBe(original.ownerId);
      expect(f.controller.status().writer?.phase).toBe('ready');
    } finally { await f.close(); }
  });

  it('keeps waiting through controller restart, allows cancellation, and activates only after clean exit', async () => {
    const f = await controllerFixture();
    try {
      const first = await f.controller.activate(f.release('next'));
      await f.restart();
      await f.controller.reconcile();
      expect(f.controller.status().operation).toMatchObject({ id: first.id, phase: 'draining' });
      expect(f.launches).toEqual(['old']);
      await f.controller.cancel(first.id);
      expect(f.owner.state()).toMatchObject({ phase: 'ready', operationId: undefined });
      const second = await f.controller.activate(f.release('next'));
      f.stop();
      await f.controller.reconcile();
      expect(f.launches).toEqual(['old', 'next']);
      expect(f.controller.status()).toMatchObject({ active: { releaseId: 'next' }, operation: { id: second.id, phase: 'completed' } });
    } finally { await f.close(); }
  });

  it('retains the clean-exit gate when transcript epoch sealing fails during shutdown', async () => {
    const f = await controllerFixture();
    try {
      await f.controller.activate(f.release('next'));
      f.stop({ ...clean, callerOutcome: 'rejected', cleanupOutcome: 'cleanup_failed',
        errorMessage: 'Transcript wire contents do not match accepted events', failureDomain: 'persistence' });
      await f.restart();
      await f.controller.reconcile();
      expect(f.launches).toEqual(['old']);
      expect(f.controller.status().operation).toMatchObject({ phase: 'failed', error: expect.stringContaining('no clean exit receipt') });
      expect(() => ManagedWriterOwner.acquire(f.home, identity)).toThrow('already owned');
    } finally { await f.close(); }
  });

  it('automatically restores the previous release after a clean candidate startup failure', async () => {
    const f = await controllerFixture();
    try {
      f.reject('broken');
      await f.controller.activate(f.release('broken'));
      f.stop();
      await f.controller.reconcile();
      expect(f.controller.status().operation?.phase).toBe('recovering');
      await f.restart();
      await f.controller.reconcile();
      expect(f.launches).toEqual(['old', 'broken', 'old']);
      expect(f.controller.status()).toMatchObject({ active: { releaseId: 'old' }, writer: { phase: 'ready' },
        operation: { phase: 'failed', error: 'example startup failure' } });
    } finally { await f.close(); }
  });

  it('offers rollback only for a release verified against the currently active canonical data', async () => {
    const f = await controllerFixture();
    try {
      await expect(f.controller.activate(f.release('previous'), 'rollback')).rejects.toThrow('canonical compatibility');
      const verified = { ...f.release('previous'), rollbackVerifiedWith: ['old'] };
      await f.controller.activate(verified, 'rollback');
      f.stop();
      await f.controller.reconcile();
      expect(f.controller.status()).toMatchObject({ active: { releaseId: 'previous' }, operation: { reason: 'rollback', phase: 'completed' } });
    } finally { await f.close(); }
  });
});
