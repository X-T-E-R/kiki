import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';

import {
  decodeHistoryDirectoryCursor,
  encodeHistoryDirectoryCursor,
  HistoryListTool,
  type IHistoryDirectory,
} from '../../../src/agent/tools/history/historyListTool';
import type { IAgentScopeContext } from '../../../src/agent/scopeContext/scopeContext';
import type { ISessionIndex } from '../../../src/app/sessionIndex/sessionIndex';
import type { IWorkspaceService } from '../../../src/app/workspace/workspace';
import type { ISessionContext } from '../../../src/session/sessionContext/sessionContext';

const session = { sessionId: 'current', workspaceId: 'ws-a' } as ISessionContext;
const caller = { agentId: 'child' } as IAgentScopeContext;
const workspaces = { get: vi.fn(async () => undefined) } as unknown as IWorkspaceService;
const sessions = {
  get: vi.fn(async (id: string) => ({ id, workspaceId: id === 'old' ? 'ws-a' : 'ws-a' })),
} as unknown as ISessionIndex;

function directory(): IHistoryDirectory {
  return {
    _serviceBrand: undefined,
    list: vi.fn(async (request) => ({
      status: 'partial' as const,
      target: {
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        agentId: request.agentId,
      },
      source: 'transcript' as const,
      coverage: { complete: false, domain: 'directory' as const, gaps: ['bounded_cold_read'] },
      turns: [{ turn: 4, promptExcerpt: 'old prompt', stepCount: 2, toolCount: 1 }],
      nextCursor: encodeHistoryDirectoryCursor({
        v: 1,
        request: {
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          kind: request.kind,
          agentId: request.agentId,
          beforeTurn: request.beforeTurn,
          afterTurn: request.afterTurn,
          at: request.at,
          order: request.order,
          limit: request.limit,
        },
        afterTurn: 4,
      }),
    })),
  };
}

async function run(tool: HistoryListTool, input: Record<string, unknown>) {
  const execution = await tool.resolveExecution(input as never);
  if (!('execute' in execution)) throw new Error('Expected executable tool');
  return execution.execute({ signal: new AbortController().signal, turnId: 1, toolCallId: 'call' });
}

describe('HistoryListTool', () => {
  it('publishes the §6.2 schema and closes unknown fields', () => {
    const validate = new Ajv({ strict: false }).compile(
      new HistoryListTool(directory(), session, workspaces, sessions, caller).parameters,
    );
    expect(validate({})).toBe(true);
    expect(validate({ kind: 'turns', limit: 30, before_turn: 4 })).toBe(true);
    expect(validate({ kind: 'turns', limit: 31 })).toBe(false);
    expect(validate({ kind: 'agents', agent_id: 'main' })).toBe(false);
    expect(validate({ at: '2026-01-01T00:00:00Z', before_turn: 4 })).toBe(false);
    expect(validate({ cursor: 'opaque', kind: 'turns' })).toBe(false);
    expect(validate({ unexpected: true })).toBe(false);
  });

  it('defaults to the current session and caller agent and emits bounded coverage', async () => {
    const source = directory();
    const result = await run(new HistoryListTool(source, session, workspaces, sessions, caller), {});
    const data = JSON.parse(result.output as string) as Record<string, unknown>;
    expect(source.list).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-a', sessionId: 'current', kind: 'turns', agentId: 'child', order: 'newest', limit: 10,
    }));
    expect(data).toMatchObject({
      schema_version: 2,
      status: 'partial',
      kind: 'turns',
      target: { workspace_id: 'ws-a', session_id: 'current', agent_id: 'child' },
      coverage: { complete: false, domain: 'directory', gaps: ['bounded_cold_read'] },
      has_more: true,
    });
    expect(data['turns']).toEqual([expect.objectContaining({ turn: 4, prompt_excerpt: 'old prompt' })]);
  });

  it('continues with only a cursor and rejects conflicting filters', async () => {
    const source = directory();
    const tool = new HistoryListTool(source, session, workspaces, sessions, caller);
    const first = await run(tool, {});
    const cursor = JSON.parse(first.output as string).next_cursor as string;
    await run(tool, { cursor });
    expect(source.list).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'ws-a', sessionId: 'current', agentId: 'child', cursor,
    }));
    await expect(tool.resolveExecution({ cursor, order: 'oldest' })).rejects.toThrow('cursor');
    expect(decodeHistoryDirectoryCursor(cursor).request.kind).toBe('turns');
  });

  it('uses the agent directory without an agent filter', async () => {
    const source = directory();
    const tool = new HistoryListTool(source, session, workspaces, sessions, caller);
    await expect(tool.resolveExecution({ kind: 'agents', agent_id: 'child' })).rejects.toThrow('agent_id');
    await run(tool, { kind: 'agents' });
    expect(source.list).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'agents', agentId: undefined }));
  });
});
