import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  IHostFileSystem,
  agentScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
  type Scope,
} from '@kiki/agent-core-v2';
import { IBootstrapService } from '@kiki/agent-core-v2/app/bootstrap/bootstrap';
import { ISessionIndex } from '@kiki/agent-core-v2/app/sessionIndex/sessionIndex';
import { ISessionManager } from '@kiki/agent-core-v2/app/sessionManager/sessionManager';
import { BlobStoreService } from '@kiki/agent-core-v2/persistence/backends/node-fs/blobStoreService';
import { InMemoryStorageService } from '@kiki/agent-core-v2/persistence/backends/memory/inMemoryStorageService';
import { IBlobStore } from '@kiki/agent-core-v2/persistence/interface/blobStore';
import type { StorageReadRange } from '@kiki/agent-core-v2/persistence/interface/storage';

import { registerHostMediaPreviewRoutes } from '../src/routes/hostMediaPreview';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

class RangeRecordingStorage extends InMemoryStorageService {
  readonly pulls: { readonly range: StorageReadRange | undefined; readonly bytes: number }[] = [];
  readonly fullReads: string[] = [];

  override async read(scope: string, key: string): Promise<Uint8Array | undefined> {
    this.fullReads.push(key);
    return super.read(scope, key);
  }

  override async *readStream(scope: string, key: string, range?: StorageReadRange): AsyncIterable<Uint8Array> {
    let bytes = 0;
    try {
      for await (const chunk of super.readStream(scope, key, range)) {
        bytes += chunk.byteLength;
        yield chunk;
      }
    } finally {
      this.pulls.push({ range, bytes });
    }
  }
}

function media(byteLength: number, write: (payload: Buffer) => void): Buffer {
  const payload = Buffer.alloc(byteLength);
  write(payload);
  return payload;
}

describe('session playback of a persisted blobref', () => {
  it('identifies audio and video from a bounded read and does not resume a cold session', async () => {
    const storage = new RangeRecordingStorage();
    const blobs = new BlobStoreService(storage);
    const sessionId = 'session-a';
    const scope = `${agentScopeOf(sessionScopeOf(workspacePersistenceScope('sessions', 'ws-1'), sessionId), 'agent-1')}/blobs`;
    const videoHash = 'ab'.repeat(32);
    const audioHash = 'cd'.repeat(32);
    const imageHash = 'ef'.repeat(32);
    const video = media(800, (payload) => { payload.write('ftyp', 4, 'latin1'); payload.write('isom', 8, 'latin1'); });
    const audio = media(800, (payload) => { payload.write('RIFF', 0, 'latin1'); payload.write('WAVE', 8, 'latin1'); });
    const image = media(800, (payload) => { payload.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); });
    await blobs.put(scope, videoHash, video);
    await blobs.put(scope, audioHash, audio);
    await blobs.put(scope, imageHash, image);
    const resumed: string[] = [];
    const hostFs = { realpath: vi.fn(async () => { throw new Error('host path'); }), stat: vi.fn(async () => { throw new Error('host path'); }) };
    const services = new Map<unknown, unknown>([
      [IHostFileSystem, hostFs],
      [ISessionIndex, { get: async (id: string) => id === sessionId ? { id: sessionId, workspaceId: 'ws-1' } : undefined }],
      [IBootstrapService, { scope: (name: string) => name }],
      [ISessionManager, {
        get: () => { resumed.push('get'); throw new Error('resumed'); },
        acquire: () => { resumed.push('acquire'); throw new Error('resumed'); },
      }],
      [IBlobStore, blobs],
    ]);
    const core = { accessor: { get: (token: unknown) => {
      const service = services.get(token);
      if (service === undefined) throw new Error('unexpected service');
      return service;
    } } } as unknown as Scope;
    const app = Fastify();
    app.setValidatorCompiler(() => () => true);
    app.setSerializerCompiler(() => (data) => JSON.stringify(data));
    registerHostMediaPreviewRoutes(app, core);
    cleanups.push(() => app.close());

    expect((await app.inject({ method: 'POST', url: '/api/sessions/other/media-playback', payload: { file_id: `blobref:agent-1:${videoHash}` } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/media-playback`, payload: { file_id: `blobref:agent-1:${'12'.repeat(32)}` } })).statusCode).toBe(404);
    expect(storage.pulls).toEqual([]);
    expect(storage.fullReads).toEqual([]);

    const opened = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/media-playback`, payload: { file_id: `blobref:agent-1:${videoHash}` } });
    expect(opened.statusCode, opened.body).toBe(200);
    const data = opened.json().data as { preview_id: string; mime: string; size: number };
    expect(data.mime).toBe('video/mp4');
    expect(data.size).toBe(video.byteLength);
    expect(storage.pulls).toEqual([{ range: { start: 0, end: 511 }, bytes: 512 }]);
    const ranged = await app.inject({ url: `/media-preview/${data.preview_id}`, headers: { range: 'bytes=0-3' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-type']).toContain('video/mp4');
    expect([...ranged.rawPayload]).toEqual([...video.subarray(0, 4)]);
    expect(storage.pulls).toEqual([
      { range: { start: 0, end: 511 }, bytes: 512 },
      { range: { start: 0, end: 3 }, bytes: 4 },
    ]);

    const wav = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/media-playback`, payload: { file_id: `blobref:agent-1:${audioHash}` } });
    expect(wav.statusCode, wav.body).toBe(200);
    expect((wav.json().data as { mime: string }).mime).toBe('audio/wav');
    expect(storage.pulls.at(-1)).toEqual({ range: { start: 0, end: 511 }, bytes: 512 });

    const png = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/media-playback`, payload: { file_id: `blobref:agent-1:${imageHash}` } });
    expect(png.statusCode).toBe(400);
    expect(storage.fullReads).toEqual([]);
    expect(resumed).toEqual([]);
    expect(hostFs.realpath).not.toHaveBeenCalled();
    expect(hostFs.stat).not.toHaveBeenCalled();
    expect(Buffer.compare(Buffer.from((await blobs.get(scope, videoHash))!), video)).toBe(0);
    expect(Buffer.compare(Buffer.from((await blobs.get(scope, audioHash))!), audio)).toBe(0);
  });
});
