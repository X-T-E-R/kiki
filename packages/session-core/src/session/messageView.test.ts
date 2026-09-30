import { describe, expect, it } from 'vitest';
import { personaGreeting, projectMessageView, projectSendMessage } from './messageView';
import type { Block, ToolBlock } from './transcript';

function tool(overrides: Partial<ToolBlock> = {}): ToolBlock {
  return { kind: 'tool', id: 'tool-call', toolCallId: 'call', name: 'SendMessage',
    args: { text: 'Delivered words', reply_to: 'user-1' }, argsText: '', display: undefined,
    description: undefined, status: 'done', output: JSON.stringify({ message_id: 'msg_1', delivered_to: ['user'] }),
    isError: false, durationMs: 20, durationSource: 'frame', progressText: undefined, turnId: 't1', ...overrides };
}
const thought: Block = { kind: 'assistant', id: 'internal', text: 'Private deliberation', streaming: false,
  createdAt: '2026-01-01T00:00:00Z', turnId: 't1' };

describe('SendMessage projection', () => {
  it('retains the call identity through streaming, success, and reconnect replay', () => {
    const pending = projectSendMessage(tool({ status: 'running', output: undefined, args: undefined,
      argsText: '{"text":"Hel' }))!;
    expect(pending.status).toBe('sending');
    expect(pending.messageId).toBeUndefined();
    expect(pending.sourceTool?.argsText).toBe('{"text":"Hel');
    const sent = projectSendMessage(tool())!;
    expect(sent.id).toBe(pending.id);
    expect(sent.messageId).toBe('msg_1');
    expect(sent.text).toBe('Delivered words');
    expect(sent.replyTo).toBe('user-1');
    expect(projectSendMessage(tool())).toEqual(sent);
  });

  it('requires a successful receipt and never exposes failed/cancelled drafts as sent speech', () => {
    for (const call of [tool({ status: 'error' }), tool({ status: 'stopped' }), tool({ output: '{}' }), tool({ isError: true })]) {
      const result = projectSendMessage(call)!;
      expect(['failed', 'cancelled']).toContain(result.status);
      expect(result.text).toBe('');
      expect(result.deliveredTo).toEqual([]);
      expect(result.attachments).toEqual([]);
    }
    expect(projectSendMessage(tool({ name: 'Read' }))).toBeUndefined();
  });

  it('takes immutable attachments and handoff identity from the receipt, not untrusted input paths', () => {
    const result = projectSendMessage(tool({ args: { text: 'Review this', attachments: [{ path: '/mutable/file' }] },
      output: { message_id: 'msg_2', delivered_to: ['reviewer'], sender: { persona_id: 'author', name: 'Author', session_id: 's1' },
        attachments: [{ blob_id: 'blob-1', path: 'report.md', title: 'Report', mime_type: 'text/markdown', size: 12 }],
        handoff: { target_persona_id: 'reviewer', target_session_id: 's2', target_name: 'Reviewer', message_id: 'mail-1' } } }))!;
    expect(result.attachments).toEqual([{ blobId: 'blob-1', path: 'report.md', title: 'Report', mimeType: 'text/markdown', size: 12 }]);
    expect(result.personaId).toBe('author');
    expect(result.handoff?.targetSessionId).toBe('s2');
  });
});

describe('message view', () => {
  it('hides ordinary assistant output, keeps process inspectable, and shows no reply only at an actual terminal turn', () => {
    const live = projectMessageView([thought]);
    expect(live.map((node) => node.kind)).toEqual(['activity-summary']);
    const done = projectMessageView([thought], { completedTurnIds: ['t1'], personaName: 'Coordinator' });
    expect(done.map((node) => node.kind)).toEqual(['activity-summary', 'notice']);
    expect(done[0]?.kind === 'activity-summary' && done[0].members).toEqual([thought]);
    expect(done[1]?.kind === 'notice' && done[1].reasonCodes).toEqual(['message.no_reply']);
    expect(projectMessageView([thought, tool()], { completedTurnIds: ['t1'] }).map((node) => node.kind))
      .toEqual(['activity-summary', 'message']);
  });

  it('groups only contiguous process within a turn and keeps measured counts in agreement', () => {
    const read = tool({ id: 'read', toolCallId: 'read', name: 'Read' });
    const memory = tool({ id: 'memory', toolCallId: 'memory', name: 'MemoryWrite', durationSource: 'turn', durationMs: 500 });
    const blocks: Block[] = [read, memory, { kind: 'shell', id: 'shell', commandId: 'shell', command: 'echo ok', output: 'ok',
      done: true, isError: false, turnId: 't1' }, tool(), { ...read, id: 'read2', turnId: 't2' }];
    const view = projectMessageView(blocks);
    expect(view.map((node) => node.kind)).toEqual(['activity-summary', 'message', 'activity-summary']);
    const summary = view[0]!;
    expect(summary.kind).toBe('activity-summary');
    if (summary.kind !== 'activity-summary') throw new Error('Expected summary');
    expect(summary.members).toEqual(blocks.slice(0, 3));
    expect(summary.counts).toEqual({ tools: 2, reads: 1, commands: 1, thinking: 0, subagents: 0, memories: 1 });
    expect(summary.durationMs).toBe(20);
    expect(summary.turnId).toBe('t1');
  });

  it('keeps questions, approvals and terminal failures visible and has no data mutation when switching views', () => {
    const failed: Block = { kind: 'notice', id: 'failure', tone: 'danger', text: 'Provider failed', turnId: 't1' };
    const blocks = [thought, tool(), failed];
    const before = structuredClone(blocks);
    const first = projectMessageView(blocks);
    expect(first.map((node) => node.kind)).toEqual(['activity-summary', 'message', 'notice']);
    expect(projectMessageView(blocks)).toEqual(first);
    expect(blocks).toEqual(before);
  });

  it('creates only local greeting speech, with no turn or tool execution identity', () => {
    expect(personaGreeting({ id: 'author', name: 'Author' })).toBeUndefined();
    const greeting = personaGreeting({ id: 'author', name: 'Author', greeting: 'Welcome' })!;
    expect(greeting.origin).toBe('persona_greeting');
    expect(greeting.status).toBe('sent');
    expect(greeting.turnId).toBeUndefined();
    expect(greeting.sourceTool).toBeUndefined();
  });
});
