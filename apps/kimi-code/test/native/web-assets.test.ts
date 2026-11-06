import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import * as version from '#/cli/version';
import {
  findServerWebAssetsDir,
  getNativeWebAssetsDir,
  getWebAssetCacheRoot,
  resolveServerWebAssetsDir,
  WEB_ASSET_MANIFEST_VERSION,
  type WebAssetManifest,
  type WebAssetSource,
} from '#/native/web-assets';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeWebAssets(files: Record<string, string>): {
  manifest: WebAssetManifest;
  source: WebAssetSource;
  rawReads: Map<string, number>;
} {
  const manifest: WebAssetManifest = {
    version: WEB_ASSET_MANIFEST_VERSION,
    target: 'test-target',
    root: 'dist/web',
    files: Object.entries(files).map(([relativePath, content]) => ({
      assetKey: `web/test-target/dist/web/${relativePath}`,
      relativePath,
      sha256: sha256(content),
    })),
  };
  const assets = new Map<string, Buffer>([
    ['web/test-target/manifest.json', Buffer.from(JSON.stringify(manifest))],
    ...Object.entries(files).map(([relativePath, content]) => [
      `web/test-target/dist/web/${relativePath}`,
      Buffer.from(content),
    ] as const),
  ]);
  const rawReads = new Map<string, number>();
  return {
    manifest,
    rawReads,
    source: {
      getAssetKeys: () => [...assets.keys()],
      getRawAsset: (assetKey) => {
        rawReads.set(assetKey, (rawReads.get(assetKey) ?? 0) + 1);
        const asset = assets.get(assetKey);
        if (asset === undefined) throw new Error(`missing test asset: ${assetKey}`);
        return asset;
      },
    },
  };
}

describe('web assets', () => {
  it('extracts embedded web assets into a dist/web cache directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-runtime-'));
    try {
      const { manifest, source } = fakeWebAssets({
        'index.html': '<div id="app"></div>\n',
        'assets/app.js': 'console.log("ok");\n',
      });

      const webDir = getNativeWebAssetsDir({
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });

      expect(webDir).toBe(getWebAssetCacheRoot(manifest, { cacheBase: dir, version: 'test' }));
      expect(readFileSync(join(webDir ?? '', 'index.html'), 'utf-8')).toBe('<div id="app"></div>\n');
      expect(readFileSync(join(webDir ?? '', 'assets', 'app.js'), 'utf-8')).toBe(
        'console.log("ok");\n',
      );
      expect(existsSync(join(dir, 'web', 'test', 'test-target'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('does not read embedded assets on a warm cache hit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-warm-'));
    try {
      const { manifest, source, rawReads } = fakeWebAssets({
        'index.html': '<html></html>',
        'assets/app.js': 'console.log("ok");\n',
      });

      const webDir = getNativeWebAssetsDir({
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });
      rawReads.clear();

      expect(getNativeWebAssetsDir({
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      })).toBe(webDir);
      expect(rawReads.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('repairs corrupted extracted files on the next lookup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-repair-'));
    try {
      const { manifest, source, rawReads } = fakeWebAssets({
        'index.html': '<html></html>',
        'assets/app.js': 'console.log("ok");\n',
      });

      const webDir = getNativeWebAssetsDir({
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });
      rawReads.clear();
      writeFileSync(join(webDir ?? '', 'index.html'), 'broken');

      const repairedDir = getNativeWebAssetsDir({
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });

      expect(repairedDir).toBe(webDir);
      expect(readFileSync(join(repairedDir ?? '', 'index.html'), 'utf-8')).toBe('<html></html>');
      expect(rawReads.get('web/test-target/dist/web/index.html')).toBe(1);
      expect(rawReads.get('web/test-target/dist/web/assets/app.js') ?? 0).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('returns null when no SEA web asset source is available', () => {
    expect(getNativeWebAssetsDir({ source: null })).toBeNull();
  });

  it('fails closed when a SEA executable has no embedded web manifest', () => {
    const source: WebAssetSource = {
      getAssetKeys: () => [],
      getRawAsset: () => Buffer.alloc(0),
    };

    expect(() => getNativeWebAssetsDir({ source })).toThrow(
      'Embedded Kiki web assets were not found',
    );
  });

  it('resolves package dist/web outside SEA mode', () => {
    expect(resolveServerWebAssetsDir(null)).toMatch(/[/\\]dist[/\\]web$/);
  });

  it('passes extracted Windows asset paths through unchanged', () => {
    const windowsPath = String.raw`C:\Program Files\Kiki\cache\dist\web`;
    expect(resolveServerWebAssetsDir(windowsPath)).toBe(windowsPath);
  });

  it('keeps the daemon available without an optional package GUI build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiki-optional-web-assets-'));
    const root = vi.spyOn(version, 'getHostPackageRoot').mockReturnValue(dir);
    try {
      expect(findServerWebAssetsDir()).toBeUndefined();
      mkdirSync(join(dir, 'dist', 'web'), { recursive: true });
      writeFileSync(join(dir, 'dist', 'web', 'index.html'), '<html></html>');
      expect(findServerWebAssetsDir()).toBe(join(dir, 'dist', 'web'));
    } finally {
      root.mockRestore();
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
