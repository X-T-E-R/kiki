import { describe, expect, it } from 'vitest';
import { personaGreeting, projectMessageView, projectSendMessage, projectSendMessages } from './messageView';
import type { AssistantBlock, Block, ToolBlock, UserBlock } from './transcript';

function tool(overrides: Partial<ToolBlock> = {}): ToolBlock {
  return { kind: 'tool', id: 'tool-call', toolCallId: 'call', name: 'SendMessage',
    args: { text: 'Delivered words', reply_to: 'user-1' }, argsText: '', display: undefined,
    description: undefined, status: 'done', output: JSON.stringify({ message_id: 'msg_1', delivered_to: ['user'] }),
    isError: false, durationMs: 20, durationSource: 'frame', progressText: undefined, turnId: 't1', ...overrides };
}
const thought: Block = { kind: 'assistant', id: 'internal', text: 'Private deliberation', streaming: false,
  createdAt: '2026-01-01T00:00:00Z', turnId: 't1' };

function reply(id: string, text: string, turnId: string, overrides: Partial<AssistantBlock> = {}): AssistantBlock {
  return { kind: 'assistant', id, text, streaming: false, createdAt: '2026-01-01T00:00:01Z', turnId, ...overrides };
}

describe('SendMessage projection', () => {
  it('projects explicit batches as independent bubbles with immutable media and per-item outcomes', () => {
    const original = tool({ args: { messages: [{ text: 'one\ntwo' }, { text: 'media' }, { text: 'uncertain' }, { text: 'not sent' }] }, output: { messages: [
      { index: 0, message_id: 'send:call:item:0', delivered_to: ['user'], channels: [{ channel_id: 'internal', status: 'delivered' }] },
      { index: 1, message_id: 'send:call:item:1', delivered_to: ['user'], channels: [{ channel_id: 'internal', status: 'delivered' }, { channel_id: 'im:b1', status: 'partial' }], attachments: [{ blob_id: 'voice-1', path: '/media/voice.ogg', kind: 'voice', mime_type: 'audio/ogg' }] },
      { index: 2, message_id: 'send:call:item:2', delivered_to: [], delivery: 'pending', channels: [{ channel_id: 'im:b1', status: 'unknown' }] },
      { index: 3, message_id: 'send:call:item:3', delivered_to: [], delivery: 'not_sent', detail: 'Stopped before sending' },
    ] } });
    const messages = projectSendMessages(original);
    expect(messages.map((item) => [item.id, item.messageId, item.status, item.text])).toEqual([
      ['tool-call:message:0', 'send:call:item:0', 'sent', 'one\ntwo'],
      ['tool-call:message:1', 'send:call:item:1', 'sent', 'media'],
      ['tool-call:message:2', 'send:call:item:2', 'pending', 'uncertain'],
      ['tool-call:message:3', 'send:call:item:3', 'failed', ''],
    ]);
    expect(messages[1]!.attachments[0]).toMatchObject({ blobId: 'voice-1', kind: 'voice' });
    expect(messages[1]!.channels?.[1]?.status).toBe('partial');
    expect(messages[3]!.failureDetail).toBe('Stopped before sending');
    expect(messages.every((item) => item.sourceTool === original)).toBe(true);
    expect(projectMessageView([original]).map((item) => item.id)).toEqual(messages.map((item) => item.id));
    expect(projectSendMessage(original)).toEqual(messages[0]);
  });
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

describe('SendMessage channel receipts', () => {
  function received(value: Record<string, unknown>): ToolBlock {
    return tool({ output: JSON.stringify(value) });
  }
  const picture = { blob_id: 'blob-1', path: '/media/a.png', title: 'a.png', mime_type: 'image/png', size: 12, kind: 'image' };
  const voice = { blob_id: 'blob-2', path: '/media/note.wav', title: 'note.wav', mime_type: 'audio/wav', size: 40, kind: 'voice' };

  it('keeps a receipt with no channels on its old reading and claims no destination', () => {
    const legacy = projectSendMessage(tool())!;
    expect(legacy.status).toBe('sent');
    expect(legacy.channels).toBeUndefined();
    expect(legacy.reached).toBeUndefined();
    expect(legacy.deliveredTo).toEqual(['user']);
  });

  it('speaks here only when this conversation’s own channel delivered', () => {
    const here = projectSendMessage(received({
      message_id: 'send:call', delivered_to: ['user'], delivery: 'delivered',
      channels: [{ channel_id: 'internal', status: 'delivered' }, { channel_id: 'im:tg-main', status: 'failed', detail: 'bot was blocked' }],
      attachments: [picture, voice],
    }))!;
    expect(here.status).toBe('sent');
    expect(here.reached).toBe('here');
    expect(here.deliveredTo).toEqual(['user']);
    expect(here.attachments.map((attachment) => [attachment.kind, attachment.mimeType]))
      .toEqual([['image', 'image/png'], ['voice', 'audio/wav']]);
    expect(here.channels?.map((channel) => [channel.channelId, channel.status, channel.detail]))
      .toEqual([['internal', 'delivered', undefined], ['im:tg-main', 'failed', 'bot was blocked']]);
  });

  it('does not read an external-only delivery as speech here', () => {
    // The user's overall receipt says "user", but this conversation was never
    // one of the destinations: its own channel is absent because internal
    // delivery is off.
    const elsewhere = projectSendMessage(received({
      message_id: 'send:call', delivered_to: ['user'], delivery: 'delivered',
      channels: [{ channel_id: 'im:tg-main', status: 'delivered', message_ids: ['42'], unsupported: ['voice'] }],
      attachments: [picture, voice],
    }))!;
    expect(elsewhere.status).toBe('sent');
    expect(elsewhere.reached).toBe('elsewhere');
    expect(elsewhere.channels?.[0]?.unsupported).toEqual(['voice']);
    // The same turn must not also promote its final reply as this page's speech.
    const view = projectMessageView([thought, received({
      message_id: 'send:call', delivered_to: ['user'], delivery: 'delivered',
      channels: [{ channel_id: 'im:tg-main', status: 'delivered' }],
    })], { completedTurnIds: ['t1'] });
    expect(view.map((node) => node.kind)).toEqual(['activity-summary', 'message']);
    expect(view.some((node) => node.kind === 'message' && node.origin === 'ordinary_final')).toBe(false);
  });

  it('keeps a supported subset delivered and names the media a channel did not take', () => {
    const partial = projectSendMessage(received({
      message_id: 'send:call', delivered_to: ['user'], delivery: 'delivered',
      channels: [
        { channel_id: 'internal', status: 'delivered', unsupported: ['voice'] },
        { channel_id: 'im:wx', status: 'unsupported', unsupported: ['image', 'voice'] },
      ],
      attachments: [picture, voice],
    }))!;
    expect(partial.status).toBe('sent');
    expect(partial.reached).toBe('here');
    expect(partial.channels?.map((channel) => [channel.channelId, channel.status, channel.unsupported]))
      .toEqual([['internal', 'delivered', ['voice']], ['im:wx', 'unsupported', ['image', 'voice']]]);
  });

  it('never reads a channel that took none of the attachments as delivered', () => {
    const refused = projectSendMessage(received({
      message_id: 'send:call', delivered_to: [], delivery: 'undeliverable',
      channels: [{ channel_id: 'internal', status: 'unsupported', unsupported: ['voice'] }],
      attachments: [voice],
    }))!;
    expect(refused.status).toBe('failed');
    expect(refused.reached).toBeUndefined();
    expect(refused.text).toBe('');
    expect(refused.attachments).toEqual([]);
  });

  it('keeps an unconfirmed outcome as pending, with no delivered claim', () => {
    const unknown = projectSendMessage(received({
      message_id: 'send:call', delivered_to: [], delivery: 'pending',
      channels: [{ channel_id: 'internal', status: 'unknown', detail: 'timeout' }],
      attachments: [picture],
    }))!;
    expect(unknown.status).toBe('pending');
    expect(unknown.reached).toBe('unconfirmed');
    expect(unknown.deliveredTo).toEqual([]);
    expect(unknown.attachments).toEqual([]);
    expect(unknown.text).toBe('Delivered words');
    // A status this build does not know is unknown, never delivered.
    const unrecognized = projectSendMessage(received({
      message_id: 'send:call', channels: [{ channel_id: 'internal', status: 'queued_somewhere' }],
    }))!;
    expect(unrecognized.status).toBe('pending');
  });

  it('keeps an unconfirmed turn from speaking a second copy as its reply', () => {
    const view = projectMessageView([thought, received({
      message_id: 'send:call', delivered_to: [], delivery: 'pending',
      channels: [{ channel_id: 'internal', status: 'unknown' }],
    })], { completedTurnIds: ['t1'], personaName: 'Coordinator' });
    expect(view.map((node) => node.kind)).toEqual(['activity-summary', 'message']);
    expect(view.some((node) => node.kind === 'notice')).toBe(false);
  });

  it('reads the summary delivery field when no channels were reported', () => {
    expect(projectSendMessage(received({ message_id: 'send:call', delivered_to: [], delivery: 'undeliverable' }))?.status).toBe('failed');
    expect(projectSendMessage(received({ message_id: 'send:call', delivered_to: [], delivery: 'pending' }))?.status).toBe('pending');
  });

  it('keeps the call’s own error text when the send was refused outright', () => {
    const refused = projectSendMessage(tool({ status: 'error', isError: true,
      output: 'media_unsupported: No enabled channel supports video (video/mp4).' }))!;
    expect(refused.status).toBe('failed');
    expect(refused.failureDetail).toContain('media_unsupported');
    // A receipt that reports failed channels carries its reasons per channel;
    // it is not re-read as the call's own error text.
    const receipted = projectSendMessage(received({
      message_id: 'send:call', delivered_to: [], delivery: 'undeliverable',
      channels: [{ channel_id: 'internal', status: 'failed' }],
    }))!;
    expect(receipted.failureDetail).toBeUndefined();
  });

  it('fails when every reported channel failed', () => {
    const failed = projectSendMessage(received({
      message_id: 'send:call', delivered_to: [], delivery: 'undeliverable',
      channels: [{ channel_id: 'internal', status: 'failed' }, { channel_id: 'im:tg', status: 'failed', detail: 'blocked' }],
    }))!;
    expect(failed.status).toBe('failed');
    expect(failed.text).toBe('');
    expect(failed.reached).toBeUndefined();
  });
});

describe('message view', () => {
  it('keeps a running turn as activity, then speaks its own final reply once the turn ends', () => {
    const live = projectMessageView([thought]);
    expect(live.map((node) => node.kind)).toEqual(['activity-summary']);
    // The same blocks, now that the turn has ended: the reply itself is the
    // speech, and it is no longer an internal step of the work.
    const done = projectMessageView([thought], { completedTurnIds: ['t1'], personaName: 'Coordinator' });
    expect(done.map((node) => node.kind)).toEqual(['message']);
    const reply = done[0]!;
    expect(reply.kind).toBe('message');
    if (reply.kind !== 'message') throw new Error('Expected the promoted reply');
    expect(reply.origin).toBe('ordinary_final');
    expect(reply.status).toBe('sent');
    expect(reply.text).toBe('Private deliberation');
    expect(reply.sourceBlock?.id).toBe('internal');
    expect(reply.sourceTool).toBeUndefined();
    expect(reply.startedAt).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(reply.turnId).toBe('t1');
  });

  it('speaks the reply alone when the turn also sent a message, and never twice', () => {
    const view = projectMessageView([thought, tool()], { completedTurnIds: ['t1'] });
    expect(view.map((node) => node.kind)).toEqual(['activity-summary', 'message']);
    expect(view[1]?.kind === 'message' && view[1].origin).toBe('send_message');
  });

  it.each([
    ['sent', tool()],
    ['pending', tool({ output: '{"message_id":', outputPending: true })],
    ['failed', tool({ status: 'error', isError: true, output: 'media_unsupported: voice is unavailable' })],
    ['cancelled', tool({ status: 'stopped', output: undefined })],
  ] as const)('uses the actual SendMessage call to suppress the final reply when %s', (status, call) => {
    for (const process of [[call], [projectSendMessage(call)!]]) {
      const final = reply('after-send', 'Final sentence is not another send', 't1');
      const view = projectMessageView([...process, final], { completedTurnIds: ['t1'] });
      expect(view.map((node) => node.kind)).toEqual(['message', 'activity-summary']);
      expect(view[0]).toMatchObject({ kind: 'message', origin: 'send_message', status });
      expect(view[0]?.kind === 'message' && view[0].failureDetail).toBe(status === 'failed'
        ? 'media_unsupported: voice is unavailable' : undefined);
      expect(view[1]?.kind === 'activity-summary' && view[1].members).toEqual([final]);
      expect(view.some((node) => node.kind === 'message' && node.origin === 'ordinary_final')).toBe(false);
      expect(view.some((node) => node.kind === 'notice' && node.reasonCodes?.includes('message.no_reply'))).toBe(false);
    }
  });

  it('keeps a structured failed receipt and its reason when a final sentence follows', () => {
    const refused = tool({ output: { message_id: 'send:call', delivered_to: [], delivery: 'undeliverable',
      detail: 'No channel accepted the message', channels: [{ channel_id: 'internal', status: 'failed', detail: 'blocked' }] } });
    const final = reply('after-refusal', 'Not a second delivery', 't1');
    const view = projectMessageView([projectSendMessage(refused)!, final], { completedTurnIds: ['t1'] });
    expect(view.map((node) => node.kind)).toEqual(['message', 'activity-summary']);
    expect(view[0]).toMatchObject({ kind: 'message', status: 'failed', failureDetail: 'No channel accepted the message',
      channels: [{ channelId: 'internal', status: 'failed', detail: 'blocked' }] });
    expect(view[1]?.kind === 'activity-summary' && view[1].members).toEqual([final]);
  });

  it('still suppresses fallback when a native call has no projectable batch item', () => {
    const invalid = tool({ args: { messages: [null] }, output: undefined });
    const final = reply('after-call', 'Not another send', 't1');
    const view = projectMessageView([invalid, final], { completedTurnIds: ['t1'] });
    expect(view.map((node) => node.kind)).toEqual(['activity-summary']);
    expect(view[0]?.kind === 'activity-summary' && view[0].members).toEqual([invalid, final]);
  });

  it('does not let an external same-name call or another turn suppress an ordinary reply', () => {
    const ordinary = reply('ordinary', 'A normal final reply', 't1');
    const external = tool({ id: 'external-send', toolCallId: 'external:session:call', name: 'SendMessage' });
    const unrelated = projectMessageView([external, ordinary], { completedTurnIds: ['t1'] });
    expect(unrelated.map((node) => node.kind)).toEqual(['activity-summary', 'message']);
    expect(unrelated[1]).toMatchObject({ kind: 'message', origin: 'ordinary_final', text: ordinary.text });

    const later = reply('later', 'A later turn replies normally', 't2');
    const acrossTurns = projectMessageView([tool(), reply('after-send', 'Not speech', 't1'), later], {
      completedTurnIds: ['t1', 't2'],
    });
    expect(acrossTurns.map((node) => node.kind)).toEqual(['message', 'activity-summary', 'message']);
    expect(acrossTurns[2]).toMatchObject({ kind: 'message', origin: 'ordinary_final', text: later.text, turnId: 't2' });
    expect(projectMessageView([ordinary], { completedTurnIds: ['t1'] })[0])
      .toMatchObject({ kind: 'message', origin: 'ordinary_final', text: ordinary.text });
  });

  it('leaves the reply in the process when the reader stopped it, and says so', () => {
    const stopped = projectMessageView([{ ...thought, stopped: true }], { completedTurnIds: ['t1'], personaName: 'Coordinator' });
    expect(stopped.map((node) => node.kind)).toEqual(['activity-summary', 'notice']);
    expect(stopped[1]?.kind === 'notice' && stopped[1].reasonCodes).toEqual(['message.no_reply']);
  });

  it('keeps each turn’s own reply when two turns say the same words', () => {
    // Two adjacent turns may legitimately repeat a short line; the second is
    // not evidence that the first was already delivered.
    const view = projectMessageView([reply('a1', '好的。', 't1'), reply('a2', '好的。', 't2')], {
      completedTurnIds: ['t1', 't2'],
    });
    expect(view.map((node) => node.kind)).toEqual(['message', 'message']);
    expect(view.map((node) => node.kind === 'message' && `${node.turnId}:${node.sourceBlock?.id}`))
      .toEqual(['t1:a1', 't2:a2']);
  });

  it('keeps both turns when two long replies start with the same preview text', () => {
    // A bounded body reaches this projection as the same prefix; identical
    // previews are not identical replies.
    const prefix = '发布清单逐条核对：签名证书、changelog、回归结果。'.repeat(40);
    const view = projectMessageView([reply('a1', `${prefix}A`, 't1'), reply('a2', `${prefix}B`, 't2')], {
      completedTurnIds: ['t1', 't2'],
    });
    expect(view.map((node) => node.kind)).toEqual(['message', 'message']);
    expect(view.map((node) => node.kind === 'message' && node.text.at(-1))).toEqual(['A', 'B']);
  });

  it('leaves a turn with no assistant text silent', () => {
    const read = tool({ id: 'read', toolCallId: 'read', name: 'Read' });
    expect(projectMessageView([read], { completedTurnIds: ['t1'] }).map((node) => node.kind)).toEqual(['activity-summary']);
  });

  it('leaves a failed turn’s partial text in the process, says it failed once, and never speaks it', () => {
    // A turn that failed after writing text is not a reply the reader received:
    // the projection keeps the text in the process, and the message view says
    // the turn failed — one line per turn, never the partial text as speech.
    const failedUser: UserBlock = {
      kind: 'user', id: 'u1', text: 'check the build', turnId: 't1',
      createdAt: '2026-01-01T00:00:00Z',
      promptOutcome: { status: 'failed', delivered: true, error: 'provider filtered the response' },
    };
    const partial = reply('a1', 'The build looked green, but', 't1');
    const view = projectMessageView([failedUser, partial], { completedTurnIds: ['t1'], personaName: 'Coordinator' });
    expect(view.map((node) => node.kind)).toEqual(['user', 'activity-summary']);
    expect(view[1]?.kind === 'activity-summary' && view[1].members.map((member) => member.id)).toEqual(['a1']);

    // The same blocks with a turn that completed normally do speak the text.
    const completed = projectMessageView([{ ...failedUser, promptOutcome: undefined }, partial], { completedTurnIds: ['t1'] });
    expect(completed.map((node) => node.kind)).toEqual(['user', 'message']);

    // Without its own bubble (a prompt outside the loaded window) the failure
    // is still readable here, and it opens the process that holds the text.
    const reported = projectMessageView([{ ...failedUser, promptOutcome: undefined }, partial], {
      completedTurnIds: ['t1'], failedTurnIds: ['t1'],
    });
    expect(reported.map((node) => node.kind)).toEqual(['user', 'activity-summary', 'notice']);
    expect(reported[2]).toMatchObject({
      kind: 'notice', turnId: 't1', tone: 'danger',
      i18n: { key: 'notice.turnFailedDetail' }, reasonCodes: ['message.turn_failed'],
    });
    expect(reported.some((node) => node.kind === 'message')).toBe(false);
  });

  it('says a turn failed once, and never as a cancel or a silent turn', () => {
    const user = (turnId: string, failed: boolean): UserBlock => ({
      kind: 'user', id: `u-${turnId}`, text: 'check the build', turnId,
      createdAt: '2026-01-01T00:00:00Z',
      promptOutcome: failed ? { status: 'failed', delivered: true } : undefined,
    });
    // Two failed turns whose bubbles say nothing (prompts outside the window):
    // one line each, in turn order.
    const both = projectMessageView([user('t1', false), reply('a1', 'partial one', 't1'),
      user('t2', false), reply('a2', 'partial two', 't2')],
    { completedTurnIds: ['t1', 't2'], failedTurnIds: ['t1', 't2'] });
    expect(both.map((node) => node.kind)).toEqual(['user', 'activity-summary', 'notice', 'user', 'activity-summary', 'notice']);
    expect(both.flatMap((node) => (node.kind === 'notice' ? [node.id] : []))).toEqual(['message-turn-failed-t1', 'message-turn-failed-t2']);

    // A failure line the transcript already wrote is the one the reader keeps.
    const reported: Block = { kind: 'notice', id: 'agent-turn-outcome-t1', turnId: 't1',
      text: 'provider filtered the response', tone: 'danger',
      i18n: { key: 'notice.turnFailedDetail', params: { detail: ': provider filtered the response' } } };
    const once = projectMessageView([user('t1', false), reply('a1', 'partial', 't1'), reported],
      { completedTurnIds: ['t1'], failedTurnIds: ['t1'] });
    expect(once.filter((node) => node.kind === 'notice').map((node) => node.id)).toEqual(['agent-turn-outcome-t1']);

    // A turn that failed after it did deliver: the delivered words stay speech,
    // and the turn still says once that it failed.
    const delivered = projectMessageView([user('t1', false), tool(), reply('a1', 'partial after the send', 't1')],
      { completedTurnIds: ['t1'], failedTurnIds: ['t1'] });
    expect(delivered.map((node) => node.kind)).toEqual(['user', 'message', 'activity-summary', 'notice']);
    expect(delivered.some((node) => node.kind === 'message' && node.origin === 'send_message')).toBe(true);
    expect(delivered.some((node) => node.kind === 'message' && node.text === 'partial after the send')).toBe(false);
  });

  it('keeps the promoted reply out of the work summary that led to it', () => {
    const read = tool({ id: 'read', toolCallId: 'read', name: 'Read' });
    const view = projectMessageView([read, thought], { completedTurnIds: ['t1'] });
    expect(view.map((node) => node.kind)).toEqual(['activity-summary', 'message']);
    const summary = view[0];
    expect(summary?.kind === 'activity-summary' && summary.members.map((member) => member.id)).toEqual(['read']);
    expect(view[1]?.kind === 'message' && view[1].text).toBe('Private deliberation');
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
