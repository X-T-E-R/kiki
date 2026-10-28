import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryEntry, MemoryJournalRecord } from '../../../app/memory/memoryStore.ts';
import type { MemoryCommit, MemoryCommitReceipt, MemoryImportResult, MemoryLegacyPayload, MemoryReadView } from '../../interface/memoryPersistence.ts';

function conflict(message: string): never { throw Object.assign(new Error(message), { code: 'revision_conflict', committed: false }); }
function fingerprint(request: string): string { return createHash('sha256').update(request).digest('hex'); }

export class MemoryDatabase {
  private readonly db: DatabaseSync;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;`);
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.['user_version']);
    if (version !== 0 && version !== 1) { this.db.close(); throw new Error('Unsupported Memory database schema'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES('generation',0);
      CREATE TABLE IF NOT EXISTS revisions(scope TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,generation INTEGER NOT NULL,entry TEXT,PRIMARY KEY(scope,id,revision));
      CREATE TABLE IF NOT EXISTS commit_views(scope TEXT NOT NULL,id TEXT NOT NULL,generation INTEGER NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(scope,id,generation));
      CREATE INDEX IF NOT EXISTS memory_commit_views ON commit_views(scope,generation,id);
      CREATE TABLE IF NOT EXISTS heads(scope TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,scope TEXT NOT NULL,object_id TEXT NOT NULL,payload TEXT NOT NULL,locator TEXT,learned_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS adjudications(id TEXT PRIMARY KEY,scope TEXT NOT NULL,object_id TEXT NOT NULL,revision TEXT NOT NULL,generation INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS barriers(scope TEXT NOT NULL,id TEXT NOT NULL,at TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,request TEXT NOT NULL,generation INTEGER NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_objects(operation_id TEXT NOT NULL,scope TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(operation_id,scope,id));
      CREATE TABLE IF NOT EXISTS journal(ordinal INTEGER PRIMARY KEY,scope TEXT NOT NULL,id TEXT NOT NULL,operation_id TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS journal_scope ON journal(scope,id,ordinal);
      CREATE TABLE IF NOT EXISTS legacy(scope TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,object_id TEXT,revision TEXT,issue TEXT,PRIMARY KEY(scope,key));
      PRAGMA user_version=1;
    `);
  }
  private generation(): number { return Number(this.db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!['value']); }
  private blocked(scope: string, id: string): boolean { return this.db.prepare('SELECT 1 FROM barriers WHERE scope=? AND id=?').get(scope, id) !== undefined; }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try { const value = fn(); this.db.exec('COMMIT'); committed = true; return value; }
    catch (error) { if (!committed) { try { this.db.exec('ROLLBACK'); } catch {} } throw error; }
  }
  read(scopes: readonly string[], generation?: number): MemoryReadView {
    this.db.exec('BEGIN');
    try {
      const current = this.generation();
      const at = generation ?? current;
      if (!Number.isSafeInteger(at) || at < 0 || at > current) throw new Error('Invalid Memory commit view');
      const objects: MemoryReadView['objects'][number][] = [];
      const query = this.db.prepare(`SELECT r.* FROM commit_views c JOIN revisions r ON r.scope=c.scope AND r.id=c.id AND r.revision=c.revision WHERE c.scope=? AND c.generation<=? AND NOT EXISTS(SELECT 1 FROM commit_views newer WHERE newer.scope=c.scope AND newer.id=c.id AND newer.generation>c.generation AND newer.generation<=?) AND NOT EXISTS(SELECT 1 FROM barriers b WHERE b.scope=c.scope AND b.id=c.id) ORDER BY r.id`);
      for (const scope of new Set(scopes)) for (const row of query.all(scope, at, at)) objects.push({ scope, id: String(row['id']), revision: String(row['revision']), entry: row['entry'] === null ? null : JSON.parse(String(row['entry'])) as MemoryEntry });
      this.db.exec('COMMIT');
      return { generation: at, objects };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  revision(scope: string, id: string, revision: string): MemoryEntry | undefined {
    const row = this.db.prepare('SELECT entry FROM revisions WHERE scope=? AND id=? AND revision=? AND NOT EXISTS(SELECT 1 FROM barriers WHERE scope=? AND id=?)').get(scope, id, revision, scope, id);
    return row === undefined || row['entry'] === null ? undefined : JSON.parse(String(row['entry'])) as MemoryEntry;
  }
  receipt(operationId: string, request?: string): MemoryCommitReceipt | undefined {
    const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
    if (row === undefined) return undefined;
    if (request !== undefined && row['request'] !== fingerprint(request)) conflict('Memory operation ID was already used for another request');
    return { operationId, generation: Number(row['generation']), result: JSON.parse(String(row['result'])), saved: true, index: 'lexical' };
  }
  commit(input: MemoryCommit): MemoryCommitReceipt {
    if (!input.operationId || !input.request || input.edits.length > 1000) throw new Error('Invalid Memory transaction');
    return this.transaction(() => {
      const replay = this.receipt(input.operationId, input.request);
      if (replay !== undefined) return replay;
      if (this.generation() !== input.expectedGeneration) conflict('Memory commit generation changed; reread and reconcile');
      const generation = input.expectedGeneration + 1;
      const touched = new Set<string>();
      for (const edit of input.edits) {
        const key = JSON.stringify([edit.scope, edit.id]);
        if (touched.has(key)) throw new Error('Duplicate Memory transaction target');
        touched.add(key);
        if (this.blocked(edit.scope, edit.id)) conflict('Memory target has a forget barrier');
        const head = this.db.prepare('SELECT revision FROM heads WHERE scope=? AND id=?').get(edit.scope, edit.id);
        if ((head?.['revision'] ?? null) !== edit.expectedRevision) conflict('Memory revision conflict');
        if (edit.entry !== null && (edit.entry.id !== edit.id || edit.entry.revision !== edit.revision)) throw new Error('Memory object identity mismatch');
        this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?)').run(edit.scope, edit.id, edit.revision, generation, edit.entry === null ? null : JSON.stringify(edit.entry));
        this.db.prepare('INSERT INTO commit_views VALUES(?,?,?,?)').run(edit.scope, edit.id, generation, edit.revision);
        this.db.prepare('INSERT INTO heads VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET revision=excluded.revision').run(edit.scope, edit.id, edit.revision);
        this.db.prepare('INSERT INTO operation_objects VALUES(?,?,?)').run(input.operationId, edit.scope, edit.id);
      }
      for (const source of input.sources ?? []) {
        if (this.blocked(source.scope, source.objectId)) conflict('Memory source has a forget barrier');
        this.db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?)').run(source.id, source.scope, source.objectId, source.payload, source.locator ?? null, source.learnedAt);
      }
      for (const decision of input.adjudications ?? []) {
        if (this.blocked(decision.scope, decision.objectId)) conflict('Memory adjudication has a forget barrier');
        const head = this.db.prepare('SELECT revision FROM heads WHERE scope=? AND id=?').get(decision.scope, decision.objectId);
        if (head?.['revision'] !== decision.revision) conflict('Memory adjudication must reference the committed head');
        this.db.prepare('INSERT INTO adjudications VALUES(?,?,?,?,?,?)').run(decision.id, decision.scope, decision.objectId, decision.revision, generation, JSON.stringify(decision));
      }
      for (const record of input.journal ?? []) {
        if (this.blocked(record.scope, record.id)) conflict('Memory journal has a forget barrier');
        this.db.prepare('INSERT INTO journal(scope,id,operation_id,payload) VALUES(?,?,?,?)').run(record.scope, record.id, input.operationId, JSON.stringify(record));
      }
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(input.operationId, fingerprint(input.request), generation, JSON.stringify(input.result));
      for (const barrier of input.barriers ?? []) {
        this.db.prepare('INSERT OR IGNORE INTO barriers VALUES(?,?,?,?)').run(barrier.scope, barrier.objectId, barrier.at, generation);
        this.db.prepare('UPDATE operations SET result=? WHERE id IN(SELECT operation_id FROM operation_objects WHERE scope=? AND id=?)').run(JSON.stringify({ forgotten: true }), barrier.scope, barrier.objectId);
        for (const table of ['heads', 'revisions', 'commit_views', 'sources', 'adjudications', 'journal']) {
          const column = table === 'sources' || table === 'adjudications' ? 'object_id' : 'id';
          this.db.prepare(`DELETE FROM ${table} WHERE scope=? AND ${column}=?`).run(barrier.scope, barrier.objectId);
        }
        this.db.prepare('DELETE FROM legacy WHERE scope=? AND (object_id=? OR key IN(?,?,?))').run(barrier.scope, barrier.objectId, 'journal.jsonl', `entries/${barrier.objectId}.md`, `inbox/${barrier.objectId}.md`);
      }
      this.db.prepare("UPDATE metadata SET value=? WHERE key='generation'").run(generation);
      return this.receipt(input.operationId)!;
    });
  }
  journal(scope: string, id?: string): readonly MemoryJournalRecord[] {
    const rows = id === undefined ? this.db.prepare('SELECT payload FROM journal WHERE scope=? ORDER BY ordinal').all(scope) : this.db.prepare('SELECT payload FROM journal WHERE scope=? AND id=? ORDER BY ordinal').all(scope, id);
    return rows.map((row) => JSON.parse(String(row['payload'])) as MemoryJournalRecord);
  }
  importLegacy(batch: readonly MemoryLegacyPayload[]): MemoryImportResult {
    if (batch.length > 1000) throw new Error('Memory import batch exceeds 1000 records');
    return this.transaction(() => {
      const generation = this.generation() + 1;
      let imported = 0;
      let retained = 0;
      const issues: MemoryImportResult['issues'][number][] = [];
      for (const record of batch) {
        const old = this.db.prepare('SELECT * FROM legacy WHERE scope=? AND key=?').get(record.scope, record.key);
        if (old?.['payload'] === record.payload) {
          retained++;
          if (old['issue'] !== null) issues.push({ scope: record.scope, key: record.key, issue: String(old['issue']) });
          continue;
        }
        const entry = record.entry;
        let issue = record.issue;
        if (entry !== undefined && this.blocked(record.scope, entry.id) || entry === undefined && this.db.prepare('SELECT 1 FROM barriers WHERE scope=? LIMIT 1').get(record.scope) !== undefined) {
          issues.push({ scope: record.scope, key: record.key, issue: 'forgotten_source_rejected' }); continue;
        }
        for (const previous of record.history ?? []) if (!this.blocked(record.scope, previous.id)) this.db.prepare('INSERT OR IGNORE INTO revisions VALUES(?,?,?,?,?)').run(record.scope, previous.id, previous.revision, 0, JSON.stringify(previous));
        for (const event of record.journal ?? []) {
          if (this.blocked(record.scope, event.id)) continue;
          const encoded = JSON.stringify(event);
          if (this.db.prepare('SELECT 1 FROM journal WHERE scope=? AND id=? AND operation_id=? AND payload=?').get(record.scope, event.id, event.operationId, encoded) === undefined) this.db.prepare('INSERT INTO journal(scope,id,operation_id,payload) VALUES(?,?,?,?)').run(record.scope, event.id, event.operationId, encoded);
        }
        const latest = new Map((record.journal ?? []).map((event) => [event.id, event]));
        for (const event of latest.values()) {
          if (event.afterRevision !== null || this.blocked(record.scope, event.id) || this.db.prepare('SELECT 1 FROM heads WHERE scope=? AND id=?').get(record.scope, event.id) !== undefined) continue;
          const revision = `legacy-deleted:${event.operationId}`;
          this.db.prepare('INSERT OR IGNORE INTO revisions VALUES(?,?,?,?,NULL)').run(record.scope, event.id, revision, generation);
          this.db.prepare('INSERT INTO commit_views VALUES(?,?,?,?)').run(record.scope, event.id, generation, revision);
          this.db.prepare('INSERT INTO heads VALUES(?,?,?)').run(record.scope, event.id, revision);
        }
        if (entry !== undefined) {
          const head = this.db.prepare('SELECT revision FROM heads WHERE scope=? AND id=?').get(record.scope, entry.id);
          const curated = this.db.prepare('SELECT 1 FROM adjudications WHERE scope=? AND object_id=?').get(record.scope, entry.id) !== undefined;
          if (this.blocked(record.scope, entry.id)) { issues.push({ scope: record.scope, key: record.key, issue: 'forgotten_source_rejected' }); continue; }
          if (curated || head !== undefined && head['revision'] !== old?.['revision']) issue = 'current_revision_preserved';
          else if (head?.['revision'] !== entry.revision) {
            this.db.prepare('INSERT OR IGNORE INTO revisions VALUES(?,?,?,?,?)').run(record.scope, entry.id, entry.revision, generation, JSON.stringify(entry));
            this.db.prepare('INSERT INTO commit_views VALUES(?,?,?,?)').run(record.scope, entry.id, generation, entry.revision);
            this.db.prepare('INSERT INTO heads VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET revision=excluded.revision').run(record.scope, entry.id, entry.revision);
            imported++;
          }
        }
        this.db.prepare('INSERT INTO legacy VALUES(?,?,?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET payload=excluded.payload,object_id=excluded.object_id,revision=excluded.revision,issue=excluded.issue').run(record.scope, record.key, record.payload, entry?.id ?? null, entry?.revision ?? null, issue ?? null);
        if (issue !== undefined) issues.push({ scope: record.scope, key: record.key, issue });
      }
      this.db.prepare("UPDATE metadata SET value=? WHERE key='generation'").run(generation);
      return { imported, retained, issues };
    });
  }
  legacy(scope: string): readonly MemoryLegacyPayload[] {
    return this.db.prepare('SELECT * FROM legacy WHERE scope=? ORDER BY key').all(scope).map((row) => ({ scope, key: String(row['key']), payload: String(row['payload']), issue: row['issue'] === null ? undefined : String(row['issue']) }));
  }
  close(): void { this.db.close(); }
}
