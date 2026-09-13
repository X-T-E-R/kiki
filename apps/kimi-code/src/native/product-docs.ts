import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import { resolveKikiHome } from '@kiki/node-sdk';

import {
  KIKI_DOCS_ASSET_KEY_PREFIX,
  KIKI_DOCS_RUNTIME_PATH_PREFIX,
} from '../../scripts/native/manifest.mjs';
import { getHostPackageRoot } from '../cli/version';
import {
  getEmbeddedNativeAssetManifest,
  getSeaAssetSource,
  validateNativeAssetManifest,
  type NativeAssetManifest,
  type NativeAssetSource,
} from './native-assets';

const INSTALLED_MANIFEST_NAME = '.kiki-docs-manifest.json';
const INSTALLED_MANIFEST_VERSION = 1;
const MODULE_DIR = import.meta.dirname;

interface KikiDocFile {
  readonly relativePath: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

interface InstalledDocsManifest {
  readonly version: typeof INSTALLED_MANIFEST_VERSION;
  readonly contentSha256: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface MaterializeKikiDocsResult {
  readonly docsRoot: string;
  readonly contentSha256: string;
  readonly fileCount: number;
  readonly writtenFiles: number;
  readonly removedFiles: number;
  readonly backedUpFiles: number;
}

export interface KikiDocsInstallOptions {
  readonly source?: NativeAssetSource | null;
  readonly manifest?: NativeAssetManifest | null;
  readonly kikiHome?: string;
  readonly docsSourceDir?: string;
  readonly packageRoot?: string;
  readonly runtimeDir?: string;
}

export type KikiDocsInstallStatus =
  | ({ readonly status: 'installed'; readonly source: 'sea' | 'package' | 'workspace' } & MaterializeKikiDocsResult)
  | { readonly status: 'source-missing' }
  | { readonly status: 'failed'; readonly errorCode: string };

function sha256(bytes: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function toBuffer(value: ArrayBuffer | ArrayBufferView | Buffer | string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.from(value);
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    normalized.length === 0 ||
    isAbsolute(normalized) ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.startsWith('//') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid Kiki documentation path: ${value}`);
  }
  return normalized;
}

function resolveDocsFile(docsRoot: string, relativePath: string): string {
  const path = resolve(docsRoot, ...safeRelativePath(relativePath).split('/'));
  const fromRoot = relative(docsRoot, path);
  if (fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\') || isAbsolute(fromRoot)) {
    throw new Error(`Kiki documentation path escapes docs root: ${relativePath}`);
  }
  return path;
}

function collectMarkdownFiles(root: string): KikiDocFile[] {
  const files: KikiDocFile[] = [];
  const visit = (dir: string, prefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path, relativePath);
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        const bytes = readFileSync(path);
        files.push({ relativePath: safeRelativePath(relativePath), bytes, sha256: sha256(bytes) });
      }
    }
  };

  for (const locale of ['en', 'zh']) {
    visit(join(root, locale), locale);
  }
  return files;
}

function docsRootExists(path: string): boolean {
  return existsSync(join(path, 'en', 'index.md')) && existsSync(join(path, 'zh', 'index.md'));
}

function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot.length === 0 || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

export function resolveKikiDocsSourceDir(
  packageRoot = getHostPackageRoot(),
  runtimeDir = MODULE_DIR,
): { readonly path: string; readonly source: 'package' | 'workspace' } | null {
  const workspace = resolve(packageRoot, '..', '..', 'docs');
  if (isWithin(resolve(packageRoot, 'src'), runtimeDir) && docsRootExists(workspace)) {
    return { path: workspace, source: 'workspace' };
  }

  const packaged = [resolve(packageRoot, 'dist', 'docs'), resolve(packageRoot, 'docs')];
  for (const path of packaged) {
    if (docsRootExists(path)) return { path, source: 'package' };
  }

  return null;
}

function collectSeaDocs(source: NativeAssetSource, rawManifest: NativeAssetManifest): KikiDocFile[] {
  const manifest = validateNativeAssetManifest(rawManifest);
  const sourceKeys = new Set(source.getAssetKeys());
  return manifest.runtimeFiles
    .filter((file) => file.key.startsWith(KIKI_DOCS_ASSET_KEY_PREFIX))
    .map((file) => {
      if (!sourceKeys.has(file.assetKey)) {
        throw new Error(`Native documentation asset is missing: ${file.assetKey}`);
      }
      const relativePath = safeRelativePath(file.key.slice(KIKI_DOCS_ASSET_KEY_PREFIX.length));
      const expectedRuntimePath = `${KIKI_DOCS_RUNTIME_PATH_PREFIX}${relativePath}`;
      if (file.relativePath.replaceAll('\\', '/') !== expectedRuntimePath) {
        throw new Error(`Native documentation asset path mismatch: ${file.relativePath}`);
      }
      const bytes = toBuffer(source.getRawAsset(file.assetKey));
      const actualSha256 = sha256(bytes);
      if (actualSha256 !== file.sha256) {
        throw new Error(
          `Native documentation asset checksum mismatch for ${file.assetKey}: ${actualSha256} !== ${file.sha256}`,
        );
      }
      return { relativePath, bytes, sha256: actualSha256 };
    })
    .toSorted((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function readFileSha256(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

function ensureFile(path: string, bytes: Buffer, expectedSha256: string): boolean {
  if (readFileSha256(path) === expectedSha256) return false;

  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, bytes, { mode: 0o644 });
  try {
    renameSync(tempPath, path);
  } catch {
    rmSync(path, { force: true });
    try {
      renameSync(tempPath, path);
    } catch (error) {
      rmSync(tempPath, { force: true });
      if (readFileSha256(path) !== expectedSha256) throw error;
      return false;
    }
  }
  return true;
}

function backupUserFile(path: string): boolean {
  const bytes = readFileSync(path);
  const fileSha256 = sha256(bytes);
  for (let index = 0; ; index += 1) {
    const backupPath = `${path}.bak${index === 0 ? '' : `.${index}`}`;
    const backupSha256 = readFileSha256(backupPath);
    if (backupSha256 === fileSha256) return false;
    if (backupSha256 === null && !existsSync(backupPath)) {
      ensureFile(backupPath, bytes, fileSha256);
      return true;
    }
  }
}

function parseInstalledManifest(path: string): InstalledDocsManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<InstalledDocsManifest>;
    if (
      parsed.version !== INSTALLED_MANIFEST_VERSION ||
      typeof parsed.contentSha256 !== 'string' ||
      typeof parsed.files !== 'object' ||
      parsed.files === null
    ) {
      return null;
    }
    const files: Record<string, string> = {};
    for (const [relativePath, fileSha256] of Object.entries(parsed.files)) {
      if (typeof fileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(fileSha256)) return null;
      files[safeRelativePath(relativePath)] = fileSha256;
    }
    return {
      version: INSTALLED_MANIFEST_VERSION,
      contentSha256: parsed.contentSha256,
      files,
    };
  } catch {
    return null;
  }
}

function materializeKikiDocs(
  files: readonly KikiDocFile[],
  kikiHome = resolveKikiHome(),
): MaterializeKikiDocsResult {
  if (files.length === 0) throw new Error('Kiki documentation source contains no Markdown files');

  const docsRoot = join(kikiHome, 'docs');
  const manifestPath = join(docsRoot, INSTALLED_MANIFEST_NAME);
  const previous = parseInstalledManifest(manifestPath);
  const fileHashes: Record<string, string> = {};
  let writtenFiles = 0;
  let backedUpFiles = 0;

  for (const file of files.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const relativePath = safeRelativePath(file.relativePath);
    if (fileHashes[relativePath] !== undefined) {
      throw new Error(`Duplicate Kiki documentation path: ${relativePath}`);
    }
    const actualSha256 = sha256(file.bytes);
    if (actualSha256 !== file.sha256) {
      throw new Error(`Kiki documentation checksum mismatch: ${relativePath}`);
    }
    fileHashes[relativePath] = file.sha256;
    const path = resolveDocsFile(docsRoot, relativePath);
    const installedSha256 = readFileSha256(path);
    const previousSha256 = previous?.files[relativePath];
    if (
      installedSha256 !== null &&
      installedSha256 !== file.sha256 &&
      installedSha256 !== previousSha256 &&
      backupUserFile(path)
    ) {
      backedUpFiles += 1;
    }
    if (ensureFile(path, file.bytes, file.sha256)) writtenFiles += 1;
  }

  let removedFiles = 0;
  for (const relativePath of Object.keys(previous?.files ?? {})) {
    if (fileHashes[relativePath] !== undefined) continue;
    const path = resolveDocsFile(docsRoot, relativePath);
    const installedSha256 = readFileSha256(path);
    if (installedSha256 !== null) {
      if (installedSha256 !== previous?.files[relativePath] && backupUserFile(path)) {
        backedUpFiles += 1;
      }
      rmSync(path, { force: true });
      removedFiles += 1;
    }
  }

  const contentSha256 = sha256(
    Object.entries(fileHashes)
      .map(([relativePath, fileSha256]) => `${relativePath}\0${fileSha256}`)
      .join('\n'),
  );
  const installedManifest: InstalledDocsManifest = {
    version: INSTALLED_MANIFEST_VERSION,
    contentSha256,
    files: fileHashes,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(installedManifest, null, 2)}\n`);
  if (ensureFile(manifestPath, manifestBytes, sha256(manifestBytes))) {
    writtenFiles += 1;
  }

  return {
    docsRoot,
    contentSha256,
    fileCount: files.length,
    writtenFiles,
    removedFiles,
    backedUpFiles,
  };
}

export function materializeKikiDocsFromDirectory(
  sourceDir: string,
  kikiHome: string,
): MaterializeKikiDocsResult {
  return materializeKikiDocs(collectMarkdownFiles(sourceDir), kikiHome);
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  return error instanceof Error ? error.name : 'UNKNOWN';
}

export function installKikiDocs(options: KikiDocsInstallOptions = {}): KikiDocsInstallStatus {
  try {
    const seaSource = options.source === undefined ? getSeaAssetSource() : options.source;
    if (seaSource !== null) {
      const rawManifest = options.manifest === undefined
        ? getEmbeddedNativeAssetManifest(seaSource)
        : options.manifest;
      if (rawManifest === null) return { status: 'source-missing' };
      const files = collectSeaDocs(seaSource, rawManifest);
      if (files.length === 0) return { status: 'source-missing' };
      return {
        status: 'installed',
        source: 'sea',
        ...materializeKikiDocs(files, options.kikiHome),
      };
    }

    const resolved = options.docsSourceDir === undefined
      ? resolveKikiDocsSourceDir(options.packageRoot, options.runtimeDir)
      : { path: options.docsSourceDir, source: 'workspace' as const };
    if (resolved === null || !docsRootExists(resolved.path)) return { status: 'source-missing' };
    return {
      status: 'installed',
      source: resolved.source,
      ...materializeKikiDocs(collectMarkdownFiles(resolved.path), options.kikiHome),
    };
  } catch (error) {
    return { status: 'failed', errorCode: errorCode(error) };
  }
}
