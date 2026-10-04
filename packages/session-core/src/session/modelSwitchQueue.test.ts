import { describe, expect, it } from 'vitest';

import {
  MODEL_SWITCH_QUEUE_ID_PREFIX,
  isModelSwitchQueueId,
  mergeSessionQueueRows,
  modelSwitchOperationIdFromQueueId,
} from './modelSwitchQueue';

describe('model switch queue ids', () => {
  it('recognises the engine reserved prefix and recovers the operation id', () => {
    const id = `${MODEL_SWITCH_QUEUE_ID_PREFIX}op-42`;
    expect(isModelSwitchQueueId(id)).toBe(true);
    expect(modelSwitchOperationIdFromQueueId(id)).toBe('op-42');
    expect(isModelSwitchQueueId('prompt-1')).toBe(false);
    expect(isModelSwitchQueueId('')).toBe(false);
  });
});

describe('mergeSessionQueueRows', () => {
  it('interleaves a switch at its shared slot between messages', () => {
    const rows = mergeSessionQueueRows(
      [
        { promptId: 'a', queuePosition: 0 },
        { promptId: 'b', queuePosition: 2 },
      ],
      [{ operationId: 'op', queueIndex: 1 }],
    );
    expect(rows).toEqual([
      { kind: 'message', promptId: 'a' },
      { kind: 'modelSwitch', operationId: 'op' },
      { kind: 'message', promptId: 'b' },
    ]);
  });

  it('keeps messages without a known position after every indexed item', () => {
    const rows = mergeSessionQueueRows(
      [
        { promptId: 'posed', queuePosition: 0 },
        { promptId: 'echoed' },
      ],
      [{ operationId: 'op', queueIndex: 1 }],
    );
    expect(rows.map((row) => (row.kind === 'message' ? row.promptId : row.operationId)))
      .toEqual(['posed', 'op', 'echoed']);
  });

  it('keeps a switch queued after a locally echoed message behind it', () => {
    const rows = mergeSessionQueueRows(
      [{ promptId: 'echoed' }],
      [{ operationId: 'op', queueIndex: 1 }],
    );
    expect(rows.map((row) => (row.kind === 'message' ? row.promptId : row.operationId)))
      .toEqual(['echoed', 'op']);
  });

  it('keeps several switches in queue order and messages in state order', () => {
    const rows = mergeSessionQueueRows(
      [
        { promptId: 'a', queuePosition: 0 },
        { promptId: 'b', queuePosition: 3 },
      ],
      [
        { operationId: 'op-2', queueIndex: 4 },
        { operationId: 'op-1', queueIndex: 2 },
      ],
    );
    expect(rows.map((row) => (row.kind === 'message' ? row.promptId : row.operationId)))
      .toEqual(['a', 'op-1', 'b', 'op-2']);
  });

  it('returns messages unchanged when nothing is queued', () => {
    const rows = mergeSessionQueueRows([{ promptId: 'a' }, { promptId: 'b', queuePosition: 5 }], []);
    expect(rows).toEqual([
      { kind: 'message', promptId: 'a' },
      { kind: 'message', promptId: 'b' },
    ]);
  });
});
