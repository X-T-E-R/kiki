import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

import Fastify, { type FastifyInstance } from 'fastify';
import {
  IBootstrapService,
  IHostFileSystem,
  ISessionContext,
  ISessionIndex,
  ISessionManager,
  ISessionMetadata,
  SessionIndexBuildingError,
  SessionIndexReconcilePendingError,
  sessionScopeOf,
  workspacePersistenceScope,
  type Scope,
  type SessionSummary,
} from '@kiki/agent-core-v2';
import {
  ISessionMediaStore,
  type SessionMediaFile,
} from '@kiki/agent-core-v2/agent/media/sessionMediaStore';
import { ScopedMediaStore } from '@kiki/agent-core-v2/agent/media/sessionMediaStoreService';
import { FileError, FileErrors, IFileService } from '@kiki/agent-core-v2/app/file/fileService';
import { InMemoryStorageService } from '@kiki/agent-core-v2/persistence/backends/memory/inMemoryStorageService';
import { JsonAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/backends/node-fs/atomicDocumentStore';
import { IAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService, type StorageReadRange } from '@kiki/agent-core-v2/persistence/interface/storage';
import { ErrorCode } from '@kiki/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerHostMediaPreviewRoutes } from '../src/routes/hostMediaPreview';
import { createAuthHook } from '../src/middleware/auth';
import type { IAuthTokenService } from '../src/services/auth/authTokenService';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  delete process.env['KIKI_MEDIA_PLAYBACK_MAX_GRANTS'];
  delete process.env['KIKI_REMOTE_MEDIA_PLAYBACK'];
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const mp4Bytes = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 1, 2, 3, 4]);
const wavBytes = (() => {
  const buf = Buffer.alloc(64);
  buf.write('RIFF', 0, 'latin1');
  buf.write('WAVE', 8, 'latin1');
  return new Uint8Array(buf);
})();

class RecordingStorage extends InMemoryStorageService {
  readonly rangeCalls: ({ readonly start: number; readonly end: number } | undefined)[] = [];

  override async *readStream(scope: string, key: string, range?: StorageReadRange): AsyncIterable<Uint8Array> {
    this.rangeCalls.push(range);
    yield* super.readStream(scope, key, range);
  }
}

interface HarnessOptions {
  readonly indexGet?: (sessionId: string) => Promise<SessionSummary | undefined>;
  readonly liveSessions?: ReadonlyMap<string, unknown>;
  readonly acquire?: ReturnType<typeof vi.fn>;
  readonly authToken?: string;
}

async function createMediaHarness(options?: HarnessOptions) {
  const storage = new RecordingStorage();
  const documents = new JsonAtomicDocumentStore(storage);
  const mediaScope = `${sessionScopeOf(workspacePersistenceScope('sessions', 'ws-a'), 'session-a')}/media`;
  const store = new ScopedMediaStore(mediaScope, storage, documents);
  const clipFileId = 'f_0123456789abcdef';
  const textFileId = 'f_fedcba9876543210';
  await store.materialize({
    fileId: clipFileId,
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    size: mp4Bytes.byteLength,
    stream: () => Readable.from([mp4Bytes]),
  });
  const textBytes = Buffer.from('plain notes');
  await store.materialize({
    fileId: textFileId,
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: textBytes.byteLength,
    stream: () => Readable.from([textBytes]),
  });

  const hostFs = { realpath: vi.fn(async (path: string) => path), stat: vi.fn() };
  const fileService = {
    get: vi.fn(async () => { throw new FileError(FileErrors.codes.FILE_NOT_FOUND, 'file not found'); }),
  };
  const defaultSummary: SessionSummary = {
    id: 'session-a',
    workspaceId: 'ws-a',
    cwd: '/example/workspace',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    private: false,
  };
  const indexGet = options?.indexGet ?? (async (id: string) => id === 'session-a' ? defaultSummary : undefined);
  const liveSessions = options?.liveSessions ?? new Map<string, unknown>();
  const acquire = options?.acquire ?? vi.fn(async () => undefined);
  const services = new Map<unknown, unknown>([
    [IHostFileSystem, hostFs],
    [IBootstrapService, { scope: (name: string) => name }],
    [IFileSystemStorageService, storage],
    [IAtomicDocumentStore, documents],
    [IFileService, fileService],
    [ISessionIndex, { get: indexGet }],
    [ISessionManager, {
      isEphemeral: () => false,
      get: (id: string) => liveSessions.get(id),
      acquire,
    }],
  ]);
  const core = {
    accessor: {
      get: (token: unknown) => {
        const service = services.get(token);
        if (service === undefined) throw new Error(`unexpected service token: ${String(token)}`);
        return service;
      },
    },
  } as unknown as Scope;

  const app = Fastify();
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  if (options?.authToken !== undefined) {
    app.addHook('onRequest', createAuthHook({ isValid: async (token: string) => token === options.authToken } as IAuthTokenService));
  }
  registerHostMediaPreviewRoutes(app, core);
  cleanups.push(() => app.close());

  return {
    app,
    hostFs,
    storage,
    acquire,
    clipFileId,
    textFileId,
  };
}

