import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { MemoryEntry } from '../../../app/memory/memoryStore.ts';
// oxlint-disable-next-line import/extensions
import { memorySourceUnitId } from '../../../app/memory/memorySourceIdentity.ts';

export class MemoryReconciliation {
  baseline: boolean;
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS memory_sources_object ON sources(scope,object_id);
      CREATE INDEX IF NOT EXISTS memory_source_link_objects ON source_links(scope,object_id,source_id);
      CREATE INDEX IF NOT EXISTS memory_legacy_object ON legacy(scope,object_id,revision);
      CREATE INDEX IF NOT EXISTS memory_operations_generation ON operations(generation);
      CREATE INDEX IF NOT EXISTS memory_operation_objects ON operation_objects(scope,id,operation_id);
      CREATE INDEX IF NOT EXISTS memory_revision_views ON commit_views(scope,id,revision,generation);
      CREATE TABLE IF NOT EXISTS memory_admissions(scope TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,generation INTEGER,signature TEXT,PRIMARY KEY(scope,id,revision));
      CREATE INDEX IF NOT EXISTS memory_admission_signature ON memory_admissions(scope,signature,id,generation);
      CREATE TABLE IF NOT EXISTS memory_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,id TEXT NOT NULL,revision TEXT);
      INSERT OR IGNORE INTO metadata VALUES('memory_reconcile_sequence',0);
      INSERT OR IGNORE INTO metadata VALUES('memory_writer_active',0);
    `);
    this.baseline = this.db.prepare("SELECT value FROM metadata WHERE key='memory_reconcile_version'").get() === undefined;
    this.db.exec("UPDATE metadata SET value=1 WHERE key='memory_writer_active'");
    if (this.baseline) {
      const insert = this.db.prepare('INSERT OR IGNORE INTO memory_admissions VALUES(?,?,?,?,?)');
      for (const row of this.db.prepare('SELECT scope,id,revision,generation,entry FROM revisions WHERE entry IS NOT NULL').all()) {
        const entry = JSON.parse(String(row['entry'])) as MemoryEntry;
        const generation = Number(row['generation']);
        insert.run(String(row['scope']), entry.id, entry.revision, generation === 0 ? null : generation, memorySourceUnitId(String(row['scope']), entry.source, entry.body, entry.basis?.refs) ?? null);
      }
      this.recoverPreimages();
    }
    for (const [table, events, object] of [['revisions', ['INSERT'], 'id'], ['legacy', ['INSERT', 'UPDATE'], 'object_id']] as const) for (const event of events) {
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS memory_track_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} WHEN NEW.${object} IS NOT NULL AND (SELECT value FROM metadata WHERE key='memory_writer_active')=0 BEGIN INSERT INTO memory_changes(scope,id,revision) VALUES(NEW.scope,NEW.${object},NEW.revision); END;`);
    }
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS memory_admit_revision AFTER INSERT ON revisions WHEN NEW.entry IS NOT NULL BEGIN
      INSERT OR IGNORE INTO memory_admissions VALUES(NEW.scope,NEW.id,NEW.revision,MAX(NEW.generation,(SELECT value+1 FROM metadata WHERE key='generation')),NULL);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_track_forget AFTER INSERT ON source_barriers WHEN (SELECT value FROM metadata WHERE key='memory_writer_active')=0 BEGIN
        INSERT INTO memory_changes(scope,id) SELECT scope,id FROM memory_admissions WHERE scope=NEW.scope AND signature=NEW.id GROUP BY scope,id;
      END;
      CREATE TRIGGER IF NOT EXISTS memory_track_object_forget AFTER INSERT ON barriers WHEN (SELECT value FROM metadata WHERE key='memory_writer_active')=0 BEGIN INSERT INTO memory_changes(scope,id) VALUES(NEW.scope,NEW.id); END;`);
  }
  private recoverPreimages(): void {
    const update = this.db.prepare('UPDATE memory_admissions SET generation=? WHERE scope=? AND id=? AND revision=? AND (generation IS NULL OR generation>?)');
    for (const object of this.db.prepare('SELECT scope,id FROM memory_admissions WHERE generation IS NULL GROUP BY scope,id').all()) {
      const scope = String(object['scope']); const id = String(object['id']);
      const events = this.db.prepare('SELECT payload FROM journal WHERE scope=? AND id=? ORDER BY ordinal').all(scope, id).map((row) => JSON.parse(String(row['payload'])) as { operationId: string; beforeRevision: string | null; afterRevision: string | null });
      const accepted = new Map(this.db.prepare('SELECT revision,MIN(generation) AS generation FROM commit_views WHERE scope=? AND id=? GROUP BY revision').all(scope, id).map((row) => [String(row['revision']), Number(row['generation'])]));
      for (let changed = true; changed;) {
        changed = false;
        for (const event of events) {
          const generation = accepted.get(event.afterRevision ?? `legacy-deleted:${event.operationId}`);
          if (generation === undefined || event.beforeRevision === null || (accepted.get(event.beforeRevision) ?? Infinity) <= generation) continue;
          accepted.set(event.beforeRevision, generation); changed = true;
        }
      }
      for (const [revision, generation] of accepted) {
        const barrier = this.db.prepare('SELECT b.generation FROM memory_admissions a JOIN source_barriers b ON b.scope=a.scope AND b.id=a.signature WHERE a.scope=? AND a.id=? AND a.revision=?').get(scope, id, revision);
        if (barrier === undefined || generation <= Number(barrier['generation'])) update.run(generation, scope, id, revision, generation);
      }
    }
  }
  note(scope: string, entry: MemoryEntry): void {
    this.db.prepare('UPDATE memory_admissions SET signature=? WHERE scope=? AND id=? AND revision=?').run(memorySourceUnitId(scope, entry.source, entry.body, entry.basis?.refs) ?? null, scope, entry.id, entry.revision);
  }
  private targets(): string {
    return `WITH changed AS (SELECT DISTINCT scope,id,revision FROM memory_changes WHERE sequence>(SELECT value FROM metadata WHERE key='memory_reconcile_sequence')), target AS (
      SELECT r.rowid AS row FROM changed c CROSS JOIN revisions r ON r.scope=c.scope AND r.id=c.id AND r.revision=c.revision
      UNION SELECT r.rowid FROM changed c CROSS JOIN revisions r ON r.scope=c.scope AND r.id=c.id WHERE c.revision IS NULL) `;
  }
  rows(): readonly Record<string, SQLOutputValue>[] {
    return this.db.prepare(`${this.baseline ? '' : this.targets()}SELECT r.scope,r.id,r.revision,r.generation,r.entry FROM ${this.baseline ? 'revisions r' : 'target t CROSS JOIN revisions r ON r.rowid=t.row'} WHERE r.entry IS NOT NULL`).all();
  }
  evidenceRows(): readonly Record<string, SQLOutputValue>[] {
    return this.db.prepare(`${this.baseline ? '' : this.targets()}SELECT DISTINCT r.scope,r.entry,l.key,l.payload FROM ${this.baseline ? 'revisions r' : 'target t CROSS JOIN revisions r ON r.rowid=t.row'} CROSS JOIN memory_admissions a ON a.scope=r.scope AND a.id=r.id AND a.revision=r.revision LEFT JOIN legacy l ON l.scope=r.scope AND l.object_id=r.id AND l.revision=r.revision LEFT JOIN operations p ON p.generation=r.generation LEFT JOIN operation_objects o ON o.operation_id=p.id AND o.scope=r.scope AND o.id=r.id LEFT JOIN sources s ON s.scope=r.scope AND s.object_id=r.id AND (s.payload=r.entry OR s.payload=l.payload) WHERE r.entry IS NOT NULL AND a.generation IS NOT NULL AND o.operation_id IS NULL AND s.id IS NULL`).all();
  }
  pending(): boolean { return this.db.prepare("SELECT 1 FROM memory_changes WHERE sequence>(SELECT value FROM metadata WHERE key='memory_reconcile_sequence') LIMIT 1").get() !== undefined; }
  acknowledge(): void {
    this.db.exec("UPDATE metadata SET value=COALESCE((SELECT seq FROM sqlite_sequence WHERE name='memory_changes'),0) WHERE key='memory_reconcile_sequence'; DELETE FROM memory_changes; INSERT INTO metadata VALUES('memory_reconcile_version',1) ON CONFLICT(key) DO UPDATE SET value=1;");
    this.baseline = false;
  }
  active(value: boolean): void { this.db.prepare("UPDATE metadata SET value=? WHERE key='memory_writer_active'").run(Number(value)); }
  admission(scope: string, id: string, revision: string): number | undefined {
    const value = this.db.prepare('SELECT generation FROM memory_admissions WHERE scope=? AND id=? AND revision=?').get(scope, id, revision)?.['generation'];
    return value === null || value === undefined ? undefined : Number(value);
  }
}
