import { describe, expect, it } from 'vitest';

import type { WireRecord } from '#/wire/record';
import { sliceMainRecordsAtTurn } from '#/workspace/sessionLifecycle/internal/forkTurnSlice';
import {
  filterPromotedRecords,
  retargetPromotedRecords,
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

  it('drops source-runtime records, the remote executor session and actual session-scoped approval grants', () => {
    const kept = filterPromotedRecords([
      user('u1', 'task', 1),
      { type: 'profile.bind', time: 2 },
      { type: 'prompt.enqueued', time: 3 },
      { type: 'task.started', time: 4 },
      { type: 'subagent.spawned', time: 5 },
      { type: 'cron.add', time: 6 },
      { type: 'executor.session.updated', time: 7, sessionRef: { ref: { sessionId: 'remote-1' } } },
      { type: 'permission.record_approval_result', time: 8, sessionApprovalRule: 'Write', result: { decision: 'approved', scope: 'session' } },
      { type: 'permission.record_approval_result', time: 9, sessionApprovalRule: 'Write', result: { decision: 'rejected', scope: 'session' } },
      { type: 'permission.record_approval_result', time: 10, result: { decision: 'approved', scope: 'session' } },
      { type: 'permission.record_approval_result', time: 11, result: { decision: 'approved' } },
      { type: 'tools.update_store', time: 12, key: 'todo', value: [{ title: 'ship', status: 'in_progress' }] },
    ]);
    expect(kept.map((record) => record.type)).toEqual([
      'context.append_message', 'permission.record_approval_result', 'permission.record_approval_result',
      'permission.record_approval_result', 'tools.update_store',
    ]);
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
