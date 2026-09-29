import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizeLiteral, tokenize } from '@kiki/minidb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteSearchIndex } from '../../src/search/sqlite/index';
import { openSearchDatabase } from '../../src/search/sqlite/schema';
import type { NormalizedQuery } from '../../src/search/match';
import { planHistoryQuery } from '../../src/services/history/historyQuery';

let home: string;
let index: SqliteSearchIndex;
const T = 1_700_000_000_000;
const session = () => ({ id: 's1', workspaceId: 'w', dir: join(home, 's1'), updatedAt: T });
const user = (text: string, time = T) => JSON.stringify({ type: 'context.append_message', time,
  message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text }] } });
const assistant = (text: string, time = T + 1, stepUuid?: string) => JSON.stringify({ type: 'context.append_loop_event', time,
  event: { type: 'content.part', stepUuid, part: { type: 'text', text } } });
const tool = (text: string) => JSON.stringify({ type: 'context.append_loop_event', time: T + 2,
  event: { type: 'tool.result', toolCallId: 'c', result: { output: text } } });
const begin = (uuid: string, ordinal: number) => JSON.stringify({ type: 'context.append_loop_event', time: T,
  event: { type: 'step.begin', uuid, step: ordinal } });
const wire = async (lines: string[], agent = 'main') => {
  const path = join(home, 's1', 'agents', agent, 'wire.jsonl');
  await mkdir(join(home, 's1', 'agents', agent), { recursive: true });
  await writeFile(path, lines.map((l) => `${l}\n`).join(''));
  return path;
};
const q = (query: string, mode: 'terms' | 'literal' = 'terms', sort: NormalizedQuery['sort'] = 'time_asc', pageSize = 20): NormalizedQuery => ({
  query, mode, sort, pageSize, op: 'AND',
  termsQuery: mode === 'terms' ? [...new Set(tokenize(query))] : undefined,
  literalQuery: mode === 'literal' ? normalizeLiteral(query) : undefined,
});
const hits = async (query: string, mode: 'terms' | 'literal' = 'terms') =>
  (await index.search(q(query, mode))).rows.map((r) => r.value);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kiki-sqlite-'));
  index = await SqliteSearchIndex.open(join(home, 'index.sqlite'));
});
afterEach(async () => {
  index.close();
  await rm(home, { recursive: true, force: true });
});

