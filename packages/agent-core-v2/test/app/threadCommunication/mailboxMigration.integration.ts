import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DatabaseSync } from 'node:sqlite';

import { LockFile, MiniDb } from '@kiki/minidb';
import { ClusterDb, shardDirName } from '@kiki/minidb/cluster';
import type { MailboxRow } from '#/persistence/backends/sqliteMailbox/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMailboxMigrationService } from '#/persistence/backends/sqliteMailbox/migration';
import { CanonicalMailboxDatabase } from '#/persistence/backends/sqliteMailbox/database';
import { assertMailboxStartupReady, assertMailboxStartupReadySync, authorityPath, migrationPath, readMailboxAuthority } from '#/persistence/backends/sqliteMailbox/authority';

let home: string;
const handles: Array<{ close(): Promise<void> }> = [];

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'kiki-mailbox-sqlite-')); });
afterEach(async () => { for (const handle of handles.splice(0).reverse()) await handle.close(); await rm(home, { recursive: true, force: true }); });

async function source(rows = 3): Promise<ClusterDb<Record<string, unknown>>> {
  const db = await ClusterDb.open<Record<string, unknown>>({ dir: join(home, 'store/thread-mailbox-v3'), shardCount: 2,
    valueCodec: 'json', valueMode: 'disk', fsyncPolicy: 'always', recovery: 'strict', activeExpireIntervalMs: 0, lockHoldMs: 0, lockPoolMaxShards: 2, crossShard: 'none' });
  await db.partitionBatch('w/test', Array.from({ length: rows }, (_, index) => ({ op: 'set' as const,
    key: `w/test/override/${index.toString().padStart(4, '0')}`, value: { kind: 'workspace_override', workspaceId: `workspace-${index}`, enabled: index % 2 === 0, updatedAt: index } })));
  return db;
}

