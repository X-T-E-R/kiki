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
      CREATE TABLE IF NOT EXISTS memory_quarantine(kind TEXT NOT NULL,scope TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,scope,id,key));
      INSERT OR IGNORE INTO metadata VALUES('memory_reconcile_sequence',0);
      INSERT OR IGNORE INTO metadata VALUES('memory_writer_active',0);
    `);
    this.baseline = this.db.prepare("SELECT value FROM metadata WHERE key='memory_reconcile_version'").get() === undefined || this.db.prepare("SELECT value FROM metadata WHERE key='memory_quarantine_version'").get() === undefined;
    this.db.exec("UPDATE metadata SET value=1 WHERE key='memory_writer_active'");
    if (this.baseline) {
      const insert = this.db.prepare('INSERT INTO memory_admissions VALUES(?,?,?,?,?) ON CONFLICT(scope,id,revision) DO UPDATE SET signature=excluded.signature');
      for (const row of this.db.prepare('SELECT scope,id,revision,generation,entry FROM revisions WHERE entry IS NOT NULL').iterate()) {
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
    this.db.exec(`CREATE TEMP TABLE memory_preimages(scope TEXT,id TEXT,revision TEXT,generation INTEGER,PRIMARY KEY(scope,id,revision));
      INSERT INTO memory_preimages SELECT c.scope,c.id,c.revision,MIN(c.generation) FROM (SELECT DISTINCT scope,id FROM memory_admissions WHERE generation IS NULL) u CROSS JOIN commit_views c ON c.scope=u.scope AND c.id=u.id GROUP BY c.scope,c.id,c.revision;`);
    const propagate = this.db.prepare(`INSERT INTO memory_preimages SELECT p.scope,p.id,json_extract(j.payload,'$.beforeRevision'),MIN(p.generation) FROM memory_preimages p CROSS JOIN journal j ON j.scope=p.scope AND j.id=p.id WHERE COALESCE(json_extract(j.payload,'$.afterRevision'),'legacy-deleted:'||json_extract(j.payload,'$.operationId'))=p.revision AND json_extract(j.payload,'$.beforeRevision') IS NOT NULL GROUP BY p.scope,p.id,json_extract(j.payload,'$.beforeRevision')
      ON CONFLICT(scope,id,revision) DO UPDATE SET generation=excluded.generation WHERE excluded.generation<memory_preimages.generation`);
    while (propagate.run().changes !== 0) {}
    this.db.exec(`UPDATE memory_admissions AS a SET generation=p.generation FROM memory_preimages p LEFT JOIN source_barriers b ON b.scope=p.scope AND b.id=(SELECT signature FROM memory_admissions WHERE scope=p.scope AND id=p.id AND revision=p.revision)
      WHERE a.scope=p.scope AND a.id=p.id AND a.revision=p.revision AND a.generation IS NULL AND (b.generation IS NULL OR p.generation<=b.generation);
      DROP TABLE memory_preimages;`);
  }
  note(scope: string, entry: MemoryEntry): void {
    this.db.prepare('UPDATE memory_admissions SET signature=? WHERE scope=? AND id=? AND revision=?').run(memorySourceUnitId(scope, entry.source, entry.body, entry.basis?.refs) ?? null, scope, entry.id, entry.revision);
  }
  private targets(): string {
    return `WITH changed AS (SELECT DISTINCT scope,id,revision FROM memory_changes WHERE sequence>(SELECT value FROM metadata WHERE key='memory_reconcile_sequence')), target AS (
      SELECT r.rowid AS row FROM changed c CROSS JOIN revisions r ON r.scope=c.scope AND r.id=c.id AND r.revision=c.revision
      UNION SELECT r.rowid FROM changed c CROSS JOIN revisions r ON r.scope=c.scope AND r.id=c.id WHERE c.revision IS NULL) `;
  }
  rows(): Iterable<Record<string, SQLOutputValue>> {
    return this.db.prepare(`${this.baseline ? '' : this.targets()}SELECT r.scope,r.id,r.revision,r.generation,r.entry FROM ${this.baseline ? 'revisions r' : 'target t CROSS JOIN revisions r ON r.rowid=t.row'} WHERE r.entry IS NOT NULL`).iterate();
  }
  evidenceRows(): Iterable<Record<string, SQLOutputValue>> {
    return this.db.prepare(`${this.baseline ? '' : this.targets()}SELECT DISTINCT r.scope,r.entry,l.key,l.payload FROM ${this.baseline ? 'revisions r' : 'target t CROSS JOIN revisions r ON r.rowid=t.row'} CROSS JOIN memory_admissions a ON a.scope=r.scope AND a.id=r.id AND a.revision=r.revision LEFT JOIN legacy l ON l.scope=r.scope AND l.object_id=r.id AND l.revision=r.revision LEFT JOIN operations p ON p.generation=r.generation LEFT JOIN operation_objects o ON o.operation_id=p.id AND o.scope=r.scope AND o.id=r.id LEFT JOIN sources s ON s.scope=r.scope AND s.object_id=r.id AND (s.payload=r.entry OR s.payload=l.payload) WHERE r.entry IS NOT NULL AND a.generation IS NOT NULL AND o.operation_id IS NULL AND s.id IS NULL`).iterate();
  }
  pending(): boolean { return this.db.prepare("SELECT 1 FROM memory_changes WHERE sequence>(SELECT value FROM metadata WHERE key='memory_reconcile_sequence') LIMIT 1").get() !== undefined; }
  acknowledge(): void {
    this.db.exec("UPDATE metadata SET value=COALESCE((SELECT seq FROM sqlite_sequence WHERE name='memory_changes'),0) WHERE key='memory_reconcile_sequence'; DELETE FROM memory_changes; INSERT INTO metadata VALUES('memory_reconcile_version',1) ON CONFLICT(key) DO UPDATE SET value=1;");
    this.db.exec("INSERT OR IGNORE INTO metadata VALUES('memory_quarantine_version',1)");
    this.baseline = false;
  }
  stash(kind: string, scope: string, id: string, revision: string, key: string, row: Record<string, SQLOutputValue>): void {
    this.db.prepare('INSERT OR IGNORE INTO memory_quarantine VALUES(?,?,?,?,?,?)').run(kind, scope, id, revision, key, JSON.stringify(row));
  }
  active(value: boolean): void { this.db.prepare("UPDATE metadata SET value=? WHERE key='memory_writer_active'").run(Number(value)); }
  admission(scope: string, id: string, revision: string): number | undefined {
    const value = this.db.prepare('SELECT generation FROM memory_admissions WHERE scope=? AND id=? AND revision=?').get(scope, id, revision)?.['generation'];
    return value === null || value === undefined ? undefined : Number(value);
  }
}
