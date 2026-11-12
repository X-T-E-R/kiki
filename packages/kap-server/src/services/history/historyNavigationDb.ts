import { open, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ColumnPageQuery, IQueryStore, Page, WriteOp } from '@kiki/agent-core-v2/persistence/interface/queryStore';
import type { NavigationAdapterCursor, NavigationScalarState } from '@kiki/transcript/navigationWireAdapter';
import type { HistoryNavigationProof } from './historyNavigationProof';
import { HISTORY_NAV_COLLECTION, type HistoryNavRow } from './historyLocatorStore';
import { navigationStatement, navigationScope, clearNavigationScopes, SqliteNavigationAnchorSequence,
  SqliteNavigationMap, SqliteNavigationSet, SqliteNavigationTurnSequence } from './historyNavigationState';

type NavigationStore = Pick<IQueryStore, 'get' | 'put' | 'batch' | 'pageByColumn'>;
const APPLICATION_ID = 0x4b484e31;
const SCHEMA_VERSION = 3;
const MANIFEST_MAX_BYTES = 16 << 10;
const CONVERSATION_SEARCH_PARTS = "('prompt','text','output')";
const SELECT_ROW = 'r.*,s.workspace,s.session,s.agent';
const COLUMNS = new Set(['turn', 'position', 'time']);
const FILTERS = new Set(['workspace', 'session', 'agent', 'kind', 'turn', 'active', 'step']);
const TABLES = ['rows', 'state', 'turn_sequence', 'anchor_sequence', 'manifest', 'canonical_spans'];

export interface HistoryNavManifest {
  readonly v: 2;
  readonly generation: string;
  readonly incarnation: string;
  readonly offset: number;
  readonly ordinal: number;
  readonly complete: boolean;
  readonly source: HistoryNavigationProof;
}
export interface HistoryCanonicalSpan {
  readonly turnId: string;
  readonly start: number;
  readonly end: number;
  readonly ordinal: number;
  readonly digest: string;
}
export interface HistoryCanonicalSeed { readonly legacyTurn: number; readonly ordinal: number }
interface StoredRow {
  readonly key: string;
  readonly workspace: string;
  readonly session: string;
  readonly agent: string;
  readonly kind: HistoryNavRow['kind'];
  readonly turn: number;
  readonly step: string | null;
  readonly active: number;
  readonly position: number | null;
  readonly time: number | null;
  readonly value: string;
}

function decodeRow(row: StoredRow): HistoryNavRow {
  const value = JSON.parse(row.value) as Partial<HistoryNavRow>;
  const result = { ...value, workspace: row.workspace, session: row.session, agent: row.agent,
    kind: row.kind, turn: row.turn, active: row.active === 1 } as HistoryNavRow;
  if (row.step !== null) Object.assign(result, { step: row.step });
  if (row.position !== null) Object.assign(result, { position: row.position });
  if (row.time !== null) Object.assign(result, { time: row.time });
  if (value.anchor !== undefined) Object.assign(result, { anchor: { ...value.anchor, v: 1,
    workspace: row.workspace, session: row.session, agent: row.agent, kind: row.kind,
    turn: row.turn, step: result.step, frame: result.frame } });
  return result;
}

/** Derived, per-installation history index. Never used as the canonical wire/replay store. */
export class HistoryNavigationDb implements NavigationStore {
  private closed = false;
  private readonly transaction: { open: boolean };
  private constructor(readonly db: DatabaseSync, private readonly projection = '', transaction?: { open: boolean }) {
    this.transaction = transaction ?? { open: false };
  }
  get projectionPrefix(): string { return this.projection === '' ? '' : `directory:${this.projection}\0`; }
  projected(id: string): HistoryNavigationDb {
    if (!/^[0-9a-f]{64}$/u.test(id)) throw new Error('invalid history directory projection');
    return new HistoryNavigationDb(this.db, id, this.transaction);
  }

