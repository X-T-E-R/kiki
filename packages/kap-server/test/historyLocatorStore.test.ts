import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { IQueryStore, WriteOp, IHistoryArchive, Scope } from '@kiki/agent-core-v2';
import { HistoryReadTool } from '@kiki/agent-core-v2/agent/tools/history/historyTools';
import type { ISessionContext } from '@kiki/agent-core-v2/session/sessionContext/sessionContext';
import type { IAgentScopeContext } from '@kiki/agent-core-v2/agent/scopeContext/scopeContext';
import type { ISessionIndex } from '@kiki/agent-core-v2/app/sessionIndex/sessionIndex';
import type { IWorkspaceService } from '@kiki/agent-core-v2/app/workspace/workspace';

import { HistoryLocatorStore, HISTORY_NAV_COLLECTION } from '../src/services/history/historyLocatorStore';
import { historyArchiveSeed } from '../src/services/historyArchive';
import type { TranscriptService } from '../src/services/transcript/transcriptService';

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

  it('returns a bounded, non-repeating partial result when one wire line exceeds the scan page', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-'));
    const wirePath = join(dir, 'wire.jsonl');
    try {
      await writeFile(wirePath, line({ type: 'turn.prompt', turnId: 0, promptId: 'oversize',
        input: [{ type: 'text', text: 'X'.repeat((8 << 20) + 1024) }], time: 1000 }));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(memoryStore(), transcript);
      const archive = historyArchiveSeed(() => ({ accessor: { get: () => undefined } }) as unknown as Scope,
        () => transcript, () => nav)[0]![1] as IHistoryArchive;
      const page = await archive.search({ query: 'needle', mode: 'auto', workspaceId: 'ws',
        sessionId: 's', agentId: 'main', pageSize: 5 });
      expect(page).toMatchObject({ items: [], hasMore: false,
        coverage: { complete: false, scanned: { records: 0 } } });
      expect(page.pageToken).toBeUndefined();
      expect(page.incomplete).toBeTruthy();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('continues a fixed-watermark scan past 8 MiB to a deep-tail source ref', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-nav-'));
    const wirePath = join(dir, 'wire.jsonl');
    try {
      const filler = 'f'.repeat(1 << 20);
      await writeFile(wirePath, Array.from({ length: 9 }, (_unused, turnId) =>
        line({ type: 'turn.prompt', turnId, promptId: `p-${turnId}`, time: 1000 + turnId,
          input: [{ type: 'text', text: `${turnId === 3 || turnId === 8 ? 'needle ' : ''}${filler}` }] })).join(''));
      const transcript = { historyWireLocation: async () => ({ workspaceId: 'ws', wirePath }) } as unknown as TranscriptService;
      const nav = new HistoryLocatorStore(memoryStore(), transcript);
      const archive = historyArchiveSeed(() => ({ accessor: { get: () => undefined } }) as unknown as Scope,
        () => transcript, () => nav)[0]![1] as IHistoryArchive;
      const request = { query: 'needle', mode: 'auto' as const, workspaceId: 'ws',
        sessionId: 's', agentId: 'main', pageSize: 1 };
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(archive.search({ ...request, signal: cancelled.signal })).rejects.toThrow();
      const first = await archive.search(request);
      expect(first).toMatchObject({ items: [{ turn: 3, ref: expect.any(String) }],
        continuation: 'scan', hasMore: true, coverage: { complete: false } });
      const second = await archive.search({ ...request, pageToken: first.pageToken });
      expect(second).toMatchObject({ items: [{ turn: 8, ref: expect.any(String) }],
        hasMore: false, coverage: { complete: true } });
      expect(second.coverage?.scanned?.bytes).toBeGreaterThan(0);
      expect((await archive.readRef?.(second.items[0]!.ref!))).toMatchObject({
        status: 'ok', text: expect.stringContaining('needle'), turn: 8,
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
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
      const archive = historyArchiveSeed(() => ({ accessor: { get: () => undefined } }) as unknown as Scope,
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
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
