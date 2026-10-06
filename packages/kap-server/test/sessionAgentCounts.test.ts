import { describe, expect, it, vi } from 'vitest';
import { IAtomicDocumentStore, ISessionIndex, ISessionManager, IWorkspaceService, type AgentMeta, type Scope } from '@kiki/agent-core-v2';
import { sessionSnapshotResponseSchema, type SnapshotSubagent } from '@kiki/protocol';
import { assembleBrowseSnapshot } from '../src/routes/snapshot';
import { sessionAgentCounts } from '../src/routes/sessionAgentCounts';
import { sessionAgentRoster } from '../src/routes/sessionAgentRoster';
import type { SessionEventBroadcaster } from '../src/transport/ws/v1/sessionEventBroadcaster';

const row = (id: string, status: SnapshotSubagent['status'], live = true): SnapshotSubagent => ({
  id, agent_id: id, session_id: 'fixture-session', kind: 'subagent', description: id,
  created_at: new Date(1).toISOString(), status, live,
});

describe('session agent metadata counts', () => {
  it('retains 300 cold agents outside the bounded roster without loading any agent body', async () => {
    const agents: Record<string, AgentMeta> = { main: { type: 'main' } };
    for (let i = 0; i < 300; i += 1) agents[`child-${i}`] = {
      type: 'sub', parentAgentId: 'main', status: i < 280 ? 'completed' : i < 290 ? 'failed' : undefined,
      resultSummary: 'historical result'.repeat(100),
    };
    const meta = { id: 'fixture-session', createdAt: 1, updatedAt: 2, archived: false, agents };
    const readMetadata = vi.fn(async () => meta);
    const manager = { get: vi.fn(() => undefined) };
    const services = new Map<unknown, unknown>([
      [ISessionManager, manager], [ISessionIndex, { get: async () => ({ ...meta, workspaceId: 'wd_fixture_000000000000' }) }],
      [IAtomicDocumentStore, { get: readMetadata }], [IWorkspaceService, { get: async () => ({ root: 'C:/fixture' }) }],
    ]);
    const core = { accessor: { get: (id: unknown) => {
      if (!services.has(id)) throw new Error('Unexpected service/body load');
      return services.get(id);
    } } } as unknown as Scope;
    const broadcaster = { getCursor: async () => ({ seq: 1, epoch: 'fixture-epoch' }) } as unknown as SessionEventBroadcaster;
    const snapshot = await assembleBrowseSnapshot(core, broadcaster, 'fixture-session');
    expect(snapshot.subagents!.length).toBeLessThan(300);
    expect(snapshot.agent_counts).toEqual({ total: 301, subagents: 300, completed: 280, failed: 10, cancelled: 0, active: 0, idle: 0, unknown: 10 });
    const parsed = sessionSnapshotResponseSchema.safeParse(snapshot);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(readMetadata).toHaveBeenCalledTimes(1);
    expect(snapshot.messages.items).toEqual([]);
  });

  it('deduplicates a new live child, completion and disposal while retaining historical registration', () => {
    const agents = { main: {}, old: { status: 'completed' as const }, cold: {} };
    expect(sessionAgentCounts(agents, [row('new', 'running')])).toEqual({ total: 4, subagents: 3, completed: 1, failed: 0, cancelled: 0, active: 1, idle: 0, unknown: 1 });
    expect(sessionAgentCounts({ ...agents, new: { status: 'completed' } }, [row('new', 'completed', false)]))
      .toEqual({ total: 4, subagents: 3, completed: 2, failed: 0, cancelled: 0, active: 0, idle: 0, unknown: 1 });
    expect(sessionAgentCounts(agents, [row('new', 'running', false)]).active).toBe(0);
    expect(sessionAgentCounts(agents, [{ ...row('new', 'running'), refreshing: true }]).active).toBe(0);
    expect(sessionAgentCounts({ main: {}, cold: {} }, []).total).toBe(2);
  });
});


describe('lightweight metadata roster', () => {
  it('unions every registered identity with the smaller replay roster and records real name/state provenance', () => {
    const agents: Record<string, AgentMeta> = { main: {} };
    for (let index = 0; index < 706; index += 1) agents[`child-${index}`] = {
      type: 'sub', status: index < 704 ? 'completed' : undefined, completedAt: index < 704 ? 10 : undefined,
      displayName: 'researcher', userLabel: `Investigation ${index}`, model: 'fixture/model',
    };
    const meta = { id: 'fixture-session', createdAt: 1, updatedAt: 10, archived: false, agents };
    const roster = sessionAgentRoster(meta.id, meta, Array.from({ length: 523 }, (_, index) => row(`child-${index}`, 'running', false)));
    expect(roster).toHaveLength(706);
    expect(roster[633]).toMatchObject({ label: 'Investigation 633', name_source: 'user_label', activity_status: 'completed', status_source: 'metadata', live: false });
    expect(roster[705]).toMatchObject({ label: 'Investigation 705', activity_status: 'unknown', status_source: 'metadata', live: false });
    expect(sessionAgentCounts(agents, roster)).toEqual({ total: 707, subagents: 706, completed: 704, failed: 0, cancelled: 0, active: 0, idle: 0, unknown: 2 });
  });

  it('distinguishes an idle live scope from an active turn and does not revive a missing phase or a completed old generation', () => {
    const agents = { main: {}, idle: { displayName: 'worker' }, cold: { labels: { collaborationTaskName: 'Recovered task' } }, resumed: { status: 'completed' as const, completedAt: 10 }, finished: {} };
    const meta = { id: 'fixture-session', createdAt: 1, updatedAt: 10, archived: false, agents };
    const turn = { turnId: 2, origin: { kind: 'user' as const }, phase: 'running' as const, step: 1, ending: false, pendingApprovals: [], activeToolCalls: [], since: 20 };
    const roster = sessionAgentRoster(meta.id, meta, [
      { ...row('resumed', 'running'), started_at: new Date(2).toISOString(), completed_at: new Date(10).toISOString(), subagent_phase: 'working' },
      { ...row('cold', 'running'), live: undefined, subagent_phase: 'working' },
      { ...row('finished', 'running'), started_at: new Date(20).toISOString(), subagent_phase: 'working' },
    ], new Map([
      ['idle', { lifecycle: 'ready', background: [] }], ['resumed', { lifecycle: 'ready', background: [], turn }],
      ['finished', { lifecycle: 'ready', background: [], lastTurn: { turnId: 3, reason: 'completed', at: 30 } }],
    ]));
    expect(roster.find((entry) => entry.id === 'idle')).toMatchObject({ activity_status: 'idle', status_source: 'runtime' });
    expect(roster.find((entry) => entry.id === 'cold')).toMatchObject({ label: 'Recovered task', name_source: 'collaboration_task', activity_status: 'unknown', status_source: 'metadata' });
    expect(roster.find((entry) => entry.id === 'resumed')).toMatchObject({ status: 'running', activity_status: 'running', status_source: 'runtime', started_at: new Date(20).toISOString(), completed_at: undefined });
    expect(roster.find((entry) => entry.id === 'finished')).toMatchObject({ status: 'completed', activity_status: 'completed', completed_at: new Date(30).toISOString(), status_source: 'runtime' });
    expect(sessionAgentCounts(agents, roster)).toEqual({ total: 5, subagents: 4, completed: 1, failed: 0, cancelled: 0, active: 1, idle: 1, unknown: 1 });
  });
});