  static async open(path: string): Promise<HistoryNavigationDb> {
    const actual = resolve(path);
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 });
    try { const file = await open(actual, 'wx', 0o600); await file.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const db = new DatabaseSync(actual);
    try {
      const applicationId = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id;
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'")
        .all() as Array<{ name: string }>).map(row => row.name);
      if (applicationId !== 0 && applicationId !== APPLICATION_ID || applicationId === 0 && tables.length > 0 ||
        applicationId === APPLICATION_ID && ![1, 2, SCHEMA_VERSION].includes(version)) {
        throw new Error(`unrecognized history navigation index at ${actual}`);
      }
      if (tables.some(name => ![...TABLES, 'scopes', 'directory_views'].includes(name))) {
        throw new Error(`unrecognized history navigation tables at ${actual}`);
      }
      db.exec('PRAGMA busy_timeout=1000');
      const upgrading = applicationId === APPLICATION_ID && version < SCHEMA_VERSION;
      db.exec(upgrading ? 'PRAGMA journal_mode=DELETE; PRAGMA secure_delete=OFF' : 'PRAGMA journal_mode=WAL');
      db.exec(`PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8192; PRAGMA mmap_size=0;
        PRAGMA wal_autocheckpoint=500; PRAGMA journal_size_limit=33554432; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE`);
      const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      const rebuilding = applicationId === APPLICATION_ID && (current === 1 || current === 2);
      if (rebuilding) {
        for (const table of ['rows', 'state', 'turn_sequence', 'anchor_sequence', 'manifest']) db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS scopes (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, projection TEXT NOT NULL,
          workspace TEXT NOT NULL, session TEXT NOT NULL, agent TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS rows (
          scope INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE, key TEXT NOT NULL,
          kind TEXT NOT NULL, turn INTEGER NOT NULL, step TEXT, active INTEGER NOT NULL,
          position INTEGER, time INTEGER, value TEXT NOT NULL, PRIMARY KEY(scope,key)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS nav_turn ON rows(scope,kind,active,turn);
        CREATE INDEX IF NOT EXISTS nav_position ON rows(scope,turn,active,position);
        CREATE INDEX IF NOT EXISTS nav_time ON rows(scope,kind,active,time);
        CREATE INDEX IF NOT EXISTS nav_search_role_order ON rows(scope,
          coalesce(json_extract(value,'$.role'),'user'),coalesce(time,0),key)
          WHERE active=1 AND json_extract(value,'$.part') IN ${CONVERSATION_SEARCH_PARTS};
        CREATE INDEX IF NOT EXISTS nav_source ON rows(scope,active,json_extract(value,'$.anchor.start'));
        CREATE TABLE IF NOT EXISTS state (
          scope INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE, bucket TEXT NOT NULL,
          key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,bucket,key)
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS canonical_spans (
          scope INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE, turn_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL, start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL,
          digest BLOB NOT NULL, PRIMARY KEY(scope,turn_id,ordinal)
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS turn_sequence (
          scope INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
          id TEXT NOT NULL, start_ordinal INTEGER NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(scope,seq)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS nav_turn_sequence_id ON turn_sequence(scope,active,id);
        CREATE INDEX IF NOT EXISTS nav_turn_sequence_start ON turn_sequence(scope,active,start_ordinal);
        CREATE TABLE IF NOT EXISTS anchor_sequence (
          scope INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
          ordinal INTEGER NOT NULL, turn_id TEXT, message_id TEXT, active INTEGER NOT NULL, PRIMARY KEY(scope,seq)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS nav_anchor_ordinal ON anchor_sequence(scope,active,ordinal DESC);
        CREATE INDEX IF NOT EXISTS nav_anchor_turn ON anchor_sequence(scope,active,turn_id);
        CREATE TABLE IF NOT EXISTS manifest (
          scope INTEGER PRIMARY KEY REFERENCES scopes(id) ON DELETE CASCADE, value TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS directory_views (id TEXT PRIMARY KEY, used INTEGER NOT NULL) STRICT, WITHOUT ROWID;
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
      const free = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
      if (rebuilding || free > 0 && db.prepare('SELECT 1 FROM scopes LIMIT 1').get() === undefined) db.exec('VACUUM');
      db.exec('PRAGMA journal_mode=WAL');
      return new HistoryNavigationDb(db);
    } catch (error) { if (db.isOpen) db.close(); throw error; }
  }

  static lazy(path: string): LazyHistoryNavigationDb { return new LazyHistoryNavigationDb(path); }
  private scope(name: string, create = false): number { return navigationScope(this.db, name, create); }
  private sourceScope(workspace: string, session: string, agent: string, create = false): number {
    return this.scope(`${this.projectionPrefix}${workspace}\0${session}\0${agent}`, create);
  }

  readManifest(scope: string): HistoryNavManifest | undefined {
    const row = navigationStatement(this.db, 'SELECT value FROM manifest WHERE scope=?').get(this.scope(scope)) as { value: string } | undefined;
    if (row === undefined || Buffer.byteLength(row.value) > MANIFEST_MAX_BYTES) return undefined;
    let value: Partial<HistoryNavManifest>;
    try { value = JSON.parse(row.value) as Partial<HistoryNavManifest>; } catch { return undefined; }
    return value.v === 2 && typeof value.generation === 'string' && value.generation.length > 0 &&
      typeof value.incarnation === 'string' && Number.isSafeInteger(value.offset) && value.offset! >= 0 &&
      Number.isSafeInteger(value.ordinal) && value.ordinal! >= 0 && typeof value.complete === 'boolean' &&
      typeof value.source?.identity === 'string' && typeof value.source.head === 'string' &&
      typeof value.source.tail === 'string' && Number.isSafeInteger(value.source.size) ? value as HistoryNavManifest : undefined;
  }
  readAdapterCursor(scope: string): NavigationAdapterCursor | undefined {
    const value = new SqliteNavigationMap<NavigationAdapterCursor>(this.db, this.scope(scope), 'cursor').get('adapter');
    return value !== undefined && Number.isSafeInteger(value.ordinal) && value.ordinal >= 0 &&
      Number.isSafeInteger(value.legacyTurn) && value.legacyTurn >= 0 &&
      (value.currentTurn === undefined || typeof value.currentTurn === 'string') &&
      (value.currentPrompt === undefined || typeof value.currentPrompt === 'string') ? value : undefined;
  }
  hasCanonicalSources(scope: string): boolean {
    return navigationStatement(this.db, "SELECT 1 FROM state WHERE scope=? AND bucket='cursor' AND key='canonicalSources'")
      .get(this.scope(scope)) !== undefined;
  }
  markCanonicalCall(scope: string, callId: string, located: boolean, turnId: string | undefined, ordinal: number): void {
    const calls = new SqliteNavigationMap(this.db, this.scope(scope, true), 'canonicalUnlocatedCalls');
    if (located) calls.delete(callId); else calls.set(callId, { turnId, ordinal });
  }
  hasUnlocatedCanonicalCall(scope: string, callId: string): boolean {
    return new SqliteNavigationMap(this.db, this.scope(scope), 'canonicalUnlocatedCalls').has(callId);
  }
  clearUnlocatedCanonicalCalls(scope: string): void {
    new SqliteNavigationMap(this.db, this.scope(scope), 'canonicalUnlocatedCalls').clear();
  }
  addCanonicalSource(scope: string, span: HistoryCanonicalSpan, seed: HistoryCanonicalSeed): void {
    const id = this.scope(scope, true);
    navigationStatement(this.db, `INSERT INTO state(scope,bucket,key,value) VALUES(?,'canonicalSeeds',?,?)
      ON CONFLICT(scope,bucket,key) DO NOTHING`).run(id, span.turnId, JSON.stringify(seed));
    navigationStatement(this.db, `INSERT INTO canonical_spans(scope,turn_id,ordinal,start_byte,end_byte,digest) VALUES(?,?,?,?,?,?)
      ON CONFLICT(scope,turn_id,ordinal) DO UPDATE SET start_byte=excluded.start_byte,end_byte=excluded.end_byte,digest=excluded.digest`)
      .run(id, span.turnId, span.ordinal, span.start, span.end, Buffer.from(span.digest, 'hex'));
  }
  canonicalSeed(scope: string, turnId: string): HistoryCanonicalSeed | undefined {
    return new SqliteNavigationMap<HistoryCanonicalSeed>(this.db, this.scope(scope), 'canonicalSeeds').get(turnId);
  }
  canonicalSources(scope: string, turnId: string, afterOrdinal: number, limit: number): HistoryCanonicalSpan[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error('invalid canonical source page');
    const rows = navigationStatement(this.db, `SELECT ordinal,start_byte,end_byte,digest FROM canonical_spans
      WHERE scope=? AND turn_id=? AND ordinal>? ORDER BY ordinal LIMIT ?`)
      .all(this.scope(scope), turnId, afterOrdinal, limit) as Array<{ ordinal: number; start_byte: number; end_byte: number; digest: Uint8Array }>;
    return rows.map(row => ({ turnId, ordinal: row.ordinal, start: row.start_byte, end: row.end_byte,
      digest: Buffer.from(row.digest).toString('hex') }));
  }
  canonicalTurnRevision(scope: string, turnId: string): string {
    const row = navigationStatement(this.db, `SELECT ordinal,start_byte,end_byte,hex(digest) AS digest FROM canonical_spans
      WHERE scope=? AND turn_id=? ORDER BY ordinal DESC LIMIT 1`).get(this.scope(scope), turnId);
    return row === undefined ? '' : JSON.stringify(row);
  }

  beginSlice(): void {
    if (this.transaction.open) throw new Error('history navigation transaction already active');
    clearNavigationScopes(this.db);
    this.db.exec('BEGIN IMMEDIATE'); this.transaction.open = true;
  }
  commitSlice(scope: string, manifest: HistoryNavManifest, cursor: NavigationAdapterCursor): void {
    if (!this.transaction.open || manifest.ordinal !== cursor.ordinal) throw new Error('invalid navigation checkpoint');
    const value = JSON.stringify(manifest);
    if (Buffer.byteLength(value) > MANIFEST_MAX_BYTES) throw new Error('navigation manifest exceeds 16 KiB');
    const id = this.scope(scope, true);
    const state = new SqliteNavigationMap(this.db, id, 'cursor');
    state.set('adapter', cursor); state.set('canonicalSources', 1);
    navigationStatement(this.db, `INSERT INTO manifest(scope,value) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value`).run(id, value);
    this.retainProjection(); this.db.exec('COMMIT'); this.transaction.open = false;
  }
  rollbackSlice(): void {
    if (!this.transaction.open) return;
    try { this.db.exec('ROLLBACK'); }
    finally { this.transaction.open = false; clearNavigationScopes(this.db); }
  }
  private retainProjection(): void {
    if (this.projection === '') return;
    navigationStatement(this.db, `INSERT INTO directory_views(id,used) VALUES(?,(SELECT coalesce(max(used),0)+1 FROM directory_views))
      ON CONFLICT(id) DO UPDATE SET used=excluded.used`).run(this.projection);
    const evicted = navigationStatement(this.db, 'SELECT id FROM directory_views ORDER BY used DESC LIMIT -1 OFFSET 2').all() as Array<{ id: string }>;
    for (const { id } of evicted) {
      navigationStatement(this.db, 'DELETE FROM scopes WHERE projection=?').run(id);
      navigationStatement(this.db, 'DELETE FROM directory_views WHERE id=?').run(id);
    }
    if (evicted.length > 0) clearNavigationScopes(this.db);
  }
  clearProjection(scope: string, workspace: string, session: string, agent: string): void {
    const id = this.sourceScope(workspace, session, agent);
    for (const table of TABLES) navigationStatement(this.db, `DELETE FROM ${table} WHERE scope=?`).run(id);
    navigationStatement(this.db, 'DELETE FROM scopes WHERE name>=? AND name<?').run(`${scope}\0`, `${scope}\u0001`);
    clearNavigationScopes(this.db);
  }
  clearState(scope: string): void {
    const id = this.scope(scope);
    for (const table of ['state', 'canonical_spans', 'turn_sequence', 'anchor_sequence']) {
      navigationStatement(this.db, `DELETE FROM ${table} WHERE scope=?`).run(id);
    }
  }
  scalarState(scope: string): NavigationScalarState {
    const id = this.scope(scope, true);
    const map = <V>(bucket: string): Map<string, V> => new SqliteNavigationMap<V>(this.db, id, bucket);
    const removed = 'SELECT id FROM turn_sequence WHERE scope=? AND seq>=? AND seq<=?';
    return {
      turns: new SqliteNavigationTurnSequence(this.db, id), anchors: new SqliteNavigationAnchorSequence(this.db, id),
      purgeRemovedTurns: range => {
        for (const bucket of ['turnStart', 'turnStates', 'canonicalTurns', 'currentStep', 'canonicalSeeds']) {
          navigationStatement(this.db, `DELETE FROM state WHERE scope=? AND bucket=? AND key IN (${removed})`).run(id, bucket, id, range[0], range[1]);
        }
        navigationStatement(this.db, `DELETE FROM state WHERE scope=? AND bucket IN ('steps','tools','canonicalUnlocatedCalls')
          AND json_extract(value,'$.turnId') IN (${removed})`).run(id, id, range[0], range[1]);
        navigationStatement(this.db, `DELETE FROM canonical_spans WHERE scope=? AND turn_id IN (${removed})`).run(id, id, range[0], range[1]);
        navigationStatement(this.db, `DELETE FROM state WHERE scope=? AND bucket='unpairedSteerCredits'
          AND substr(key,1,instr(key,char(0))-1) IN (${removed})`).run(id, id, range[0], range[1]);
      },
      canonicalTurns: new SqliteNavigationSet(this.db, id, 'canonicalTurns'), turnStart: map<number>('turnStart'),
      turnStates: map<'running' | 'completed'>('turnStates'),
      steps: map<NavigationScalarState['steps'] extends Map<string, infer V> ? V : never>('steps'),
      currentStep: map<string>('currentStep'), tools: map<NavigationScalarState['tools'] extends Map<string, infer V> ? V : never>('tools'),
      deliveries: map<NavigationScalarState['deliveries'] extends Map<string, infer V> ? V : never>('deliveries'),
      steeredMessageIds: new SqliteNavigationSet(this.db, id, 'steeredMessageIds'), unpairedSteerCredits: map<number>('unpairedSteerCredits'),
    };
  }
  deactivateRange(input: { scope: string; workspace: string; session: string; agent: string;
    range?: readonly [number, number]; retain?: { turn: number; beforeOrdinal: number } }): void {
    const id = this.scope(input.scope);
    if (input.range !== undefined) navigationStatement(this.db, `UPDATE rows SET active=0 WHERE scope=? AND active=1 AND turn IN
      (SELECT CAST(substr(id,2) AS INTEGER) FROM turn_sequence WHERE scope=? AND seq>=? AND seq<=?)`).run(id, id, ...input.range);
    if (input.retain !== undefined) {
      navigationStatement(this.db, `DELETE FROM state WHERE scope=? AND bucket='canonicalUnlocatedCalls'
        AND json_extract(value,'$.turnId')=? AND json_extract(value,'$.ordinal')>=?`).run(id, `t${input.retain.turn}`, input.retain.beforeOrdinal);
      navigationStatement(this.db, 'DELETE FROM canonical_spans WHERE scope=? AND turn_id=? AND ordinal>=?')
        .run(id, `t${input.retain.turn}`, input.retain.beforeOrdinal);
      navigationStatement(this.db, "UPDATE rows SET active=0 WHERE scope=? AND active=1 AND turn=? AND kind<>'turn' AND position>=?")
        .run(id, input.retain.turn, input.retain.beforeOrdinal * 1024);
    }
  }
  rowsAtSource(workspace: string, session: string, agent: string, start: number): HistoryNavRow[] {
    return (navigationStatement(this.db, `SELECT ${SELECT_ROW} FROM rows r JOIN scopes s ON s.id=r.scope
      WHERE r.scope=? AND r.active=1 AND json_extract(r.value,'$.anchor.start')=? LIMIT 1024`)
      .all(this.sourceScope(workspace, session, agent), start) as unknown as StoredRow[]).map(decodeRow);
  }
  searchRows(input: { workspace: string; session: string; agent: string; direction: 'asc' | 'desc';
    after?: { time: number; key: string }; includeToolOutput?: boolean; role?: 'user' | 'assistant' | 'tool' | 'record';
    startTime?: number; endTime?: number; limit: number }): Array<{ key: string; time: number; row: HistoryNavRow }> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 64) throw new Error('invalid history navigation page');
    const time = 'coalesce(r.time,0)';
    const where = ['r.scope=? AND r.active=1', input.role === 'record' ? "json_extract(r.value,'$.part')='record'" : `json_extract(r.value,'$.part') IN ${CONVERSATION_SEARCH_PARTS}`,
      "EXISTS (SELECT 1 FROM rows p WHERE p.scope=r.scope AND p.kind='turn' AND p.turn=r.turn AND p.active=1)",
      "coalesce(json_extract(r.value,'$.role'),'user')=?"];
    const bounds: Array<string | number> = [];
    if (input.startTime !== undefined || input.endTime !== undefined) where.push('r.time IS NOT NULL');
    if (input.startTime !== undefined) { where.push(`${time}>=?`); bounds.push(input.startTime); }
    if (input.endTime !== undefined) { where.push(`${time}<?`); bounds.push(input.endTime); }
    const direction = input.direction === 'asc' ? 'ASC' : 'DESC';
    const comparator = input.direction === 'asc' ? '>' : '<';
    if (input.after !== undefined) {
      where.push(`${time} ${comparator}= ? AND (${time},r.key) ${comparator} (?,?)`);
      bounds.push(input.after.time, input.after.time, this.localKey(input.after.key));
    }
    const roles = input.role !== undefined ? [input.role] : input.includeToolOutput === true ? ['user', 'assistant', 'tool'] : ['user', 'assistant'];
    const select = `SELECT r.key AS sort_key,${time} AS sort_time,${SELECT_ROW} FROM rows r JOIN scopes s ON s.id=r.scope WHERE ${where.join(' AND ')}`;
    const sql = `${roles.map(() => select).join(' UNION ALL ')} ORDER BY sort_time ${direction},sort_key ${direction} LIMIT ?`;
    const id = this.sourceScope(input.workspace, input.session, input.agent);
    const values = roles.flatMap(role => [id, role, ...bounds]);
    return (navigationStatement(this.db, sql).all(...values, input.limit) as unknown as Array<StoredRow & { sort_time: number }>)
      .map(row => ({ key: this.externalKey(row), time: row.sort_time, row: decodeRow(row) }));
  }

  private localKey(key: string): string {
    const parts = key.split('\0');
    return parts.length >= 8 ? `\u0001${parts.slice(3).join('\0')}` : key;
  }
  private externalKey(row: StoredRow): string {
    return row.key.startsWith('\u0001') ? `${this.projectionPrefix}${row.workspace}\0${row.session}\0${row.agent}\0${row.key.slice(1)}` : row.key;
  }
  async get<T>(collection: string, key: string): Promise<T | undefined> {
    this.assertCollection(collection);
    const parts = key.split('\0');
    const scoped = parts.length >= 8;
    const row = navigationStatement(this.db, `SELECT ${SELECT_ROW} FROM rows r JOIN scopes s ON s.id=r.scope
      WHERE ${scoped ? 'r.scope=?' : 's.projection=?'} AND r.key=? LIMIT 1`)
      .get(scoped ? this.sourceScope(parts[0]!, parts[1]!, parts[2]!) : this.projection, this.localKey(key)) as unknown as StoredRow | undefined;
    return row === undefined ? undefined : decodeRow(row) as T;
  }
  async put<T>(collection: string, key: string, value: T): Promise<void> { this.assertCollection(collection); this.write(key, value); }
  async batch(ops: readonly WriteOp[]): Promise<void> {
    if (!this.transaction.open) this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const op of ops) {
        this.assertCollection(op.collection);
        if (op.kind === 'put') this.write(op.key, op.value);
        else {
          const parts = op.key.split('\0');
          if (parts.length >= 8) navigationStatement(this.db, 'DELETE FROM rows WHERE scope=? AND key=?')
            .run(this.sourceScope(parts[0]!, parts[1]!, parts[2]!), this.localKey(op.key));
          else navigationStatement(this.db, 'DELETE FROM rows WHERE scope IN (SELECT id FROM scopes WHERE projection=?) AND key=?').run(this.projection, op.key);
        }
      }
      if (!this.transaction.open) this.db.exec('COMMIT');
    } catch (error) { if (!this.transaction.open) { this.db.exec('ROLLBACK'); clearNavigationScopes(this.db); } throw error; }
  }
  async pageByColumn<T>(collection: string, query: ColumnPageQuery): Promise<Page<T>> {
    this.assertCollection(collection);
    if (!COLUMNS.has(query.column) || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 1024) throw new Error('invalid history navigation page');
    const values: Array<string | number> = [this.projection];
    const where = [`r.${query.column} IS NOT NULL`, 's.projection=?'];
    for (const [column, value] of Object.entries(query.filter ?? {})) {
      if (!FILTERS.has(column) || value === undefined || typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error('invalid history navigation filter');
      }
      where.push(`${['workspace', 'session', 'agent'].includes(column) ? 's' : 'r'}.${column}=?`);
      values.push(typeof value === 'boolean' ? Number(value) : value);
    }
    const filter = query.filter;
    if (typeof filter?.['workspace'] === 'string' && typeof filter['session'] === 'string' && typeof filter['agent'] === 'string') {
      where.push('r.scope=?'); values.push(this.sourceScope(filter['workspace'], filter['session'], filter['agent']));
    }
    for (const [bound, sql] of [['gt', '>'], ['gte', '>='], ['lt', '<'], ['lte', '<=']] as const) {
      const value = query.bounds?.[bound];
      if (value !== undefined) { where.push(`r.${query.column}${sql}?`); values.push(value); }
    }
    const direction = query.dir === 'desc' ? 'DESC' : 'ASC';
    const rows = navigationStatement(this.db, `SELECT ${SELECT_ROW} FROM rows r JOIN scopes s ON s.id=r.scope
      WHERE ${where.join(' AND ')} ORDER BY r.${query.column} ${direction},r.key ${direction} LIMIT ?`)
      .all(...values, query.limit) as unknown as StoredRow[];
    return { items: rows.map(row => decodeRow(row) as T) };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.projection !== '') return;
    this.rollbackSlice(); this.db.close();
  }
  private assertCollection(collection: string): void {
    if (collection !== HISTORY_NAV_COLLECTION || this.closed) throw new Error('history navigation store unavailable');
  }
  private write(key: string, value: unknown): void {
    const { workspace, session, agent, kind, turn, step, active, position, time, anchor, ...rest } = value as HistoryNavRow;
    const payload = { ...rest, anchor: anchor === undefined ? undefined : {
      incarnation: anchor.incarnation, start: anchor.start, end: anchor.end, digest: anchor.digest,
      selector: anchor.selector, focus: anchor.focus, window: anchor.window,
    } };
    navigationStatement(this.db, `INSERT INTO rows(scope,key,kind,turn,step,active,position,time,value) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(scope,key) DO UPDATE SET kind=excluded.kind,turn=excluded.turn,step=excluded.step,active=excluded.active,
      position=excluded.position,time=excluded.time,value=excluded.value`).run(
      this.sourceScope(workspace, session, agent, true), this.localKey(key), kind, turn, step ?? null, Number(active), position ?? null, time ?? null, JSON.stringify(payload));
  }
}

