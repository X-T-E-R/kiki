import { mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import Fastify from 'fastify';
import type { Scope } from '@kiki/agent-core-v2';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAuthHook } from '../src/middleware/auth';
import { registerHostMediaPreviewRoutes } from '../src/routes/hostMediaPreview';
import { registerWorkspaceFsRoutes } from '../src/routes/workspaceFs';
import type { IAuthTokenService } from '../src/services/auth/authTokenService';
import { setWebPrincipal } from '../src/services/webAccess';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).toReversed()) await cleanup(); });

const OWNER_HEADERS = { authorization: 'Bearer fixture-owner' };

function makePngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.byteLength, 0);
  const crcInput = Buffer.concat([typeBytes, Buffer.from(data)]);
  let crc = 0xffffffff;
  for (const byte of crcInput) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([len, typeBytes, Buffer.from(data), crcBuf]);
}

function makeSolidOnePixelPng(r: number, g: number, b: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = deflateSync(Buffer.from([0, r, g, b]), { level: 0 });
  return Buffer.concat([
    sig,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', new Uint8Array()),
  ]);
}

async function fixture(options?: { readonly allowExternalHostPaths?: boolean; readonly withAuth?: boolean; readonly onStat?: (path: string) => Promise<void> }) {
  const root = await mkdtemp(join(tmpdir(), 'media-preview-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const video = join(root, 'clip.mp4');
  const bytes = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3, 4, 5, 6, 7, 8]);
  await writeFile(video, bytes);
  await writeFile(join(root, 'notes.txt'), 'hello');
  const hostFs = {
    realpath: (path: string) => realpath(path),
    stat: async (path: string) => {
      if (options?.onStat !== undefined) await options.onStat(path);
      const info = await stat(path);
      return { isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size, mtimeMs: info.mtimeMs, ino: path.endsWith('.png') ? 0 : info.ino };
    },
    readBytes: async (path: string, length: number) => (await readFile(path)).subarray(0, length),
  };
  const core = { accessor: { get: () => hostFs } } as unknown as Scope;
  const app = Fastify();
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  if (options?.withAuth !== false) {
    app.addHook(
      'onRequest',
      createAuthHook(
        { isValid: async (token: string) => token === 'fixture-owner' } as IAuthTokenService,
        {
          authorizeCookie: async (req, reply) => {
            if (req.headers.cookie !== 'kiki_web=1') {
              await reply.code(401).send({ code: 40101, msg: 'unauthorized' });
              return false;
            }
            setWebPrincipal(req, { kind: 'web', sessionId: 'web-1' });
            return true;
          },
        },
      ),
    );
  }
  registerHostMediaPreviewRoutes(app, core, undefined, options?.allowExternalHostPaths ?? true);
  registerWorkspaceFsRoutes(app as unknown as Parameters<typeof registerWorkspaceFsRoutes>[0], core);
  cleanups.push(() => app.close());
  return { app, root, video, bytes };
}

