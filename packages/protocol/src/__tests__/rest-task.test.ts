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

describe('listTasksQuerySchema', () => {
  it('accepts empty query', () => {
    expect(listTasksQuerySchema.parse({})).toEqual({});
  });
  it('accepts status filter', () => {
    expect(listTasksQuerySchema.parse({ status: 'running' })).toEqual({
      status: 'running',
    });
  });
  it('rejects unknown status', () => {
    expect(listTasksQuerySchema.safeParse({ status: 'pending' }).success).toBe(false);
  });
});

describe('listTasksResponseSchema', () => {
  it('round-trips empty items[]', () => {
    expect(listTasksResponseSchema.parse({ items: [] })).toEqual({ items: [] });
  });
});

describe('getTaskQuerySchema', () => {
  it('accepts empty query', () => {
    expect(getTaskQuerySchema.parse({})).toEqual({});
  });
  it('coerces with_output + output_bytes from strings (HTTP query)', () => {
    const parsed = getTaskQuerySchema.parse({
      with_output: 'true',
      output_bytes: '512',
      agent_id: 'agent-a',
    });
    expect(parsed.with_output).toBe(true);
    expect(parsed.output_bytes).toBe(512);
    expect(parsed.agent_id).toBe('agent-a');
  });
});

describe('cancelTaskQuerySchema', () => {
  it('accepts an optional owning agent id', () => {
    expect(cancelTaskQuerySchema.parse({})).toEqual({});
    expect(cancelTaskQuerySchema.parse({ agent_id: 'agent-a' })).toEqual({
      agent_id: 'agent-a',
    });
    expect(cancelTaskQuerySchema.safeParse({ agent_id: '' }).success).toBe(false);
  });
});

describe('getTaskResponseSchema', () => {
  it('parses a minimal task shape', () => {
    const t = {
      id: 'task_01',
      session_id: 'sess_01',
      kind: 'subagent' as const,
      description: 'spin up x',
      status: 'running' as const,
      created_at: '2026-06-04T10:00:00.000Z',
      run_in_background: true,
    };
    expect(getTaskResponseSchema.parse(t).kind).toBe('subagent');
  });
});

describe('cancelTaskResultSchema', () => {
  it('requires cancelled: true literal', () => {
    expect(cancelTaskResultSchema.parse({ cancelled: true })).toEqual({ cancelled: true });
    expect(cancelTaskResultSchema.safeParse({ cancelled: false }).success).toBe(false);
  });
});

describe('taskAlreadyFinishedDataSchema (40904 envelope data)', () => {
  it('requires cancelled: false literal', () => {
    expect(taskAlreadyFinishedDataSchema.parse({ cancelled: false })).toEqual({
      cancelled: false,
    });
    expect(taskAlreadyFinishedDataSchema.safeParse({ cancelled: true }).success).toBe(
      false,
    );
  });
});

describe('whole-session agent task metadata', () => {
  it('registers only a session-addressed read in the approved connection surface', () => {
    expect(matchConnectionOperation('GET', '/api/sessions/example/agent-tasks')).toEqual({ operation: 'agentTaskList', params: { sessionId: 'example' } });
    expect(matchConnectionOperation('POST', '/api/sessions/example/agent-tasks')).toBeUndefined();
    expect(matchConnectionOperation('GET', '/api/sessions/%2Fother/agent-tasks')).toBeUndefined();
  });
  it('requires owner provenance and bounds query pages', () => {
    expect(listAgentTasksQuerySchema.parse({ page_size: '2', page_token: 'opaque' })).toEqual({ page_size: 2, page_token: 'opaque' });
    expect(listAgentTasksQuerySchema.safeParse({ page_size: 101 }).success).toBe(false);
    const task = { id: 'example', session_id: 'session', kind: 'subagent', status: 'running', description: 'example',
      created_at: '2026-06-04T10:00:00.000Z', agent_id: 'target', source: 'live' };
    expect(agentTaskSummarySchema.safeParse(task).success).toBe(false);
    expect(agentTaskSummarySchema.parse({ ...task, owner_agent_id: 'owner' })).toMatchObject({ owner_agent_id: 'owner', agent_id: 'target' });
  });
  it('distinguishes successful empty coverage, progress and failed coverage', () => {
    const empty = { items: [], owners: [{ owner_agent_id: 'main', source: 'persisted', state: 'complete' }],
      coverage: { total_owners: 1, completed_owners: 1, failed_owners: 0, pending_owners: 0, inventory_complete: true, complete: true, failures: [] },
      has_more: false, partial: false, consistency: 'incremental', started_at: '2026-06-04T10:00:00.000Z', observed_at: '2026-06-04T10:00:00.000Z' };
    expect(listAgentTasksResponseSchema.safeParse(empty).success).toBe(true);
    expect(listAgentTasksResponseSchema.safeParse({ ...empty, has_more: true }).success).toBe(false);
    expect(listAgentTasksResponseSchema.safeParse({ ...empty, coverage: { ...empty.coverage, total_owners: 2 } }).success).toBe(false);
    const progressing = { ...empty, owners: [{ ...empty.owners[0], state: 'pending' }], has_more: true, next_page_token: 'next',
      coverage: { ...empty.coverage, completed_owners: 0, pending_owners: 1, complete: false } };
    expect(listAgentTasksResponseSchema.safeParse(progressing).success).toBe(true);
    const failed = { ...empty, owners: [{ ...empty.owners[0], state: 'failed' }], partial: true,
      coverage: { ...empty.coverage, completed_owners: 0, failed_owners: 1, complete: false,
        failures: [{ stage: 'owner', owner_agent_id: 'main', message: 'Unable to read owner' }] } };
    expect(listAgentTasksResponseSchema.safeParse(failed).success).toBe(true);
  });
});
