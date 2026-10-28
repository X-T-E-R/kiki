import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { parentPort, workerData } from 'node:worker_threads';
import type { IndexDef, StagedWrite, WriteCondition, WriteOp } from '../../interface/queryStore.ts';
import type { ReadQuery, StoreOperation, StoreRequest, StoreResponse } from './protocol.ts';
// oxlint-disable-next-line import/extensions
import { getPath, matches, scalarKey, sortValue } from './querySemantics.ts';

const port = parentPort;
if (port === null) throw new Error('Query store requires a worker');
const database = (workerData as { database: string }).database;
const APPLICATION_ID = 0x4b515331;
interface QueryConnection {
  readonly connection: DatabaseSync;
  readonly get: ReturnType<DatabaseSync['prepare']>;
  readonly put: ReturnType<DatabaseSync['prepare']>;
  readonly remove: ReturnType<DatabaseSync['prepare']>;
  readonly clearColumns: ReturnType<DatabaseSync['prepare']>;
  readonly column: ReturnType<DatabaseSync['prepare']>;
}
let db: QueryConnection | undefined;
let cancellation: Int32Array | undefined;

function check(): void { if (cancellation !== undefined && Atomics.load(cancellation, 0) !== 0) throw new DOMException('Query store read cancelled', 'AbortError'); }
function quote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function open(): DatabaseSync {
  if (db !== undefined) return db.connection;
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const connection = new DatabaseSync(database);
  try {
    connection.exec('PRAGMA busy_timeout=50; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const application = Number(connection.prepare('PRAGMA application_id').get()!['application_id']);
    const version = Number(connection.prepare('PRAGMA user_version').get()!['user_version']);
    if (application !== 0 && application !== APPLICATION_ID || version > 1) throw new Error('Unsupported query-store SQLite schema');
    if (application === 0 && connection.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() !== undefined) throw new Error('Unrecognized query-store SQLite database');
    connection.function('kiki_value', { deterministic: true }, (json, path) => { check(); return scalarKey(getPath(JSON.parse(String(json)), String(path))); });
    connection.function('kiki_order', { deterministic: true }, (json, path) => { check(); return sortValue(getPath(JSON.parse(String(json)), String(path))); });
    connection.exec(`CREATE TABLE IF NOT EXISTS rows(collection TEXT NOT NULL, key BLOB NOT NULL, json TEXT NOT NULL CHECK(json_valid(json)), PRIMARY KEY(collection,key)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS columns(collection TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, key BLOB NOT NULL, PRIMARY KEY(collection,name,value,key), FOREIGN KEY(collection,key) REFERENCES rows(collection,key) ON DELETE CASCADE) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS columns_by_key ON columns(collection,key);
      CREATE TABLE IF NOT EXISTS definitions(id INTEGER PRIMARY KEY, collection TEXT NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(collection,name));
      PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);
    connection.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE');
    db = {
      connection,
      get: connection.prepare('SELECT json FROM rows WHERE collection=? AND key=?'),
      put: connection.prepare('INSERT INTO rows VALUES(?,?,?) ON CONFLICT(collection,key) DO UPDATE SET json=excluded.json'),
      remove: connection.prepare('DELETE FROM rows WHERE collection=? AND key=?'),
      clearColumns: connection.prepare('DELETE FROM columns WHERE collection=? AND key=?'),
      column: connection.prepare('INSERT INTO columns VALUES(?,?,?,?)'),
    };
    return connection;
  } catch (error) { connection.close(); throw error; }
}

function transaction<T>(work: (connection: DatabaseSync) => T): T {
  const connection = open();
  connection.exec('BEGIN IMMEDIATE');
  try { const result = work(connection); connection.exec('COMMIT'); return result; }
  catch (error) { connection.exec('ROLLBACK'); throw error; }
}

function batch(ops: readonly WriteOp[], conditions?: readonly WriteCondition[], staged?: StagedWrite): boolean {
  return transaction((connection) => {
    const { get, put, remove, clearColumns, column } = db!;
    for (const condition of conditions ?? []) {
      const row = get.get(condition.collection, Buffer.from(condition.key));
      const current: unknown = row === undefined ? undefined : JSON.parse(String(row['json']));
      const expected: unknown = condition.value === undefined ? undefined : JSON.parse(JSON.stringify(condition.value));
      if (!isDeepStrictEqual(current, expected)) return false;
    }
    if (staged !== undefined) {
      if (staged.source === staged.collection) throw new Error('Staging source must differ from target');
      if (staged.replace) connection.prepare('DELETE FROM rows WHERE collection=?').run(staged.collection);
      connection.prepare('DELETE FROM columns WHERE collection=? AND key IN (SELECT key FROM rows WHERE collection=?)').run(staged.collection, staged.source);
      connection.prepare('INSERT INTO rows SELECT ?,key,json FROM rows WHERE collection=? ON CONFLICT(collection,key) DO UPDATE SET json=excluded.json').run(staged.collection, staged.source);
      connection.prepare('INSERT INTO columns SELECT ?,name,value,key FROM columns WHERE collection=?').run(staged.collection, staged.source);
      connection.prepare('DELETE FROM rows WHERE collection=?').run(staged.source);
    }
    for (const op of ops) {
      const key = Buffer.from(op.key);
      if (op.kind === 'delete') { remove.run(op.collection, key); continue; }
      const json = JSON.stringify(op.value);
      if (json === undefined) throw new TypeError('Query store values must be JSON serializable');
      put.run(op.collection, key, json);
      clearColumns.run(op.collection, key);
      for (const [name, value] of Object.entries(op.columns ?? {})) {
        if (!Number.isFinite(value)) throw new TypeError('Ordered column values must be finite numbers');
        column.run(op.collection, name, value, key);
      }
    }
    return true;
  });
}

function ensureIndex(collection: string, definition: IndexDef): void {
  if (definition.kind === 'text') throw new Error('Query store is structural-only; text indexes belong to global search');
  transaction((connection) => {
    const previous = connection.prepare('SELECT id,json FROM definitions WHERE collection=? AND name=?').get(collection, definition.name);
    if (previous !== undefined) {
      if (!isDeepStrictEqual(JSON.parse(String(previous['json'])), definition)) throw new Error(`Query store index definition changed: ${definition.name}`);
      return;
    }
    const id = connection.prepare('INSERT INTO definitions(collection,name,json) VALUES(?,?,?)').run(collection, definition.name, JSON.stringify(definition)).lastInsertRowid;
    const fields = definition.kind === 'value' ? `kiki_value(json,${quote(definition.field)})` : `kiki_value(json,${quote(definition.groupBy)}),kiki_order(json,${quote(definition.orderBy)})`;
    connection.exec(`CREATE ${definition.kind === 'value' && definition.unique ? 'UNIQUE ' : ''}INDEX query_value_${id} ON rows(collection,${fields}${definition.kind === 'value' && definition.unique ? '' : ',key'}) WHERE collection=${quote(collection)}`);
  });
}

function indexedEqualities(filter: Record<string, unknown> | undefined): Array<[string, unknown]> {
  const result: Array<[string, unknown]> = [];
  for (const [field, value] of Object.entries(filter ?? {})) {
    if (field === '$and' && Array.isArray(value)) for (const nested of value) result.push(...indexedEqualities(nested));
    else if (!field.startsWith('$')) {
      if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) result.push([field, value]);
      else if (value !== null && typeof value === 'object' && Object.keys(value).length === 1 && '$eq' in value) {
        const expected = value.$eq;
        if (expected === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof expected)) result.push([field, expected]);
      }
    }
  }
  return result;
}

async function query(input: ReadQuery): Promise<{ items: unknown[]; nextCursor?: string }> {
  const connection = open();
  const signature = JSON.stringify([input.collection, input.filter, input.column, input.sort, input.columnOrder], (_key, value: unknown) => value instanceof RegExp ? ['regexp', value.source, value.flags] : value === undefined ? ['undefined'] : value);
  let position: { key: string; value?: number | string; offset?: number } | undefined;
  if (input.cursor !== undefined) {
    const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as { v: number; signature: string; position: typeof position };
    if (cursor.v !== 1 || cursor.signature !== signature || cursor.position === undefined || typeof cursor.position.key !== 'string') throw new Error('Invalid SQLite query cursor');
    position = cursor.position;
  }
  const limit = input.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new RangeError('Query limit must be a nonnegative integer');
  const clauses = ['r.collection=?'];
  const parameters: SQLInputValue[] = [input.collection];
  let from = 'rows r';
  let order = 'r.key ASC';
  let selected = 'r.key,r.json';
  let orderedValue: string | undefined;
  let descending = input.columnOrder === 'desc';
  if (input.column !== undefined) {
    from = 'columns c JOIN rows r ON r.collection=c.collection AND r.key=c.key';
    clauses.push('c.collection=?', 'c.name=?'); parameters.push(input.collection, input.column.name);
    const operators = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
    for (const [bound, value] of Object.entries(input.column.bounds)) if (value !== undefined) {
      const operator = operators[bound as keyof typeof operators];
      if (operator === undefined || !Number.isFinite(value)) throw new TypeError('Invalid numeric column bound');
      clauses.push(`c.value ${operator} ?`); parameters.push(value);
    }
    if (input.columnOrder !== undefined) orderedValue = 'c.value';
  }
  for (const [field, value] of indexedEqualities(input.filter)) { clauses.push(`kiki_value(r.json,${quote(field)}) IS ?`); parameters.push(scalarKey(value)); }
  let fallbackSort = false;
  if (input.sort !== undefined) {
    connection.function('kiki_sort_kind', (json) => { check(); return typeof getPath(JSON.parse(String(json)), input.sort!.field); });
    const kinds = connection.prepare(`SELECT DISTINCT kiki_sort_kind(r.json) AS kind FROM ${from} WHERE ${clauses.join(' AND ')}`).all(...parameters);
    fallbackSort = kinds.some((row) => row['kind'] !== 'number' && row['kind'] !== 'string') || new Set(kinds.map((row) => row['kind'])).size > 1;
    if (!fallbackSort) { orderedValue = `kiki_order(r.json,${quote(input.sort.field)})`; descending = input.sort.dir === 'desc'; }
  }
  if (!fallbackSort && position !== undefined) {
    if (orderedValue !== undefined) { clauses.push(`(${orderedValue} ${descending ? '<' : '>'} ? OR (${orderedValue}=? AND r.key ${input.columnOrder === 'desc' && input.sort === undefined ? '<' : '>'} ?))`); parameters.push(position.value!, position.value!, Buffer.from(position.key, 'base64')); }
    else { clauses.push('r.key>?'); parameters.push(Buffer.from(position.key, 'base64')); }
  }
  if (orderedValue !== undefined && !fallbackSort) { order = `${orderedValue} ${descending ? 'DESC' : 'ASC'},r.key ${input.columnOrder === 'desc' && input.sort === undefined ? 'DESC' : 'ASC'}`; selected += `,${orderedValue} AS value`; }
  const iterator = connection.prepare(`SELECT ${selected} FROM ${from} WHERE ${clauses.join(' AND ')} ORDER BY ${order}`).iterate(...parameters);
  const rows: Array<{ key: Uint8Array; value?: number | string; doc: unknown }> = [];
  let visits = 0;
  try {
    for (const row of iterator) {
      check();
      const doc: unknown = JSON.parse(String(row['json']));
      if (matches(doc, input.filter ?? {})) rows.push({ key: row['key'] as Uint8Array, value: row['value'] as number | string | undefined, doc });
      if (!fallbackSort && limit !== undefined && rows.length > limit) break;
      if (++visits % 256 === 0) await yieldToEventLoop();
    }
  } finally { iterator.return?.(); }
  check();
  if (fallbackSort && input.sort !== undefined) {
    const sort = input.sort;
    rows.sort((left, right) => {
      const a = getPath(left.doc, sort.field) as number;
      const b = getPath(right.doc, sort.field) as number;
      return (a < b ? -1 : a > b ? 1 : 0) * (sort.dir === 'desc' ? -1 : 1);
    });
  }
  const offset = fallbackSort ? position?.offset ?? 0 : 0;
  const page = limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + limit);
  const last = page.at(-1);
  const nextCursor = limit !== undefined && rows.length > offset + limit && last !== undefined ? Buffer.from(JSON.stringify({ v: 1, signature, position: { key: Buffer.from(last.key).toString('base64'), value: last.value, offset: fallbackSort ? offset + limit : undefined } })).toString('base64url') : undefined;
  return { items: page.map((row) => row.doc), nextCursor };
}

async function execute(operation: StoreOperation): Promise<unknown> {
  check();
  if (operation.type === 'close') { try { db?.connection.exec('PRAGMA wal_checkpoint(PASSIVE)'); } finally { try { db?.connection.close(); } finally { db = undefined; } } return undefined; }
  if (operation.type === 'batch') return batch(operation.ops, operation.conditions, operation.staged);
  if (operation.type === 'query') {
    const connection = open();
    connection.exec('BEGIN');
    try { const page = await query(operation.query); connection.exec('COMMIT'); return page; }
    catch (error) { connection.exec('ROLLBACK'); throw error; }
  }
  if (operation.type === 'index') return ensureIndex(operation.collection, operation.definition);
  if (operation.type === 'drop') return transaction((connection) => {
    const definitions = connection.prepare('SELECT id FROM definitions WHERE collection=?').all(operation.collection);
    for (const row of definitions) connection.exec(`DROP INDEX query_value_${Number(row['id'])}`);
    connection.prepare('DELETE FROM definitions WHERE collection=?').run(operation.collection);
    connection.prepare('DELETE FROM rows WHERE collection=?').run(operation.collection);
  });
  const connection = open();
  if (operation.type === 'get') {
    const { get } = db!;
    const rows: Array<[string, unknown]> = [];
    connection.exec('BEGIN');
    try {
      for (const key of operation.keys) { check(); const row = get.get(operation.collection, Buffer.from(key)); if (row !== undefined) rows.push([key, JSON.parse(String(row['json']))]); }
      connection.exec('COMMIT');
    } catch (error) { connection.exec('ROLLBACK'); throw error; }
    return rows;
  }
  const keys: string[] = [];
  for (const row of connection.prepare('SELECT key FROM rows WHERE collection=? ORDER BY key').iterate(operation.collection)) { check(); keys.push(Buffer.from(row['key'] as Uint8Array).toString('utf8')); }
  return keys;
}

async function executeWithBusyRetry(operation: StoreOperation): Promise<unknown> {
  const deadline = Date.now() + 5000;
  let delay = 25;
  for (;;) {
    try { return await execute(operation); }
    catch (error) {
      const code = Number((error as { errcode?: number }).errcode) & 255;
      if (code !== 5 && code !== 6 || Date.now() + delay > deadline) throw error;
      check();
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 250);
    }
  }
}

let lane = Promise.resolve();
port.on('message', (request: StoreRequest) => {
  lane = lane.then(async () => {
    cancellation = request.cancellation === undefined ? undefined : new Int32Array(request.cancellation);
    let response: StoreResponse;
    try { response = { id: request.id, result: await executeWithBusyRetry(request.operation) }; }
    catch (error) {
      const value = error as Error & { code?: string };
      response = { id: request.id, error: { message: value.message, code: value.name === 'AbortError' ? 'ABORT_ERR' : value.code, committed: request.operation.type === 'batch' ? false : undefined } };
    }
    cancellation = undefined;
    port.postMessage(response);
    if (request.operation.type === 'close') port.close();
  });
});
