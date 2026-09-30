import { open, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ColumnPageQuery, IQueryStore, Page, WriteOp } from '@kiki/agent-core-v2/persistence/interface/queryStore';
import type { NavigationAdapterCursor, NavigationScalarState } from '@kiki/transcript/navigationWireAdapter';
import type { HistoryNavigationProof } from './historyNavigationProof';

import { HISTORY_NAV_COLLECTION, type HistoryNavRow } from './historyLocatorStore';
import { SqliteNavigationAnchorSequence, SqliteNavigationMap,
  SqliteNavigationSet, SqliteNavigationTurnSequence } from './historyNavigationState';

type NavigationStore = Pick<IQueryStore, 'get' | 'put' | 'batch' | 'pageByColumn'>;
const APPLICATION_ID = 0x4b484e31;
const SCHEMA_VERSION = 2;
const MANIFEST_MAX_BYTES = 16 << 10;

export interface HistoryNavManifest {
  readonly v: 2;
  readonly generation: string;
  readonly incarnation: string;
  readonly offset: number;
  readonly ordinal: number;
  readonly complete: boolean;
  readonly source: HistoryNavigationProof;
}

const COLUMNS = new Set(['turn', 'position', 'time']);
const FILTERS = new Set(['workspace', 'session', 'agent', 'kind', 'turn', 'active', 'step']);

