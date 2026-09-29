import { describe, expect, it, vi } from 'vitest';
import type { HistorySearchPage, Scope } from '@kiki/agent-core-v2';
import type { TranscriptService } from '../src/services/transcript/transcriptService';
import { historyArchiveSeed } from '../src/services/historyArchive';

function fixture(live: boolean, unavailable = false) {
  const turn = {
    kind: 'turn', ordinal: 4, state: 'completed', origin: { kind: 'user' },
    prompt: '用户压缩前的原话', steps: [
      { stepId: 't4.1', frames: [{ kind: 'text', role: 'assistant', text: '旧回答' }] },
      { stepId: 't4.2', frames: [{ kind: 'tool', name: 'Read', input: { path: 'old.txt' }, output: '工具原始结果' }] },
    ],
  };
  const readColdSnapshotBounded = vi.fn(async () => ({
    snapshot: { items: [turn] }, bytesRead: 1234, recordsRead: 17, complete: true,
  }));
  const transcript = {
    forSessionLive: vi.fn(() => live ? {
      getAgent: () => ({ snapshot: () => ({ items: [] }) }),
    } : undefined),
    whenReady: vi.fn(async () => {}),
    ensureAgentHistory: vi.fn(async () => {}),
    readColdSnapshot: vi.fn(async () => ({ items: [turn] })),
    readColdSnapshotBounded,
  } as unknown as TranscriptService;
  const search = vi.fn(async () => ({
    items: [], hasMore: false, indexState: { state: unavailable ? 'building' : 'ready' },
    source: 'index', unavailable: unavailable || undefined,
  }));
  const core = { accessor: { get: () => ({ search }) } } as unknown as Scope;
  const seed = historyArchiveSeed(() => core, () => transcript);
  const archive = seed[0]![1] as ReturnType<typeof historyArchiveSeed>[number][1] & {
    readTurn(sessionId: string, agentId: string, turn: number, stepId?: string): Promise<string | undefined>;
    search(query: unknown): Promise<unknown>;
  };
  return { archive, transcript, search, readColdSnapshotBounded };
}

describe('history archive', () => {
  it('recovers the exact user text and tool output from persisted pre-compaction transcript', async () => {
    const { archive, transcript, search } = fixture(true);
    const turn = await archive.readTurn('current', 'main', 4);
    expect(JSON.parse(turn!)).toMatchObject({ user: '用户压缩前的原话', steps: [
      { step_id: 't4.1', frames: [{ text: '旧回答' }] },
      { step_id: 't4.2', frames: [{ role: 'tool', output: '工具原始结果' }] },
    ] });
    expect(transcript.readColdSnapshot).toHaveBeenCalledWith('current', 'main');
    const step = JSON.parse((await archive.readTurn('current', 'main', 4, 't4.2'))!);
    expect(step.steps).toHaveLength(1);
    expect(step.steps[0].frames[0].output).toBe('工具原始结果');
    expect(await archive.readTurn('current', 'main', 4, 't4.9')).toBeUndefined();
    expect(search).not.toHaveBeenCalled();
  });

  it('delegates workspace-constrained search to the existing global index', async () => {
    const { archive, search } = fixture(false);
    await archive.search({ query: 'needle', workspaceId: 'ws-a', sessionId: 'old', pageSize: 8 });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-a', indexOnly: true, container: { sessionId: 'old', agentId: undefined }, pageSize: 8,
    }));
    await expect(archive.readTurn('old', '../outside', 0)).rejects.toThrow('Invalid agent id');
  });

  it('reports an unavailable index and searches only the bounded current-session wire', async () => {
    const { archive, readColdSnapshotBounded, search } = fixture(false, true);
    const page = await archive.search({
      query: '原话', workspaceId: 'ws-a', pageSize: 8,
      fallbackSessionId: 'current', fallbackAgentId: 'main',
    }) as HistorySearchPage;
    expect(search).toHaveBeenCalledOnce();
    expect(readColdSnapshotBounded).toHaveBeenCalledWith(
      'current', 'main', expect.objectContaining({ maxBytes: 2 << 20, maxRecords: 10_000 }),
    );
    expect(page.warning).toBe('search index unavailable');
    expect(page.source).toBe('fallback');
    expect(page.items).toEqual([expect.objectContaining({
      sessionId: 'current', agentId: 'main', role: 'user', turn: 4,
    })]);
    expect(page.fallback).toMatchObject({
      scope: 'current_session_wire', maxBytes: 2 << 20, maxRecords: 10_000,
      bytesRead: 1234, recordsRead: 17, truncated: false,
    });
    expect(JSON.parse((await archive.readTurn('current', 'main', 4))!).user).toBe('用户压缩前的原话');
    expect(search).toHaveBeenCalledOnce();
  });
});
