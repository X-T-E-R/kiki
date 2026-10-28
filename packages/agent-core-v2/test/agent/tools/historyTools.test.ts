import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';

import {
  HistoryReadTool,
  HistoryReadInputSchema,
  HistorySearchTool,
  IHistoryArchive,
  IHistorySearchTool,
  IHistoryReadTool,
} from '../../../src/agent/tools/history/historyTools';
import { HistoryListTool } from '../../../src/agent/tools/history/historyListTool';
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
  readonly error?: { readonly code?: string; readonly next_call?: { readonly arguments: Record<string, unknown> } };
  readonly expand_hint?: { readonly next_call: { readonly arguments: Record<string, unknown> } };
  readonly fallback?: {
    readonly maxBytes: number;
    readonly maxRecords: number;
    readonly truncated: boolean;
  };
}

async function run(tool: { resolveExecution(input: never): import('../../../src/tool/toolContract').ToolExecution | Promise<import('../../../src/tool/toolContract').ToolExecution> }, input: Record<string, unknown>) {
  const execution = await tool.resolveExecution(input as never);
  if (!('execute' in execution)) return { execution, result: execution, data: JSON.parse(execution.output as string) as HistoryToolData };
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
    const first = await run(tool, {
      query: 'needle', scope: 'workspace', mode: 'literal', include_tool_output: true, limit: 2,
    });
    const next = await run(tool, { cursor: first.data.next_cursor });
    expect(next.result.isError).not.toBe(true);
    expect(source.search).toHaveBeenLastCalledWith(expect.objectContaining({
      query: 'needle', sessionId: undefined, mode: 'literal', pageSize: 2, pageToken: 'backend-page',
    }));
    const wrong = await run(tool, { cursor: first.data.next_cursor, mode: 'terms' });
    expect(wrong.result.isError).toBe(true);
    const wrongScope = await run(tool, { cursor: first.data.next_cursor, include_tool_output: false });
    expect(wrongScope.result.isError).toBe(true);
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

  it('passes execution cancellation to archive block and directory reads', async () => {
    const source = archive();
    const ref = `h1_${Buffer.from(JSON.stringify({ workspace: 'ws-a', session: 'current', agent: 'main', kind: 'frame' })).toString('base64url')}`;
    const directoryRef = `h1_${Buffer.from(JSON.stringify({ workspace: 'ws-a', session: 'current', agent: 'main', kind: 'turn' })).toString('base64url')}`;
    const controller = new AbortController();
    const context = { signal: controller.signal, turnId: 1, toolCallId: 'history-signal' };
    const readRef = vi.fn(async (value: string, signal?: AbortSignal) => {
      expect(signal).toBe(context.signal);
      return { status: 'ok' as const, text: 'archive text', turn: 7, ref: value };
    });
    const readDirectory = vi.fn(async (_value: string, _maxChars: number, _cursor: unknown, signal?: AbortSignal) => {
      expect(signal).toBe(context.signal);
      return { status: 'ok' as const, blocks: [], complete: true };
    });
    source.readRef = readRef;
    source.readDirectory = readDirectory;
    const tool = new HistoryReadTool(source, session, workspaces, sessions, caller);
    const block = await tool.resolveExecution({ ref });
    const directory = await tool.resolveExecution({ ref: directoryRef });
    if (!('execute' in block) || !('execute' in directory)) throw new Error('Expected executions');
    await block.execute(context);
    await directory.execute(context);
    expect(readRef).toHaveBeenCalledWith(ref, controller.signal);
    expect(readDirectory).toHaveBeenCalledWith(directoryRef, 6000, undefined, controller.signal);
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

  it('approves a known foreign session without workspace_id and does not read before that approval', async () => {
    const source = archive();
    const reader = new HistoryReadTool(source, session, workspaces, sessions, caller);
    const external = await reader.resolveExecution({ session_id: 'foreign', turn: 0 });
    expect(source.readTurn).not.toHaveBeenCalled();
    expect('accesses' in external && external.accesses).toEqual([{
      kind: 'file', operation: 'read', path: '/external/project', implicitExternal: true,
    }]);
    if (!('execute' in external)) throw new Error('expected execution');
    await external.execute({ signal: new AbortController().signal, turnId: 1, toolCallId: 'foreign-read' });
    expect(source.readTurn).toHaveBeenCalledWith('foreign', 'main', 0, undefined);
    const mismatched = await reader.resolveExecution({ session_id: 'foreign', workspace_id: 'ws-a', turn: 4 });
    expect('execute' in mismatched).toBe(false);
    expect(source.readTurn).toHaveBeenCalledTimes(1);
    const mismatch = JSON.parse((mismatched as { output: string }).output);
    expect(mismatch.error.next_call).toEqual({ tool: 'HistoryRead', arguments: {
      session_id: 'foreign', workspace_id: 'ws-b', turn: 4,
    } });
    const followed = await reader.resolveExecution(mismatch.error.next_call.arguments);
    expect(source.readTurn).toHaveBeenCalledTimes(1);
    expect('accesses' in followed && followed.accesses).toEqual([{
      kind: 'file', operation: 'read', path: '/external/project', implicitExternal: true,
    }]);
    if (!('execute' in followed)) throw new Error('expected execution');
    await followed.execute({ signal: new AbortController().signal, turnId: 1, toolCallId: 'foreign-follow' });
    expect(source.readTurn).toHaveBeenLastCalledWith('foreign', 'main', 4, undefined);
    const searchSource = archive();
    const search = new HistorySearchTool(searchSource, session, workspaces, caller, sessions);
    const known = await search.resolveExecution({ query: 'needle', session_id: 'foreign' });
    expect(searchSource.search).not.toHaveBeenCalled();
    expect('accesses' in known && known.accesses).toEqual([{
      kind: 'file', operation: 'search', path: '/external/project', recursive: true, implicitExternal: true,
    }]);
    if (!('execute' in known)) throw new Error('expected execution');
    await known.execute({ signal: new AbortController().signal, turnId: 1, toolCallId: 'foreign-search' });
    expect(searchSource.search).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-b', sessionId: 'foreign' }));
    const widened = await search.resolveExecution({ query: 'needle', workspace_id: 'ws-b', scope: 'workspace' });
    expect('accesses' in widened && widened.accesses).toEqual([{
      kind: 'file', operation: 'search', path: '/external/project', recursive: true, implicitExternal: true,
    }]);
  });

  it('follows unknown and stale recovery to a real target without another session or a loop', async () => {
    const source = archive();
    const known: Record<string, string> = { current: 'ws-a', older: 'ws-a', foreign: 'ws-b' };
    const get = vi.fn(async (id: string) => known[id] === undefined ? undefined : { id, workspaceId: known[id] });
    const index = { get } as unknown as ISessionIndex;
    const list = vi.fn(async (request: { workspaceId: string; sessionId: string }) => ({
      status: 'ok' as const, target: { workspaceId: request.workspaceId, sessionId: request.sessionId },
      source: 'transcript' as const, coverage: { complete: true, domain: 'directory' as const }, turns: [],
    }));
    const search = new HistorySearchTool(source, session, workspaces, caller, index);
    const listed = new HistoryListTool({ _serviceBrand: undefined, list }, session, workspaces, index, caller);
    const reader = new HistoryReadTool(source, session, workspaces, index, caller);
    const signal = { signal: new AbortController().signal, turnId: 1, toolCallId: 'recover' };
    const searchFailure = await run(search, { query: 'needle', session_id: 'missing' });
    const workspaceFailure = await run(search, { query: 'needle', scope: 'workspace', workspace_id: 'ws-missing' });
    const listFailure = await run(listed, { session_id: 'missing' });
    const ref = `h1_${Buffer.from(JSON.stringify({ workspace: 'ws-a', session: 'missing', agent: 'main', kind: 'turn' })).toString('base64url')}`;
    const refFailure = await run(reader, { ref });
    expect(searchFailure.data.error?.next_call).toEqual({ tool: 'HistorySearch', arguments: { query: 'needle', scope: 'workspace' } });
    expect(workspaceFailure.data.error?.next_call).toEqual({ tool: 'HistorySearch', arguments: { query: 'needle', scope: 'workspace' } });
    expect(listFailure.data.error?.next_call).toEqual({ tool: 'HistoryList', arguments: { kind: 'turns' } });
    expect(refFailure.data.error?.next_call).toEqual({ tool: 'HistoryList', arguments: { kind: 'turns' } });
    expect(JSON.stringify(refFailure.data.error?.next_call)).not.toContain('missing');
    expect(source.search).not.toHaveBeenCalled();
    expect(source.readTurn).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    const moved = `h1_${Buffer.from(JSON.stringify({ workspace: 'ws-a', session: 'foreign', agent: 'main', kind: 'turn' })).toString('base64url')}`;
    const movedFailure = await run(reader, { ref: moved });
    expect(movedFailure.data.error?.next_call).toEqual({ tool: 'HistoryList', arguments: {
      kind: 'turns', session_id: 'foreign', workspace_id: 'ws-b', agent_id: 'main',
    } });
    const movedList = await listed.resolveExecution(movedFailure.data.error?.next_call?.arguments ?? {});
    expect(list).not.toHaveBeenCalled();
    expect(source.readTurn).not.toHaveBeenCalled();
    expect('accesses' in movedList && movedList.accesses).toEqual([{
      kind: 'file', operation: 'read', path: '/external/project', implicitExternal: true,
    }]);
    const widened = await search.resolveExecution(searchFailure.data.error?.next_call?.arguments ?? {});
    expect(source.search).not.toHaveBeenCalled();
    if (!('execute' in widened)) throw new Error('expected search execution');
    const widenedResult = await widened.execute(signal);
    expect(widenedResult.isError).not.toBe(true);
    expect(source.search).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-a', sessionId: undefined }));
    const browsed = await listed.resolveExecution(listFailure.data.error?.next_call?.arguments ?? {});
    if (!('execute' in browsed)) throw new Error('expected list execution');
    const browsedResult = await browsed.execute(signal);
    expect(browsedResult.isError).not.toBe(true);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-a', sessionId: 'current' }));
    expect(source.readTurn).not.toHaveBeenCalled();
    const staleCursor = Buffer.from(JSON.stringify({ v: 1, session: 'older', agent: 'main', turn: 7, offset: 0, hash: 'stale' })).toString('base64url');
    get.mockResolvedValueOnce(undefined);
    const stale = await run(reader, { cursor: staleCursor });
    expect(stale.data.error?.next_call).toEqual({ tool: 'HistoryRead', arguments: { session_id: 'older', turn: 7, agent_id: 'main' } });
    expect(stale.data.error?.next_call?.arguments).not.toHaveProperty('cursor');
    expect(source.readTurn).not.toHaveBeenCalled();
    const restored = await reader.resolveExecution(stale.data.error?.next_call?.arguments ?? {});
    if (!('execute' in restored)) throw new Error('expected restored read');
    await restored.execute(signal);
    expect(source.readTurn).toHaveBeenCalledWith('older', 'main', 7, undefined);
    const ghostCursor = Buffer.from(JSON.stringify({ v: 1, session: 'ghost', agent: 'main', turn: 7, offset: 0, hash: 'gone' })).toString('base64url');
    vi.mocked(source.readTurn).mockClear();
    const ghost = await run(reader, { cursor: ghostCursor });
    const ghostRetry = await run(reader, ghost.data.error?.next_call?.arguments ?? {});
    expect(ghostRetry.data.error?.next_call).toEqual({ tool: 'HistoryList', arguments: { kind: 'turns' } });
    expect(JSON.stringify(ghostRetry.data.error?.next_call)).not.toContain('ghost');
    expect(source.readTurn).not.toHaveBeenCalled();
    const ghostList = await listed.resolveExecution(ghostRetry.data.error?.next_call?.arguments ?? {});
    if (!('execute' in ghostList)) throw new Error('expected discovery list');
    const ghostPage = await ghostList.execute(signal);
    expect(ghostPage.isError).not.toBe(true);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'current', workspaceId: 'ws-a' }));
    const unindexed = archive();
    const empty = { get: vi.fn(async () => undefined) } as unknown as ISessionIndex;
    const currentSearch = await new HistorySearchTool(unindexed, session, workspaces, caller, empty)
      .resolveExecution({ query: 'needle' });
    if (!('execute' in currentSearch)) throw new Error('current session must stay readable');
    await currentSearch.execute(signal);
    expect(unindexed.search).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-a', sessionId: 'current' }));
  });

  it('drops a stale read cursor and restores its original session', async () => {
    const source = archive('text'.repeat(4_000));
    const get = vi.fn(async (id: string): Promise<{ id: string; workspaceId: string } | undefined> => ({ id, workspaceId: 'ws-a' }));
    const index = { get } as unknown as ISessionIndex;
    const reader = new HistoryReadTool(source, session, workspaces, index, caller);
    const first = await run(reader, { session_id: 'older', turn: 7 });
    vi.mocked(source.readTurn).mockClear();
    get.mockResolvedValueOnce(undefined);
    const failed = await run(reader, { cursor: first.data.next_cursor });
    expect(failed.data).toMatchObject({ error: { code: 'history_target_unavailable', scope: 'selector', target_kind: 'cursor',
      next_call: { tool: 'HistoryRead', arguments: { session_id: 'older', turn: 7, agent_id: 'main' } } } });
    expect(failed.data.error?.next_call?.arguments).not.toHaveProperty('cursor');
    expect(source.readTurn).not.toHaveBeenCalled();
    const restored = await run(reader, failed.data.error?.next_call?.arguments ?? {});
    expect(restored.result.isError).not.toBe(true);
    expect(source.readTurn).toHaveBeenCalledWith('older', 'main', 7, undefined);
  });

  it.each(['turn', 'frame'] as const)('binds ref preparation to its %s target and original read position', async (kind) => {
    const ix = new TestInstantiationService();
    const source = archive();
    const preparation = { offset: 8000, incarnation: 'incarnation' };
    const scanned = { bytes: 8000, records: 2 };
    source.readDirectory = vi.fn(async () => ({ status: 'navigation_building' as const, preparation, scanned }));
    source.readRef = vi.fn(async () => ({ status: 'navigation_building' as const, next: preparation, scanned }));
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
      expect(result.isError).not.toBe(true);
      return JSON.parse(result.output as string);
    };
    try {
      const ref = `h1_${Buffer.from(JSON.stringify({ workspace: 'ws-a', session: 'current', agent: 'main', kind, pad: 'p'.repeat(1100) })).toString('base64url')}`;
      const resume = { v: 3, ref, maxChars: 1000, position: 11, offset: 17, watermark: 33, asOfBytes: 99 };
      const first = await execute(kind === 'turn' ? { cursor: Buffer.from(JSON.stringify(resume)).toString('base64url') } :
        { ref, start_char: 29, max_chars: 1000 });
      expect(first).toMatchObject({ status: 'partial', ref, blocks: [], has_more: true, continuation: 'scan',
        coverage: { complete: false, gaps: ['navigation_building'], scanned }, progress: { through_bytes: 8000 } });
      expect(HistoryReadInputSchema.safeParse({ cursor: first.next_cursor }).success).toBe(true);
      const wrapper = JSON.parse(Buffer.from(first.next_cursor, 'base64url').toString('utf8'));
      expect(wrapper.resume).toEqual(kind === 'turn' ?
        { v: 3, position: 11, offset: 17, watermark: 33, asOfBytes: 99 } : { v: 2, offset: 29 });
      await execute({ cursor: first.next_cursor });
      if (kind === 'turn') expect(source.readDirectory).toHaveBeenLastCalledWith(ref, 1000,
        { position: 11, offset: 17, watermark: 33, asOfBytes: 99 }, expect.any(AbortSignal));
      else expect(source.readRef).toHaveBeenLastCalledWith(ref, expect.any(AbortSignal));
      const wrongAgent = await tool.resolveExecution({ cursor: first.next_cursor, agent_id: 'other' });
      expect(wrongAgent).toMatchObject({ isError: true });
      await expect(tool.resolveExecution({ cursor: first.next_cursor, max_chars: 2000 })).rejects.toThrow('conflicts');
      await expect(tool.resolveExecution({ cursor: first.next_cursor, turn: 12 })).rejects.toThrow('conflicts');
      const forged = Buffer.from(JSON.stringify({ ...wrapper, resume: { ...wrapper.resume, ref: `${ref}x` } })).toString('base64url');
      await expect(tool.resolveExecution({ cursor: forged })).rejects.toThrow('Invalid HistoryRead ref preparation cursor');
      expect(source.readTurn).not.toHaveBeenCalled();
    } finally { await ix.dispose(); }
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
