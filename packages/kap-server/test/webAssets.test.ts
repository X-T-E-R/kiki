import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerWebAssetRoutes } from '../src/routes/webAssets';
import { createSecurityHeadersHook } from '../src/middleware/securityHeaders';

describe('web asset cache policy', () => {
  let app: FastifyInstance;
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(tmpdir(), 'kimi-web-assets-'));
    await Promise.all([
      mkdir(join(assetsDir, 'assets')),
      mkdir(join(assetsDir, 'pdfjs', 'cmaps'), { recursive: true }),
      mkdir(join(assetsDir, 'pdfjs', 'standard_fonts'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(assetsDir, 'index.html'), '<main>Kimi</main>'),
      writeFile(join(assetsDir, 'assets', 'index-Dy7xs5tu.js'), 'export {};'),
      writeFile(join(assetsDir, 'assets', 'application-configuration.json'), '{}'),
      writeFile(join(assetsDir, 'favicon.svg'), '<svg></svg>'),
      writeFile(join(assetsDir, 'manifest.webmanifest'), '{}'),
      writeFile(join(assetsDir, 'pdfjs', 'pdf.worker.min.mjs'), 'export const WorkerMessageHandler = {};'),
      writeFile(join(assetsDir, 'pdfjs', 'cmaps', 'UniJIS-UTF16-H.bcmap'), Buffer.from([0, 1, 255])),
      writeFile(join(assetsDir, 'pdfjs', 'standard_fonts', 'FoxitSerif.pfb'), Buffer.from([128, 1, 255])),
    ]);
    app = Fastify();
    app.addHook('onSend', createSecurityHeadersHook({ tls: false }));
    app.get('/api/fixture', async () => ({ ok: true }));
    await registerWebAssetRoutes(app, assetsDir);
  });

  afterEach(async () => {
    await app.close();
    await rm(assetsDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it.each(['/', '/sessions/active'])('serves the GUI index for %s', async (url) => {
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toBe('<main>Kimi</main>');
    expect(response.headers['content-security-policy']).toContain("img-src 'self' data: blob: https: http:");
    expect(response.headers['content-security-policy']).toContain("frame-src 'self' http://*.kiki-document.localhost:* https: http: blob:");
    expect(response.headers['content-security-policy']).toContain("worker-src 'self' blob:");
  });

  it('keeps remote image sources out of the default response policy', async () => {
    const response = await app.inject('/api/fixture');
    expect(response.headers['content-security-policy']).toContain("img-src 'self' data: blob:;");
  });

  it('serves the PDF module worker as JavaScript with the GUI worker policy', async () => {
    const response = await app.inject('/pdfjs/pdf.worker.min.mjs');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(response.body).toBe('export const WorkerMessageHandler = {};');
    expect(response.headers['content-security-policy']).toContain("worker-src 'self' blob:");
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it.each([
    ['/pdfjs/cmaps/UniJIS-UTF16-H.bcmap', [0, 1, 255]],
    ['/pdfjs/standard_fonts/FoxitSerif.pfb', [128, 1, 255]],
  ] as const)('serves PDF binary resource %s without returning the GUI index', async (url, bytes) => {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.rawPayload).toEqual(Buffer.from(bytes));
  });

  it.each([
    '/pdfjs/missing.worker.mjs',
    '/pdfjs/cmaps/missing.bcmap',
    '/pdfjs/standard_fonts/missing.pfb',
  ])('returns 404 instead of the GUI index for missing PDF resource %s', async (url) => {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.body).toBe('Not found');
  });

  it('caches content-hashed assets as immutable', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/index-Dy7xs5tu.js' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('serves the install manifest with its manifest media type', async () => {
    const response = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/manifest+json');
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('rejects a missing GUI build with the asset path in the diagnostic', async () => {
    const missingDir = await mkdtemp(join(tmpdir(), 'kimi-web-assets-missing-'));
    const missingApp = Fastify();
    try {
      await expect(registerWebAssetRoutes(missingApp, missingDir)).rejects.toThrow(
        `Kiki web assets were not found at ${missingDir}`,
      );
    } finally {
      await missingApp.close();
      await rm(missingDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it.each([
    '/index.html',
    '/sessions/active',
    '/favicon.svg',
    '/assets/application-configuration.json',
  ])(
    'requires revalidation for %s',
    async (url) => {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-cache');
    },
  );
});
