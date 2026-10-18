import { request as httpRequest } from 'node:http';

import Fastify, { type FastifyInstance } from 'fastify';
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
    expect(openSessionMedia).toHaveBeenCalledWith(expect.anything(), 'session-a', 'file-a', undefined, expect.any(AbortSignal));
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

  it('stops the stream and releases the lease once when the stream fails or closes early', async () => {
    const { app } = appFor();
    const seen = watchLogs(app);
    const unhandled = trackUnhandled();
    try {
      const dispose = vi.fn(async () => undefined);
      openSessionMedia.mockImplementation(async () => ({
        sessionExists: true,
        operation: { dispose },
        file: {
          name: 'clip.mp4',
          mediaType: 'video/mp4',
          size: bytes.byteLength,
          stream: async function* () { throw new Error('stream broke'); },
        },
      }));
      const opened = await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: 'file-a' } });
      expect(opened.statusCode, opened.body).toBe(200);
      expect(dispose).toHaveBeenCalledTimes(1);
      const id = (opened.json().data as { preview_id: string }).preview_id;
      await app.inject(`/media-preview/${id}`).catch(() => undefined);
      await vi.waitFor(() => { expect(dispose).toHaveBeenCalledTimes(2); });
      expect(seen.some((entry) => entry.level === 'warn' && entry.message === 'session media stream error')).toBe(true);

      dispose.mockClear();
      seen.splice(0);
      openSessionMedia.mockImplementation(async () => ({
        sessionExists: true,
        operation: { dispose },
        file: {
          name: 'clip.mp4',
          mediaType: 'video/mp4',
          size: bytes.byteLength,
          stream: async function* () { return; },
        },
      }));
      const again = await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: 'file-a' } });
      const next = (again.json().data as { preview_id: string }).preview_id;
      expect(dispose).toHaveBeenCalledTimes(1);
      await app.inject(`/media-preview/${next}`).catch(() => undefined);
      await vi.waitFor(() => { expect(dispose).toHaveBeenCalledTimes(2); });
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(unhandled.reasons).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it('releases the lease once when send fails and reports a rejected release', async () => {
    const { app } = appFor();
    const seen = watchLogs(app);
    const unhandled = trackUnhandled();
    let phase = 0;
    const dispose = vi.fn(async () => {
      phase += 1;
      if (phase > 2) throw new Error('lease release failed');
    });
    try {
      file({ dispose });
      app.addHook('onRequest', async (req, reply) => {
        if (req.url.includes('send-fail')) {
          const send = reply.send.bind(reply);
          reply.send = ((payload?: unknown) => {
            if (payload !== null && typeof payload === 'object' && typeof (payload as { pipe?: unknown }).pipe === 'function') throw new Error('send failed');
            return send(payload as never);
          }) as typeof reply.send;
        }
      });
      const opened = await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: 'file-a' } });
      expect(opened.statusCode, opened.body).toBe(200);
      expect(dispose).toHaveBeenCalledTimes(1);
      const id = (opened.json().data as { preview_id: string }).preview_id;
      await app.inject({ url: `/media-preview/${id}?send-fail=1` }).catch(() => undefined);
      await vi.waitFor(() => { expect(dispose).toHaveBeenCalledTimes(2); });

      phase = 1;
      dispose.mockClear();
      const rejected = await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: 'file-a' } });
      const next = (rejected.json().data as { preview_id: string }).preview_id;
      const played = await app.inject(`/media-preview/${next}`);
      expect(played.statusCode).toBe(200);
      await vi.waitFor(() => { expect(seen.some((entry) => entry.level === 'error' && entry.message === 'session media cleanup failed')).toBe(true); });
      expect(dispose).toHaveBeenCalledTimes(2);
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(unhandled.reasons).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it('releases the lease once when the client disconnects', async () => {
    const { app } = appFor();
    const unhandled = trackUnhandled();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const dispose = vi.fn(async () => undefined);
    openSessionMedia.mockImplementation(async () => ({
      sessionExists: true,
      operation: { dispose },
      file: {
        name: 'clip.mp4',
        mediaType: 'video/mp4',
        size: bytes.byteLength,
        stream: async function* () {
          started();
          await gate;
          yield bytes;
        },
      },
    }));
    try {
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const opened = await fetch(`${base}/api/sessions/session-a/media-playback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: 'file-a' }),
      });
      expect(opened.status).toBe(200);
      expect(dispose).toHaveBeenCalledTimes(1);
      const id = ((await opened.json()) as { data: { preview_id: string } }).data.preview_id;
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      const playback = httpRequest({ host: '127.0.0.1', port: address.port, path: `/media-preview/${id}` });
      playback.on('error', () => undefined);
      playback.end();
      await reading;
      playback.destroy();
      await vi.waitFor(() => { expect(dispose).toHaveBeenCalledTimes(2); });
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(unhandled.reasons).toEqual([]);
    } finally {
      releaseGate();
      unhandled.stop();
    }
  });
});

function watchLogs(app: FastifyInstance): { level: string; message: string }[] {
  const seen: { level: string; message: string }[] = [];
  app.addHook('onRequest', async (req) => {
    const current = req.log;
    const warn = current.warn.bind(current);
    const error = current.error.bind(current);
    current.warn = ((obj?: unknown, message?: unknown) => {
      seen.push({ level: 'warn', message: String(message ?? '') });
      return warn(obj as never, message as never);
    }) as typeof current.warn;
    current.error = ((obj?: unknown, message?: unknown) => {
      seen.push({ level: 'error', message: String(message ?? '') });
      return error(obj as never, message as never);
    }) as typeof current.error;
  });
  return seen;
}

function trackUnhandled(): { reasons: unknown[]; stop: () => void } {
  const reasons: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { reasons.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  return { reasons, stop: () => { process.off('unhandledRejection', onUnhandled); } };
}
