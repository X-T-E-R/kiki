import { describe, expect, it } from 'vitest';

import { mapCodexNotification } from '../src/events';

describe('Codex notification mapping', () => {
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
