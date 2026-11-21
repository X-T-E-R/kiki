import { describe, expect, it, vi } from 'vitest';
import type { AgentTranscriptSnapshot } from '@kiki/transcript';
import { IAtomicDocumentStore, IFileSystemStorageService, ISessionIndex, ISessionManager, type Scope, type SessionMeta } from '@kiki/agent-core-v2';
import {
  decodeHistoryDirectoryCursor,
  type IHistoryDirectory,
} from '@kiki/agent-core-v2/agent/tools/history/historyListTool';
import { historyDirectorySeed, type HistoryNavigationAdapter } from '../src/services/history/historyDirectory';

const turn = (ordinal: number, prompt: string, startedAt: string) => ({
  kind: 'turn' as const,
  turnId: `t${ordinal}`,
  ordinal,
  state: 'completed' as const,
  origin: { kind: 'user' as const },
  prompt,
  startedAt,
  steps: [{
    kind: 'step' as const,
    stepId: `t${ordinal}.0`,
    turnId: `t${ordinal}`,
    ordinal: 0,
    state: 'completed' as const,
    frames: [
      { kind: 'text' as const, frameId: `t${ordinal}.0.f0`, role: 'assistant' as const, text: `answer ${ordinal}` },
      { kind: 'tool' as const, frameId: `t${ordinal}.0.f1`, toolCallId: `call-${ordinal}`, name: 'Read', state: 'done' as const },
    ],
  }],
});

const snapshot: AgentTranscriptSnapshot = {
  items: [turn(1, 'first prompt', '2026-01-01T00:00:00.000Z'), turn(2, 'second prompt', '2026-01-02T00:00:00.000Z')],
  tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {},
  hasMoreOlder: false,
};

function fixture() {
  const bounded = vi.fn(async () => ({ snapshot, bytesRead: 432, recordsRead: 12, complete: true }));
  const transcript = {
    forSessionLive: vi.fn(() => undefined),
    whenReady: vi.fn(async () => undefined),
    readColdSnapshotBounded: bounded,
  };
  return { transcript, bounded };
}

function directory(
  transcript: ReturnType<typeof fixture>['transcript'],
  navigation?: HistoryNavigationAdapter,
  core?: Scope,
): IHistoryDirectory {
  return historyDirectorySeed(() => core!, () => transcript, navigation === undefined ? undefined : () => navigation)[0]![1] as IHistoryDirectory;
}

