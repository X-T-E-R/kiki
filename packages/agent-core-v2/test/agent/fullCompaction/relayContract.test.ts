import { describe, expect, it } from 'vitest';
import { buildContextCompactionShape } from '#/agent/contextMemory/compactionHandoff';
import { applyContextCompactionRecord } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { evaluateFreshEligibility } from '#/agent/fullCompaction/freshEligibility';
import { renderPendingReceipts, renderRelay, type RelayInput } from '#/agent/fullCompaction/relayPackage';
import { hashTodoNotes, mergeTodoNotes } from '#/session/todo/todoNotes';

const user = (text: string, origin?: ContextMessage['origin']): ContextMessage => ({ role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin });
const meta = { rev: 1, hash: hashTodoNotes({ next: 'act' }), writtenTurn: 4, writtenStep: 't4.1', coveredMessageId: 'toolcall:notes', windowEpoch: 0 };
const assistant: ContextMessage = { role: 'assistant', content: [], toolCalls: [{ id: 'notes', type: 'function', name: 'TodoList', arguments: '{}' }] };
const receipt = user('done with a conclusive result', { kind: 'task', taskId: 'task-1', status: 'completed', notificationId: 'n1' });
const input: RelayInput = { history: [user('initial'), assistant, receipt, user('recent')], compactCount: 3,
  sessionId: 's1', agentId: 'child', epoch: 0, turnId: 4, todos: [], notes: { next: 'act' }, meta,
  estimateText: (text) => Math.ceil(text.length / 4) };

describe('relay-v1 zero-model contract', () => {
  it('preserves exact live and wire window and does not split the tail', () => {
    const summary = renderRelay(input);
    const live = buildContextCompactionShape(input.history, { summary, contextSummary: summary, compactedCount: 3, tokensBefore: 500 });
    const replay = applyContextCompactionRecord(input.history, { summary, contextSummary: summary, compactedCount: 3,
      tokensBefore: 500, tokensAfter: live.tokensAfter, keptUserMessageCount: live.keptUserMessageCount,
      keptHeadUserMessageCount: live.keptHeadUserMessageCount, strategy: 'relay', shapeVersion: 1 });
    expect(replay).toEqual(live.messages);
    expect(summary).toContain('agent_id:"child"');
    expect(summary).toContain('old window t0–t4');
    expect(summary).toContain('turn:4');
    expect(summary).toContain('task-1');
    expect(live.messages.at(-1)).toEqual(input.history.at(-1));
  });

  it('keeps each unabsorbed receipt in newest-first order even beyond the body budget', () => {
    const older = user('x'.repeat(40_000), { kind: 'task', taskId: 'older', status: 'completed', notificationId: 'n2' });
    const recent = user('new', { kind: 'task', taskId: 'newer', status: 'completed', notificationId: 'n3' });
    const text = renderPendingReceipts({ ...input, history: [assistant, older, recent], compactCount: 3 });
    expect(text.indexOf('newer')).toBeLessThan(text.indexOf('older'));
    expect(text).toContain('older');
    expect(text).toContain('HistoryRead');
    expect(text).not.toContain('x'.repeat(20_000));
  });

  it('merges or clears notes independently and rejects oversized updates', () => {
    expect(mergeTodoNotes({ goal: 'keep', next: 'old' }, { next: 'new' })).toEqual({ goal: 'keep', next: 'new' });
    expect(mergeTodoNotes({ goal: 'keep' }, { goal: '' })).toBeUndefined();
    expect(mergeTodoNotes({ goal: 'keep' }, null)).toBeUndefined();
    expect(() => mergeTodoNotes({}, { next: 'x'.repeat(1_501) })).toThrow('1,500');
  });

  it('applies safety reasons to both choices and risk reasons to auto only', () => {
    const base = { history: input.history, compactCount: 3, notes: input.notes, meta, windowEpoch: 0,
      threshold: 100_000, projectedTokens: 10_000, historyAvailable: true,
      estimateMessage: (_message: ContextMessage) => 10 };
    expect(evaluateFreshEligibility({ ...base, strategy: 'fresh' }).eligible).toBe(true);
    expect(evaluateFreshEligibility({ ...base, strategy: 'auto', historyAvailable: false }).reasons).toContain('history_unavailable');
    expect(evaluateFreshEligibility({ ...base, strategy: 'fresh', projectedTokens: 70_000 }).reasons).toContain('projected_too_large');
    expect(evaluateFreshEligibility({ ...base, strategy: 'fresh', instruction: 'custom' }).reasons).toContain('manual_instruction');
    expect(evaluateFreshEligibility({ ...base, strategy: 'fresh', notes: undefined }).reasons).toContain('notes_missing');
    expect(evaluateFreshEligibility({ ...base, strategy: 'fresh', windowEpoch: 1 }).reasons).toContain('notes_previous_window');
    const riskHistory = [...input.history.slice(0, 3), { role: 'tool', content: [{ type: 'text', text: 'failed' }], toolCalls: [], isError: true } as ContextMessage];
    expect(evaluateFreshEligibility({ ...base, history: riskHistory, compactCount: 4, strategy: 'fresh' }).eligible).toBe(true);
    expect(evaluateFreshEligibility({ ...base, history: riskHistory, compactCount: 4, strategy: 'auto' }).eligible).toBe(false);
  });
});
