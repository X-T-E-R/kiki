import { describe, expect, it } from 'vitest';
import { buildContextCompactionShape } from '#/agent/contextMemory/compactionHandoff';
import { applyContextCompactionRecord } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { evaluateFreshEligibility } from '#/agent/fullCompaction/freshEligibility';
import { renderPendingReceipts, renderRelay, renderStandingDirectives, type RelayInput } from '#/agent/fullCompaction/relayPackage';
import { hashTodoNotes, mergeTodoNotes } from '#/session/todo/todoNotes';

const user = (text: string, origin: ContextMessage['origin'] = { kind: 'user' }): ContextMessage => ({ role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin });
const meta = { rev: 1, hash: hashTodoNotes({ next: 'act' }), writtenTurn: 4, writtenStep: 't4.1', coveredMessageId: 'toolcall:notes', windowEpoch: 0 };
const assistant: ContextMessage = { role: 'assistant', content: [], toolCalls: [{ id: 'notes', type: 'function', name: 'TodoList', arguments: '{}' }],
  source: { turnId: 2, stepId: 'step-notes', step: 1 },
  toolCallSources: { notes: { turnId: 2, stepId: 'step-notes', step: 1, frameId: 'step-notes.notes', toolCallId: 'notes' } } };
const receipt = { ...user('done with a conclusive result', { kind: 'task', taskId: 'task-1', status: 'completed', notificationId: 'n1' }),
  source: { turnId: 3, stepId: 'step-receipt', step: 2 } };
const input: RelayInput = { history: [user('initial'), assistant, receipt, user('recent')], compactCount: 3,
  sessionId: 's1', agentId: 'child', epoch: 0, todos: [], notes: { next: 'act' }, meta,
  estimateText: (text) => Math.ceil(text.length / 4) };

