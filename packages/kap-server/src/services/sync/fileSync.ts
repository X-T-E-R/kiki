import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  SyncFilesExportResult,
  SyncFilesImportInput,
  SyncFilesTransferReceipt,
} from '@kiki/protocol';
import { packTarGz, safePortablePath, unpackTarGz } from '../portableSpace/tarArchive';

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const NOFOLLOW_FLAG = fsConstants.O_NOFOLLOW ?? 0;

async function readRegularFileNoFollow(filePath: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | NOFOLLOW_FLAG);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new SyncPathForbiddenError(`Symlink file '${filePath}' is not allowed`);
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new SyncPathForbiddenError(`Non-regular file '${filePath}' is not allowed`);
    }
    if (info.nlink > 1) {
      throw new SyncPathForbiddenError(`Hardlinked source file '${filePath}' is not allowed`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeRegularFileNoFollow(filePath: string, bytes: Buffer): Promise<void> {
  const parent = dirname(filePath);
  const tmpPath = join(parent, `.kiki-sync-${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW_FLAG,
      0o644,
    );
    await handle.writeFile(bytes);
    await handle.close();
    handle = undefined;
    await assertLeafSafeForFileWrite(filePath);
    await rename(tmpPath, filePath);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    await unlink(tmpPath).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new SyncPathForbiddenError(`Symlink destination '${filePath}' is not allowed`);
    }
    throw error;
  }
}

/** Error raised when a requested file-sync path targets a forbidden secret location or escapes via symlink. */
export class SyncPathForbiddenError extends Error {
  readonly status = 403;
  readonly reason = 'sync_path_forbidden';
  constructor(message: string) {
    super(message);
    this.name = 'SyncPathForbiddenError';
  }
}

/** Error raised when a requested file-sync source path does not exist. */
export class SyncPathNotFoundError extends Error {
  readonly status = 404;
  readonly reason = 'sync_path_not_found';
  constructor(message: string) {
    super(message);
    this.name = 'SyncPathNotFoundError';
  }
}

/** Error raised when an incoming file-sync archive is invalid or fails traversal checks. */
export class SyncArchiveInvalidError extends Error {
  readonly status = 400;
  readonly reason = 'sync_archive_invalid';
  constructor(message: string) {
    super(message);
    this.name = 'SyncArchiveInvalidError';
  }
}

export interface FileSyncPathOptions {
  readonly homeDir: string;
  readonly osHomeDir: string;
}

function normalizeCompare(value: string): string {
  const resolved = resolve(value).replaceAll('\\', '/').replace(/\/+$/u, '') || '/';
  return CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved;
}

function isPathContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isSameOrDescendant(root: string, candidate: string): boolean {
  const normRoot = normalizeCompare(root);
  const normCandidate = normalizeCompare(candidate);
  if (normCandidate === normRoot) return true;
  if (normRoot === '/') return true;
  return normCandidate.startsWith(`${normRoot}/`);
}

function assertNoControlChars(value: string): void {
  if (value.trim().length === 0) {
    throw new SyncPathForbiddenError('Transfer path must not be empty');
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.codePointAt(i);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) {
      throw new SyncPathForbiddenError('Transfer path contains control characters');
    }
  }
}

function expandAbsolutePath(rawPath: string, osHomeDir: string): string {
  assertNoControlChars(rawPath);
  const trimmed = rawPath.trim();
  let expanded = trimmed;
  if (trimmed === '~') {
    expanded = osHomeDir;
  } else if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    expanded = join(osHomeDir, trimmed.slice(2));
  }
  if (!isAbsolute(expanded)) {
    throw new SyncPathForbiddenError(`Transfer path must be absolute: '${rawPath}'`);
  }
  return resolve(expanded);
}

const FORBIDDEN_SEGMENT_PATTERN =
  /^(?:\.ssh|\.gnupg|\.secrets?|server\.local-owner|server\.token|config\.local\.toml|device-x25519\.key|\.env(?:\..+)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|kdbx|age))$/i;

async function resolveForbiddenRoots(options: FileSyncPathOptions): Promise<readonly string[]> {
  const rawHome = resolve(options.homeDir);
  const rawOsHome = resolve(options.osHomeDir);
  const realHome = await realpath(rawHome).catch(() => rawHome);
  const realOsHome = await realpath(rawOsHome).catch(() => rawOsHome);
  const roots = new Set<string>([
    join(rawOsHome, '.ssh'),
    join(realOsHome, '.ssh'),
    join(rawOsHome, '.gnupg'),
    join(realOsHome, '.gnupg'),
    join(rawHome, 'credentials'),
    join(realHome, 'credentials'),
    join(rawHome, 'secrets'),
    join(realHome, 'secrets'),
    join(rawHome, 'server'),
    join(realHome, 'server'),
    join(rawHome, 'server.local-owner'),
    join(realHome, 'server.local-owner'),
    join(rawHome, 'config.local.toml'),
    join(realHome, 'config.local.toml'),
  ]);
  return [...roots];
}

function assertNotForbiddenPath(candidate: string, forbiddenRoots: readonly string[]): void {
  const normalizedSegments = resolve(candidate).replaceAll('\\', '/').split('/');
  for (const segment of normalizedSegments) {
    if (segment.length > 0 && FORBIDDEN_SEGMENT_PATTERN.test(segment)) {
      throw new SyncPathForbiddenError(`Transfer path '${candidate}' is forbidden`);
    }
  }
  for (const forbidden of forbiddenRoots) {
    if (isSameOrDescendant(forbidden, candidate)) {
      throw new SyncPathForbiddenError(`Transfer path '${candidate}' is forbidden`);
    }
  }
}

async function resolveNearestRealpath(target: string): Promise<string> {
  let cursor = resolve(target);
  const trailing: string[] = [];
  for (;;) {
    try {
      const resolved = await realpath(cursor);
      return trailing.length === 0 ? resolved : join(resolved, ...trailing.toReversed());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) {
        return trailing.length === 0 ? cursor : join(cursor, ...trailing.toReversed());
      }
      trailing.push(relative(parent, cursor));
      cursor = parent;
    }
  }
}

async function assertNoSymlinkSegments(realRoot: string, normalizedRel: string): Promise<void> {
  let cursor = realRoot;
  for (const segment of normalizedRel.split('/')) {
    cursor = join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new SyncPathForbiddenError(`Symlink segment '${normalizedRel}' is not allowed`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

async function assertLeafSafeForFileWrite(dest: string): Promise<void> {
  try {
    const info = await lstat(dest);
    if (info.isSymbolicLink() || info.isDirectory()) {
      throw new SyncPathForbiddenError(`Destination '${dest}' is a symlink or directory`);
    }
    if (info.nlink > 1) {
      throw new SyncPathForbiddenError(`Hardlinked destination '${dest}' is not allowed`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

/** Exports a single file or directory into a bounded gzip-compressed POSIX ustar archive after enforcing path safety. */
export async function exportTransferFiles(
  rawPath: string,
  options: FileSyncPathOptions,
): Promise<SyncFilesExportResult> {
  const forbiddenRoots = await resolveForbiddenRoots(options);
  const resolved = expandAbsolutePath(rawPath, options.osHomeDir);
  assertNotForbiddenPath(resolved, forbiddenRoots);

  let stat;
  try {
    stat = await lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SyncPathNotFoundError(`Path not found: '${rawPath}'`);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new SyncPathForbiddenError(`Symlink source '${rawPath}' is not allowed`);
  }
  const realTarget = await realpath(resolved);
  assertNotForbiddenPath(realTarget, forbiddenRoots);

  const rootName = safePortablePath(basename(realTarget));
  const files = new Map<string, Buffer>();
  let totalBytes = 0;

  if (stat.isFile()) {
    const bytes = await readRegularFileNoFollow(realTarget);
    files.set(rootName, bytes);
    totalBytes = bytes.byteLength;
    const archive = packTarGz(files);
    return {
      kind: 'file',
      rootName,
      fileCount: 1,
      totalBytes,
      archiveBase64: archive.toString('base64'),
    };
  }

  if (!stat.isDirectory()) {
    throw new SyncPathForbiddenError(`Unsupported source type: '${rawPath}'`);
  }

  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new SyncPathForbiddenError(`Symlink entry '${entry.name}' inside source directory is not allowed`);
      }
      assertNotForbiddenPath(fullPath, forbiddenRoots);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const info = await lstat(fullPath);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new SyncPathForbiddenError(`Non-regular entry '${entry.name}' is not allowed`);
        }
        const rel = safePortablePath(relative(realTarget, fullPath).replaceAll('\\', '/'));
        const bytes = await readRegularFileNoFollow(fullPath);
        totalBytes += bytes.byteLength;
        files.set(rel, bytes);
      }
    }
  };
  await walk(realTarget);

  const archive = packTarGz(files);
  return {
    kind: 'directory',
    rootName,
    fileCount: files.size,
    totalBytes,
    archiveBase64: archive.toString('base64'),
  };
}

/** Imports a bounded gzip-compressed POSIX ustar archive to a local file or directory after enforcing path safety. */
export async function importTransferFiles(
  input: SyncFilesImportInput,
  options: FileSyncPathOptions,
): Promise<SyncFilesTransferReceipt> {
  const forbiddenRoots = await resolveForbiddenRoots(options);
  const resolvedDest = expandAbsolutePath(input.destinationPath, options.osHomeDir);
  assertNotForbiddenPath(resolvedDest, forbiddenRoots);
  const nearestReal = await resolveNearestRealpath(resolvedDest);
  assertNotForbiddenPath(nearestReal, forbiddenRoots);

  let files: Map<string, Buffer>;
  try {
    files = unpackTarGz(Buffer.from(input.archiveBase64, 'base64'));
  } catch (error) {
    const detail = error instanceof Error && error.message.length > 0 ? `: ${error.message}` : '';
    throw new SyncArchiveInvalidError(`Invalid or unsafe tar.gz archive${detail}`);
  }

  if (input.kind === 'file') {
    if (files.size !== 1) {
      throw new SyncArchiveInvalidError('Single-file archive must contain exactly one entry');
    }
    const [entryName, bytes] = [...files.entries()][0]!;
    const safeName = safePortablePath(entryName);
    let targetFile = resolvedDest;
    let existingStat;
    try {
      existingStat = await lstat(resolvedDest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existingStat !== undefined) {
      if (existingStat.isSymbolicLink()) {
        throw new SyncPathForbiddenError(`Symlink destination '${input.destinationPath}' is not allowed`);
      }
      if (existingStat.isDirectory()) {
        const realDir = await realpath(resolvedDest);
        assertNotForbiddenPath(realDir, forbiddenRoots);
        await assertNoSymlinkSegments(realDir, safeName);
        targetFile = resolve(realDir, safeName);
        if (!isPathContained(realDir, targetFile)) {
          throw new SyncPathForbiddenError(`Destination path '${safeName}' escapes target directory`);
        }
      }
    }
    assertNotForbiddenPath(targetFile, forbiddenRoots);
    const parentDir = dirname(targetFile);
    await mkdir(parentDir, { recursive: true });
    const realParent = await realpath(parentDir);
    assertNotForbiddenPath(realParent, forbiddenRoots);
    const confirmedTarget = join(realParent, basename(targetFile));
    assertNotForbiddenPath(confirmedTarget, forbiddenRoots);
    await assertLeafSafeForFileWrite(confirmedTarget);
    await writeRegularFileNoFollow(confirmedTarget, bytes);
    return {
      kind: 'file',
      destinationPath: confirmedTarget,
      fileCount: 1,
      totalBytes: bytes.byteLength,
      files: [safeName],
    };
  }

  let existingDirStat;
  try {
    existingDirStat = await lstat(resolvedDest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existingDirStat !== undefined) {
    if (existingDirStat.isSymbolicLink() || !existingDirStat.isDirectory()) {
      throw new SyncPathForbiddenError(`Destination '${input.destinationPath}' must be a directory`);
    }
  }
  await mkdir(resolvedDest, { recursive: true });
  const realDest = await realpath(resolvedDest);
  assertNotForbiddenPath(realDest, forbiddenRoots);

  const written: string[] = [];
  let totalBytes = 0;
  for (const [rawRel, bytes] of files.entries()) {
    const safeRel = safePortablePath(rawRel);
    const destFile = resolve(realDest, safeRel);
    if (!isPathContained(realDest, destFile)) {
      throw new SyncPathForbiddenError(`Archive entry '${rawRel}' escapes destination root`);
    }
    assertNotForbiddenPath(destFile, forbiddenRoots);
    await assertNoSymlinkSegments(realDest, safeRel);
    const destParent = dirname(destFile);
    await mkdir(destParent, { recursive: true });
    const realParent = await realpath(destParent);
    if (!isPathContained(realDest, realParent)) {
      throw new SyncPathForbiddenError(`Archive entry '${rawRel}' escapes destination root via symlink`);
    }
    assertNotForbiddenPath(realParent, forbiddenRoots);
    const confirmedDestFile = join(realParent, basename(destFile));
    assertNotForbiddenPath(confirmedDestFile, forbiddenRoots);
    await assertLeafSafeForFileWrite(confirmedDestFile);
    await writeRegularFileNoFollow(confirmedDestFile, bytes);
    written.push(safeRel);
    totalBytes += bytes.byteLength;
  }

  return {
    kind: 'directory',
    destinationPath: realDest,
    fileCount: written.length,
    totalBytes,
    files: written.toSorted(),
  };
}
