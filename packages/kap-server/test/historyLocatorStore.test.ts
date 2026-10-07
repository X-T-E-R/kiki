import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { IQueryStore, WriteOp, IHistoryArchive, Scope } from '@kiki/agent-core-v2';
import { SyncDescriptor } from '@kiki/agent-core-v2/_base/di/descriptors';
import { TestInstantiationService } from '@kiki/agent-core-v2/_base/di/test';
import { HistoryReadTool, IHistoryReadTool, IHistoryArchive as HistoryArchiveToken } from '@kiki/agent-core-v2/agent/tools/history/historyTools';
import { ISessionContext as SessionContextToken, type ISessionContext } from '@kiki/agent-core-v2/session/sessionContext/sessionContext';
import { IAgentScopeContext as AgentScopeContextToken, type IAgentScopeContext } from '@kiki/agent-core-v2/agent/scopeContext/scopeContext';
import { ISessionIndex as SessionIndexToken, type ISessionIndex } from '@kiki/agent-core-v2/app/sessionIndex/sessionIndex';
import { IWorkspaceService as WorkspaceToken, type IWorkspaceService } from '@kiki/agent-core-v2/app/workspace/workspace';

import { TranscriptWireAdapter } from '@kiki/transcript';
import { HistoryLocatorStore, HISTORY_NAV_COLLECTION } from '../src/services/history/historyLocatorStore';
import { HistoryNavigationDb } from '../src/services/history/historyNavigationDb';
import { historyArchiveSeed } from '../src/services/historyArchive';
import type { TranscriptService } from '../src/services/transcript/transcriptService';

vi.mock('node:fs/promises', { spy: true });

function memoryStore(): IQueryStore {
  const rows = new Map<string, unknown>();
  return {
    get: async <T>(collection: string, key: string) => rows.get(`${collection}:${key}`) as T | undefined,
    put: async <T>(collection: string, key: string, value: T) => { rows.set(`${collection}:${key}`, value); },
    batch: async (ops: readonly WriteOp[]) => {
      for (const op of ops) {
        if (op.kind === 'put') rows.set(`${op.collection}:${op.key}`, op.value);
        else rows.delete(`${op.collection}:${op.key}`);
      }
    },
    pageByColumn: async <T extends Record<string, unknown>>(collection: string, query: {
      column: string; dir?: string; filter?: Record<string, unknown>;
      bounds?: { gt?: number; gte?: number; lt?: number; lte?: number }; limit: number,
    }) => {
      const values = [...rows].filter(([key]) => key.startsWith(`${collection}:`)).map(([, value]) => value as T)
        .filter((row) => Object.entries(query.filter ?? {}).every(([key, value]) => row[key] === value))
        .filter((row) => {
          const value = row[query.column] as number;
          return value !== undefined && (query.bounds?.gt === undefined || value > query.bounds.gt) &&
            (query.bounds?.gte === undefined || value >= query.bounds.gte) &&
            (query.bounds?.lt === undefined || value < query.bounds.lt) &&
            (query.bounds?.lte === undefined || value <= query.bounds.lte);
        }).toSorted((a, b) => (query.dir === 'desc' ? -1 : 1) *
          ((a[query.column] as number) - (b[query.column] as number)));
      return { items: values.slice(0, query.limit) };
    },
  } as unknown as IQueryStore;
}

function line(record: Record<string, unknown>): string { return `${JSON.stringify(record)}\n`; }

const lines = [
  line({ type: 'turn.prompt', turnId: 4, promptId: 'prompt-4',
    input: [{ type: 'text', text: '原话 one' }], origin: { kind: 'user' }, time: 1000 }),
  line({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 4, step: 1, uuid: 'uuid-1' }, time: 1001 }),
  line({ type: 'context.append_loop_event', event: { type: 'tool.call', turnId: 4, stepUuid: 'uuid-1',
    toolCallId: 'call-1', name: 'Read', args: { file: 'a.txt' } }, time: 1002 }),
  line({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'call-1',
    result: { output: 'needle 𠮷 suffix' } }, time: 1003 }),
  line({ type: 'context.append_loop_event', event: { type: 'step.end', turnId: 4, step: 1, uuid: 'uuid-1' }, time: 1004 }),
  line({ type: 'turn.ended', turnId: 4, reason: 'completed', time: 1005 }),
];

