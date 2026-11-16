import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WorkspacePathEntry } from './workspacePathInventory';

export type WorkspaceTrigramOperation =
  | { readonly type: 'workspace.trigram.begin'; readonly path: string; readonly epoch: string }
  | { readonly type: 'workspace.trigram.update'; readonly path: string; readonly epoch: string; readonly root: string; readonly entries: readonly WorkspacePathEntry[] }
  | { readonly type: 'workspace.trigram.finish'; readonly path: string; readonly epoch: string }
  | { readonly type: 'workspace.trigram.query'; readonly path: string; readonly epoch: string; readonly literal: string; readonly insensitive: boolean; readonly limit: number };

function openStore(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-4096;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, mtime REAL NOT NULL,
      ctime REAL NOT NULL, size INTEGER NOT NULL, ino REAL NOT NULL, epoch TEXT NOT NULL, unindexed INTEGER NOT NULL, non_ascii INTEGER NOT NULL) STRICT;
    CREATE VIRTUAL TABLE IF NOT EXISTS content USING fts5(body, tokenize='trigram', detail='none');`);
  return db;
}

export function executeWorkspaceTrigram(operation: WorkspaceTrigramOperation): boolean | readonly string[] | undefined {
  const db = openStore(operation.path);
  try {
    db.exec('BEGIN IMMEDIATE');
    const epoch = (db.prepare("SELECT value FROM meta WHERE key='epoch'").get() as { value: string } | undefined)?.value;
    if (operation.type === 'workspace.trigram.begin') {
      db.prepare("INSERT INTO meta(key,value) VALUES('epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(operation.epoch);
      db.prepare("DELETE FROM meta WHERE key='complete'").run();
      db.exec('COMMIT');
      return true;
    }
    if (epoch !== operation.epoch) { db.exec('ROLLBACK'); return undefined; }
    if (operation.type === 'workspace.trigram.query') {
      const complete = db.prepare("SELECT 1 FROM meta WHERE key='complete'").get();
      if (complete === undefined) { db.exec('ROLLBACK'); return undefined; }
      const chars = [...operation.literal];
      const grams = new Set<string>();
      for (let index = 0; index + 2 < chars.length; index++) grams.add(chars.slice(index, index + 3).join(''));
      const query = [...grams].map(gram => `"${gram.replaceAll('"', '""')}"`).join(' AND ');
      const rows = db.prepare(`SELECT path FROM files WHERE unindexed=1 OR (?=1 AND non_ascii=1)
        UNION SELECT f.path FROM content JOIN files f ON f.id=content.rowid WHERE content MATCH ? LIMIT ?`)
        .all(Number(operation.insensitive), query, operation.limit + 1) as Array<{ path: string }>;
      db.exec('COMMIT');
      return rows.length > operation.limit ? undefined : rows.map(row => row.path);
    }
    if (operation.type === 'workspace.trigram.finish') {
      db.exec('DELETE FROM content WHERE rowid IN (SELECT id FROM files WHERE epoch<>(SELECT value FROM meta WHERE key=\'epoch\')); DELETE FROM files WHERE epoch<>(SELECT value FROM meta WHERE key=\'epoch\')');
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('complete','1')").run();
      db.exec('COMMIT');
      return true;
    }
    const find = db.prepare('SELECT * FROM files WHERE path=?');
    const touch = db.prepare('UPDATE files SET epoch=? WHERE id=?');
    const remove = db.prepare('DELETE FROM content WHERE rowid=?');
    const upsert = db.prepare(`INSERT INTO files(path,mtime,ctime,size,ino,epoch,unindexed,non_ascii) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime,ctime=excluded.ctime,size=excluded.size,ino=excluded.ino,
      epoch=excluded.epoch,unindexed=excluded.unindexed,non_ascii=excluded.non_ascii RETURNING id`);
    const insert = db.prepare('INSERT INTO content(rowid,body) VALUES(?,?)');
    for (const entry of operation.entries) {
      const old = find.get(entry.path) as { id: number; mtime: number; ctime: number; size: number; ino: number } | undefined;
      if (old !== undefined && old.mtime === entry.mtimeMs && old.ctime === entry.ctimeMs && old.size === entry.size && old.ino === entry.ino) {
        touch.run(operation.epoch, old.id);
        continue;
      }
      let text: string | undefined;
      if (entry.size <= (1 << 20)) {
        try {
          const path = join(operation.root, entry.path);
          const bytes = readFileSync(path);
          const stat = statSync(path);
          if (bytes.length === entry.size && stat.mtimeMs === entry.mtimeMs && stat.ctimeMs === entry.ctimeMs &&
            !bytes.includes(0) && !(bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff)) text = bytes.toString('utf8');
        } catch (error) {
          if (!['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
      const row = upsert.get(entry.path, entry.mtimeMs, entry.ctimeMs, entry.size, entry.ino, operation.epoch,
        Number(text === undefined), Number(text !== undefined && /[^\x00-\x7f]/u.test(text))) as { id: number };
      remove.run(row.id);
      if (text !== undefined) insert.run(row.id, text);
    }
    db.exec('COMMIT');
    return true;
  } finally { db.close(); }
}
