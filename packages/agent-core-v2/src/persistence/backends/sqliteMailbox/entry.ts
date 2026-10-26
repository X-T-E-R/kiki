import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, backup, type SQLInputValue } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { isDeepStrictEqual } from 'node:util';

import type { MailboxOperation, MailboxOwner, MailboxRequest, MailboxResponse, MailboxRow } from './protocol.ts';

const port = parentPort;
if (port === null) throw new Error('Canonical mailbox requires a worker');
const configuration = workerData as { readonly database: string; readonly create: boolean; readonly readOnly?: boolean };
const APPLICATION_ID = 0x4b4d4231;
let connection: DatabaseSync | undefined;
let cancellation: Int32Array | undefined;

function check(): void {
  if (cancellation !== undefined && Atomics.load(cancellation, 0) !== 0) throw new DOMException('Mailbox operation cancelled before commit', 'AbortError');
}

function open(): DatabaseSync {
  if (connection !== undefined) return connection;
  if (!configuration.create && !existsSync(configuration.database)) throw new Error('Canonical mailbox database is missing; restore its consistent backup');
  if (configuration.create) mkdirSync(dirname(configuration.database), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(configuration.database, { readOnly: configuration.readOnly === true });
  try {
    db.exec('PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON');
    const application = Number(db.prepare('PRAGMA application_id').get()!['application_id']);
    const version = Number(db.prepare('PRAGMA user_version').get()!['user_version']);
    if ((application !== 0 && application !== APPLICATION_ID) || version > 1 || (!configuration.create && (application !== APPLICATION_ID || version !== 1))) throw new Error('Unsupported canonical mailbox SQLite schema');
    if (application === 0 && db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() !== undefined) throw new Error('Unrecognized canonical mailbox database');
    if (configuration.readOnly === true) { db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-8192'); connection = db; return db; }
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192;
      CREATE TABLE IF NOT EXISTS records(key TEXT PRIMARY KEY COLLATE BINARY, json TEXT NOT NULL CHECK(json_valid(json)), expire_at INTEGER NOT NULL DEFAULT 0 CHECK(expire_at>=0),
        kind TEXT GENERATED ALWAYS AS (json_extract(json,'$.kind')) VIRTUAL,
        peer_group TEXT GENERATED ALWAYS AS (json_extract(json,'$.peerGroup')) VIRTUAL,
        peer_order TEXT GENERATED ALWAYS AS (json_extract(json,'$.peerOrder')) VIRTUAL) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS records_by_kind ON records(kind,key);
      CREATE INDEX IF NOT EXISTS records_by_peer ON records(peer_group,peer_order,key) WHERE kind='peer_index';
      CREATE INDEX IF NOT EXISTS records_by_expiry ON records(expire_at) WHERE expire_at>0;
      CREATE INDEX IF NOT EXISTS records_by_message ON records(json_extract(json,'$.message.messageId'),key) WHERE kind='message';
      CREATE INDEX IF NOT EXISTS records_by_legacy_activity ON records(json_extract(json,'$.legacyIdentity'),key) WHERE kind='activity';
      CREATE TABLE IF NOT EXISTS legacy_archive(source TEXT NOT NULL,key TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),expire_at INTEGER NOT NULL,PRIMARY KEY(source,key)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, json TEXT NOT NULL CHECK(json_valid(json))) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS imports(source TEXT PRIMARY KEY, after_key TEXT NOT NULL, items INTEGER NOT NULL, bytes INTEGER NOT NULL) WITHOUT ROWID;
      PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;`);
    connection = db;
    return db;
  } catch (error) { db.close(); throw error; }
}

function transaction<T>(run: (db: DatabaseSync) => T): T {
  const db = open();
  check();
  db.exec('BEGIN IMMEDIATE');
  try { const result = run(db); check(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function metadata(db: DatabaseSync, key: string): unknown {
  const row = db.prepare('SELECT json FROM metadata WHERE key=?').get(key);
  return row === undefined ? undefined : JSON.parse(String(row['json']));
}

function assertOwner(db: DatabaseSync, owner: MailboxOwner | undefined): void {
  if (owner === undefined) {
    if (metadata(db, 'authority') === 'sqlite') throw new Error('Import cannot write an active canonical mailbox');
    return;
  }
  const current = metadata(db, 'owner') as MailboxOwner | undefined;
  if (metadata(db, 'authority') !== 'sqlite' || current?.epoch !== owner.epoch || current.hostId !== owner.hostId) throw Object.assign(new Error('Canonical mailbox owner epoch is no longer active'), { code: 'runtime.owner_gone' });
}

function row(value: Record<string, SQLInputValue>): MailboxRow {
  return { key: String(value['key']), value: JSON.parse(String(value['json'])), expireAt: Number(value['expire_at']) };
}

function verify(db: DatabaseSync): { readonly counts: Record<string, number>; readonly items: number; readonly bytes: number } {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0]!['integrity_check'] !== 'ok') throw new Error(`Canonical mailbox integrity check failed: ${JSON.stringify(integrity)}`);
  const counts: Record<string, number> = {};
  let items = 0;
  let bytes = 0;
  const allowed = new Set(['target_meta', 'message', 'idempotency', 'activity', 'workspace_override', 'receipt', 'migration_marker', 'active_backend', 'peer_index', 'peer_index_marker']);
  const get = db.prepare('SELECT json FROM records WHERE key=?');
  for (const record of db.prepare('SELECT key,json,expire_at,kind FROM records ORDER BY key').iterate()) {
    check();
    const key = String(record['key']);
    const kind = String(record['kind']);
    if (!allowed.has(kind)) throw new Error(`Unknown canonical record kind at ${key}`);
    const value = JSON.parse(String(record['json'])) as Record<string, unknown>;
    counts[kind] = (counts[kind] ?? 0) + 1;
    items++;
    bytes += Buffer.byteLength(key) + Buffer.byteLength(String(record['json']));
    if (kind === 'peer_index') {
      const target = get.get(String(value['messageKey']));
      if (target === undefined || JSON.parse(String(target['json'])).kind !== 'message') throw new Error(`Dangling peer index at ${key}`);
    }
    if (kind === 'message') {
      const message = value['message'] as Record<string, unknown> | undefined;
      if (message === undefined || !Number.isSafeInteger(message['targetSeq']) || Number(message['targetSeq']) < 1 || typeof message['messageId'] !== 'string' || typeof value['idempotencyStorageKey'] !== 'string') throw new Error(`Invalid message at ${key}`);
    }
    if (kind === 'idempotency' && (Number(record['expire_at']) === 0 || Number(record['expire_at']) > Date.now())) {
      if (typeof value['messageKey'] !== 'string') throw new Error(`Invalid idempotency message reference at ${key}`);
      const target = get.get(value['messageKey']);
      if (target === undefined && !value['messageKey'].includes('/legacy-message/')) throw new Error(`Missing idempotency message at ${key}`);
      if (target !== undefined) {
        const delivery = JSON.parse(String(target['json'])) as Record<string, unknown>;
        const message = delivery['message'] as Record<string, unknown> | undefined;
        if (delivery['kind'] !== 'message' || delivery['idempotencyStorageKey'] !== key || message === undefined
          || value['payloadHash'] !== delivery['payloadHash'] || value['idempotencyKey'] !== message['idempotencyKey']
          || !isDeepStrictEqual(value['producer'], message['producer']) || !isDeepStrictEqual(value['target'], message['target'])
          || value['messageId'] !== undefined && value['messageId'] !== message['messageId']) throw new Error(`Idempotency reference does not match its message at ${key}`);
      }
    }
    if (kind === 'target_meta') {
      const partition = key.slice(0, -'/meta'.length);
      const pending = Number(db.prepare("SELECT count(*) AS n FROM records WHERE key>=? AND key<? AND kind='message' AND json_extract(json,'$.state') IN ('pending','delivering')").get(`${partition}/message/`, `${partition}/message0`)!['n']);
      const max = Number(db.prepare("SELECT coalesce(max(json_extract(json,'$.message.targetSeq')),0) AS n FROM records WHERE key>=? AND key<? AND kind='message'").get(`${partition}/message/`, `${partition}/message0`)!['n']);
      if (value['pendingCount'] !== pending || Number(value['nextMessageSeq']) <= max) throw new Error(`Mailbox metadata does not match messages at ${key}`);
    }
  }
  if (metadata(db, 'authority') === undefined) {
    const mismatch = db.prepare("SELECT a.key FROM legacy_archive a LEFT JOIN records r ON r.key=a.key WHERE a.source LIKE 'thread-mailbox-v3/%' AND json_extract(a.json,'$.kind') NOT IN ('target_meta','workspace_override') AND (r.key IS NULL OR r.json<>a.json OR r.expire_at<>a.expire_at) LIMIT 1").get();
    if (mismatch !== undefined) throw new Error(`Imported canonical record differs from its frozen source at ${String(mismatch['key'])}`);
  }
  return { counts, items, bytes };
}

async function execute(operation: MailboxOperation): Promise<unknown> {
  check();
  if (operation.type === 'close') { connection?.close(); connection = undefined; return undefined; }
  const db = open();
  switch (operation.type) {
    case 'owner': return transaction((db) => {
      if (metadata(db, 'authority') !== 'sqlite') throw new Error('Mailbox migration has not published SQLite authority');
      const prior = metadata(db, 'owner') as MailboxOwner | undefined;
      if (prior !== undefined && (prior.epoch > operation.owner.epoch || prior.epoch === operation.owner.epoch && prior.hostId !== operation.owner.hostId)) throw Object.assign(new Error('Mailbox owner epoch is stale'), { code: 'runtime.owner_gone' });
      db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run('owner', JSON.stringify(operation.owner));
      return undefined;
    });
    case 'get': {
      const get = db.prepare('SELECT json FROM records WHERE key=? AND (expire_at=0 OR expire_at>?)');
      const now = Date.now();
      return operation.keys.map((key) => { check(); const record = get.get(key, now); return record === undefined ? undefined : JSON.parse(String(record['json'])); });
    }
    case 'find_identity': {
      const kind = operation.field === 'messageId' ? 'message' : 'activity';
      const path = operation.field === 'messageId' ? '$.message.messageId' : '$.legacyIdentity';
      const found = db.prepare('SELECT key,json,expire_at FROM records WHERE kind=? AND json_extract(json,?)=? AND key>=? AND key<? LIMIT 1').get(kind, path, operation.value, `${operation.partition}/`, `${operation.partition}0`);
      return found === undefined ? undefined : row(found);
    }
    case 'batch': return transaction((db) => {
      assertOwner(db, operation.owner);
      const put = db.prepare('INSERT INTO records(key,json,expire_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json,expire_at=excluded.expire_at');
      const putMissing = db.prepare('INSERT INTO records(key,json,expire_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING');
      const remove = db.prepare('DELETE FROM records WHERE key=?');
      const now = Date.now();
      for (const op of operation.ops) {
        check();
        if (op.op === 'del') remove.run(op.key);
        else {
          const expireAt = op.expireAt ?? (op.ttl === undefined ? 0 : now + Math.floor(op.ttl));
          if (!Number.isSafeInteger(expireAt) || expireAt < 0) throw new TypeError('Invalid absolute mailbox expiration');
          (op.onlyIfMissing === true ? putMissing : put).run(op.key, JSON.stringify(op.value), expireAt);
        }
      }
      if (operation.archive !== undefined) {
        const archive = db.prepare('INSERT INTO legacy_archive VALUES(?,?,?,?) ON CONFLICT(source,key) DO UPDATE SET json=excluded.json,expire_at=excluded.expire_at');
        for (const item of operation.archive.rows) archive.run(operation.archive.source, item.key, JSON.stringify(item.value), item.expireAt);
      }
      if (operation.importCheckpoint !== undefined) {
        const point = operation.importCheckpoint;
        db.prepare('INSERT INTO imports VALUES(?,?,?,?) ON CONFLICT(source) DO UPDATE SET after_key=excluded.after_key,items=excluded.items,bytes=excluded.bytes').run(point.source, point.after, point.items, point.bytes);
      } else if (operation.ops.length > 0 && operation.owner !== undefined) {
        db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run('hasNewWrites', 'true');
      }
      return undefined;
    });
    case 'scan': {
      const values: SQLInputValue[] = [operation.prefix, `${operation.prefix}\uffff`, operation.after ?? '', Date.now()];
      let sql = 'SELECT key,json,expire_at FROM records WHERE key>=? AND key<? AND key>? AND (expire_at=0 OR expire_at>?)';
      if (operation.kind !== undefined) { sql += ' AND kind=?'; values.push(operation.kind); }
      values.push(operation.limit);
      return db.prepare(`${sql} ORDER BY key LIMIT ?`).all(...values).map(row);
    }
    case 'peer': {
      const values: SQLInputValue[] = [operation.group, Date.now()];
      let sql = "SELECT key,json,expire_at FROM records WHERE kind='peer_index' AND peer_group=? AND (expire_at=0 OR expire_at>?)";
      if (operation.before !== undefined) { sql += ' AND peer_order<?'; values.push(operation.before); }
      values.push(operation.limit);
      return db.prepare(`${sql} ORDER BY peer_order DESC,key DESC LIMIT ?`).all(...values).map((record) => ({ ...row(record), orderValue: (JSON.parse(String(record['json'])) as { peerOrder: string }).peerOrder }));
    }
    case 'checkpoint': return db.prepare('SELECT after_key AS after,items,bytes FROM imports WHERE source=?').get(operation.source);
    case 'metadata': {
      if (operation.value === undefined) return metadata(db, operation.key);
      return transaction((db) => { db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(operation.key, JSON.stringify(operation.value)); });
    }
    case 'verify': return verify(db);
    case 'backup': {
      if (existsSync(operation.destination)) throw new Error('Mailbox backup destination already exists');
      mkdirSync(dirname(operation.destination), { recursive: true, mode: 0o700 });
      let pages = 0;
      await backup(db, operation.destination, { rate: 128, progress: ({ remainingPages, totalPages }) => { check(); pages = totalPages - remainingPages; return 128; } });
      check();
      const restored = new DatabaseSync(operation.destination, { readOnly: true });
      try { return { ...verify(restored), pages }; } finally { restored.close(); }
    }
  }
}

let chain = Promise.resolve();
port.on('message', (request: MailboxRequest) => {
  chain = chain.then(async () => {
    cancellation = request.cancellation === undefined ? undefined : new Int32Array(request.cancellation);
    try { port.postMessage({ id: request.id, result: await execute(request.operation) } satisfies MailboxResponse); }
    catch (error) {
      const cause = error as { message?: string; code?: string };
      port.postMessage({ id: request.id, error: { message: cause.message ?? String(error), code: cause.code, committed: request.operation.type === 'batch' ? false : undefined } } satisfies MailboxResponse);
    } finally { cancellation = undefined; }
    if (request.operation.type === 'close') port.close();
  });
});