describe('history navigation source rows', () => {
  it('projects canonical IDs and source spans, verifies a tool result, and rejects a same-size replacement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-'));
    const wirePath = join(dir, 'wire.jsonl');
    try {
      await writeFile(wirePath, lines.join(''));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const store = memoryStore();
      const nav = new HistoryLocatorStore(store, transcript);
      const scan = await nav.scan('s', 'main');
      expect(scan).toMatchObject({ complete: true, recordsRead: 6 });
      const turn = await nav.row('ws', 's', 'main', 'turn', 4);
      expect(turn?.excerpt).toBe('原话 one');
      expect((await nav.read(nav.ref(turn!)))).toMatchObject({ status: 'ok', text: '原话 one' });
      const frame = await nav.row('ws', 's', 'main', 'frame', 4, 't4.1', 'uuid-1.call-1:output', 'output');
      expect(frame).toMatchObject({ role: 'tool', part: 'output', toolName: 'Read', excerpt: 'needle 𠮷 suffix' });
      expect((await nav.read(nav.ref(frame!)))).toMatchObject({ status: 'ok', text: 'needle 𠮷 suffix' });
      const directory = await nav.list({ workspaceId: 'ws', sessionId: 's', agentId: 'main',
        kind: 'turns', order: 'newest', limit: 10 });
      expect(directory).toMatchObject({ status: 'ok', coverage: { complete: true },
        turns: [{ turn: 4, promptExcerpt: '原话 one', stepCount: 1, toolCount: 1, ref: expect.any(String) }] });
      const modified = lines.map((item) => item.replace('needle', 'otherX'));
      await writeFile(wirePath, modified.join(''));
      expect((await nav.read(nav.ref(frame!))).status).toBe('stale_ref');
      expect(await store.get(HISTORY_NAV_COLLECTION, 'unused')).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('advances after append without rereading the old prefix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-'));
    const wirePath = join(dir, 'wire.jsonl');
    try {
      await writeFile(wirePath, lines.slice(0, 3).join(''));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(memoryStore(), transcript);
      const first = await nav.scan('s', 'main');
      await appendFile(wirePath, lines.slice(3).join(''));
      const second = await nav.scan('s', 'main');
      expect(second?.recordsRead).toBe(3);
      expect(second?.nextByteOffset).toBeGreaterThan(first!.nextByteOffset);
      const row = await nav.row('ws', 's', 'main', 'frame', 4, 't4.1', 'uuid-1.call-1:output', 'output');
      expect((await nav.read(nav.ref(row!))).status).toBe('ok');
      await appendFile(wirePath, line({ type: 'context.undo', count: 1, time: 1010 }));
      const undone = await nav.scan('s', 'main');
      expect(undone?.recordsRead).toBe(1);
      expect((await nav.read(nav.ref(row!))).status).toBe('stale_ref');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('hides a large SQLite suffix with range effects, keeps earlier refs and reuses IDs after clear', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-disk-undo-'));
    const wirePath = join(dir, 'wire.jsonl');
    const db = HistoryNavigationDb.lazy(join(dir, 'navigation.sqlite'));
    try {
      const prompts = Array.from({ length: 200 }, (_, turnId) => line({ type: 'turn.prompt', turnId,
        promptId: `p${turnId}`, origin: { kind: 'user' }, input: [{ type: 'text', text: `prompt ${turnId}` }] }));
      await writeFile(wirePath, prompts.join(''));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(db, transcript);
      expect((await nav.scan('s', 'main'))?.recordsRead).toBe(200);
      const earlier = await nav.row('ws', 's', 'main', 'turn', 19);
      const removed = await nav.row('ws', 's', 'main', 'turn', 21);
      await appendFile(wirePath, line({ type: 'context.undo', count: 180 }));
      expect((await nav.scan('s', 'main'))?.recordsRead).toBe(1);
      expect((await nav.read(nav.ref(earlier!))).status).toBe('ok');
      expect((await nav.read(nav.ref(removed!))).status).toBe('stale_ref');
      await appendFile(wirePath, line({ type: 'context.clear' }));
      await nav.scan('s', 'main');
      expect((await nav.read(nav.ref(earlier!))).status).toBe('stale_ref');
      await appendFile(wirePath, line({ type: 'turn.prompt', turnId: 0, promptId: 'again',
        origin: { kind: 'user' }, input: [{ type: 'text', text: 'new turn zero' }] }));
      await nav.scan('s', 'main');
      const reused = await nav.row('ws', 's', 'main', 'turn', 0);
      expect(await nav.read(nav.ref(reused!))).toMatchObject({ status: 'ok', text: 'new turn zero' });
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('restores a small manifest and disk identities after reopen, then scans only the appended tail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-restore-'));
    const wirePath = join(dir, 'wire.jsonl');
    const path = join(dir, 'navigation.sqlite');
    const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
    try {
      await writeFile(wirePath, lines.join(''));
      const firstDb = HistoryNavigationDb.lazy(path);
      const first = new HistoryLocatorStore(firstDb, transcript);
      expect((await first.scan('s', 'main'))?.recordsRead).toBe(6);
      const oldOutput = await first.row('ws', 's', 'main', 'frame', 4, 't4.1', 'uuid-1.call-1:output', 'output');
      const scope = 'ws\0s\0main';
      const manifest = (await firstDb.ready()).readManifest(scope);
      expect(manifest).toMatchObject({ v: 2, offset: Buffer.byteLength(lines.join('')), ordinal: 6 });
      const size = (await firstDb.ready()).db.prepare('SELECT length(value) AS size FROM manifest WHERE scope=?')
        .get(scope) as { size: number };
      expect(size.size).toBeLessThanOrEqual(16 << 10);
      await firstDb.close();
      const appended = [
        line({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'call-1',
          result: { output: 'late result after restart' } }, time: 1006 }),
        line({ type: 'turn.prompt', turnId: 5, promptId: 'p5', origin: { kind: 'user' },
          input: [{ type: 'text', text: 'tail original' }], time: 1007 }),
      ];
      await appendFile(wirePath, appended.join(''));
      const secondDb = HistoryNavigationDb.lazy(path);
      try {
        const second = new HistoryLocatorStore(secondDb, transcript);
        const scan = await second.scan('s', 'main');
        expect(scan).toMatchObject({ recordsRead: 2, bytesRead: expect.any(Number), complete: true });
        expect(scan!.bytesRead).toBeLessThan(Buffer.byteLength(lines.join('')));
        expect((await second.read(second.ref(oldOutput!))).status).toBe('stale_ref');
        const updated = await second.row('ws', 's', 'main', 'frame', 4, 't4.1', 'uuid-1.call-1:output', 'output');
        expect(await second.read(second.ref(updated!))).toMatchObject({ status: 'ok', text: 'late result after restart' });
        expect((await secondDb.ready()).readManifest(scope)?.ordinal).toBe(8);
      } finally { await secondDb.close(); }
      const original = await readFile(wirePath, 'utf8');
      await writeFile(wirePath, original.replace('late result after restart', 'cold result after restart'));
      const changedDb = HistoryNavigationDb.lazy(path);
      try {
        const changed = new HistoryLocatorStore(changedDb, transcript);
        expect((await changed.scan('s', 'main'))?.recordsRead).toBe(8);
        const replacement = await changed.row('ws', 's', 'main', 'frame', 4, 't4.1', 'uuid-1.call-1:output', 'output');
        expect(await changed.read(changed.ref(replacement!))).toMatchObject({ status: 'ok', text: 'cold result after restart' });
      } finally { await changedDb.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each(['crash', 'cancel'] as const)('rolls back flushed rows and scalar state on %s before checkpoint', async (failure) => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-crash-'));
    const wirePath = join(dir, 'wire.jsonl');
    const path = join(dir, 'navigation.sqlite');
    const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
    try {
      await writeFile(wirePath, lines.join(''));
      const firstDb = HistoryNavigationDb.lazy(path);
      const first = new HistoryLocatorStore(firstDb, transcript);
      const before = await first.scan('s', 'main');
      const tail = Array.from({ length: 300 }, (_, n) => line({ type: 'turn.prompt', turnId: n + 10,
        promptId: `tail-${n}`, origin: { kind: 'user' }, input: [{ type: 'text', text: `tail-prompt-${n}` }] }));
      await appendFile(wirePath, tail.join(''));
      const disk = await firstDb.ready();
      const original = disk.batch.bind(disk);
      const controller = new AbortController();
      vi.spyOn(disk, 'batch').mockImplementationOnce(async (ops) => {
        await original(ops);
        if (failure === 'cancel') controller.abort(new DOMException('injected scan cancel', 'AbortError'));
        else throw new Error('simulated crash after microbatch write');
      });
      await expect(first.scan('s', 'main', controller.signal)).rejects.toThrow(
        failure === 'cancel' ? 'injected scan cancel' : 'simulated crash');
      expect(disk.readManifest('ws\0s\0main')?.offset).toBe(before?.nextByteOffset);
      expect(await first.row('ws', 's', 'main', 'turn', 10)).toBeUndefined();
      await firstDb.close();
      const secondDb = HistoryNavigationDb.lazy(path);
      try {
        const second = new HistoryLocatorStore(secondDb, transcript);
        expect((await second.scan('s', 'main'))?.recordsRead).toBe(300);
        const row = await second.row('ws', 's', 'main', 'turn', 309);
        expect(await second.read(second.ref(row!))).toMatchObject({ status: 'ok', text: 'tail-prompt-299' });
      } finally { await secondDb.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('serializes two concurrent SQLite query workspaces and keeps both source hits readable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-disk-parallel-'));
    const wirePath = join(dir, 'wire.jsonl');
    const db = HistoryNavigationDb.lazy(join(dir, 'navigation.sqlite'));
    try {
      await writeFile(wirePath, lines.join(''));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(db, transcript);
      const [prompt, tool] = await Promise.all([
        nav.scan('s', 'main', undefined, { query: '原话', mode: 'auto', pageSize: 5 }),
        nav.scan('s', 'main', undefined, { query: 'needle', mode: 'auto', pageSize: 5 }),
      ]);
      const sourceRows = (await db.ready()).rowsAtSource('ws', 's', 'main', 0);
      expect(sourceRows).toEqual([expect.objectContaining({ part: 'prompt', role: 'user', active: true })]);
      expect(await nav.read(nav.ref(sourceRows[0]!))).toMatchObject({ status: 'ok', text: '原话 one' });
      expect(prompt).toMatchObject({ recordsRead: 6, complete: true });
      expect(prompt?.hits?.map((hit) => hit.turn)).toEqual([4]);
      expect(tool?.hits?.map((hit) => hit.turn)).toEqual([4]);
      expect((await nav.read(prompt!.hits![0]!.ref!)).status).toBe('ok');
      expect((await nav.read(tool!.hits![0]!.ref!)).status).toBe('ok');
      const disk = await db.ready();
      const scope = 'ws\0s\0main';
      const generation = disk.readManifest(scope)?.generation;
      const oldTurnKey = ['ws', 's', 'main', 'turn', '4', '', '', ''].join('\0');
      await disk.put(HISTORY_NAV_COLLECTION, oldTurnKey, { ...sourceRows[0]!, role: undefined });
      expect((await nav.scan('s', 'main', undefined, { query: '原话', mode: 'auto',
        role: 'user', pageSize: 5 }))?.hits).toEqual([expect.objectContaining({ turn: 4, role: 'user' })]);
      const variants = [
        { query: '原话', mode: 'auto', role: 'user' },
        { query: 'needle', mode: 'all', role: 'tool' },
        { query: 'needle', mode: 'any', role: 'tool' },
      ] as const;
      for (let i = 0; i < 12; i += 1) {
        const result = await nav.scan('s', 'main', undefined, { ...variants[i % variants.length]!, pageSize: 1 });
        expect(result?.hits?.map((hit) => hit.turn)).toEqual([4]);
      }
      const cancelled = new AbortController();
      cancelled.abort(new Error('one search caller cancelled'));
      const independent = { query: 'needle', mode: 'literal' as const, pageSize: 5 };
      const [rejected, allowed] = await Promise.allSettled([
        nav.scan('s', 'main', cancelled.signal, independent), nav.scan('s', 'main', undefined, independent),
      ]);
      expect(rejected).toMatchObject({ status: 'rejected' });
      expect(allowed).toMatchObject({ status: 'fulfilled', value: { hits: [{ turn: 4 }] } });
      expect(disk.readManifest(scope)?.generation).toBe(generation);
      const scopeBytes = Buffer.from(scope).toString('hex').toUpperCase();
      expect(disk.db.prepare('SELECT hex(scope) AS scope FROM manifest').all()).toEqual([{ scope: scopeBytes }]);
      expect(disk.db.prepare('SELECT DISTINCT hex(scope) AS scope FROM state').all()).toEqual([{ scope: scopeBytes }]);
      const indexPlan = disk.db.prepare(`EXPLAIN QUERY PLAN SELECT value FROM rows
        WHERE workspace=? AND session=? AND agent=? AND active=1
        AND json_extract(value, '$.anchor.start')=? LIMIT 1024`)
        .all('ws', 's', 'main', 0) as Array<{ detail: string }>;
      expect(indexPlan.some((step) => step.detail.includes('nav_source'))).toBe(true);
      await appendFile(wirePath, line({ type: 'context.undo', count: 1, time: 1010 }));
      expect((await nav.scan('s', 'main', undefined, { query: 'needle', mode: 'any', pageSize: 5 }))?.hits).toEqual([]);
      expect((await nav.read(tool!.hits![0]!.ref!)).status).toBe('stale_ref');
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('keeps uppercase ASCII and NFKC-equivalent Unicode searchable through the fast path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-normalized-'));
    const wirePath = join(dir, 'wire.jsonl');
    const db = HistoryNavigationDb.lazy(join(dir, 'navigation.sqlite'));
    try {
      await writeFile(wirePath, [
        line({ type: 'turn.prompt', turnId: 0, promptId: 'p0', origin: { kind: 'user' },
          input: [{ type: 'text', text: 'UPPERCASE prompt' }], time: 1 }),
        line({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 0,
          step: 1, uuid: 's0' }, time: 2 }),
        line({ type: 'context.append_loop_event', event: { type: 'content.part', turnId: 0,
          stepUuid: 's0', uuid: 'f0', part: { type: 'text', text: 'ＦＯＯ result' } }, time: 3 }),
      ].join(''));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(db, transcript);
      for (const [query, role, text] of [
        ['uppercase', 'user', 'UPPERCASE prompt'], ['foo', 'assistant', 'ＦＯＯ result'],
      ] as const) {
        const page = await nav.scan('s', 'main', undefined, { query, mode: 'literal', pageSize: 5 });
        expect(page?.hits).toEqual([expect.objectContaining({ turn: 0, role })]);
        expect(await nav.read(page!.hits![0]!.ref!)).toMatchObject({ status: 'ok', text });
      }
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('returns a bounded, non-repeating partial result when one wire line exceeds the scan page', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-'));
    const wirePath = join(dir, 'wire.jsonl');
    try {
      await writeFile(wirePath, line({ type: 'turn.prompt', turnId: 0, promptId: 'oversize',
        input: [{ type: 'text', text: 'X'.repeat((8 << 20) + 1024) }], time: 1000 }));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(memoryStore(), transcript);
      const archive = historyArchiveSeed(() => ({ accessor: { get: () => ({ get: async () => undefined }) } }) as unknown as Scope,
        () => transcript, () => nav)[0]![1] as IHistoryArchive;
      const page = await archive.search({ query: 'needle', mode: 'auto', workspaceId: 'ws',
        sessionId: 's', agentId: 'main', pageSize: 5 });
      expect(page).toMatchObject({ items: [], hasMore: false,
        coverage: { complete: false, scanned: { records: 0 } } });
      expect(page.pageToken).toBeUndefined();
      expect(page.incomplete).toBeTruthy();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('continues a fixed-watermark SQLite search past 8 MiB to a deep-tail source ref', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-'));
    const wirePath = join(dir, 'wire.jsonl');
    const db = HistoryNavigationDb.lazy(join(dir, 'navigation.sqlite'));
    try {
      const filler = 'f'.repeat(1 << 20);
      const wire = Array.from({ length: 9 }, (_unused, turnId) =>
        line({ type: 'turn.prompt', turnId, promptId: `p-${turnId}`, time: 1000 + turnId,
          input: [{ type: 'text', text: `${turnId === 3 || turnId === 8 ? 'needle ' : ''}${turnId === 8 ? 'tailmarker ' : ''}${filler}` }] })).join('');
      expect(Buffer.byteLength(wire)).toBeGreaterThan(9 << 20);
      await writeFile(wirePath, wire);
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(db, transcript);
      const archive = historyArchiveSeed(() => ({ accessor: { get: () => ({ get: async () => undefined }) } }) as unknown as Scope,
        () => transcript, () => nav)[0]![1] as IHistoryArchive;
      const request = { query: 'needle', mode: 'auto' as const, workspaceId: 'ws',
        sessionId: 's', agentId: 'main', pageSize: 1 };
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(archive.search({ ...request, signal: cancelled.signal })).rejects.toThrow();
      const first = await archive.search({ ...request, sort: 'newest' });
      expect(first).toMatchObject({ items: [], incomplete: 'navigation_building',
        continuation: 'scan', hasMore: true, coverage: { complete: false } });
      const second = await archive.search({ ...request, sort: 'newest', pageToken: first.pageToken });
      expect(second).toMatchObject({ items: [{ turn: 8, ref: expect.any(String) }], hasMore: true });
      const third = await archive.search({ ...request, sort: 'newest', pageToken: second.pageToken });
      expect(third.items.map((hit) => hit.turn)).toEqual([3]);
      expect((await archive.readRef?.(second.items[0]!.ref!))).toMatchObject({
        status: 'ok', text: expect.stringContaining('needle'), turn: 8,
      });
      for (const page of [first, second, third]) {
        expect(page.fallback).toMatchObject({ maxBytes: 8 << 20, maxRecords: 50_000 });
        expect(page.coverage?.scanned?.bytes).toBeLessThanOrEqual(8 << 20);
        expect(page.coverage?.scanned?.records).toBeLessThanOrEqual(50_000);
      }
      const recent = await archive.search({ ...request, query: 'tailmarker', sort: 'newest' });
      expect(recent).toMatchObject({ items: [{ turn: 8, time: 1008 }], hasMore: true });
      expect(recent.coverage?.scanned?.bytes).toBeLessThan(2 << 20);
      const absent = await archive.search({ ...request, query: 'absentmarker' });
      expect(absent).toMatchObject({ items: [], continuation: 'scan', hasMore: true,
        coverage: { complete: false }, incomplete: 'wire_scan_limit' });
      const absentTail = await archive.search({ ...request, query: 'absentmarker', pageToken: absent.pageToken });
      expect(absentTail).toMatchObject({ items: [], hasMore: false, coverage: { complete: true } });
      expect(absentTail.pageToken).toBeUndefined();
      const alternate = await archive.search({ ...request, query: 'needle fff', pageToken: undefined });
      expect(alternate.items.map((hit) => hit.turn)).toEqual([8]);
      const manifestScopes = (await db.ready()).db.prepare('SELECT hex(scope) AS scope FROM manifest').all() as Array<{ scope: string }>;
      expect(manifestScopes).toEqual([{ scope: Buffer.from('ws\0s\0main').toString('hex').toUpperCase() }]);
      await appendFile(wirePath, line({ type: 'context.clear', time: 1011 }));
      await nav.scan('s', 'main');
      await expect(archive.search({ ...request, sort: 'newest', pageToken: first.pageToken })).rejects.toThrow('stale_scan_cursor');
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('returns the newest cold-session hit on the first call when preparation and text fit the shared budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-sort-cold-'));
    const wirePath = join(dir, 'wire.jsonl');
    const db = HistoryNavigationDb.lazy(join(dir, 'navigation.sqlite'));
    try {
      const filler = 'f'.repeat(1 << 20);
      await writeFile(wirePath, Array.from({ length: 6 }, (_unused, turnId) => line({ type: 'turn.prompt', turnId,
        promptId: `p${turnId}`, time: turnId + 1000, input: [{ type: 'text', text: `${turnId === 5 ? 'tailmarker ' : ''}${filler}` }] })).join(''));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(db, transcript);
      const archive = historyArchiveSeed(() => ({ accessor: { get: () => ({ get: async () => undefined }) } }) as unknown as Scope,
        () => transcript, () => nav)[0]![1] as IHistoryArchive;
      const page = await archive.search({ query: 'tailmarker', mode: 'auto', sort: 'newest', workspaceId: 'ws', sessionId: 's', agentId: 'main', pageSize: 1 });
      expect(page.items).toMatchObject([{ turn: 5, time: 1005 }]);
      expect(page.coverage?.scanned?.bytes).toBeLessThanOrEqual(8 << 20);
      expect(page.coverage?.scanned?.bytes).toBeGreaterThan(6 << 20);
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('sorts SQLite hits by time and stable key across pages, ranks page-local relevance and rejects mutated cursors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-sort-'));
    const wirePath = join(dir, 'wire.jsonl');
    const db = HistoryNavigationDb.lazy(join(dir, 'navigation.sqlite'));
    try {
      const times = [3000, 1000, 3000, 2000];
      const wire = times.map((time, turnId) => line({ type: 'turn.prompt', turnId, promptId: `p${turnId}`, time,
        input: [{ type: 'text', text: turnId === 1 ? 'needle extra' : 'needle' }] })).join('');
      await writeFile(wirePath, wire);
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(db, transcript);
      const archive = historyArchiveSeed(() => ({ accessor: { get: () => ({ get: async () => undefined }) } }) as unknown as Scope,
        () => transcript, () => nav)[0]![1] as IHistoryArchive;
      const request = { query: 'needle', mode: 'auto' as const, workspaceId: 'ws', sessionId: 's', agentId: 'main', pageSize: 1 };
      for (const sort of ['newest', 'oldest'] as const) {
        const turns: number[] = [];
        let pageToken: string | undefined;
        do {
          const page = await archive.search({ ...request, sort, pageToken });
          turns.push(...page.items.map((item) => item.turn!));
          pageToken = page.pageToken;
        } while (pageToken !== undefined);
        expect(turns).toEqual(sort === 'newest' ? [2, 0, 3, 1] : [1, 3, 0, 2]);
      }
      const filtered = await archive.search({ ...request, sort: 'newest', role: 'user', after: 2000, before: 3000, pageSize: 5 });
      expect(filtered.items.map((hit) => hit.turn)).toEqual([3]);
      expect((await archive.search({ ...request, sort: 'newest', role: 'assistant' })).items).toEqual([]);
      const relevance = await archive.search({ ...request, query: 'needle extra', pageSize: 4 });
      expect(relevance.items.map((hit) => hit.turn)).toEqual([1, 2, 0, 3]);
      const partial = await archive.search({ ...request, query: 'needle extra', pageSize: 2 });
      expect(partial.coverage?.gaps).toContain('page_local_relevance');
      expect(partial.warning).toContain('only this page');
      const newest = await archive.search({ ...request, sort: 'newest' });
      const identity = JSON.parse(Buffer.from(newest.pageToken!, 'base64url').toString('utf8')) as { incarnation: string; asOf: number };
      const oldCursor = Buffer.from(JSON.stringify({ v: 1, offset: 0, incarnation: identity.incarnation, asOf: identity.asOf })).toString('base64url');
      const legacy = await archive.search({ ...request, sort: 'newest', pageToken: oldCursor });
      expect(legacy.items.map((hit) => hit.turn)).toEqual([0]);
      expect(legacy.coverage?.gaps).toContain('legacy_source_order');
      expect(legacy.warning).toContain('source order');
      const reopenedDb = HistoryNavigationDb.lazy(join(dir, 'navigation.sqlite'));
      try {
        const reopenedNav = new HistoryLocatorStore(reopenedDb, transcript);
        const reopenedArchive = historyArchiveSeed(() => ({ accessor: { get: () => ({ get: async () => undefined }) } }) as unknown as Scope,
          () => transcript, () => reopenedNav)[0]![1] as IHistoryArchive;
        expect((await reopenedArchive.search({ ...request, sort: 'newest', pageToken: newest.pageToken })).items.map((hit) => hit.turn)).toEqual([0]);
      } finally { await reopenedDb.close(); }
      const database = (await db.ready()).db;
      const version = database.prepare('PRAGMA user_version').get();
      expect(version).toEqual({ user_version: 2 });
      const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT key,value FROM rows WHERE workspace='ws' AND session='s' AND agent='main'
        AND active=1 AND json_extract(value,'$.part') IN ('prompt','text','output') ORDER BY coalesce(time,0) DESC,key DESC LIMIT 64`).all() as Array<{ detail: string }>;
      expect(plan.some((row) => row.detail.includes('nav_search_order'))).toBe(true);
      expect(plan.some((row) => row.detail.includes('TEMP B-TREE'))).toBe(false);
      await expect(archive.search({ ...request, sort: 'oldest', pageToken: newest.pageToken })).rejects.toThrow('stale_scan_cursor');
      await expect(archive.search({ ...request, query: 'other', sort: 'newest', pageToken: newest.pageToken })).rejects.toThrow('stale_scan_cursor');
      const decoded = JSON.parse(Buffer.from(newest.pageToken!, 'base64url').toString('utf8')) as Record<string, unknown>;
      await expect(archive.search({ ...request, sort: 'newest', pageToken: Buffer.from(JSON.stringify({ ...decoded, after: { time: 0, key: '' } })).toString('base64url') })).rejects.toThrow('invalid_scan_cursor');
      await writeFile(wirePath, wire.replace('needle', 'absent'));
      await expect(archive.search({ ...request, sort: 'newest', pageToken: newest.pageToken })).rejects.toThrow('stale_scan_cursor');
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('finishes undo and clear visibility before sorted search returns any hits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-sort-visibility-'));
    const wirePath = join(dir, 'wire.jsonl');
    const db = HistoryNavigationDb.lazy(join(dir, 'navigation.sqlite'));
    try {
      await writeFile(wirePath, [0, 1].map((turnId) => line({ type: 'turn.prompt', turnId, promptId: `p${turnId}`,
        origin: { kind: 'user' }, time: 1000 + turnId, input: [{ type: 'text', text: 'needle' }] })).join('') + line({ type: 'context.undo', count: 1 }));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(db, transcript);
      const archive = historyArchiveSeed(() => ({ accessor: { get: () => ({ get: async () => undefined }) } }) as unknown as Scope,
        () => transcript, () => nav)[0]![1] as IHistoryArchive;
      const request = { query: 'needle', mode: 'auto' as const, sort: 'newest' as const, workspaceId: 'ws', sessionId: 's', agentId: 'main', pageSize: 5 };
      expect((await archive.search(request)).items.map((item) => item.turn)).toEqual([0]);
      await appendFile(wirePath, line({ type: 'context.clear' }));
      expect((await archive.search(request)).items).toEqual([]);
      await appendFile(wirePath, line({ type: 'turn.prompt', turnId: 0, promptId: 'replacement', time: 5000,
        input: [{ type: 'text', text: 'needle replacement' }] }));
      const replaced = await archive.search(request);
      expect(replaced.items).toMatchObject([{ turn: 0, time: 5000 }]);
      expect((await archive.readRef?.(replaced.items[0]!.ref!))).toMatchObject({ status: 'ok', text: 'needle replacement' });
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('focuses a 20k tool-output tail and resumes a block with ref plus UTF-16 range', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-'));
    const wirePath = join(dir, 'wire.jsonl');
    try {
      const text = `${'A'.repeat(19_000)}needle𠮷${'B'.repeat(1200)}`;
      await writeFile(wirePath, lines.map((item) => item.replace('needle 𠮷 suffix', text)).join(''));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(memoryStore(), transcript);
      const result = await nav.scan('s', 'main', undefined, {
        query: 'needle𠮷', mode: 'auto', pageSize: 5,
      });
      expect(result?.hits).toEqual([expect.objectContaining({ role: 'tool', turn: 4, stepId: 't4.1', ref: expect.any(String) })]);
      const row = await nav.row('ws', 's', 'main', 'frame', 4, 't4.1', 'uuid-1.call-1:output', 'output');
      const archive = historyArchiveSeed(() => ({ accessor: { get: () => ({ get: async () => undefined }) } }) as unknown as Scope,
        () => transcript, () => nav)[0]![1] as IHistoryArchive;
      const page = await archive.search({ query: 'needle𠮷', mode: 'auto', workspaceId: 'ws',
        sessionId: 's', agentId: 'main', pageSize: 5 });
      expect(page.items).toEqual([expect.objectContaining({ ref: expect.any(String), turn: 4, stepId: 't4.1' })]);
      expect(page.coverage).toMatchObject({ complete: true, domain: 'full_text' });
      const tool = new HistoryReadTool(archive, { sessionId: 's', workspaceId: 'ws' } as ISessionContext,
        { get: async () => undefined } as unknown as IWorkspaceService,
        { get: async () => ({ workspaceId: 'ws' }) } as unknown as ISessionIndex,
        { agentId: 'main' } as IAgentScopeContext);
      const run = async (input: Record<string, unknown>) => {
        const execution = await tool.resolveExecution(input as never);
        if (!('execute' in execution)) throw new Error('not executable');
        return JSON.parse((await execution.execute({ signal: new AbortController().signal, turnId: 0, toolCallId: 'c' })).output as string);
      };
      const invalid = `h1_${Buffer.from(JSON.stringify({ workspace: 'ws', session: 's', agent: 'main' })).toString('base64url')}`;
      expect(await run({ ref: invalid })).toMatchObject({ error: { code: 'invalid_ref' } });
      const focus = await run({ ref: nav.ref(row!, 19_000) });
      expect(focus.blocks[0].text).toContain('needle𠮷');
      expect(focus.blocks[0].range.start).toBeGreaterThan(18_000);
      const first = await run({ ref: focus.blocks[0].ref, start_char: 0 });
      let merged = first.blocks[0].text as string;
      let cursor = first.next_cursor as string | undefined;
      while (cursor !== undefined) {
        const page = await run({ cursor });
        merged += page.blocks[0].text;
        cursor = page.next_cursor;
      }
      expect(merged).toBe(text);
      const recovered = await run({ ref: focus.blocks[0].ref, start_char: first.blocks[0].range.end });
      expect(recovered.blocks[0].text).toBe(text.slice(first.blocks[0].range.end, recovered.blocks[0].range.end));
      const directory = await nav.list({ workspaceId: 'ws', sessionId: 's', agentId: 'main',
        kind: 'turns', order: 'newest', limit: 10 });
      const turnRef = directory.turns?.[0]?.ref;
      expect(turnRef).toBeDefined();
      const collect = async (selector: Record<string, unknown>) => {
        const blocks: Array<{ part: string; text: string; range: { start: number; end: number } }> = [];
        let page = await run(selector);
        let pages = 0;
        while (true) {
          pages += 1;
          if (pages > 20) throw new Error('directory pagination did not terminate');
          blocks.push(...page.blocks);
          if (page.next_cursor === undefined) break;
          page = await run({ cursor: page.next_cursor });
        }
        return blocks;
      };
      const turnBlocks = await collect({ ref: turnRef });
      expect(turnBlocks[0]).toMatchObject({ part: 'prompt', text: '原话 one' });
      expect(turnBlocks.filter((block) => block.part === 'output').map((block) => block.text).join('')).toBe(text);
      expect(turnBlocks.some((block) => block.part === 'input')).toBe(true);
      const numericBlocks = await collect({ turn: 4 });
      expect(numericBlocks).toEqual(turnBlocks);
      const stepRef = await archive.directoryRef?.('ws', 's', 'main', 4, 't4.1');
      const stepBlocks = await collect({ ref: stepRef });
      expect(stepBlocks.some((block) => block.part === 'prompt')).toBe(false);
      expect(stepBlocks.filter((block) => block.part === 'output').map((block) => block.text).join('')).toBe(text);
      expect(await collect({ step_id: 't4.1' })).toEqual(stepBlocks);
      const beforeRevision = await run({ ref: turnRef });
      expect(beforeRevision.next_cursor).toBeDefined();
      await appendFile(wirePath, line({ type: 'context.append_loop_event', event: {
        type: 'tool.result', toolCallId: 'call-1', result: { output: 'revised tool output' },
      }, time: 1011 }));
      await nav.scan('s', 'main');
      expect(await run({ cursor: beforeRevision.next_cursor })).toMatchObject({ error: { code: 'stale_ref' } });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reads separate tool input/result spans after a slice and matches canonical tool identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-tool-'));
    const wirePath = join(dir, 'wire.jsonl');
    try {
      const longInput = 'I'.repeat(16_000);
      const longOutput = `late-result ${'O'.repeat(16_000)}`;
      const call = { type: 'context.append_loop_event', time: 3,
        event: { type: 'tool.call', turnId: 4, stepUuid: 's4', toolCallId: 'tool-4', name: 'Read', args: { path: longInput } } };
      const result = { type: 'context.append_loop_event', time: 6,
        event: { type: 'tool.result', toolCallId: 'tool-4', result: { output: longOutput } } };
      const records = [
        { type: 'turn.prompt', turnId: 4, promptId: 'p4', input: [{ type: 'text', text: 'prompt' }],
          origin: { kind: 'user' }, time: 1 },
        { type: 'context.append_loop_event', time: 2, event: { type: 'step.begin', turnId: 4, step: 1, uuid: 's4' } },
        call,
        { type: 'context.append_loop_event', time: 4, event: { type: 'step.end', turnId: 4, step: 1, uuid: 's4' } },
        { type: 'turn.ended', turnId: 4, reason: 'completed', time: 5 },
        result,
      ];
      await writeFile(wirePath, records.slice(0, 5).map(line).join(''));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(memoryStore(), transcript);
      expect((await nav.scan('s', 'main'))?.recordsRead).toBe(5);
      await appendFile(wirePath, line(result));
      expect((await nav.scan('s', 'main'))?.recordsRead).toBe(1);
      const input = await nav.row('ws', 's', 'main', 'frame', 4, 't4.1', 's4.tool-4:input', 'input');
      const output = await nav.row('ws', 's', 'main', 'frame', 4, 't4.1', 's4.tool-4:output', 'output');
      expect(input?.selector).toBe('event.args');
      expect(output?.selector).toBe('event.result.output');
      expect(input?.anchor.start).toBeLessThan(output!.anchor.start);
      expect(await nav.read(nav.ref(input!))).toMatchObject({ status: 'ok', text: JSON.stringify({ path: longInput }) });
      expect(await nav.read(nav.ref(output!))).toMatchObject({ status: 'ok', text: longOutput });
      const canonical = new TranscriptWireAdapter('main');
      const projected = records.flatMap((record) => canonical.add(record).flatMap((fact) => fact.operations));
      const tool = projected.findLast((operation) => operation.op === 'frame.upsert');
      expect(tool).toMatchObject({ turnId: 't4', stepId: 's4', frame: {
        frameId: 's4.tool-4', name: 'Read', input: { path: longInput }, output: longOutput } });
      await appendFile(wirePath, line({ type: 'context.clear', time: 7 }));
      await nav.scan('s', 'main');
      expect((await nav.read(nav.ref(input!))).status).toBe('stale_ref');
      expect((await nav.read(nav.ref(output!))).status).toBe('stale_ref');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each(['memory', 'sqlite'] as const)('preserves accepted delivery frames across undo with %s state', async (backend) => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-undo-'));
    const wirePath = join(dir, 'wire.jsonl');
    const db = backend === 'sqlite' ? HistoryNavigationDb.lazy(join(dir, 'navigation.sqlite')) : undefined;
    try {
      const records = [
        { type: 'turn.prompt', turnId: 0, promptId: 'p0', managed: true, origin: { kind: 'user' },
          input: [], time: 1 },
        { type: 'context.append_message', time: 2, message: { role: 'user', id: 'p0', origin: { kind: 'user',
          skillActivations: [{ activationId: 'skill-1', skillName: 'Show' }] },
          content: [{ type: 'text', text: 'skill marker' }, { type: 'text', text: 'delivered prompt' }] },
          delivery: { turnId: 0, messageId: 'p0' } },
        { type: 'context.append_loop_event', time: 3, event: { type: 'step.begin', turnId: 0, step: 1, uuid: 's0' } },
        { type: 'context.append_loop_event', time: 4, event: { type: 'content.part', turnId: 0, stepUuid: 's0',
          uuid: 'before', part: { type: 'text', text: 'before delivery' } } },
        { type: 'context.append_message', time: 5, message: { role: 'user', id: 'd1', origin: { kind: 'user' },
          content: [{ type: 'text', text: 'steer' }] }, delivery: { turnId: 0, stepId: 's0', step: 1 } },
        { type: 'context.append_loop_event', time: 6, event: { type: 'content.part', turnId: 0, stepUuid: 's0',
          uuid: 'after', part: { type: 'text', text: 'after delivery' } } },
      ];
      await writeFile(wirePath, records.map(line).join(''));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(db ?? memoryStore(), transcript);
      await nav.scan('s', 'main');
      const turn = await nav.row('ws', 's', 'main', 'turn', 0);
      const before = await nav.row('ws', 's', 'main', 'frame', 0, 't0.1', 'before:text', 'text');
      const after = await nav.row('ws', 's', 'main', 'frame', 0, 't0.1', 'after:text', 'text');
      expect(turn?.selector).toBe('message.content');
      expect(await nav.read(nav.ref(turn!))).toMatchObject({ status: 'ok', text: 'delivered prompt' });
      expect((await nav.read(nav.ref(after!))).status).toBe('ok');
      const canonical = new TranscriptWireAdapter('main');
      for (const record of records) canonical.add(record);
      const undo = { type: 'context.undo', count: 1, time: 7 };
      const effects = canonical.add(undo).flatMap((fact) => fact.operations);
      expect(effects).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'turn.upsert', turn: expect.objectContaining({
        prompt: 'delivered prompt' }) })]));
      await appendFile(wirePath, line(undo));
      await nav.scan('s', 'main');
      expect((await nav.read(nav.ref(turn!))).status).toBe('ok');
      expect((await nav.read(nav.ref(before!))).status).toBe('ok');
      expect((await nav.read(nav.ref(after!))).status).toBe('stale_ref');
    } finally { await db?.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('projects legacy assistant parts and tool messages while skipping hidden legacy origins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-legacy-'));
    const wirePath = join(dir, 'wire.jsonl');
    try {
      const records = [
        { type: 'context.append_message', time: 1, message: { role: 'user', id: 'u0',
          origin: { kind: 'user' }, content: [{ type: 'text', text: 'legacy prompt' }] } },
        { type: 'context.append_message', time: 2, message: { role: 'assistant', id: 'a0',
          content: [{ type: 'text', text: 'legacy answer' }, { type: 'think', think: 'private' }],
          toolCalls: [{ id: 'c0', name: 'Read', arguments: '{"path":"legacy.txt"}' }] } },
        { type: 'context.append_message', time: 3, message: { role: 'tool', toolCallId: 'c0',
          content: [{ type: 'text', text: 'legacy result' }] } },
        { type: 'context.append_message', time: 4, message: { role: 'user', id: 'hidden',
          origin: { kind: 'retry' }, content: [{ type: 'text', text: 'not a turn' }] } },
        { type: 'context.append_message', time: 5, message: { role: 'user', id: 'u2',
          origin: { kind: 'user' }, content: [{ type: 'text', text: 'next prompt' }] } },
      ];
      await writeFile(wirePath, records.map(line).join(''));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(memoryStore(), transcript);
      await nav.scan('s', 'main');
      const canonical = new TranscriptWireAdapter('main');
      const operations = records.flatMap((record) => canonical.add(record).flatMap((fact) => fact.operations));
      expect(operations.filter((op) => op.op === 'turn.upsert').map((op) => op.turn.turnId))
        .toEqual(['t0', 't0', 't2']);
      const prompt = await nav.row('ws', 's', 'main', 'turn', 0);
      const answer = await nav.row('ws', 's', 'main', 'frame', 0, 't0.1', 'legacy:v1:r1:part0:text', 'text');
      const input = await nav.row('ws', 's', 'main', 'frame', 0, 't0.1', 'legacy:v1:r1:step.c0:input', 'input');
      const output = await nav.row('ws', 's', 'main', 'frame', 0, 't0.1', 'legacy:v1:r1:step.c0:output', 'output');
      expect(await nav.read(nav.ref(prompt!))).toMatchObject({ status: 'ok', text: 'legacy prompt' });
      expect(await nav.read(nav.ref(answer!))).toMatchObject({ status: 'ok', text: 'legacy answer' });
      expect(await nav.read(nav.ref(input!))).toMatchObject({ status: 'ok', text: '{"path":"legacy.txt"}' });
      expect(await nav.read(nav.ref(output!))).toMatchObject({ status: 'ok', text: 'legacy result' });
      expect(await nav.row('ws', 's', 'main', 'turn', 1)).toBeUndefined();
      expect(await nav.read(nav.ref((await nav.row('ws', 's', 'main', 'turn', 2))!)))
        .toMatchObject({ status: 'ok', text: 'next prompt' });
      expect(nav.retainedBodyChars).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('does not turn a paired steer echo into a delivery or a new legacy turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-steer-'));
    const wirePath = join(dir, 'wire.jsonl');
    try {
      const records = [
        { type: 'context.append_message', time: 1, message: { role: 'user', id: 'u0',
          origin: { kind: 'user' }, content: [{ type: 'text', text: 'initial' }] } },
        { type: 'turn.steer', time: 2, turnId: 0, promptId: 'steer-1', origin: { kind: 'user' },
          input: [{ type: 'text', text: 'steered body' }] },
        { type: 'context.append_message', time: 3, message: { role: 'user', id: 'steer-1',
          origin: { kind: 'user' }, content: [{ type: 'text', text: 'steered body' }] } },
        { type: 'context.append_message', time: 4, message: { role: 'user', id: 'u1',
          origin: { kind: 'user' }, content: [{ type: 'text', text: 'next' }] } },
      ];
      await writeFile(wirePath, records.map(line).join(''));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(memoryStore(), transcript);
      await nav.scan('s', 'main');
      const canonical = new TranscriptWireAdapter('main');
      const ops = records.flatMap((record) => canonical.add(record).flatMap((fact) => fact.operations));
      expect(ops.filter((op) => op.op === 'turn.upsert').map((op) => op.turn.turnId)).toEqual(['t0', 't1']);
      expect(await nav.row('ws', 's', 'main', 'turn', 2)).toBeUndefined();
      expect((await nav.row('ws', 's', 'main', 'turn', 1))?.excerpt).toBe('next');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('recovers a distant step through preparation cursors and distinguishes absent and missing sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-read-preparation-'));
    const wirePath = join(dir, 'wire.jsonl');
    const db = HistoryNavigationDb.lazy(join(dir, 'navigation.sqlite'));
    const ix = new TestInstantiationService();
    try {
      const filler = 'f'.repeat(1 << 20);
      const target = lines.map((record) => record.replaceAll('"turnId":4',
        record.includes('context.append_loop_event') ? '"turnId":"782"' : '"turnId":782').replaceAll('"step":1', '"step":14')).join('');
      await writeFile(wirePath, Array.from({ length: 9 }, (_, turnId) => line({ type: 'turn.prompt', turnId,
        input: [{ type: 'text', text: filler }], origin: { kind: 'user' } })).join('') +
        line({ type: 'context.apply_compaction', history: [] }) + target);
      const transcript = { historyWireLocation: async (_session: string, agent: string) =>
        agent === 'missing' ? undefined : { workspaceId: 'ws', wirePath } } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(db, transcript);
      const archive = historyArchiveSeed(() => ({ accessor: { get: () => ({ get: async () => undefined }) } }) as unknown as Scope,
        () => transcript, () => nav)[0]![1] as IHistoryArchive;
      ix.set(HistoryArchiveToken, archive);
      ix.set(SessionContextToken, { sessionId: 's', workspaceId: 'ws' } as ISessionContext);
      ix.set(AgentScopeContextToken, { agentId: 'main' } as IAgentScopeContext);
      ix.set(SessionIndexToken, { get: async () => ({ workspaceId: 'ws' }) } as unknown as ISessionIndex);
      ix.set(WorkspaceToken, { get: async () => undefined } as unknown as IWorkspaceService);
      ix.set(IHistoryReadTool, new SyncDescriptor(HistoryReadTool));
      const tool = ix.get(IHistoryReadTool);
      const run = async (input: Record<string, unknown>) => {
        const execution = await tool.resolveExecution(input as never);
        if (!('execute' in execution)) throw new Error('not executable');
        const result = await execution.execute({ signal: new AbortController().signal, turnId: 0, toolCallId: 'c' });
        return { result, data: JSON.parse(result.output as string) };
      };
      const first = await run({ step_id: 't782.14', max_chars: 1000 });
      expect(first.result.isError).not.toBe(true);
      expect(first.data).toMatchObject({ status: 'partial', continuation: 'scan', has_more: true,
        coverage: { complete: false, gaps: ['navigation_building'] }, blocks: [] });
      expect(first.data.next_call.arguments).toEqual({ cursor: first.data.next_cursor });
      await appendFile(wirePath, line({ type: 'metadata', time: 2000 }));
      const recovered = await run(first.data.next_call.arguments);
      expect(recovered.data.status).toBe('ok');
      expect(recovered.data.blocks).toContainEqual(expect.objectContaining({ step_id: 't782.14', part: 'output', text: 'needle 𠮷 suffix' }));
      expect((await run({ step_id: 't782.999' })).data).toMatchObject({ status: 'no_match', has_more: false,
        coverage: { complete: true }, blocks: [] });
      expect((await run({ turn: 782, agent_id: 'missing' })).data).toMatchObject({ error: { code: 'source_missing', retryable: false,
        next_call: { tool: 'HistoryList', arguments: { kind: 'agents' } } } });
      await appendFile(wirePath, line({ type: 'context.clear' }));
      expect((await run({ step_id: 't782.14' })).data.status).toBe('no_match');
      await appendFile(wirePath, '{"type":');
      const pending = await run({ step_id: 't782.14' });
      expect(pending.result.isError).not.toBe(true);
      expect(pending.data).toMatchObject({ status: 'partial', has_more: false,
        coverage: { complete: false, gaps: ['source_pending'] } });
      const pendingSearch = await archive.search({ query: 'needle', mode: 'auto', workspaceId: 'ws',
        sessionId: 's', agentId: 'main', pageSize: 1 });
      expect(pendingSearch).toMatchObject({ items: [], hasMore: false, incomplete: 'source_pending',
        coverage: { complete: false, gaps: ['source_pending'] } });
      expect(pendingSearch.warning).toContain('unfinished record');
      await appendFile(wirePath, '"metadata"}\n');
      expect((await run({ step_id: 't782.14' })).data.status).toBe('no_match');
    } finally { await ix.dispose(); await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('continues newest List preparation instead of returning a prefix as the newest directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-list-preparation-'));
    const wirePath = join(dir, 'wire.jsonl');
    const db = HistoryNavigationDb.lazy(join(dir, 'navigation.sqlite'));
    try {
      const filler = 'f'.repeat(1 << 20);
      await writeFile(wirePath, Array.from({ length: 9 }, (_, turnId) => line({ type: 'turn.prompt', turnId,
        time: 1000 + turnId, input: [{ type: 'text', text: filler }], origin: { kind: 'user' } })).join(''));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(db, transcript);
      const request = { workspaceId: 'ws', sessionId: 's', agentId: 'main', kind: 'turns' as const,
        order: 'newest' as const, limit: 2, at: 1008 };
      const first = await nav.list(request);
      expect(first).toMatchObject({ status: 'partial', turns: [], nextCursor: expect.any(String),
        coverage: { complete: false, gaps: ['navigation_building'] } });
      await appendFile(wirePath, line({ type: 'metadata' }));
      const next = await nav.list({ ...request, cursor: first.nextCursor });
      expect(next.turns?.map((turn) => turn.turn)).toEqual([8, 7]);
      expect((await nav.readBlocks(next.turns![0]!.ref!, 1000)).status).toBe('ok');
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('keeps two serial live searches and their refs on fixed ranges while proof IO races real appends', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-search-proof-append-'));
    const wirePath = join(dir, 'wire.jsonl');
    const db = HistoryNavigationDb.lazy(join(dir, 'navigation.sqlite'));
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let nextTurn = 3;
    const prompt = (turnId: number) => line({ type: 'turn.prompt', turnId, time: 1000 + turnId,
      input: [{ type: 'text', text: `needle ${turnId} 汉😀` }], origin: { kind: 'user' } });
    await writeFile(wirePath, [0, 1, 2].map(prompt).join(''));
    const gate = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] !== wirePath) return handle;
      const read = handle.read.bind(handle);
      Object.assign(handle, { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position);
        await actual.appendFile(wirePath, prompt(nextTurn++));
        return result;
      } });
      return handle;
    });
    try {
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(db, transcript);
      const archive = historyArchiveSeed(() => ({ accessor: { get: () => ({ get: async () => undefined }) } }) as unknown as Scope,
        () => transcript, () => nav)[0]![1] as IHistoryArchive;
      const request = { query: 'needle', source: 'transcript' as const, mode: 'auto' as const, sort: 'newest' as const,
        workspaceId: 'ws', sessionId: 's', agentId: 'main', pageSize: 2 };
      const first = await archive.search(request);
      expect(first.items.map((hit) => hit.turn)).toEqual([2, 1]);
      const continued = await archive.search({ ...request, pageToken: first.pageToken });
      expect(continued.items.map((hit) => hit.turn)).toEqual([0]);
      expect(continued.hasMore).toBe(false);
      const capturedTurns = nextTurn;
      const second = await archive.search({ ...request, pageSize: 100 });
      expect(second.items.map((hit) => hit.turn)).toEqual(Array.from({ length: capturedTurns }, (_, index) => capturedTurns - 1 - index));
      expect(second.hasMore).toBe(false);
      gate.mockRestore();
      const fresh = await archive.search(request);
      expect(fresh.items[0]?.turn).toBe(nextTurn - 1);
      const page = await archive.search({ ...request, pageToken: fresh.pageToken });
      expect(page.items.map((hit) => hit.turn)).toEqual([nextTurn - 3, nextTurn - 4]);
      for (const hit of [...first.items, ...second.items, ...fresh.items, ...page.items]) {
        expect(await archive.readRef?.(hit.ref!)).toMatchObject({ status: 'ok', text: `needle ${hit.turn} 汉😀` });
      }
    } finally { gate.mockRestore(); await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('keeps rewrite recovery explicit when the accepted search prefix is truncated during proof IO', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-search-proof-truncate-'));
    const wirePath = join(dir, 'wire.jsonl');
    const db = HistoryNavigationDb.lazy(join(dir, 'navigation.sqlite'));
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    try {
      await writeFile(wirePath, lines.join(''));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(db, transcript);
      const archive = historyArchiveSeed(() => ({ accessor: { get: () => ({ get: async () => undefined }) } }) as unknown as Scope,
        () => transcript, () => nav)[0]![1] as IHistoryArchive;
      const request = { query: 'needle', mode: 'auto' as const, sort: 'newest' as const,
        workspaceId: 'ws', sessionId: 's', agentId: 'main', pageSize: 1 };
      const first = await archive.search(request);
      expect(first.items).toHaveLength(1);
      let changed = false;
      const gate = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        if (args[0] !== wirePath) return handle;
        const read = handle.read.bind(handle);
        Object.assign(handle, { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await read(buffer, offset, length, position);
          if (!changed) { changed = true; writeFileSync(wirePath, lines[0]!); }
          return result;
        } });
        return handle;
      });
      try { await expect(archive.search(request)).rejects.toThrow('history_source_changed'); }
      finally { gate.mockRestore(); }
      expect(await archive.readRef?.(first.items[0]!.ref!)).toMatchObject({ status: 'stale_ref' });
      expect(await archive.search(request)).toMatchObject({ items: [], hasMore: false });
      await writeFile(wirePath, lines.map((record) => record.replace('needle', 'repaired')).join(''));
      const recovered = await archive.search({ ...request, query: 'repaired' });
      expect(recovered.items).toHaveLength(1);
      expect(await archive.readRef?.(recovered.items[0]!.ref!)).toMatchObject({ status: 'ok', text: 'repaired 𠮷 suffix' });
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('pins Search preparation and query pages despite append during and between calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-search-self-append-'));
    const wirePath = join(dir, 'wire.jsonl');
    const db = HistoryNavigationDb.lazy(join(dir, 'navigation.sqlite'));
    try {
      const filler = 'f'.repeat(1 << 20);
      await writeFile(wirePath, Array.from({ length: 9 }, (_, turnId) => line({ type: 'turn.prompt', turnId,
        time: 1000 + turnId, input: [{ type: 'text', text: `needle ${filler}` }], origin: { kind: 'user' } })).join(''));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(db, transcript);
      const database = await db.ready();
      const commit = database.commitSlice.bind(database);
      let appended = false;
      const spy = vi.spyOn(database, 'commitSlice').mockImplementation((...args) => {
        commit(...args);
        if (!appended) { appended = true; appendFileSync(wirePath, line({ type: 'metadata' })); }
      });
      const archive = historyArchiveSeed(() => ({ accessor: { get: () => ({ get: async () => undefined }) } }) as unknown as Scope,
        () => transcript, () => nav)[0]![1] as IHistoryArchive;
      const request = { query: 'needle', mode: 'auto' as const, sort: 'newest' as const,
        workspaceId: 'ws', sessionId: 's', agentId: 'main', pageSize: 2 };
      const first = await archive.search(request);
      expect(first).toMatchObject({ items: [], hasMore: true, coverage: { gaps: ['navigation_building'] } });
      spy.mockRestore();
      const turns: number[] = [];
      let pageToken = first.pageToken;
      let pages = 0;
      while (pageToken !== undefined) {
        if (++pages > 10) throw new Error('Search preparation did not terminate');
        await appendFile(wirePath, line({ type: 'metadata', time: 2000 + pages }));
        const page = await archive.search({ ...request, pageToken });
        turns.push(...page.items.map((hit) => hit.turn!));
        for (const hit of page.items) expect((await archive.readRef?.(hit.ref!))?.status).toBe('ok');
        pageToken = page.pageToken;
      }
      expect(turns).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0]);
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