describe('host media preview', () => {
  it('serves a loopback video with range, type and revoke, and rejects other files', async () => {
    const { app, video, bytes } = await fixture();
    const opened = await app.inject({ method: 'POST', url: '/api/fs:media-preview', headers: OWNER_HEADERS, payload: { path: video } });
    expect(opened.statusCode, opened.body).toBe(200);
    const data = opened.json().data as { preview_id: string; url: string; mime: string; size: number };
    expect(data.mime).toBe('video/mp4');
    expect(data.size).toBe(bytes.byteLength);
    expect(data.url).toContain(`/media-preview/${data.preview_id}`);
    const ranged = await app.inject({ url: `/media-preview/${data.preview_id}`, headers: { range: 'bytes=0-3' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-type']).toContain('video/mp4');
    expect(ranged.headers['accept-ranges']).toBe('bytes');
    expect(ranged.headers['cache-control']).toBe('private, no-store');
    expect(ranged.headers['content-range']).toBe(`bytes 0-3/${bytes.byteLength}`);
    expect([...ranged.rawPayload]).toEqual([...bytes.subarray(0, 4)]);
    const remoteRead = await app.inject({ url: `/media-preview/${data.preview_id}`, remoteAddress: '198.51.100.7' });
    expect(remoteRead.statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/fs:media-preview', headers: OWNER_HEADERS, payload: { path: video.replace(/clip\.mp4$/u, 'notes.txt') } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/fs:media-preview', headers: OWNER_HEADERS, payload: { path: 'clip.mp4' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/fs:media-preview/${data.preview_id}`, headers: OWNER_HEADERS })).statusCode).toBe(200);
    expect((await app.inject(`/media-preview/${data.preview_id}`)).statusCode).toBe(404);
  });

  it('rejects unauthenticated, web-principal, non-loopback, and ssh-managed host media preview requests', async () => {
    const { app, video } = await fixture();
    expect((await app.inject({ method: 'POST', url: '/api/fs:media-preview', payload: { path: video } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/fs:media-preview', headers: { cookie: 'kiki_web=1' }, payload: { path: video } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/fs:media-preview', headers: OWNER_HEADERS, remoteAddress: '198.51.100.7', payload: { path: video } })).statusCode).toBe(403);

    const noAuthHook = await fixture({ withAuth: false });
    expect((await noAuthHook.app.inject({ method: 'POST', url: '/api/fs:media-preview', payload: { path: noAuthHook.video } })).statusCode).toBe(403);

    const sshManaged = await fixture({ allowExternalHostPaths: false });
    expect((await sshManaged.app.inject({ method: 'POST', url: '/api/fs:media-preview', headers: OWNER_HEADERS, payload: { path: sshManaged.video } })).statusCode).toBe(403);
  });

  it('advertises range requests on the raw file route and isolates media preview cache entries by absolute path', async () => {
    const { app, root, video, bytes } = await fixture({ withAuth: false });
    const full = await app.inject({ url: '/fs:content', query: { path: video } });
    expect(full.statusCode, full.body).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-type']).toContain('video/mp4');
    const ranged = await app.inject({ url: '/fs:content', query: { path: video }, headers: { range: 'bytes=4-7' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['accept-ranges']).toBe('bytes');
    expect([...ranged.rawPayload]).toEqual([...bytes.subarray(4, 8)]);

    const redPng = makeSolidOnePixelPng(255, 0, 0);
    const bluePng = makeSolidOnePixelPng(0, 0, 255);
    expect(redPng.byteLength).toBe(bluePng.byteLength);
    const redPath = join(root, 'red.png');
    const bluePath = join(root, 'blue.png');
    await writeFile(redPath, redPng);
    await writeFile(bluePath, bluePng);
    const fixedTime = new Date('2026-01-01T00:00:00.000Z');
    await utimes(redPath, fixedTime, fixedTime);
    await utimes(bluePath, fixedTime, fixedTime);

    const redPreview = await app.inject({ url: '/fs:content', query: { path: redPath, preview: 'media' } });
    const bluePreview = await app.inject({ url: '/fs:content', query: { path: bluePath, preview: 'media' } });
    expect(redPreview.statusCode).toBe(200);
    expect(bluePreview.statusCode).toBe(200);
    expect(redPreview.headers.etag).toBe(bluePreview.headers.etag);
    expect(Buffer.compare(redPreview.rawPayload, bluePreview.rawPayload)).not.toBe(0);
  });

  it('honors If-Range with stat-based ETag on host /media-preview/:id range requests', async () => {
    const { app, video, bytes } = await fixture();
    const opened = await app.inject({ method: 'POST', url: '/api/fs:media-preview', headers: OWNER_HEADERS, payload: { path: video } });
    expect(opened.statusCode, opened.body).toBe(200);
    const id = (opened.json().data as { preview_id: string }).preview_id;

    const first = await app.inject({ url: `/media-preview/${id}`, headers: { range: 'bytes=0-3' } });
    expect(first.statusCode).toBe(206);
    expect(first.headers['cache-control']).toBe('private, no-store');
    const etag = first.headers['etag'];
    expect(typeof etag).toBe('string');

    const matched = await app.inject({ url: `/media-preview/${id}`, headers: { range: 'bytes=4-7', 'if-range': String(etag) } });
    expect(matched.statusCode).toBe(206);
    expect([...matched.rawPayload]).toEqual([...bytes.subarray(4, 8)]);

    const mismatched = await app.inject({ url: `/media-preview/${id}`, headers: { range: 'bytes=4-7', 'if-range': '"0-0"' } });
    expect(mismatched.statusCode).toBe(200);
    expect([...mismatched.rawPayload]).toEqual([...bytes]);
  });

  it('rejects new overlapping GET requests after grant expiry while letting an in-flight stream finish and deletes it on close', async () => {
    const now = Date.now;
    let fakeNow = 1_700_000_000_000;
    Date.now = () => fakeNow;
    const root = await mkdtemp(join(tmpdir(), 'media-preview-expiry-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const video = join(root, 'clip.mp4');
    const bytes = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3, 4, 5, 6, 7, 8]);
    await writeFile(video, bytes);
    let statStarted!: () => void;
    const firstInFlight = new Promise<void>((resolve) => { statStarted = resolve; });
    let releaseFirstStat!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirstStat = resolve; });
    let holdNextStat = false;
    const hostFs = {
      realpath: (path: string) => realpath(path),
      stat: async (path: string) => {
        if (holdNextStat) {
          holdNextStat = false;
          statStarted();
          await gate;
        }
        const info = await stat(path);
        return { isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
      },
      readBytes: async (path: string, length: number) => (await readFile(path)).subarray(0, length),
    };
    const core = { accessor: { get: () => hostFs } } as unknown as Scope;
    const app = Fastify();
    app.setValidatorCompiler(() => () => true);
    app.addHook('onRequest', createAuthHook({
      isValid: async (token: string) => token === 'fixture-owner',
    } as IAuthTokenService));
    registerHostMediaPreviewRoutes(app, core, undefined, true);
    cleanups.push(() => app.close());
    try {
      const opened = await app.inject({ method: 'POST', url: '/api/fs:media-preview', headers: OWNER_HEADERS, payload: { path: video } });
      expect(opened.statusCode, opened.body).toBe(200);
      const id = (opened.json().data as { preview_id: string }).preview_id;

      holdNextStat = true;
      const firstStream = app.inject({ url: `/media-preview/${id}`, headers: { range: 'bytes=0-3' } });
      await firstInFlight;

      fakeNow += 31 * 60 * 1000;
      const overlapping = await app.inject({ url: `/media-preview/${id}`, headers: { range: 'bytes=0-3' } });
      expect(overlapping.statusCode).toBe(404);
      expect(overlapping.json().msg).toBe('media_preview_not_found');

      releaseFirstStat();
      const completed = await firstStream;
      expect(completed.statusCode).toBe(206);
      expect([...completed.rawPayload]).toEqual([...bytes.subarray(0, 4)]);

      fakeNow = 1_700_000_000_000 + 1;
      const afterClose = await app.inject({ url: `/media-preview/${id}`, headers: { range: 'bytes=0-3' } });
      expect(afterClose.statusCode).toBe(404);
    } finally {
      releaseFirstStat();
      Date.now = now;
    }
  });
});
