import { describe, expect, it } from 'vitest';

import { AcpClientErrorCode, mapAcpSessionNotification, mapAcpSessionUpdate } from '../src';

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
    expect(mapAcpSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'audio', mimeType: 'audio/wav', data: 'AQI=' } }))
      .toEqual({ type: 'message.delta', role: 'assistant', messageId: undefined,
        content: { type: 'audio', mimeType: 'audio/wav', data: 'AQI=' } });
    expect(mapAcpSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [
      { type: 'content', content: { type: 'resource', resource: { uri: 'urn:embedded', text: 'embedded body', mimeType: 'text/plain' } } },
      { type: 'content', content: { type: 'resource_link', uri: 'https://example.test/resource', name: 'remote', mimeType: 'text/plain', title: 'Remote title', description: 'Remote description' } },
    ] })).toMatchObject({ type: 'tool.update', content: [
      { type: 'content', content: { type: 'resource', resource: { text: 'embedded body' } } },
      { type: 'content', content: { type: 'resource_link', uri: 'https://example.test/resource', title: 'Remote title', description: 'Remote description' } },
    ] });
    expect(mapAcpSessionUpdate({ sessionUpdate: 'plan', entries: [] }))
      .toMatchObject({ type: 'plan.update', unstable: false });
    expect(mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: 1, size: 10 }))
      .toEqual({ type: 'usage', used: 1, size: 10, cost: undefined });
    expect(mapAcpSessionUpdate({ sessionUpdate: 'future_vendor_update' }))
      .toEqual({ type: 'unknown', updateType: 'future_vendor_update', payload: { sessionUpdate: 'future_vendor_update' } });
  });

  it.each(['_x.ai/session_notification', '_x.ai/session/update'])('maps observed Grok extensions on %s without inventing message text', (method) => {
    const map = (update: unknown) => mapAcpSessionNotification({ sessionId: 'session-1', update }, method).event;
    expect(map({ sessionUpdate: 'tool_call_delta_chunk', tool_call_id: 'call-1', tool_index: 0, name: 'search_replace' }))
      .toEqual({ type: 'tool.input.delta', toolCallId: 'call-1', toolIndex: 0, name: 'search_replace', delta: undefined });
    expect(map({ sessionUpdate: 'tool_call_delta_chunk', tool_index: 0, arguments_delta: '{"file":"src/' }))
      .toMatchObject({ type: 'tool.input.delta', toolIndex: 0, delta: '{"file":"src/' });
    expect(map({ sessionUpdate: 'session_summary_generated', session_summary: 'Inspect project' }))
      .toEqual({ type: 'session.info', title: 'Inspect project' });
    expect(map({ sessionUpdate: 'pending_interaction', tool_call_id: 'call-1', kind: 'permission' }))
      .toEqual({ type: 'tool.interaction', toolCallId: 'call-1', state: 'pending', kind: 'permission' });
    expect(map({ sessionUpdate: 'interaction_resolved', tool_call_id: 'call-1' }))
      .toMatchObject({ type: 'tool.interaction', state: 'resolved' });
    expect(map({ sessionUpdate: 'response_completed', stop_reason: 'tool_use', usage: { output_tokens: 7 }, signature: 'encrypted' }))
      .toEqual({ type: 'response.completed', meta: { messageId: undefined, stopReason: 'tool_use', usage: { output_tokens: 7 } } });
    expect(map({ sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', stop_reason: 'end_turn', usage: { inputTokens: 12 }, elapsed_ms: 100 }))
      .toMatchObject({ type: 'session.info', meta: { completion: { promptId: 'prompt-1', stopReason: 'end_turn', usage: { inputTokens: 12 }, elapsedMs: 100 } } });
    expect(map({ sessionUpdate: 'future_update', nested: { businessFact: 1 } }))
      .toMatchObject({ type: 'unknown', updateType: 'future_update', method, payload: { update: { nested: { businessFact: 1 } } } });
    expect(mapAcpSessionNotification({ sessionId: 'session-1', update: { sessionUpdate: 'tool_call_delta_chunk', tool_index: 0 } }).event.type).toBe('unknown');
    expect(() => map({ sessionUpdate: 'tool_call_delta_chunk', tool_index: -1 })).toThrow(/tool_index/);
  });

  it('retains bounded opaque payload diagnostics without pretending support', () => {
    expect(mapAcpSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: {
      type: 'future_block', body: { token: 'secret-looking-but-opaque' },
    } })).toEqual({ type: 'message.delta', role: 'assistant', messageId: undefined, content: {
      type: 'opaque', contentType: 'future_block', payload: { type: 'future_block', body: { token: '[REDACTED]' } },
    } });
  });

  it.each(['tool_call', 'tool_call_update'])('preserves %s names and complete initial or updated payloads', (sessionUpdate) => {
    const rawInput = { source: { kind: 'url', url: 'https://example.com/spec' }, extra: 'x'.repeat(70_000) };
    const rawOutput = { unknown: { kept: true } };
    const content = [{ type: 'diff', path: 'a.ts', oldText: null, newText: 'new' }, { type: 'future', data: [1, 2] }];
    const locations = [{ path: 'a.ts', line: 3 }];
    expect(mapAcpSessionUpdate({ sessionUpdate, toolCallId: 'remote-call', title: 'FetchURL', name: 'FetchURL', kind: 'fetch', rawInput, rawOutput, content, locations }))
      .toMatchObject({ toolCallId: 'remote-call', title: 'FetchURL', name: 'FetchURL', rawInput, rawOutput, content, locations });
  });

  it('retains bounded opaque payload diagnostics without pretending support', () => {
    expect(mapAcpSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: {
      type: 'future_block', body: { token: 'secret-looking-but-opaque' },
    } })).toEqual({ type: 'message.delta', role: 'assistant', messageId: undefined, content: {
      type: 'opaque', contentType: 'future_block', payload: { type: 'future_block', body: { token: '[REDACTED]' } },
    } });
  });

  it.each(['agent_message_chunk', 'agent_thought_chunk'])('degrades malformed resources in %s without failing the notification', (sessionUpdate) => {
    for (const resource of [undefined, null, [], 'invalid', 42, {}, { text: 'body' }, { uri: null }, { uri: 42 }, { uri: 'urn:embedded', mimeType: 42 }]) {
      expect(mapAcpSessionNotification({ sessionId: 'resource-session', update: {
        sessionUpdate, content: { type: 'resource', resource, token: 'private-value' },
      } })).toMatchObject({ sessionId: 'resource-session', event: { content: {
        type: 'opaque', contentType: 'resource', payload: { type: 'resource', token: '[REDACTED]' },
      } } });
    }
    expect(mapAcpSessionNotification({ sessionId: 'resource-session', update: {
      sessionUpdate, content: { type: 'text', text: 'next chunk' },
    } })).toMatchObject({ event: { content: { type: 'text', text: 'next chunk' } } });
  });

  it.each([
    { uri: 'urn:embedded', text: 'body', mimeType: 'text/plain' },
    { uri: 'urn:embedded', blob: 'AQI=', mimeType: 'application/octet-stream' },
  ])('keeps well-formed embedded resources typed: $mimeType', (resource) => {
    expect(mapAcpSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'resource', resource } }))
      .toMatchObject({ content: { type: 'resource', resource: { ...resource, type: 'text' in resource ? 'text' : 'blob' } } });
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
