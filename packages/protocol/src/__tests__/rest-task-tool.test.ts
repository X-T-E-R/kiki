import { describe, expect, it } from 'vitest';

import { agentTaskSummarySchema, listAgentTasksQuerySchema, listAgentTasksResponseSchema } from '../rest/agent-tasks';
import { matchConnectionOperation } from '../rest/connection-operations';
import {
  cancelTaskQuerySchema,
  cancelTaskResultSchema,
  getTaskQuerySchema,
  getTaskResponseSchema,
  listTasksQuerySchema,
  listTasksResponseSchema,
  taskAlreadyFinishedDataSchema,
} from '../rest/task';
import {
  listMcpServersResponseSchema,
  listToolsQuerySchema,
  listToolsResponseSchema,
  restartMcpServerResultSchema,
} from '../rest/tool';

describe('session tasks REST schemas', () => {
  it('validates list, get, and cancel task queries and payloads', () => {
    expect(listTasksQuerySchema.parse({})).toEqual({});
    expect(listTasksQuerySchema.parse({ status: 'running' })).toEqual({ status: 'running' });
    expect(listTasksQuerySchema.safeParse({ status: 'pending' }).success).toBe(false);
    expect(listTasksResponseSchema.parse({ items: [] })).toEqual({ items: [] });

    expect(getTaskQuerySchema.parse({})).toEqual({});
    expect(getTaskQuerySchema.parse({ with_output: 'true', output_bytes: '512', agent_id: 'agent-a' }))
      .toEqual({ with_output: true, output_bytes: 512, agent_id: 'agent-a' });

    expect(cancelTaskQuerySchema.parse({})).toEqual({});
    expect(cancelTaskQuerySchema.parse({ agent_id: 'agent-a' })).toEqual({ agent_id: 'agent-a' });
    expect(cancelTaskQuerySchema.safeParse({ agent_id: '' }).success).toBe(false);

    expect(
      getTaskResponseSchema.parse({
        id: 'task_01',
        session_id: 'sess_01',
        kind: 'subagent',
        description: 'spin up x',
        status: 'running',
        created_at: '2026-06-04T10:00:00.000Z',
        run_in_background: true,
      }).kind,
    ).toBe('subagent');
  });

  it('enforces exact cancellation literal flags (rejects false success receipts)', () => {
    expect(cancelTaskResultSchema.parse({ cancelled: true })).toEqual({ cancelled: true });
    expect(cancelTaskResultSchema.safeParse({ cancelled: false }).success).toBe(false);
    expect(taskAlreadyFinishedDataSchema.parse({ cancelled: false })).toEqual({ cancelled: false });
    expect(taskAlreadyFinishedDataSchema.safeParse({ cancelled: true }).success).toBe(false);
  });
});