/** Derived, per-installation history index. Never used as the canonical wire/replay store. */
export class HistoryNavigationDb implements NavigationStore {
  private closed = false;
  private scanTransactionOpen = false;
  private constructor(readonly db: DatabaseSync) {}

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
        .all() as Array<{ name: string }>).map((row) => row.name);
      if (applicationId !== 0 && applicationId !== APPLICATION_ID ||
          applicationId === 0 && tables.length > 0 ||
          applicationId === APPLICATION_ID && version !== 1 && version !== SCHEMA_VERSION) {
        throw new Error(`unrecognized history navigation index at ${actual}`);
      }
      if (tables.some((name) => !['rows', 'state', 'turn_sequence', 'anchor_sequence', 'manifest'].includes(name))) {
        throw new Error(`unrecognized history navigation tables at ${actual}`);
      }
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA busy_timeout=1000; PRAGMA wal_autocheckpoint=500; PRAGMA journal_size_limit=33554432');
      db.exec(`
        CREATE TABLE IF NOT EXISTS rows (
          key TEXT PRIMARY KEY, workspace TEXT, session TEXT, agent TEXT, kind TEXT,
          turn INTEGER, step TEXT, active INTEGER, position INTEGER, time INTEGER,
          value TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS nav_turn ON rows(workspace, session, agent, kind, active, turn);
        CREATE INDEX IF NOT EXISTS nav_position ON rows(workspace, session, agent, turn, active, position);
        CREATE INDEX IF NOT EXISTS nav_time ON rows(workspace, session, agent, kind, active, time);
        CREATE INDEX IF NOT EXISTS nav_search_order ON rows(workspace, session, agent, coalesce(time,0), key)
          WHERE active=1 AND json_extract(value,'$.part') IN ('prompt','text','output');
        CREATE INDEX IF NOT EXISTS nav_search_role_order ON rows(workspace, session, agent,
          coalesce(json_extract(value,'$.role'),'user'), coalesce(time,0), key)
          WHERE active=1 AND json_extract(value,'$.part') IN ('prompt','text','output');
        CREATE INDEX IF NOT EXISTS nav_source ON rows(
          workspace, session, agent, active, json_extract(value, '$.anchor.start')
        );
        CREATE TABLE IF NOT EXISTS state (
          scope TEXT NOT NULL, bucket TEXT NOT NULL, key TEXT NOT NULL,
          value TEXT NOT NULL, PRIMARY KEY(scope, bucket, key)
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS turn_sequence (
          scope TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL,
          start_ordinal INTEGER NOT NULL, active INTEGER NOT NULL,
          PRIMARY KEY(scope, seq)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS nav_turn_sequence_id ON turn_sequence(scope,active,id);
        CREATE INDEX IF NOT EXISTS nav_turn_sequence_start ON turn_sequence(scope,active,start_ordinal);
        CREATE TABLE IF NOT EXISTS anchor_sequence (
          scope TEXT NOT NULL, seq INTEGER NOT NULL, ordinal INTEGER NOT NULL,
          turn_id TEXT, message_id TEXT, active INTEGER NOT NULL,
          PRIMARY KEY(scope,seq)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS nav_anchor_ordinal ON anchor_sequence(scope,active,ordinal DESC);
        CREATE INDEX IF NOT EXISTS nav_anchor_turn ON anchor_sequence(scope,active,turn_id);
        CREATE TABLE IF NOT EXISTS manifest (
          scope TEXT PRIMARY KEY, value TEXT NOT NULL
        ) STRICT, WITHOUT ROWID;
      `);
      db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}`);
      return new HistoryNavigationDb(db);
    } catch (error) { db.close(); throw error; }
  }

  static lazy(path: string): LazyHistoryNavigationDb { return new LazyHistoryNavigationDb(path); }

  readManifest(scope: string): HistoryNavManifest | undefined {
    const row = this.db.prepare('SELECT value FROM manifest WHERE scope=?').get(scope) as { value: string } | undefined;
    if (row === undefined || Buffer.byteLength(row.value) > MANIFEST_MAX_BYTES) return undefined;
    let value: Partial<HistoryNavManifest>;
    try { value = JSON.parse(row.value) as Partial<HistoryNavManifest>; }
    catch { return undefined; }
    return value.v === 2 && typeof value.generation === 'string' && value.generation.length > 0 &&
      typeof value.incarnation === 'string' && Number.isSafeInteger(value.offset) && value.offset! >= 0 &&
      Number.isSafeInteger(value.ordinal) && value.ordinal! >= 0 && typeof value.complete === 'boolean' &&
      typeof value.source?.identity === 'string' && typeof value.source.head === 'string' &&
      typeof value.source.tail === 'string' && Number.isSafeInteger(value.source.size)
      ? value as HistoryNavManifest : undefined;
  }

  readAdapterCursor(scope: string): NavigationAdapterCursor | undefined {
    const row = this.db.prepare("SELECT value FROM state WHERE scope=? AND bucket='cursor' AND key='adapter'")
      .get(scope) as { value: string } | undefined;
    if (row === undefined) return undefined;
    let value: Partial<NavigationAdapterCursor>;
    try { value = JSON.parse(row.value) as Partial<NavigationAdapterCursor>; }
    catch { return undefined; }
    return Number.isSafeInteger(value.ordinal) && value.ordinal! >= 0 &&
      Number.isSafeInteger(value.legacyTurn) && value.legacyTurn! >= 0 &&
      (value.currentTurn === undefined || typeof value.currentTurn === 'string') &&
      (value.currentPrompt === undefined || typeof value.currentPrompt === 'string')
      ? value as NavigationAdapterCursor : undefined;
  }

  beginSlice(): void {
    if (this.scanTransactionOpen) throw new Error('history navigation transaction already active');
    this.db.exec('BEGIN IMMEDIATE');
    this.scanTransactionOpen = true;
  }

  commitSlice(scope: string, manifest: HistoryNavManifest, cursor: NavigationAdapterCursor): void {
    if (!this.scanTransactionOpen || manifest.ordinal !== cursor.ordinal) throw new Error('invalid navigation checkpoint');
    const value = JSON.stringify(manifest);
    if (Buffer.byteLength(value) > MANIFEST_MAX_BYTES) throw new Error('navigation manifest exceeds 16 KiB');
    this.db.prepare(`INSERT INTO state(scope,bucket,key,value) VALUES(?,'cursor','adapter',?)
      ON CONFLICT(scope,bucket,key) DO UPDATE SET value=excluded.value`).run(scope, JSON.stringify(cursor));
    this.db.prepare(`INSERT INTO manifest(scope,value) VALUES(?,?)
      ON CONFLICT(scope) DO UPDATE SET value=excluded.value`).run(scope, value);
    this.db.exec('COMMIT');
    this.scanTransactionOpen = false;
  }

  rollbackSlice(): void {
    if (!this.scanTransactionOpen) return;
    try { this.db.exec('ROLLBACK'); }
    finally { this.scanTransactionOpen = false; }
  }

  clearProjection(scope: string, workspace: string, session: string, agent: string): void {
    this.clearState(scope);
    this.db.prepare('DELETE FROM manifest WHERE scope=?').run(scope);
    // Commit-4 search checkpoints included a query digest in the scope. Prune
    // those scalar copies using indexed SQL ranges while rebuilding the one
    // session projection; never materialize their keys in JavaScript.
    const lower = `${scope}\0`;
    const upper = `${scope}\u0001`;
    for (const table of ['state', 'turn_sequence', 'anchor_sequence', 'manifest']) {
      this.db.prepare(`DELETE FROM ${table} WHERE scope>=? AND scope<?`).run(lower, upper);
    }
    this.db.prepare('DELETE FROM rows WHERE workspace=? AND session=? AND agent=?')
      .run(workspace, session, agent);
    this.db.prepare('DELETE FROM rows WHERE key=?').run(`${scope}\0checkpoint`);
  }

  clearState(scope: string): void {
    this.db.prepare('DELETE FROM state WHERE scope=?').run(scope);
    this.db.prepare('DELETE FROM turn_sequence WHERE scope=?').run(scope);
    this.db.prepare('DELETE FROM anchor_sequence WHERE scope=?').run(scope);
  }

  scalarState(scope: string): NavigationScalarState {
    const map = <V>(bucket: string): Map<string, V> => new SqliteNavigationMap<V>(this.db, scope, bucket);
    const removed = `SELECT id FROM turn_sequence WHERE scope=? AND seq>=? AND seq<=?`;
    return {
      turns: new SqliteNavigationTurnSequence(this.db, scope),
      anchors: new SqliteNavigationAnchorSequence(this.db, scope),
      purgeRemovedTurns: (range) => {
        for (const bucket of ['turnStart', 'turnStates', 'canonicalTurns', 'currentStep']) {
          this.db.prepare(`DELETE FROM state WHERE scope=? AND bucket=? AND key IN (${removed})`)
            .run(scope, bucket, scope, range[0], range[1]);
        }
        this.db.prepare(`DELETE FROM state WHERE scope=? AND bucket IN ('steps','tools')
          AND json_extract(value,'$.turnId') IN (${removed})`).run(scope, scope, range[0], range[1]);
        this.db.prepare(`DELETE FROM state WHERE scope=? AND bucket='unpairedSteerCredits'
          AND substr(key,1,instr(key,char(0))-1) IN (${removed})`).run(scope, scope, range[0], range[1]);
      },
      canonicalTurns: new SqliteNavigationSet(this.db, scope, 'canonicalTurns'),
      turnStart: map<number>('turnStart'),
      turnStates: map<'running' | 'completed'>('turnStates'),
      steps: map<NavigationScalarState['steps'] extends Map<string, infer V> ? V : never>('steps'),
      currentStep: map<string>('currentStep'),
      tools: map<NavigationScalarState['tools'] extends Map<string, infer V> ? V : never>('tools'),
      deliveries: map<NavigationScalarState['deliveries'] extends Map<string, infer V> ? V : never>('deliveries'),
      steeredMessageIds: new SqliteNavigationSet(this.db, scope, 'steeredMessageIds'),
      unpairedSteerCredits: map<number>('unpairedSteerCredits'),
    };
  }

  /** Applies a suffix visibility change in SQL; no turn or frame list is materialized. */
  deactivateRange(input: { scope: string; workspace: string; session: string; agent: string;
    range?: readonly [number, number]; retain?: { turn: number; beforeOrdinal: number } }): void {
    if (input.range !== undefined) {
      this.db.prepare(`UPDATE rows SET active=0,value=json_set(value,'$.active',json('false'))
        WHERE workspace=? AND session=? AND agent=? AND active=1 AND turn IN
        (SELECT CAST(substr(id,2) AS INTEGER) FROM turn_sequence WHERE scope=? AND seq>=? AND seq<=?)`)
        .run(input.workspace, input.session, input.agent, input.scope, input.range[0], input.range[1]);
    }
    if (input.retain !== undefined) {
      this.db.prepare(`UPDATE rows SET active=0,value=json_set(value,'$.active',json('false'))
        WHERE workspace=? AND session=? AND agent=? AND active=1 AND turn=? AND kind<>'turn' AND position>=?`)
        .run(input.workspace, input.session, input.agent, input.retain.turn, input.retain.beforeOrdinal * 1024);
    }
  }

  rowsAtSource(workspace: string, session: string, agent: string, start: number): HistoryNavRow[] {
    const rows = this.db.prepare(`SELECT value FROM rows WHERE workspace=? AND session=? AND agent=? AND active=1
      AND json_extract(value, '$.anchor.start')=? LIMIT 1024`)
      .all(workspace, session, agent, start) as Array<{ value: string }>;
    return rows.map((row) => JSON.parse(row.value) as HistoryNavRow);
  }

  searchRows(input: { workspace: string; session: string; agent: string; direction: 'asc' | 'desc';
    after?: { time: number; key: string }; role?: 'user' | 'assistant' | 'tool';
    startTime?: number; endTime?: number; limit: number }): Array<{ key: string; time: number; row: HistoryNavRow }> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 64) throw new Error('invalid history navigation page');
    const where = ["r.workspace=? AND r.session=? AND r.agent=? AND r.active=1",
      "json_extract(r.value,'$.part') IN ('prompt','text','output')",
      "EXISTS (SELECT 1 FROM rows p WHERE p.workspace=r.workspace AND p.session=r.session AND p.agent=r.agent AND p.kind='turn' AND p.turn=r.turn AND p.active=1)"];
    const values: Array<string | number> = [input.workspace, input.session, input.agent];
    if (input.role !== undefined) {
      where.push("coalesce(json_extract(r.value,'$.role'),'user')=?");
      values.push(input.role);
    }
    if (input.startTime !== undefined) { where.push('r.time>=?'); values.push(input.startTime); }
    if (input.endTime !== undefined) { where.push('r.time<?'); values.push(input.endTime); }
    const direction = input.direction === 'asc' ? 'ASC' : 'DESC';
    const comparator = input.direction === 'asc' ? '>' : '<';
    if (input.after !== undefined) {
      where.push(`(coalesce(r.time,0),r.key) ${comparator} (?,?)`);
      values.push(input.after.time, input.after.key);
    }
    const rows = this.db.prepare(`SELECT r.key,coalesce(r.time,0) AS time,r.value FROM rows r
      WHERE ${where.join(' AND ')} ORDER BY coalesce(r.time,0) ${direction},r.key ${direction} LIMIT ?`)
      .all(...values, input.limit) as Array<{ key: string; time: number; value: string }>;
    return rows.map(({ key, time, value }) => ({ key, time, row: JSON.parse(value) as HistoryNavRow }));
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    this.assertCollection(collection);
    const row = this.db.prepare('SELECT value FROM rows WHERE key=?').get(key) as { value: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.value) as T;
  }

  async put<T>(collection: string, key: string, value: T): Promise<void> {
    this.assertCollection(collection);
    this.write(key, value);
  }

  async batch(ops: readonly WriteOp[]): Promise<void> {
    if (!this.scanTransactionOpen) this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const op of ops) {
        this.assertCollection(op.collection);
        if (op.kind === 'put') this.write(op.key, op.value);
        else this.db.prepare('DELETE FROM rows WHERE key=?').run(op.key);
      }
      if (!this.scanTransactionOpen) this.db.exec('COMMIT');
    } catch (error) {
      if (!this.scanTransactionOpen) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async pageByColumn<T>(collection: string, query: ColumnPageQuery): Promise<Page<T>> {
    this.assertCollection(collection);
    if (!COLUMNS.has(query.column) || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 1024) {
      throw new Error('invalid history navigation page');
    }
    const values: Array<string | number | null> = [];
    const where: string[] = [`${query.column} IS NOT NULL`];
    for (const [column, value] of Object.entries(query.filter ?? {})) {
      if (!FILTERS.has(column) || value === undefined ||
          typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error('invalid history navigation filter');
      }
      where.push(`${column}=?`);
      values.push(typeof value === 'boolean' ? Number(value) : value);
    }
    for (const [bound, sql] of [['gt', '>'], ['gte', '>='], ['lt', '<'], ['lte', '<=']] as const) {
      const value = query.bounds?.[bound];
      if (value !== undefined) { where.push(`${query.column}${sql}?`); values.push(value); }
    }
    const direction = query.dir === 'desc' ? 'DESC' : 'ASC';
    const statement = this.db.prepare(`SELECT value FROM rows WHERE ${where.join(' AND ')} ORDER BY ${query.column} ${direction}, key ${direction} LIMIT ?`);
    const rows = statement.all(...values, query.limit) as Array<{ value: string }>;
    return { items: rows.map((row) => JSON.parse(row.value) as T) };
  }

  close(): void {
    if (this.closed) return;
    this.rollbackSlice();
    this.closed = true;
    this.db.close();
  }

  private assertCollection(collection: string): void {
    if (collection !== HISTORY_NAV_COLLECTION || this.closed) throw new Error('history navigation store unavailable');
  }

  private write(key: string, value: unknown): void {
    const row = value as Partial<HistoryNavRow>;
    this.db.prepare(`INSERT INTO rows(key,workspace,session,agent,kind,turn,step,active,position,time,value)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
      workspace=excluded.workspace,session=excluded.session,agent=excluded.agent,kind=excluded.kind,
      turn=excluded.turn,step=excluded.step,active=excluded.active,position=excluded.position,
      time=excluded.time,value=excluded.value`).run(
      key, row.workspace ?? null, row.session ?? null, row.agent ?? null, row.kind ?? null,
      row.turn ?? null, row.step ?? null, row.active === undefined ? null : Number(row.active),
      row.position ?? null, row.time ?? null, JSON.stringify(value),
    );
  }
}

/** Opens only when navigation is first used; close is safe when no history was requested. */
export class LazyHistoryNavigationDb implements NavigationStore {
  private opened?: Promise<HistoryNavigationDb>;
  private closed = false;
  constructor(private readonly path: string) {}
  ready(): Promise<HistoryNavigationDb> {
    if (this.closed) throw new Error('history navigation store closed');
    return this.opened ??= HistoryNavigationDb.open(this.path);
  }
  async get<T>(collection: string, key: string): Promise<T | undefined> {
    return (await this.ready()).get<T>(collection, key);
  }
  async put<T>(collection: string, key: string, value: T): Promise<void> {
    return (await this.ready()).put(collection, key, value);
  }
  async batch(ops: readonly WriteOp[]): Promise<void> { return (await this.ready()).batch(ops); }
  async pageByColumn<T>(collection: string, query: ColumnPageQuery): Promise<Page<T>> {
    return (await this.ready()).pageByColumn<T>(collection, query);
  }
  async close(): Promise<void> {
    this.closed = true;
    (await this.opened)?.close();
  }
}
