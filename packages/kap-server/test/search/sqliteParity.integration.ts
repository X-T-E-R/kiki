import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IBootstrapService, IFlagService, ILogService, ISessionIndex, SessionSummary } from '@kiki/agent-core-v2';
import { Event } from '@kiki/agent-core-v2/_base/event';
import { normalizeLiteral, tokenize } from '@kiki/minidb';
import { afterEach, beforeEach, expect, it } from 'vitest';

import type { GlobalSearchQuery } from '../../src/search/contract';
import type { NormalizedQuery } from '../../src/search/match';
import { GlobalSearchService, SEARCH_WORKER_FLAG_ID, drainGlobalSearchDisposals } from '../../src/search/searchService';
import { SqliteSearchIndex } from '../../src/search/sqlite/index';

const T = 1_700_000_000_000;
const WS = 'ws_test';
let home: string;
let legacy: GlobalSearchService | undefined;
let sqlite: SqliteSearchIndex | undefined;
const summary = (id: string, time: number): SessionSummary => ({ id, workspaceId: WS, title: id,
  createdAt: time, updatedAt: time, archived: false });
const source = (id: string) => ({ id, workspaceId: WS, dir: join(home, 'sessions', WS, id), updatedAt: id === 's1' ? T : T + 100 });
const user = (text: string, time: number) => JSON.stringify({ type: 'context.append_message', time,
  message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text }] } });
const assistant = (text: string, time: number, stepUuid?: string) => JSON.stringify({ type: 'context.append_loop_event', time,
  event: { type: 'content.part', stepUuid, part: { type: 'text', text } } });
const step = (uuid: string, ordinal: number) => JSON.stringify({ type: 'context.append_loop_event', time: T,
  event: { type: 'step.begin', uuid, step: ordinal } });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kiki-search-parity-'));
  for (const id of ['s1', 's2']) await mkdir(join(home, 'sessions', WS, id, 'agents', 'main'), { recursive: true });
  await writeFile(join(home, 'sessions', WS, 's1', 'state.json'), JSON.stringify({ title: '苹果 title' }));
  await writeFile(join(home, 'sessions', WS, 's1', 'agents', 'main', 'wire.jsonl'), [
    user('苹果 first C++', T), step('u1', 2), assistant('苹果 reply C++', T + 20, 'u1'),
    user('苹果 undone', T + 30), JSON.stringify({ type: 'context.undo', count: 1 }),
    user('苹果 redone', T + 40),
  ].map((line) => `${line}\n`).join(''));
  await writeFile(join(home, 'sessions', WS, 's2', 'agents', 'main', 'wire.jsonl'), user('苹果 second C++', T + 100) + '\n');
});
afterEach(async () => {
  legacy?.dispose();
  await drainGlobalSearchDisposals();
  sqlite?.close();
  await rm(home, { recursive: true, force: true });
  legacy = undefined;
  sqlite = undefined;
});

it.each(['minidb', 'sqlite'] as const)('preserves searchService integration cases (%s)', async (backend) => {
  const sessions = [summary('s1', T), summary('s2', T + 100)];
  if (backend === 'minidb') {
    const sessionIndex = {
      _serviceBrand: undefined,
      prepare: async () => ({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 }),
      onDidChangeStatus: Event.None,
      status: () => ({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 }),
      listRecent: async () => ({ items: sessions, nextCursor: undefined }),
      count: async () => sessions.length,
    } as unknown as ISessionIndex;
    const bootstrap = { homeDir: home, scope: (name: string) => name } as IBootstrapService;
    const flags = { enabled: (id: string) => id === SEARCH_WORKER_FLAG_ID } as unknown as IFlagService;
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as ILogService;
    legacy = new GlobalSearchService(sessionIndex, bootstrap, log, flags);
    legacy.syncDebounceMs = 0;
    legacy.setLiveTranscriptSource({ forSessionLive: () => undefined, whenReady: async () => {}, ensureAgentHistory: async () => {} });
    await legacy.reindex();
  } else {
    sqlite = await SqliteSearchIndex.open(join(home, 'sqlite', 'search.db'));
    for (const id of ['s1', 's2']) await sqlite.syncSession(source(id));
  }
  const search = async (input: GlobalSearchQuery) => {
    if (legacy) {
      const page = await legacy.search(input);
      return { items: page.items.map((r) => ({ sessionId: r.sessionId, role: r.role, time: r.time,
        turn: r.turn, stepId: r.stepId })), hasMore: page.hasMore, pageToken: page.pageToken };
    }
    const mode = input.mode ?? 'terms';
    const q: NormalizedQuery = { query: input.query, mode, op: input.op ?? 'AND',
      sort: input.sort ?? 'score', pageSize: input.pageSize ?? 20, container: input.container,
      role: input.role, workspaceId: input.workspaceId, startTime: input.startTime, endTime: input.endTime,
      termsQuery: mode === 'terms' ? [...new Set(tokenize(input.query))] : undefined,
      literalQuery: mode === 'literal' ? normalizeLiteral(input.query) : undefined };
    const page = await sqlite!.search(q, input.pageToken);
    return { items: page.rows.map(({ value: r }) => ({ sessionId: r.sessionId, role: r.role, time: r.time,
      turn: r.kind === 'message' ? r.turn : undefined, stepId: r.kind === 'message' ? r.stepId : undefined })),
      hasMore: page.hasMore, pageToken: page.pageToken };
  };
  const query = { query: '苹果', role: 'user' as const, sort: 'time_asc' as const, pageSize: 2 };
  const first = await search(query);
  expect(first.items.map((r) => [r.sessionId, r.turn])).toEqual([['s1', 0], ['s1', 1]]);
  expect(first.hasMore).toBe(true);
  const next = await search({ ...query, pageToken: first.pageToken });
  expect(next.items.map((r) => [r.sessionId, r.turn])).toEqual([['s1', 1], ['s2', 0]]);
  expect(next.hasMore).toBe(false);
  const byScore = await search({ query: '苹果', sort: 'score' });
  expect(byScore.items.slice(0, 3).map((r) => [r.role, r.time])).toEqual([
    ['user', T + 40], ['user', T + 30], ['title', T],
  ]);
  expect((await search({ query: 'C++', mode: 'literal' })).items.map((r) => [r.role, r.sessionId]))
    .toEqual([['user', 's2'], ['assistant', 's1'], ['user', 's1']]);
  expect((await search({ query: 'reply', role: 'assistant' })).items[0]?.stepId).toBe('t0.2');
  expect((await search({ query: 'title', role: 'title' })).items[0]?.role).toBe('title');
  await expect(search({ ...query, query: '梨子', pageToken: first.pageToken }))
    .rejects.toMatchObject({ reason: 'invalid_page_token' });
  await rm(join(home, 'sessions', WS, 's2'), { recursive: true });
  expect((await search({ query: '苹果' })).items.some((r) => r.sessionId === 's2')).toBe(false);
});
