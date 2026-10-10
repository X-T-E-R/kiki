import { describe, expect, it } from 'vitest';

import { AcpClientErrorCode, mapAcpSessionUpdate } from '../src';

describe('ACP normalized executor event mapper', () => {
  it('maps message, thought, tool, plan, usage, and unknown updates', () => {
    expect(mapAcpSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'hello' },
    })).toEqual({
      type: 'message.delta',
      role: 'assistant',
      messageId: 'm1',
      content: { type: 'text', text: 'hello' },
    });
    expect(mapAcpSessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'hmm' },
    })).toMatchObject({ type: 'thought.delta' });
    expect(mapAcpSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Run',
      status: 'pending',
    })).toMatchObject({ type: 'tool.call', toolCallId: 't1' });
    expect(mapAcpSessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      rawOutput: { text: 'ok' },
    })).toMatchObject({ type: 'tool.update', status: 'completed' });
    expect(mapAcpSessionUpdate({ sessionUpdate: 'plan', entries: [] }))
      .toMatchObject({ type: 'plan.update', unstable: false });
    expect(mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: 1, size: 10 }))
      .toEqual({ type: 'usage', used: 1, size: 10, cost: undefined });
    expect(mapAcpSessionUpdate({ sessionUpdate: 'future_vendor_update' }))
      .toEqual({ type: 'unknown', updateType: 'future_vendor_update' });
  });

  it.each(['tool_call', 'tool_call_update'])('preserves %s names and complete initial or updated payloads', (sessionUpdate) => {
    const rawInput = { source: { kind: 'url', url: 'https://example.com/spec' }, extra: 'x'.repeat(70_000) };
    const rawOutput = { unknown: { kept: true } };
    const content = [{ type: 'diff', path: 'a.ts', oldText: null, newText: 'new' }, { type: 'future', data: [1, 2] }];
    const locations = [{ path: 'a.ts', line: 3 }];
    expect(mapAcpSessionUpdate({ sessionUpdate, toolCallId: 'remote-call', title: 'FetchURL', name: 'FetchURL', kind: 'fetch', rawInput, rawOutput, content, locations }))
      .toMatchObject({ toolCallId: 'remote-call', title: 'FetchURL', name: 'FetchURL', rawInput, rawOutput, content, locations });
  });

  it('fails known malformed updates instead of silently dropping them', () => {
    expect(() =>
      mapAcpSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 42 },
      }),
    ).toThrow(expect.objectContaining({ code: AcpClientErrorCode.ProtocolError }));
    expect(() =>
      mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: '1', size: 10 }),
    ).toThrow(expect.objectContaining({ code: AcpClientErrorCode.ProtocolError }));
  });
});
