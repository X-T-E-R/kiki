import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { MemoryEntry, MemoryJournalRecord } from '../../../app/memory/memoryStore.ts';
// oxlint-disable-next-line import/extensions
import { memoryObjectSourceUnitId, memorySourceUnitId } from '../../../app/memory/memorySourceIdentity.ts';
import type { MemoryCommit, MemoryCommitReceipt, MemoryImportResult, MemoryLegacyPayload, MemoryReadView, MemorySourceState, MemoryProvenance, MemoryAdjudication } from '../../interface/memoryPersistence.ts';

function conflict(message: string): never { throw Object.assign(new Error(message), { code: 'revision_conflict', committed: false }); }
function fingerprint(request: string): string { return createHash('sha256').update(request).digest('hex'); }

export class MemoryDatabase {
  private readonly db: DatabaseSync;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;`);
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.['user_version']);
    if (![0, 1, 2, 3].includes(version)) { this.db.close(); throw new Error('Unsupported Memory database schema'); }
    this.transaction(() => {
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
      CREATE TABLE IF NOT EXISTS source_barriers(scope TEXT NOT NULL,id TEXT NOT NULL,at TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS source_links(scope TEXT NOT NULL,source_id TEXT NOT NULL,object_id TEXT NOT NULL,PRIMARY KEY(scope,source_id,object_id));
      CREATE INDEX IF NOT EXISTS source_link_objects ON source_links(scope,object_id);
      CREATE TABLE IF NOT EXISTS source_signatures(scope TEXT NOT NULL,source_id TEXT NOT NULL,object_id TEXT NOT NULL,PRIMARY KEY(scope,source_id,object_id));
      CREATE INDEX IF NOT EXISTS source_signature_objects ON source_signatures(scope,object_id);
      `);
      if (version < 3) {
        for (const row of this.db.prepare('SELECT scope,entry FROM revisions WHERE entry IS NOT NULL').all()) {
          const scope = String(row['scope']);
          const entry = JSON.parse(String(row['entry'])) as MemoryEntry;
          const signature = memorySourceUnitId(scope, entry.source, entry.body, entry.basis?.refs);
          if (signature !== undefined) {
            this.db.prepare('INSERT OR IGNORE INTO source_signatures VALUES(?,?,?)').run(scope, signature, entry.id);
            this.db.prepare('DELETE FROM source_links WHERE scope=? AND source_id=?').run(scope, signature);
            const identity = memoryObjectSourceUnitId(scope, entry.id, entry.body);
            this.db.prepare('UPDATE OR IGNORE sources SET id=? WHERE scope=? AND id=? AND object_id=?').run(identity, scope, signature, entry.id);
          }
          this.linkEntrySource(scope, entry);
        }
        for (const row of this.db.prepare('SELECT l.scope,l.payload,r.entry FROM legacy l JOIN revisions r ON r.scope=l.scope AND r.id=l.object_id AND r.revision=l.revision WHERE r.entry IS NOT NULL').all()) {
          const entry = JSON.parse(String(row['entry'])) as MemoryEntry;
          const scope = String(row['scope']);
          if (this.blocked(scope, entry.id)) continue;
          this.db.prepare('INSERT OR IGNORE INTO sources VALUES(?,?,?,?,?,?)').run(memoryObjectSourceUnitId(scope, entry.id, entry.body), scope, entry.id, String(row['payload']), entry.basis?.refs?.[0] ?? null, entry.created);
        }
      }
      this.db.exec('INSERT OR IGNORE INTO source_links SELECT scope,id,object_id FROM sources');
      if (version < 3) this.linkLegacyLineages();
      this.db.exec('PRAGMA user_version=3');
    });
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
      const aliases = input.edits.flatMap((edit) => {
        this.linkHistoricalSources(edit.scope, edit.id);
        if (edit.entry === null) return [];
        const signature = memorySourceUnitId(edit.scope, edit.entry.source, edit.entry.body, edit.entry.basis?.refs);
        if (signature !== undefined && this.signatureBlocked(edit.scope, signature, edit.id)) conflict('Memory source has a forget barrier');
        return [{ scope: edit.scope, id: memoryObjectSourceUnitId(edit.scope, edit.id, edit.entry.body), objectId: edit.id }];
      });
      for (const source of input.sources ?? []) for (const id of source.aliases ?? []) {
        if (!/^source-unit:[a-f0-9]{64}$/.test(id)) throw new Error('Invalid Memory source alias');
        aliases.push({ scope: source.scope, id, objectId: source.objectId });
      }
      for (const source of input.sources ?? []) for (const signature of source.signatures ?? []) {
        if (!/^source-unit:[a-f0-9]{64}$/.test(signature)) throw new Error('Invalid Memory source signature');
        if (this.signatureBlocked(source.scope, signature, source.objectId)) conflict('Memory source has a forget barrier');
      }
      for (const alias of aliases) {
        if (this.db.prepare('SELECT 1 FROM source_barriers WHERE scope=? AND id=?').get(alias.scope, alias.id) !== undefined) conflict('Memory source has a forget barrier');
        const linked = this.db.prepare('SELECT object_id FROM source_links WHERE scope=? AND source_id=?').all(alias.scope, alias.id).map((row) => String(row['object_id']));
        if (linked.length > 0 && !linked.includes(alias.objectId) && !input.sourceTransfers?.some((transfer) => transfer.scope === alias.scope && transfer.to === alias.objectId && linked.includes(transfer.from))) conflict('Memory source was concurrently registered; reread its current lineage');
      }
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
        if (edit.entry !== null) this.linkEntrySource(edit.scope, edit.entry);
      }
      for (const source of input.sources ?? []) {
        if (this.blocked(source.scope, source.objectId) || this.db.prepare('SELECT 1 FROM source_barriers WHERE scope=? AND id=?').get(source.scope, source.id) !== undefined) conflict('Memory source has a forget barrier');
        if (this.db.prepare('SELECT 1 FROM sources WHERE id=?').get(source.id) !== undefined) conflict('Memory source was concurrently registered; reread its current lineage');
        this.db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?)').run(source.id, source.scope, source.objectId, source.payload, source.locator ?? null, source.learnedAt);
        this.db.prepare('INSERT INTO source_links VALUES(?,?,?)').run(source.scope, source.id, source.objectId);
        for (const signature of source.signatures ?? []) this.db.prepare('INSERT OR IGNORE INTO source_signatures VALUES(?,?,?)').run(source.scope, signature, source.objectId);
      }
      for (const alias of aliases) this.db.prepare('INSERT OR IGNORE INTO source_links VALUES(?,?,?)').run(alias.scope, alias.id, alias.objectId);
      for (const transfer of input.sourceTransfers ?? []) {
        const from = input.edits.find((edit) => edit.scope === transfer.scope && edit.id === transfer.from);
        const to = input.edits.find((edit) => edit.scope === transfer.scope && edit.id === transfer.to);
        if (to?.entry === undefined || to.entry === null) conflict('Invalid Memory source lineage transfer');
        if (from === undefined) {
          const parent = this.db.prepare('SELECT revision FROM heads WHERE scope=? AND id=?').get(transfer.scope, transfer.from);
          if (this.blocked(transfer.scope, transfer.from) || to.entry.status !== 'pending' || to.entry.supersedes !== transfer.from || to.entry.supersedes_revision !== parent?.['revision']) conflict('Memory proposal source changed');
        } else if (to.entry.status === 'pending' || from.entry !== null && (from.entry.status !== 'superseded' || to.entry.status !== 'active')) conflict('Invalid Memory source lineage transfer');
        this.db.prepare('INSERT OR IGNORE INTO source_links SELECT scope,source_id,? FROM source_links WHERE scope=? AND object_id=?').run(transfer.to, transfer.scope, transfer.from);
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
      const barriers = input.barriers ?? [];
      for (const barrier of barriers) this.linkHistoricalSources(barrier.scope, barrier.objectId);
      for (const barrier of barriers) for (const related of this.relatedObjects(barrier.scope, barrier.objectId)) {
        const row = this.db.prepare('SELECT r.entry FROM heads h JOIN revisions r ON r.scope=h.scope AND r.id=h.id AND r.revision=h.revision WHERE h.scope=? AND h.id=?').get(barrier.scope, related);
        if (row !== undefined && !barriers.some((target) => target.scope === barrier.scope && target.objectId === related)) conflict('Memory forget preview must include the complete source lineage');
      }
      for (const barrier of barriers) {
        this.db.prepare('INSERT OR IGNORE INTO barriers VALUES(?,?,?,?)').run(barrier.scope, barrier.objectId, barrier.at, generation);
        for (const table of ['source_links', 'source_signatures']) this.db.prepare(`INSERT OR IGNORE INTO source_barriers SELECT scope,source_id,?,? FROM ${table} WHERE scope=? AND object_id=?`).run(barrier.at, generation, barrier.scope, barrier.objectId);
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
  source(scope: string, id: string): MemorySourceState {
    if (this.db.prepare('SELECT 1 FROM source_barriers WHERE scope=? AND id=?').get(scope, id) !== undefined) return { state: 'forgotten', id, scope };
    const row = this.db.prepare('SELECT * FROM sources WHERE scope=? AND id=?').get(scope, id) ?? this.db.prepare('SELECT s.* FROM source_links a JOIN source_links l ON l.scope=a.scope AND l.object_id=a.object_id JOIN sources s ON s.scope=l.scope AND s.id=l.source_id WHERE a.scope=? AND a.source_id=? ORDER BY s.learned_at,s.id LIMIT 1').get(scope, id);
    return row === undefined ? { state: 'missing' } : { state: 'registered', source: { id: String(row['id']), scope, objectId: String(row['object_id']), payload: String(row['payload']), locator: row['locator'] === null ? undefined : String(row['locator']), learnedAt: String(row['learned_at']) }, objectIds: this.relatedObjects(scope, String(row['object_id'])) };
  }
  private signatureBlocked(scope: string, signature: string, objectId: string): boolean {
    return this.db.prepare('SELECT 1 FROM source_barriers WHERE scope=? AND id=?').get(scope, signature) !== undefined
      && this.db.prepare('SELECT 1 FROM source_signatures WHERE scope=? AND source_id=? AND object_id=?').get(scope, signature, objectId) === undefined;
  }
  private linkEntrySource(scope: string, entry: MemoryEntry): void {
    this.db.prepare('INSERT OR IGNORE INTO source_links VALUES(?,?,?)').run(scope, memoryObjectSourceUnitId(scope, entry.id, entry.body), entry.id);
    const signature = memorySourceUnitId(scope, entry.source, entry.body, entry.basis?.refs);
    if (signature !== undefined) this.db.prepare('INSERT OR IGNORE INTO source_signatures VALUES(?,?,?)').run(scope, signature, entry.id);
  }
  private linkHistoricalSources(scope: string, id: string): void {
    for (const row of this.db.prepare('SELECT entry FROM revisions WHERE scope=? AND id=? AND entry IS NOT NULL').all(scope, id)) this.linkEntrySource(scope, JSON.parse(String(row['entry'])) as MemoryEntry);
  }
  private linkLegacyLineages(): void {
    this.db.exec(`INSERT OR IGNORE INTO source_links SELECT r.scope,l.source_id,r.id FROM revisions r JOIN source_links l ON l.scope=r.scope AND l.object_id=json_extract(r.entry,'$.supersedes') WHERE r.entry IS NOT NULL;
      INSERT OR IGNORE INTO source_links SELECT r.scope,l.source_id,target.id FROM revisions r JOIN source_links l ON l.scope=r.scope AND l.object_id=r.id JOIN heads target ON target.scope=r.scope AND target.id=json_extract(r.entry,'$.superseded_by') WHERE r.entry IS NOT NULL;`);
  }
  provenance(scope: string, id: string): MemoryProvenance {
    this.linkHistoricalSources(scope, id);
    const sources = this.db.prepare('SELECT s.id FROM sources s JOIN source_links l ON l.scope=s.scope AND l.source_id=s.id WHERE l.scope=? AND l.object_id=? ORDER BY s.learned_at,s.id').all(scope, id).flatMap((row) => {
      const source = this.source(scope, String(row['id']));
      return source.state === 'registered' ? [source.source] : [];
    });
    const adjudications = this.db.prepare('SELECT payload FROM adjudications WHERE scope=? AND object_id=? ORDER BY generation,id').all(scope, id).map((row) => JSON.parse(String(row['payload'])) as MemoryAdjudication);
    return { sources, adjudications, relatedObjectIds: this.relatedObjects(scope, id) };
  }
  private relatedObjects(scope: string, id: string): string[] {
    return this.db.prepare('WITH RECURSIVE affected(id) AS (SELECT ? UNION SELECT linked.object_id FROM affected JOIN source_links origin ON origin.scope=? AND origin.object_id=affected.id JOIN source_links linked ON linked.scope=origin.scope AND linked.source_id=origin.source_id) SELECT id FROM affected ORDER BY id').all(id, scope).map((row) => String(row['id']));
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
        const sourceId = entry === undefined ? undefined : memoryObjectSourceUnitId(record.scope, entry.id, entry.body);
        const signature = entry === undefined ? undefined : memorySourceUnitId(record.scope, entry.source, entry.body, entry.basis?.refs);
        const source = sourceId === undefined ? undefined : this.source(record.scope, sourceId);
        let issue = record.issue;
        if (source?.state === 'forgotten' || signature !== undefined && this.signatureBlocked(record.scope, signature, entry!.id) || entry !== undefined && this.blocked(record.scope, entry.id) || entry === undefined && this.db.prepare('SELECT 1 FROM barriers WHERE scope=? LIMIT 1').get(record.scope) !== undefined) {
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
          if (sourceId !== undefined && this.db.prepare('SELECT 1 FROM sources WHERE id=?').get(sourceId) === undefined) this.db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?)').run(sourceId, record.scope, entry.id, record.payload, entry.basis?.refs?.[0] ?? null, entry.created);
          this.linkEntrySource(record.scope, entry);
        }
        this.db.prepare('INSERT INTO legacy VALUES(?,?,?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET payload=excluded.payload,object_id=excluded.object_id,revision=excluded.revision,issue=excluded.issue').run(record.scope, record.key, record.payload, entry?.id ?? null, entry?.revision ?? null, issue ?? null);
        if (issue !== undefined) issues.push({ scope: record.scope, key: record.key, issue });
      }
      this.linkLegacyLineages();
      this.db.prepare("UPDATE metadata SET value=? WHERE key='generation'").run(generation);
      return { imported, retained, issues };
    });
  }
  legacy(scope: string): readonly MemoryLegacyPayload[] {
    return this.db.prepare('SELECT * FROM legacy WHERE scope=? ORDER BY key').all(scope).map((row) => ({ scope, key: String(row['key']), payload: String(row['payload']), issue: row['issue'] === null ? undefined : String(row['issue']) }));
  }
  namespaces(): readonly string[] {
    return this.db.prepare('SELECT scope FROM heads UNION SELECT scope FROM barriers UNION SELECT scope FROM source_barriers UNION SELECT scope FROM legacy ORDER BY scope').all().map((row) => String(row['scope']));
  }
  async backup(destination: string): Promise<number> {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    await backup(this.db, destination);
    return this.generation();
  }
  close(): void { this.db.close(); }
}
