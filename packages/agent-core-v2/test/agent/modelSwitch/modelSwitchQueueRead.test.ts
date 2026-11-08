import { createHash } from 'node:crypto';
import { enableMapSet } from 'immer';
import { expect, it, vi } from 'vitest';
import { PersistedModelSwitchReader, ModelSwitchQueuePreparingError } from '#/agent/prompt/modelSwitchQueueRead';
import { modelSwitchQueueKey } from '#/agent/prompt/modelSwitchQueueOps';
import { promptQueueKey } from '#/agent/prompt/promptService';
import { REPLAY_ABI_VERSION } from '#/state/eventDispatcherService';
import { encodeReplayCheckpointGraph } from '#/state/replayCheckpointCodec';
import { JOURNAL_BOUNDARY_HASH_BYTES, JOURNAL_HEAD_HASH_BYTES } from '#/wire/wire';

enableMapSet();
const queued = (id: string, index: number) => ({ type: 'prompt.model_switch_queued', time: 1,
  entry: { input: { operationId: id, model: 'model/new', mode: 'direct' }, revision: 0,
    receipt: { operationId: id, agentId: 'main', state: 'pending', fromModel: 'model/old', toModel: 'model/new', mode: 'direct' },
    originalBinding: { model: 'model/old', thinking: '' } }, queueIndex: index });
