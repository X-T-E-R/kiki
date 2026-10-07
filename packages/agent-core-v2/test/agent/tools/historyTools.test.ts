import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';

import {
  HistoryReadTool,
  HistorySearchTool,
  IHistoryArchive,
  IHistorySearchTool,
  IHistoryReadTool,
} from '../../../src/agent/tools/history/historyTools';
import { SyncDescriptor } from '../../../src/_base/di/descriptors';
import { TestInstantiationService } from '../../../src/_base/di/test';
import { ISessionContext as SessionContextToken } from '../../../src/session/sessionContext/sessionContext';
import { IAgentScopeContext as AgentScopeContextToken } from '../../../src/agent/scopeContext/scopeContext';
import { ISessionIndex as SessionIndexToken } from '../../../src/app/sessionIndex/sessionIndex';
import { IWorkspaceService as WorkspaceToken } from '../../../src/app/workspace/workspace';
import { toolGroupForName } from '../../../src/agent/toolRegistry/toolGroups';
import { isToolActive } from '../../../src/agent/toolPolicy/evaluate';
import type { ISessionContext } from '../../../src/session/sessionContext/sessionContext';
import type { IAgentScopeContext } from '../../../src/agent/scopeContext/scopeContext';
import type { ISessionIndex } from '../../../src/app/sessionIndex/sessionIndex';
import type { IWorkspaceService } from '../../../src/app/workspace/workspace';

const caller = { agentId: 'main' } as IAgentScopeContext;
const session = { sessionId: 'current', workspaceId: 'ws-a' } as ISessionContext;
const workspaces = {
  get: vi.fn(async (id: string) => id === 'ws-b' ? { root: '/external/project' } : undefined),
} as unknown as IWorkspaceService;
const sessions = {
  get: vi.fn(async (id: string) => ({ id, workspaceId: id === 'foreign' ? 'ws-b' : 'ws-a' })),
} as unknown as ISessionIndex;

function archive(text = '{"user":"原话","steps":[]}'): IHistoryArchive {
  return {
    _serviceBrand: undefined,
    search: vi.fn(async () => ({
      items: [{ sessionId: 'older', agentId: 'main', role: 'user' as const, turn: 3, snippet: '原话' },
        { sessionId: 'older', agentId: '', role: 'title' as const, snippet: 'title' }],
      hasMore: false, indexState: { state: 'ready' }, source: 'index' as const,
    })),
    readTurn: vi.fn(async () => text),
  };
}

interface HistoryToolData {
  readonly hits?: unknown;
  readonly text?: string;
  readonly has_more?: boolean;
  readonly next_cursor?: string;
  readonly warning?: string;
  readonly expand_hint?: { readonly next_call: { readonly arguments: Record<string, unknown> } };
  readonly fallback?: {
    readonly maxBytes: number;
    readonly maxRecords: number;
    readonly truncated: boolean;
  };
}

async function run(tool: Pick<HistorySearchTool | HistoryReadTool, 'resolveExecution'>, input: Record<string, unknown>) {
  const execution = await tool.resolveExecution(input as never);
  if (!('execute' in execution)) throw new Error('Expected executable tool');
  const result = await execution.execute({ signal: new AbortController().signal, turnId: 1, toolCallId: 'c' });
  return { execution, result, data: result.isError ? {} as HistoryToolData : JSON.parse(result.output as string) as HistoryToolData };
}

