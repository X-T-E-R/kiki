import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createHttpRestFacade, type HttpRestTransport } from '../src/transports/http/rest';

function facade(response: () => Response) {
  const raw = vi.fn(async (_path, _options, consume) => consume(response()));
  return { rest: createHttpRestFacade({ json: vi.fn(), raw } as HttpRestTransport), raw };
}

describe('explicit media stream', () => {
  it('delivers the exact 300 MiB original to an awaited sink without an arrayBuffer or JSON page cap', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x5a);
    const count = 300 * 1024 * 1024 / chunk.byteLength;
    const expected = createHash('sha256');
    for (let index = 0; index < count; index += 1) expected.update(chunk);
    let produced = 0;
    let consumed = 0;
    const actual = createHash('sha256');
    const { rest, raw } = facade(() => new Response(new ReadableStream({
      pull(controller) { if (produced++ < count) controller.enqueue(chunk); else controller.close(); },
    }), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(count * chunk.byteLength) } }));
    const receipt = await rest.sessions.downloadMedia('session', 'file', async (value, progress) => {
      actual.update(value);
      consumed += value.byteLength;
      expect(progress.bytes).toBe(consumed);
      await Promise.resolve();
    });
    expect(receipt.bytes).toBe(300 * 1024 * 1024);
    expect(actual.digest('hex')).toBe(expected.digest('hex'));
    expect(raw).toHaveBeenCalledWith('/sessions/session/media/file', expect.objectContaining({ expectBinary: true, timeoutMs: 0 }), expect.any(Function));
  });

  it('cancels the source reader and never writes another sink chunk after cancellation', async () => {
    const abort = new AbortController();
    let cancelled = 0;
    let produced = 0;
    let consumed = 0;
    const { rest } = facade(() => new Response(new ReadableStream({
      pull(controller) { produced += 1; controller.enqueue(new Uint8Array(64 * 1024)); },
      cancel() { cancelled += 1; },
    })));
    await expect(rest.sessions.downloadMedia('session', 'file', () => { consumed += 1; abort.abort(); }, { signal: abort.signal })).rejects.toThrow();
    expect(consumed).toBe(1);
    expect(produced).toBeLessThanOrEqual(2);
    expect(cancelled).toBe(1);
  });

  it('accepts the same 512 KiB preview contract through session and host consumers', async () => {
    const bytes = new Uint8Array(512 * 1024).fill(42);
    const { rest } = facade(() => new Response(bytes, { headers: { 'content-type': 'image/png' } }));
    expect((await rest.sessions.mediaPreview('session', 'file')).bytes).toEqual(bytes);
    expect((await rest.filesystem.readHostMediaPreview('/fixture/image.png')).bytes).toEqual(bytes);
  });

  it('counts preview stream bytes instead of trusting a lying content-length', async () => {
    let cancelled = 0;
    const { rest, raw } = facade(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(512 * 1024 + 1)); },
      cancel() { cancelled += 1; },
    }), { headers: { 'content-length': '1', 'content-type': 'image/jpeg' } }));
    await expect(rest.sessions.mediaPreview('session', 'file', { mediaType: 'image/png' })).rejects.toThrow('preview exceeds');
    expect(cancelled).toBe(1);
    expect(raw).toHaveBeenCalledWith('/sessions/session/media/file/preview', expect.objectContaining({ query: { media_type: 'image/png' }, expectBinary: true }), expect.any(Function));
  });
});
