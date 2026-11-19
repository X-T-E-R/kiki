import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WorkspacePathEntry } from './workspacePathInventory';

const TRIGRAM_LEASE_TTL_MS = 60_000;

export type WorkspaceTrigramOperation =
  | { readonly type: 'workspace.trigram.begin'; readonly path: string; readonly epoch: string; readonly owner?: string }
  | { readonly type: 'workspace.trigram.update'; readonly path: string; readonly epoch: string; readonly root: string; readonly entries: readonly WorkspacePathEntry[]; readonly removed?: readonly string[]; readonly owner?: string }
  | { readonly type: 'workspace.trigram.finish'; readonly path: string; readonly epoch: string; readonly owner?: string }
  | { readonly type: 'workspace.trigram.query'; readonly path: string; readonly epoch: string; readonly literal: string; readonly insensitive: boolean; readonly limit: number };

function openStore(path: string, readOnly = false): DatabaseSync {
  if (!readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096;');
    if (readOnly) {
      db.exec('PRAGMA query_only=ON;');
      return db;
    }
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=33554432;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, mtime REAL NOT NULL,
        ctime REAL NOT NULL, size INTEGER NOT NULL, ino REAL NOT NULL, epoch TEXT NOT NULL, unindexed INTEGER NOT NULL, non_ascii INTEGER NOT NULL) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS content USING fts5(body, tokenize='trigram', detail='none');`);
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

function rollbackQuietly(db: DatabaseSync): void {
  if (!db.isTransaction) return;
  try { db.exec('ROLLBACK'); } catch {}
}

interface PreparedUpdateEntry {
  readonly entry: WorkspacePathEntry;
  readonly existingId?: number;
  readonly unchanged: boolean;
  readonly text?: string;
}

export function executeWorkspaceTrigram(operation: WorkspaceTrigramOperation, signal?: AbortSignal): boolean | readonly string[] | undefined {
  signal?.throwIfAborted();
  if (operation.type === 'workspace.trigram.query') {
    if (!existsSync(operation.path)) return undefined;
    const db = openStore(operation.path, true);
    try {
      signal?.throwIfAborted();
      db.exec('BEGIN');
      try {
        const epoch = (db.prepare("SELECT value FROM meta WHERE key='epoch'").get() as { value: string } | undefined)?.value;
        if (epoch !== operation.epoch) return undefined;
        const complete = db.prepare("SELECT 1 FROM meta WHERE key='complete'").get();
        if (complete === undefined) return undefined;
        const chars = Array.from(operation.literal);
        const grams = new Set<string>();
        for (let index = 0; index + 2 < chars.length; index++) grams.add(chars.slice(index, index + 3).join(''));
        const query = [...grams].map(gram => `"${gram.replaceAll('"', '""')}"`).join(' AND ');
        signal?.throwIfAborted();
        const rows = db.prepare(`SELECT path FROM files WHERE unindexed=1 OR (?=1 AND non_ascii=1)
          UNION SELECT f.path FROM content JOIN files f ON f.id=content.rowid WHERE content MATCH ? LIMIT ?`)
          .all(Number(operation.insensitive), query, operation.limit + 1) as Array<{ path: string }>;
        return rows.length > operation.limit ? undefined : rows.map(row => row.path);
      } finally {
        rollbackQuietly(db);
      }
    } finally {
      db.close();
    }
  }

  const db = openStore(operation.path, false);
  try {
    signal?.throwIfAborted();
    if (operation.type === 'workspace.trigram.begin') {
      db.exec('BEGIN IMMEDIATE');
      try {
        signal?.throwIfAborted();
        const now = Date.now();
        const existingOwner = (db.prepare("SELECT value FROM meta WHERE key='lease_owner'").get() as { value: string } | undefined)?.value;
        const existingExpires = Number((db.prepare("SELECT value FROM meta WHERE key='lease_expires_at'").get() as { value: string } | undefined)?.value ?? 0);
        const complete = db.prepare("SELECT 1 FROM meta WHERE key='complete'").get();
        const owner = operation.owner ?? operation.epoch;
        if (
          complete === undefined &&
          existingOwner !== undefined &&
          existingOwner !== owner &&
          existingExpires > now
        ) {
          rollbackQuietly(db);
          return false;
        }
        const upsertMeta = db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
        upsertMeta.run('epoch', operation.epoch);
        upsertMeta.run('lease_owner', owner);
        upsertMeta.run('lease_expires_at', String(now + TRIGRAM_LEASE_TTL_MS));
        db.prepare("DELETE FROM meta WHERE key='complete'").run();
        db.exec('COMMIT');
        return true;
      } catch (error) {
        rollbackQuietly(db);
        throw error;
      }
    }

    if (operation.type === 'workspace.trigram.finish') {
      db.exec('BEGIN IMMEDIATE');
      try {
        signal?.throwIfAborted();
        const epoch = (db.prepare("SELECT value FROM meta WHERE key='epoch'").get() as { value: string } | undefined)?.value;
        if (epoch !== operation.epoch) { rollbackQuietly(db); return undefined; }
        db.exec('DELETE FROM content WHERE rowid IN (SELECT id FROM files WHERE epoch<>(SELECT value FROM meta WHERE key=\'epoch\')); DELETE FROM files WHERE epoch<>(SELECT value FROM meta WHERE key=\'epoch\')');
        db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('complete','1')").run();
        db.prepare("DELETE FROM meta WHERE key IN ('lease_owner','lease_expires_at')").run();
        db.exec('COMMIT');
        return true;
      } catch (error) {
        rollbackQuietly(db);
        throw error;
      }
    }

    const existingEpoch = (db.prepare("SELECT value FROM meta WHERE key='epoch'").get() as { value: string } | undefined)?.value;
    if (existingEpoch !== operation.epoch) return undefined;

    const find = db.prepare('SELECT id,mtime,ctime,size,ino FROM files WHERE path=?');
    const prepared: PreparedUpdateEntry[] = [];
    for (const entry of operation.entries) {
      signal?.throwIfAborted();
      const old = find.get(entry.path) as { id: number; mtime: number; ctime: number; size: number; ino: number } | undefined;
      if (old !== undefined && old.mtime === entry.mtimeMs && old.ctime === entry.ctimeMs && old.size === entry.size && old.ino === entry.ino) {
        prepared.push({ entry, existingId: old.id, unchanged: true });
        continue;
      }
      let text: string | undefined;
      if (entry.size <= (1 << 20)) {
        signal?.throwIfAborted();
        try {
          const fullPath = join(operation.root, entry.path);
          const bytes = readFileSync(fullPath);
          const stat = statSync(fullPath);
          if (bytes.length === entry.size && stat.mtimeMs === entry.mtimeMs && stat.ctimeMs === entry.ctimeMs &&
            !bytes.includes(0) && !(bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff)) {
            text = bytes.toString('utf8');
          }
        } catch (error) {
          if (!['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
      prepared.push({ entry, unchanged: false, text });
    }

    signal?.throwIfAborted();
    db.exec('BEGIN IMMEDIATE');
    try {
      const epoch = (db.prepare("SELECT value FROM meta WHERE key='epoch'").get() as { value: string } | undefined)?.value;
      if (epoch !== operation.epoch) { rollbackQuietly(db); return undefined; }
      db.prepare("INSERT INTO meta(key,value) VALUES('lease_expires_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now() + TRIGRAM_LEASE_TTL_MS));
      const deleteContentByPath = db.prepare('DELETE FROM content WHERE rowid IN (SELECT id FROM files WHERE path=?)');
      const deleteFileByPath = db.prepare('DELETE FROM files WHERE path=?');
      for (const path of operation.removed ?? []) {
        signal?.throwIfAborted();
        deleteContentByPath.run(path);
        deleteFileByPath.run(path);
      }
      const touch = db.prepare('UPDATE files SET epoch=? WHERE id=?');
      const remove = db.prepare('DELETE FROM content WHERE rowid=?');
      const upsert = db.prepare(`INSERT INTO files(path,mtime,ctime,size,ino,epoch,unindexed,non_ascii) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime,ctime=excluded.ctime,size=excluded.size,ino=excluded.ino,
        epoch=excluded.epoch,unindexed=excluded.unindexed,non_ascii=excluded.non_ascii RETURNING id`);
      const insert = db.prepare('INSERT INTO content(rowid,body) VALUES(?,?)');
      for (const item of prepared) {
        signal?.throwIfAborted();
        if (item.unchanged && item.existingId !== undefined) {
          touch.run(operation.epoch, item.existingId);
          continue;
        }
        const row = upsert.get(
          item.entry.path,
          item.entry.mtimeMs,
          item.entry.ctimeMs,
          item.entry.size,
          item.entry.ino,
          operation.epoch,
          Number(item.text === undefined),
          Number(item.text !== undefined && /[^\x00-\x7f]/u.test(item.text)),
        ) as { id: number };
        remove.run(row.id);
        if (item.text !== undefined) insert.run(row.id, item.text);
      }
      signal?.throwIfAborted();
      db.exec('COMMIT');
      return true;
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  } finally {
    db.close();
  }
}
