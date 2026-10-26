import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  IBootstrapService,
  IFlagService,
  ILogService,
  ISessionIndex,
  SessionSummary,
} from '@kiki/agent-core-v2';
import { Event } from '@kiki/agent-core-v2/_base/event';
import { atomicWrite } from '@kiki/agent-core-v2/_base/utils/fs';
import { TranscriptStore, type TranscriptOperation } from '@kiki/transcript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GlobalSearchService,
  drainGlobalSearchDisposals,
  type LiveTranscriptSource,
} from '../../src/search/searchService';

const WS = 'ws_test';

const T1 = 1_700_000_000_000;
const T2 = 1_700_000_100_000;
const T3 = 1_700_000_200_000;

function summary(id: string, title: string, updatedAt = T1, workspaceId = WS): SessionSummary {
  return { id, workspaceId, title, createdAt: updatedAt, updatedAt, archived: false };
}

function makeBootstrap(home: string): IBootstrapService {
  return {
    homeDir: home,
    scope: (name: string) => name,
  } as unknown as IBootstrapService;
}

function userLine(text: string, time: number, origin?: unknown): string {
  return JSON.stringify({
    type: 'context.append_message',
    time,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      origin: origin ?? { kind: 'user' },
    },
  });
}

function assistantLine(text: string, time: number): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    time,
    event: { type: 'content.part', part: { type: 'text', text } },
  });
}

function stepBeginLine(uuid: string, step: number, time: number): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    time,
    event: { type: 'step.begin', uuid, turnId: '0', step },
  });
}

function assistantStepLine(text: string, stepUuid: string, time: number): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    time,
    event: { type: 'content.part', stepUuid, part: { type: 'text', text } },
  });
}

async function writeWire(
  home: string,
  sessionId: string,
  agentId: string,
  lines: string[],
  workspaceId = WS,
): Promise<string> {
  const dir = join(home, 'sessions', workspaceId, sessionId, 'agents', agentId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'wire.jsonl');
  await writeFile(file, lines.map((l) => `${l}\n`).join(''), 'utf8');
  return file;
}

async function writeTitle(
  home: string,
  sessionId: string,
  title: string,
  workspaceId = WS,
): Promise<void> {
  const dir = join(home, 'sessions', workspaceId, sessionId);
  await mkdir(dir, { recursive: true });
  await atomicWrite(join(dir, 'state.json'), JSON.stringify({ title }));
}

const noopLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
} as unknown as ILogService;

function makeFlags(): IFlagService {
  return {
    enabled: () => false,
  } as unknown as IFlagService;
}

const noLiveSource: LiveTranscriptSource = {
  forSessionLive: () => undefined,
  whenReady: async () => {},
  ensureAgentHistory: async () => undefined,
};

function makeInlineService(home: string, index: ISessionIndex): GlobalSearchService {
  const service = new GlobalSearchService(index, makeBootstrap(home), noopLog, makeFlags());
  service.syncDebounceMs = 0;
  service.setLiveTranscriptSource(noLiveSource);
  return service;
}

function makeService(home: string, index: ISessionIndex): GlobalSearchService {
  return makeInlineService(home, index);
}

