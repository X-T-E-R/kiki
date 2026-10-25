import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { Scope } from '@kiki/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';

import { registerHostMediaPreviewRoutes } from '../src/routes/hostMediaPreview';
import { registerWorkspaceFsRoutes } from '../src/routes/workspaceFs';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).toReversed()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'media-preview-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const video = join(root, 'clip.mp4');
  const bytes = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3, 4, 5, 6, 7, 8]);
  await writeFile(video, bytes);
  await writeFile(join(root, 'notes.txt'), 'hello');
  const hostFs = {
    realpath: (path: string) => realpath(path),
    stat: async (path: string) => {
      const info = await stat(path);
      return { isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
    },
    readBytes: async (path: string, length: number) => (await readFile(path)).subarray(0, length),
  };
  const core = { accessor: { get: () => hostFs } } as unknown as Scope;
  const app = Fastify();
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  registerHostMediaPreviewRoutes(app, core);
  registerWorkspaceFsRoutes(app as unknown as Parameters<typeof registerWorkspaceFsRoutes>[0], core);
  cleanups.push(() => app.close());
  return { app, video, bytes };
}

describe('host media preview', () => {
  it('serves a loopback video with range, type and revoke, and rejects other files', async () => {
    const { app, video, bytes } = await fixture();
    const opened = await app.inject({ method: 'POST', url: '/api/fs:media-preview', payload: { path: video } });
    expect(opened.statusCode, opened.body).toBe(200);
    const data = opened.json().data as { preview_id: string; url: string; mime: string; size: number };
    expect(data.mime).toBe('video/mp4');
    expect(data.size).toBe(bytes.byteLength);
    expect(data.url).toContain(`/media-preview/${data.preview_id}`);
    const ranged = await app.inject({ url: `/media-preview/${data.preview_id}`, headers: { range: 'bytes=0-3' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-type']).toContain('video/mp4');
    expect(ranged.headers['accept-ranges']).toBe('bytes');
    expect(ranged.headers['content-range']).toBe(`bytes 0-3/${bytes.byteLength}`);
    expect([...ranged.rawPayload]).toEqual([...bytes.subarray(0, 4)]);
    expect((await app.inject({ method: 'POST', url: '/api/fs:media-preview', payload: { path: video.replace(/clip\.mp4$/u, 'notes.txt') } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/fs:media-preview', payload: { path: 'clip.mp4' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/fs:media-preview/${data.preview_id}` })).statusCode).toBe(200);
    expect((await app.inject(`/media-preview/${data.preview_id}`)).statusCode).toBe(404);
  });

  it('advertises range requests on the raw file route', async () => {
    const { app, video, bytes } = await fixture();
    const full = await app.inject({ url: '/fs:content', query: { path: video } });
    expect(full.statusCode, full.body).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-type']).toContain('video/mp4');
    const ranged = await app.inject({ url: '/fs:content', query: { path: video }, headers: { range: 'bytes=4-7' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['accept-ranges']).toBe('bytes');
    expect([...ranged.rawPayload]).toEqual([...bytes.subarray(4, 8)]);
  });
});
