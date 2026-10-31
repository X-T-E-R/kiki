import { describe, expect, it } from 'vitest';

import type { Task } from '@kiki/protocol';
import type { AgentReference } from '@kiki/transcript';

import { agentRefDelegation, agentRefsOfBlock, replaceAgentRefs } from './agentReferences';
import type { UserBlock } from './transcript/types';

const MESSAGE_ID = 'msg-1';

function reference(profile: string, refId = `ar:${MESSAGE_ID}:${profile}`): AgentReference {
  return { refId, profile, executor: 'native', configuration: 'native', label: profile };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    session_id: 'session_1',
    kind: 'subagent',
    description: 'Delegate',
    status: 'running',
    created_at: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('agentRefsOfBlock', () => {
  it('reads the structured references a user origin carries', () => {
    const refs = [reference('worker'), reference('reviewer')];
    const block = { sourceOrigin: { kind: 'user', agentRefs: refs } } as unknown as Pick<UserBlock, 'sourceOrigin'>;
    expect(agentRefsOfBlock(block)).toEqual(refs);
  });

  it('returns an empty list for a plain user message', () => {
    expect(agentRefsOfBlock({ sourceOrigin: { kind: 'user' } } as unknown as Pick<UserBlock, 'sourceOrigin'>)).toEqual([]);
    expect(agentRefsOfBlock({ sourceOrigin: undefined } as unknown as Pick<UserBlock, 'sourceOrigin'>)).toEqual([]);
  });

  it('drops a malformed agentRefs payload instead of trusting it', () => {
    const block = { sourceOrigin: { kind: 'user', agentRefs: [{ refId: 1 }] } } as unknown as Pick<UserBlock, 'sourceOrigin'>;
    expect(agentRefsOfBlock(block)).toEqual([]);
  });
});

describe('agentRefDelegation', () => {
  const ref = reference('worker');

  it('delegates to the child a matching task names', () => {
    const match = task({ source_ref: { ...ref, messageId: MESSAGE_ID }, agent_id: 'agent-child-1' });
    expect(agentRefDelegation(ref, [match], MESSAGE_ID)).toEqual({
      status: 'delegated',
      agentId: 'agent-child-1',
      taskId: 'task-1',
      runs: [{ agentId: 'agent-child-1', taskId: 'task-1', startedAt: undefined }],
    });
  });

  it('is pending when no task names the ref', () => {
    expect(agentRefDelegation(ref, [], MESSAGE_ID)).toEqual({ status: 'pending' });
    expect(agentRefDelegation(ref, [task({ source_ref: undefined })], MESSAGE_ID)).toEqual({ status: 'pending' });
  });

  it('is rejected when the matching run never produced a child or failed to start', () => {
    const noAgent = task({ source_ref: { ...ref, messageId: MESSAGE_ID }, agent_id: undefined });
    expect(agentRefDelegation(ref, [noAgent], MESSAGE_ID)).toEqual({ status: 'rejected' });
    const failed = task({ source_ref: { ...ref, messageId: MESSAGE_ID }, agent_id: 'agent-x', status: 'failed' });
    expect(agentRefDelegation(ref, [failed], MESSAGE_ID)).toEqual({ status: 'rejected' });
  });

  it('prefers the run on the same message when several messages share a profile', () => {
    const other = task({ id: 'task-other', source_ref: { ...ref, messageId: 'msg-other' }, agent_id: 'agent-other' });
    const own = task({ id: 'task-own', source_ref: { ...ref, messageId: MESSAGE_ID }, agent_id: 'agent-own' });
    expect(agentRefDelegation(ref, [other, own], MESSAGE_ID)).toEqual({
      status: 'delegated',
      agentId: 'agent-own',
      taskId: 'task-own',
      runs: [{ agentId: 'agent-own', taskId: 'task-own', startedAt: undefined }],
    });
  });

  it('jumps to the most recent child and lists every run when one reference ran several', () => {
    const older = task({ id: 'task-older', source_ref: { ...ref, messageId: MESSAGE_ID }, agent_id: 'agent-older', started_at: '2026-01-01T10:00:00.000Z' });
    const newer = task({ id: 'task-newer', source_ref: { ...ref, messageId: MESSAGE_ID }, agent_id: 'agent-newer', started_at: '2026-01-01T12:00:00.000Z' });
    const delegation = agentRefDelegation(ref, [older, newer], MESSAGE_ID);
    expect(delegation).toEqual({
      status: 'delegated',
      agentId: 'agent-newer',
      taskId: 'task-newer',
      runs: [
        { agentId: 'agent-newer', taskId: 'task-newer', startedAt: '2026-01-01T12:00:00.000Z' },
        { agentId: 'agent-older', taskId: 'task-older', startedAt: '2026-01-01T10:00:00.000Z' },
      ],
    });
  });
});

describe('replaceAgentRefs', () => {
  it('turns each reference into @profile for a one-line summary', () => {
    expect(replaceAgentRefs('让 kiki://agents/worker 接着扫,再叫 kiki://agents/reviewer 复核。')).toBe('让 @worker 接着扫,再叫 @reviewer 复核。');
  });

  it('leaves text without references untouched', () => {
    expect(replaceAgentRefs('no links here')).toBe('no links here');
  });
});
