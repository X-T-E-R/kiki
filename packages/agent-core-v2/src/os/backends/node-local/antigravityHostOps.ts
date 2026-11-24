import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { extract as extractTar, list as listTar, type ReadEntry } from 'tar';

import { atomicWrite } from '#/_base/utils/fs';
import {
  readAntigravitySettings,
  type AntigravityAuthMethod,
  type AntigravityStoredSettings,
} from './antigravitySettings';
import type { BinaryArchiveProgress } from './binaryArchive';

const MAX_OFFICIAL_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_OFFICIAL_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_CACHE_BYTES = 256 * 1024;
const MAX_METADATA_BLOB_BYTES = 1024 * 1024;
const INSTALL_RECORD_NAME = '.install-complete.json';
const PROFILE_CACHE_NAME = 'kiki-agy-cache.json';
const PROFILE_SECRETS_NAME = 'kiki-credentials.json';
const RULE_COPIES_MANIFEST = '.kiki-rule-copies.json';
const TRAJECTORY_WORKSPACES = 1;
const WORKSPACE_URI = 1;
const TRAJECTORY_SESSION_ID = 6;
const TRAJECTORY_WORKSPACE_URIS = 7;
const NATIVE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_CONFIG_FILES = [
  ['AGENTS.md'],
  ['GEMINI.md'],
  ['config', 'skills.json'],
] as const;

export interface OfficialInstalledReleaseRecord {
  readonly version: string;
  readonly releaseId: string;
  readonly layout: 'official-cli';
  readonly platform?: string;
  readonly arch?: string;
  readonly sha512: string;
  readonly executable: {
    readonly name: string;
    readonly bytes: number;
  };
}

export interface OfficialInstalledVersion {
  readonly version: string;
  readonly releaseId: string;
  readonly directoryName: string;
  readonly directory: string;
  readonly executablePath: string;
  readonly executableName: string;
  readonly sha512: string;
}

export interface InstallOfficialBinaryOptions {
  readonly url: string;
  readonly version: string;
  readonly sha512: string;
  readonly format: 'executable' | 'tar.gz';
  readonly executableName: string;
  readonly versionsRoot: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly leasedDirectories?: ReadonlySet<string>;
  readonly onProgress?: (progress: BinaryArchiveProgress) => void;
  readonly validate?: (executablePath: string) => Promise<void>;
}

export interface AntigravityCachedModel {
  readonly id: string;
  readonly label?: string;
  readonly thinkingLevels?: readonly string[];
}

export interface AntigravityProfileCache {
  readonly version: 1;
  readonly checkedAt: string;
  readonly authMethod?: AntigravityAuthMethod;
  readonly accountLabel?: string;
  readonly accountFingerprint?: string;
  readonly gcpProject?: string;
  readonly gcpLocation?: string;
  readonly eligibility?: 'ready' | 'subscription_required' | 'unknown';
  readonly eligibilityMessage?: string;
  readonly verificationFailed?: boolean;
  readonly autoModeSupported?: boolean;
  readonly models?: readonly AntigravityCachedModel[];
  readonly commands?: readonly string[];
}

export interface AntigravityProfileSecrets {
  readonly geminiApiKey?: string;
  readonly googleApiKey?: string;
}

export interface AntigravityCliTokenData {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiry?: string;
  readonly expired: boolean;
}

export interface AntigravityLegacyTokenData {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly projectId?: string;
}

export interface AntigravityLocalCredentials {
  readonly settings: AntigravityStoredSettings;
  readonly cliToken?: AntigravityCliTokenData;
  readonly legacyToken?: AntigravityLegacyTokenData;
  readonly secrets: AntigravityProfileSecrets;
  readonly hasCliToken: boolean;
  readonly hasLegacyToken: boolean;
  readonly revisionHash: string;
}

export async function detectLinuxMusl(platform: NodeJS.Platform, arch: string): Promise<boolean> {
  if (platform !== 'linux') return false;
  const loader = arch === 'arm64' ? '/lib/libc.musl-aarch64.so.1' : '/lib/libc.musl-x86_64.so.1';
  return stat(loader).then((info) => info.isFile(), () => false);
}

