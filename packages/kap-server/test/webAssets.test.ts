import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerWebAssetRoutes } from '../src/routes/webAssets';

describe('web asset cache policy', () => {
  let app: FastifyInstance;
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(tmpdir(), 'kimi-web-assets-'));
    await mkdir(join(assetsDir, 'assets'));
    await Promise.all([
      writeFile(join(assetsDir, 'index.html'), '<main>Kimi</main>'),
      writeFile(join(assetsDir, 'assets', 'index-Dy7xs5tu.js'), 'export {};'),
      writeFile(join(assetsDir, 'assets', 'application-configuration.json'), '{}'),
      writeFile(join(assetsDir, 'favicon.svg'), '<svg></svg>'),
    ]);
    app = Fastify();
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
  });

  it('caches content-hashed assets as immutable', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/index-Dy7xs5tu.js' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
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
