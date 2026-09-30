import { describe, expect, it } from 'vitest';

import { mapCodexNotification } from '../src/events';

describe('Codex notification mapping', () => {
  it.each(['agentMessage', 'reasoning', 'plan', 'userMessage'])(
    'drops recognized %s item starts without reporting unknown events',
    (type) => {
      expect(mapCodexNotification('item/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1,
        item: { id: 'item-1', type },
      }).events).toEqual([]);
    },
  );

  it('maps recognized tool item starts and completions', () => {
    expect(mapCodexNotification('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      startedAtMs: 1,
      item: { id: 'command-1', type: 'commandExecution', command: 'echo test' },
    }).events).toEqual([
      expect.objectContaining({ type: 'tool.call', toolCallId: 'command-1' }),
    ]);
    expect(mapCodexNotification('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: 2,
      item: { id: 'command-1', type: 'commandExecution', command: 'echo test', status: 'completed' },
    }).events).toEqual([
      expect.objectContaining({ type: 'tool.update', toolCallId: 'command-1', status: 'completed' }),
    ]);
  });

  it('codes a Codex MCP approval refusal and leaves other MCP failures uncoded', () => {
    const completed = (error: unknown) => mapCodexNotification('item/completed', {
      item: { id: 'mcp-1', type: 'mcpToolCall', server: 'kiki-harness', tool: 'kiki_list', status: 'failed', error },
    }).events[0];
    expect(completed({ message: 'MCP tool call requires approval, but approval policy is never' }))
      .toMatchObject({ type: 'tool.update', status: 'failed', errorCode: 'codex_mcp_approval_denied' });
    expect(completed({ message: 'tool crashed' })).toMatchObject({ status: 'failed', errorCode: undefined });
    expect(mapCodexNotification('item/completed', {
      item: { id: 'cmd-1', type: 'commandExecution', command: 'x', status: 'failed',
        error: { message: 'requires approval, but approval policy is never' } },
    }).events[0]).toMatchObject({ errorCode: undefined });
  });

  it('drops completed user echoes and maps completed agent messages', () => {
    expect(mapCodexNotification('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: 2,
      item: { id: 'user-1', type: 'userMessage', text: 'echo' },
    }).events).toEqual([]);
    expect(mapCodexNotification('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: 2,
      item: { id: 'message-1', type: 'agentMessage', text: 'answer' },
    }).events).toEqual([{
      type: 'message.delta',
      role: 'assistant',
      messageId: 'message-1',
      content: { type: 'text', text: 'answer' },
    }]);
  });

  it('maps web search, collaboration, diff and compaction to timeline events', () => {
    for (const type of ['webSearch', 'collabAgentToolCall', 'subAgentActivity']) {
      expect(mapCodexNotification('item/started', {
        item: { id: 'tool-1', type, query: 'docs', input: { agent: 'reviewer', prompt: 'check' } },
      }).events).toEqual([expect.objectContaining({ type: 'tool.call', toolCallId: 'tool-1' })]);
    }
    expect(mapCodexNotification('turn/diff/updated', { diff: '--- a/file' }).events)
      .toEqual([{ type: 'turn.diff', diff: '--- a/file' }]);
    expect(mapCodexNotification('thread/compacted', { threadId: 'thread-1' }).events)
      .toEqual([{ type: 'context.compacted', threadId: 'thread-1' }]);
  });

  it.each(['functionCallOutput', 'hookPrompt', 'imageGeneration', 'contextCompaction'])(
    'reports unsupported %s item boundaries as unknown events',
    (type) => {
      expect(mapCodexNotification('item/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1,
        item: { id: 'item-1', type },
      }).events).toEqual([{ type: 'unknown', updateType: `item/started:${type}` }]);
      expect(mapCodexNotification('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 2,
        item: { id: 'item-1', type },
      }).events).toEqual([{ type: 'unknown', updateType: `item/completed:${type}` }]);
    },
  );
});
