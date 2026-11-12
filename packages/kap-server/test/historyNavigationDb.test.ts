import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';

import { HISTORY_NAV_COLLECTION, type HistoryNavRow } from '../src/services/history/historyLocatorStore';
import { HistoryNavigationDb } from '../src/services/history/historyNavigationDb';
import { navigationScope, SqliteNavigationMap, SqliteNavigationSet } from '../src/services/history/historyNavigationState';

const APPLICATION_ID = 0x4b484e31;
const FOREIGN_APPLICATION_ID = 0x554e4b4e;

function createLegacyNavigationDb(path: string, version: 1 | 2): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE rows (
        key TEXT PRIMARY KEY, workspace TEXT, session TEXT, agent TEXT, kind TEXT,
        turn INTEGER, step TEXT, active INTEGER, position INTEGER, time INTEGER, value TEXT NOT NULL
      ) STRICT;
      CREATE INDEX nav_turn ON rows(workspace,session,agent,kind,active,turn);
      CREATE INDEX nav_position ON rows(workspace,session,agent,turn,active,position);
      CREATE INDEX nav_time ON rows(workspace,session,agent,kind,active,time);
      CREATE TABLE state (
        scope TEXT NOT NULL, bucket TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(scope,bucket,key)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE turn_sequence (
        scope TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL,
        start_ordinal INTEGER NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(scope,seq)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX nav_turn_sequence_id ON turn_sequence(scope,active,id);
      CREATE INDEX nav_turn_sequence_start ON turn_sequence(scope,active,start_ordinal);
      CREATE TABLE anchor_sequence (
        scope TEXT NOT NULL, seq INTEGER NOT NULL, ordinal INTEGER NOT NULL,
        turn_id TEXT, message_id TEXT, active INTEGER NOT NULL, PRIMARY KEY(scope,seq)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX nav_anchor_ordinal ON anchor_sequence(scope,active,ordinal DESC);
      CREATE INDEX nav_anchor_turn ON anchor_sequence(scope,active,turn_id);
    `);
    if (version === 2) {
      db.exec(`
        CREATE INDEX nav_search_order ON rows(workspace,session,agent,coalesce(time,0),key)
          WHERE active=1 AND json_extract(value,'$.part') IN ('prompt','text','output');
        CREATE INDEX nav_search_role_order ON rows(workspace,session,agent,
          coalesce(json_extract(value,'$.role'),'user'),coalesce(time,0),key)
          WHERE active=1 AND json_extract(value,'$.part') IN ('prompt','text','output');
        CREATE INDEX nav_source ON rows(workspace,session,agent,active,json_extract(value,'$.anchor.start'));
        CREATE INDEX nav_canonical_source ON state(scope,json_extract(value,'$.turnId'),CAST(key AS INTEGER))
          WHERE bucket='canonicalRecords';
        CREATE TABLE manifest (scope TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT, WITHOUT ROWID;
      `);
    }
    const largeValue = JSON.stringify({ type: 'turn', payload: 'x'.repeat(6 << 20) });
    db.prepare(`INSERT INTO rows(key,workspace,session,agent,kind,turn,step,active,position,time,value)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('old-row', 'ws', 's', 'main', 'turn', 1, null, 1, 1, 1, largeValue);
    db.prepare('INSERT INTO state(scope,bucket,key,value) VALUES(?,?,?,?)')
      .run('ws\0s\0main', 'turnStart', 't1', '0');
    if (version === 2) {
      db.prepare('INSERT INTO state(scope,bucket,key,value) VALUES(?,?,?,?)')
        .run('ws\0s\0main', 'canonicalRecords', '0', JSON.stringify({ turnId: 't1', ordinal: 0,
          start: 0, end: 1, digest: 'a'.repeat(64) }));
      db.prepare('INSERT INTO manifest(scope,value) VALUES(?,?)')
        .run('ws\0s\0main', JSON.stringify({ v: 2, generation: 'old', incarnation: 'old', offset: 1,
          ordinal: 1, complete: true, source: { identity: 'old', size: 1, head: 'a', tail: 'b' } }));
    }
    db.prepare('INSERT INTO turn_sequence(scope,seq,id,start_ordinal,active) VALUES(?,?,?,?,?)')
      .run('ws\0s\0main', 1, 't1', 0, 1);
    db.prepare('INSERT INTO anchor_sequence(scope,seq,ordinal,turn_id,message_id,active) VALUES(?,?,?,?,?,?)')
      .run('ws\0s\0main', 1, 0, 't1', 'm1', 1);
    db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${version};`);
  } finally {
    db.close();
  }
}

describe('history navigation SQLite repository', () => {
  it('isolates fixed directory projections, shares rollback and retains two committed watermarks', async () => {
    const home = await mkdtemp(join(tmpdir(), 'history-navigation-fixed-'));
    const path = join(home, 'navigation.sqlite');
    const db = await HistoryNavigationDb.open(path);
    const row = { workspace: 'ws', session: 's', agent: 'main', kind: 'turn', turn: 1, active: true, position: 1 };
    const proof = { identity: 'fixture', size: 0, mtimeNs: '0', ctimeNs: '0', head: '0', tail: '0' };
    const manifest = { v: 2 as const, generation: 'fixed', incarnation: 'fixture', offset: 0,
      ordinal: 0, complete: true, source: proof };
    try {
      await db.put(HISTORY_NAV_COLLECTION, 'turn', { ...row, excerpt: 'current' });
      const views = ['1', '2', '3'].map((id) => db.projected(id.repeat(64)));
      const scope = (view: HistoryNavigationDb): string => `${view.projectionPrefix}ws\0s\0main`;
      const commit = async (view: HistoryNavigationDb, excerpt: string): Promise<void> => {
        view.beginSlice();
        view.scalarState(scope(view)).turnStart.set('t1', 0);
        await view.put(HISTORY_NAV_COLLECTION, 'turn', { ...row, excerpt });
        view.commitSlice(scope(view), manifest, { ordinal: 0, legacyTurn: 0 });
      };
      await commit(views[0]!, 'watermark-1');
      views[1]!.beginSlice();
      expect(() => db.beginSlice()).toThrow('already active');
      await views[1]!.put(HISTORY_NAV_COLLECTION, 'turn', { ...row, excerpt: 'uncommitted' });
      db.rollbackSlice();
      expect(await views[1]!.get(HISTORY_NAV_COLLECTION, 'turn')).toBeUndefined();
      await commit(views[1]!, 'watermark-2');
      expect((await db.pageByColumn(HISTORY_NAV_COLLECTION, { column: 'turn', filter: { workspace: 'ws' }, limit: 10 })).items)
        .toEqual([{ ...row, excerpt: 'current' }]);
      expect((await views[0]!.pageByColumn(HISTORY_NAV_COLLECTION, { column: 'turn', filter: { workspace: 'ws' }, limit: 10 })).items)
        .toEqual([{ ...row, excerpt: 'watermark-1' }]);
      await commit(views[0]!, 'watermark-1');
      await commit(views[2]!, 'watermark-3');
      expect(await views[1]!.get(HISTORY_NAV_COLLECTION, 'turn')).toBeUndefined();
      expect(views[1]!.readManifest(scope(views[1]!))).toBeUndefined();
      expect(views[1]!.scalarState(scope(views[1]!)).turnStart.has('t1')).toBe(false);
      expect(await db.get(HISTORY_NAV_COLLECTION, 'turn')).toEqual({ ...row, excerpt: 'current' });
      views[2]!.beginSlice();
      views[2]!.clearProjection(scope(views[2]!), 'ws', 's', 'main');
      views[2]!.rollbackSlice();
      expect(await views[2]!.get(HISTORY_NAV_COLLECTION, 'turn')).toEqual({ ...row, excerpt: 'watermark-3' });
      views[2]!.close();
      expect(await db.get(HISTORY_NAV_COLLECTION, 'turn')).toEqual({ ...row, excerpt: 'current' });
      db.close();
      const reopened = await HistoryNavigationDb.open(path);
      try {
        expect(await reopened.projected('1'.repeat(64)).get(HISTORY_NAV_COLLECTION, 'turn'))
          .toEqual({ ...row, excerpt: 'watermark-1' });
      } finally { reopened.close(); }
    } finally { db.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('reuses hot SQL across records while preserving rollback and independent iterators', async () => {
    const home = await mkdtemp(join(tmpdir(), 'history-navigation-statements-'));
    const db = await HistoryNavigationDb.open(join(home, 'navigation.sqlite'));
    const prepare = vi.spyOn(db.db, 'prepare');
    try {
      const first = db.scalarState('first');
      const second = db.scalarState('second');
      db.beginSlice();
      for (let n = 0; n < 200; n++) {
        first.turnStart.set(`t${n}`, n);
        second.turnStart.set(`t${n}`, n + 1);
        expect(first.turnStart.get(`t${n}`)).toBe(n);
        expect(second.turnStart.has(`t${n}`)).toBe(true);
        db.addCanonicalSource('first', { turnId: `t${n}`, start: n, end: n + 1, ordinal: n, digest: 'fixture' }, { legacyTurn: n, ordinal: n });
      }
      expect(prepare).toHaveBeenCalledTimes(7);
      const a = first.turnStart.entries();
      const b = second.turnStart.entries();
      expect(a.next().value).toEqual(['t0', 0]);
      expect(b.next().value).toEqual(['t0', 1]);
      expect(a.next().value).toEqual(['t1', 1]);
      a.return?.();
      b.return?.();
      db.rollbackSlice();
      expect(first.turnStart.get('t0')).toBeUndefined();
      expect(second.turnStart.has('t0')).toBe(false);
    } finally {
      prepare.mockRestore();
      db.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('persists source-backed rows and advances bounded indexed pages after reopen', async () => {
    const home = await mkdtemp(join(tmpdir(), 'history-navigation-db-'));
    const path = join(home, 'index', 'navigation.sqlite');
    try {
      const lazy = HistoryNavigationDb.lazy(path);
      const rows = Array.from({ length: 200 }, (_, turn) => ({
        workspace: 'ws', session: 'session', agent: 'main', kind: 'turn', turn,
        time: turn * 10, position: turn * 1024, active: true, excerpt: `turn-${turn}`,
      }));
      await lazy.batch(rows.map((value, turn) => ({ kind: 'put', collection: HISTORY_NAV_COLLECTION,
        key: `turn-${turn}`, value })));
      expect((await lazy.pageByColumn<(typeof rows)[number]>(HISTORY_NAV_COLLECTION, {
        column: 'turn', filter: { workspace: 'ws', session: 'session', agent: 'main', kind: 'turn', active: true },
        bounds: { gt: 190 }, dir: 'asc', limit: 4,
      })).items.map((row) => row.turn)).toEqual([191, 192, 193, 194]);
      await lazy.close();
      const reopened = await HistoryNavigationDb.open(path);
      try {
        expect(await reopened.get<(typeof rows)[number]>(HISTORY_NAV_COLLECTION, 'turn-194'))
          .toEqual(rows[194]);
        expect((await reopened.pageByColumn<(typeof rows)[number]>(HISTORY_NAV_COLLECTION, {
          column: 'position', filter: { workspace: 'ws', session: 'session', agent: 'main', turn: 194,
            active: true }, bounds: { gte: 194 * 1024 }, limit: 2,
        })).items).toEqual([rows[194]]);
        await expect(reopened.batch([
          { kind: 'put', collection: HISTORY_NAV_COLLECTION, key: 'not-committed', value: rows[0] },
          { kind: 'put', collection: 'unsupported', key: 'invalid', value: rows[0] },
        ])).rejects.toThrow('unavailable');
        expect(await reopened.get(HISTORY_NAV_COLLECTION, 'not-committed')).toBeUndefined();
      } finally { reopened.close(); }
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('merges indexed conversation roles in cursor order without sorting the session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'history-navigation-search-order-'));
    const db = await HistoryNavigationDb.open(join(home, 'navigation.sqlite'));
    const scope = { workspace: 'ws', session: 'session', agent: 'main' };
    const frame = { ...scope, kind: 'frame', turn: 1, active: true, time: 10 } as const;
    const rows: Array<[string, Omit<HistoryNavRow, 'anchor'>]> = [
      ['parent', { ...frame, kind: 'turn' }],
      ['a\0user', { ...frame, role: 'user', part: 'text' }],
      ['a\0assistant', { ...frame, role: 'assistant', part: 'text' }],
      ['tool-output', { ...frame, role: 'tool', part: 'output', time: 12 }],
      ['tool-input', { ...frame, role: 'tool', part: 'input', time: 13 }],
      ['record', { ...frame, role: 'record', part: 'record', time: 14 }],
      ['undated', { ...frame, part: 'text', time: undefined }],
      ['hidden', { ...frame, role: 'assistant', part: 'text', time: 15, active: false }],
      ['orphan', { ...frame, role: 'assistant', part: 'text', time: 16, turn: 2 }],
    ];
    try {
      await db.batch(rows.map(([key, value]) => ({ kind: 'put', collection: HISTORY_NAV_COLLECTION, key, value })));
      const prepare = vi.spyOn(db.db, 'prepare');
      try {
        const first = db.searchRows({ ...scope, direction: 'desc', limit: 1 });
        expect(first.map(({ key }) => key)).toEqual(['a\0user']);
        const second = db.searchRows({ ...scope, direction: 'desc', limit: 2, after: first[0] });
        expect(second.map(({ key }) => key)).toEqual(['a\0assistant', 'undated']);
        const plans = prepare.mock.calls.slice(0, 2).map(([sql]) => {
          const args = Array.from(sql.matchAll(/\?/g), () => null);
          return db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(({ detail }) => detail);
        });
        for (const plan of plans) {
          expect(plan.filter((detail) => String(detail).includes('nav_search_role_order'))).toHaveLength(2);
          expect(plan.join('\n')).not.toContain('TEMP B-TREE');
        }
        expect(db.searchRows({ ...scope, direction: 'asc', limit: 10, endTime: 11 }).map(({ key }) => key))
          .toEqual(['a\0assistant', 'a\0user']);
        expect(db.searchRows({ ...scope, direction: 'desc', limit: 10, includeToolOutput: true }).map(({ key }) => key))
          .toEqual(['tool-output', 'a\0user', 'a\0assistant', 'undated']);
        expect(db.searchRows({ ...scope, direction: 'desc', limit: 10, role: 'record' }).map(({ key }) => key))
          .toEqual(['record']);
      } finally { prepare.mockRestore(); }
    } finally { db.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('keeps scalar adapter maps and sets on disk, including deletion during keyset iteration', async () => {
    const home = await mkdtemp(join(tmpdir(), 'history-navigation-state-'));
    const path = join(home, 'navigation.sqlite');
    try {
      const db = await HistoryNavigationDb.open(path);
      try {
        const scope = navigationScope(db.db, 'scope');
        const tools = new SqliteNavigationMap<{ turnId: string; stepId: string }>(db.db, scope, 'tools');
        const turns = new SqliteNavigationSet(db.db, scope, 'canonical');
        for (let i = 0; i < 300; i += 1) {
          tools.set(`tool-${i.toString().padStart(3, '0')}`, { turnId: `t${i}`, stepId: `s${i}` });
          turns.add(`t${i}`);
        }
        expect(tools.size).toBe(300);
        expect(turns.size).toBe(300);
        const restored = new SqliteNavigationMap<{ turnId: string; stepId: string }>(db.db, scope, 'tools');
        expect(restored.get('tool-240')).toEqual({ turnId: 't240', stepId: 's240' });
        for (const [key, value] of restored) if (Number(value.turnId.slice(1)) >= 150) restored.delete(key);
        expect(restored.size).toBe(150);
        expect([...turns].slice(0, 3)).toEqual(['t0', 't1', 't10']);
        restored.clear();
        expect(tools.size).toBe(0);
      } finally { db.close(); }
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('keeps indexed turn and anchor order on disk across suffix deletion and ID reuse', async () => {
    const home = await mkdtemp(join(tmpdir(), 'history-navigation-sequence-'));
    try {
      const db = await HistoryNavigationDb.open(join(home, 'navigation.sqlite'));
      try {
        const state = db.scalarState('scope');
        for (let n = 0; n < 200; n += 1) {
          state.turns!.push(`t${n}`, n * 3);
          state.turnStart.set(`t${n}`, n * 3);
          state.anchors!.push({ turnId: `t${n}`, ordinal: n * 3 });
        }
        expect(state.anchors!.nthFromLast(180)).toEqual({ turnId: 't20', ordinal: 60 });
        expect(state.turns!.findFromOrdinal(60)).toBe(20);
        const removed = state.turns!.removeFrom(20);
        state.purgeRemovedTurns!(removed.sequenceRange!);
        state.anchors!.discardRemovedTurns(removed.sequenceRange, removed.ids);
        expect(state.turns!.length).toBe(20);
        expect(state.turns!.at(-1)).toBe('t19');
        expect(state.turnStart.has('t21')).toBe(false);
        expect(state.anchors!.nthFromLast(1)).toEqual({ turnId: 't19', ordinal: 57 });
        state.turns!.push('t21', 901);
        expect(state.turns!.indexOf('t21')).toBe(20);
        expect(state.turns!.findFromOrdinal(900)).toBe(20);
      } finally { db.close(); }
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it.each([1, 2] as const)('rebuilds the entire recognized v%s derived database from canonical sources', async version => {
    const home = await mkdtemp(join(tmpdir(), `history-navigation-v${version}-`));
    const path = join(home, 'navigation.sqlite');
    try {
      createLegacyNavigationDb(path, version);
      const beforeBytes = (await stat(path)).size;
      expect(beforeBytes).toBeGreaterThan(5 << 20);
      let upgraded: HistoryNavigationDb | undefined;
      try {
        upgraded = await HistoryNavigationDb.open(path);
        expect(upgraded.db.prepare('PRAGMA application_id').get()).toEqual({ application_id: APPLICATION_ID });
        expect(upgraded.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
        expect(upgraded.db.prepare('SELECT count(*) AS count FROM rows').get()).toEqual({ count: 0 });
        expect(upgraded.db.prepare('SELECT count(*) AS count FROM state').get()).toEqual({ count: 0 });
        expect(upgraded.db.prepare('SELECT count(*) AS count FROM manifest').get()).toEqual({ count: 0 });
        expect(upgraded.db.prepare('SELECT count(*) AS count FROM turn_sequence').get()).toEqual({ count: 0 });
        expect(upgraded.db.prepare('SELECT count(*) AS count FROM anchor_sequence').get()).toEqual({ count: 0 });
        expect(upgraded.db.prepare('SELECT count(*) AS count FROM canonical_spans').get()).toEqual({ count: 0 });
        const scope = navigationScope(upgraded.db, 'ws\0s\0main');
        for (const table of ['state', 'manifest', 'turn_sequence', 'anchor_sequence', 'canonical_spans']) {
          expect(upgraded.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE scope=?`).get(scope))
            .toEqual({ count: 0 });
        }
        const scopeType = (table: string): string | undefined =>
          (upgraded!.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>)
            .find(column => column.name === 'scope')?.type;
        for (const table of ['state', 'manifest', 'turn_sequence', 'anchor_sequence', 'canonical_spans']) {
          expect(scopeType(table)).toBe('INTEGER');
        }
        expect((upgraded.db.prepare('PRAGMA table_info(canonical_spans)').all() as Array<{ name: string; type: string }>)
          .map(({ name, type }) => [name, type])).toEqual([
          ['scope', 'INTEGER'], ['turn_id', 'TEXT'], ['ordinal', 'INTEGER'], ['start_byte', 'INTEGER'],
          ['end_byte', 'INTEGER'], ['digest', 'BLOB'],
        ]);
      } finally { upgraded?.close(); }
      expect((await stat(path)).size).toBeLessThan(beforeBytes - (4 << 20));
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('does not modify an unrecognized SQLite library while refusing it as a navigation index', async () => {
    const home = await mkdtemp(join(tmpdir(), 'history-navigation-unknown-'));
    const path = join(home, 'other-library.sqlite');
    try {
      const foreign = new DatabaseSync(path);
      foreign.exec(`CREATE TABLE owned_data(value TEXT NOT NULL); INSERT INTO owned_data VALUES('keep me'); PRAGMA application_id=${FOREIGN_APPLICATION_ID}; PRAGMA user_version=7;`);
      foreign.close();
      const before = await readFile(path);
      await expect(HistoryNavigationDb.open(path)).rejects.toThrow('unrecognized history navigation index');
      expect(await readFile(path)).toEqual(before);
      const verified = new DatabaseSync(path);
      try {
        expect(verified.prepare('SELECT value FROM owned_data').get()).toEqual({ value: 'keep me' });
        expect(verified.prepare('PRAGMA application_id').get()).toEqual({ application_id: FOREIGN_APPLICATION_ID });
        expect(verified.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 });
      } finally { verified.close(); }
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('recovers the preceding manifest after a worker exits with uncommitted rows and state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'history-navigation-crash-'));
    const path = join(home, 'navigation.sqlite');
    try {
      const db = await HistoryNavigationDb.open(path);
      const proof = { identity: 'fixture', size: 0, mtimeNs: '0', ctimeNs: '0', head: '0', tail: '0' };
      db.beginSlice();
      db.commitSlice('scope', { v: 2, generation: 'before-crash', incarnation: 'fixture',
        offset: 0, ordinal: 0, complete: false, source: proof }, { ordinal: 0, legacyTurn: 0 });
      db.close();
      const moduleUrl = new URL('../src/services/history/historyNavigationDb.ts', import.meta.url).href;
      const script = `const { HistoryNavigationDb } = await import(${JSON.stringify(moduleUrl)});
        const db = await HistoryNavigationDb.open(process.argv[1]);
        db.beginSlice();
        db.scalarState('scope').turnStart.set('t99', 7);
        await db.put('history_navigation_v1', 'uncommitted', { workspace: 'ws', session: 's',
          agent: 'main', kind: 'turn', turn: 99, active: true, position: 7 });
        process.exit(79);`;
      const rawLoader = new URL('../../../build/register-raw-text-loader.mjs', import.meta.url).href;
      const tsconfig = fileURLToPath(new URL('../../agent-core-v2/tsconfig.json', import.meta.url));
      const child = spawnSync(process.execPath,
        ['--import', 'tsx', '--import', rawLoader, '--input-type=module', '-e', script, path], {
          cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig, NODE_NO_WARNINGS: '1' },
        });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(79);
      const reopened = await HistoryNavigationDb.open(path);
      try {
        expect(reopened.readManifest('scope')).toMatchObject({ generation: 'before-crash', ordinal: 0 });
        expect(reopened.scalarState('scope').turnStart.has('t99')).toBe(false);
        expect(await reopened.get(HISTORY_NAV_COLLECTION, 'uncommitted')).toBeUndefined();
      } finally { reopened.close(); }
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

describe('history navigation schema recovery', () => {
  it('retries a recognized migration after a reader releases its WAL lock', async () => {
    const home = await mkdtemp(join(tmpdir(), 'history-navigation-migration-lock-'));
    const path = join(home, 'navigation.sqlite');
    createLegacyNavigationDb(path, 2);
    const reader = new DatabaseSync(path);
    reader.exec('PRAGMA journal_mode=WAL; BEGIN');
    reader.prepare('SELECT count(*) FROM rows').get();
    const lazy = HistoryNavigationDb.lazy(path);
    try {
      await expect(lazy.ready()).rejects.toThrow('locked');
      reader.exec('COMMIT');
      reader.close();
      const reopened = await lazy.ready();
      expect(reopened.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
      expect(reopened.readManifest('absent')).toBeUndefined();
      expect(reopened.db.prepare('SELECT count(*) AS n FROM scopes').get()).toEqual({ n: 0 });
    } finally {
      if (reader.isOpen) reader.close();
      await lazy.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('never reuses an evicted directory identity across two open connections', async () => {
    const home = await mkdtemp(join(tmpdir(), 'history-navigation-directory-connections-'));
    const path = join(home, 'navigation.sqlite');
    const a = await HistoryNavigationDb.open(path);
    const b = await HistoryNavigationDb.open(path);
    const manifest = { v: 2 as const, generation: 'g', incarnation: 'i', ordinal: 0, offset: 0, complete: true,
      source: { identity: 'i', size: 0, mtimeNs: '0', ctimeNs: '0', head: '0', tail: '0' } };
    const scope = (db: HistoryNavigationDb) => `${db.projectionPrefix}ws\0s\0main`;
    const commit = async (id: string) => {
      const view = b.projected(id.repeat(64));
      view.beginSlice();
      await view.put(HISTORY_NAV_COLLECTION, ['ws', 's', 'main', 'turn', '1', '', '', ''].join('\0'), {
        workspace: 'ws', session: 's', agent: 'main', kind: 'turn', turn: 1, active: true, excerpt: id,
      });
      view.commitSlice(scope(view), { ...manifest, generation: id }, { ordinal: 0, legacyTurn: 0 });
    };
    try {
      await commit('1');
      const first = a.projected('1'.repeat(64));
      expect(first.readManifest(scope(first))?.generation).toBe('1');
      await commit('2'); await commit('3'); await commit('4');
      expect(first.readManifest(scope(first))).toBeUndefined();
      expect(await first.get(HISTORY_NAV_COLLECTION, ['ws', 's', 'main', 'turn', '1', '', '', ''].join('\0'))).toBeUndefined();
      const third = a.projected('3'.repeat(64));
      expect(third.readManifest(scope(third))?.generation).toBe('3');
    } finally { a.close(); b.close(); await rm(home, { recursive: true, force: true }); }
  });
});
