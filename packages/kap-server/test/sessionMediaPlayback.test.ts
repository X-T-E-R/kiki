import Fastify from 'fastify';
import type { Scope } from '@kiki/agent-core-v2';
import { afterEach, describe, expect, it, vi } from 'vitest';

const openSessionMedia = vi.hoisted(() => vi.fn());
vi.mock('../src/routes/sessionMedia', () => ({ openSessionMedia }));

import { registerHostMediaPreviewRoutes } from '../src/routes/hostMediaPreview';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  openSessionMedia.mockReset();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const bytes = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3, 4, 5, 6, 7, 8]);

function appFor() {
  const hostFs = { realpath: vi.fn(async (path: string) => path), stat: vi.fn() };
  const core = { accessor: { get: () => hostFs } } as unknown as Scope;
  const app = Fastify();
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  registerHostMediaPreviewRoutes(app, core);
  cleanups.push(() => app.close());
  return { app, hostFs };
}

function file(options?: { readonly missing?: boolean; readonly mime?: string; readonly name?: string; readonly dispose?: ReturnType<typeof vi.fn> }) {
  const calls: ({ readonly start: number; readonly end: number } | undefined)[] = [];
  const dispose = options?.dispose ?? vi.fn(async () => undefined);
  openSessionMedia.mockImplementation(async (_core: unknown, sessionId: string, fileId: string) => {
    if (options?.missing || sessionId !== 'session-a' || fileId !== 'file-a') return { sessionExists: sessionId === 'session-a', operation: { dispose } };
    return {
      sessionExists: true,
      operation: { dispose },
      file: {
        name: options?.name ?? 'clip.mp4',
        mediaType: options?.mime ?? 'video/mp4',
        size: bytes.byteLength,
        path: 'C:/do-not-read/clip.mp4',
        stream: (range?: { readonly start: number; readonly end: number }) => {
          calls.push(range);
          const start = range?.start ?? 0;
          const end = range?.end ?? bytes.byteLength - 1;
          return (async function* () { yield bytes.subarray(start, end + 1); })();
        },
      },
    };
  });
  return { calls, dispose };
}

describe('session media playback', () => {
  it('streams a canonical range and does not read a host path', async () => {
    const { app, hostFs } = appFor();
    const { calls, dispose } = file();
    const opened = await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: 'file-a' } });
    expect(opened.statusCode, opened.body).toBe(200);
    const data = opened.json().data as { preview_id: string; url: string; mime: string; size: number };
    expect(data.mime).toBe('video/mp4');
    expect(data.size).toBe(bytes.byteLength);
    expect(data.url).toContain(`/media-preview/${data.preview_id}`);
    expect(openSessionMedia).toHaveBeenCalledWith(expect.anything(), 'session-a', 'file-a', undefined);
    expect(hostFs.realpath).not.toHaveBeenCalled();
    expect(hostFs.stat).not.toHaveBeenCalled();
    const ranged = await app.inject({ url: `/media-preview/${data.preview_id}`, headers: { range: 'bytes=0-3' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-type']).toContain('video/mp4');
    expect(ranged.headers['content-range']).toBe(`bytes 0-3/${bytes.byteLength}`);
    expect([...ranged.rawPayload]).toEqual([...bytes.subarray(0, 4)]);
    expect(calls).toEqual([{ start: 0, end: 3 }]);
    expect(dispose).toHaveBeenCalled();
    expect(hostFs.realpath).not.toHaveBeenCalled();
  });

  it('rejects a missing canonical file, a host path, a bad range, revoke, and expiry', async () => {
    const { app, hostFs } = appFor();
    const { calls } = file();
    expect((await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: 'file-a', path: 'C:/clip.mp4' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: 'missing' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/other-session/media-playback', payload: { file_id: 'file-a' } })).statusCode).toBe(404);
    expect(hostFs.realpath).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    file({ mime: 'text/plain', name: 'notes.txt' });
    expect((await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: 'file-a' } })).statusCode).toBe(400);
    const granted = file();
    const opened = await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: 'file-a' } });
    const id = (opened.json().data as { preview_id: string }).preview_id;
    const past = await app.inject({ url: `/media-preview/${id}`, headers: { range: 'bytes=100-120' } });
    expect(past.statusCode).toBe(416);
    expect(past.headers['content-range']).toBe(`bytes */${bytes.byteLength}`);
    expect(granted.calls).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `/api/sessions/media-playback/${id}` })).statusCode).toBe(200);
    expect((await app.inject(`/media-preview/${id}`)).statusCode).toBe(404);
    const now = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      const again = await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: 'file-a' } });
      const next = (again.json().data as { preview_id: string }).preview_id;
      Date.now = () => 1_700_000_000_000 + 30 * 60 * 1000 + 1;
      expect((await app.inject(`/media-preview/${next}`)).statusCode).toBe(404);
    } finally {
      Date.now = now;
    }
    expect((await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: 'file-a' }, remoteAddress: '203.0.113.8' })).statusCode).toBe(403);
  });
});
