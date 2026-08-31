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

  it.each(['webSearch', 'functionCallOutput', 'hookPrompt', 'subAgentActivity', 'imageGeneration', 'contextCompaction'])(
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