describe('whole-session agent task metadata and operation routes', () => {
  it('registers only a session-addressed read in the approved connection surface', () => {
    expect(matchConnectionOperation('GET', '/api/sessions/example/agent-tasks'))
      .toEqual({ operation: 'agentTaskList', params: { sessionId: 'example' } });
    expect(matchConnectionOperation('POST', '/api/sessions/example/agent-tasks')).toBeUndefined();
    expect(matchConnectionOperation('GET', '/api/sessions/%2Fother/agent-tasks')).toBeUndefined();
    expect(matchConnectionOperation('POST', '/api/sessions/session-example/abort')).toBeUndefined();
    expect(matchConnectionOperation('POST', '/api/sessions/session-example/prompts/steer')).toBeUndefined();
  });

  it.each([
    ['POST', '/api/sessions/session-example:abort', 'abort', { sessionId: 'session-example' }],
    ['POST', '/api/sessions/session-example/turns/12:abort', 'turnAbort', { sessionId: 'session-example', turnId: '12' }],
    ['POST', '/api/sessions/session-example/messages/message-example:edit', 'messageEdit', { sessionId: 'session-example', messageId: 'message-example' }],
    ['POST', '/api/sessions/session-example/messages/message-example:regenerate', 'messageRegenerate', { sessionId: 'session-example', messageId: 'message-example' }],
    ['POST', '/api/sessions/session-example/tasks/task-example:cancel', 'taskCancel', { sessionId: 'session-example', taskId: 'task-example' }],
    ['POST', '/api/sessions/session-example/prompts/prompt-example:move', 'promptMove', { sessionId: 'session-example', promptId: 'prompt-example' }],
    ['POST', '/api/sessions/session-example/prompts/prompt-example:replace', 'promptReplace', { sessionId: 'session-example', promptId: 'prompt-example' }],
    ['POST', '/api/sessions/session-example/prompts/prompt-example:timing', 'promptTiming', { sessionId: 'session-example', promptId: 'prompt-example' }],
    ['POST', '/api/sessions/session-example/prompts/prompt-example:hold', 'promptHold', { sessionId: 'session-example', promptId: 'prompt-example' }],
    ['POST', '/api/sessions/session-example/prompts/prompt-example:steer', 'promptSteer', { sessionId: 'session-example', promptId: 'prompt-example' }],
    ['POST', '/api/sessions/session-example/prompts:steer', 'steer', { sessionId: 'session-example' }],
    ['POST', '/api/sessions/session-example/agents/agent-example:promote', 'agentPromote', { sessionId: 'session-example', agentId: 'agent-example' }],
    ['POST', '/api/sessions/session-example/document-preview', 'documentPreview', { sessionId: 'session-example' }],
    ['GET', '/api/sessions/session-example/document-preview/assets/page-1', 'documentPreviewAsset', { sessionId: 'session-example', assetId: 'page-1' }],
    ['PATCH', '/api/sessions/session-example/agents/agent-example/context-strategy', 'contextStrategyUpdate', { sessionId: 'session-example', agentId: 'agent-example' }],
    ['PUT', '/api/personas/kiki', 'personaPut', { personaId: 'kiki' }],
    ['POST', '/api/personas/kiki:archive', 'personaArchive', { personaId: 'kiki' }],
    ['GET', '/api/personas/kiki', 'persona', { personaId: 'kiki' }],
  ] as const)('matches active session route %s %s', (method, path, operation, params) => {
    expect(matchConnectionOperation(method, path)).toEqual({ operation, params });
  });

  it('admits persona definition writes and archive for peers but not deletion or duplication', () => {
    expect(matchConnectionOperation('DELETE', '/api/personas/kiki')).toBeUndefined();
    expect(matchConnectionOperation('POST', '/api/personas/kiki:duplicate')).toBeUndefined();
    expect(matchConnectionOperation('PUT', '/api/personas/kiki/avatar')).toBeUndefined();
  });

  it('requires owner provenance and distinguishes empty, progressing, and failed coverage', () => {
    expect(listAgentTasksQuerySchema.parse({ page_size: '2', page_token: 'opaque' })).toEqual({ page_size: 2, page_token: 'opaque' });
    expect(listAgentTasksQuerySchema.safeParse({ page_size: 101 }).success).toBe(false);

    const task = {
      id: 'example',
      session_id: 'session',
      kind: 'subagent',
      status: 'running',
      description: 'example',
      created_at: '2026-06-04T10:00:00.000Z',
      agent_id: 'target',
      source: 'live',
    };
    expect(agentTaskSummarySchema.safeParse(task).success).toBe(false);
    expect(agentTaskSummarySchema.parse({ ...task, owner_agent_id: 'owner' }))
      .toMatchObject({ owner_agent_id: 'owner', agent_id: 'target' });

    const empty = {
      items: [],
      owners: [{ owner_agent_id: 'main', source: 'persisted', state: 'complete' }],
      coverage: { total_owners: 1, completed_owners: 1, failed_owners: 0, pending_owners: 0, inventory_complete: true, complete: true, failures: [] },
      has_more: false,
      partial: false,
      consistency: 'incremental',
      started_at: '2026-06-04T10:00:00.000Z',
      observed_at: '2026-06-04T10:00:00.000Z',
    };
    expect(listAgentTasksResponseSchema.safeParse(empty).success).toBe(true);
    expect(listAgentTasksResponseSchema.safeParse({ ...empty, has_more: true }).success).toBe(false);
    expect(listAgentTasksResponseSchema.safeParse({ ...empty, coverage: { ...empty.coverage, total_owners: 2 } }).success).toBe(false);
    expect(
      listAgentTasksResponseSchema.safeParse({
        ...empty,
        owners: [{ ...empty.owners[0], state: 'pending' }],
        has_more: true,
        next_page_token: 'next',
        coverage: { ...empty.coverage, completed_owners: 0, pending_owners: 1, complete: false },
      }).success,
    ).toBe(true);
    expect(
      listAgentTasksResponseSchema.safeParse({
        ...empty,
        owners: [{ ...empty.owners[0], state: 'failed' }],
        partial: true,
        coverage: {
          ...empty.coverage,
          completed_owners: 0,
          failed_owners: 1,
          complete: false,
          failures: [{ stage: 'owner', owner_agent_id: 'main', message: 'Unable to read owner' }],
        },
      }).success,
    ).toBe(true);
  });
});

describe('tools and MCP server REST schemas', () => {
  it('validates listToolsQuerySchema and tool/MCP response envelopes', () => {
    expect(listToolsQuerySchema.parse({})).toEqual({});
    expect(listToolsQuerySchema.parse({ session_id: 'sess_01' })).toEqual({ session_id: 'sess_01' });
    expect(listToolsQuerySchema.safeParse({ session_id: '' }).success).toBe(false);

    expect(listToolsResponseSchema.parse({ tools: [] })).toEqual({ tools: [] });
    expect(
      listToolsResponseSchema.parse({
        tools: [{ name: 'Bash', description: 'Execute shell', input_schema: null, source: 'builtin' }],
      }).tools,
    ).toHaveLength(1);
    expect(
      listMcpServersResponseSchema.parse({
        servers: [{ id: 'lark', name: 'lark', transport: 'stdio', status: 'connected', tool_count: 3 }],
      }).servers[0]?.id,
    ).toBe('lark');
  });

  it('requires restarting: true literal and rejects false success receipts', () => {
    expect(restartMcpServerResultSchema.parse({ restarting: true })).toEqual({ restarting: true });
    expect(restartMcpServerResultSchema.safeParse({ restarting: false }).success).toBe(false);
  });
});
