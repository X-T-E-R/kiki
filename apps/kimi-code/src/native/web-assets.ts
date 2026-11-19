import { statSync } from 'node:fs';
import { join } from 'node:path';

import { KIMI_BUILD_INFO } from '#/cli/build-info';
import { getHostPackageRoot } from '#/cli/version';
import {
  currentTarget,
  ensureFile,
  getNativeCacheBase,
  getSeaAssetSource,
  readFileSha256,
  sanitizeSegment,
  sha256,
  toBuffer,
  type NativeAssetSource,
} from './native-assets';
import {
  WEB_ASSET_MANIFEST_VERSION as MANIFEST_VERSION,
  buildWebManifestKey,
} from '../../scripts/native/manifest.mjs';

export const WEB_ASSET_MANIFEST_VERSION = MANIFEST_VERSION;

const WEB_ASSETS_DIR = 'dist/web';

export interface WebAssetFile {
  readonly assetKey: string;
  readonly relativePath: string;
  readonly sha256: string;
}

export interface WebAssetManifest {
  readonly version: typeof WEB_ASSET_MANIFEST_VERSION;
  readonly target: string;
  readonly root: 'dist/web';
  readonly files: readonly WebAssetFile[];
}

export type WebAssetSource = NativeAssetSource;

export interface WebAssetOptions {
  readonly source?: WebAssetSource | null;
  readonly manifest?: WebAssetManifest | null;
  readonly cacheBase?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly version?: string;
}

type RawWebAssetManifest = Omit<WebAssetManifest, 'version' | 'root'> & {
  readonly version: number;
  readonly root: string;
};

function assertSafeRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    relativePath.split('/').includes('..') ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    throw new Error(`Invalid web asset relative path: ${relativePath}`);
  }
}

export function webAssetManifestKey(target: string = currentTarget()): string {
  return buildWebManifestKey(target);
}

export function getEmbeddedWebAssetManifest(
  source: WebAssetSource | null = getSeaAssetSource(),
  target = currentTarget(),
): WebAssetManifest | null {
  if (source === null) return null;
  const key = webAssetManifestKey(target);
  if (!source.getAssetKeys().includes(key)) return null;
  const raw = source.getRawAsset(key);
  const manifest = JSON.parse(toBuffer(raw).toString('utf-8')) as RawWebAssetManifest;
  if (manifest.version !== WEB_ASSET_MANIFEST_VERSION) {
    throw new Error(`Unsupported web asset manifest version: ${manifest.version}`);
  }
  if (manifest.target !== target) {
    throw new Error(`Web asset manifest target mismatch: ${manifest.target} !== ${target}`);
  }
  if (manifest.root !== 'dist/web') {
    throw new Error(`Unsupported web asset root: ${manifest.root}`);
  }
  return manifest as WebAssetManifest;
}

export function getWebAssetCacheRoot(
  manifest: WebAssetManifest,
  options: WebAssetOptions = {},
): string {
  const version = sanitizeSegment(options.version ?? KIMI_BUILD_INFO.version ?? 'dev');
  const manifestHash = sha256(JSON.stringify(manifest));
  return join(
    getNativeCacheBase({
      cacheBase: options.cacheBase,
      env: options.env,
      platform: options.platform,
      homeDir: options.homeDir,
    }),
    'web',
    version,
    sanitizeSegment(manifest.target),
    manifestHash,
    manifest.root,
  );
}

export function getNativeWebAssetsDir(options: WebAssetOptions = {}): string | null {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return null;

  const target = currentTarget();
  const manifest = options.manifest ?? getEmbeddedWebAssetManifest(source, target);
  if (manifest === null) {
    throw new Error(`Embedded Kiki web assets were not found for ${target}.`);
  }

  const cacheRoot = getWebAssetCacheRoot(manifest, options);
  for (const file of manifest.files) {
    assertSafeRelativePath(file.relativePath);
    const path = join(cacheRoot, file.relativePath);
    if (readFileSha256(path) === file.sha256) continue;
    const bytes = toBuffer(source.getRawAsset(file.assetKey));
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== file.sha256) {
      throw new Error(
        `Web asset checksum mismatch for ${file.assetKey}: ${actualSha256} !== ${file.sha256}`,
      );
    }
    ensureFile(path, bytes, file.sha256);
  }
  return cacheRoot;
}

export function resolveServerWebAssetsDir(
  nativeWebAssetsDir: string | null = getNativeWebAssetsDir(),
): string {
  return nativeWebAssetsDir ?? join(getHostPackageRoot(), WEB_ASSETS_DIR);
}

export function findServerWebAssetsDir(): string | undefined {
  const native = getNativeWebAssetsDir();
  if (native !== null) return native;
  const assetsDir = resolveServerWebAssetsDir(null);
  return statSync(join(assetsDir, 'index.html'), { throwIfNoEntry: false })?.isFile() ? assetsDir : undefined;
}
