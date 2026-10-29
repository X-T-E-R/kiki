import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { deserialize, serialize } from 'node:v8';
import { isDeepStrictEqual } from 'node:util';
import type { UsageFact } from '../../../agent/usage/usageFact.ts';
import type { UsageReadModelAggregate, UsageReadModelQuery, UsageReadModelResult, UsageReadModelSession, UsageSourceHead, UsageImportProgress, UsageSourcePage } from '../../interface/usageReadModel.ts';
import type { UsageStoreOperation } from './usageProtocol.ts';

const COST_OVERFLOW = new Error('Usage cost overflow');
const APPLICATION_ID = 0x4b555332;
const COLUMNS = 'time,model,upstream_model,source_agent,agent,parent_agent,provider,model_alias,profile,turn,input_other,output,cache_read,cache_creation,state,mask,known,usage_scope,executor';
const EMPTY = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
type Row = Record<string, unknown>;

export class UsageDatabase {
  private readonly db: DatabaseSync;
  private readonly insertStage;
  private readonly hourTotalsAvailable;
  constructor(path: string, private readonly writable: boolean, private readonly check: () => void = () => {}) {
    if (writable) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { readOnly: !writable });
    try {
      this.db.exec('PRAGMA busy_timeout=50; PRAGMA foreign_keys=ON; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-16384');
      const app = Number(this.db.prepare('PRAGMA application_id').get()!['application_id']);
      const version = Number(this.db.prepare('PRAGMA user_version').get()!['user_version']);
      if ((app !== 0 && app !== APPLICATION_ID) || version > 2) throw new Error('Unsupported Usage read-model schema; upgrade this writer');
      if (app === 0 && this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() !== undefined) throw new Error('Unrecognized Usage database');
      if (writable) {
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL,revision INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS session(workspace TEXT NOT NULL,id TEXT NOT NULL,title TEXT,created REAL NOT NULL,updated REAL NOT NULL,archived INTEGER NOT NULL,deleted INTEGER NOT NULL,ephemeral INTEGER NOT NULL DEFAULT 0,present INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(workspace,id)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS source(id TEXT PRIMARY KEY,workspace TEXT,session_id TEXT,generation TEXT NOT NULL,checkpoint TEXT,journal_offset INTEGER NOT NULL DEFAULT 0,journal_size INTEGER NOT NULL DEFAULT 0,ordinal INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,present INTEGER NOT NULL DEFAULT 1,kind TEXT NOT NULL DEFAULT 'wire',retained_meta TEXT,building_generation TEXT,building_checkpoint TEXT,building_ordinal INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
          CREATE INDEX IF NOT EXISTS source_session ON source(workspace,session_id);
          CREATE TABLE IF NOT EXISTS fact(source TEXT NOT NULL,generation TEXT NOT NULL,ordinal INTEGER NOT NULL,time REAL NOT NULL,model TEXT NOT NULL,upstream_model TEXT,source_agent TEXT,agent TEXT,parent_agent TEXT,provider TEXT,model_alias TEXT,profile TEXT,turn REAL,input_other REAL NOT NULL,output REAL NOT NULL,cache_read REAL NOT NULL,cache_creation REAL NOT NULL,state INTEGER NOT NULL,mask INTEGER NOT NULL,known INTEGER,usage_scope TEXT,executor TEXT,PRIMARY KEY(source,generation,ordinal)) WITHOUT ROWID;
          CREATE INDEX IF NOT EXISTS fact_time ON fact(time,source,generation,ordinal);
          CREATE TABLE IF NOT EXISTS source_model_total(source TEXT NOT NULL,generation TEXT NOT NULL,model TEXT NOT NULL,state INTEGER NOT NULL,mask INTEGER NOT NULL,input_other REAL NOT NULL,output REAL NOT NULL,cache_read REAL NOT NULL,cache_creation REAL NOT NULL,records INTEGER NOT NULL,PRIMARY KEY(source,generation,model,state,mask)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS source_hour_total_v1(source TEXT NOT NULL,generation TEXT NOT NULL,identity TEXT NOT NULL,time REAL NOT NULL,latest_time REAL NOT NULL,model TEXT NOT NULL,source_agent TEXT,agent TEXT,parent_agent TEXT,provider TEXT,model_alias TEXT,profile TEXT,turn REAL,input_other REAL NOT NULL,output REAL NOT NULL,cache_read REAL NOT NULL,cache_creation REAL NOT NULL,state INTEGER NOT NULL,mask INTEGER NOT NULL,record_count INTEGER NOT NULL,precise INTEGER NOT NULL,PRIMARY KEY(source,generation,identity)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS source_hour_head_v1(source TEXT NOT NULL,generation TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(source,generation)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS retired_generation(source TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(source,generation)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS retained_publication(ledger TEXT NOT NULL,target TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(ledger,target)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS import(source TEXT PRIMARY KEY,progress TEXT NOT NULL) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS stage(source TEXT NOT NULL,ordinal INTEGER NOT NULL,time REAL NOT NULL,model TEXT NOT NULL,upstream_model TEXT,source_agent TEXT,agent TEXT,parent_agent TEXT,provider TEXT,model_alias TEXT,profile TEXT,turn REAL,input_other REAL NOT NULL,output REAL NOT NULL,cache_read REAL NOT NULL,cache_creation REAL NOT NULL,state INTEGER NOT NULL,mask INTEGER NOT NULL,known INTEGER,usage_scope TEXT,executor TEXT,PRIMARY KEY(source,ordinal)) WITHOUT ROWID;
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=2; COMMIT;`);
        this.db.prepare('INSERT OR IGNORE INTO meta VALUES(1,?,0)').run(randomUUID());
      } else if (app !== APPLICATION_ID || version !== 2) throw new Error('Usage read model is preparing');
      this.hourTotalsAvailable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='source_hour_head_v1'").get() !== undefined;
      this.db.function('usage_check', () => { this.check(); return 1; });
      this.db.aggregate<number>('usage_finite_sum', { start: 0, step: (total, value) => { const next = total + Number(value); return Number.isFinite(next) ? next : total; } });
      this.db.function('usage_bucket', { deterministic: true }, (time, granularity, offset) => bucket(Number(time), String(granularity), Number(offset)));
      this.insertStage = writable ? this.db.prepare(`INSERT INTO stage(source,ordinal,${COLUMNS}) VALUES(${Array.from({ length: 21 }, () => '?').join(',')})`) : undefined;
    } catch (error) { this.db.close(); throw error; }
  }

  execute(operation: UsageStoreOperation): unknown {
    this.check();
    switch (operation.type) {
      case 'source': return this.source(operation.source);
      case 'sources': return this.snapshot(() => this.db.prepare('SELECT * FROM source').all().map((row) => { this.check(); return { source: String(row['id']), head: sourceHeadOf(row) }; }));
      case 'progress': return this.progress(operation.source);
      case 'apply': return this.transaction(() => this.apply(operation.page));
      case 'maintain': return this.transaction(() => this.backfillHourTotals());
      case 'abandon': return this.transaction(() => { this.db.prepare('DELETE FROM stage WHERE source=?').run(operation.source); this.db.prepare('DELETE FROM import WHERE source=?').run(operation.source); });
      case 'invalidate': return this.transaction(() => {
        const row = this.db.prepare('SELECT generation,building_generation FROM source WHERE id=?').get(operation.source);
        if (row !== undefined) {
          this.db.prepare('INSERT OR IGNORE INTO retired_generation VALUES(?,?)').run(operation.source, String(row['generation']));
          if (row['building_generation'] !== null) this.db.prepare('INSERT OR IGNORE INTO retired_generation VALUES(?,?)').run(operation.source, String(row['building_generation']));
          this.db.prepare('UPDATE source SET generation=?,checkpoint=NULL,journal_offset=0,journal_size=0,ordinal=0,building_generation=NULL,building_checkpoint=NULL,building_ordinal=0,revision=revision+1 WHERE id=?').run(randomUUID(), operation.source);
          this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
        }
        this.db.prepare('DELETE FROM stage WHERE source=?').run(operation.source);
        this.db.prepare('DELETE FROM import WHERE source=?').run(operation.source);
        this.collectRetired();
      });
      case 'read': return this.snapshot(() => {
        const head = this.source(operation.source);
        if (head?.checkpoint === undefined) return { head, records: [] };
        const row = this.db.prepare('SELECT generation FROM source WHERE id=?').get(operation.source)!;
        const parameters: SQLInputValue[] = [operation.source, String(row['generation']), operation.offset ?? 0];
        const clauses = ['source=?', 'generation=?', 'ordinal>=?'];
        if (operation.until !== undefined) { clauses.push('ordinal<?'); parameters.push(operation.until); }
        if (operation.range?.startAt !== undefined) { clauses.push('(time>=? OR state=3)'); parameters.push(operation.range.startAt); }
        if (operation.range?.endAt !== undefined) { clauses.push('(time<? OR state=3)'); parameters.push(operation.range.endAt); }
        parameters.push((operation.limit ?? 1000) + 1);
        const rows = this.db.prepare(`SELECT * FROM fact WHERE ${clauses.join(' AND ')} ORDER BY ordinal LIMIT ?`).all(...parameters);
        const more = rows.length > (operation.limit ?? 1000);
        if (more) rows.pop();
        return { head, records: rows.map(factOf), nextOffset: more ? Number(rows.at(-1)!['ordinal']) + 1 : undefined };
      });
      case 'summary': return this.snapshot(() => {
        const head = this.source(operation.source);
        if (head?.checkpoint === undefined) return { head };
        const rows = this.db.prepare('SELECT t.* FROM source_model_total t JOIN source s ON t.source=s.id AND t.generation=s.generation WHERE s.id=?').all(operation.source);
        const byModel: Record<string, typeof EMPTY> = {};
        const byModelMask: Record<string, Record<string, typeof EMPTY>> = {};
        const usage = { ...EMPTY };
        let records = 0, knownUsageRecords = 0, partial = !head.checkpoint.valid;
        for (const row of rows) {
          if (Number(row['state']) === 3) { partial = true; continue; }
          records += Number(row['records']);
          if (Number(row['state']) !== 0) { partial = true; continue; }
          knownUsageRecords += Number(row['records']);
          const model = String(row['model']);
          const value = tokenOf(row);
          const current = byModel[model] ?? { ...EMPTY };
          for (const key of Object.keys(EMPTY) as (keyof typeof EMPTY)[]) { usage[key] += value[key]; current[key] += value[key]; }
          Object.defineProperty(byModel, model, { value: current, enumerable: true, writable: true, configurable: true });
          const masks = Object.hasOwn(byModelMask, model) ? byModelMask[model]! : {};
          masks[String(row['mask'])] = value;
          Object.defineProperty(byModelMask, model, { value: masks, enumerable: true, writable: true, configurable: true });
        }
        return { head, totals: { version: 2, usage, byModel, byModelMask, records, knownUsageRecords, partial } };
      });
      case 'catalog': return this.transaction(() => this.catalog(operation.sessions, operation.sources, operation.inventory));
      case 'models': return this.db.prepare('SELECT DISTINCT t.model FROM source_model_total t JOIN source s ON t.source=s.id AND t.generation=s.generation WHERE s.present=1').all().map((row) => String(row['model']));
      case 'retained': return this.db.prepare("SELECT id,retained_meta FROM source WHERE kind='retained' AND present=1 AND retained_meta IS NOT NULL").all().map((row) => ({ source: String(row['id']), session: JSON.parse(String(row['retained_meta'])) as UsageReadModelSession })).filter((row) => operation.workspaceIds === undefined || operation.workspaceIds.includes(row.session.workspaceId));
      case 'settleRetained': return this.transaction(() => {
        const changed = this.db.prepare("UPDATE source SET present=0 WHERE kind='retained' AND present=1 AND id IN (SELECT target FROM retained_publication WHERE ledger=? AND generation!=?)").run(operation.ledger, operation.generation).changes;
        this.db.exec("UPDATE session SET present=0 WHERE deleted=1 AND present=1 AND NOT EXISTS(SELECT 1 FROM source s WHERE s.workspace=session.workspace AND s.session_id=session.id AND s.kind='retained' AND s.present=1)");
        if (Number(changed) > 0) this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
      });
      case 'query': return this.snapshot(() => {
        try { return this.query(operation.query); }
        catch (error) { if (error !== COST_OVERFLOW) throw error; return this.query(operation.query, true); }
      });
      case 'close': this.db.close(); return undefined;
    }
  }

  private transaction<T>(work: () => T): T {
    if (!this.writable) throw Object.assign(new Error('Usage writer is owned by another process'), { code: 'usage.read_only', committed: false });
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private snapshot<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try { const value = work(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private source(source: string): UsageSourceHead | undefined {
    const row = this.db.prepare('SELECT * FROM source WHERE id=?').get(source);
    return row === undefined ? undefined : sourceHeadOf(row);
  }
  private progress(source: string): UsageImportProgress | undefined {
    const row = this.db.prepare('SELECT progress FROM import WHERE source=?').get(source);
    return row === undefined ? undefined : deserialize(Buffer.from(String(row['progress']), 'base64')) as UsageImportProgress;
  }
  private apply(page: UsageSourcePage): boolean {
    if (!isDeepStrictEqual(this.progress(page.source), page.expected)) return false;
    this.db.prepare('INSERT OR IGNORE INTO source(id,generation) VALUES(?,?)').run(page.source, randomUUID());
    if (page.reset) this.db.prepare('DELETE FROM stage WHERE source=?').run(page.source);
    const first = page.progress.ordinal - page.records.length;
    if (!Number.isSafeInteger(first) || first < 0) throw new Error('Invalid Usage ordinal');
    for (const [index, fact] of page.records.entries()) {
      this.check();
      const state = fact.invalid ? 3 : fact.usageKnown === false ? 1 : fact.usageKnown === undefined && Object.values(fact.usage).every((value) => value === 0) ? 2 : 0;
      this.insertStage!.run(page.source, first + index, fact.time, fact.model, fact.upstreamModelId ?? null, fact.sourceAgentId ?? null, fact.agentId ?? null, fact.parentAgentId ?? null, fact.provider ?? null, fact.modelAlias ?? null, fact.profileName ?? null, fact.turnId ?? null, fact.usage.inputOther, fact.usage.output, fact.usage.inputCacheRead, fact.usage.inputCacheCreation, state, maskOf(fact), fact.usageKnown === undefined ? null : Number(fact.usageKnown), fact.usageScope ?? null, fact.executorId ?? null);
    }
    this.db.prepare('INSERT INTO import VALUES(?,?) ON CONFLICT(source) DO UPDATE SET progress=excluded.progress').run(page.source, serialize(page.progress).toString('base64'));
    if (page.publish === undefined) return true;
    const { start, checkpoint, journalSize, session } = page.publish;
    const target = page.publish.source ?? page.source;
    this.db.prepare('INSERT OR IGNORE INTO source(id,generation) VALUES(?,?)').run(target, randomUUID());
    const head = this.source(target)!;
    const current = this.db.prepare('SELECT * FROM source WHERE id=?').get(target)!;
    const previous = head.pendingCheckpoint ?? head.checkpoint;
    const replace = start === 0;
    const accepted = !isDeepStrictEqual(previous, checkpoint) && (replace || previous?.generation === checkpoint.generation && start === previous.offset);
    if (accepted) {
      const generation = replace ? randomUUID() : String(current['building_generation'] ?? current['generation']);
      const ordinal = replace ? 0 : Number(current['building_generation'] === null ? current['ordinal'] : current['building_ordinal']);
      this.db.prepare(`INSERT INTO fact SELECT ?,?,ordinal+?,${COLUMNS} FROM stage WHERE source=?`).run(target, generation, ordinal, page.source);
      this.db.prepare(`INSERT INTO source_model_total SELECT ?,?,model,state,mask,SUM(input_other),SUM(output),SUM(cache_read),SUM(cache_creation),COUNT(*) FROM stage WHERE source=? GROUP BY model,state,mask
        ON CONFLICT(source,generation,model,state,mask) DO UPDATE SET input_other=input_other+excluded.input_other,output=output+excluded.output,cache_read=cache_read+excluded.cache_read,cache_creation=cache_creation+excluded.cache_creation,records=records+excluded.records`).run(target, generation, page.source);
      const totalHead = this.db.prepare('SELECT ordinal FROM source_hour_head_v1 WHERE source=? AND generation=?').get(target, generation);
      if (ordinal === 0 || totalHead?.['ordinal'] === ordinal) this.extendHourTotals(target, generation, ordinal, ordinal + page.progress.ordinal);
      const valid = checkpoint.valid && (replace || previous?.valid !== false) && this.db.prepare('SELECT 1 FROM stage WHERE source=? AND state=3 LIMIT 1').get(page.source) === undefined;
      const building = session === undefined && head.checkpoint !== undefined && checkpoint.offset < checkpoint.size && (replace || head.pendingCheckpoint !== undefined);
      const retire = this.db.prepare('INSERT OR IGNORE INTO retired_generation VALUES(?,?)');
      if (!building && current['generation'] !== generation) retire.run(target, String(current['generation']));
      if (current['building_generation'] !== null && current['building_generation'] !== generation) retire.run(target, String(current['building_generation']));
      if (building) this.db.prepare('UPDATE source SET building_generation=?,building_checkpoint=?,building_ordinal=?,revision=revision+1 WHERE id=?').run(generation, JSON.stringify({ ...checkpoint, valid }), ordinal + page.progress.ordinal, target);
      else this.db.prepare('UPDATE source SET generation=?,checkpoint=?,ordinal=?,building_generation=NULL,building_checkpoint=NULL,building_ordinal=0,revision=revision+1 WHERE id=?').run(generation, JSON.stringify({ ...checkpoint, valid }), ordinal + page.progress.ordinal, target);
      if (session !== undefined) {
        this.db.prepare('INSERT INTO retained_publication VALUES(?,?,?) ON CONFLICT(ledger,target) DO UPDATE SET generation=excluded.generation').run(page.source, target, checkpoint.generation);
        this.db.prepare("UPDATE source SET kind='retained',workspace=?,session_id=?,retained_meta=?,present=1 WHERE id=?").run(session.workspaceId, session.id, JSON.stringify(session), target);
        const live = this.db.prepare('SELECT present,deleted FROM session WHERE workspace=? AND id=?').get(session.workspaceId, session.id);
        if (live === undefined || !live['present'] || live['deleted']) this.catalog([session], [], false);
      }
      if (page.progress.ordinal > 0 || replace) this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
    }
    this.db.prepare('UPDATE source SET journal_offset=?,journal_size=? WHERE id=?').run(page.progress.offset, journalSize, page.source);
    this.db.prepare('DELETE FROM stage WHERE source=?').run(page.source);
    if (page.continuation === undefined) this.db.prepare('DELETE FROM import WHERE source=?').run(page.source);
    else this.db.prepare('UPDATE import SET progress=? WHERE source=?').run(serialize(page.continuation).toString('base64'), page.source);
    this.collectRetired();
    return true;
  }
  private extendHourTotals(source: string, generation: string, start: number, until: number): void {
    const identity = 'json_array(CAST(floor(time/3600000) AS INTEGER),model,source_agent,agent,parent_agent,provider,model_alias,profile,turn,state,mask)';
    const precise = ['input_other', 'output', 'cache_read', 'cache_creation'].map((column) => `${column}=floor(${column}) AND ${column}<=9007199254740991`).join(' AND ');
    this.db.prepare(`INSERT INTO source_hour_total_v1 SELECT source,generation,${identity},min(time),max(time),model,source_agent,agent,parent_agent,provider,model_alias,profile,turn,sum(input_other),sum(output),sum(cache_read),sum(cache_creation),state,mask,count(*),min(${precise}) FROM fact WHERE source=? AND generation=? AND ordinal>=? AND ordinal<? AND state!=3 AND usage_check()=1 GROUP BY ${identity}
      ON CONFLICT(source,generation,identity) DO UPDATE SET time=min(time,excluded.time),latest_time=max(latest_time,excluded.latest_time),input_other=input_other+excluded.input_other,output=output+excluded.output,cache_read=cache_read+excluded.cache_read,cache_creation=cache_creation+excluded.cache_creation,record_count=record_count+excluded.record_count,precise=min(precise,excluded.precise)`).run(source, generation, start, until);
    this.db.prepare('INSERT INTO source_hour_head_v1 VALUES(?,?,?) ON CONFLICT(source,generation) DO UPDATE SET ordinal=excluded.ordinal').run(source, generation, until);
  }
  private backfillHourTotals(): boolean {
    let remaining = 32768, completed = 0;
    const sources = this.db.prepare('SELECT s.id,s.generation,s.ordinal,coalesce(h.ordinal,0) AS start FROM source s LEFT JOIN source_hour_head_v1 h ON h.source=s.id AND h.generation=s.generation WHERE s.present=1 AND s.ordinal>coalesce(h.ordinal,0) ORDER BY s.id LIMIT 128').all();
    for (const row of sources) {
      this.check();
      const start = Number(row['start']), until = Math.min(Number(row['ordinal']), start + remaining);
      this.extendHourTotals(String(row['id']), String(row['generation']), start, until);
      remaining -= until - start;
      if (until === Number(row['ordinal'])) completed++;
      if (remaining === 0) break;
    }
    if (completed > 0) this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
    return this.db.prepare('SELECT 1 FROM source s LEFT JOIN source_hour_head_v1 h ON h.source=s.id AND h.generation=s.generation WHERE s.present=1 AND s.ordinal>coalesce(h.ordinal,0) LIMIT 1').get() !== undefined;
  }
  private collectRetired(): void {
    const retired = this.db.prepare('SELECT * FROM retired_generation LIMIT 1').get();
    if (retired === undefined) return;
    const source = String(retired['source']), generation = String(retired['generation']);
    this.db.prepare('DELETE FROM fact WHERE (source,generation,ordinal) IN (SELECT source,generation,ordinal FROM fact WHERE source=? AND generation=? LIMIT 2048)').run(source, generation);
    if (this.db.prepare('SELECT 1 FROM fact WHERE source=? AND generation=? LIMIT 1').get(source, generation) !== undefined) return;
    this.db.prepare('DELETE FROM source_model_total WHERE source=? AND generation=?').run(source, generation);
    this.db.prepare('DELETE FROM source_hour_total_v1 WHERE (source,generation,identity) IN (SELECT source,generation,identity FROM source_hour_total_v1 WHERE source=? AND generation=? LIMIT 2048)').run(source, generation);
    if (this.db.prepare('SELECT 1 FROM source_hour_total_v1 WHERE source=? AND generation=? LIMIT 1').get(source, generation) !== undefined) return;
    this.db.prepare('DELETE FROM source_hour_head_v1 WHERE source=? AND generation=?').run(source, generation);
    this.db.prepare('DELETE FROM retired_generation WHERE source=? AND generation=?').run(source, generation);
  }
  private catalog(sessions: readonly UsageReadModelSession[], sources: readonly { source: string; workspaceId: string; sessionId: string }[], inventory?: boolean): void {
    let changed = 0;
    if (inventory) {
      this.db.exec('CREATE TEMP TABLE IF NOT EXISTS inventory_session(workspace TEXT,id TEXT,PRIMARY KEY(workspace,id)) WITHOUT ROWID; DELETE FROM inventory_session; CREATE TEMP TABLE IF NOT EXISTS inventory_source(id TEXT PRIMARY KEY) WITHOUT ROWID; DELETE FROM inventory_source');
      const session = this.db.prepare('INSERT INTO inventory_session VALUES(?,?)');
      const source = this.db.prepare('INSERT INTO inventory_source VALUES(?)');
      for (const item of sessions) session.run(item.workspaceId, item.id);
      for (const item of sources) source.run(item.source);
      changed += Number(this.db.prepare('UPDATE session SET present=0 WHERE deleted=0 AND present=1 AND NOT EXISTS(SELECT 1 FROM inventory_session i WHERE i.workspace=session.workspace AND i.id=session.id)').run().changes);
      changed += Number(this.db.prepare("UPDATE source SET present=0 WHERE kind='wire' AND present=1 AND NOT EXISTS(SELECT 1 FROM inventory_source i WHERE i.id=source.id) AND EXISTS(SELECT 1 FROM session s WHERE s.workspace=source.workspace AND s.id=source.session_id AND s.deleted=0)").run().changes);
      for (const row of this.db.prepare("SELECT retained_meta FROM source s WHERE kind='retained' AND present=1 AND EXISTS(SELECT 1 FROM session u WHERE u.workspace=s.workspace AND u.id=s.session_id AND u.present=0)").all()) this.catalog([JSON.parse(String(row['retained_meta'])) as UsageReadModelSession], [], false);
    }
    const put = this.db.prepare(`INSERT INTO session VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(workspace,id) DO UPDATE SET title=excluded.title,created=excluded.created,updated=excluded.updated,archived=excluded.archived,deleted=excluded.deleted,ephemeral=excluded.ephemeral,present=1
      WHERE title IS NOT excluded.title OR created!=excluded.created OR updated!=excluded.updated OR archived!=excluded.archived OR deleted!=excluded.deleted OR ephemeral!=excluded.ephemeral OR present!=1`);
    for (const item of sessions) changed += Number(put.run(item.workspaceId, item.id, item.title ?? null, item.createdAt, item.updatedAt, Number(item.archived), Number(item.deleted), Number(item.ephemeral ?? false)).changes);
    const source = this.db.prepare(`INSERT INTO source(id,generation,workspace,session_id) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace,session_id=excluded.session_id,present=1 WHERE workspace IS NOT excluded.workspace OR session_id IS NOT excluded.session_id OR present!=1`);
    for (const item of sources) changed += Number(source.run(item.source, randomUUID(), item.workspaceId, item.sessionId).changes);
    this.backfillHourTotals();
    this.collectRetired();
    if (changed > 0) this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
  }

  private query(query: UsageReadModelQuery, finiteCosts = false): UsageReadModelResult {
    const meta = this.db.prepare('SELECT * FROM meta WHERE id=1').get()!;
    const revision = `${text(meta['epoch'])}:${Number(meta['revision'])}`;
    if (query.expectedRevision !== undefined && query.expectedRevision !== revision) throw Object.assign(new Error('Usage data changed; restart pagination'), { code: 'usage.revision_changed' });
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS quote(model TEXT PRIMARY KEY,i REAL,o REAL,r REAL,c REAL) WITHOUT ROWID; DELETE FROM quote');
    const quote = this.db.prepare('INSERT INTO quote VALUES(?,?,?,?,?)');
    for (const value of query.quotes) quote.run(value.model, value.inputOther ?? null, value.output ?? null, value.inputCacheRead ?? null, value.inputCacheCreation ?? null);
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS excluded_source(id TEXT PRIMARY KEY) WITHOUT ROWID; DELETE FROM excluded_source');
    const exclude = this.db.prepare('INSERT OR IGNORE INTO excluded_source VALUES(?)');
    for (const source of query.excludedSources ?? []) exclude.run(source);
    const parameters: SQLInputValue[] = [];
    const clauses = ['s.present=1', 'u.present=1', "((s.kind='wire' AND u.deleted=0) OR (s.kind='retained' AND u.deleted=1))", 'f.generation=s.generation', 'f.state!=3', 'usage_check()=1'];
    if (!query.includeArchived) clauses.push('u.archived=0');
    if (query.startAt !== undefined) { clauses.push('f.time>=?'); parameters.push(query.startAt); }
    if (query.endAt !== undefined) { clauses.push('f.time<?'); parameters.push(query.endAt); }
    const filter = (column: string, values: readonly string[]): void => { if (values.length > 0) { clauses.push(`${column} IN (${values.map(() => '?').join(',')})`); parameters.push(...values); } };
    if (query.models.length > 0) { clauses.push(`(f.model IN (${query.models.map(() => '?').join(',')}) OR (u.ephemeral=0 AND f.model_alias IN (${query.models.map(() => '?').join(',')})))`); parameters.push(...query.models, ...query.models); }
    filter('f.provider', query.providers); filter('f.profile', query.profiles); filter('f.agent', query.agentIds); filter('s.workspace', query.workspaceIds);
    if (query.providers.length + query.profiles.length + query.agentIds.length > 0) clauses.push('u.ephemeral=0');
    const cost = `CASE WHEN f.mask=0 THEN 0 WHEN ((f.mask&1)=0 OR q.i IS NOT NULL) AND ((f.mask&2)=0 OR q.o IS NOT NULL) AND ((f.mask&4)=0 OR q.r IS NOT NULL) AND ((f.mask&8)=0 OR q.c IS NOT NULL) THEN f.input_other*coalesce(q.i,0)+f.output*coalesce(q.o,0)+f.cache_read*coalesce(q.r,0)+f.cache_creation*coalesce(q.c,0) END`;
    const dimension = query.dimension === 'model' ? "CASE WHEN u.ephemeral=1 THEN f.model ELSE coalesce(f.model_alias,'unknown') END" : query.dimension === 'agent' ? "CASE WHEN u.ephemeral=1 THEN 'ephemeral' ELSE coalesce(f.agent,'unknown') END" : query.dimension === 'project' ? 's.workspace' : query.dimension === 'session' ? "CASE WHEN u.ephemeral=1 THEN 'ephemeral' ELSE s.session_id END" : query.dimension === 'provider' ? "'provider:'||json_quote(f.provider)" : "'profile:'||json_quote(f.profile)";
    const nativeBucket = query.granularity === 'five_hour' ? 18_000_000 : query.granularity === 'day' ? 86_400_000 : undefined;
    const bucketKey = query.granularity === 'session' ? 's.session_id' : nativeBucket === undefined ? 'CAST(CAST(usage_bucket(f.time,?,?) AS INTEGER) AS TEXT)' : `CAST(CAST(floor((f.time+?)/${nativeBucket})*${nativeBucket}-? AS INTEGER) AS TEXT)`;
    const bucketParams: SQLInputValue[] = query.granularity === 'session' ? [] : nativeBucket === undefined ? [query.granularity, query.timezoneOffsetMinutes] : [query.timezoneOffsetMinutes * 60_000, query.timezoneOffsetMinutes * 60_000];
    this.db.exec('DROP TABLE IF EXISTS temp.usage_selected; DROP TABLE IF EXISTS temp.usage_sources');
    try {
    this.db.exec(`CREATE TEMP TABLE usage_sources AS SELECT row_number() OVER(ORDER BY s.id) AS source_number,s.*,${this.hourTotalsAvailable ? 'h.ordinal' : 'NULL'} AS total_ordinal FROM source s ${this.hourTotalsAvailable ? 'LEFT JOIN source_hour_head_v1 h ON h.source=s.id AND h.generation=s.generation' : ''}; CREATE UNIQUE INDEX usage_source_number ON usage_sources(source_number)`);
    const sourceSelection = (rolled: boolean): string => `SELECT s.source_number,f.time,${rolled ? 'f.latest_time,f.record_count,' : ''}f.model,f.source_agent,f.agent,f.parent_agent,f.provider,f.model_alias,f.profile,f.turn,f.input_other,f.output,f.cache_read,f.cache_creation,f.state,f.mask,s.workspace,s.session_id,u.ephemeral,${cost} AS raw_cost,${dimension} AS group_key,${bucketKey} AS bucket FROM usage_sources s JOIN session u ON s.workspace=u.workspace AND s.session_id=u.id CROSS JOIN ${rolled ? 'source_hour_total_v1' : 'fact'} f NOT INDEXED ON f.source=s.id AND f.generation=s.generation LEFT JOIN quote q ON q.model=f.model WHERE s.source_number=? AND ${clauses.join(' AND ')}`;
    const selected = sourceSelection(false);
    const identities = 'source_number,bucket,turn,model,source_agent,agent,parent_agent,provider,model_alias,profile,state,mask';
    const compact = `WITH selected AS (${selected}) SELECT min(time) AS time,max(time) AS latest_time,${identities},min(workspace) AS workspace,min(session_id) AS session_id,min(ephemeral) AS ephemeral,min(group_key) AS group_key,sum(input_other) AS input_other,sum(output) AS output,sum(cache_read) AS cache_read,sum(cache_creation) AS cache_creation,sum(CASE WHEN raw_cost<=1.7976931348623157e308 THEN raw_cost END) AS raw_cost,max(raw_cost IS NULL OR raw_cost>1.7976931348623157e308) AS price_unknown,count(*) AS record_count FROM selected GROUP BY ${identities}`;
    const individual = `SELECT *,time AS latest_time,raw_cost IS NULL OR raw_cost>1.7976931348623157e308 AS price_unknown,1 AS record_count FROM (${selected})`;
    const projection = finiteCosts ? individual : compact;
    this.db.prepare(`CREATE TEMP TABLE usage_selected AS ${projection} LIMIT 0`).run(...bucketParams, 0, ...parameters);
    const append = this.db.prepare(`INSERT INTO usage_selected ${projection}`);
    const rolled = !finiteCosts && this.hourTotalsAvailable ? this.db.prepare(`INSERT INTO usage_selected WITH selected AS (${sourceSelection(true)}) SELECT time,latest_time,${identities},workspace,session_id,ephemeral,group_key,input_other,output,cache_read,cache_creation,raw_cost,raw_cost IS NULL OR raw_cost>1.7976931348623157e308 AS price_unknown,record_count FROM selected`) : undefined;
    const overlap: string[] = [], unsafe = ['precise=0', ...['input_other', 'output', 'cache_read', 'cache_creation'].map((column) => `${column}>9007199254740991`)];
    const overlapArgs: SQLInputValue[] = [], unsafeArgs: SQLInputValue[] = [];
    if (query.startAt !== undefined) { overlap.push('latest_time>=?'); overlapArgs.push(query.startAt); unsafe.push('time<?'); unsafeArgs.push(query.startAt); }
    if (query.endAt !== undefined) { overlap.push('time<?'); overlapArgs.push(query.endAt); unsafe.push('latest_time>=?'); unsafeArgs.push(query.endAt); }
    if (query.granularity !== 'session') {
      unsafe.push('usage_bucket(time,?,?)!=usage_bucket(latest_time,?,?)');
      unsafeArgs.push(query.granularity, query.timezoneOffsetMinutes, query.granularity, query.timezoneOffsetMinutes);
    }
    const boundary = rolled === undefined ? undefined : this.db.prepare(`SELECT 1 FROM source_hour_total_v1 WHERE source=? AND generation=? ${overlap.length === 0 ? '' : `AND ${overlap.join(' AND ')}`} AND (${unsafe.join(' OR ')}) LIMIT 1`);
    for (const source of this.db.prepare('SELECT source_number,id,generation,ordinal,total_ordinal FROM usage_sources WHERE present=1').iterate()) {
      this.check();
      const prepared = rolled !== undefined && source['total_ordinal'] === source['ordinal'] && boundary!.get(String(source['id']), String(source['generation']), ...overlapArgs, ...unsafeArgs) === undefined;
      (prepared ? rolled! : append).run(...bucketParams, Number(source['source_number']), ...parameters);
    }
    this.db.exec('CREATE INDEX usage_selected_session ON usage_selected(workspace,session_id)');
    if (!finiteCosts && this.db.prepare('SELECT 1 FROM usage_selected WHERE raw_cost>1.7976931348623157e308 LIMIT 1').get() !== undefined) throw COST_OVERFLOW;
    const cte = 'WITH priced AS (SELECT *,CASE WHEN state=0 AND raw_cost<=1.7976931348623157e308 THEN raw_cost END AS cost FROM usage_selected)';
    const all = (sql: string, extra: SQLInputValue[] = []): Row[] => {
      this.check();
      const rows = this.db.prepare(`${cte} ${sql}`).all(...extra);
      if (!finiteCosts && rows.some((row) => Object.hasOwn(row, 'cost') && !Number.isFinite(Number(row['cost'])))) throw COST_OVERFLOW;
      return rows;
    };
    const aggregate = `coalesce(sum(CASE WHEN state=0 THEN input_other ELSE 0 END),0) AS input_other,coalesce(sum(CASE WHEN state=0 THEN output ELSE 0 END),0) AS output,coalesce(sum(CASE WHEN state=0 THEN cache_read ELSE 0 END),0) AS cache_read,coalesce(sum(CASE WHEN state=0 THEN cache_creation ELSE 0 END),0) AS cache_creation,coalesce(${finiteCosts ? 'usage_finite_sum' : 'sum'}(cost),0) AS cost,(max(cost IS NULL OR price_unknown) OR sum(cost)>1.7976931348623157e308) AS cost_unknown,sum(CASE WHEN state=0 THEN record_count ELSE 0 END) AS known,sum(CASE WHEN state=1 THEN record_count ELSE 0 END) AS missing,sum(CASE WHEN state=2 THEN record_count ELSE 0 END) AS legacy`;
    const totals = all(`SELECT ${aggregate},min(time) AS earliest,max(latest_time) AS latest,count(DISTINCT CASE WHEN ephemeral=0 THEN session_id END) AS sessions FROM priced`)[0]!;
    const unknown = all('SELECT DISTINCT model FROM priced WHERE price_unknown ORDER BY model').map((row) => String(row['model']));
    const groups = all(`SELECT bucket,group_key,${aggregate},CASE WHEN count(DISTINCT coalesce(provider,char(0)))=1 THEN min(provider) END AS provider,CASE WHEN count(DISTINCT coalesce(model_alias,char(0)))=1 THEN min(model_alias) END AS model_alias,CASE WHEN count(DISTINCT coalesce(agent,char(0)))=1 THEN min(agent) END AS agent,CASE WHEN count(DISTINCT coalesce(parent_agent,char(0)))=1 THEN min(parent_agent) END AS parent_agent,CASE WHEN count(DISTINCT coalesce(profile,char(0)))=1 THEN min(profile) END AS profile FROM priced ${query.granularity === 'session' ? 'WHERE ephemeral=0' : ''} GROUP BY bucket,group_key ORDER BY bucket,cost DESC,group_key`);
    const buckets = all(`SELECT bucket,min(time) AS earliest,max(latest_time) AS latest,sum(record_count) AS requests FROM priced ${query.granularity === 'session' ? 'WHERE ephemeral=0' : ''} GROUP BY bucket`);
    const turns = all('SELECT bucket,count(*) AS turns FROM (SELECT DISTINCT bucket,session_id,coalesce(agent,source_agent,\'\') AS effective_agent,turn FROM priced WHERE turn IS NOT NULL AND ephemeral=0) GROUP BY bucket');
    const drill = all(`SELECT bucket,session_id,count(DISTINCT turn) AS turns,sum(CASE WHEN turn IS NULL THEN record_count ELSE 0 END) AS unknown FROM priced WHERE ephemeral=0 GROUP BY bucket,session_id ORDER BY bucket,session_id`);
    const drillTurns = all(`SELECT bucket,session_id,turn FROM (SELECT bucket,session_id,turn,row_number() OVER(PARTITION BY bucket,session_id ORDER BY turn) AS n FROM (SELECT DISTINCT bucket,session_id,turn FROM priced WHERE ephemeral=0 AND turn IS NOT NULL)) WHERE n<=? ORDER BY bucket,session_id,turn`, [query.drilldownTurnLimit]);
    const pageClause = query.position === undefined ? '' : 'WHERE cost<? OR (cost=? AND session_id<?)';
    const pageArgs: SQLInputValue[] = query.position === undefined ? [] : [query.position[0], query.position[0], query.position[1]];
    const pages = all(`, session_totals AS (SELECT workspace,session_id,${aggregate} FROM priced WHERE ephemeral=0 GROUP BY workspace,session_id) SELECT * FROM session_totals ${pageClause} ORDER BY cost DESC,session_id DESC LIMIT ?`, [...pageArgs, query.pageSize + 1]);
    const hasMore = pages.length > query.pageSize;
    if (hasMore) pages.pop();
    const sessions = pages.map((row) => {
      const workspace = String(row['workspace']), id = String(row['session_id']);
      const session = this.db.prepare('SELECT * FROM session WHERE workspace=? AND id=?').get(workspace, id)!;
      const model = all('SELECT model,sum(record_count) AS records FROM priced WHERE workspace=? AND session_id=? GROUP BY model ORDER BY records DESC,model LIMIT 1', [workspace, id])[0];
      const profiles = all('SELECT DISTINCT profile FROM priced WHERE workspace=? AND session_id=? AND profile IS NOT NULL ORDER BY profile', [workspace, id]).map((item) => String(item['profile']));
      const missing = all('SELECT DISTINCT model FROM priced WHERE workspace=? AND session_id=? AND price_unknown ORDER BY model', [workspace, id]).map((item) => String(item['model']));
      return { ...aggregateOf(row), session: sessionOf(session), primaryModel: model === undefined ? undefined : String(model['model']), profileNames: profiles, unknownPriceModels: missing };
    });
    const selection: string[] = ['s.present=1', 'u.present=1'];
    const selectedArgs: SQLInputValue[] = [];
    if (!query.includeArchived) selection.push('u.archived=0');
    if (query.workspaceIds.length > 0) { selection.push(`s.workspace IN (${query.workspaceIds.map(() => '?').join(',')})`); selectedArgs.push(...query.workspaceIds); }
    const status = this.db.prepare(`SELECT count(DISTINCT u.id) AS scanned,count(DISTINCT CASE WHEN NOT EXISTS(SELECT 1 FROM excluded_source e WHERE e.id=s.id) AND (s.building_checkpoint IS NOT NULL OR s.checkpoint IS NULL OR json_extract(s.checkpoint,'$.valid')=0 OR json_extract(s.checkpoint,'$.offset')!=json_extract(s.checkpoint,'$.size')) THEN u.id END) AS incomplete,max(u.deleted) AS deleted FROM source s JOIN session u ON s.workspace=u.workspace AND s.session_id=u.id WHERE ${selection.join(' AND ')}`).get(...selectedArgs)!;
    const groupRows = (rows: Row[], column: string): Map<string, Row[]> => {
      const grouped = new Map<string, Row[]>();
      for (const row of rows) {
        const key = String(row[column]);
        const current = grouped.get(key);
        if (current === undefined) grouped.set(key, [row]); else current.push(row);
      }
      return grouped;
    };
    const groupsByBucket = groupRows(groups, 'bucket');
    const sessionsByBucket = groupRows(drill, 'bucket');
    const turnsByBucket = new Map(turns.map((row) => [String(row['bucket']), Number(row['turns'])]));
    const drillTurnsByBucket = groupRows(drillTurns, 'bucket');
    const trend = buckets.map((row) => {
      const key = String(row['bucket']);
      const startAt = query.granularity === 'session' ? Number(row['earliest']) : Number(key);
      const members = sessionsByBucket.get(key) ?? [];
      const turnsBySession = groupRows(drillTurnsByBucket.get(key) ?? [], 'session_id');
      return { key, startAt, endAt: query.granularity === 'session' ? Number(row['latest']) + 1 : bucketEnd(startAt, query.granularity, query.timezoneOffsetMinutes), requests: Number(row['requests']), turns: turnsByBucket.get(key) ?? 0, groups: (groupsByBucket.get(key) ?? []).map((item) => ({ ...aggregateOf(item), key: String(item['group_key']), provider: nullable(item['provider']), modelAlias: nullable(item['model_alias']), agentId: nullable(item['agent']), parentAgentId: nullable(item['parent_agent']), profileName: nullable(item['profile']) })), sessions: members.slice(0, query.drilldownSessionLimit).map((item) => ({ id: String(item['session_id']), turns: Number(item['turns']), unknownTurnRecords: Number(item['unknown']), turnIds: (turnsBySession.get(String(item['session_id'])) ?? []).map((turn) => Number(turn['turn'])) })), sessionsTruncated: members.length > query.drilldownSessionLimit };
    }).sort((left, right) => left.startAt -right.startAt || left.key.localeCompare(right.key));
    return { revision, total: aggregateOf(totals), earliestAt: totals['earliest'] === null ? undefined : Number(totals['earliest']), latestAt: totals['latest'] === null ? undefined : Number(totals['latest']), sessionCount: Number(totals['sessions']), incompleteSessions: Number(status['incomplete']), scannedSessions: Number(status['scanned']), includesDeletedSessions: Boolean(status['deleted']), unknownPriceModels: unknown, trend, sessions, hasMore };
    } finally { this.db.exec('DROP TABLE IF EXISTS temp.usage_selected; DROP TABLE IF EXISTS temp.usage_sources'); }
  }
}

function text(value: unknown): string { if (typeof value !== 'string') throw new TypeError('Invalid Usage text column'); return value; }
function nullable(value: unknown): string | null { return value === null || value === undefined ? null : text(value); }
function tokenOf(row: Row): typeof EMPTY { return { inputOther: Number(row['input_other']), output: Number(row['output']), inputCacheRead: Number(row['cache_read']), inputCacheCreation: Number(row['cache_creation']) }; }
function aggregateOf(row: Row): UsageReadModelAggregate { return { usage: tokenOf(row), cost: Number(row['cost']), costUnknown: Boolean(row['cost_unknown']), knownRecords: Number(row['known'] ?? 0), missingRecords: Number(row['missing'] ?? 0), legacyZeroRecords: Number(row['legacy'] ?? 0) }; }
function maskOf(fact: UsageFact): number { return Number(fact.usage.inputOther !== 0) | Number(fact.usage.output !== 0) << 1 | Number(fact.usage.inputCacheRead !== 0) << 2 | Number(fact.usage.inputCacheCreation !== 0) << 3; }
function sourceHeadOf(row: Row): UsageSourceHead {
  return { dataGeneration: String(row['generation']), checkpoint: row['checkpoint'] === null ? undefined : JSON.parse(text(row['checkpoint'])), pendingCheckpoint: row['building_checkpoint'] === null ? undefined : JSON.parse(text(row['building_checkpoint'])), journalOffset: Number(row['journal_offset']), journalSize: Number(row['journal_size']), ordinal: Number(row['ordinal']), revision: Number(row['revision']) };
}
function factOf(row: Row): UsageFact {
  const fact: UsageFact = { time: Number(row['time']), model: String(row['model']), usage: tokenOf(row), invalid: Number(row['state']) === 3 || undefined, upstreamModelId: nullable(row['upstream_model']) ?? undefined, sourceAgentId: nullable(row['source_agent']) ?? undefined, agentId: nullable(row['agent']) ?? undefined, parentAgentId: nullable(row['parent_agent']) ?? undefined, provider: nullable(row['provider']) ?? undefined, modelAlias: nullable(row['model_alias']) ?? undefined, profileName: nullable(row['profile']) ?? undefined, turnId: row['turn'] === null ? undefined : Number(row['turn']), usageScope: row['usage_scope'] === 'turn' ? 'turn' : row['usage_scope'] === 'session' ? 'session' : undefined, executorId: nullable(row['executor']) ?? undefined };
  if (row['known'] !== null) Object.defineProperty(fact, 'usageKnown', { value: Boolean(row['known']), enumerable: true });
  return fact;
}
function sessionOf(row: Row): UsageReadModelSession { return { id: String(row['id']), workspaceId: String(row['workspace']), title: nullable(row['title']) ?? undefined, createdAt: Number(row['created']), updatedAt: Number(row['updated']), archived: Boolean(row['archived']), deleted: Boolean(row['deleted']), ephemeral: Boolean(row['ephemeral']) }; }
function bucket(time: number, granularity: string, offset: number): number {
  const shift = offset * 60000;
  if (granularity === 'five_hour') return Math.floor((time + shift) / 18000000) * 18000000 - shift;
  const date = new Date(time + shift);
  if (granularity === 'month') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) - shift;
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - shift;
  return granularity === 'week' ? start - (date.getUTCDay() + 6) % 7 * 86400000 : start;
}
function bucketEnd(start: number, granularity: string, offset: number): number {
  if (granularity === 'month') { const date = new Date(start + offset * 60000); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - offset * 60000; }
  return start + (granularity === 'five_hour' ? 18000000 : granularity === 'week' ? 604800000 : 86400000);
}