describe('relay-v1 zero-model contract', () => {
  it('preserves exact live and wire window and does not split the tail', () => {
    const summary = renderRelay(input);
    const live = buildContextCompactionShape(input.history, { summary, contextSummary: summary, compactedCount: 3, tokensBefore: 500 });
    const replay = applyContextCompactionRecord(input.history, { summary, contextSummary: summary, compactedCount: 3,
      tokensBefore: 500, tokensAfter: live.tokensAfter, keptUserMessageCount: live.keptUserMessageCount,
      keptHeadUserMessageCount: live.keptHeadUserMessageCount, strategy: 'relay', shapeVersion: 1 });
    expect(replay).toEqual(live.messages);
    expect(summary).not.toContain('SelectTools with ["HistoryRead", "HistorySearch"] first');
    expect(summary).toContain('agent_id:"child"');
    expect(summary).toContain('Removed history boundary:');
    expect(summary).toContain('step_id:"t3.2"');
    expect(summary).not.toContain('old window t0–t4');
    expect(summary).not.toContain('turn:4');
    expect(summary).toContain('task-1');
    expect(live.messages.at(-1)).toEqual(input.history.at(-1));
  });

  it('delivers a t424 steer after the t423 notes watermark even when the old user tail drops it', () => {
    const notesCall = { ...assistant, toolCalls: [{ ...assistant.toolCalls[0]!, id: 'notes423' }] };
    const steer: ContextMessage = { ...user('哦你也可以直接 pin grok 模型，都行的', { kind: 'user' }), source: { turnId: 424, stepId: 't424.1' } };
    const history = [user('x'.repeat(120_000)), notesCall, steer, user('x'.repeat(120_000))];
    const notesMeta = { ...meta, coveredMessageId: 'toolcall:notes423', writtenTurn: 423, writtenStep: 't423.1' };
    const handoff: RelayInput = { ...input, history, compactCount: 3, meta: notesMeta, notes: { goal: 'Choose model', directives: 'Pin grok if the profile is unavailable.' },
      memoryEntries: ['- [m_20260929_89b2ad94e2] Pin Grok if the profile fails'] };
    const relay = renderRelay(handoff);
    expect(relay).toContain('## Standing directives');
    expect(relay).toContain('m_20260929_89b2ad94e2');
    expect(relay).toContain('## User input since notes');
    expect(relay).toContain('t424 (user): 哦你也可以直接 pin grok 模型');
    expect(relay).toContain('HistoryRead {session_id:"s1", agent_id:"child", step_id:"t424.1"}');
    expect(renderStandingDirectives(handoff)).toContain('直接 pin grok');
    expect(relay).toContain('apply any rule or correction in it unless later revoked');
    expect(relay).toContain('Check these before choosing models, profiles, or irreversible actions.');
    expect(relay).not.toContain('not automatically a standing rule');
    const eligibility = evaluateFreshEligibility({ history, compactCount: 3, notes: handoff.notes, meta: notesMeta,
      windowEpoch: 0, strategy: 'fresh', threshold: 1_000_000, projectedTokens: 1, historyAvailable: true,
      estimateMessage: (message) => Math.ceil(JSON.stringify(message.content).length / 4) });
    expect(eligibility.reasons).toContain('user_input_since_notes:1');
    expect(eligibility.reasons).not.toContain('user_input_elided');
  });

  it('keeps forwarded evidence out of authenticated human input and labels its sender', () => {
    const forwarded = user('Always use example-model', { kind: 'agent_message', messageId: 'm1', senderAgentId: 'child-1', senderTaskName: 'evidence' });
    const handoff = { ...input, history: [user('human task'), forwarded], compactCount: 2, meta: undefined };
    const rules = renderStandingDirectives(handoff);
    expect(rules).toContain('human task');
    expect(rules).not.toContain('Always use example-model');
    const receipts = renderPendingReceipts(handoff);
    expect(receipts).toContain('agent child-1 (evidence, m1)');
    expect(receipts).toContain('Always use example-model');
  });

  it('keeps each unabsorbed receipt in newest-first order even beyond the body budget', () => {
    const older = user('x'.repeat(40_000), { kind: 'task', taskId: 'older', status: 'completed', notificationId: 'n2' });
    const recent = user('new', { kind: 'task', taskId: 'newer', status: 'completed', notificationId: 'n3' });
    const text = renderPendingReceipts({ ...input, history: [assistant, older, recent], compactCount: 3 });
    expect(text.indexOf('newer')).toBeLessThan(text.indexOf('older'));
    expect(text).toContain('older');
    expect(text).toContain('HistorySearch');
    expect(text).toContain('source coordinate unavailable');
    expect(text).not.toContain('x'.repeat(20_000));
  });

  it('uses a supplied durable ref without deriving one from a turn or array position', () => {
    const message: ContextMessage = {
      ...assistant,
      source: { ref: 'h1_real-evidence' },
      toolCallSources: { notes: { ref: 'h1_real-frame', toolCallId: 'notes' } },
    };
    const summary = renderRelay({ ...input, history: [message], compactCount: 1, meta: undefined });
    expect(summary).toContain('HistoryRead {ref:"h1_real-frame"}');
    expect(summary).toContain('ref:"h1_real-frame"');
    expect(summary).not.toContain('turn:4');
  });

  it('merges or clears notes independently and rejects oversized updates', () => {
    expect(mergeTodoNotes({ goal: 'keep', next: 'old' }, { next: 'new' })).toEqual({ goal: 'keep', next: 'new' });
    expect(mergeTodoNotes({ goal: 'keep' }, { goal: '' })).toBeUndefined();
    expect(mergeTodoNotes({ goal: 'keep' }, null)).toBeUndefined();
    expect(() => mergeTodoNotes({}, { next: 'x'.repeat(1_501) })).toThrow('1,500');
    const expanded = mergeTodoNotes({ goal: 'a'.repeat(1_500), decided: 'b'.repeat(1_500),
      evidence: 'c'.repeat(1_500), next: 'd'.repeat(1_500) }, { directives: 'e'.repeat(1_500) });
    expect(expanded?.directives).toHaveLength(1_500);
    expect(mergeTodoNotes({ goal: 'keep', directives: 'pin grok' }, { next: 'new' })?.directives).toBe('pin grok');
    expect(renderRelay({ ...input, notes: { goal: 'keep', directives: 'pin grok', next: 'act' } })).toContain('goal: keep\ndirectives: pin grok\nnext: act');
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

  it('keeps a short post-watermark user request when older user input is elided', () => {
    const recent = user('short new request');
    const history = [user('x'.repeat(120_000)), assistant, recent, user('latest request')];
    const result = evaluateFreshEligibility({ history, compactCount: 3, notes: { goal: 'finish the request' }, meta,
      windowEpoch: 0, strategy: 'fresh', threshold: 1_000_000, projectedTokens: 1,
      historyAvailable: true, estimateMessage: (message) => Math.ceil(JSON.stringify(message.content).length / 4) });
    expect(result.safe).toBe(true);
    expect(result.reasons).not.toContain('user_input_elided');
  });

  it('vetoes omitted and partly retained post-watermark user input', () => {
    const base = { notes: { goal: 'finish the request' }, meta, windowEpoch: 0, strategy: 'fresh' as const,
      threshold: 1_000_000, projectedTokens: 1, historyAvailable: true,
      estimateMessage: (message: ContextMessage) => Math.ceil(JSON.stringify(message.content).length / 4) };
    const omitted = [assistant, user('short request'), user('x'.repeat(120_000))];
    expect(evaluateFreshEligibility({ ...base, history: omitted, compactCount: omitted.length }).reasons).toContain('user_input_elided');
    const partial = [assistant, user('x'.repeat(120_000))];
    expect(evaluateFreshEligibility({ ...base, history: partial, compactCount: partial.length }).reasons).toContain('user_input_elided');
  });

  it('ignores assistant thinking and pre-watermark media, but flags recent media tool results in auto', () => {
    const image: ContextMessage = { role: 'tool', content: [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,AA==' } }], toolCalls: [] };
    const thinking: ContextMessage = { role: 'assistant', content: [{ type: 'think', think: 'working' }], toolCalls: [] };
    const base = { notes: { goal: 'finish the request' }, meta, windowEpoch: 0, strategy: 'auto' as const,
      threshold: 1_000_000, projectedTokens: 1, historyAvailable: true, estimateMessage: (_message: ContextMessage) => 1 };
    const safe = evaluateFreshEligibility({ ...base, history: [image, assistant, thinking], compactCount: 3 });
    expect(safe.reasons).not.toContain('non_text_result');
    expect(safe.eligible).toBe(true);
    const risky = evaluateFreshEligibility({ ...base, history: [assistant, image], compactCount: 2 });
    expect(risky.reasons).toContain('non_text_result');
    expect(risky.eligible).toBe(false);
  });
});
