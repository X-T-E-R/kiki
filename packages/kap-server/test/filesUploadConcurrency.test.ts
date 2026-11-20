import Fastify from 'fastify';
import { IFileService, type Scope } from '@kiki/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';

import { registerFilesRoutes } from '../src/routes/files';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  delete process.env['KIKI_FILES_UPLOAD_MAX_CONCURRENCY'];
  delete process.env['KIKI_FILES_UPLOAD_MAX_QUEUE'];
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function buildMultipartPayload(filename: string, data: Buffer): { body: Buffer; contentType: string } {
  const boundary = '----KikiUploadGateTestBoundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('files upload concurrency gate', () => {
  it('bounds concurrent uploads and returns 429 when queue capacity is exceeded', async () => {
    process.env['KIKI_FILES_UPLOAD_MAX_CONCURRENCY'] = '2';
    process.env['KIKI_FILES_UPLOAD_MAX_QUEUE'] = '1';

    let active = 0;
    let peakActive = 0;
    const releases: Array<() => void> = [];
    const fileService = {
      save: async (source: AsyncIterable<Uint8Array>, filename: string) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        let size = 0;
        for await (const chunk of source) size += chunk.byteLength;
        await new Promise<void>((resolve) => { releases.push(resolve); });
        active -= 1;
        return {
          id: `f_${filename}`,
          name: filename,
          media_type: 'application/octet-stream',
          size,
          created_at: '2026-01-01T00:00:00.000Z',
        };
      },
    };
    const core = {
      accessor: {
        get: (token: unknown) => {
          if (token === IFileService) return fileService;
          throw new Error('unexpected service');
        },
      },
    } as unknown as Scope;

    const app = Fastify();
    app.setValidatorCompiler(() => () => true);
    app.setSerializerCompiler(() => (data) => JSON.stringify(data));
    registerFilesRoutes(app as unknown as Parameters<typeof registerFilesRoutes>[0], core);
    cleanups.push(() => app.close());

    const payload = buildMultipartPayload('giant.bin', Buffer.alloc(1024, 7));
    const send = () => app.inject({
      method: 'POST',
      url: '/files',
      payload: payload.body,
      headers: { 'content-type': payload.contentType },
    });

    const p1 = send();
    const p2 = send();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peakActive).toBe(2);

    const p3 = send();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const p4 = await send();
    expect(p4.statusCode).toBe(429);
    expect(p4.json()).toMatchObject({ code: 42901, msg: 'too_many_uploads' });

    while (releases.length > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect([r1.statusCode, r2.statusCode, r3.statusCode]).toEqual([200, 200, 200]);
    expect(peakActive).toBe(2);
  });
});
