import { open, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Schema guard adapted from dsh-core/packages/session-query/session-query-sqlite/src/schema.ts (MIT). */
export const APPLICATION_ID = 0x4b534958;
export const SCHEMA_VERSION = 1;

const DERIVED_TABLES = new Set([
  'sessions', 'files', 'turn_openers', 'docs', 'docs_terms', 'docs_terms_data',
  'docs_terms_idx', 'docs_terms_docsize', 'docs_terms_config', 'docs_tri',
  'docs_tri_data', 'docs_tri_idx', 'docs_tri_docsize', 'docs_tri_config', 'meta', 'file_failures',
]);

export async function openSearchDatabase(path: string): Promise<DatabaseSync> {
  const actual = path === ':memory:' ? path : resolve(path);
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 });
    try {
      const file = await open(actual, 'wx', 0o600);
      await file.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const db = new DatabaseSync(actual);
  try {
    const applicationId = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id;
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'").all() as { name: string }[]).map((row) => row.name);
    if (applicationId !== 0 && applicationId !== APPLICATION_ID) {
      throw new Error(`search database at "${actual}" belongs to another application`);
    }
    if (applicationId === 0 && tables.length > 0) {
      throw new Error(`search database at "${actual}" is not an empty or recognized derived index`);
    }
    if (applicationId === APPLICATION_ID) {
      const unknown = tables.filter((name) => !DERIVED_TABLES.has(name));
      if (unknown.length) throw new Error(`search database at "${actual}" has unrecognized user tables: ${unknown.join(', ')}`);
      if (version !== SCHEMA_VERSION) {
        for (const name of ['docs_tri', 'docs_terms', 'turn_openers', 'docs', 'files', 'sessions', 'meta', 'file_failures']) {
          if (tables.includes(name)) db.exec(`DROP TABLE IF EXISTS "${name}"`);
        }
        db.exec('PRAGMA user_version = 0');
      }
    }
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-32768; PRAGMA mmap_size=0; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=67108864');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
        dir TEXT NOT NULL, identity TEXT NOT NULL, updated_at INTEGER NOT NULL, source_mtime_ms REAL) STRICT;
      CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE, ino TEXT, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
        offset INTEGER NOT NULL, tail_hash TEXT, turn_next INTEGER NOT NULL, turn_has INTEGER NOT NULL,
        step_state TEXT NOT NULL, policy TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS turn_openers (file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL, turn INTEGER NOT NULL, anchor INTEGER NOT NULL,
        PRIMARY KEY (file_id, idx)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        line_offset INTEGER NOT NULL, ord INTEGER NOT NULL, role TEXT NOT NULL, time INTEGER NOT NULL,
        turn INTEGER, step_id TEXT, text TEXT NOT NULL,
        UNIQUE (file_id, line_offset, ord)) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_terms USING fts5(terms, content='', tokenize='unicode61 remove_diacritics 0');
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_tri USING fts5(text, content='docs', content_rowid='id', tokenize='trigram');
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS file_failures (path TEXT PRIMARY KEY, strikes INTEGER NOT NULL,
        error TEXT NOT NULL) STRICT;
    `);
    db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}`);
    db.prepare("INSERT OR IGNORE INTO meta(k,v) VALUES('generation','0')").run();
    const extractor = db.prepare("SELECT v FROM meta WHERE k='extractor_version'").get() as { v: string } | undefined;
    if (extractor && extractor.v !== '2') {
      db.exec('BEGIN');
      try {
        db.prepare("UPDATE files SET policy='refresh'").run();
        db.prepare("UPDATE meta SET v='2' WHERE k='extractor_version'").run();
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } else if (!extractor) {
      db.prepare("INSERT INTO meta(k,v) VALUES('extractor_version','2')").run();
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
