import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
});
