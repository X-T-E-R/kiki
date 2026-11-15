import { describe, expect, it } from 'vitest';

import type { WireRecord } from '#/wire/record';
import { reduceContextTranscript } from '#/agent/contextMemory/contextTranscript';
import { sliceMainRecordsAtTurn } from '#/workspace/sessionLifecycle/internal/forkTurnSlice';
import {
  collectPromotedDescendantIds,
  filterPromotedDescendantRecords,
  filterPromotedRecords,
  normalizePromotedDescendantMeta,
  normalizePromotedTaskDocument,
  retargetPromotedRecords,
  settlePromotedWireRecords,
  sliceSettledAgentRecords,
} from '#/workspace/sessionLifecycle/internal/promoteAgent';

function user(id: string, text: string, time: number): WireRecord {
  return {
    type: 'context.append_message',
    time,
    message: {
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    },
  };
}

function assistant(id: string, text: string, time: number): WireRecord {
  return {
    type: 'context.append_message',
    time,
    message: {
      id,
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    },
  };
}

describe('sliceMainRecordsAtTurn message boundaries', () => {
  const records: WireRecord[] = [
    { type: 'metadata', protocol_version: '1.5', created_at: 1 },
    { type: 'turn.prompt', time: 2, input: [{ type: 'text', text: 'one' }], origin: { kind: 'user' } },
    user('u1', 'one', 3),
    assistant('a1', 'reply one', 4),
    { type: 'turn.prompt', time: 5, input: [{ type: 'text', text: 'two' }], origin: { kind: 'user' } },
    user('u2', 'two', 6),
    assistant('a2', 'reply two', 7),
  ];

  it('addresses surviving turns after undo without copying a discarded prompt into an earlier turn', () => {
    const rewritten = [...records, { type: 'context.undo', count: 1, time: 8 }, user('u3', 'three', 9)];
    const earlier = sliceMainRecordsAtTurn(rewritten, 'session_test', 0);
    expect(reduceContextTranscript(earlier.records).entries.map((message) => message.id)).toEqual(['u1', 'a1']);
    const latest = sliceMainRecordsAtTurn(rewritten, 'session_test', 1, true);
    expect(latest.records.at(-1)).toEqual(rewritten.at(-1));
    expect(reduceContextTranscript(latest.records).entries.map((message) => message.id)).toEqual(['u1', 'a1', 'u3']);
    expect(latest.lastPrompt).toBe('three');
  });

  it('cuts edit and regenerate replacements at their undo fact rather than the original user record', () => {
    const replacement = {
      type: 'context.undo', count: 1, time: 8,
      replacementPrompt: { id: 'replacement', message: user('u2', 'edited', 8)['message'] },
    };
    const rewritten = [...records, replacement, assistant('a3', 'new reply', 9)];
    const sliced = sliceMainRecordsAtTurn(rewritten, 'session_test', 1, true);
    expect(sliced.records.at(-1)).toEqual(replacement);
    expect(sliced.cutoffTime).toBe(8);
    expect(sliced.lastPrompt).toBe('edited');
    const projected = reduceContextTranscript(sliced.records).entries;
    expect(projected.map((message) => message.id)).toEqual(['u1', 'a1', 'u2']);
    expect(projected.at(-1)?.content).toEqual([{ type: 'text', text: 'edited' }]);
  });

  it.each([
    { type: 'context.clear', time: 8 },
    { type: 'context.apply_compaction', compactedCount: 4, summary: 'Earlier conversation', time: 8 },
    { type: 'agent.model_switch', context: [], time: 8 },
  ])('uses the transcript undo window after $type', (reset) => {
    const rewritten = [...records, reset, user('u3', 'three', 9), { type: 'context.undo', count: 1, time: 10 }, user('u4', 'four', 11)];
    const sliced = sliceMainRecordsAtTurn(rewritten, 'session_test', 2, true);
    expect(sliced.records.at(-1)).toEqual(rewritten.at(-1));
    expect(reduceContextTranscript(sliced.records).entries.filter((message) => message.origin?.kind === 'user').map((message) => message.id)).toEqual(['u1', 'u2', 'u4']);
    expect(sliced.lastPrompt).toBe('four');
  });

  it.each([
    { type: 'context.clear', time: 8 },
    { type: 'context.apply_compaction', compactedCount: 4, summary: 'Later summary', time: 8 },
    { type: 'agent.model_switch', context: [], time: 8 },
  ])('does not inherit a later $type when forking an archived assistant', (reset) => {
    const rewritten = [...records, reset, user('u3', 'three', 9)];
    const sliced = sliceMainRecordsAtTurn(rewritten, 'session_test', 1);
    expect(sliced.records).not.toContainEqual(reset);
    expect(reduceContextTranscript(sliced.records).logicalEntries.map((message) => message.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(sliced.records.at(-1)).toEqual(records.at(-1));
  });

  it('retains exactly through a user message for an open-tail fork', () => {
    const slice = sliceMainRecordsAtTurn(records, 'session_test', 1, true);
    expect(slice.records.at(-1)).toMatchObject({
      type: 'context.append_message',
      message: { id: 'u2' },
    });
    expect(slice.records.some((record) => (record['message'] as { id?: string } | undefined)?.id === 'a2')).toBe(false);
    expect(slice.cutoffTime).toBe(6);
  });

  it('keeps the complete addressed turn for an assistant boundary', () => {
    const slice = sliceMainRecordsAtTurn(records, 'session_test', 0);
    expect(slice.records.at(-1)).toMatchObject({
      type: 'context.append_message',
      message: { id: 'a1' },
    });
    expect(slice.records.some((record) => (record['message'] as { id?: string } | undefined)?.id === 'u2')).toBe(false);
  });
});

describe('promoted subagent records', () => {
  const hash = 'a'.repeat(64);
  const parentHash = 'b'.repeat(64);
  const step = (type: 'step.begin' | 'step.end', uuid: string, turnId: number, time: number): WireRecord => ({
    type: 'context.append_loop_event', time, event: { type, uuid, turnId: String(turnId), step: 1 },
  });

  it('keeps a finished subagent journal intact and reports its last outcome', () => {
    const records: WireRecord[] = [
      user('u1', 'task', 1),
      step('step.begin', 's1', 0, 2),
      step('step.end', 's1', 0, 3),
      { type: 'turn.ended', turnId: 0, reason: 'completed', time: 4 },
    ];
    const settled = sliceSettledAgentRecords(records);
    expect(settled.records).toEqual(records);
    expect(settled.lastTurnReason).toBe('completed');
  });

  it('cuts a running subagent after its last closed step and closes the turn as cancelled', () => {
    const records: WireRecord[] = [
      user('u1', 'task', 1),
      step('step.begin', 's1', 3, 2),
      { type: 'context.append_loop_event', time: 3, event: { type: 'tool.result', toolCallId: 't1' } },
      step('step.end', 's1', 3, 4),
      step('step.begin', 's2', 3, 5),
      { type: 'context.append_loop_event', time: 6, event: { type: 'tool.call', uuid: 't2', turnId: '3' } },
    ];
    const settled = sliceSettledAgentRecords(records);
    expect(settled.records.slice(0, 4)).toEqual(records.slice(0, 4));
    expect(settled.records.at(-1)).toMatchObject({ type: 'turn.ended', turnId: 3, reason: 'cancelled', time: 4 });
    expect(settled.lastTurnReason).toBe('cancelled');
  });

  it('keeps the opening task of a subagent whose first step has not finished', () => {
    const records: WireRecord[] = [user('u1', 'task', 1), step('step.begin', 's1', 0, 2)];
    const settled = sliceSettledAgentRecords(records);
    expect(settled.records[0]).toEqual(records[0]);
    expect(settled.records.at(-1)).toMatchObject({ type: 'turn.ended', turnId: 0, reason: 'cancelled' });
  });

  it('synthesizes the next cancelled boundary when a legacy running prompt has no turn id', () => {
    const records: WireRecord[] = [
      { type: 'turn.ended', turnId: 0, reason: 'completed', time: 1 },
      { type: 'turn.prompt', time: 2, input: [{ type: 'text', text: 'next' }], origin: { kind: 'user' } },
      user('u2', 'next', 3),
    ];
    const snapshot = structuredClone(records);
    const settled = sliceSettledAgentRecords(records);
    expect(settled.records).toEqual([...records, { type: 'turn.ended', turnId: 1, reason: 'cancelled', time: 3 }]);
    expect(records).toEqual(snapshot);
  });

  it('does not treat an interrupted or failed step end as a settled tool boundary', () => {
    for (const finishReason of ['interrupted', 'error'] as const) {
      const records: WireRecord[] = [
        user('u1', 'task', 1),
        step('step.begin', 's1', 2, 2),
        step('step.end', 's1', 2, 3),
        step('step.begin', 's2', 2, 4),
        { type: 'context.append_loop_event', time: 5, event: { type: 'step.end', uuid: 's2', turnId: '2', finishReason } },
      ];
      const settled = sliceSettledAgentRecords(records);
      expect(settled.records.slice(0, 3)).toEqual(records.slice(0, 3));
      expect(settled.records.some((record) => JSON.stringify(record).includes('s2'))).toBe(false);
      expect(settled.records.at(-1)).toMatchObject({ type: 'turn.ended', turnId: 2, reason: 'cancelled', time: 3 });
    }
  });

  it('projects a blocked terminal outcome as failed session metadata', () => {
    const records: WireRecord[] = [{ type: 'turn.ended', turnId: 4, reason: 'blocked', time: 1 }];
    expect(sliceSettledAgentRecords(records).lastTurnReason).toBe('failed');
  });

  it('drops source-runtime locks and session-scoped approvals while preserving executor continuity', () => {
    const kept = filterPromotedRecords([
      user('u1', 'task', 1),
      { type: 'profile.bind', time: 2 },
      { type: 'agent.branch_sealed', sealed: true, time: 2 },
      { type: 'agent.tool_lock_changed', locked: true, time: 2 },
      { type: 'branch.base', parentAgentId: 'main', time: 2 },
      { type: 'prompt.enqueued', time: 3 },
      { type: 'task.started', time: 4 },
      { type: 'subagent.spawned', time: 5 },
      { type: 'subagent.autonomous_receipt_delivered', turnId: 0, time: 5 },
      { type: 'cron.add', time: 6 },
      { type: 'executor.session.updated', time: 7, sessionRef: { ref: { sessionId: 'remote-1' } } },
      { type: 'permission.record_approval_result', time: 8, sessionApprovalRule: 'Write', result: { decision: 'approved', scope: 'session' } },
      { type: 'permission.record_approval_result', time: 9, sessionApprovalRule: 'Write', result: { decision: 'rejected', scope: 'session' } },
      { type: 'permission.record_approval_result', time: 10, result: { decision: 'approved', scope: 'session' } },
      { type: 'permission.record_approval_result', time: 11, result: { decision: 'approved' } },
      { type: 'tools.update_store', time: 12, key: 'todo', value: [{ title: 'ship', status: 'in_progress' }] },
    ]);
    expect(kept.map((record) => record.type)).toEqual([
      'context.append_message', 'task.started', 'subagent.spawned', 'executor.session.updated',
      'permission.record_approval_result', 'permission.record_approval_result',
      'permission.record_approval_result', 'tools.update_store',
    ]);
  });

  it('collects transitive descendants and branches while reparenting direct children to main', () => {
    const collected = collectPromotedDescendantIds({
      main: { type: 'main' },
      'agent-root': { type: 'sub', delegator: { kind: 'agent', agentId: 'main' } },
      'agent-sibling': { type: 'sub', delegator: { kind: 'agent', agentId: 'main' } },
      'agent-child': { type: 'sub', delegator: { kind: 'agent', agentId: 'agent-root' } },
      'agent-branch': { type: 'sub', forkedFrom: 'agent-root', labels: { branch: 'true' } },
      'agent-grandchild': { type: 'sub', delegator: { kind: 'agent', agentId: 'agent-child' } },
      'agent-external': { type: 'sub', parentAgentId: 'agent-root', delegator: { kind: 'external', delegationId: 'ext-1' } },
    }, 'agent-root');
    expect(collected.map((item) => ({ id: item.agentId, parent: item.parentAgentId }))).toEqual([
      { id: 'agent-child', parent: 'main' },
      { id: 'agent-branch', parent: 'main' },
      { id: 'agent-grandchild', parent: 'agent-child' },
    ]);
  });

  it('reparents promoted wire records, settles open tasks and subagents, and seals open descendant state', () => {
    const mainSettled = settlePromotedWireRecords([
      {
        type: 'subagent.spawned',
        subagentId: 'agent-done',
        taskId: 'subagent-done-12345678',
        parentAgentId: 'agent-root',
        callerAgentId: 'agent-root',
        parentToolCallId: 'call-1',
        runInBackground: true,
        time: 10,
      },
      {
        type: 'subagent.completed',
        subagentId: 'agent-done',
        taskId: 'subagent-done-12345678',
        resultSummary: 'Done.',
        time: 12,
      },
      {
        type: 'subagent.spawned',
        subagentId: 'agent-open',
        taskId: 'subagent-open-87654321',
        parentAgentId: 'agent-root',
        callerAgentId: 'agent-root',
        parentToolCallId: 'call-2',
        runInBackground: true,
        time: 14,
      },
      {
        type: 'task.started',
        info: {
          taskId: 'subagent-open-87654321',
          kind: 'agent',
          agentId: 'agent-open',
          ownerAgentId: 'agent-root',
          description: 'Open child',
          status: 'running',
          startedAt: 14,
          endedAt: null,
        },
        time: 14,
      },
      {
        type: 'usage.record',
        model: 'm1',
        agentId: 'agent-root',
        parentAgentId: 'main',
        usage: { inputOther: 5, output: 3, inputCacheRead: 0, inputCacheCreation: 0 },
        time: 15,
      },
    ], { sourceRootAgentId: 'agent-root', targetAgentId: 'main' });

    expect([...mainSettled.tasks.keys()]).toEqual(['subagent-open-87654321']);
    expect(mainSettled.records[0]).toMatchObject({
      type: 'subagent.spawned',
      parentAgentId: 'main',
      callerAgentId: 'main',
    });
    expect(mainSettled.records[4]).toMatchObject({
      type: 'usage.record',
      agentId: 'main',
    });
    expect(mainSettled.records[4]!['parentAgentId']).toBeUndefined();
    expect(mainSettled.records).toContainEqual({
      type: 'task.terminated',
      info: {
        taskId: 'subagent-open-87654321',
        kind: 'agent',
        agentId: 'agent-open',
        ownerAgentId: 'main',
        description: 'Open child',
        status: 'killed',
        startedAt: 14,
        endedAt: 15,
        terminalNotificationSuppressed: true,
      },
      time: 15,
    });
    expect(mainSettled.records).toContainEqual({
      type: 'subagent.failed',
      subagentId: 'agent-open',
      taskId: 'subagent-open-87654321',
      error: 'terminated',
      time: 15,
    });

    const descendantFiltered = filterPromotedDescendantRecords([
      { type: 'profile.bind', profile: 'worker', time: 1 },
      { type: 'executor.session.updated', executorId: 'example-acp', descriptorRevision: 'r1', sessionEpoch: 1,
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-child' } }, time: 2 },
      { type: 'branch.base', version: 1, parentAgentId: 'agent-root', seed: 'verbatim', inheritedCount: 2, time: 3 },
      { type: 'turn.prompt', turnId: 0, parentReceiptManaged: false, time: 4 },
      {
        type: 'context.append_message',
        time: 5,
        message: { role: 'assistant', source: { turnId: 0 }, content: [{ type: 'text', text: 'Autonomous reply' }] },
      },
      { type: 'turn.ended', turnId: 0, reason: 'completed', time: 6 },
    ]);
    expect(descendantFiltered.some((record) => record.type === 'profile.bind')).toBe(true);
    expect(descendantFiltered.find((record) => record.type === 'executor.session.updated')).toMatchObject({
      sessionRef: { executorId: 'example-acp', version: 1, ref: { copiedIdentity: true } },
    });
    expect(JSON.stringify(descendantFiltered)).not.toContain('remote-child');

    const descendantSettled = settlePromotedWireRecords(descendantFiltered, {
      sourceRootAgentId: 'agent-root',
      targetAgentId: 'agent-branch',
      isDescendant: true,
      isUnsealedBranch: true,
    });
    expect(descendantSettled.records).toContainEqual(expect.objectContaining({
      type: 'branch.base',
      parentAgentId: 'main',
    }));
    expect(descendantSettled.records).toContainEqual({
      type: 'subagent.autonomous_receipt_delivered',
      turnId: 0,
      time: 6,
    });
    expect(descendantSettled.records).toContainEqual({
      type: 'agent.branch_sealed',
      sealed: true,
      time: 6,
    });

    const normalizedTask = normalizePromotedTaskDocument({
      taskId: 'bash-open-12345678',
      kind: 'process',
      ownerAgentId: 'agent-root',
      status: 'running',
      cleanupPending: true,
      startedAt: 10,
      endedAt: null,
    }, 'agent-root', 20);
    expect(normalizedTask).toEqual({
      taskId: 'bash-open-12345678',
      kind: 'process',
      ownerAgentId: 'main',
      status: 'killed',
      startedAt: 10,
      endedAt: 20,
      terminalNotificationSuppressed: true,
    });

    const normalizedMeta = normalizePromotedDescendantMeta({
      agentId: 'agent-open',
      parentAgentId: 'main',
      agentMeta: {
        type: 'sub',
        delegator: { kind: 'agent', agentId: 'agent-root' },
        labels: { parentAgentId: 'agent-root', requestIdentityRootAgent: 'agent-root', profileName: 'worker' },
        resultSummary: 'stale',
      },
      records: [],
      wasOpen: true,
    }, {
      sourceRootAgentId: 'agent-root',
      targetAgentHome: '/target/agents/agent-open',
      settleTime: 25,
    });
    expect(normalizedMeta).toEqual({
      type: 'sub',
      homedir: '/target/agents/agent-open',
      parentAgentId: 'main',
      delegator: { kind: 'agent', agentId: 'main' },
      status: 'cancelled',
      completedAt: 25,
      labels: {
        parentAgentId: 'main',
        requestIdentityRootAgent: 'main',
        profileName: 'worker',
      },
    });
  });

  it.each(['disk', 'wire', 'subagent'] as const)('reconciles a %s-first terminal outcome across task documents, wire, and descendant metadata', (terminalSource) => {
    const taskId = 'subagent-race-12345678';
    const info = {
      taskId, kind: 'agent', agentId: 'agent-child', ownerAgentId: 'agent-root',
      description: 'Finish slice', status: 'running', startedAt: 10, endedAt: null,
    };
    const terminal = { ...info, status: 'completed', endedAt: 20 };
    const records: WireRecord[] = [
      { type: 'subagent.spawned', subagentId: 'agent-child', taskId, time: 10 },
      { type: 'task.started', info, time: 10 },
    ];
    if (terminalSource === 'wire') records.push({ type: 'task.terminated', info: terminal, time: 20 });
    if (terminalSource === 'subagent') records.push({ type: 'subagent.completed', subagentId: 'agent-child', taskId, resultSummary: 'Slice finished.', time: 20 });
    const settled = settlePromotedWireRecords(records, {
      sourceRootAgentId: 'agent-root', targetAgentId: 'main',
      taskDocuments: new Map([[taskId, {
        info: terminalSource === 'disk' ? terminal : info,
        output: new TextEncoder().encode('Slice finished.'),
      }]]),
    });
    const outcome = settled.tasks.get(taskId)!.info;
    expect(outcome).toMatchObject({ status: 'completed', endedAt: 20, ownerAgentId: 'main', terminalNotificationSuppressed: true });
    expect(settled.records.filter((record) => record.type === 'task.terminated')).toEqual([
      expect.objectContaining({ info: outcome }),
    ]);
    expect(settled.records.filter((record) => record.type === 'subagent.completed' || record.type === 'subagent.failed')).toEqual([
      expect.objectContaining({ type: 'subagent.completed', subagentId: 'agent-child', taskId, resultSummary: 'Slice finished.', time: 20 }),
    ]);
    expect(normalizePromotedDescendantMeta({
      agentId: 'agent-child', parentAgentId: 'main',
      records: [{ type: 'turn.prompt', turnId: 0, time: 10 }], wasOpen: true,
      agentMeta: { type: 'sub', taskId, status: 'failed', error: 'stale failure' },
    }, {
      sourceRootAgentId: 'agent-root', targetAgentHome: '/target/agents/agent-child', settleTime: 30,
      outcome: settled.agentOutcomes.get('agent-child'),
    })).toMatchObject({ taskId, status: 'completed', completedAt: 20, resultSummary: 'Slice finished.', error: undefined });
  });

  it.each([{ startedAt: 20, selfReceipt: true }, { startedAt: 30, selfReceipt: false }])('preserves a newer cancelled turn starting at $startedAt over its preceding completed receipt', ({ startedAt, selfReceipt }) => {
    const taskId = 'agent-receipt-12345678';
    const resultSummary = 'Previous turn finished.';
    const records: WireRecord[] = [
      { type: 'turn.prompt', turnId: 0, time: 10 },
      { type: 'turn.ended', turnId: 0, reason: 'completed', time: 20 },
    ];
    if (selfReceipt) records.push({ type: 'subagent.completed', subagentId: 'agent-child', taskId, resultSummary, time: 20 });
    records.push(
      { type: 'turn.prompt', turnId: 1, time: startedAt },
      { type: 'turn.ended', turnId: 1, reason: 'cancelled', time: 40 },
    );
    const normalized = normalizePromotedDescendantMeta({
      agentId: 'agent-child', parentAgentId: 'main', wasOpen: true, lastTurnReason: 'cancelled', records,
      agentMeta: { type: 'sub', taskId, status: 'completed', completedAt: 20, resultSummary, error: 'stale error' },
    }, {
      sourceRootAgentId: 'agent-root', targetAgentHome: '/target/agents/agent-child', settleTime: 40,
      outcome: { taskId, status: 'completed', completedAt: 20, resultSummary },
    });
    expect(normalized).toMatchObject({ taskId, status: 'cancelled', completedAt: 40 });
    expect(normalized.resultSummary).toBeUndefined();
    expect(normalized.error).toBeUndefined();
  });

  it.each(['completed', 'failed', 'killed', 'timed_out', 'lost'])('uses the committed %s task outcome over a conflicting wire outcome', (status) => {
    const taskId = 'subagent-conflict-12345678';
    const info = {
      taskId, kind: 'agent', agentId: 'agent-child', ownerAgentId: 'agent-root',
      description: 'Historical task', status: 'completed', startedAt: 10, endedAt: 20,
    };
    const settled = settlePromotedWireRecords([
      { type: 'subagent.completed', subagentId: 'agent-child', taskId, resultSummary: 'Old result.', time: 20 },
      { type: 'task.terminated', info, time: 20 },
    ], {
      sourceRootAgentId: 'agent-root', targetAgentId: 'main',
      taskDocuments: new Map([[taskId, { info: { ...info, status, endedAt: 30, stopReason: 'Committed outcome' } }]]),
    });
    expect(settled.tasks.get(taskId)?.info).toMatchObject({ status, endedAt: 30 });
    expect(settled.records.find((record) => record.type === 'task.terminated')?.['info']).toEqual(settled.tasks.get(taskId)?.info);
    expect(settled.agentOutcomes.get('agent-child')).toMatchObject({
      status: status === 'completed' ? 'completed' : status === 'killed' ? 'cancelled' : 'failed',
      completedAt: 30,
      error: status === 'completed' ? undefined : status === 'killed' ? 'terminated' : 'Committed outcome',
    });
  });

  it('ends a delayed task start with the same reconciled terminal outcome', () => {
    const taskId = 'subagent-late-12345678';
    const info = {
      taskId, kind: 'agent', agentId: 'agent-child', ownerAgentId: 'agent-root',
      description: 'Historical task', status: 'completed', startedAt: 10, endedAt: 20,
    };
    const settled = settlePromotedWireRecords([
      { type: 'task.terminated', info, time: 20 },
      { type: 'task.started', info: { ...info, status: 'running', endedAt: null }, time: 30 },
    ], { sourceRootAgentId: 'agent-root', targetAgentId: 'main' });
    expect(settled.records.findLast((record) => record.type.startsWith('task.'))).toMatchObject({
      type: 'task.terminated', info: { taskId, status: 'completed', endedAt: 20 },
    });
    expect(settled.tasks.get(taskId)?.info).toMatchObject({ status: 'completed', endedAt: 20 });
  });

  it('points blob references at the promoted main agent and collects foreign blobs and media ids', () => {
    const home = 'C:\\kiki\\sessions\\w\\session_a\\agents\\agent-3';
    const target = 'C:\\kiki\\sessions\\w\\session_b\\agents\\main';
    const sourceMedia = 'C:\\kiki\\sessions\\w\\session_a\\media';
    const legacyMedia = 'C:\\kiki\\ephemeral\\w\\session_a\\media';
    const targetMedia = 'C:\\kiki\\sessions\\w\\session_b\\media';
    const result = retargetPromotedRecords([
      {
        type: 'context.append_message',
        time: 1,
        message: {
          role: 'user',
          content: [
            { type: 'image_url', imageUrl: { url: `blobref:agent-3:${hash}` } },
            { type: 'image_url', imageUrl: { url: `blobref:main:${parentHash}` } },
            { type: 'image_url', imageUrl: { url: `blobref:image/png;${hash}` } },
            { type: 'text', text: `see ${home}\\tool-results\\out.txt, ${sourceMedia}\\f_media1.png, ${legacyMedia}\\f_legacy1.png and f_media1` },
          ],
        },
      },
    ], 'agent-3', home, target, [sourceMedia, legacyMedia], targetMedia);
    const text = JSON.stringify(result.records[0]);
    expect(text).toContain(`blobref:main:${hash}`);
    expect(text).toContain(`blobref:main:${parentHash}`);
    expect(text).toContain(`blobref:image/png;${hash}`);
    expect(text).not.toContain('blobref:agent-3');
    expect(text).toContain('session_b\\\\agents\\\\main\\\\tool-results');
    expect(text).toContain('session_b\\\\media\\\\f_media1.png');
    expect(text).toContain('session_b\\\\media\\\\f_legacy1.png');
    expect(text).not.toContain('session_a\\\\media');
    expect(text).not.toContain('ephemeral');
    expect(result.foreignBlobs).toEqual([{ agentId: 'main', hash: parentHash }]);
    expect(result.fileIds.has('f_media1')).toBe(true);
  });
});