describe('canonical mailbox SQLite migration', () => {
  it('freezes and preserves the old canonical source, imports it and publishes paired fences', async () => {
    const old = await source();
    await old.close();
    const migration = createMailboxMigrationService(home);
    handles.push(migration);
    const phases: string[] = [];
    const result = await migration.migrate({ onProgress: (status) => phases.push(status.phase) });
    expect(result.failure).toBeUndefined();
    expect(result.state).toBe('complete');
    expect(result.authority).toBe('sqlite');
    expect(phases).toEqual(expect.arrayContaining(['waiting_for_writers', 'backing_up', 'importing', 'verifying', 'switching', 'complete']));
    const authority = await readMailboxAuthority(home);
    expect(authority?.migrationId).toBe(result.migrationId);
    for (const name of ['thread-mailbox-v3', 'thread-mailbox-v1', 'agent-collaboration-mailbox-v2']) expect((await stat(join(home, 'store', name))).isFile()).toBe(true);
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!);
    handles.push(db);
    expect(await db.page('w/test/override/')).toHaveLength(3);
    expect((await db.verify()).counts['workspace_override']).toBe(3);
    const backup = join(home, 'restored.sqlite');
    expect((await migration.backup(backup)).items).toBe(3);
    const restored = new CanonicalMailboxDatabase<Record<string, unknown>>(backup);
    handles.push(restored);
    expect(await restored.page('w/test/override/')).toEqual(await db.page('w/test/override/'));
  });

  it('returns the live writer and leaves the source authoritative until it exits', async () => {
    const old = await source();
    const migration = createMailboxMigrationService(home);
    handles.push(migration);
    const waiting = await migration.migrate();
    expect(waiting.state).toBe('waiting');
    expect(waiting.phase).toBe('waiting_for_writers');
    expect(waiting.writer?.lockPath).toContain('db.lock');
    await expect(readFile(authorityPath(home))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(join(home, 'store/thread-mailbox-v3'))).isDirectory()).toBe(true);
    await old.close();
    const completed = await migration.migrate();
    expect(completed.failure).toBeUndefined();
    expect(completed.state).toBe('complete');
  });

  it('cancels after a committed import page and resumes without losing or duplicating rows', async () => {
    const old = await source(300);
    await old.close();
    const migration = createMailboxMigrationService(home);
    handles.push(migration);
    const controller = new AbortController();
    const stopped = await migration.migrate({ signal: controller.signal, onProgress: (status) => {
      if (status.phase === 'importing' && status.progress.items > 0) controller.abort();
    } });
    expect(stopped.state).toBe('cancelled');
    expect(stopped.progress.items).toBeGreaterThan(0);
    await expect(readFile(authorityPath(home))).rejects.toMatchObject({ code: 'ENOENT' });
    const completed = await migration.migrate();
    expect(completed.failure).toBeUndefined();
    expect(completed.state).toBe('complete');
    expect(completed.migrationId).toBe(stopped.migrationId);
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(completed.databasePath!);
    handles.push(db);
    expect(await db.prefix('w/test/override/')).toHaveLength(300);
    expect((await db.verify()).counts['workspace_override']).toBe(300);
  });

  it('imports a persistent legacy message beyond a full page that expires after the source opens, including cancel and resume', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      const target = { hostId: 'example-host', workspaceId: 'example-workspace', sessionId: 'example-target' };
      const sourceRef = { ...target, sessionId: 'example-source' };
      const message = { source: sourceRef, target, messageId: 'after-expiry-page', targetSeq: 1, acceptedAt: 1,
        content: 'durable message after TTL page', idempotencyKey: 'example-key' };
      const v1 = await MiniDb.open<Record<string, unknown>>({ dir: join(home, 'store/thread-mailbox-v1'), valueCodec: 'json', indexGenerations: false, fsyncPolicy: 'always', activeExpireIntervalMs: 0 });
      await v1.batch([
        ...Array.from({ length: 256 }, (_, index) => ({ op: 'set' as const, key: `activity/ghost/event/${String(index).padStart(16, '0')}`,
          value: { kind: 'activity_event', target, activity: { seq: index + 1, epoch: 'expired', kind: 'terminal', at: 1, reason: 'gone' } }, ttl: 5_000 })),
        { op: 'set', key: 'delivery/z-live', value: { kind: 'delivery', message, state: 'pending', attempt: 0, idempotencyStorageKey: 'idem/example-key' } },
      ]);
      await v1.close();
      const originalOpen = MiniDb.open.bind(MiniDb);
      let expiredAfterOpen = false;
      const open = vi.spyOn(MiniDb, 'open').mockImplementation(async (options) => {
        const db = await originalOpen(options);
        if (options.readOnly && options.dir.endsWith('thread-mailbox-v1') && !expiredAfterOpen) {
          expect([...db.store.scan({ gt: '', count: 1 })]).toHaveLength(1);
          vi.setSystemTime(now + 6_000);
          expect(db.get('delivery/z-live')).toBeDefined();
          expiredAfterOpen = true;
        }
        return db;
      });
      try {
        const migration = createMailboxMigrationService(home); handles.push(migration);
        const controller = new AbortController();
        const stopped = await migration.migrate({ signal: controller.signal, onProgress: (status) => {
          if (status.phase === 'importing' && status.currentSource?.startsWith('thread-mailbox-v1/') && status.progress.items > 0) controller.abort();
        } });
        expect(expiredAfterOpen).toBe(true);
        expect(stopped.state).toBe('cancelled');
        expect(stopped.progress.items).toBe(1);
        const completed = await migration.migrate();
        expect(completed.state).toBe('complete');
        const db = new CanonicalMailboxDatabase<Record<string, unknown>>(completed.databasePath!); handles.push(db);
        expect((await db.verify()).counts['message']).toBe(1);
        expect((await db.page(`t/${digest(target)}/message/`)).map((row) => (row.value['message'] as { messageId: string }).messageId)).toEqual(['after-expiry-page']);
      } finally { open.mockRestore(); }
    } finally { vi.useRealTimers(); }
  });

  it('preserves all canonical key kinds and absolute receipt TTL while completing historical peer coverage', async () => {
    const old = await source(0);
    const target = { hostId: 'example-host', workspaceId: 'example-workspace', sessionId: 'example-target' };
    const producer = { kind: 'room', roomId: 'example-room' };
    const partition = `t/${digest(target)}`;
    const messageKey = `${partition}/message/0000000000000009`;
    const idemKey = `${partition}/idempotency/example`;
    const message = { messageId: 'example-message', target, producer, targetSeq: 9, acceptedAt: 1, content: 'kept content', idempotencyKey: 'example-key' };
    await old.partitionBatch(partition, [
      { op: 'set', key: `${partition}/meta`, value: { kind: 'target_meta', target, nextMessageSeq: 10, nextDeliverableSeq: 9, pendingCount: 1, activityEpoch: 'example-epoch', nextActivitySeq: 8, minActivitySeq: 7 } },
      { op: 'set', key: messageKey, value: { kind: 'message', message, idempotencyStorageKey: idemKey, payloadHash: digest({ content: message.content }), state: 'delivering', fence: 3 } },
      { op: 'set', key: idemKey, value: { kind: 'idempotency', producer, target, idempotencyKey: 'example-key', payloadHash: digest({ content: message.content }), messageKey } },
      { op: 'set', key: `${partition}/activity/0000000000000007`, value: { kind: 'activity', target, activity: { seq: 7, epoch: 'example-epoch', kind: 'terminal', at: 1, reason: 'done' } } },
      { op: 'set', key: `${partition}/receipt/example`, value: { kind: 'receipt', requestId: 'example-request', result: { accepted: true } }, ttl: 60_000 },
      { op: 'set', key: `${partition}/migration`, value: { kind: 'migration_marker', version: 3, migratedAt: 1 } },
    ]);
    await old.partitionBatch('s/thread-mailbox-v3', [{ op: 'set', key: 's/thread-mailbox-v3/active-backend', value: { kind: 'active_backend', version: 3, ownerEpoch: 2, readyAt: 1 } }]);
    await old.partitionBatch('w/example', [{ op: 'set', key: 'w/example/override', value: { kind: 'workspace_override', workspaceId: 'example', enabled: false, updatedAt: 2 } }]);
    await old.close();
    const expected = await readSourceRows();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    expect(result.failure).toBeUndefined();
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!); handles.push(db);
    const actual = new Map((await db.page('', undefined, 256)).map((row) => [row.key, row]));
    for (const row of expected) expect(actual.get(row.key)).toEqual(row);
    expect(expected.find((row) => row.value['kind'] === 'receipt')!.expireAt).toBeGreaterThan(Date.now());
    expect(await db.metadata('peerHistoryComplete')).toBe(true);
    expect((await db.verify()).counts['peer_index']).toBe(3);
  });

  it('imports v1 and v2 identities, attempts, activity cursors and absolute idempotency expiration', async () => {
    const expiry = Date.now() + 90_000;
    const sourceRef = { hostId: 'example-host', workspaceId: 'example-source-workspace', sessionId: 'example-source-session' };
    const target = { hostId: 'example-host', workspaceId: 'example-workspace', sessionId: 'example-target' };
    const legacyMessage = { source: sourceRef, target, messageId: 'example-v1-message', targetSeq: 5, acceptedAt: 2, content: 'example legacy content', idempotencyKey: 'example-v1-key' };
    const v1 = await MiniDb.open<Record<string, unknown>>({ dir: join(home, 'store/thread-mailbox-v1'), valueCodec: 'json', indexGenerations: false, fsyncPolicy: 'always', activeExpireIntervalMs: 0 });
    await v1.batch([
      { op: 'set', key: 'delivery/example-v1-message', value: { kind: 'delivery', message: legacyMessage, state: 'delivering', attempt: 3, activeAttemptId: 'example-attempt', idempotencyStorageKey: 'idem/example-v1-key' } },
      { op: 'set', key: 'idem/example-v1-key', value: { kind: 'idempotency', source: sourceRef, target, messageId: legacyMessage.messageId, idempotencyKey: legacyMessage.idempotencyKey, payloadHash: digest({ content: legacyMessage.content }) }, ttl: expiry - Date.now() },
      { op: 'set', key: 'activity/meta', value: { kind: 'activity_meta', target, epoch: 'example-epoch', nextSeq: 9, minSeq: 7 } },
      { op: 'set', key: 'activity/event/7', value: { kind: 'activity_event', target, activity: { seq: 7, epoch: 'example-epoch', kind: 'terminal', at: 3, reason: 'done' } } },
    ]);
    const originalExpiry = v1.store.getRecord('idem/example-v1-key')!.expireAt;
    await v1.close();
    const v2Target = { hostId: 'agent-collaboration-v2', workspaceId: 'example-agent-session', sessionId: 'example-agent-target' };
    const v2Message = { ...legacyMessage, target: v2Target, messageId: 'example-v2-message', idempotencyKey: 'example-v2-key', targetSeq: 2,
      content: JSON.stringify({ v: 1, kind: 'agent_collaboration_message', sourceTaskName: 'example-source', targetTaskName: 'example-target', content: 'example v2 content' }) };
    const v2 = await MiniDb.open<Record<string, unknown>>({ dir: join(home, 'store/agent-collaboration-mailbox-v2'), valueCodec: 'json', indexGenerations: false, fsyncPolicy: 'always', activeExpireIntervalMs: 0 });
    await v2.batch([{ op: 'set', key: 'delivery/example-v2-message', value: { kind: 'delivery', message: v2Message, state: 'pending', attempt: 1, idempotencyStorageKey: 'idem/example-v2-key' } }]);
    await v2.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    expect(result.failure).toBeUndefined();
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!); handles.push(db);
    const rows = await db.page('', undefined, 256);
    const normalized = (message: typeof legacyMessage) => { const { source: producerSource, ...fields } = message; return { ...fields, producer: { kind: 'peer_thread', source: producerSource } }; };
    expect(rows.filter((row) => row.value['kind'] === 'message').map((row) => row.value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: normalized(legacyMessage), state: 'delivering', fence: 4, legacyAttempt: { attempt: 3, activeAttemptId: 'example-attempt', sourceKey: 'delivery/example-v1-message' } }),
      expect.objectContaining({ message: normalized(v2Message), state: 'pending', fence: 1 }),
    ]));
    expect(rows.find((row) => row.value['kind'] === 'idempotency' && row.value['messageId'] === legacyMessage.messageId)?.expireAt).toBe(originalExpiry);
    expect(rows.find((row) => row.value['kind'] === 'target_meta' && JSON.stringify(row.value['target']) === JSON.stringify(target))?.value).toMatchObject({ nextMessageSeq: 6, nextDeliverableSeq: 5, pendingCount: 1, activityEpoch: 'example-epoch', nextActivitySeq: 9, minActivitySeq: 7 });
    expect((await db.verify()).counts['message']).toBe(2);
  });

  it('keeps the established activity epoch and archives a superseded legacy activity stream', async () => {
    const target = { hostId: 'example-host', workspaceId: 'example-workspace', sessionId: 'example-target' };
    const partition = `t/${digest(target)}`;
    const old = await source(0);
    await old.partitionBatch(partition, [
      { op: 'set', key: `${partition}/meta`, value: { kind: 'target_meta', target, nextMessageSeq: 1, nextDeliverableSeq: 1, pendingCount: 0, activityEpoch: 'current-epoch', nextActivitySeq: 3, minActivitySeq: 1 } },
      { op: 'set', key: `${partition}/activity/0000000000000001`, value: { kind: 'activity', target, activity: { seq: 1, epoch: 'current-epoch', kind: 'terminal', at: 1, reason: 'done' } } },
      { op: 'set', key: `${partition}/activity/0000000000000002`, value: { kind: 'activity', target, activity: { seq: 2, epoch: 'current-epoch', kind: 'terminal', at: 2, reason: 'done' } } },
    ]);
    await old.close();
    const v1 = await MiniDb.open<Record<string, unknown>>({ dir: join(home, 'store/thread-mailbox-v1'), valueCodec: 'json', indexGenerations: false, fsyncPolicy: 'always', activeExpireIntervalMs: 0 });
    await v1.batch([
      { op: 'set', key: 'activity/meta', value: { kind: 'activity_meta', target, epoch: 'superseded-epoch', nextSeq: 5, minSeq: 1 } },
      { op: 'set', key: 'activity/event/1', value: { kind: 'activity_event', target, activity: { seq: 1, epoch: 'superseded-epoch', kind: 'terminal', at: 0, reason: 'superseded' } } },
      { op: 'set', key: 'activity/event/2', value: { kind: 'activity_event', target, activity: { seq: 2, epoch: 'superseded-epoch', kind: 'attention', at: 0, reason: 'superseded' } } },
      { op: 'set', key: 'activity/event/4', value: { kind: 'activity_event', target, activity: { seq: 4, epoch: 'superseded-epoch', kind: 'terminal', at: 0, reason: 'superseded' } } },
    ]);
    await v1.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    expect(result.failure).toBeUndefined();
    expect(result.state).toBe('complete');
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!); handles.push(db);
    expect((await db.page(`${partition}/meta`)).map((row) => row.value['activityEpoch'])).toEqual(['current-epoch']);
    expect((await db.page(`${partition}/meta`)).map((row) => row.value['nextActivitySeq'])).toEqual([3]);
    const activities = await db.page(`${partition}/activity/`);
    expect(activities.map((row) => (row.value['activity'] as { epoch: string }).epoch)).toEqual(['current-epoch', 'current-epoch']);
    expect(activities.map((row) => (row.value['activity'] as { seq: number }).seq)).toEqual([1, 2]);
  });

  it('merges legacy activity events that still belong to the established epoch', async () => {
    const target = { hostId: 'example-host', workspaceId: 'example-workspace', sessionId: 'example-target' };
    const partition = `t/${digest(target)}`;
    const old = await source(0);
    await old.partitionBatch(partition, [
      { op: 'set', key: `${partition}/meta`, value: { kind: 'target_meta', target, nextMessageSeq: 1, nextDeliverableSeq: 1, pendingCount: 0, activityEpoch: 'current-epoch', nextActivitySeq: 2, minActivitySeq: 1 } },
      { op: 'set', key: `${partition}/activity/0000000000000001`, value: { kind: 'activity', target, activity: { seq: 1, epoch: 'current-epoch', kind: 'terminal', at: 1, reason: 'done' } } },
    ]);
    await old.close();
    const v1 = await MiniDb.open<Record<string, unknown>>({ dir: join(home, 'store/thread-mailbox-v1'), valueCodec: 'json', indexGenerations: false, fsyncPolicy: 'always', activeExpireIntervalMs: 0 });
    await v1.batch([
      { op: 'set', key: 'activity/meta', value: { kind: 'activity_meta', target, epoch: 'current-epoch', nextSeq: 4, minSeq: 1 } },
      { op: 'set', key: 'activity/event/2', value: { kind: 'activity_event', target, activity: { seq: 2, epoch: 'current-epoch', kind: 'attention', at: 2, reason: 'approval' } } },
      { op: 'set', key: 'activity/event/3', value: { kind: 'activity_event', target, activity: { seq: 3, epoch: 'current-epoch', kind: 'terminal', at: 3, reason: 'completed' } } },
    ]);
    await v1.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    expect(result.failure).toBeUndefined();
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!); handles.push(db);
    expect((await db.page(`${partition}/meta`)).map((row) => row.value['nextActivitySeq'])).toEqual([4]);
    expect((await db.page(`${partition}/activity/`)).map((row) => (row.value['activity'] as { seq: number }).seq)).toEqual([1, 2, 3]);
  });

  it('keeps recovery copies but removes temporary archive bytes from the completed SQLite database', async () => {
    const old = await source(0);
    const payload = 'x'.repeat(512 * 1024);
    await old.partitionBatch('w/test', [{ op: 'set', key: 'w/test/override/large', value: { kind: 'workspace_override', workspaceId: 'large', enabled: true, updatedAt: 1, payload } }]);
    await old.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    expect(result.failure).toBeUndefined();
    const db = new DatabaseSync(result.databasePath!, { readOnly: true });
    try {
      expect(Number(db.prepare('SELECT count(*) n FROM legacy_archive').get()!['n'])).toBe(0);
      expect(Number(db.prepare('PRAGMA auto_vacuum').get()!['auto_vacuum'])).toBe(2);
      expect(Number(db.prepare('PRAGMA freelist_count').get()!['freelist_count'])).toBe(0);
    } finally { db.close(); }
    const bytes = (await stat(result.databasePath!)).size;
    expect(bytes).toBeLessThan(850 * 1024);
    expect((await stat(join(result.backupPath!, 'thread-mailbox-v3'))).isDirectory()).toBe(true);
    expect((await stat(join(home, 'store/thread-mailbox-sqlite-v1/recovery', result.migrationId!, 'originals/thread-mailbox-v3'))).isDirectory()).toBe(true);
  });

  it('previews and explicitly removes only matching frozen copies after new writes and an independent SQLite backup', async () => {
    const old = await source(3); await old.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    expect(result.state).toBe('complete');
    await expect(migration.cleanupRecovery()).rejects.toThrow('rollback is still available');
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!);
    try {
      await db.claimOwner({ hostId: 'fixture-owner', epoch: 1_000 });
      await db.partitionBatch('w/test', [{ op: 'set', key: 'w/test/override/new', value: { kind: 'workspace_override', workspaceId: 'new', enabled: true, updatedAt: 2 } }]);
    } finally { await db.close(); }
    const priorDatabase = new DatabaseSync(result.databasePath!);
    try {
      priorDatabase.exec('PRAGMA auto_vacuum=NONE; VACUUM');
      priorDatabase.prepare('INSERT INTO legacy_archive(source,key,json,expire_at) VALUES(?,?,?,?)').run('old/import', 'example-legacy',
        JSON.stringify({ kind: 'delivery', payload: 'x'.repeat(512 * 1024) }), 0);
      expect(priorDatabase.prepare('PRAGMA auto_vacuum').get()!['auto_vacuum']).toBe(0);
    } finally { priorDatabase.close(); }
    const inflatedBytes = (await stat(result.databasePath!)).size;
    const preview = await migration.cleanupRecovery();
    expect(preview.completed).toBe(false);
    expect(preview.remove).toHaveLength(1);
    expect(preview.remove[0]!.path).toBe(join(result.backupPath!, 'thread-mailbox-v3'));
    expect(preview.removeBytes).toBeGreaterThan(0);
    expect(preview.preserveBytes).toBeGreaterThan(0);
    expect(preview.removeBytes).toBe(preview.preserveBytes);
    await expect(migration.cleanupRecovery({ confirm: true, backupDestination: join(home, 'bad.sqlite') })).rejects.toThrow('outside this Kiki home');
    const external = await mkdtemp(join(tmpdir(), 'kiki-mailbox-cleanup-'));
    try {
      const snapshot = join(external, 'mailbox.sqlite');
      const cleaned = await migration.cleanupRecovery({ confirm: true, backupDestination: snapshot });
      expect(cleaned).toMatchObject({ completed: true, backupDestination: snapshot, removeBytes: preview.removeBytes });
      await expect(stat(preview.remove[0]!.path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(preview.preserve[0]!.path)).isDirectory()).toBe(true);
      const backup = new CanonicalMailboxDatabase<Record<string, unknown>>(snapshot, false, true);
      try {
        expect((await backup.verify()).counts['workspace_override']).toBe(4);
        expect(await backup.metadata<string>('authority')).toBe('sqlite');
      } finally { await backup.close(); }
      const compacted = new DatabaseSync(result.databasePath!, { readOnly: true });
      try { expect(Number(compacted.prepare('SELECT count(*) n FROM legacy_archive').get()!['n'])).toBe(0); }
      finally { compacted.close(); }
      expect((await stat(result.databasePath!)).size).toBeLessThan(inflatedBytes - 400 * 1024);
      expect((await migration.cleanupRecovery()).removeBytes).toBe(0);
    } finally { await rm(external, { recursive: true, force: true }); }
  });

  it('refuses recovery cleanup when the frozen copy differs from its original', async () => {
    const old = await source(1); await old.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!);
    try {
      await db.claimOwner({ hostId: 'fixture-owner', epoch: 1_000 });
      await db.partitionBatch('w/test', [{ op: 'set', key: 'w/test/override/new', value: { kind: 'workspace_override', workspaceId: 'new', enabled: true, updatedAt: 2 } }]);
    } finally { await db.close(); }
    const manifest = JSON.parse(await readFile(migrationPath(home), 'utf8'));
    const first = manifest.files.find((file: { source: string }) => file.source === 'thread-mailbox-v3');
    await writeFile(join(result.backupPath!, first.source, first.relative), 'damaged frozen copy');
    await expect(migration.cleanupRecovery()).rejects.toThrow('differs from original');
    expect((await stat(join(result.backupPath!, first.source))).isDirectory()).toBe(true);
  });

  it('keeps recovery copies if a legacy writer still owns an original shard', async () => {
    const old = await source(1); await old.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!);
    try {
      await db.claimOwner({ hostId: 'fixture-owner', epoch: 1_000 });
      await db.partitionBatch('w/test', [{ op: 'set', key: 'w/test/override/new', value: { kind: 'workspace_override', workspaceId: 'new', enabled: true, updatedAt: 2 } }]);
    } finally { await db.close(); }
    const original = join(home, 'store/thread-mailbox-sqlite-v1/recovery', result.migrationId!, 'originals/thread-mailbox-v3');
    const lock = new LockFile(join(original, shardDirName(0, 2), 'db.lock'));
    expect(await lock.acquire()).toBe(true);
    const external = await mkdtemp(join(tmpdir(), 'kiki-mailbox-cleanup-'));
    try {
      const destination = join(external, 'mailbox.sqlite');
      await expect(migration.cleanupRecovery({ confirm: true, backupDestination: destination })).rejects.toThrow('legacy writer still holds');
      await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(join(result.backupPath!, 'thread-mailbox-v3'))).isDirectory()).toBe(true);
    } finally { await lock.release(); await rm(external, { recursive: true, force: true }); }
  });

  it('resumes an interrupted recovery cleanup only with its original verified independent backup', async () => {
    const old = await source(2); await old.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!);
    try {
      await db.claimOwner({ hostId: 'fixture-owner', epoch: 1_000 });
      await db.partitionBatch('w/test', [{ op: 'set', key: 'w/test/override/new', value: { kind: 'workspace_override', workspaceId: 'new', enabled: true, updatedAt: 2 } }]);
    } finally { await db.close(); }
    const external = await mkdtemp(join(tmpdir(), 'kiki-mailbox-cleanup-'));
    try {
      const snapshot = join(external, 'mailbox.sqlite');
      await migration.backup(snapshot);
      const recovery = join(home, 'store/thread-mailbox-sqlite-v1/recovery', result.migrationId!);
      await writeFile(join(recovery, 'cleanup.json'), JSON.stringify({ version: 1, migrationId: result.migrationId!, backupDestination: snapshot,
        mailboxOwner: { hostId: 'fixture-owner', epoch: 1_000 } }));
      const manifest = JSON.parse(await readFile(migrationPath(home), 'utf8'));
      const first = manifest.files.find((file: { source: string }) => file.source === 'thread-mailbox-v3');
      await rm(join(result.backupPath!, first.source, first.relative));
      const preview = await migration.cleanupRecovery();
      expect(preview.removeBytes).toBeGreaterThan(0);
      await expect(migration.cleanupRecovery({ confirm: true, backupDestination: join(external, 'different.sqlite') })).rejects.toThrow('original verified backup');
      const resumed = await migration.cleanupRecovery({ confirm: true, backupDestination: snapshot });
      expect(resumed.completed).toBe(true);
      expect((await stat(join(recovery, 'originals', 'thread-mailbox-v3'))).isDirectory()).toBe(true);
      expect((await migration.cleanupRecovery()).completed).toBe(true);
    } finally { await rm(external, { recursive: true, force: true }); }
  });

  it('requires a fresh independent backup when writes happened after an interrupted cleanup', async () => {
    const old = await source(1); await old.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!);
    try {
      await db.claimOwner({ hostId: 'first-writer', epoch: 1_000 });
      await db.partitionBatch('w/test', [{ op: 'set', key: 'w/test/override/first', value: { kind: 'workspace_override', workspaceId: 'first', enabled: true, updatedAt: 2 } }]);
    } finally { await db.close(); }
    const external = await mkdtemp(join(tmpdir(), 'kiki-mailbox-cleanup-'));
    try {
      const snapshot = join(external, 'old.sqlite');
      await migration.backup(snapshot);
      const markerPath = join(home, 'store/thread-mailbox-sqlite-v1/recovery', result.migrationId!, 'cleanup.json');
      await writeFile(markerPath, JSON.stringify({ version: 1, migrationId: result.migrationId!, backupDestination: snapshot,
        mailboxOwner: { hostId: 'first-writer', epoch: 1_000 } }));
      const newer = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!);
      try {
        await newer.claimOwner({ hostId: 'next-writer', epoch: 1_001 });
        await newer.partitionBatch('w/test', [{ op: 'set', key: 'w/test/override/latest', value: { kind: 'workspace_override', workspaceId: 'latest', enabled: true, updatedAt: 3 } }]);
      } finally { await newer.close(); }
      await expect(migration.cleanupRecovery({ confirm: true, backupDestination: snapshot })).rejects.toThrow('new --backup destination');
      expect((await stat(join(result.backupPath!, 'thread-mailbox-v3'))).isDirectory()).toBe(true);
      const fresh = join(external, 'current.sqlite');
      expect((await migration.cleanupRecovery({ confirm: true, backupDestination: fresh })).completed).toBe(true);
      const backup = new CanonicalMailboxDatabase<Record<string, unknown>>(fresh, false, true);
      try { expect((await backup.verify()).counts['workspace_override']).toBe(3); }
      finally { await backup.close(); }
    } finally { await rm(external, { recursive: true, force: true }); }
  });

  it('rejects an outside backup path whose junction resolves inside the home, including a missing nested parent', async () => {
    const old = await source(1); await old.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!);
    try {
      await db.claimOwner({ hostId: 'fixture-owner', epoch: 1_000 });
      await db.partitionBatch('w/test', [{ op: 'set', key: 'w/test/override/new', value: { kind: 'workspace_override', workspaceId: 'new', enabled: true, updatedAt: 2 } }]);
    } finally { await db.close(); }
    const external = await mkdtemp(join(tmpdir(), 'kiki-mailbox-link-'));
    const alias = join(external, 'linked-home');
    try {
      await symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const destination = join(alias, 'missing-parent', 'backup.sqlite');
      await expect(migration.cleanupRecovery({ confirm: true, backupDestination: destination })).rejects.toThrow('outside this Kiki home');
      await expect(stat(join(home, 'missing-parent'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(join(result.backupPath!, 'thread-mailbox-v3'))).isDirectory()).toBe(true);
    } finally { await rm(alias, { force: true }); await rm(external, { recursive: true, force: true }); }
  });

  it('retains recovery when the backup parent becomes a home junction after the backup finishes', async () => {
    const old = await source(1); await old.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!);
    try {
      await db.claimOwner({ hostId: 'fixture-owner', epoch: 1_000 });
      await db.partitionBatch('w/test', [{ op: 'set', key: 'w/test/override/new', value: { kind: 'workspace_override', workspaceId: 'new', enabled: true, updatedAt: 2 } }]);
    } finally { await db.close(); }
    const external = await mkdtemp(join(tmpdir(), 'kiki-mailbox-link-'));
    const parent = join(external, 'backup-parent');
    const moved = join(external, 'original-parent');
    await mkdir(parent);
    try {
      const realBackup = migration.backup.bind(migration);
      vi.spyOn(migration, 'backup').mockImplementation(async (destination, options) => {
        const saved = await realBackup(destination, options);
        await rename(parent, moved);
        await symlink(home, parent, process.platform === 'win32' ? 'junction' : 'dir');
        return saved;
      });
      await expect(migration.cleanupRecovery({ confirm: true, backupDestination: join(parent, 'backup.sqlite') })).rejects.toThrow('outside this Kiki home');
      expect((await stat(join(moved, 'backup.sqlite'))).isFile()).toBe(true);
      expect((await stat(join(result.backupPath!, 'thread-mailbox-v3'))).isDirectory()).toBe(true);
    } finally { vi.restoreAllMocks(); await rm(parent, { force: true }); await rm(external, { recursive: true, force: true }); }
  });

  it('keeps recovery if another ordinary external file replaces the verified backup before deletion', async () => {
    const old = await source(1); await old.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!);
    try {
      await db.claimOwner({ hostId: 'fixture-owner', epoch: 1_000 });
      await db.partitionBatch('w/test', [{ op: 'set', key: 'w/test/override/new', value: { kind: 'workspace_override', workspaceId: 'new', enabled: true, updatedAt: 2 } }]);
    } finally { await db.close(); }
    const external = await mkdtemp(join(tmpdir(), 'kiki-mailbox-cleanup-'));
    try {
      const destination = join(external, 'backup.sqlite');
      const replacement = join(external, 'replacement.sqlite');
      await writeFile(replacement, 'ordinary unrelated file');
      const realClose = CanonicalMailboxDatabase.prototype.close;
      vi.spyOn(CanonicalMailboxDatabase.prototype, 'close').mockImplementation(async function (this: CanonicalMailboxDatabase<Record<string, unknown>>) {
        await realClose.call(this);
        if (this.database === destination) {
          await rename(destination, join(external, 'verified.sqlite'));
          await rename(replacement, destination);
        }
      });
      await expect(migration.cleanupRecovery({ confirm: true, backupDestination: destination })).rejects.toThrow('backup changed after verification');
      expect((await stat(join(result.backupPath!, 'thread-mailbox-v3'))).isDirectory()).toBe(true);
    } finally { vi.restoreAllMocks(); await rm(external, { recursive: true, force: true }); }
  });

  it('retains a frozen copy changed after the independent backup but before deletion', async () => {
    const old = await source(1); await old.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!);
    try {
      await db.claimOwner({ hostId: 'fixture-owner', epoch: 1_000 });
      await db.partitionBatch('w/test', [{ op: 'set', key: 'w/test/override/new', value: { kind: 'workspace_override', workspaceId: 'new', enabled: true, updatedAt: 2 } }]);
    } finally { await db.close(); }
    const manifest = JSON.parse(await readFile(migrationPath(home), 'utf8'));
    const first = manifest.files.find((file: { source: string }) => file.source === 'thread-mailbox-v3');
    const frozen = join(result.backupPath!, first.source, first.relative);
    const original = await readFile(frozen);
    const external = await mkdtemp(join(tmpdir(), 'kiki-mailbox-cleanup-'));
    try {
      const realBackup = migration.backup.bind(migration);
      vi.spyOn(migration, 'backup').mockImplementation(async (destination, options) => {
        const saved = await realBackup(destination, options);
        const changed = Buffer.from(original);
        const firstByte = changed.at(0);
        if (firstByte === undefined) throw new Error('Fixture expected a nonempty frozen source file');
        changed[0] = firstByte ^ 1;
        await writeFile(frozen, changed);
        return saved;
      });
      await expect(migration.cleanupRecovery({ confirm: true, backupDestination: join(external, 'backup.sqlite') })).rejects.toThrow('differs from original');
      expect((await stat(join(result.backupPath!, first.source))).isDirectory()).toBe(true);
      expect((await stat(frozen)).isFile()).toBe(true);
    } finally { vi.restoreAllMocks(); await rm(external, { recursive: true, force: true }); }
  });

  it('uses each real legacy activity meta key before earlier-sorted mixed-epoch events', async () => {
    const old = await source(0); await old.close();
    const targets = ['first', 'second'].map((sessionId) => ({ hostId: 'example-host', workspaceId: 'example-workspace', sessionId }));
    const v1 = await MiniDb.open<Record<string, unknown>>({ dir: join(home, 'store/thread-mailbox-v1'), valueCodec: 'json', indexGenerations: false, fsyncPolicy: 'always', activeExpireIntervalMs: 0 });
    for (const target of targets) {
      const key = `activity/${digest(target)}`;
      await v1.batch([
        { op: 'set', key: `${key}/event/0000000000000001`, value: { kind: 'activity_event', target,
          activity: { seq: 1, epoch: target.sessionId === 'first' ? 'old-epoch' : 'current-epoch', kind: 'attention', at: 1, reason: 'old warning' } } },
        { op: 'set', key: `${key}/event/0000000000000002`, value: { kind: 'activity_event', target,
          activity: { seq: 2, epoch: 'current-epoch', kind: 'terminal', at: 2, reason: 'new completed' } } },
        { op: 'set', key: `${key}/meta`, value: { kind: 'activity_meta', target, epoch: 'current-epoch', nextSeq: 3, minSeq: 1 } },
      ]);
    }
    await v1.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    expect(result.failure).toBeUndefined();
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!); handles.push(db);
    for (const target of targets) {
      const partition = `t/${digest(target)}`;
      const meta = (await db.partitionGet(partition, `${partition}/meta`))!;
      expect(meta).toMatchObject({ activityEpoch: 'current-epoch', nextActivitySeq: 3 });
      const activities = await db.page(`${partition}/activity/`);
      expect(activities.map((entry) => (entry.value['activity'] as { seq: number }).seq)).toEqual(target.sessionId === 'first' ? [2] : [1, 2]);
    }
  });

  it('appends distinct legacy messages in original target order when both sequence positions are occupied', async () => {
    const target = { hostId: 'example-host', workspaceId: 'example-workspace', sessionId: 'example-target' };
    const sourceRef = { ...target, sessionId: 'example-source' };
    const producer = { kind: 'peer_thread', source: sourceRef };
    const partition = `t/${digest(target)}`;
    const old = await source(0);
    const existing = [1, 2].map((seq) => ({ messageId: `canonical-${seq}`, producer, target, content: `original-${seq}`, idempotencyKey: `original-${seq}`, acceptedAt: seq, targetSeq: seq }));
    await old.partitionBatch(partition, [
      { op: 'set', key: `${partition}/meta`, value: { kind: 'target_meta', target, nextMessageSeq: 3, nextDeliverableSeq: 1, pendingCount: 2, activityEpoch: 'existing', nextActivitySeq: 1, minActivitySeq: 1 } },
      ...existing.map((message) => ({ op: 'set' as const, key: `${partition}/message/${message.targetSeq.toString().padStart(16, '0')}`,
        value: { kind: 'message', message, idempotencyStorageKey: `example-canonical-${message.targetSeq}`, payloadHash: digest({ content: message.content }), state: 'pending', fence: 0 } })),
    ]);
    await old.close();
    const v1 = await MiniDb.open<Record<string, unknown>>({ dir: join(home, 'store/thread-mailbox-v1'), valueCodec: 'json', indexGenerations: false, fsyncPolicy: 'always', activeExpireIntervalMs: 0 });
    await v1.batch([
      { op: 'set', key: 'delivery/z-first', value: { kind: 'delivery', message: { ...existing[0], source: sourceRef, producer: undefined, messageId: 'legacy-first', content: 'first', idempotencyKey: 'first' }, idempotencyStorageKey: 'idem/first', state: 'pending', attempt: 0 } },
      { op: 'set', key: 'delivery/a-second', value: { kind: 'delivery', message: { ...existing[1], source: sourceRef, producer: undefined, messageId: 'legacy-second', content: 'second', idempotencyKey: 'second' }, idempotencyStorageKey: 'idem/second', state: 'pending', attempt: 0 } },
    ]);
    await v1.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    expect(result.failure).toBeUndefined();
    expect(result.sources.filter((entry) => entry.exists).every((entry) => entry.stage === 'verified')).toBe(true);
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!); handles.push(db);
    const messages = await db.page(`${partition}/message/`);
    expect(messages.map((entry) => (entry.value['message'] as { messageId: string; targetSeq: number }).messageId)).toEqual([
      'canonical-1', 'canonical-2', 'legacy-first', 'legacy-second',
    ]);
    expect(messages.map((entry) => (entry.value['message'] as { targetSeq: number }).targetSeq)).toEqual([1, 2, 3, 4]);
    expect((await db.partitionGet(partition, `${partition}/meta`))?.['pendingCount']).toBe(4);
    expect((await db.verify()).counts['message']).toBe(4);
    expect((await db.page(`${partition}/idempotency/`)).map((row) => row.value['messageKey']).toSorted()).toEqual([
      `${partition}/message/0000000000000003`, `${partition}/message/0000000000000004`,
    ]);
  });

  it('keeps a true message-id content conflict unresolved with its exact legacy row', async () => {
    const target = { hostId: 'example-host', workspaceId: 'example-workspace', sessionId: 'example-target' };
    const sourceRef = { ...target, sessionId: 'example-source' };
    const partition = `t/${digest(target)}`;
    const old = await source(0);
    const message = { messageId: 'shared-id', producer: { kind: 'peer_thread', source: sourceRef }, target,
      content: 'original content', idempotencyKey: 'original', acceptedAt: 1, targetSeq: 1 };
    await old.partitionBatch(partition, [
      { op: 'set', key: `${partition}/meta`, value: { kind: 'target_meta', target, nextMessageSeq: 2, nextDeliverableSeq: 1, pendingCount: 1, activityEpoch: 'existing', nextActivitySeq: 1, minActivitySeq: 1 } },
      { op: 'set', key: `${partition}/message/0000000000000001`, value: { kind: 'message', message,
        idempotencyStorageKey: 'canonical-idempotency', payloadHash: digest({ content: message.content }), state: 'pending', fence: 0 } },
    ]);
    await old.close();
    const v1 = await MiniDb.open<Record<string, unknown>>({ dir: join(home, 'store/thread-mailbox-v1'), valueCodec: 'json', indexGenerations: false, fsyncPolicy: 'always', activeExpireIntervalMs: 0 });
    await v1.batch([{ op: 'set', key: 'delivery/changed', value: { kind: 'delivery', message: { ...message, content: 'different content' },
      idempotencyStorageKey: 'idem/changed', state: 'pending', attempt: 0 } }]);
    await v1.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const failed = await migration.migrate();
    expect(failed).toMatchObject({ state: 'failed', authority: 'legacy', failure: { key: 'delivery/changed', source: expect.stringContaining('thread-mailbox-v1'), message: expect.stringContaining('Conflicting legacy message identity') } });
    await expect(readFile(authorityPath(home))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(join(home, 'store/thread-mailbox-v1'))).isDirectory()).toBe(true);
    expect((await stat(join(failed.backupPath!, 'thread-mailbox-v1'))).isDirectory()).toBe(true);
  });

  it('reports the source that failed instead of the previously imported one', async () => {
    const old = await source(0);
    await old.partitionBatch('w/test', [{ op: 'set', key: 'w/test/override/0001', value: { kind: 'workspace_override', workspaceId: 'workspace', enabled: true, updatedAt: 1 } }]);
    await old.close();
    const target = { hostId: 'example-host', workspaceId: 'example-workspace', sessionId: 'example-target' };
    const v1 = await MiniDb.open<Record<string, unknown>>({ dir: join(home, 'store/thread-mailbox-v1'), valueCodec: 'json', indexGenerations: false, fsyncPolicy: 'always', activeExpireIntervalMs: 0 });
    await v1.batch([{ op: 'set', key: 'activity/event/0', value: { kind: 'activity_event', target, activity: { seq: 0, epoch: 'example-epoch', kind: 'terminal', at: 1, reason: 'done' } } }]);
    await v1.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    expect(result.state).toBe('failed');
    expect(result.failure?.source).toContain('thread-mailbox-v1');
    expect(result.failure?.key).toBe('activity/event/0');
    expect(result.failure?.message).toContain('Invalid legacy mailbox record');
    expect(result.progress.items).toBeGreaterThan(0);
    expect(result.sources.find((source) => source.name === 'thread-mailbox-v3')?.stage).toBe('imported');
    expect(result.sources.find((source) => source.name === 'thread-mailbox-v1')?.stage).toBe('importing');
    expect((await migration.status()).progress).toEqual(result.progress);
  });

  describe('switching recovery after a legacy writer restart', () => {
    beforeEach(async () => {
      const old = await source(); await old.close();
      const crash = await crashAt('switching');
      expect(crash.output).toContain('"boundary":"switching"');
      expect(crash.code).not.toBe(0);
    });

    it('rejects the changed source, then preserves it through explicit rollback and reimport', async () => {
      const changed = await source(4); await changed.close();
      const migration = createMailboxMigrationService(home); handles.push(migration);
      const refused = await migration.migrate();
      expect(refused.state).toBe('failed');
      expect(refused.failure?.message).toContain('changed while frozen');
      await expect(readFile(authorityPath(home))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await migration.rollback()).authority).toBe('legacy');
      const completed = await migration.migrate();
      expect(completed.failure).toBeUndefined();
      const db = new CanonicalMailboxDatabase<Record<string, unknown>>(completed.databasePath!); handles.push(db);
      expect(await db.prefix('w/test/override/')).toHaveLength(4);
    });
  });

  it.each(['switching', 'fenced', 'complete'])('resumes a real process crash at %s without publishing an empty mailbox', async (boundary) => {
    const old = await source(); await old.close();
    const crash = await crashAt(boundary);
    expect(crash.output).toContain(`"boundary":"${boundary}"`);
    expect(crash.code).not.toBe(0);
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const result = await migration.migrate();
    expect(result.failure, crash.errors).toBeUndefined();
    expect(result.state).toBe('complete');
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(result.databasePath!); handles.push(db);
    expect(await db.prefix('w/test/override/')).toHaveLength(3);
  });

  it('starts an empty home and active SQLite without requiring historical backup progress', async () => {
    await expect(assertMailboxStartupReady(home)).resolves.toBeUndefined();
    expect(() => assertMailboxStartupReadySync(home)).not.toThrow();
    const old = await source(); await old.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    expect(await migration.migrate()).toMatchObject({ state: 'complete', authority: 'sqlite' });
    const path = migrationPath(home);
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...manifest, copiedFiles: -1, files: null,
      status: { ...manifest.status, progress: null, backupPath: 'unavailable-historical-backup' } }));
    await expect(assertMailboxStartupReady(home)).resolves.toBeUndefined();
    expect(() => assertMailboxStartupReadySync(home)).not.toThrow();
    const status = await migration.status();
    expect(status).toMatchObject({ authority: 'sqlite', phase: 'complete', state: 'complete', canRollback: false,
      migrationId: manifest.status.migrationId, warning: { code: 'mailbox.checkpoint_warning' } });
    expect(status.failure).toBeUndefined();
    expect(await migration.migrate()).toMatchObject({ authority: 'sqlite', state: 'complete', warning: { code: 'mailbox.checkpoint_warning' } });
    await writeFile(path, JSON.stringify({ ...manifest, rollbackAuthority: await readMailboxAuthority(home) }));
    await expect(assertMailboxStartupReady(home)).rejects.toMatchObject({ code: 'mailbox.migration_required' });
    expect(() => assertMailboxStartupReadySync(home)).toThrow('rollback is incomplete');
    expect(await migration.status()).toMatchObject({ phase: 'rolling_back', canRollback: true });
  });

  describe('rollback authority commit crash', () => {
    beforeEach(async () => {
      const old = await source(); await old.close();
      const migration = createMailboxMigrationService(home); handles.push(migration);
      const completed = await migration.migrate();
      expect(completed.state).toBe('complete');
      const db = new CanonicalMailboxDatabase<Record<string, unknown>>(completed.databasePath!);
      try {
        await db.metadata('authority', 'rolled_back');
        await expect(assertMailboxStartupReady(home)).rejects.toMatchObject({ code: 'mailbox.migration_required' });
        expect(() => assertMailboxStartupReadySync(home)).toThrow('database authority is not active');
        await db.metadata('authority', 'sqlite');
      } finally { await db.close(); }
      const crash = await crashAt('rollback-authority');
      expect(crash.output, crash.errors).toContain('"boundary":"rollback-authority"');
      expect(crash.code).not.toBe(0);
    });

    it('blocks both startup gates after the rollback authority commit crash and permits explicit recovery', async () => {
      const migration = createMailboxMigrationService(home); handles.push(migration);
      expect(await readMailboxAuthority(home)).toBeDefined();
      await expect(assertMailboxStartupReady(home)).rejects.toMatchObject({ code: 'mailbox.migration_required' });
      expect(() => assertMailboxStartupReadySync(home)).toThrow('rollback is incomplete');
      expect(await migration.status()).toMatchObject({ phase: 'rolling_back', canRollback: true });
      expect(await migration.rollback()).toMatchObject({ authority: 'legacy' });
      expect(await migration.migrate()).toMatchObject({ state: 'complete', authority: 'sqlite' });
      await expect(assertMailboxStartupReady(home)).resolves.toBeUndefined();
      expect(() => assertMailboxStartupReadySync(home)).not.toThrow();
    });
  });

  it('restores the legacy authority before new SQLite writes and refuses rollback afterwards', async () => {
    const old = await source(); await old.close();
    const migration = createMailboxMigrationService(home); handles.push(migration);
    const first = await migration.migrate();
    expect(first.failure).toBeUndefined();
    const rolledBack = await migration.rollback();
    expect(rolledBack.authority).toBe('legacy');
    expect((await stat(join(home, 'store/thread-mailbox-v3'))).isDirectory()).toBe(true);
    const second = await migration.migrate();
    expect(second.failure).toBeUndefined();
    expect(second.migrationId).not.toBe(first.migrationId);
    const db = new CanonicalMailboxDatabase<Record<string, unknown>>(second.databasePath!); handles.push(db);
    await db.claimOwner({ hostId: 'example-owner', epoch: 100 });
    await db.partitionBatch('', [{ op: 'set', key: 'w/new/override', value: { kind: 'workspace_override', workspaceId: 'new', enabled: true, updatedAt: 3 } }]);
    await expect(migration.rollback()).rejects.toThrow('accepted new canonical writes');
    expect((await migration.status()).canRollback).toBe(false);
    expect(await readMailboxAuthority(home)).toMatchObject({ migrationId: second.migrationId });
  });
});

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('base64url'); }

async function readSourceRows(): Promise<MailboxRow[]> {
  const rows: MailboxRow[] = [];
  for (let shard = 0; shard < 2; shard++) {
    const db = await MiniDb.open<Record<string, unknown>>({ dir: join(home, 'store/thread-mailbox-v3', shardDirName(shard, 2)), readOnly: true, valueCodec: 'json', indexGenerations: false, activeExpireIntervalMs: 0 });
    try { for (const row of db.store.scan()) rows.push({ key: row.key.toString(), value: db.codec.decode(row.value), expireAt: row.expireAt }); }
    finally { await db.close(); }
  }
  return rows;
}

async function crashAt(boundary: string): Promise<{ code: number | null; output: string; errors: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', new URL('../../../../../build/register-raw-text-loader.mjs', import.meta.url).href,
    fileURLToPath(new URL('./fixtures/mailbox-migration-crash.mts', import.meta.url)), home, boundary], { cwd: join(import.meta.dirname, '../../..'), stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
  let output = ''; let errors = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (value: string) => { output += value; }); child.stderr.on('data', (value: string) => { errors += value; });
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve({ code, output, errors })); });
}
