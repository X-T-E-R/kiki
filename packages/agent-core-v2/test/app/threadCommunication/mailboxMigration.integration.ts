import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MiniDb } from '@kiki/minidb';
import { ClusterDb, shardDirName } from '@kiki/minidb/cluster';
import type { MailboxRow } from '#/persistence/backends/sqliteMailbox/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMailboxMigrationService } from '#/persistence/backends/sqliteMailbox/migration';
import { CanonicalMailboxDatabase } from '#/persistence/backends/sqliteMailbox/database';
import { assertMailboxStartupReady, assertMailboxStartupReadySync, authorityPath, readMailboxAuthority } from '#/persistence/backends/sqliteMailbox/authority';

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