export async function isAntigravityIdeArtifact(commandPath: string, platform: NodeJS.Platform): Promise<boolean> {
  const name = basename(commandPath).replace(/\.(?:exe|cmd|bat|com)$/i, '').toLowerCase();
  if (name !== 'antigravity') return false;
  if (platform === 'win32') return true;
  const resolved = await realpath(commandPath).catch(() => commandPath);
  const normalized = resolved.replaceAll('\\', '/');
  if (normalized.includes('.app/Contents/')) return true;
  const dir = dirname(resolved);
  const parent = dirname(dir);
  const ideMarkers = [
    join(dir, 'resources', 'app', 'package.json'),
    join(dir, 'resources', 'app.asar'),
    join(dir, 'chrome_100_percent.pak'),
    join(parent, 'resources', 'app', 'package.json'),
    join(parent, 'resources', 'app.asar'),
  ];
  for (const marker of ideMarkers) {
    const exists = await stat(marker).then(() => true, () => false);
    if (exists) return true;
  }
  return false;
}

export function officialReleaseDirectoryName(version: string, sha512: string): string {
  return `${version}-${sha512.slice(0, 12).toLowerCase()}`;
}

export async function inspectOfficialReleaseDirectory(
  directory: string,
  platform: NodeJS.Platform,
  arch?: string,
): Promise<OfficialInstalledVersion | undefined> {
  const dirStat = await lstat(directory).catch(() => undefined);
  if (dirStat === undefined || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return undefined;
  const recordPath = join(directory, INSTALL_RECORD_NAME);
  const recordStat = await lstat(recordPath).catch(() => undefined);
  if (recordStat === undefined || recordStat.isSymbolicLink() || !recordStat.isFile() || recordStat.size > MAX_RECORD_BYTES) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(recordPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const version = typeof parsed['version'] === 'string' ? parsed['version'].trim() : '';
  const releaseId = typeof parsed['releaseId'] === 'string' ? parsed['releaseId'].trim() : '';
  const layout = parsed['layout'];
  const sha512 = typeof parsed['sha512'] === 'string' ? parsed['sha512'].trim().toLowerCase() : '';
  const recordPlatform = typeof parsed['platform'] === 'string' ? parsed['platform'] : undefined;
  const recordArch = typeof parsed['arch'] === 'string' ? parsed['arch'] : undefined;
  const executable = parsed['executable'];
  if (
    version === '' ||
    releaseId === '' ||
    layout !== 'official-cli' ||
    !/^[a-f0-9]{128}$/.test(sha512) ||
    !isRecord(executable) ||
    typeof executable['name'] !== 'string' ||
    executable['name'].trim() === '' ||
    typeof executable['bytes'] !== 'number' ||
    !Number.isSafeInteger(executable['bytes']) ||
    executable['bytes'] <= 0
  ) {
    return undefined;
  }
  if (recordPlatform !== undefined && recordPlatform !== platform) return undefined;
  if (arch !== undefined && recordArch !== undefined && recordArch !== arch) return undefined;
  const executablePath = join(directory, executable['name']);
  const exeStat = await lstat(executablePath).catch(() => undefined);
  if (exeStat === undefined || exeStat.isSymbolicLink() || !exeStat.isFile() || exeStat.size !== executable['bytes']) {
    return undefined;
  }
  if (platform !== 'win32' && (exeStat.mode & 0o111) === 0) return undefined;
  return {
    version,
    releaseId,
    directoryName: basename(directory),
    directory,
    executablePath,
    executableName: executable['name'],
    sha512,
  };
}

export async function listInstalledOfficialVersions(
  versionsRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): Promise<readonly OfficialInstalledVersion[]> {
  const entries = await readdir(versionsRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const installed: OfficialInstalledVersion[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const inspected = await inspectOfficialReleaseDirectory(join(versionsRoot, entry.name), platform, arch);
    if (inspected !== undefined) installed.push(inspected);
  }
  return installed;
}

export async function unlockDirectoryTree(directory: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') return;
  const info = await lstat(directory).catch(() => undefined);
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) return;
  await chmod(directory, 0o700).catch(() => undefined);
  const entries = await readdir(directory).catch(() => []);
  for (const entry of entries) {
    const child = join(directory, entry);
    const childInfo = await lstat(child).catch(() => undefined);
    if (childInfo === undefined || childInfo.isSymbolicLink()) continue;
    if (childInfo.isDirectory()) {
      await unlockDirectoryTree(child, platform);
    } else {
      await chmod(child, 0o600).catch(() => undefined);
    }
  }
}

export async function removeReleaseDirectory(directory: string, platform: NodeJS.Platform): Promise<void> {
  await unlockDirectoryTree(directory, platform);
  await retryOnWindowsLock(platform, () => rm(directory, { recursive: true, force: true }));
}

export async function pruneUnusedOfficialVersions(
  versionsRoot: string,
  activeDirectory: string | undefined,
  leasedDirectories: ReadonlySet<string>,
  platform: NodeJS.Platform,
): Promise<void> {
  const entries = await readdir(versionsRoot, { withFileTypes: true }).catch(() => []);
  const activeKey = activeDirectory === undefined ? undefined : normalizeFsPathKey(activeDirectory, platform);
  const leasedKeys = new Set([...leasedDirectories].map((dir) => normalizeFsPathKey(dir, platform)));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const full = join(versionsRoot, entry.name);
    const key = normalizeFsPathKey(full, platform);
    if (key === activeKey || leasedKeys.has(key)) continue;
    await removeReleaseDirectory(full, platform).catch(() => undefined);
  }
}

export async function installOfficialAntigravityBinary(
  options: InstallOfficialBinaryOptions,
): Promise<OfficialInstalledVersion> {
  const expectedPrefix = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${options.version}-`;
  if (!options.url.startsWith(expectedPrefix)) {
    throw new Error('Unexpected Antigravity CLI download URL');
  }
  const expectedSha512 = options.sha512.toLowerCase();
  if (!/^[a-f0-9]{128}$/.test(expectedSha512)) {
    throw new Error('Invalid Antigravity CLI SHA-512 checksum');
  }
  const releaseId = expectedSha512.slice(0, 64);
  const dirName = officialReleaseDirectoryName(options.version, expectedSha512);
  const destination = join(options.versionsRoot, dirName);
  await mkdir(options.versionsRoot, { recursive: true });

  const existing = await inspectOfficialReleaseDirectory(destination, options.platform, options.arch);
  if (existing !== undefined && existing.version === options.version && existing.sha512 === expectedSha512) {
    if (options.validate !== undefined) await options.validate(existing.executablePath);
    return existing;
  }

  const staging = await mkdtemp(join(options.versionsRoot, '.install-'));
  const downloadPath = join(staging, 'download');
  const runtimeDir = join(staging, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(options.url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000),
      redirect: 'follow',
    });
    if (!response.ok || response.body === null) {
      throw new Error(`Binary download failed (HTTP ${response.status})`);
    }
    if (response.url) {
      const resolvedUrl = new URL(response.url);
      if (resolvedUrl.protocol !== 'https:' || resolvedUrl.hostname !== 'storage.googleapis.com') {
        throw new Error('Unexpected Antigravity download origin');
      }
    }
    const hash = createHash('sha512');
    const length = Number(response.headers.get('content-length'));
    const totalBytes = Number.isFinite(length) && length > 0 ? length : undefined;
    const step = totalBytes === undefined ? 1024 * 1024 : Math.max(64 * 1024, Math.floor(totalBytes / 100));
    let downloaded = 0;
    let reported = 0;
    options.onProgress?.({ stage: 'download', receivedBytes: 0, totalBytes });
    await pipeline(
      Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          downloaded += chunk.length;
          if (downloaded > MAX_OFFICIAL_DOWNLOAD_BYTES) {
            callback(new Error('Antigravity download exceeds the allowed size limit'));
            return;
          }
          hash.update(chunk);
          if (options.onProgress !== undefined && downloaded - reported >= step) {
            reported = downloaded;
            options.onProgress({ stage: 'download', receivedBytes: downloaded, totalBytes });
          }
          callback(null, chunk);
        },
      }),
      createWriteStream(downloadPath, { flags: 'wx', mode: 0o600 }),
    );
    if (reported !== downloaded) {
      options.onProgress?.({ stage: 'download', receivedBytes: downloaded, totalBytes });
    }
    const digest = hash.digest('hex').toLowerCase();
    if (digest !== expectedSha512) {
      throw new Error('Antigravity download SHA-512 checksum mismatch');
    }

    options.onProgress?.({ stage: 'extract' });
    const stagedExecutable = join(runtimeDir, options.executableName);
    if (options.format === 'executable') {
      await copyFile(downloadPath, stagedExecutable);
    } else {
      await extractSingleTarGzExecutable(downloadPath, runtimeDir, options.executableName);
    }
    await rm(downloadPath, { force: true });
    const exeInfo = await stat(stagedExecutable);
    if (!exeInfo.isFile() || exeInfo.size <= 0 || exeInfo.size > MAX_OFFICIAL_EXECUTABLE_BYTES) {
      throw new Error('Extracted Antigravity binary is missing or invalid');
    }
    if (options.platform !== 'win32') {
      await chmod(stagedExecutable, 0o755);
    }

    if (options.validate !== undefined) {
      await options.validate(stagedExecutable);
    }

    const record: OfficialInstalledReleaseRecord = {
      version: options.version,
      releaseId,
      layout: 'official-cli',
      platform: options.platform,
      arch: options.arch,
      sha512: expectedSha512,
      executable: {
        name: options.executableName,
        bytes: exeInfo.size,
      },
    };
    const recordPath = join(runtimeDir, INSTALL_RECORD_NAME);
    await atomicWrite(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    if (options.platform !== 'win32') {
      await chmod(stagedExecutable, 0o555);
      await chmod(recordPath, 0o400);
    }

    const destinationExists = await lstat(destination).then(() => true, () => false);
    if (destinationExists) {
      const destKey = normalizeFsPathKey(destination, options.platform);
      const leased = options.leasedDirectories !== undefined &&
        [...options.leasedDirectories].some((dir) => normalizeFsPathKey(dir, options.platform) === destKey);
      if (leased) {
        throw new Error('Active Antigravity sessions are using this version directory; wait for turns to finish before reinstalling.');
      }
      await removeReleaseDirectory(destination, options.platform);
    }

    await retryOnWindowsLock(options.platform, () => rename(runtimeDir, destination));
    if (options.platform !== 'win32') {
      await chmod(destination, 0o500).catch(() => undefined);
    }
    return {
      version: options.version,
      releaseId,
      directoryName: dirName,
      directory: destination,
      executablePath: join(destination, options.executableName),
      executableName: options.executableName,
      sha512: expectedSha512,
    };
  } finally {
    await unlockDirectoryTree(staging, options.platform).catch(() => undefined);
    await retryOnWindowsLock(options.platform, () => rm(staging, { recursive: true, force: true })).catch(() => undefined);
  }
}

async function extractSingleTarGzExecutable(archivePath: string, destinationDir: string, executableName: string): Promise<void> {
  const entries: Array<{ readonly path: string; readonly type: string; readonly size: number }> = [];
  await listTar({
    file: archivePath,
    onReadEntry: (entry: ReadEntry) => {
      entries.push({ path: entry.path, type: String(entry.type), size: entry.size ?? 0 });
    },
  });
  const normalizedName = executableName.replace(/^\.\//, '');
  if (
    entries.length !== 1 ||
    entries[0] === undefined ||
    entries[0].path.replace(/^\.\//, '') !== normalizedName ||
    entries[0].type !== 'File' ||
    entries[0].size <= 0 ||
    entries[0].size > MAX_OFFICIAL_EXECUTABLE_BYTES ||
    entries[0].path.includes('..') ||
    entries[0].path.startsWith('/')
  ) {
    throw new Error('The Antigravity archive must contain exactly one regular executable');
  }
  await extractTar({
    file: archivePath,
    cwd: destinationDir,
    strict: true,
    preserveOwner: false,
    filter: (entryPath) => entryPath.replace(/^\.\//, '') === normalizedName,
  });
}

export async function syncAntigravityUserConfig(input: {
  readonly profileHome: string;
  readonly tempHome?: string;
  readonly userHome: string;
  readonly platform: NodeJS.Platform;
}): Promise<void> {
  const dirs = [input.profileHome, join(input.profileHome, 'antigravity-acp')];
  if (input.tempHome !== undefined) dirs.push(input.tempHome);
  await Promise.all(dirs.map(async (dir) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (input.platform !== 'win32') await chmod(dir, 0o700).catch(() => undefined);
  }));

  const globalGemini = join(input.userHome, '.gemini');
  const dirLinkType = input.platform === 'win32' ? 'junction' : 'dir';
  for (const relative of [join('config', 'skills'), join('antigravity-cli', 'skills')]) {
    await reconcileDirectoryLink(
      join(input.profileHome, relative),
      join(globalGemini, relative),
      dirLinkType,
    ).catch(() => undefined);
  }

  if (input.platform !== 'win32') {
    for (const segments of USER_CONFIG_FILES) {
      await reconcileFileSymlink(
        join(input.profileHome, ...segments),
        join(globalGemini, ...segments),
      ).catch(() => undefined);
    }
    return;
  }

  await copyUserConfigFilesWindows(input.profileHome, globalGemini).catch(() => undefined);
}

async function reconcileDirectoryLink(link: string, target: string, type: 'junction' | 'dir'): Promise<void> {
  const targetExists = await stat(target).then((info) => info.isDirectory(), () => false);
  const existing = await lstat(link).catch(() => undefined);
  if (!targetExists) {
    if (existing?.isSymbolicLink()) await rm(link, { force: true });
    return;
  }
  if (existing?.isSymbolicLink()) {
    const current = await readlink(link).then((value) => resolve(dirname(link), value), () => undefined);
    if (current === resolve(target)) return;
    await rm(link, { force: true });
  } else if (existing !== undefined) {
    if (!existing.isDirectory()) return;
    await rmdir(link).catch(() => undefined);
    if (await lstat(link).then(() => true, () => false)) return;
  }
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link, type);
}

async function reconcileFileSymlink(link: string, target: string): Promise<void> {
  const targetExists = await stat(target).then((info) => info.isFile(), () => false);
  const existing = await lstat(link).catch(() => undefined);
  if (!targetExists) {
    if (existing?.isSymbolicLink()) await rm(link, { force: true });
    return;
  }
  if (existing?.isSymbolicLink()) {
    const current = await readlink(link).then((value) => resolve(dirname(link), value), () => undefined);
    if (current === resolve(target)) return;
    await rm(link, { force: true });
  } else if (existing !== undefined) {
    return;
  }
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link, 'file');
}

async function copyUserConfigFilesWindows(profileHome: string, globalGemini: string): Promise<void> {
  const manifestPath = join(profileHome, RULE_COPIES_MANIFEST);
  const copies: Record<string, string> = {};
  const manifestText = await readFile(manifestPath, 'utf8').catch(() => undefined);
  if (manifestText !== undefined) {
    try {
      const parsed: unknown = JSON.parse(manifestText);
      if (isRecord(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string') copies[key] = value;
        }
      }
    } catch {}
  }

  let changed = false;
  for (const segments of USER_CONFIG_FILES) {
    const key = segments.join('/');
    const destination = join(profileHome, ...segments);
    const source = join(globalGemini, ...segments);
    const current = await readFile(destination, 'utf8').catch(() => undefined);
    if (current !== undefined && current !== copies[key]) {
      if (Object.hasOwn(copies, key)) {
        delete copies[key];
        changed = true;
      }
      continue;
    }
    const sourceText = await readFile(source, 'utf8').catch(() => undefined);
    if (sourceText === undefined) {
      if (current !== undefined) await rm(destination, { force: true }).catch(() => undefined);
      if (Object.hasOwn(copies, key)) {
        delete copies[key];
        changed = true;
      }
      continue;
    }
    if (current !== sourceText) {
      await mkdir(dirname(destination), { recursive: true });
      await atomicWrite(destination, sourceText);
    }
    if (copies[key] !== sourceText) {
      copies[key] = sourceText;
      changed = true;
    }
  }
  if (changed || manifestText === undefined) {
    await atomicWrite(manifestPath, `${JSON.stringify(copies, null, 2)}\n`).catch(() => undefined);
  }
}

export async function readAntigravityProfileCache(profileHome: string): Promise<AntigravityProfileCache | undefined> {
  const path = join(profileHome, PROFILE_CACHE_NAME);
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.size > MAX_CACHE_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(parsed) || parsed['version'] !== 1 || typeof parsed['checkedAt'] !== 'string') return undefined;
    return parsed as unknown as AntigravityProfileCache;
  } catch {
    return undefined;
  }
}

export async function writeAntigravityProfileCache(profileHome: string, cache: AntigravityProfileCache): Promise<void> {
  await mkdir(profileHome, { recursive: true, mode: 0o700 });
  await atomicWrite(join(profileHome, PROFILE_CACHE_NAME), `${JSON.stringify(cache, null, 2)}\n`);
}

export async function readAntigravityProfileSecrets(profileHome: string): Promise<AntigravityProfileSecrets> {
  const path = join(profileHome, 'antigravity-acp', PROFILE_SECRETS_NAME);
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.size > MAX_RECORD_BYTES) return {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(parsed)) return {};
    return {
      geminiApiKey: typeof parsed['geminiApiKey'] === 'string' && parsed['geminiApiKey'].trim() !== '' ? parsed['geminiApiKey'].trim() : undefined,
      googleApiKey: typeof parsed['googleApiKey'] === 'string' && parsed['googleApiKey'].trim() !== '' ? parsed['googleApiKey'].trim() : undefined,
    };
  } catch {
    return {};
  }
}

export async function writeAntigravityProfileSecrets(
  profileHome: string,
  patch: { readonly geminiApiKey?: string | null; readonly googleApiKey?: string | null },
): Promise<void> {
  const existing = await readAntigravityProfileSecrets(profileHome);
  const next: Record<string, string> = {};
  const geminiApiKey = patch.geminiApiKey === null ? undefined : patch.geminiApiKey ?? existing.geminiApiKey;
  const googleApiKey = patch.googleApiKey === null ? undefined : patch.googleApiKey ?? existing.googleApiKey;
  if (geminiApiKey !== undefined && geminiApiKey.trim() !== '') next['geminiApiKey'] = geminiApiKey.trim();
  if (googleApiKey !== undefined && googleApiKey.trim() !== '') next['googleApiKey'] = googleApiKey.trim();
  const dir = join(profileHome, 'antigravity-acp');
  const path = join(dir, PROFILE_SECRETS_NAME);
  if (Object.keys(next).length === 0) {
    await rm(path, { force: true }).catch(() => undefined);
    return;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
  if (process.platform !== 'win32') await chmod(path, 0o600).catch(() => undefined);
}

export async function readAntigravityLocalCredentials(
  profileHome: string,
  nowMs: number = Date.now(),
): Promise<AntigravityLocalCredentials> {
  const acpDir = join(profileHome, 'antigravity-acp');
  const cliTokenPath = join(acpDir, 'antigravity-oauth-token');
  const legacyTokenPath = join(acpDir, 'acp_token.json');
  const [settings, secrets, cliRaw, legacyRaw] = await Promise.all([
    readAntigravitySettings(profileHome),
    readAntigravityProfileSecrets(profileHome),
    readFile(cliTokenPath, 'utf8').catch(() => undefined),
    readFile(legacyTokenPath, 'utf8').catch(() => undefined),
  ]);

  let cliToken: AntigravityCliTokenData | undefined;
  if (cliRaw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(cliRaw);
      const token = isRecord(parsed) && isRecord(parsed['token']) ? parsed['token'] : undefined;
      if (token !== undefined && typeof token['access_token'] === 'string' && token['access_token'].trim() !== '') {
        const expiry = typeof token['expiry'] === 'string' ? token['expiry'] : undefined;
        const parsedExpiry = expiry !== undefined ? Date.parse(expiry) : NaN;
        const expired = !(Number.isFinite(parsedExpiry) && parsedExpiry > nowMs + 60_000);
        cliToken = {
          accessToken: token['access_token'],
          refreshToken: typeof token['refresh_token'] === 'string' ? token['refresh_token'] : undefined,
          expiry,
          expired,
        };
      }
    } catch {}
  }

  let legacyToken: AntigravityLegacyTokenData | undefined;
  if (legacyRaw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(legacyRaw);
      if (
        isRecord(parsed) &&
        typeof parsed['client_id'] === 'string' && parsed['client_id'].trim() !== '' &&
        typeof parsed['client_secret'] === 'string' && parsed['client_secret'].trim() !== '' &&
        typeof parsed['refresh_token'] === 'string' && parsed['refresh_token'].trim() !== ''
      ) {
        legacyToken = {
          clientId: parsed['client_id'],
          clientSecret: parsed['client_secret'],
          refreshToken: parsed['refresh_token'],
          projectId: typeof parsed['project_id'] === 'string' && parsed['project_id'].trim() !== ''
            ? parsed['project_id']
            : undefined,
        };
      }
    } catch {}
  }

  const revisionHash = createHash('sha256')
    .update(JSON.stringify({
      authMethod: settings.authMethod,
      gcpProject: settings.gcpProject,
      gcpLocation: settings.gcpLocation,
      cliHash: cliRaw === undefined ? undefined : createHash('sha256').update(cliRaw).digest('hex'),
      legacyHash: legacyRaw === undefined ? undefined : createHash('sha256').update(legacyRaw).digest('hex'),
      hasGeminiKey: secrets.geminiApiKey !== undefined,
      hasGoogleKey: secrets.googleApiKey !== undefined,
    }))
    .digest('hex');

  return {
    settings,
    cliToken,
    legacyToken,
    secrets,
    hasCliToken: cliToken !== undefined,
    hasLegacyToken: legacyToken !== undefined,
    revisionHash,
  };
}

export interface AntigravityAuthConfigSnapshot {
  readonly settingsRaw?: string;
  readonly secretsRaw?: string;
}

export async function snapshotAntigravityAuthConfig(profileHome: string): Promise<AntigravityAuthConfigSnapshot> {
  const acpDir = join(profileHome, 'antigravity-acp');
  const [settingsRaw, secretsRaw] = await Promise.all([
    readFile(join(acpDir, 'settings.json'), 'utf8').catch(() => undefined),
    readFile(join(acpDir, PROFILE_SECRETS_NAME), 'utf8').catch(() => undefined),
  ]);
  return { settingsRaw, secretsRaw };
}

export async function restoreAntigravityAuthConfig(
  profileHome: string,
  snapshot: AntigravityAuthConfigSnapshot,
): Promise<void> {
  const acpDir = join(profileHome, 'antigravity-acp');
  const settingsPath = join(acpDir, 'settings.json');
  const secretsPath = join(acpDir, PROFILE_SECRETS_NAME);
  if (snapshot.settingsRaw === undefined) {
    await removeFileIfPresent(settingsPath);
  } else {
    await mkdir(acpDir, { recursive: true, mode: 0o700 });
    await atomicWrite(settingsPath, snapshot.settingsRaw);
  }
  if (snapshot.secretsRaw === undefined) {
    await removeFileIfPresent(secretsPath);
  } else {
    await mkdir(acpDir, { recursive: true, mode: 0o700 });
    await atomicWrite(secretsPath, snapshot.secretsRaw);
    if (process.platform !== 'win32') {
      await chmod(secretsPath, 0o600).catch(() => undefined);
    }
  }
}

export async function scrubAntigravityProfileAuth(profileHome: string): Promise<void> {
  const acpDir = join(profileHome, 'antigravity-acp');
  await Promise.all([
    removeFileIfPresent(join(acpDir, 'antigravity-oauth-token')),
    removeFileIfPresent(join(acpDir, 'acp_token.json')),
    removeFileIfPresent(join(acpDir, PROFILE_SECRETS_NAME)),
    removeFileIfPresent(join(profileHome, PROFILE_CACHE_NAME)),
  ]);
}

async function removeFileIfPresent(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw error;
  }
}

export async function createAntigravityProbeWorkspace(profileHome: string): Promise<string> {
  const tmpRoot = join(profileHome, 'antigravity-acp', 'tmp');
  await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
  return mkdtemp(join(tmpRoot, `probe-${randomUUID().slice(0, 8)}-`));
}

export async function removeDirectoryForce(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

export async function scrubAntigravityProbeSession(input: {
  readonly profileHome: string;
  readonly sessionId: string | undefined;
  readonly cwd: string;
}): Promise<void> {
  const { sessionId } = input;
  if (sessionId === undefined || !NATIVE_SESSION_ID_RE.test(sessionId)) return;
  const acpDirectory = join(input.profileHome, 'antigravity-acp');
  const base = join(acpDirectory, 'conversations', sessionId);
  const metaPath = `${base}.meta`;
  const hasMeta = await stat(metaPath).then((info) => info.isFile(), () => false);
  if (hasMeta) {
    const raw = await readFile(metaPath, 'utf8').catch(() => undefined);
    if (raw === undefined) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed['cwd'] !== input.cwd) return;
    } catch {
      return;
    }
  } else {
    const workspacePaths = await readDatabaseWorkspacePaths(input.profileHome, sessionId);
    if (workspacePaths === undefined || workspacePaths.length === 0) return;
    const cwdKey = await canonicalPathKey(input.cwd);
    for (const workspacePath of workspacePaths) {
      if (await canonicalPathKey(workspacePath) !== cwdKey) return;
    }
  }

  for (const suffix of ['.db', '.db-wal', '.db-shm', '.db-journal', '.meta']) {
    await rm(`${base}${suffix}`, { force: true }).catch(() => undefined);
  }
  await rm(join(acpDirectory, 'brain', sessionId), { recursive: true, force: true }).catch(() => undefined);
  await rm(join(acpDirectory, 'annotations', `${sessionId}.pbtxt`), { force: true }).catch(() => undefined);
}

function decodeProtoFields(bytes: Uint8Array): ReadonlyArray<readonly [number, Uint8Array]> {
  const fields: Array<readonly [number, Uint8Array]> = [];
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error('Truncated varint');
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    throw new Error('Overlong varint');
  };
  while (offset < bytes.length) {
    const key = readVarint();
    const wire = key % 8;
    const field = Math.floor(key / 8);
    if (wire === 0) readVarint();
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else if (wire === 2) {
      const length = readVarint();
      if (offset + length > bytes.length) throw new Error('Truncated field');
      fields.push([field, bytes.subarray(offset, offset + length)]);
      offset += length;
    } else {
      throw new Error('Unsupported wire type');
    }
  }
  if (offset > bytes.length) throw new Error('Truncated field');
  return fields;
}

function decodeTrajectoryOwnership(blob: Uint8Array): {
  readonly sessionId: string | undefined;
  readonly workspaceUris: readonly string[];
} | undefined {
  const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    let sessionId: string | undefined;
    const workspaceUris: string[] = [];
    for (const [field, value] of decodeProtoFields(blob)) {
      if (field === TRAJECTORY_SESSION_ID && sessionId === undefined) {
        const decoded = utf8Decoder.decode(value).trim();
        if (decoded.length > 0) sessionId = decoded;
      } else if (field === TRAJECTORY_WORKSPACES) {
        for (const [nestedField, nestedValue] of decodeProtoFields(value)) {
          if (nestedField !== WORKSPACE_URI) continue;
          const uri = utf8Decoder.decode(nestedValue).trim();
          if (uri.length > 0) workspaceUris.push(uri);
        }
      } else if (field === TRAJECTORY_WORKSPACE_URIS) {
        const uri = utf8Decoder.decode(value).trim();
        if (uri.length > 0) workspaceUris.push(uri);
      }
    }
    return { sessionId, workspaceUris };
  } catch {
    return undefined;
  }
}

async function readDatabaseWorkspacePaths(
  profileHome: string,
  sessionId: string,
): Promise<readonly string[] | undefined> {
  const root = await realpath(profileHome).catch(() => undefined);
  if (root === undefined) return undefined;
  const dbPath = await verifyManagedFilePath(root, ['antigravity-acp', 'conversations', `${sessionId}.db`]);
  if (dbPath === undefined) return undefined;

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
    database.exec('PRAGMA busy_timeout = 100');
    const rows = database
      .prepare('SELECT data FROM trajectory_metadata_blob WHERE length(data) <= ? LIMIT 2')
      .all(MAX_METADATA_BLOB_BYTES);
    if (rows.length !== 1) return undefined;
    const row = rows[0] as Record<string, unknown> | null | undefined;
    if (row === null || row === undefined || typeof row !== 'object' || !(row['data'] instanceof Uint8Array)) {
      return undefined;
    }
    const metadata = decodeTrajectoryOwnership(row['data']);
    if (
      metadata === undefined ||
      metadata.workspaceUris.length === 0 ||
      (metadata.sessionId !== undefined && metadata.sessionId !== sessionId)
    ) {
      return undefined;
    }
    return metadata.workspaceUris.map((uri) => fileURLToPath(uri));
  } catch {
    return undefined;
  } finally {
    try { database?.close(); } catch {}
  }
}

async function verifyManagedFilePath(root: string, segments: readonly string[]): Promise<string | undefined> {
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => undefined);
    const expectFile = index === segments.length - 1;
    if (info === undefined || info.isSymbolicLink() || (expectFile ? !info.isFile() : !info.isDirectory())) {
      return undefined;
    }
  }
  return (await realpath(current).catch(() => undefined)) === current ? current : undefined;
}

async function canonicalPathKey(target: string): Promise<string> {
  const resolved = await realpath(target).catch(() => resolve(target));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeFsPathKey(target: string, platform: NodeJS.Platform): string {
  const resolved = resolve(target);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function retryOnWindowsLock<T>(platform: NodeJS.Platform, work: () => Promise<T>): Promise<T> {
  const maxAttempts = platform === 'win32' ? 16 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (platform !== 'win32' || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') || attempt + 1 >= maxAttempts) {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    }
  }
  throw lastError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