describe('SQLite derived search index', () => {
  it('indexes terms, CJK, literal, titles, turn and step while applying the extraction policy', async () => {
    await wire([user('苹果 first'), begin('u1', 3), assistant('apple first', T + 1, 'u1'),
      tool('main-tool-value'), user('苹果 second', T + 3)]);
    await writeFile(join(home, 's1', 'state.json'), JSON.stringify({ title: '季度总结' }));
    await wire([user('sub dialogue'), assistant('child reply'), assistant('visible-' + 'x '.repeat(2100) + 'hidden-child-tail'),
      JSON.stringify({ type: 'context.append_message', time: T + 4,
      message: { role: 'user', origin: { kind: 'system_trigger', name: 'subagent' },
        content: [{ type: 'text', text: 'delegated unique prompt' }] } }), tool('hidden-sub-tool')], 'child');
    await index.syncSession(session());
    expect((await hits('苹果')).map((r) => [r.role, 'turn' in r ? r.turn : undefined])).toEqual([['user', 0], ['user', 1]]);
    expect((await hits('apple'))[0]).toMatchObject({ role: 'assistant', turn: 0, stepId: 't0.3' });
    expect((await hits('季度'))[0]).toMatchObject({ role: 'title' });
    expect((await hits('苹果', 'literal')).map((r) => r.role)).toEqual(['user', 'user']);
    const shortAscii = await index.search(q('ap', 'literal'));
    expect(shortAscii.rows[0]?.value.role).toBe('assistant');
    expect(shortAscii.incomplete).toBeUndefined();
    expect((await hits('main-tool', 'literal'))[0]).toMatchObject({ role: 'tool' });
    expect(await hits('hidden-sub-tool', 'literal')).toEqual([]);
    expect(await hits('sub dialogue')).toEqual([]);
    expect(await hits('child reply')).toEqual([]);
    expect(await hits('delegated unique prompt')).toEqual([]);
    expect(index.syncStatus.wireFilesRead).toBe(1);
    index.close();
    index = await SqliteSearchIndex.open(join(home, 'index.sqlite'), { indexSubagents: true });
    index.resetReadCounters();
    await index.syncSession(session());
    expect(index.syncStatus.wireFilesRead).toBe(1);
    expect((await hits('sub dialogue'))[0]).toMatchObject({ role: 'user' });
    expect((await hits('child reply'))[0]).toMatchObject({ role: 'assistant' });
    expect((await hits('visible', 'literal'))[0]).toMatchObject({ role: 'assistant' });
    expect(await hits('hidden-child-tail', 'literal')).toEqual([]);
    expect((await hits('delegated unique prompt'))[0]).toMatchObject({ role: 'user' });
    expect((await hits('hidden-sub-tool', 'literal'))[0]).toMatchObject({ role: 'tool' });
    index.close();
    index = await SqliteSearchIndex.open(join(home, 'index.sqlite'));
    index.resetReadCounters();
    await index.syncSession(session());
    expect(index.syncStatus.wireFilesRead).toBe(0);
    expect(await hits('sub dialogue')).toEqual([]);
    expect(await hits('child reply')).toEqual([]);
    expect(await hits('hidden-sub-tool', 'literal')).toEqual([]);
  });

  it('uses file watermarks, resumes partial lines and replaces only the changed file', async () => {
    index.close();
    index = await SqliteSearchIndex.open(join(home, 'index.sqlite'), { indexSubagents: true });
    const path = await wire([user('苹果 first')]);
    await wire([user('香蕉 independent')], 'child');
    await index.syncSession(session());
    await appendFile(path, user('苹果 unfinished', T + 1));
    await index.syncSession(session());
    expect(await hits('unfinished')).toEqual([]);
    await appendFile(path, '\n');
    await index.syncSession(session());
    expect(await hits('unfinished')).toHaveLength(1);
    expect(await hits('香蕉')).toHaveLength(1);
    await writeFile(path, `${user('梨子 replaced')}\n`);
    await index.syncSession(session());
    expect(await hits('苹果')).toEqual([]);
    expect(await hits('梨子')).toHaveLength(1);
    expect(await hits('香蕉')).toHaveLength(1);
    const current = await readFile(path, 'utf8');
    await writeFile(path, current.replace('梨子', '桃子'));
    await index.syncSession(session());
    expect(await hits('梨子')).toEqual([]);
    expect(await hits('桃子')).toHaveLength(1);
    expect(await hits('香蕉')).toHaveLength(1);
  });

  it('keeps per-file turn and step state across append, undo, restart and pagination', async () => {
    const path = await wire([user('苹果 one'), begin('u1', 1), assistant('苹果 one reply', T + 1, 'u1')]);
    await index.syncSession(session());
    index.close();
    index = await SqliteSearchIndex.open(join(home, 'index.sqlite'));
    await appendFile(path, [user('苹果 undone', T + 2), JSON.stringify({ type: 'context.undo', count: 1 }),
      user('苹果 redone', T + 3)].map((line) => `${line}\n`).join(''));
    await index.syncSession(session());
    const first = await index.search(q('苹果', 'terms', 'time_asc', 2));
    expect(first.rows.map((r) => [r.value.role, 'turn' in r.value ? r.value.turn : undefined]))
      .toEqual([['user', 0], ['assistant', 0]]);
    expect(first.hasMore).toBe(true);
    const second = await index.search(q('苹果', 'terms', 'time_asc', 2), first.pageToken);
    expect(second.rows.map((r) => 'turn' in r.value ? r.value.turn : undefined)).toEqual([1, 1]);
    expect(second.hasMore).toBe(false);
    await expect(index.search(q('梨子'), first.pageToken)).rejects.toMatchObject({ reason: 'invalid_page_token' });
  });

  it('applies session, workspace, agent, role and time filters before candidate caps', async () => {
    await wire([user('target needle')]);
    await index.syncSession(session());
    for (const id of ['other-a', 'other-b']) {
      const dir = join(home, id);
      await mkdir(join(dir, 'agents', 'main'), { recursive: true });
      await writeFile(join(dir, 'agents', 'main', 'wire.jsonl'), `${user('target needle')}\n`);
      await index.syncSession({ id, dir, workspaceId: 'other', updatedAt: T });
    }
    const budgets = { literalCandidateCap: 1, maxTextHits: 1,
      postingsVisitBudget: 100, queryDeadlineMs: 10_000, queryTextBudgetChars: 100_000 };
    for (const mode of ['terms', 'literal'] as const) {
      for (const sort of ['score', 'time_asc', 'time_desc'] as const) {
        const result = await index.search({ ...q('target needle', mode, sort),
          container: { sessionId: 's1', agentId: 'main' }, workspaceId: 'w', role: 'user',
          startTime: T, endTime: T }, undefined, budgets);
        expect(result.rows.map((row) => row.value.sessionId)).toEqual(['s1']);
        expect(result.incomplete).toBeUndefined();
      }
    }
    const short = await index.search({ ...q('ta', 'literal'), container: { sessionId: 's1' } }, undefined, budgets);
    expect(short.rows.map((row) => row.value.sessionId)).toEqual(['s1']);
  });

  it('matches workspace history auto/all/any clauses after scoped candidate selection', async () => {
    await wire([user('state badge granted'), user('state-badge not granted', T + 1),
      user('state badge pending', T + 2)]);
    await index.syncSession(session());
    for (const id of ['other-a', 'other-b']) {
      const dir = join(home, id);
      await mkdir(join(dir, 'agents', 'main'), { recursive: true });
      await writeFile(join(dir, 'agents', 'main', 'wire.jsonl'), `${user('state badge granted')}\n`);
      await index.syncSession({ id, dir, workspaceId: 'other', updatedAt: T });
    }
    const budget = { literalCandidateCap: 1, maxTextHits: 4,
      postingsVisitBudget: 100, queryDeadlineMs: 10_000, queryTextBudgetChars: 100_000 };
    const query = '"state badge" granted';
    const tokens = [...new Set(['state', 'badge', 'granted'])];
    const modeQuery = (mode: 'auto' | 'all' | 'any'): NormalizedQuery => ({
      ...q(query), termsQuery: tokens, op: 'OR', historyPlan: planHistoryQuery(query, mode),
      workspaceId: 'w', role: 'user',
    });
    const auto = await index.search(modeQuery('auto'), undefined, budget);
    expect(auto.rows.map((row) => row.value.text)).toEqual([
      'state badge granted', 'state-badge not granted', 'state badge pending',
    ]);
    expect(auto.incomplete).toBeUndefined();
    expect((await index.search(modeQuery('all'), undefined, budget)).rows.map((row) => row.value.text))
      .toEqual(['state badge granted']);
    expect((await index.search(modeQuery('any'), undefined, budget)).rows.map((row) => row.value.text))
      .toEqual(['state badge granted', 'state-badge not granted', 'state badge pending']);
    const first = await index.search({ ...modeQuery('auto'), pageSize: 1 }, undefined, budget);
    expect(first.rows).toHaveLength(1);
    expect(first.pageToken).toBeDefined();
    const second = await index.search({ ...modeQuery('auto'), pageSize: 1 }, first.pageToken, budget);
    expect(second.rows[0]?.value.text).not.toBe(first.rows[0]?.value.text);
    await expect(index.search({ ...modeQuery('all'), pageSize: 1 }, first.pageToken, budget))
      .rejects.toMatchObject({ reason: 'invalid_page_token' });
  });

  it('rejects foreign and unknown databases before mutating their schema; resets an old owned schema', async () => {
    const foreign = join(home, 'foreign.sqlite');
    const db = new DatabaseSync(foreign);
    db.exec('CREATE TABLE data(secret TEXT)');
    db.close();
    await expect(openSearchDatabase(foreign)).rejects.toThrow('not an empty');
    const check = new DatabaseSync(foreign);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name='data'").get()).toBeDefined();
    check.close();
    const owned = join(home, 'owned.sqlite');
    const old = await openSearchDatabase(owned);
    old.exec('PRAGMA user_version=999');
    old.close();
    const reset = await openSearchDatabase(owned);
    expect((reset.prepare('SELECT count(*) AS n FROM docs').get() as { n: number }).n).toBe(0);
    reset.close();
  });

  it('indexes lines crossing read chunks and skips oversized lines without losing the following record', async () => {
    const huge = 'x'.repeat(9 << 20);
    const path = await wire([user('苹果 ' + 'x'.repeat(1 << 20)),
      JSON.stringify({ type: 'llm.request', payload: huge }), user('香蕉 after large line', T + 1)]);
    await index.syncSession(session());
    expect((await hits('苹果')).length).toBe(1);
    expect((await hits('香蕉')).length).toBe(1);
    const meta = index.db.prepare('SELECT offset FROM files WHERE path=?').get(path) as { offset: number };
    expect(meta.offset).toBe((await stat(path)).size);
    expect((index.db.prepare("SELECT v FROM meta WHERE k='skipped_lines'").get() as { v: string }).v).toBe('1');
  });

  it('redacts binary payloads, truncates tool text, and refreshes title FTS entries', async () => {
    const path = await wire([user('asset ' + 'A'.repeat(300)), tool('main trace ' + 'x'.repeat(4100) + 'needle')]);
    await writeFile(join(home, 's1', 'state.json'), JSON.stringify({ title: 'first title' }));
    await index.syncSession(session());
    expect(await hits('A'.repeat(300), 'literal')).toEqual([]);
    expect(await hits('needle', 'literal')).toEqual([]);
    expect((await hits('main trace', 'literal'))[0]?.role).toBe('tool');
    await writeFile(join(home, 's1', 'state.json'), JSON.stringify({ title: 'second title' }));
    await index.syncSession(session());
    expect(await hits('first title', 'literal')).toEqual([]);
    expect((await hits('second title', 'literal'))[0]?.role).toBe('title');
    await appendFile(path, user('followup', T + 5) + '\n');
    await index.syncSession(session());
    expect((await hits('followup'))[0]?.role).toBe('user');
  });

  it('hides hits immediately after a session directory identity changes', async () => {
    await wire([user('apple secret')]);
    await index.syncSession(session());
    await rm(join(home, 's1'), { recursive: true });
    expect(await hits('apple')).toEqual([]);
  });
});
