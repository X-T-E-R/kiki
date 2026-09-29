import { describe, expect, it, vi } from 'vitest';

import {
  HistoryReadTool,
  HistorySearchTool,
  type IHistoryArchive,
} from '../../../src/agent/tools/history/historyTools';
import { toolGroupForName } from '../../../src/agent/toolRegistry/toolGroups';
import { isToolActive } from '../../../src/agent/toolPolicy/evaluate';
import type { ISessionContext } from '../../../src/session/sessionContext/sessionContext';
import type { IAgentScopeContext } from '../../../src/agent/scopeContext/scopeContext';

const caller = { agentId: 'main' } as IAgentScopeContext;
import type { ISessionIndex } from '../../../src/app/sessionIndex/sessionIndex';
import type { IWorkspaceService } from '../../../src/app/workspace/workspace';

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
}

async function run(tool: HistorySearchTool | HistoryReadTool, input: Record<string, unknown>) {
  const execution = await tool.resolveExecution(input as never);
  if (!('execute' in execution)) throw new Error('Expected executable tool');
  const result = await execution.execute({ signal: new AbortController().signal, turnId: 1, toolCallId: 'c' });
  return { execution, result, data: result.isError ? {} as HistoryToolData : JSON.parse(result.output as string) as HistoryToolData };
}

describe('history tools', () => {
  it('uses the existing profile tool-group gate', () => {
    expect(toolGroupForName('HistorySearch')).toBe('history');
    expect(toolGroupForName('HistoryRead')).toBe('history');
    expect(isToolActive({ disabledToolGroups: ['history'] }, 'HistoryRead')).toBe(false);
    expect(isToolActive({ disabledToolGroups: ['history'] }, 'HistorySearch')).toBe(false);
  });

  it('searches across sessions in the current workspace without widening the query', async () => {
    const source = archive();
    const { data } = await run(new HistorySearchTool(source, session, workspaces, caller), { query: '原话' });
    expect(source.search).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-a', sessionId: undefined }));
    expect(data.hits).toEqual([{ session_id: 'older', agent_id: 'main', role: 'user', turn: 3, snippet: '原话' }]);
    await run(new HistorySearchTool(source, session, workspaces, caller), {
      query: '原话', scope: 'this_session', mode: 'literal',
    });
    expect(source.search).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'ws-a', sessionId: 'current', mode: 'literal',
    }));
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
    const search = await new HistorySearchTool(source, session, workspaces, caller)
      .resolveExecution({ query: 'needle', workspace_id: 'ws-b' });
    expect('accesses' in search && search.accesses).toEqual([{
      kind: 'file', operation: 'search', path: '/external/project', recursive: true, implicitExternal: true,
    }]);
  });
});
