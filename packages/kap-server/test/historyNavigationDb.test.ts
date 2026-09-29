import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HISTORY_NAV_COLLECTION } from '../src/services/history/historyLocatorStore';
import { HistoryNavigationDb } from '../src/services/history/historyNavigationDb';
import { SqliteNavigationMap, SqliteNavigationSet } from '../src/services/history/historyNavigationState';

describe('history navigation SQLite repository', () => {
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

  it('keeps scalar adapter maps and sets on disk, including deletion during keyset iteration', async () => {
    const home = await mkdtemp(join(tmpdir(), 'history-navigation-state-'));
    const path = join(home, 'navigation.sqlite');
    try {
      const db = await HistoryNavigationDb.open(path);
      try {
        const tools = new SqliteNavigationMap<{ turnId: string; stepId: string }>(db.db, 'scope', 'tools');
        const turns = new SqliteNavigationSet(db.db, 'scope', 'canonical');
        for (let i = 0; i < 300; i += 1) {
          tools.set(`tool-${i.toString().padStart(3, '0')}`, { turnId: `t${i}`, stepId: `s${i}` });
          turns.add(`t${i}`);
        }
        expect(tools.size).toBe(300);
        expect(turns.size).toBe(300);
        const restored = new SqliteNavigationMap<{ turnId: string; stepId: string }>(db.db, 'scope', 'tools');
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

  it('upgrades the earlier derived index without treating its non-atomic checkpoint as resumable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'history-navigation-v1-'));
    const path = join(home, 'navigation.sqlite');
    try {
      const previous = await HistoryNavigationDb.open(path);
      await previous.put(HISTORY_NAV_COLLECTION, 'old-row', { workspace: 'ws', session: 's',
        agent: 'main', kind: 'turn', turn: 1, active: true, position: 1 });
      previous.scalarState('ws\0s\0main\0old-query-hash').turnStart.set('t1', 0);
      previous.scalarState('ws\0other\0main').turnStart.set('t2', 0);
      previous.db.exec('DROP TABLE manifest; PRAGMA user_version=1');
      previous.close();
      const upgraded = await HistoryNavigationDb.open(path);
      try {
        expect((upgraded.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
        expect(upgraded.readManifest('ws\0s\0main')).toBeUndefined();
        upgraded.beginSlice();
        upgraded.clearProjection('ws\0s\0main', 'ws', 's', 'main');
        upgraded.rollbackSlice();
        expect(await upgraded.get(HISTORY_NAV_COLLECTION, 'old-row')).toBeDefined();
        expect(upgraded.scalarState('ws\0s\0main\0old-query-hash').turnStart.has('t1')).toBe(true);
        upgraded.beginSlice();
        upgraded.clearProjection('ws\0s\0main', 'ws', 's', 'main');
        upgraded.commitSlice('ws\0s\0main', { v: 2, generation: 'rebuilt', incarnation: 'new',
          offset: 0, ordinal: 0, complete: false,
          source: { identity: 'new', size: 0, mtimeNs: '0', ctimeNs: '0', head: '0', tail: '0' } },
          { ordinal: 0, legacyTurn: 0 });
        expect(await upgraded.get(HISTORY_NAV_COLLECTION, 'old-row')).toBeUndefined();
        expect(upgraded.scalarState('ws\0s\0main\0old-query-hash').turnStart.has('t1')).toBe(false);
        expect(upgraded.scalarState('ws\0other\0main').turnStart.has('t2')).toBe(true);
      } finally { upgraded.close(); }
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
