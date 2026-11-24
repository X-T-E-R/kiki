import { mkdtemp, open as fsOpen, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import {
  HOST_PINNED_MIN_BYTES,
  IAtomicDocumentStore,
  IBootstrapService,
  IHostFileSystem,
  ISessionIndex,
  ISessionManager,
  isHostPinnedSupported,
  registerHostPinnedRef,
  sessionScopeOf,
  workspacePersistenceScope,
  type Scope,
} from '@kiki/agent-core-v2';
import { JsonAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';
import { afterEach, describe, expect, it } from 'vitest';

import { createAuthHook } from '../src/middleware/auth';
import { registerHostMediaPreviewRoutes } from '../src/routes/hostMediaPreview';
import type { IAuthTokenService } from '../src/services/auth/authTokenService';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const OWNER_HEADERS = { authorization: 'Bearer fixture-owner' };

function makeFakeMp4(totalBytes: number): Buffer {
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x6d, 0x70, 0x34, 0x31,
  ]);
  const moov = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x6d, 0x6f, 0x6f, 0x76]);
  const mdatSize = Math.max(16, totalBytes - ftyp.byteLength - moov.byteLength);
  const out = Buffer.alloc(ftyp.byteLength + moov.byteLength + mdatSize);
  ftyp.copy(out, 0);
  moov.copy(out, ftyp.byteLength);
  out.writeUInt32BE(mdatSize, ftyp.byteLength + moov.byteLength);
  out.write('mdat', ftyp.byteLength + moov.byteLength + 4, 'ascii');
  for (let i = ftyp.byteLength + moov.byteLength + 8; i < out.byteLength; i += 4096) {
    out[i] = (i >>> 12) & 0xff;
  }
  return out;
}

describe('host-pinned playback route & canonical playback hardening', () => {
  it('streams verified host-pinned Range, rejects tampered/deleted/cross-session with 404 zero-leak, and blocks hostref/sha256 in canonical playback', async () => {
    const prevHelperEnv = process.env['KIKI_WINDOWS_PROCESS_HELPER'];
    delete process.env['KIKI_WINDOWS_PROCESS_HELPER'];
    cleanups.push(async () => {
      if (prevHelperEnv === undefined) delete process.env['KIKI_WINDOWS_PROCESS_HELPER'];
      else process.env['KIKI_WINDOWS_PROCESS_HELPER'] = prevHelperEnv;
    });

    const homeDir = await mkdtemp(join(tmpdir(), 'kap-hp-home-'));
    const wsDir = await mkdtemp(join(tmpdir(), 'kap-hp-ws-'));
    cleanups.push(() => rm(homeDir, { recursive: true, force: true }));
    cleanups.push(() => rm(wsDir, { recursive: true, force: true }));

    const storage = new FileStorageService(homeDir);
    cleanups.push(() => storage.close());
    const docs = new JsonAtomicDocumentStore(storage);
    const sessionId = 'session_hp_1';
    const workspaceId = 'wd_hp_1';
    const sessionScope = sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId);

    const services = new Map<unknown, unknown>([
      [IHostFileSystem, {}],
      [IAtomicDocumentStore, docs],
      [IBootstrapService, { scope: (name: string) => name }],
      [ISessionManager, { get: () => undefined }],
      [ISessionIndex, {
        get: async (id: string) => (id === sessionId ? { id: sessionId, workspaceId } : undefined),
      }],
    ]);
    const core = {
      accessor: {
        get: (token: unknown) => services.get(token),
      },
    } as unknown as Scope;

    const app = Fastify();
    app.setValidatorCompiler(() => () => true);
    app.setSerializerCompiler(() => (data) => JSON.stringify(data));
    app.addHook(
      'onRequest',
      createAuthHook({ isValid: async (token: string) => token === 'fixture-owner' } as IAuthTokenService),
    );
    registerHostMediaPreviewRoutes(app, core, undefined, true);
    cleanups.push(() => app.close());

    const canonicalRejectHostRef = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/media-playback`,
      headers: OWNER_HEADERS,
      payload: { file_id: `hostref:hp_${'a'.repeat(32)}` },
    });
    expect(canonicalRejectHostRef.statusCode).toBe(404);

    const canonicalRejectSha = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/media-playback`,
      headers: OWNER_HEADERS,
      payload: { file_id: 'b'.repeat(64) },
    });
    expect(canonicalRejectSha.statusCode).toBe(404);

    if (!isHostPinnedSupported()) return;

    const mp4 = makeFakeMp4(HOST_PINNED_MIN_BYTES + 128 * 1024);
    const mp4Path = join(wsDir, 'source.mp4');
    await writeFile(mp4Path, mp4);

    const record = await registerHostPinnedRef(docs, {
      sessionScope,
      sessionId,
      path: mp4Path,
      mimeType: 'video/mp4',
      allowedRoots: [wsDir],
    });

    const crossSession = await app.inject({
      method: 'POST',
      url: '/api/sessions/other_session/host-pinned-playback',
      headers: OWNER_HEADERS,
      payload: { ref_id: record.refId },
    });
    expect(crossSession.statusCode).toBe(404);
    expect(crossSession.json()).toMatchObject({ msg: 'media_source_changed_or_missing' });

    const remoteDenied = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/host-pinned-playback`,
      headers: OWNER_HEADERS,
      remoteAddress: '10.0.0.5',
      payload: { ref_id: record.refId },
    });
    expect(remoteDenied.statusCode).toBe(403);

    const minted = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/host-pinned-playback`,
      headers: OWNER_HEADERS,
      payload: { ref_id: `hostref:${record.refId}` },
    });
    expect(minted.statusCode).toBe(200);
    const previewUrl = (minted.json() as { data: { url: string } }).data.url;

    const rangeRes = await app.inject({
      method: 'GET',
      url: previewUrl,
      headers: { range: 'bytes=0-65535' },
    });
    expect(rangeRes.statusCode).toBe(206);
    expect(rangeRes.headers['cache-control']).toBe('private, no-store');
    expect(rangeRes.rawPayload).toEqual(mp4.subarray(0, 65536));

    const beforeStat = await stat(mp4Path);
    const fh = await fsOpen(mp4Path, 'r+');
    const mid = Math.floor(mp4.byteLength / 2);
    await fh.write(Buffer.from([mp4[mid]! ^ 0xff]), 0, 1, mid);
    await fh.close();
    await utimes(mp4Path, beforeStat.atime, beforeStat.mtime);

    const tamperedStream = await app.inject({
      method: 'GET',
      url: previewUrl,
      headers: { range: 'bytes=0-65535' },
    });
    expect(tamperedStream.statusCode).toBe(404);
    expect(tamperedStream.json()).toMatchObject({ msg: 'media_source_changed_or_missing' });

    const tamperedMint = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/host-pinned-playback`,
      headers: OWNER_HEADERS,
      payload: { ref_id: record.refId },
    });
    expect(tamperedMint.statusCode).toBe(404);
    expect(tamperedMint.json()).toMatchObject({ msg: 'media_source_changed_or_missing' });

    await rm(mp4Path);
    const deletedStream = await app.inject({
      method: 'GET',
      url: previewUrl,
    });
    expect(deletedStream.statusCode).toBe(404);
    expect(deletedStream.json()).toMatchObject({ msg: 'media_source_changed_or_missing' });
  }, 45_000);
});