describe('history tools', () => {
  it('routes peer scope to mailbox-only search, preserves message locators and binds cursor permissions', async () => {
    const ix = new TestInstantiationService();
    const source = archive();
    const communication = { messageId: 'handoff-one', source: { kind: 'thread' as const, thread: {
      ref: { hostId: 'host', workspaceId: 'ws-a', sessionId: 'sender' }, deleted: false, archived: false,
    } }, target: { ref: { hostId: 'host', workspaceId: 'ws-a', sessionId: 'receiver' }, deleted: false, archived: false },
      acceptedAt: 100, targetSeq: 2, delivery: 'delivered' as const };
    source.search = vi.fn(async () => ({ items: [{ sessionId: 'receiver', agentId: 'main', role: 'user' as const,
      snippet: 'handoff', communication }], hasMore: true, pageToken: 'peer-page',
      source: 'mailbox' as const, indexState: { state: 'ready' }, coverage: { complete: true, domain: 'full_text' as const } }));
    ix.set(IHistoryArchive, source);
    ix.set(SessionContextToken, session);
    ix.set(AgentScopeContextToken, caller);
    ix.set(SessionIndexToken, sessions);
    ix.set(WorkspaceToken, workspaces);
    ix.set(IHistorySearchTool, new SyncDescriptor(HistorySearchTool));
    const tool = ix.get(IHistorySearchTool);
    const execute = async (input: Record<string, unknown>) => {
      const execution = await tool.resolveExecution(input as never);
      if (!('execute' in execution)) throw new Error('Expected execute');
      const result = await execution.execute({ signal: new AbortController().signal, turnId: 1, toolCallId: 'peer-search' });
      return { result, data: JSON.parse(result.output as string) };
    };
    try {
      const first = await execute({ query: 'handoff', scope: 'peer', workspace_id: 'ws-b' });
      expect(source.search).toHaveBeenCalledWith(expect.objectContaining({ peer: true, workspaceId: 'ws-b', sessionId: undefined, agentId: 'main' }));
      expect(first.data).toMatchObject({ scope_used: 'peer', source: 'mailbox', hits: [{ communication }] });
      expect(first.data).not.toHaveProperty('expand_hint');
      await execute({ cursor: first.data.next_cursor });
      expect(source.search).toHaveBeenLastCalledWith(expect.objectContaining({ peer: true, workspaceId: 'ws-b', pageToken: 'peer-page' }));
      const conflicting = await execute({ cursor: first.data.next_cursor, workspace_id: 'ws-a' });
      expect(conflicting.result.isError).toBe(true);
      await expect(tool.resolveExecution({ query: 'handoff', scope: 'peer', include_subagents: true })).rejects.toThrow('peer searches');
      await expect(tool.resolveExecution({ query: 'handoff', scope: 'peer', sort: 'oldest' })).rejects.toThrow('peer searches');
    } finally { await ix.dispose(); }
  });
  it('uses the existing profile tool-group gate', () => {
    expect(toolGroupForName('HistorySearch')).toBe('history');
    expect(toolGroupForName('HistoryRead')).toBe('history');
    expect(isToolActive({ disabledToolGroups: ['history'] }, 'HistoryRead')).toBe(false);
    expect(isToolActive({ disabledToolGroups: ['history'] }, 'HistorySearch')).toBe(false);
  });

  it('defaults to this session, this agent and auto; expands scope only explicitly', async () => {
    const source = archive();
    const tool = new HistorySearchTool(source, session, workspaces, caller, sessions);
    const validate = new Ajv({ strict: false }).compile(tool.parameters);
    expect(validate({ query: '原话' })).toBe(true);
    expect(validate({ cursor: 'opaque' })).toBe(true);
    expect(validate({})).toBe(false);
    const { data } = await run(tool, { query: '原话' });
    expect(source.search).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-a', sessionId: 'current', agentId: 'main', mode: 'auto', pageSize: 5,
    }));
    expect(data.hits).toEqual([{ session_id: 'older', agent_id: 'main', role: 'user', turn: 3, snippet: '原话' }]);
    expect(data).toMatchObject({ scope_used: 'session', mode_used: 'auto', expand_hint: {
      next_call: { tool: 'HistorySearch', arguments: { query: '原话', mode: 'terms', scope: 'workspace' } },
    } });
    const expand = data.expand_hint?.next_call.arguments;
    expect(expand).toBeDefined();
    const widened = await run(tool, expand ?? {});
    expect(widened.data).toMatchObject({ scope_used: 'workspace', mode_used: 'terms' });
    expect(source.search).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'ws-a', sessionId: undefined, mode: 'terms',
    }));
    const narrowed = await run(tool, { query: '原话', session_id: 'older', source: 'transcript', role: 'tool' });
    const wider = await run(tool, narrowed.data.expand_hint?.next_call.arguments ?? {});
    expect(wider.data).toMatchObject({ scope_used: 'workspace', mode_used: 'terms' });
    expect(source.search).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: undefined, source: undefined, role: 'tool', mode: 'terms',
    }));
    const across = await run(tool, { query: '原话', scope: 'workspace', mode: 'literal' });
    expect(across.data).toMatchObject({ scope_used: 'workspace', mode_used: 'literal' });
    expect(across.data).not.toHaveProperty('expand_hint');
    expect(source.search).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'ws-a', sessionId: undefined, mode: 'literal',
    }));
  });

  it('continues a bound Search cursor alone and rejects conflicting filters', async () => {
    const source = archive();
    source.search = vi.fn(async () => ({ items: [], hasMore: true, pageToken: 'backend-page',
      source: 'index' as const, indexState: { state: 'ready' } }));
    const tool = new HistorySearchTool(source, session, workspaces, caller, sessions);
    const first = await run(tool, { query: 'needle', scope: 'workspace', mode: 'literal', limit: 2 });
    const next = await run(tool, { cursor: first.data.next_cursor });
    expect(next.result.isError).not.toBe(true);
    expect(source.search).toHaveBeenLastCalledWith(expect.objectContaining({
      query: 'needle', sessionId: undefined, mode: 'literal', pageSize: 2, pageToken: 'backend-page',
    }));
    const wrong = await run(tool, { cursor: first.data.next_cursor, mode: 'terms' });
    expect(wrong.result.isError).toBe(true);
    expect(JSON.parse(wrong.result.output as string)).toMatchObject({ error: { code: 'cursor_mismatch' } });
  });

  it('returns a cursor-free recovery call after a captured source range changes', async () => {
    const ix = new TestInstantiationService();
    const source = archive();
    const search = vi.fn(source.search);
    source.search = search;
    ix.set(IHistoryArchive, source);
    ix.set(SessionContextToken, session);
    ix.set(AgentScopeContextToken, caller);
    ix.set(SessionIndexToken, sessions);
    ix.set(WorkspaceToken, workspaces);
    ix.set(IHistorySearchTool, new SyncDescriptor(HistorySearchTool));
    try {
      const tool = ix.get(IHistorySearchTool);
      const input = { query: 'needle', source: 'transcript', session_id: 'older' };
      search.mockRejectedValueOnce(new Error('history_source_changed'));
      const failed = await run(tool, input);
      expect(failed.result.isError).toBe(true);
      const data = JSON.parse(failed.result.output as string);
      expect(data).toMatchObject({ target: { session_id: 'older', agent_id: 'main' }, error: {
        code: 'source_changed', message: 'The transcript was replaced or its captured range changed; restart the query without cursor.',
        retryable: true, next_call: { tool: 'HistorySearch', arguments: input },
      } });
      expect(data.error.next_call.arguments).not.toHaveProperty('cursor');
      expect((await run(tool, data.error.next_call.arguments)).result.isError).not.toBe(true);
    } finally { await ix.dispose(); }
  });

  it('surfaces an unavailable index alongside bounded fallback metadata', async () => {
    const source = archive();
    source.search = vi.fn(async () => ({
      items: [{ sessionId: 'current', agentId: 'main', role: 'user' as const, turn: 2, snippet: '原话' }],
      hasMore: false,
      indexState: { state: 'unavailable', stale: true, degraded: 'search index unavailable' },
      warning: 'search index unavailable',
      fallback: {
        reason: 'search index unavailable', scope: 'current_session_wire',
        maxBytes: 2 << 20, maxRecords: 10_000, bytesRead: 123, recordsRead: 4, truncated: false,
      },
      source: 'fallback' as const,
    }));
    const { data } = await run(new HistorySearchTool(source, session, workspaces, caller, sessions), { query: '原话' });
    expect(source.search).toHaveBeenCalledWith(expect.objectContaining({
      fallbackSessionId: 'current', fallbackAgentId: 'main',
    }));
    expect(data.warning).toBe('search index unavailable');
    expect(data.fallback).toMatchObject({ maxBytes: 2 << 20, maxRecords: 10_000, truncated: false });
    expect(data.hits).toEqual([{ session_id: 'current', agent_id: 'main', role: 'user', turn: 2, snippet: '原话' }]);
  });

  it('reads a precise step including tool output from a previous turn', async () => {
    const source = archive('{"steps":[{"step_id":"t7.2","frames":[{"role":"tool","output":"old result"}]}]}');
    const { data } = await run(new HistoryReadTool(source, session, workspaces, sessions, caller),
      { session_id: 'older', turn: 7, step_id: 't7.2' });
    expect(source.readTurn).toHaveBeenCalledWith('older', 'main', 7, 't7.2');
    expect(data.text).toContain('old result');
    await expect(new HistoryReadTool(source, session, workspaces, sessions, caller)
      .resolveExecution({ turn: 7, step_id: 't8.2' })).rejects.toThrow('step_id');
  });

  it('advertises and executes step-only and cursor-only reads', async () => {
    const source = archive('响'.repeat(6_101));
    const tool = new HistoryReadTool(source, session, workspaces, sessions, caller);
    const validate = new Ajv({ strict: false }).compile(tool.parameters);
    expect(validate({ step_id: 't7.2' })).toBe(true);
    expect(validate({ cursor: 'opaque' })).toBe(true);
    expect(validate({ turn: 7, step_id: 't7.2' })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ step_id: 't7.2', turns: 7 })).toBe(false);
    const first = await run(tool, { step_id: 't7.2' });
    expect(source.readTurn).toHaveBeenLastCalledWith('current', 'main', 7, 't7.2');
    const second = await run(tool, { cursor: first.data.next_cursor });
    expect(second.data.text).toBe('响'.repeat(3_000));
    expect(source.readTurn).toHaveBeenLastCalledWith('current', 'main', 7, 't7.2');
    const wrong = await run(tool, { cursor: first.data.next_cursor, turn: 8 });
    expect(wrong.result).toMatchObject({ isError: true });
    expect(JSON.parse(wrong.result.output as string)).toMatchObject({ error: { code: 'cursor_mismatch' } });
  });

  it('pages large output with a bounded chunk and bound cursor', async () => {
    const source = archive('压'.repeat(17_000));
    const tool = new HistoryReadTool(source, session, workspaces, sessions, caller);
    const first = await run(tool, { turn: 2 });
    expect((first.data.text as string).length).toBeLessThanOrEqual(3_000);
    expect(first.data.has_more).toBe(true);
    const chunks = [first.data.text];
    let cursor = first.data.next_cursor;
    while (cursor !== undefined) {
      const page = await run(tool, { turn: 2, cursor });
      chunks.push(page.data.text);
      cursor = page.data.next_cursor;
    }
    expect(chunks.join('')).toBe('压'.repeat(17_000));
    const wrong = await run(tool, { turn: 3, cursor: first.data.next_cursor });
    expect(wrong.result.isError).toBe(true);
  });

  it('rejects another workspace by default and subjects an explicit request to external access policy', async () => {
    const source = archive();
    const reader = new HistoryReadTool(source, session, workspaces, sessions, caller);
    await expect(reader.resolveExecution({ session_id: 'foreign', turn: 0 })).rejects.toThrow('requested workspace');
    expect(source.readTurn).not.toHaveBeenCalled();
    const external = await reader.resolveExecution({ session_id: 'foreign', workspace_id: 'ws-b', turn: 0 });
    expect('accesses' in external && external.accesses).toEqual([{
      kind: 'file', operation: 'read', path: '/external/project', implicitExternal: true,
    }]);
    const search = await new HistorySearchTool(source, session, workspaces, caller, sessions)
      .resolveExecution({ query: 'needle', workspace_id: 'ws-b', scope: 'workspace' });
    expect('accesses' in search && search.accesses).toEqual([{
      kind: 'file', operation: 'search', path: '/external/project', recursive: true, implicitExternal: true,
    }]);
  });

  it('binds preparation cursors to their target and never advises replaying a stale directory ref', async () => {
    const ix = new TestInstantiationService();
    const source = archive();
    source.lookupDirectory = vi.fn(async () => ({ status: 'navigation_building' as const,
      next: { offset: 8000, incarnation: 'incarnation' }, scanned: { bytes: 8000, records: 2 } }));
    source.readDirectory = vi.fn(async () => ({ status: 'stale_ref' as const }));
    ix.set(IHistoryArchive, source);
    ix.set(SessionContextToken, session);
    ix.set(AgentScopeContextToken, caller);
    ix.set(SessionIndexToken, sessions);
    ix.set(WorkspaceToken, workspaces);
    ix.set(IHistoryReadTool, new SyncDescriptor(HistoryReadTool));
    const tool = ix.get(IHistoryReadTool);
    const execute = async (input: Record<string, unknown>) => {
      const execution = await tool.resolveExecution(input as never);
      if (!('execute' in execution)) throw new Error('Expected execute');
      const result = await execution.execute({ signal: new AbortController().signal, turnId: 1, toolCallId: 'read' });
      return { result, data: JSON.parse(result.output as string) };
    };
    try {
      const first = await execute({ step_id: 't782.14', max_chars: 10_000 });
      expect(first.data).toMatchObject({ status: 'partial', has_more: true, continuation: 'scan' });
      await execute({ cursor: first.data.next_cursor });
      expect(source.lookupDirectory).toHaveBeenLastCalledWith('ws-a', 'current', 'main', 782, 't782.14',
        { offset: 8000, incarnation: 'incarnation' }, expect.any(AbortSignal));
      const wrong = await execute({ cursor: first.data.next_cursor, turn: 1 });
      expect(wrong.data.error.code).toBe('cursor_mismatch');
      const foreign = await execute({ cursor: first.data.next_cursor, max_chars: 1000 });
      expect(foreign.data.error.code).toBe('cursor_mismatch');
      const ref = `h1_${Buffer.from(JSON.stringify({ workspace: 'ws-a', session: 'current', agent: 'main', kind: 'turn' })).toString('base64url')}`;
      const stale = await execute({ ref });
      expect(stale.data).toMatchObject({ error: { code: 'stale_ref', retryable: false,
        next_call: { tool: 'HistoryList', arguments: { session_id: 'current', agent_id: 'main' } } } });
      expect(stale.data.error.next_call.arguments).not.toHaveProperty('ref');
      expect(source.readTurn).not.toHaveBeenCalled();
    } finally { await ix.dispose(); }
  });
});
