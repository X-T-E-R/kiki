import { describe, expect, it } from 'vitest';
import { HistorySearchTool, type IHistoryArchive } from '../../../src/agent/tools/history/historyTools';
import type { ISessionContext } from '../../../src/session/sessionContext/sessionContext';
import type { IAgentScopeContext } from '../../../src/agent/scopeContext/scopeContext';
import type { IWorkspaceService } from '../../../src/app/workspace/workspace';
import type { ISessionIndex } from '../../../src/app/sessionIndex/sessionIndex';

const session = { sessionId: 'current', workspaceId: 'ws-a' } as ISessionContext;
const caller = { agentId: 'main' } as IAgentScopeContext;
const workspaces = { get: async () => undefined } as unknown as IWorkspaceService;
const sessions = { get: async () => ({ workspaceId: 'ws-a' }) } as unknown as ISessionIndex;

describe('HistorySearch index states', () => {
  for (const state of ['building', 'ready', 'unavailable'] as const) {
    it(`snapshots ${state} output with coverage and progress`, async () => {
      const archive = {
        search: async () => ({
          items: state === 'unavailable' ? [] : [{ sessionId: 'older', agentId: 'main', role: 'assistant',
            turn: 3, stepId: 't3.1', snippet: 'result' }],
          hasMore: false, source: state === 'unavailable' ? 'fallback' : 'index',
          indexState: { state, indexedSessions: state === 'building' ? 2 : 3,
            totalSessions: 3, documents: 14, ...(state === 'unavailable' ? { reason: 'sqlite_unavailable' } : {}) },
        }),
      } as unknown as IHistoryArchive;
      const tool = new HistorySearchTool(archive, session, workspaces, caller, sessions);
      const execution = await tool.resolveExecution({ query: 'result' });
      if (!('execute' in execution)) throw new Error('not executable');
      const result = await execution.execute({ signal: new AbortController().signal, turnId: 1, toolCallId: 'c' });
      const output = JSON.parse(result.output as string);
      expect(output).toMatchObject({
        schema_version: 2,
        status: state === 'ready' ? 'ok' : 'partial',
        target: { workspace_id: 'ws-a', session_id: 'current', agent_id: 'main' },
        coverage: { complete: state === 'ready', domain: 'indexed_text', gaps: ['tool_tail_not_indexed'] },
        index_state: { state, indexedSessions: state === 'building' ? 2 : 3, totalSessions: 3, documents: 14 },
        source: state === 'unavailable' ? 'fallback' : 'index',
      });
      expect(output.hits).toHaveLength(state === 'unavailable' ? 0 : 1);
    });
  }
});