describe('GlobalSearchService', () => {
  let home: string | undefined;
  const services: GlobalSearchService[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-kap-search-'));
  });

  afterEach(async () => {
    for (const service of services.splice(0)) service.dispose();
    await drainGlobalSearchDisposals();
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      home = undefined;
    }
  });

  function track(service: GlobalSearchService): GlobalSearchService {
    services.push(service);
    return service;
  }

  describe('live route', () => {
    function gettableIndex(summaries: SessionSummary[]): ISessionIndex {
      const byId = new Map(summaries.map((s) => [s.id, s]));
      return {
        _serviceBrand: undefined,
        prepare: async () => ({
          source: 'read-model',
          state: 'ready',
          generation: 1,
          degradedCount: 0,
        }),
        onDidChangeStatus: Event.None as ISessionIndex['onDidChangeStatus'],
        status: () => ({
          source: 'read-model',
          state: 'ready',
          generation: 1,
          degradedCount: 0,
        }),
        listRecent: async () => ({ items: summaries, nextCursor: undefined }),
        get: async (id) => byId.get(id),
        archiveFamily: async () => [],
        count: async () => summaries.length,
        remove: async () => {},
      };
    }

    interface LiveSourceCalls {
      whenReady: string[];
      ensureAgentHistory: [string, string][];
    }

    function fakeLiveSource(
      stores: Map<string, TranscriptStore>,
      calls?: LiveSourceCalls,
    ): LiveTranscriptSource {
      return {
        forSessionLive: (sessionId) => stores.get(sessionId),
        whenReady: async (sessionId) => {
          calls?.whenReady.push(sessionId);
        },
        ensureAgentHistory: async (sessionId, agentId) => {
          calls?.ensureAgentHistory.push([sessionId, agentId]);
          return stores.get(sessionId)?.getAgent(agentId);
        },
      };
    }

    function makeLiveStore(sessionId: string): TranscriptStore {
      const store = new TranscriptStore(sessionId);
      store.ensureAgent('main', { agentId: 'main', type: 'main' });
      store.getAgent('main')!.apply([
        {
          op: 'turn.upsert',
          turn: {
            kind: 'turn',
            turnId: 't0',
            ordinal: 0,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: '帮我看看苹果怎么挑',
            startedAt: new Date(T1).toISOString(),
          },
        },
        {
          op: 'step.upsert',
          turnId: 't0',
          step: {
            kind: 'step',
            stepId: 't0.1',
            turnId: 't0',
            ordinal: 1,
            state: 'completed',
            startedAt: new Date(T2).toISOString(),
          },
        },
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: { kind: 'thinking', frameId: 't0.1.f1', text: '苹果 thinking 不可见' },
        },
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: {
            kind: 'tool',
            frameId: 't0.1.f2',
            toolCallId: 'call-1',
            name: 'Read',
            state: 'done',
          },
        },
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: {
            kind: 'text',
            frameId: 't0.1.f3',
            role: 'assistant',
            text: '苹果要挑红富士。',
          },
        },
      ]);
      return store;
    }

    function addLiveTurn(
      store: TranscriptStore,
      agentId: string,
      turn: {
        ordinal: number;
        startedAt: number;
        prompt?: string;
        state?: 'running' | 'completed';
        steps?: readonly {
          stepId: string;
          startedAt?: number;
          endedAt?: number;
          state?: 'running' | 'completed';
          texts?: readonly string[];
        }[];
      },
    ): void {
      const turnId = `t${turn.ordinal}`;
      const ops: TranscriptOperation[] = [
        {
          op: 'turn.upsert',
          turn: {
            kind: 'turn',
            turnId,
            ordinal: turn.ordinal,
            state: turn.state ?? 'completed',
            origin: { kind: 'user' },
            prompt: turn.prompt,
            startedAt: new Date(turn.startedAt).toISOString(),
          },
        },
      ];
      for (const step of turn.steps ?? []) {
        ops.push({
          op: 'step.upsert',
          turnId,
          step: {
            kind: 'step',
            stepId: step.stepId,
            turnId,
            ordinal: Number(step.stepId.split('.')[1] ?? 0),
            state: step.state ?? 'completed',
            startedAt:
              step.startedAt !== undefined ? new Date(step.startedAt).toISOString() : undefined,
            endedAt: step.endedAt !== undefined ? new Date(step.endedAt).toISOString() : undefined,
          },
        });
        (step.texts ?? []).forEach((text, i) => {
          ops.push({
            op: 'frame.upsert',
            turnId,
            stepId: step.stepId,
            frame: {
              kind: 'text',
              frameId: `${step.stepId}.f${i}`,
              role: 'assistant',
              text,
            },
          });
        });
      }
      store.getAgent(agentId)!.apply(ops);
    }

    it('serves container-scoped literal queries from the live transcript store', async () => {
      const s1 = summary('s1', '苹果标题', T1);
      const stores = new Map([['s1', makeLiveStore('s1')]]);
      const calls: LiveSourceCalls = { whenReady: [], ensureAgentHistory: [] };
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(stores, calls));

      const page = await service.search({
        query: '苹果',
        mode: 'literal',
        container: { sessionId: 's1' },
      });
      expect(page.source).toBe('live');
      expect(page.indexState).toEqual({
        state: 'ready',
        indexedSessions: 1,
        totalSessions: 1,
        documents: 3,
      });
      expect(calls.whenReady).toEqual(['s1']);
      expect(calls.ensureAgentHistory).toEqual([['s1', 'main']]);

      const user = page.items.find((h) => h.role === 'user');
      expect(user).toBeDefined();
      expect(user!.sessionId).toBe('s1');
      expect(user!.workspaceId).toBe(WS);
      expect(user!.sessionTitle).toBe('苹果标题');
      expect(user!.agentId).toBe('main');
      expect(user!.turn).toBe(0);
      expect(user!.stepId).toBeUndefined();
      expect(user!.time).toBe(T1);
      expect(user!.snippet).toContain('苹果');

      const assistant = page.items.find((h) => h.role === 'assistant');
      expect(assistant).toBeDefined();
      expect(assistant!.turn).toBe(0);
      expect(assistant!.stepId).toBe('t0.1');
      expect(assistant!.time).toBe(T2);

      const title = page.items.find((h) => h.role === 'title');
      expect(title).toBeDefined();
      expect(title!.snippet).toBe('苹果标题');

      const thinking = await service.search({
        query: '不可见',
        mode: 'literal',
        container: { sessionId: 's1' },
      });
      expect(thinking.items).toEqual([]);
    });

    it('keeps live search conversation-only unless tool output is requested', async () => {
      const s1 = summary('s1', 'live scope', T1);
      const store = makeLiveStore('s1');
      store.getAgent('main')!.apply([
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: {
            kind: 'tool',
            frameId: 't0.1.f2',
            toolCallId: 'call-1',
            name: 'Read',
            state: 'done',
            output: 'live-outputneedle first',
          },
        },
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: {
            kind: 'tool',
            frameId: 't0.1.f4',
            toolCallId: 'call-2',
            name: 'Read',
            state: 'done',
            output: 'live-outputneedle second',
          },
        },
      ]);
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', store]])));

      expect((await service.search({ query: 'live-outputneedle', container: { sessionId: 's1' } })).items).toEqual([]);
      const output = await service.search({
        query: 'live-outputneedle', container: { sessionId: 's1' }, includeToolOutput: true, pageSize: 1,
      });
      expect(output.items[0]?.role).toBe('tool');
      expect(output.hasMore).toBe(true);
      await expect(service.search({
        query: 'live-outputneedle', container: { sessionId: 's1' }, includeToolOutput: false,
        pageSize: 1, pageToken: output.pageToken,
      })).rejects.toMatchObject({ reason: 'invalid_page_token' });
      const explicitRole = await service.search({
        query: 'live-outputneedle', container: { sessionId: 's1' }, role: 'tool', pageSize: 1,
      });
      expect(explicitRole.items[0]?.role).toBe('tool');
    });

    it('searches real user-origin live steer frames but excludes internal user-role content', async () => {
      const s1 = summary('s1', 'unrelated title', T1);
      const store = makeLiveStore('s1');
      const needle = 'uniquesteerneedle';
      store.getAgent('main')!.apply([
        { op: 'frame.upsert', turnId: 't0', stepId: 't0.1', frame: {
          kind: 'text', frameId: 'real-steer', role: 'user', origin: { kind: 'user' }, text: needle,
          delivery: { deliveryId: 'steer-delivery', messageId: 'real-steer', origin: 'user' },
        } },
        ...['system_trigger', 'task', 'mailbox', 'injection'].map((kind): TranscriptOperation => ({
          op: 'frame.upsert', turnId: 't0', stepId: 't0.1', frame: {
            kind: 'text', frameId: `internal-${kind}`, role: 'user', origin: { kind }, text: needle,
          },
        })),
        { op: 'frame.upsert', turnId: 't0', stepId: 't0.1', frame: {
          kind: 'text', frameId: 'unknown-provenance', role: 'user', text: needle,
        } },
        { op: 'frame.upsert', turnId: 't0', stepId: 't0.1', frame: {
          kind: 'thinking', frameId: 'private-thought', text: needle,
        } },
      ]);
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', store]])));
      for (const mode of ['terms', 'literal'] as const) {
        for (const includeToolOutput of [false, true]) {
          const page = await service.search({ query: needle, mode, includeToolOutput,
            container: { sessionId: 's1', agentId: 'main' } });
          expect(page.source).toBe('live');
          expect(page.items).toHaveLength(1);
          expect(page.items[0]).toMatchObject({ role: 'user', turn: 0, stepId: 't0.1' });
          expect(page.items[0]?.snippet).toContain(needle);
        }
      }
    });

    it('accepts single-character literal queries on the live route', async () => {
      const s1 = summary('s1', '苹果标题', T1);
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', makeLiveStore('s1')]])));

      const page = await service.search({
        query: '苹',
        mode: 'literal',
        container: { sessionId: 's1' },
      });
      expect(page.source).toBe('live');
      expect(page.items.length).toBe(3);
      expect(page.items.map((h) => h.role).sort()).toEqual(['assistant', 'title', 'user']);

      await expect(service.search({ query: '苹', mode: 'literal' })).rejects.toMatchObject({
        reason: 'invalid_query',
      });
    });

    it('falls back to the index route when no source is wired or the session is not live', async () => {
      const s1 = summary('s1', 'fallback', T1);
      await writeWire(home!, 's1', 'main', [userLine('苹果 from index', T1)]);
      const service = track(makeService(home!, gettableIndex([s1])));
      await service.reindex();

      const unwired = await service.search({
        query: '苹果',
        mode: 'literal',
        container: { sessionId: 's1' },
      });
      expect(unwired.source).toBe('index');
      expect(unwired.items.length).toBe(1);

      service.setLiveTranscriptSource(fakeLiveSource(new Map()));
      const notLive = await service.search({
        query: '苹果',
        mode: 'literal',
        container: { sessionId: 's1' },
      });
      expect(notLive.source).toBe('index');
      expect(notLive.items.length).toBe(1);
    });

    it('can read indexed old turns even when the live transcript retains no old turn', async () => {
      const s1 = summary('s1', 'unrelated', T1);
      await writeWire(home!, 's1', 'main', [userLine('precompaction needle', T1)]);
      const service = track(makeService(home!, gettableIndex([s1])));
      await service.reindex();
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', new TranscriptStore('s1')]])));

      const page = await service.search({ query: 'precompaction', workspaceId: WS,
        container: { sessionId: 's1' }, indexOnly: true });
      expect(page.source).toBe('index');
      expect(page.items.map((hit) => [hit.sessionId, hit.turn, hit.snippet])).toEqual([
        ['s1', 0, expect.stringContaining('precompaction needle')],
      ]);
    });

    it('serves terms queries from the live store and orders hits by tf score', async () => {
      const s1 = summary('s1', '无关标题', T1);
      const store = new TranscriptStore('s1');
      store.ensureAgent('main', { agentId: 'main', type: 'main' });
      addLiveTurn(store, 'main', { ordinal: 0, startedAt: T1, prompt: '苹果怎么挑' });
      addLiveTurn(store, 'main', { ordinal: 1, startedAt: T2, prompt: '苹果苹果都要' });
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', store]])));

      const page = await service.search({ query: '苹果', container: { sessionId: 's1' } });
      expect(page.source).toBe('live');
      expect(page.items.length).toBe(2);
      expect(page.items[0]!.time).toBe(T2);
      expect(page.items[1]!.time).toBe(T1);
      expect(page.items[0]!.score).toBeGreaterThan(page.items[1]!.score);
      expect(page.items[1]!.score).toBeGreaterThan(0);

      const dup = await service.search({ query: '苹果 苹果', container: { sessionId: 's1' } });
      expect(dup.items.map((h) => h.time)).toEqual(page.items.map((h) => h.time));
    });

    it('returns matching terms result sets on both routes for equivalent data', async () => {
      const s1 = summary('s1', '无关标题', T1);
      await writeWire(home!, 's1', 'main', [
        userLine('帮我看看苹果怎么挑', T1),
        stepBeginLine('u1', 1, T1 + 100),
        assistantStepLine('苹果要挑红富士。', 'u1', T2),
      ]);
      const stores = new Map([['s1', makeLiveStore('s1')]]);
      const service = track(makeService(home!, gettableIndex([s1])));
      await service.reindex();
      service.setLiveTranscriptSource(fakeLiveSource(stores));

      const query = { query: '苹果', container: { sessionId: 's1' } };
      const live = await service.search(query);
      expect(live.source).toBe('live');
      expect(live.items.length).toBe(2);

      stores.delete('s1');
      const index = await service.search(query);
      expect(index.source).toBe('index');
      expect(index.items.length).toBe(2);

      const identity = (page: typeof live) =>
        page.items
          .map((h) => ({
            sessionId: h.sessionId,
            agentId: h.agentId,
            role: h.role,
            time: h.time,
            turn: h.turn,
            stepId: h.stepId,
          }))
          .sort((a, b) => a.time - b.time);
      expect(identity(live)).toEqual(identity(index));
      for (const page of [live, index]) {
        for (let i = 1; i < page.items.length; i++) {
          expect(page.items[i - 1]!.score).toBeGreaterThanOrEqual(page.items[i]!.score);
        }
      }
    });

    it('SQ2-R1/R2 replaces a same-inode same-length prefix rewrite, invalidates its cursor and keeps append incremental', async () => {
      const path = await writeWire(home!, 's1', 'main', [userLine('needle oldneedle', T1),
        userLine(`needle ${'padding '.repeat(1000)}`, T2), userLine('needle third', T3)]);
      const service = track(makeService(home!, gettableIndex([summary('s1', '', T1)])));
      service.sourceStatIntervalMs = 0;
      await service.reindex();
      const query = { query: 'needle', sort: 'time_asc' as const, pageSize: 1 };
      const first = await service.search(query);
      expect(first.pageToken).toBeDefined();
      const before = await stat(path);
      const original = await readFile(path, 'utf8');
      const rewritten = original.replace('oldneedle', 'newneedle');
      expect(Buffer.byteLength(original)).toBeGreaterThan(4096);
      expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original));
      expect(rewritten.slice(-4096)).toBe(original.slice(-4096));
      await writeFile(path, rewritten);
      await utimes(path, before.atime, new Date(before.mtimeMs + 1000));
      expect((await stat(path)).ino).toBe(before.ino);
      await expect.poll(async () => (await service.search({ query: 'newneedle' })).items.length,
        { timeout: 10_000 }).toBe(1);
      expect((await service.search({ query: 'oldneedle' })).items).toEqual([]);
      await expect(service.search({ ...query, pageToken: first.pageToken })).rejects.toMatchObject({ reason: 'invalid_page_token' });
      const current = await service.search(query);
      await appendFile(path, userLine('needle appended', T3 + 1) + '\n');
      await expect.poll(async () => (await service.search({ query: 'appended' })).items.length,
        { timeout: 10_000 }).toBe(1);
      const next = await service.search({ ...query, pageToken: current.pageToken });
      expect(next.items).toHaveLength(1);
      expect(next.items[0]?.time).toBe(T2);
    });

    it('SQ2-R3 retires inventory removals and missing sources before high-rank stale rows can hide live hits', async () => {
      const inventory = [summary('gone', '', T1), summary('retained-dir', '', T1), summary('alive', '', T1)];
      await writeWire(home!, 'gone', 'main', Array.from({ length: 70 }, (_, n) => userLine('needle needle needle', T1 + n)));
      await writeWire(home!, 'retained-dir', 'main', [userLine('needle inventoryremoved', T1)]);
      await writeWire(home!, 'alive', 'main', [userLine(`needle ${'padding '.repeat(200)}`, T1)]);
      const service = track(makeService(home!, gettableIndex(inventory)));
      await service.reindex();
      const first = await service.search({ query: 'needle' });
      expect(first.incomplete).toBe('candidate_cap');
      expect(first.items.some((hit) => hit.sessionId === 'alive')).toBe(false);
      inventory.splice(inventory.findIndex((entry) => entry.id === 'retained-dir'), 1);
      await rm(join(home!, 'sessions', WS, 'gone'), { recursive: true });
      await expect.poll(async () => (await service.search({ query: 'needle' })).items.map((hit) => hit.sessionId),
        { timeout: 10_000 }).toEqual(['alive']);
      service.syncDebounceMs = 60_000;
      await expect.poll(async () => {
        const state = (await service.status()).indexer!;
        return { indexedSessions: state.indexedSessions, pendingSessions: state.pendingSessions, totalSessions: state.totalSessions };
      }, { timeout: 10_000 }).toEqual({ indexedSessions: 1, pendingSessions: 0, totalSessions: 1 });
      expect((await stat(join(home!, 'sessions', WS, 'retained-dir'))).isDirectory()).toBe(true);
      const db = new DatabaseSync(join(home!, 'search-index-v2', 'index.sqlite'), { readOnly: true });
      try {
        for (const table of ['sessions', 'files', 'docs', 'docs_terms', 'docs_tri']) {
          expect((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(1);
        }
        expect((await service.status()).indexer).toMatchObject({ pendingSessions: 0, totalSessions: 1 });
      } finally { db.close(); }
    });

    it('SQ2-R5 preserves fullwidth punctuation token equality on live and SQLite terms routes', async () => {
      const s1 = summary('s1', '', T1);
      await writeWire(home!, 's1', 'main', [userLine('你好，世界', T1), userLine('你好世界', T2)]);
      const store = new TranscriptStore('s1');
      store.ensureAgent('main', { agentId: 'main', type: 'main' });
      addLiveTurn(store, 'main', { ordinal: 0, startedAt: T1, prompt: '你好，世界' });
      addLiveTurn(store, 'main', { ordinal: 1, startedAt: T2, prompt: '你好世界' });
      const service = track(makeService(home!, gettableIndex([s1])));
      await service.reindex();
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', store]])));
      const query = { query: '你好，世界', container: { sessionId: 's1' } };
      const live = await service.search(query);
      const indexed = await service.search({ ...query, indexOnly: true });
      console.log('[SQ2-R5]', { live: live.items.map((hit) => hit.time), indexed: indexed.items.map((hit) => hit.time) });
      expect(live.items.map((hit) => hit.time)).toEqual([T1]);
      expect(indexed.items.map((hit) => hit.time)).toEqual([T1]);
    });

    it('applies role, time, agent and sort filters on the live route', async () => {
      const s1 = summary('s1', '', T1);
      const store = new TranscriptStore('s1');
      store.ensureAgent('main', { agentId: 'main', type: 'main' });
      store.ensureAgent('sub', { agentId: 'sub', type: 'sub' });
      addLiveTurn(store, 'main', {
        ordinal: 0,
        startedAt: T1,
        prompt: '苹果 user question',
        steps: [{ stepId: 't0.1', startedAt: T2, texts: ['苹果 assistant answer'] }],
      });
      addLiveTurn(store, 'sub', { ordinal: 0, startedAt: T3, prompt: '苹果 subagent prompt' });
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', store]])));

      const base = { query: '苹果', container: { sessionId: 's1' } };
      const users = await service.search({ ...base, role: 'user' });
      expect(users.items.length).toBe(2);
      expect(users.items.every((h) => h.role === 'user')).toBe(true);

      const assistants = await service.search({ ...base, role: 'assistant' });
      expect(assistants.items.length).toBe(1);
      expect(assistants.items[0]!.stepId).toBe('t0.1');

      const ranged = await service.search({ ...base, startTime: T2, endTime: T2 });
      expect(ranged.items.length).toBe(1);
      expect(ranged.items[0]!.time).toBe(T2);

      const subOnly = await service.search({
        ...base,
        container: { sessionId: 's1', agentId: 'sub' },
      });
      expect(subOnly.items.length).toBe(1);
      expect(subOnly.items[0]!.agentId).toBe('sub');

      const asc = await service.search({ ...base, sort: 'time_asc' });
      expect(asc.items.map((h) => h.time)).toEqual([T1, T2, T3]);
      const desc = await service.search({ ...base, sort: 'time_desc' });
      expect(desc.items.map((h) => h.time)).toEqual([T3, T2, T1]);
    });

    it('yields no hits for a live container session in another workspace', async () => {
      const s1 = summary('s1', '苹果标题', T1);
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', makeLiveStore('s1')]])));

      const matching = await service.search({
        query: '苹果',
        container: { sessionId: 's1' },
        workspaceId: WS,
      });
      expect(matching.source).toBe('live');
      expect(matching.items.length).toBeGreaterThan(0);

      const foreign = await service.search({
        query: '苹果',
        container: { sessionId: 's1' },
        workspaceId: 'ws_other',
      });
      expect(foreign.source).toBe('live');
      expect(foreign.items).toEqual([]);
    });

    it('hits the session title doc on the live route (terms mode)', async () => {
      const s1 = summary('s1', '苹果标题', T1);
      const store = new TranscriptStore('s1');
      store.ensureAgent('main', { agentId: 'main', type: 'main' });
      addLiveTurn(store, 'main', { ordinal: 0, startedAt: T1, prompt: '随便聊聊' });
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', store]])));

      const page = await service.search({ query: '苹果', container: { sessionId: 's1' } });
      expect(page.source).toBe('live');
      expect(page.items.length).toBe(1);
      const hit = page.items[0]!;
      expect(hit.role).toBe('title');
      expect(hit.agentId).toBe('');
      expect(hit.sessionId).toBe('s1');
      expect(hit.snippet).toBe('苹果标题');
    });

    it('scopes container.agentId queries to that agent only', async () => {
      const s1 = summary('s1', '', T1);
      const store = new TranscriptStore('s1');
      store.ensureAgent('main', { agentId: 'main', type: 'main' });
      store.ensureAgent('sub', { agentId: 'sub', type: 'sub' });
      addLiveTurn(store, 'main', { ordinal: 0, startedAt: T1, prompt: '苹果 from main' });
      addLiveTurn(store, 'sub', { ordinal: 0, startedAt: T2, prompt: '苹果 from sub' });
      const calls: LiveSourceCalls = { whenReady: [], ensureAgentHistory: [] };
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', store]]), calls));

      const page = await service.search({
        query: '苹果',
        container: { sessionId: 's1', agentId: 'sub' },
      });
      expect(page.source).toBe('live');
      expect(calls.whenReady).toEqual(['s1']);
      expect(calls.ensureAgentHistory).toEqual([['s1', 'sub']]);
      expect(page.indexState.documents).toBe(1);
      expect(page.items.length).toBe(1);
      expect(page.items[0]!.agentId).toBe('sub');
    });

    it('handles an empty roster, prompt-less turns and empty text frames', async () => {
      const s1 = summary('s1', '', T1);
      const calls: LiveSourceCalls = { whenReady: [], ensureAgentHistory: [] };
      const service = track(makeService(home!, gettableIndex([s1])));
      const stores = new Map([['s1', new TranscriptStore('s1')]]);
      service.setLiveTranscriptSource(fakeLiveSource(stores, calls));

      const empty = await service.search({ query: '苹果', container: { sessionId: 's1' } });
      expect(empty.source).toBe('live');
      expect(empty.items).toEqual([]);
      expect(empty.indexState.documents).toBe(0);
      expect(calls.whenReady).toEqual(['s1']);
      expect(calls.ensureAgentHistory).toEqual([]);

      const store = new TranscriptStore('s1');
      store.ensureAgent('main', { agentId: 'main', type: 'main' });
      addLiveTurn(store, 'main', {
        ordinal: 0,
        startedAt: T1,
        steps: [{ stepId: 't0.1', startedAt: T1, texts: ['', '   '] }],
      });
      addLiveTurn(store, 'main', { ordinal: 1, startedAt: T2, prompt: '苹果 survives' });
      stores.set('s1', store);
      const page = await service.search({ query: '苹果', container: { sessionId: 's1' } });
      expect(page.items.length).toBe(1);
      expect(page.items[0]!.role).toBe('user');
      expect(page.indexState.documents).toBe(1);
    });

    it('does not fall back to the index when the live route fails', async () => {
      const s1 = summary('s1', 'boom', T1);
      await writeWire(home!, 's1', 'main', [userLine('苹果 from index', T1)]);
      const service = track(makeService(home!, gettableIndex([s1])));
      await service.reindex();

      const store = makeLiveStore('s1');
      service.setLiveTranscriptSource({
        forSessionLive: (sessionId) => (sessionId === 's1' ? store : undefined),
        whenReady: async () => {
          throw new Error('backfill boom');
        },
        ensureAgentHistory: async () => undefined,
      });

      await expect(
        service.search({ query: '苹果', container: { sessionId: 's1' } }),
      ).rejects.toThrow('backfill boom');
    });

    it('searches the partial text of an in-flight turn', async () => {
      const s1 = summary('s1', '', T1);
      const store = new TranscriptStore('s1');
      store.ensureAgent('main', { agentId: 'main', type: 'main' });
      addLiveTurn(store, 'main', {
        ordinal: 0,
        startedAt: T1,
        state: 'running',
        prompt: '苹果 running prompt',
        steps: [{ stepId: 't0.1', startedAt: T2, state: 'running', texts: ['苹果 partial answer'] }],
      });
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', store]])));

      const page = await service.search({ query: '苹果', container: { sessionId: 's1' } });
      expect(page.source).toBe('live');
      expect(page.items.length).toBe(2);
      expect(page.items.some((h) => h.role === 'user' && h.snippet.includes('running'))).toBe(true);
      expect(
        page.items.some((h) => h.role === 'assistant' && h.snippet.includes('partial')),
      ).toBe(true);
    });

    it('matches nothing for a query that tokenizes to zero terms', async () => {
      const s1 = summary('s1', '', T1);
      const stores = new Map([['s1', makeLiveStore('s1')]]);
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(stores));

      const page = await service.search({ query: '+++', container: { sessionId: 's1' } });
      expect(page.source).toBe('live');
      expect(page.items).toEqual([]);
      expect(page.hasMore).toBe(false);
    });

    it('rejects page tokens across a route flip (the fingerprint covers the source)', async () => {
      const s1 = summary('s1', 'flip', T1);
      await writeWire(home!, 's1', 'main', [
        userLine('苹果 index one', T1),
        assistantLine('苹果 index two', T2),
      ]);
      const stores = new Map([['s1', makeLiveStore('s1')]]);
      const service = track(makeService(home!, gettableIndex([s1])));
      await service.reindex();
      service.setLiveTranscriptSource(fakeLiveSource(stores));

      const query = {
        query: '苹果',
        mode: 'literal' as const,
        container: { sessionId: 's1' },
        pageSize: 1,
      };
      const livePage = await service.search(query);
      expect(livePage.source).toBe('live');
      expect(livePage.hasMore).toBe(true);

      stores.delete('s1');
      await expect(
        service.search({ ...query, pageToken: livePage.pageToken }),
      ).rejects.toMatchObject({ reason: 'invalid_page_token' });

      const indexPage = await service.search(query);
      expect(indexPage.source).toBe('index');
      expect(indexPage.hasMore).toBe(true);
      stores.set('s1', makeLiveStore('s1'));
      await expect(
        service.search({ ...query, pageToken: indexPage.pageToken }),
      ).rejects.toMatchObject({ reason: 'invalid_page_token' });
    });

    it('returns identical literal results on both routes for equivalent data', async () => {
      const s1 = summary('s1', '无关标题', T1);
      await writeWire(home!, 's1', 'main', [
        userLine('帮我看看苹果怎么挑', T1),
        stepBeginLine('u1', 1, T1 + 100),
        assistantStepLine('苹果要挑红富士。', 'u1', T2),
      ]);
      await writeTitle(home!, 's1', '无关标题');
      const stores = new Map([['s1', makeLiveStore('s1')]]);
      const service = track(makeService(home!, gettableIndex([s1])));
      await service.reindex();
      service.setLiveTranscriptSource(fakeLiveSource(stores));

      const query = { query: '苹果', mode: 'literal' as const, container: { sessionId: 's1' } };
      const live = await service.search(query);
      expect(live.source).toBe('live');

      stores.delete('s1');
      const index = await service.search(query);
      expect(index.source).toBe('index');

      const project = (page: typeof live) =>
        page.items.map((h) => ({
          sessionId: h.sessionId,
          workspaceId: h.workspaceId,
          sessionTitle: h.sessionTitle,
          agentId: h.agentId,
          role: h.role,
          snippet: h.snippet,
          time: h.time,
          turn: h.turn,
          stepId: h.stepId,
          score: h.score,
        }));
      expect(project(live)).toEqual(project(index));
    });
  });
});
