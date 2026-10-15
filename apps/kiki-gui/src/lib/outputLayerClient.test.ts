import { describe, expect, it, vi } from 'vitest';
import { OutputLayerClient, splitOutputLayerText, outputLayerViewportIndices, OUTPUT_LAYER_DEFAULT_SETTINGS } from './outputLayerClient';
import { OUTPUT_LAYER_DEFAULT_PRESETS, type OutputLayerRequest, type OutputLayerEvent } from '@kiki/protocol';
import type { OutputLayerFacade } from '@kiki/klient/core/facade/output-layer';

const preset = OUTPUT_LAYER_DEFAULT_PRESETS[0]!;
const settings = OUTPUT_LAYER_DEFAULT_SETTINGS;
const source = (sourceId: string) => ({ sessionId: 'example-session', sourceId, sourceRevision: '1', text: `Visible ${sourceId}` });
function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
function mockApi() {
  const requests: OutputLayerRequest[] = [];
  const api: OutputLayerFacade = {
    configuration: vi.fn(), configure: vi.fn(),
    stream: vi.fn(async (input, receive) => {
      requests.push(structuredClone(input));
      receive({ type: 'started', cycleId: requests.length === 3 ? 'reset-cycle' : input.cycleId, historyReset: requests.length === 3, contextWindow: 32768, inputTokensEstimate: 100 });
      receive({ type: 'delta', text: '译' });
      receive({ type: 'completed', text: `译文 ${input.sourceId}` });
    }),
  };
  return { api, requests };
}

describe('output layer reading client', () => {
  it('serializes requests, appends complete pairs, and starts a fresh batch after whole-history reset', async () => {
    const { api, requests } = mockApi(); const client = new OutputLayerClient(api);
    const updates: string[] = [];
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => client.process(source(id), preset, settings, (value) => updates.push(value.status))));
    expect(requests.map((request) => request.history.map((pair) => pair.sourceId))).toEqual([[], ['a'], ['a', 'b'], ['c']]);
    expect(requests[1]!.history[0]).toMatchObject({ original: 'Visible a', output: '译文 a' });
    expect(requests[3]!.cycleId).toBe('reset-cycle');
    expect(requests[2]!.cycleId).not.toBe('reset-cycle');
    expect(updates).toContain('queued'); expect(updates).toContain('streaming'); expect(updates).toContain('completed');
  });

  it('persists derived results independently of model history and reads them after reopen', async () => {
    const { api, requests } = mockApi(); const storage = memoryStorage();
    const client = new OutputLayerClient(api, storage);
    await client.process(source('a'), preset, settings, () => {});
    client.clearHistory('example-session');
    await client.process(source('a'), preset, settings, () => {});
    expect(requests).toHaveLength(1);
    const reopened = new OutputLayerClient(api, storage);
    expect(reopened.get(source('a'), preset)?.output).toBe('译文 a');
    await reopened.process(source('a'), preset, settings, () => {});
    expect(requests).toHaveLength(1);
    reopened.clearResults();
    await reopened.process(source('a'), preset, settings, () => {});
    expect(requests).toHaveLength(2);
    expect(new OutputLayerClient(api, memoryStorage()).get(source('a'), preset)).toBeUndefined();
  });

  it('binds cached results to source revision and full preset settings', async () => {
    const { api, requests } = mockApi(); const client = new OutputLayerClient(api);
    await client.process(source('a'), preset, settings, () => {});
    expect(client.get({ ...source('a'), sourceRevision: '2' }, preset)).toBeUndefined();
    expect(client.get(source('a'), { ...preset, instruction: 'Changed' })).toBeUndefined();
    client.invalidateSource('example-session', 'a');
    expect(client.get(source('a'), preset)).toBeUndefined();
    await client.process(source('b'), preset, settings, () => {});
    expect(requests.at(-1)!.history).toEqual([]);
  });

  it('keeps an in-flight snapshot and cancellation separate from source invalidation', async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    let receive: (event: OutputLayerEvent) => void = () => {};
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const { api } = mockApi();
    api.stream = vi.fn(async (input, callback, options) => {
      receive = callback; started();
      callback({ type: 'started', cycleId: input.cycleId, historyReset: false, contextWindow: 32768, inputTokensEstimate: 10 });
      await new Promise<void>((resolve) => { release = resolve; options?.signal?.addEventListener('abort', resolve.bind(null), { once: true }); });
      callback({ type: 'completed', text: input.preset.instruction });
    });
    const client = new OutputLayerClient(api); const editable = { ...preset };
    const pending = client.process(source('a'), editable, settings, () => {});
    await ready;
    editable.instruction = 'New prompt'; release();
    expect((await pending).output).toBe(preset.instruction);
    const revoked = client.process(source('b'), preset, settings, () => {});
    await Promise.resolve();
    client.invalidateSource('example-session', 'a');
    receive({ type: 'delta', text: 'late bytes' });
    expect((await revoked).status).toBe('stale');
    expect(client.get(source('b'), preset)).toBeUndefined();
  });

  it('retains truncated partial text without caching or appending it and permits an explicit retry', async () => {
    const { api, requests } = mockApi();
    const successful = api.stream;
    let truncated = true;
    const error = '输出被模型截断，请提高预设的输出预算后重试';
    api.stream = async (input, receive, options) => {
      if (input.sourceId === 'a' && truncated) {
        requests.push(structuredClone(input));
        receive({ type: 'started', cycleId: input.cycleId, historyReset: false, contextWindow: 32768, inputTokensEstimate: 100 });
        receive({ type: 'delta', text: '未完成译文' });
        receive({ type: 'failed', message: error });
        return;
      }
      return successful(input, receive, options);
    };
    const storage = memoryStorage();
    const client = new OutputLayerClient(api, storage);
    const original = source('a');
    const statuses: string[] = [];
    expect(await client.process(original, preset, settings, value => statuses.push(value.status)))
      .toMatchObject({ status: 'failed', text: original.text, output: '未完成译文', error });
    expect(statuses).not.toContain('completed');
    expect(requests).toHaveLength(1);
    expect(client.get(original, preset)).toBeUndefined();
    expect(new OutputLayerClient(api, storage).get(original, preset)).toBeUndefined();
    await client.process(source('b'), preset, settings, () => {});
    expect(requests[1]!.history).toEqual([]);
    truncated = false;
    expect((await client.process(original, preset, settings, () => {})).status).toBe('completed');
    expect(requests).toHaveLength(3);
    expect(requests[2]!.history.map(pair => pair.sourceId)).toEqual(['b']);
    expect(new OutputLayerClient(api, storage).get(original, preset)?.output).toBe('译文 a');
  });

  it('groups Unicode without changing text and prioritizes the visible range before configurable neighbors', () => {
    const text = ('😀正文。\n'.repeat(300));
    const groups = splitOutputLayerText(text, 600);
    expect(groups.join('')).toBe(text);
    expect(groups.every((group) => Array.from(group).length <= 600)).toBe(true);
    expect(groups.some((group) => group.endsWith('\n'))).toBe(true);
    expect(outputLayerViewportIndices(4, 5, 12, settings)).toEqual([4, 5, 3, 6]);
    expect(outputLayerViewportIndices(0, 0, 12, { ...settings, preloadBefore: 0, preloadAfter: 2 })).toEqual([0, 1, 2]);
  });
});