function host(records: unknown[]) {
  let data = Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  let time = 1;
  let identity = 1;
  let onScan: (() => void) | undefined;
  const reads = vi.fn();
  const scans = () => reads.mock.calls.filter(([, options]) => options?.chunkBytes !== 64 * 1024).map(([range]) => range);
  return { update(next: unknown[], replacement = false, preserveTime = false) {
    data = Buffer.from(next.map((record) => JSON.stringify(record)).join('\n') + '\n');
    if (!preserveTime) time++;
    if (replacement) identity++;
  }, duringScan(callback: () => void) { onScan = callback; }, reads, scans,
    reader: new PersistedModelSwitchReader({ docs: { get: async () => undefined } as never,
      files: { stat: async () => ({ isFile: true, isDirectory: false, size: data.length, mtimeMs: time, ino: identity }) },
      storage: { size: async () => data.length, mtime: async () => time, pathFor: () => 'example-wire',
        read: async () => undefined,
        readStream: async function* (_scope: string, _key: string, range: { start: number; end: number }, options?: { chunkBytes?: number }) {
          reads(range, options);
          const bytes = data.subarray(range.start, range.end + 1);
          if (options?.chunkBytes !== 64 * 1024) onScan?.();
          yield bytes;
        },
      } as never,
    }),
  };
}
it('reads the shared queue order, preserves cancel/failure states, and invalidates the cached cold source', async () => {
  const records = [queued('one', 0), queued('two', 1), { type: 'prompt.moved', promptId: '\u0000model-switch:two', targetIndex: 0, movedAt: '2026-01-01T00:00:00.000Z', queuedPromptIds: ['\u0000model-switch:two', '\u0000model-switch:one'], time: 2 }];
  const fixture = host(records);
  const list = await fixture.reader.read('session/agents/main');
  expect(list.map((entry) => [entry.input.operationId, entry.queueIndex])).toEqual([['one', 1], ['two', 0]]);
  await fixture.reader.read('session/agents/main'); expect(fixture.scans()).toHaveLength(1);
  fixture.update([...records, { type: 'prompt.model_switch_status', operationId: 'two', time: 3,
    receipt: { ...queued('two', 1).entry.receipt, state: 'cancelled' } }]);
  expect((await fixture.reader.read('session/agents/main'))[1]).toMatchObject({ queueIndex: -1, receipt: { state: 'cancelled' } });
});
it('continues a bounded cold read without claiming an empty queue or decoding unrelated request bodies', async () => {
  const fixture = host([{ type: 'llm.request', ignored: 'x'.repeat(8 * 1024 * 1024 + 512) }, queued('after-budget', 0)]);
  await expect(fixture.reader.read('s')).rejects.toBeInstanceOf(ModelSwitchQueuePreparingError);
  expect((await fixture.reader.read('s'))[0]?.input.operationId).toBe('after-budget');
  expect(fixture.scans().map((range) => range.start)).toEqual([0, 8 * 1024 * 1024]);
});
it('completes a fixed cold watermark despite an unrelated append between every slice, then folds only the suffix', async () => {
  const records: unknown[] = [{ type: 'llm.request', ignored: 'x'.repeat(8 * 1024 * 1024 + 512) }, queued('held', 0)];
  const fixture = host(records);
  await expect(fixture.reader.read('s')).rejects.toBeInstanceOf(ModelSwitchQueuePreparingError);
  records.push({ type: 'turn.ended', time: 2 });
  fixture.update(records);
  expect((await fixture.reader.read('s'))[0]?.input.operationId).toBe('held');
  const initialSize = Buffer.byteLength(records.slice(0, 2).map((record) => JSON.stringify(record)).join('\n') + '\n');
  records.push({ type: 'prompt.model_switch_status', operationId: 'held', time: 3,
    receipt: { ...queued('held', 0).entry.receipt, state: 'cancelled' } });
  fixture.update(records);
  expect((await fixture.reader.read('s'))[0]).toMatchObject({ queueIndex: -1, receipt: { state: 'cancelled' } });
  expect(fixture.scans().map((range) => range.start)).toEqual([0, 8 * 1024 * 1024, initialSize]);
});
it('accepts append during each storage slice without chasing the moving EOF', async () => {
  const records: unknown[] = [{ type: 'llm.request', ignored: 'x'.repeat(8 * 1024 * 1024 + 512) }, queued('held', 0)];
  const fixture = host(records);
  const watermark = Buffer.byteLength(records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  fixture.duringScan(() => { records.push({ type: 'turn.ended', time: records.length }); fixture.update(records); });
  await expect(fixture.reader.read('s')).rejects.toBeInstanceOf(ModelSwitchQueuePreparingError);
  expect((await fixture.reader.read('s'))[0]?.input.operationId).toBe('held');
  expect((await fixture.reader.read('s'))[0]?.input.operationId).toBe('held');
  expect(fixture.scans().map((range) => range.start)).toEqual([0, 8 * 1024 * 1024, watermark]);
});
it('rebuilds after a same-size same-time source replacement instead of accepting its sampled matching bytes', async () => {
  const records = [queued('held', 0), { type: 'llm.request', ignored: 'x'.repeat(8 * 1024 * 1024 + 512) }];
  const fixture = host(records);
  await expect(fixture.reader.read('s')).rejects.toBeInstanceOf(ModelSwitchQueuePreparingError);
  fixture.update(records, true, true);
  await expect(fixture.reader.read('s')).rejects.toBeInstanceOf(ModelSwitchQueuePreparingError);
  expect((await fixture.reader.read('s'))[0]?.input.operationId).toBe('held');
  expect(fixture.scans().map((range) => range.start)).toEqual([0, 0, 8 * 1024 * 1024]);
});
it('rejects an in-place sampled prefix rewrite followed by growth without retaining old folds', async () => {
  const filler = { type: 'llm.request', ignored: 'x'.repeat(8 * 1024 * 1024 + 512) };
  const fixture = host([queued('old', 0), filler]);
  await expect(fixture.reader.read('s')).rejects.toBeInstanceOf(ModelSwitchQueuePreparingError);
  fixture.update([queued('new', 0), filler, { type: 'turn.ended', time: 2 }]);
  await expect(fixture.reader.read('s')).rejects.toBeInstanceOf(ModelSwitchQueuePreparingError);
  expect((await fixture.reader.read('s')).map((entry) => entry.input.operationId)).toEqual(['new']);
  expect(fixture.scans().map((range) => range.start)).toEqual([0, 0, 8 * 1024 * 1024]);
});
it('keeps only sixteen source folds and replays an evicted source', async () => {
  const fixture = host([queued('held', 0)]);
  for (let index = 0; index < 17; index++) await fixture.reader.read(`source-${index}`);
  await fixture.reader.read('source-0');
  expect(fixture.scans()).toHaveLength(18);
  expect(fixture.scans().every((range) => range.end - range.start + 1 <= 8 * 1024 * 1024)).toBe(true);
});
it('keeps a malformed durable read failed until the source is repaired', async () => {
  const fixture = host([{ type: 'prompt.model_switch_queued', time: 1, entry: null }]);
  await expect(fixture.reader.read('s')).rejects.toThrow();
  await expect(fixture.reader.read('s')).rejects.toThrow();
  fixture.update([queued('repaired', 0)]);
  expect((await fixture.reader.read('s'))[0]?.input.operationId).toBe('repaired');
});
it('returns a ready cold queue across bounded slices without exposing preparation to the consumer', async () => {
  const fixture = host([{ type: 'llm.request', ignored: 'x'.repeat(8 * 1024 * 1024 + 512) }, queued('after-budget', 0)]);
  const list = await fixture.reader.readReady('s');
  expect(list).toMatchObject([{ input: { operationId: 'after-budget' }, queueIndex: 0, receipt: { state: 'pending' } }]);
  expect(fixture.scans().map((range) => range.start)).toEqual([0, 8 * 1024 * 1024]);
  await fixture.reader.readReady('s');
  expect(fixture.scans()).toHaveLength(2);
});
it('cancels a ready read between slices and preserves its progress for the next consumer', async () => {
  const fixture = host([{ type: 'llm.request', ignored: 'x'.repeat(8 * 1024 * 1024 + 512) }, queued('after-budget', 0)]);
  const controller = new AbortController();
  fixture.duringScan(() => controller.abort(new Error('cancelled read')));
  await expect(fixture.reader.readReady('s', controller.signal)).rejects.toThrow('cancelled read');
  expect(fixture.scans()).toHaveLength(1);
  fixture.duringScan(() => {});
  expect((await fixture.reader.readReady('s'))[0]?.input.operationId).toBe('after-budget');
  expect(fixture.scans().map((range) => range.start)).toEqual([0, 8 * 1024 * 1024]);
});
it('returns a durable failure from a ready read rather than retrying malformed state', async () => {
  const fixture = host([{ type: 'prompt.model_switch_queued', time: 1, entry: null }]);
  await expect(fixture.reader.readReady('s')).rejects.toThrow();
  expect(fixture.scans()).toHaveLength(1);
});
it('rejects an aborted caller without changing any queue state', () => {
  const fixture = host([queued('one', 0)]); const controller = new AbortController(); controller.abort();
  expect(() => fixture.reader.read('s', controller.signal)).toThrow();
  expect(fixture.reads).not.toHaveBeenCalled();
});
it('uses boundary-verified replay checkpoints and scans only appended tail records', async () => {
  const prefixRecords = [
    { type: 'llm.request', ignored: 'x'.repeat(JOURNAL_HEAD_HASH_BYTES + 1024) },
    queued('from-checkpoint', 0),
  ];
  const prefixBytes = Buffer.from(prefixRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const tailRecord = queued('from-tail', 1);
  const fullBytes = Buffer.concat([prefixBytes, Buffer.from(JSON.stringify(tailRecord) + '\n')]);
  const headHash = createHash('sha256').update(prefixBytes.subarray(0, JOURNAL_HEAD_HASH_BYTES)).digest('hex').slice(0, 32);
  const boundarySha256 = createHash('sha256')
    .update(prefixBytes.subarray(prefixBytes.length - JOURNAL_BOUNDARY_HASH_BYTES))
    .digest('hex');
  const switches = new Map([[
    'from-checkpoint',
    queued('from-checkpoint', 0).entry,
  ]]);
  const queue = {
    ...promptQueueKey.initial(),
    order: ['\u0000model-switch:from-checkpoint', '\u0000model-switch:from-tail'],
  };
  const graph = encodeReplayCheckpointGraph({
    states: [
      { name: 'unrelated.large', value: { text: 'y'.repeat(1024) }, meta: { history: [], checkpoints: [], nextPatchId: 1 } },
      { name: modelSwitchQueueKey.name, value: switches, meta: { history: [], checkpoints: [], nextPatchId: 1 } },
      { name: promptQueueKey.name, value: queue, meta: { history: [], checkpoints: [], nextPatchId: 1 } },
    ],
  });
  const reads: { start: number; end: number; chunkBytes?: number }[] = [];
  const reader = new PersistedModelSwitchReader({
    docs: {
      get: async () => ({
        format: 1,
        replayAbi: REPLAY_ABI_VERSION,
        wire: {
          size: prefixBytes.length,
          mtimeMs: 1,
          headHash,
          boundarySha256,
          storeGeneration: 'gen-1',
        },
        graph,
      }),
    } as never,
    files: { stat: async () => ({ isFile: true, isDirectory: false, size: fullBytes.length, mtimeMs: 2, ino: 1 }) },
    storage: {
      size: async () => fullBytes.length,
      mtime: async () => 2,
      pathFor: () => 'example-wire',
      read: async (_scope: string, key: string) =>
        key === 'wire.jsonl.generation' ? new TextEncoder().encode('gen-1') : undefined,
      readStream: async function* (_scope: string, _key: string, range: { start: number; end: number }, options?: { chunkBytes?: number }) {
        reads.push({ ...range, chunkBytes: options?.chunkBytes });
        yield fullBytes.subarray(range.start, range.end + 1);
      },
    } as never,
  });
  const result = await reader.read('s');
  expect(result.map((entry) => [entry.input.operationId, entry.queueIndex])).toEqual([
    ['from-checkpoint', 0],
    ['from-tail', 1],
  ]);
  const bodyScans = reads.filter((range) => range.chunkBytes !== 64 * 1024 && range.end - range.start + 1 !== JOURNAL_HEAD_HASH_BYTES && range.end - range.start + 1 !== JOURNAL_BOUNDARY_HASH_BYTES);
  expect(bodyScans).toEqual([{ start: prefixBytes.length, end: fullBytes.length - 1, chunkBytes: undefined }]);
});
it('supports small prefix-verified checkpoints on append and falls back to offset 0 on generation or boundary changes or invalid sizes', async () => {
  const smallPrefix = Buffer.from(JSON.stringify(queued('small-cp', 0)) + '\n');
  const smallTail = Buffer.from(JSON.stringify(queued('small-tail', 1)) + '\n');
  const smallFull = Buffer.concat([smallPrefix, smallTail]);
  const smallHeadHash = createHash('sha256').update(smallFull.subarray(0, Math.min(smallFull.length, JOURNAL_HEAD_HASH_BYTES))).digest('hex').slice(0, 32);
  const prefixSha256 = createHash('sha256').update(smallPrefix).digest('hex');
  const smallSwitches = new Map([['small-cp', queued('small-cp', 0).entry]]);
  const smallQueue = { ...promptQueueKey.initial(), order: ['\u0000model-switch:small-cp'] };
  const smallGraph = encodeReplayCheckpointGraph({
    states: [
      { name: modelSwitchQueueKey.name, value: smallSwitches, meta: { history: [], checkpoints: [], nextPatchId: 1 } },
      { name: promptQueueKey.name, value: smallQueue, meta: { history: [], checkpoints: [], nextPatchId: 1 } },
    ],
  });
  let checkpointWire: Record<string, unknown> = {
    size: smallPrefix.length,
    mtimeMs: 1,
    headHash: smallHeadHash,
    prefixSha256,
    storeGeneration: 'gen-1',
  };
  let storedGen = 'gen-1';
  let currentBytes = smallFull;
  const scanStarts: number[] = [];
  const makeReader = () => new PersistedModelSwitchReader({
    docs: {
      get: async () => ({
        format: 1,
        replayAbi: REPLAY_ABI_VERSION,
        wire: checkpointWire,
        graph: smallGraph,
      }),
    } as never,
    files: { stat: async () => ({ isFile: true, isDirectory: false, size: currentBytes.length, mtimeMs: 2, ino: 1 }) },
    storage: {
      size: async () => currentBytes.length,
      mtime: async () => 2,
      pathFor: () => 'example-wire',
      read: async (_scope: string, key: string) =>
        key === 'wire.jsonl.generation' ? new TextEncoder().encode(storedGen) : undefined,
      readStream: async function* (_scope: string, _key: string, range: { start: number; end: number }, options?: { chunkBytes?: number }) {
        expect(range.start).toBeGreaterThanOrEqual(0);
        if (options?.chunkBytes !== 64 * 1024 && range.end - range.start + 1 !== JOURNAL_HEAD_HASH_BYTES && range.end - range.start + 1 !== smallPrefix.length && range.end - range.start + 1 !== JOURNAL_BOUNDARY_HASH_BYTES) {
          scanStarts.push(range.start);
        }
        yield currentBytes.subarray(range.start, range.end + 1);
      },
    } as never,
  });

  const hitResult = await makeReader().read('small');
  expect(hitResult.map((entry) => [entry.input.operationId, entry.queueIndex])).toEqual([
    ['small-cp', 0],
    ['small-tail', 1],
  ]);
  expect(scanStarts).toEqual([smallPrefix.length]);

  const largePrefix = Buffer.from([
    { type: 'llm.request', ignored: 'x'.repeat(JOURNAL_HEAD_HASH_BYTES + 1024) },
    queued('large-cp', 0),
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const largeFull = Buffer.concat([largePrefix, smallTail]);
  const largeHeadHash = createHash('sha256').update(largeFull.subarray(0, JOURNAL_HEAD_HASH_BYTES)).digest('hex').slice(0, 32);
  const validBoundarySha256 = createHash('sha256').update(largePrefix.subarray(largePrefix.length - JOURNAL_BOUNDARY_HASH_BYTES)).digest('hex');

  scanStarts.length = 0;
  checkpointWire = { ...checkpointWire, size: -5 };
  const negativeOffsetResult = await makeReader().read('small-negative');
  expect(negativeOffsetResult.map((entry) => entry.input.operationId)).toEqual(['small-cp', 'small-tail']);
  expect(scanStarts).toEqual([0]);

  currentBytes = largeFull;
  storedGen = 'gen-2';
  checkpointWire = {
    size: largePrefix.length,
    mtimeMs: 1,
    headHash: largeHeadHash,
    boundarySha256: validBoundarySha256,
    storeGeneration: 'gen-1',
  };
  scanStarts.length = 0;
  const genMismatchResult = await makeReader().read('large-gen-changed');
  expect(genMismatchResult.map((entry) => entry.input.operationId)).toEqual(['large-cp', 'small-tail']);
  expect(scanStarts).toEqual([0]);

  storedGen = 'gen-1';
  checkpointWire = {
    size: largePrefix.length,
    mtimeMs: 1,
    headHash: largeHeadHash,
    boundarySha256: 'f'.repeat(64),
    storeGeneration: 'gen-1',
  };
  scanStarts.length = 0;
  const boundaryMismatchResult = await makeReader().read('large-boundary-changed');
  expect(boundaryMismatchResult.map((entry) => entry.input.operationId)).toEqual(['large-cp', 'small-tail']);
  expect(scanStarts).toEqual([0]);
});
