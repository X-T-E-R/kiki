import { enableMapSet } from 'immer';
import { expect, it, vi } from 'vitest';
import { PersistedModelSwitchReader, ModelSwitchQueuePreparingError } from '#/agent/prompt/modelSwitchQueueRead';

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
it('rejects an aborted caller without changing any queue state', async () => {
  const fixture = host([queued('one', 0)]); const controller = new AbortController(); controller.abort();
  expect(() => fixture.reader.read('s', controller.signal)).toThrow();
  expect(fixture.reads).not.toHaveBeenCalled();
});