function makeSessionHandle(options: {
  readonly fileId: string;
  readonly isPrivate?: boolean;
  readonly streamFactory: (range?: { readonly start: number; readonly end: number }) => AsyncIterable<Uint8Array>;
  readonly mediaType?: string;
  readonly name?: string;
  readonly size?: number;
}) {
  const isPrivate = options.isPrivate ?? false;
  const mediaFile: SessionMediaFile = {
    name: options.name ?? 'clip.mp4',
    mediaType: options.mediaType ?? 'video/mp4',
    size: options.size ?? mp4Bytes.byteLength,
    stream: options.streamFactory,
  };
  return {
    accessor: {
      get: (token: unknown) => {
        if (token === ISessionContext) return { workspaceId: 'ws-live', ephemeral: false, isPrivate: () => isPrivate };
        if (token === ISessionMetadata) return { isPrivate: () => isPrivate, snapshot: () => ({ private: isPrivate }) };
        if (token === ISessionMediaStore) {
          return {
            open: async (id: string) => id === options.fileId ? mediaFile : undefined,
          };
        }
        throw new Error(`unexpected session token: ${String(token)}`);
      },
    },
  };
}

describe('session media playback', () => {
  it('streams a canonical range through real openSessionMedia without reading a host path and honors If-Range', async () => {
    const { app, hostFs, storage, clipFileId } = await createMediaHarness();
    const opened = await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: clipFileId } });
    expect(opened.statusCode, opened.body).toBe(200);
    const data = opened.json().data as { preview_id: string; url: string; mime: string; size: number };
    expect(data.mime).toBe('video/mp4');
    expect(data.size).toBe(mp4Bytes.byteLength);
    expect(data.url).toContain(`/media-preview/${data.preview_id}`);
    expect(hostFs.realpath).not.toHaveBeenCalled();
    expect(hostFs.stat).not.toHaveBeenCalled();

    const ranged = await app.inject({ url: `/media-preview/${data.preview_id}`, headers: { range: 'bytes=0-3' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-type']).toContain('video/mp4');
    expect(ranged.headers['content-range']).toBe(`bytes 0-3/${mp4Bytes.byteLength}`);
    expect(ranged.headers['cache-control']).toBe('private, max-age=1800, immutable');
    const etag = ranged.headers['etag'];
    expect(typeof etag).toBe('string');
    expect([...ranged.rawPayload]).toEqual([...mp4Bytes.subarray(0, 4)]);
    expect(storage.rangeCalls).toEqual([{ start: 0, end: 3 }]);

    const matchingIfRange = await app.inject({
      url: `/media-preview/${data.preview_id}`,
      headers: { range: 'bytes=4-7', 'if-range': String(etag) },
    });
    expect(matchingIfRange.statusCode).toBe(206);
    expect([...matchingIfRange.rawPayload]).toEqual([...mp4Bytes.subarray(4, 8)]);

    const mismatchedIfRange = await app.inject({
      url: `/media-preview/${data.preview_id}`,
      headers: { range: 'bytes=4-7', 'if-range': '"stale-etag"' },
    });
    expect(mismatchedIfRange.statusCode).toBe(200);
    expect([...mismatchedIfRange.rawPayload]).toEqual([...mp4Bytes]);
    expect(hostFs.realpath).not.toHaveBeenCalled();
  });

  it('serves live resident session audio in <100ms even while ISessionIndex is reconciling and acquireSessionOperation is blocked', async () => {
    const neverResolves = new Promise<never>(() => {});
    const acquireSpy = vi.fn(() => neverResolves);
    const livePub = makeSessionHandle({
      fileId: 'audio-live-1',
      isPrivate: false,
      name: 'voice.wav',
      mediaType: 'audio/wav',
      size: wavBytes.byteLength,
      streamFactory: (range) => (async function* () {
        const start = range?.start ?? 0;
        const end = range?.end ?? wavBytes.byteLength - 1;
        yield wavBytes.subarray(start, end + 1);
      })(),
    });
    const livePriv = makeSessionHandle({
      fileId: 'audio-live-1',
      isPrivate: true,
      name: 'secret.wav',
      mediaType: 'audio/wav',
      size: wavBytes.byteLength,
      streamFactory: (range) => (async function* () {
        const start = range?.start ?? 0;
        const end = range?.end ?? wavBytes.byteLength - 1;
        yield wavBytes.subarray(start, end + 1);
      })(),
    });
    const { app } = await createMediaHarness({
      indexGet: async () => { throw new SessionIndexReconcilePendingError('concurrent_changes', 1); },
      liveSessions: new Map<string, unknown>([
        ['session-live-pub', livePub],
        ['session-live-priv', livePriv],
      ]),
      acquire: acquireSpy,
    });

    const t0 = performance.now();
    const opened = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-live-pub/media-playback',
      payload: { file_id: 'audio-live-1' },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const id = (opened.json().data as { preview_id: string }).preview_id;

    const ranged = await app.inject({
      url: `/media-preview/${id}`,
      headers: { range: 'bytes=0-11' },
    });
    const elapsedMs = performance.now() - t0;
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['cache-control']).toBe('private, max-age=1800, immutable');
    expect([...ranged.rawPayload]).toEqual([...wavBytes.subarray(0, 12)]);
    expect(elapsedMs).toBeLessThan(100);
    expect(acquireSpy).not.toHaveBeenCalled();

    const privOpened = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-live-priv/media-playback',
      payload: { file_id: 'audio-live-1' },
    });
    expect(privOpened.statusCode, privOpened.body).toBe(200);
    const privId = (privOpened.json().data as { preview_id: string }).preview_id;
    const privRanged = await app.inject({
      url: `/media-preview/${privId}`,
      headers: { range: 'bytes=0-3' },
    });
    expect(privRanged.statusCode).toBe(206);
    expect(privRanged.headers['cache-control']).toBe('private, no-store');
  });

  it('returns 503 SESSION_BUSY JSON envelope instead of 500 when cold session preparation hits SessionIndexBuildingError', async () => {
    const acquireSpy = vi.fn(async () => { throw new SessionIndexBuildingError(); });
    const { app } = await createMediaHarness({
      indexGet: async () => { throw new SessionIndexBuildingError(); },
      acquire: acquireSpy,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/cold-building/media-playback',
      payload: { file_id: 'f_aaaaaaaaaaaaaaaa' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      code: ErrorCode.SESSION_BUSY,
    });
  });

  it('rejects a missing canonical file, a host path, a bad range, revoke, and expiry', async () => {
    const { app, hostFs, storage, clipFileId, textFileId } = await createMediaHarness();
    expect((await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: clipFileId, path: 'C:/clip.mp4' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: 'f_missing000000000' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/other-session/media-playback', payload: { file_id: clipFileId } })).statusCode).toBe(404);
    expect(hostFs.realpath).not.toHaveBeenCalled();
    expect(storage.rangeCalls).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: textFileId } })).statusCode).toBe(400);

    const opened = await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: clipFileId } });
    const id = (opened.json().data as { preview_id: string }).preview_id;
    const past = await app.inject({ url: `/media-preview/${id}`, headers: { range: 'bytes=100-120' } });
    expect(past.statusCode).toBe(416);
    expect(past.headers['content-range']).toBe(`bytes */${mp4Bytes.byteLength}`);
    expect(storage.rangeCalls).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `/api/sessions/media-playback/${id}` })).statusCode).toBe(200);
    expect((await app.inject(`/media-preview/${id}`)).statusCode).toBe(404);

    const now = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      const again = await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: clipFileId } });
      const next = (again.json().data as { preview_id: string }).preview_id;
      Date.now = () => 1_700_000_000_000 + 30 * 60 * 1000 + 1;
      expect((await app.inject(`/media-preview/${next}`)).statusCode).toBe(404);
    } finally {
      Date.now = now;
    }
    expect((await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: clipFileId }, remoteAddress: '203.0.113.8' })).statusCode).toBe(403);
  });

  it('stops the stream cleanly without unhandled rejections when the stream fails or closes early', async () => {
    let streamMode: 'fail' | 'empty' = 'fail';
    const handle = makeSessionHandle({
      fileId: 'file-a',
      streamFactory: () => streamMode === 'fail' ? failingByteStream(new Error('stream broke')) : emptyByteStream(),
    });
    const { app } = await createMediaHarness({
      liveSessions: new Map<string, unknown>([['session-live', handle]]),
    });
    const seen = watchLogs(app);
    const unhandled = trackUnhandled();
    try {
      const opened = await app.inject({ method: 'POST', url: '/api/sessions/session-live/media-playback', payload: { file_id: 'file-a' } });
      expect(opened.statusCode, opened.body).toBe(200);
      const id = (opened.json().data as { preview_id: string }).preview_id;
      await app.inject(`/media-preview/${id}`).catch(() => undefined);
      await vi.waitFor(() => {
        expect(seen.some((entry) => entry.level === 'warn' && entry.message === 'session media stream error')).toBe(true);
      });

      seen.splice(0);
      streamMode = 'empty';
      const again = await app.inject({ method: 'POST', url: '/api/sessions/session-live/media-playback', payload: { file_id: 'file-a' } });
      expect(again.statusCode, again.body).toBe(200);
      const next = (again.json().data as { preview_id: string }).preview_id;
      await app.inject(`/media-preview/${next}`).catch(() => undefined);
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(unhandled.reasons).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it('destroys the stream cleanly without unhandled rejections when send fails', async () => {
    const cleaned = vi.fn();
    const handle = makeSessionHandle({
      fileId: 'file-a',
      streamFactory: (range) => (async function* () {
        try {
          const start = range?.start ?? 0;
          const end = range?.end ?? mp4Bytes.byteLength - 1;
          yield mp4Bytes.subarray(start, end + 1);
        } finally {
          cleaned();
        }
      })(),
    });
    const { app } = await createMediaHarness({
      liveSessions: new Map<string, unknown>([['session-live', handle]]),
    });
    const unhandled = trackUnhandled();
    try {
      app.addHook('onRequest', async (req, reply) => {
        if (req.url.includes('send-fail')) {
          const send = reply.send.bind(reply);
          reply.send = ((payload?: unknown) => {
            if (payload !== null && typeof payload === 'object' && typeof (payload as { pipe?: unknown }).pipe === 'function') throw new Error('send failed');
            return send(payload as never);
          }) as typeof reply.send;
        }
      });
      const opened = await app.inject({ method: 'POST', url: '/api/sessions/session-live/media-playback', payload: { file_id: 'file-a' } });
      expect(opened.statusCode, opened.body).toBe(200);
      const id = (opened.json().data as { preview_id: string }).preview_id;
      const failed = await app.inject({ url: `/media-preview/${id}?send-fail=1` });
      expect(failed.statusCode).toBe(500);
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(unhandled.reasons).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it('aborts and cleans up the active stream when the client disconnects', async () => {
    const unhandled = trackUnhandled();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const streamClosed = vi.fn();
    const handle = makeSessionHandle({
      fileId: 'file-a',
      streamFactory: async function* () {
        try {
          started();
          yield mp4Bytes.subarray(0, 4);
          await gate;
          yield mp4Bytes.subarray(4);
        } finally {
          streamClosed();
        }
      },
    });
    const { app } = await createMediaHarness({
      liveSessions: new Map<string, unknown>([['session-live', handle]]),
    });
    try {
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const opened = await fetch(`${base}/api/sessions/session-live/media-playback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: 'file-a' }),
      });
      expect(opened.status).toBe(200);
      const id = ((await opened.json()) as { data: { preview_id: string } }).data.preview_id;
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      const playback = httpRequest({ host: '127.0.0.1', port: address.port, path: `/media-preview/${id}` });
      playback.on('error', () => undefined);
      playback.end();
      await reading;
      playback.destroy();
      releaseGate();
      await vi.waitFor(() => { expect(streamClosed).toHaveBeenCalledTimes(1); });
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(unhandled.reasons).toEqual([]);
    } finally {
      releaseGate();
      unhandled.stop();
    }
  });

  it('supports more than 64 grants by default and never evicts an actively streaming grant when at capacity', async () => {
    const { app, clipFileId } = await createMediaHarness();
    const ids: string[] = [];
    for (let i = 0; i < 80; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/api/sessions/session-a/media-playback', payload: { file_id: clipFileId } });
      expect(res.statusCode).toBe(200);
      ids.push((res.json().data as { preview_id: string }).preview_id);
    }
    const firstStillValid = await app.inject({ url: `/media-preview/${ids[0]}`, headers: { range: 'bytes=0-3' } });
    expect(firstStillValid.statusCode).toBe(206);

    process.env['KIKI_MEDIA_PLAYBACK_MAX_GRANTS'] = '3';
    let streamStarted!: () => void;
    const streaming = new Promise<void>((resolve) => { streamStarted = resolve; });
    let finishStream!: () => void;
    const streamGate = new Promise<void>((resolve) => { finishStream = resolve; });
    let holdFirst = true;
    const liveHandle = makeSessionHandle({
      fileId: 'file-a',
      streamFactory: async function* () {
        if (holdFirst) {
          holdFirst = false;
          streamStarted();
          await streamGate;
        }
        yield mp4Bytes;
      },
    });
    const bounded = (await createMediaHarness({
      liveSessions: new Map<string, unknown>([['session-a', liveHandle]]),
    })).app;
    try {
      const base = await bounded.listen({ host: '127.0.0.1', port: 0 });
      const mint = async () => {
        const response = await fetch(`${base}/api/sessions/session-a/media-playback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file_id: 'file-a' }),
        });
        expect(response.status).toBe(200);
        return ((await response.json()) as { data: { preview_id: string } }).data.preview_id;
      };
      const g1 = await mint();
      const g2 = await mint();
      const g3 = await mint();
      const activeFetch = fetch(`${base}/media-preview/${g1}`);
      await streaming;
      const g4 = await mint();
      expect(g4).toBeTruthy();
      finishStream();
      const activeRes = await activeFetch;
      expect(activeRes.status).toBe(200);
      const afterEvictG1 = await bounded.inject({ url: `/media-preview/${g1}`, headers: { range: 'bytes=0-3' } });
      expect(afterEvictG1.statusCode).toBe(206);
      const afterEvictG2 = await bounded.inject({ url: `/media-preview/${g2}`, headers: { range: 'bytes=0-3' } });
      expect(afterEvictG2.statusCode).toBe(404);
      const afterEvictG3 = await bounded.inject({ url: `/media-preview/${g3}`, headers: { range: 'bytes=0-3' } });
      expect(afterEvictG3.statusCode).toBe(206);
    } finally {
      finishStream();
    }
  });

  it('enables IP-bound authenticated remote session Range streaming only when KIKI_REMOTE_MEDIA_PLAYBACK=true', async () => {
    process.env['KIKI_REMOTE_MEDIA_PLAYBACK'] = 'true';
    const { app, clipFileId } = await createMediaHarness({ authToken: 'owner-tok' });

    const unauth = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-a/media-playback',
      remoteAddress: '203.0.113.8',
      payload: { file_id: clipFileId },
    });
    expect(unauth.statusCode).toBe(401);

    const hostRemote = await app.inject({
      method: 'POST',
      url: '/api/fs:media-preview',
      headers: { authorization: 'Bearer owner-tok' },
      remoteAddress: '203.0.113.8',
      payload: { path: '/tmp/clip.mp4' },
    });
    expect(hostRemote.statusCode).toBe(403);

    const minted = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-a/media-playback',
      headers: { authorization: 'Bearer owner-tok' },
      remoteAddress: '203.0.113.8',
      payload: { file_id: clipFileId },
    });
    expect(minted.statusCode, minted.body).toBe(200);
    const id = (minted.json().data as { preview_id: string }).preview_id;

    const sameIpRange = await app.inject({
      url: `/media-preview/${id}`,
      remoteAddress: '203.0.113.8',
      headers: { range: 'bytes=0-3' },
    });
    expect(sameIpRange.statusCode).toBe(206);
    expect([...sameIpRange.rawPayload]).toEqual([...mp4Bytes.subarray(0, 4)]);

    const differentIp = await app.inject({
      url: `/media-preview/${id}`,
      remoteAddress: '198.51.100.9',
      headers: { range: 'bytes=0-3' },
    });
    expect(differentIp.statusCode).toBe(403);
  });
});

function failingByteStream(error: Error): AsyncIterable<Uint8Array> {
  return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }) };
}

function emptyByteStream(): AsyncIterable<Uint8Array> {
  return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) };
}

function watchLogs(app: FastifyInstance): { level: string; message: string }[] {
  const seen: { level: string; message: string }[] = [];
  app.addHook('onRequest', async (req) => {
    const current = req.log;
    const warn = current.warn.bind(current);
    const error = current.error.bind(current);
    current.warn = ((obj?: unknown, message?: unknown) => {
      seen.push({ level: 'warn', message: typeof message === 'string' ? message : '' });
      return warn(obj as never, message as never);
    }) as typeof current.warn;
    current.error = ((obj?: unknown, message?: unknown) => {
      seen.push({ level: 'error', message: typeof message === 'string' ? message : '' });
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
