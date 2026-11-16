import { describe, expect, it } from 'vitest';

import { visibleReplyMessages } from '../../../src/services/imSession/host';

describe('visible IM reply messages', () => {
  it.each([undefined, 14])('bounds five steered prompts without stopping at internal records (%s)', (turnId) => {
    const messages = [
      ...Array.from({ length: 5 }, (_, index) => ({ id: `P${index + 1}`, role: 'user', origin: { kind: 'user' }, source: { turnId } })),
      ...['branch_fold', 'retry', 'injection', 'task', 'hook_result', 'compaction_summary', 'system_trigger', 'skill_activation', 'plugin_command', 'shell_command', 'cron_missed'].map(kind => ({ id: kind, role: 'user', origin: { kind }, source: { turnId } })),
      { id: 'final', role: 'assistant', source: { turnId } },
    ];
    for (let index = 1; index < 5; index++) expect(visibleReplyMessages(messages, `P${index}`, turnId)).toEqual([]);
    expect(visibleReplyMessages(messages, 'P5', turnId).map(message => message.id)).toEqual(['final']);
  });

  it('keeps the pre-steer reply with its original prompt', () => {
    const messages = [
      { id: 'P1', role: 'user', source: { turnId: 14 } },
      { id: 'first', role: 'assistant', source: { turnId: 14 } },
      { id: 'P2', role: 'user', source: { turnId: 14 } },
      { id: 'final', role: 'assistant', source: { turnId: 14 } },
    ];
    expect(visibleReplyMessages(messages, 'P1', 14).map(message => message.id)).toEqual(['first']);
  });

  it('does not claim a compacted prompt when a newer prompt survives', () => {
    const messages = [
      { id: 'P2', role: 'user', source: { turnId: 14 }, origin: { kind: 'user' } },
      { id: 'final', role: 'assistant', source: { turnId: 14 } },
    ];
    expect(visibleReplyMessages(messages, 'P1', 14)).toEqual([]);
  });

  it('allows only the latest prompt to claim orphan replies after compaction', () => {
    const messages = [
      { role: 'user', origin: { kind: 'compaction_summary' } },
      { id: 'final', role: 'assistant', source: { turnId: 14 } },
    ];
    expect(visibleReplyMessages(messages, 'P1', 14, 'P5')).toEqual([]);
    expect(visibleReplyMessages(messages, 'P5', 14, 'P5').map(message => message.id)).toEqual(['final']);
  });

  it.each([
    { delivered_to: ['user'] },
    { messages: [{ delivered_to: ['Peer Bot'] }, { delivered_to: ['user'] }] },
  ])('suppresses fallback text and media after confirmed delivery: %j', output => {
    const messages = sendMessages(output);
    expect(visibleReplyMessages(messages, 'P1', 14)).toEqual([]);
  });

  it.each([
    { output: { delivered_to: ['Peer Bot'] }, isError: false },
    { output: { delivered_to: ['user'] }, isError: true },
    { output: { delivered_to: [] }, isError: false },
  ])('preserves fallback after handoff or failure: %j', ({ output, isError }) => {
    const messages = sendMessages(output, isError);
    expect(visibleReplyMessages(messages, 'P1', 14).map(message => message.id)).toEqual(['send', 'closing']);
  });

  it('does not suppress a later steered prompt after an earlier SendMessage', () => {
    const messages = [
      ...sendMessages({ delivered_to: ['user'] }),
      { id: 'P2', role: 'user', source: { turnId: 14 } },
      { id: 'ordinary', role: 'assistant', source: { turnId: 14 } },
    ];
    expect(visibleReplyMessages(messages, 'P2', 14).map(message => message.id)).toEqual(['ordinary']);
  });

  it('ignores unrelated tool receipts and invalid JSON', () => {
    const messages = sendMessages({ delivered_to: ['user'] });
    const tool = messages[2]!;
    expect(visibleReplyMessages([...messages.slice(0, 2), { ...tool, toolCallId: 'other' }, messages[3]!], 'P1', 14)).toHaveLength(2);
    expect(visibleReplyMessages([...messages.slice(0, 2), { ...tool, content: [{ type: 'text', text: 'failed' }] }, messages[3]!], 'P1', 14)).toHaveLength(2);
  });
  it('returns the assistant text for the prompt turn after an injected reminder', () => {
    const messages = [
      { id: 'im:1', role: 'user', origin: { kind: 'user' }, source: { turnId: 0 }, content: [{ type: 'text', text: 'turn-hello' }] },
      { id: 'reminder', role: 'user', origin: { kind: 'injection', variant: 'runtime_snapshot' }, content: [{ type: 'text', text: '<system-reminder>\nworkspace\n</system-reminder>' }] },
      { id: 'assistant', role: 'assistant', source: { turnId: 0 }, content: [{ type: 'text', text: 'reply-turn-hello' }] },
    ];
    expect(visibleReplyMessages(messages, 'im:1').map((item) => item.content[0]?.text)).toEqual(['reply-turn-hello']);
  });

  it.each([undefined, 0])('does not fall back to another turn when the requested turn has no reply (%s)', (turnId) => {
    const messages = [
      { id: 'im:1', role: 'user', source: { turnId: 0 } },
      { id: 'other-reply', role: 'assistant', source: { turnId: 1 } },
    ];
    expect(visibleReplyMessages(messages, 'im:1', turnId)).toEqual([]);
  });

  it('skips an injection when the prompt has no turn id yet and stops at the next person', () => {
    const messages = [
      { id: 'im:1', role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'a' }] },
      { id: 'reminder', role: 'user', origin: { kind: 'injection' }, content: [{ type: 'text', text: '<system-reminder>\nx\n</system-reminder>' }] },
      { id: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'one' }] },
      { id: 'im:2', role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'b' }] },
      { id: 'later', role: 'assistant', content: [{ type: 'text', text: 'two' }] },
    ];
    expect(visibleReplyMessages(messages, 'im:1').map((item) => item.id)).toEqual(['assistant']);
  });

  it('returns only assistant replies generated after an accepted steer prompt in the same turn', () => {
    const messages = [
      { id: 'im:1', role: 'user', origin: { kind: 'user' }, source: { turnId: 0 }, content: [{ type: 'text', text: 'first' }] },
      { id: 'step-1', role: 'assistant', source: { turnId: 0 }, content: [{ type: 'text', text: 'step-one-reply' }] },
      { id: 'im:2', role: 'user', origin: { kind: 'user' }, source: { turnId: 0 }, content: [{ type: 'text', text: 'steered' }] },
      { id: 'reminder', role: 'user', origin: { kind: 'injection' }, content: [{ type: 'text', text: '<system-reminder>\nx\n</system-reminder>' }] },
      { id: 'step-2', role: 'assistant', source: { turnId: 0 }, content: [{ type: 'text', text: 'step-two-reply' }] },
      { id: 'turn-1', role: 'assistant', source: { turnId: 1 }, content: [{ type: 'text', text: 'other-turn' }] },
    ];
    expect(visibleReplyMessages(messages, 'im:2', 0).map((item) => item.id)).toEqual(['step-2']);
    expect(visibleReplyMessages(messages, 'im:2').map((item) => item.id)).toEqual(['step-2']);
  });
});

function sendMessages(output: unknown, isError = false) {
  return [
    { id: 'P1', role: 'user', source: { turnId: 14 } },
    { id: 'send', role: 'assistant', source: { turnId: 14 }, toolCalls: [{ id: 'call', function: { name: 'SendMessage' } }, { id: 'edit', name: 'Edit' }] },
    { role: 'tool', toolCallId: 'call', source: { turnId: 14 }, isError, content: [{ type: 'text', text: JSON.stringify(output) }] },
    { id: 'closing', role: 'assistant', source: { turnId: 14 }, content: [{ type: 'text', text: 'See the delivery above.' }, { type: 'image_url' }] },
  ];
}