describe('history directory', () => {
  it('lists bounded cold turns and marks the result partial instead of claiming full coverage', async () => {
    const { transcript, bounded } = fixture();
    const result = await directory(transcript).list({
      workspaceId: 'ws', sessionId: 'session', kind: 'turns', agentId: 'main', order: 'newest', limit: 1,
    });
    expect(bounded).toHaveBeenCalledWith('session', 'main', expect.objectContaining({ maxBytes: 2 << 20 }), undefined);
    expect(result.status).toBe('partial');
    expect(result.coverage).toMatchObject({ complete: false, domain: 'directory', scanned: { bytes: 432, records: 12 } });
    expect(result.turns).toEqual([expect.objectContaining({ turn: 2, promptExcerpt: 'second prompt', answerExcerpt: 'answer 2', stepCount: 1, toolCount: 1 })]);
    expect(result.nextCursor).toBeDefined();
  });

  it('uses a turn keyset cursor without repeating the previous entry', async () => {
    const { transcript } = fixture();
    const source = directory(transcript);
    const first = await source.list({
      workspaceId: 'ws', sessionId: 'session', kind: 'turns', agentId: 'main', order: 'newest', limit: 1,
    });
    const second = await source.list({
      workspaceId: 'ws', sessionId: 'session', kind: 'turns', agentId: 'main', order: 'newest', limit: 1,
      cursor: first.nextCursor,
    });
    expect(decodeHistoryDirectoryCursor(first.nextCursor!).afterTurn).toBe(2);
    expect(second.turns).toEqual([expect.objectContaining({ turn: 1 })]);
    expect(second.nextCursor).toBeUndefined();
  });

  it('lists a cold roster as best effort and includes the canonical main agent', async () => {
    const { transcript, bounded } = fixture();
    const resume = vi.fn();
    const storedEnd = Date.parse('2026-01-02T00:00:00.000Z');
    const metadata: SessionMeta = {
      id: 'session', createdAt: 0, updatedAt: storedEnd, archived: false,
      agents: {
        worker: { type: 'sub', status: 'completed', completedAt: storedEnd },
        idle: { labels: { branch: 'true' }, branchTurn: { startedAt: 1, endedAt: storedEnd, outcome: 'completed' } },
        failed: { labels: { branch: 'true' }, branchTurn: { startedAt: 1, endedAt: storedEnd, outcome: 'failed' } },
        interrupted: { labels: { branch: 'true' }, branchTurn: { startedAt: 1, endedAt: storedEnd, outcome: 'cancelled' } },
        merged: { labels: { branch: 'true', branchSealed: 'true' }, completedAt: storedEnd },
      },
    };
    const get = vi.fn(async () => metadata);
    const services = new Map<unknown, unknown>([
      [ISessionManager, { get: () => undefined, resume }],
      [ISessionIndex, { get: async () => ({ workspaceId: 'ws' }) }],
      [IFileSystemStorageService, {}],
      [IAtomicDocumentStore, { get }],
    ]);
    const core = { accessor: { get: (token: unknown) => services.get(token) } } as Scope;
    const result = await directory(transcript, undefined, core).list({
      workspaceId: 'ws', sessionId: 'session', kind: 'agents', order: 'oldest', limit: 10,
    });
    expect(get).toHaveBeenCalledExactlyOnceWith('sessions/ws/session', 'state.json');
    expect(resume).not.toHaveBeenCalled();
    expect(transcript.forSessionLive).not.toHaveBeenCalled();
    expect(bounded).not.toHaveBeenCalled();
    expect(result.status).toBe('partial');
    expect(result.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'main', kind: 'main', status: 'idle' }),
      expect.objectContaining({ agentId: 'worker', kind: 'subagent', status: 'completed' }),
      expect.objectContaining({ agentId: 'idle', kind: 'branch', sealed: false, status: 'idle', lastTurnReason: 'completed' }),
      expect.objectContaining({ agentId: 'failed', kind: 'branch', sealed: false, status: 'failed', lastTurnReason: 'failed', updatedAt: '2026-01-02T00:00:00.000Z' }),
      expect.objectContaining({ agentId: 'interrupted', kind: 'branch', sealed: false, status: 'interrupted', lastTurnReason: 'cancelled' }),
      expect.objectContaining({ agentId: 'merged', kind: 'branch', sealed: true, status: 'merged' }),
    ]));
    expect(result.coverage.gaps).toContain('roster_best_effort');
  });

  it('delegates to a navigation adapter when one is available', async () => {
    const { transcript } = fixture();
    const navigation: HistoryNavigationAdapter = {
      list: vi.fn(async (request) => ({
        status: 'ok' as const,
        target: { workspaceId: request.workspaceId, sessionId: request.sessionId, agentId: request.agentId },
        source: 'navigation' as const,
        coverage: { complete: true, domain: 'directory' as const },
        turns: [{ ref: 'h1_navigation', turn: 2, stepCount: 1, toolCount: 0 }],
      })),
    };
    const result = await directory(transcript, navigation).list({
      workspaceId: 'ws', sessionId: 'session', kind: 'turns', agentId: 'main', order: 'newest', limit: 10,
    });
    expect(navigation.list).toHaveBeenCalledOnce();
    expect(result.source).toBe('navigation');
    expect(result.turns?.[0]?.ref).toBe('h1_navigation');
  });
});
