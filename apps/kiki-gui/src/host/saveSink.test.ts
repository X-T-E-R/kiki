// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserSaveSink, bufferedSaveSink } from './saveSink';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('browser original save capability', () => {
  it('writes with FSA backpressure and aborts the pending writer without committing', async () => {
    const write = vi.fn();
    const close = vi.fn();
    const abort = vi.fn();
    const picker = vi.fn(async () => ({ createWritable: async () => new WritableStream({ write, close, abort }) }));
    vi.stubGlobal('showSaveFilePicker', picker);
    const sink = (await browserSaveSink('original.bin'))!;
    expect(sink.streaming).toBe(true);
    await sink.write(Uint8Array.from([1, 2]));
    await sink.abort();
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'original.bin' });
    expect(write).toHaveBeenCalledWith(Uint8Array.from([1, 2]), expect.anything());
    expect(abort).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('retains the existing download outlet without FSA rather than disabling original files', async () => {
    vi.stubGlobal('showSaveFilePicker', undefined);
    let blob: Blob | undefined;
    URL.createObjectURL = vi.fn((value) => { blob = value as Blob; return 'blob:original'; });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const sink = (await browserSaveSink('original.bin'))!;
    expect(sink.streaming).toBe(false);
    await sink.write(Uint8Array.from([1, 2]));
    await sink.write(Uint8Array.from([3]));
    expect(await sink.close()).toBe(true);
    expect(blob?.size).toBe(3);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('releases buffered bytes on cancel and does not invoke the existing save route', async () => {
    const save = vi.fn();
    const sink = bufferedSaveSink(save);
    await sink.write(new Uint8Array(64 * 1024));
    await sink.abort();
    expect(await sink.close()).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});