/** Opens only when navigation is first used; close is safe when no history was requested. */
export class LazyHistoryNavigationDb implements NavigationStore {
  private opened?: Promise<HistoryNavigationDb>;
  private closed = false;
  constructor(private readonly openDb: string | (() => Promise<HistoryNavigationDb>)) {}
  ready(): Promise<HistoryNavigationDb> {
    if (this.closed) throw new Error('history navigation store closed');
    return this.opened ??= (typeof this.openDb === 'string' ? HistoryNavigationDb.open(this.openDb) : this.openDb())
      .catch((error: unknown) => { this.opened = undefined; throw error; });
  }
  projected(id: string): LazyHistoryNavigationDb {
    return new LazyHistoryNavigationDb(async () => (await this.ready()).projected(id));
  }
  async rollbackSlice(): Promise<void> { (await this.opened)?.rollbackSlice(); }
  async get<T>(collection: string, key: string): Promise<T | undefined> { return (await this.ready()).get<T>(collection, key); }
  async put<T>(collection: string, key: string, value: T): Promise<void> { return (await this.ready()).put(collection, key, value); }
  async batch(ops: readonly WriteOp[]): Promise<void> { return (await this.ready()).batch(ops); }
  async pageByColumn<T>(collection: string, query: ColumnPageQuery): Promise<Page<T>> { return (await this.ready()).pageByColumn<T>(collection, query); }
  async close(): Promise<void> { this.closed = true; (await this.opened)?.close(); }
}
