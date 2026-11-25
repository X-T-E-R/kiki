import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { basename, extname, isAbsolute, join } from 'pathe';
import type { ReadFilesResult, SelectedFileDescriptor } from '#/shared/types';

export type HostPathOp = 'open' | 'reveal' | 'write';

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([
  'exe',
  'com',
  'pif',
  'scr',
  'cpl',
  'msi',
  'msp',
  'msc',
  'bat',
  'cmd',
  'ps1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'hta',
  'lnk',
  'reg',
  'url',
  'chm',
  'application',
  'settingcontent-ms',
]);

const MACOS_EXECUTABLE_EXTENSIONS = new Set(['app', 'command']);
const LINUX_EXECUTABLE_EXTENSIONS = new Set(['desktop']);

const IMAGE_MIMES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const MAX_SAVE_CHUNK_BYTES = 64 * 1024;
const MAX_SELECTED_TOKENS = 512;

export function normalizeIncomingHostPath(rawPath: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(rawPath) ? rawPath.slice(1) : rawPath;
}

export function isRemoteOrDevicePath(rawPath: string): boolean {
  return (
    rawPath.startsWith('\\\\') ||
    rawPath.startsWith('//') ||
    rawPath.startsWith('\\??\\') ||
    rawPath.includes('\0')
  );
}

export function isExecutableHostPath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  let name = basename(filePath.replaceAll('\\', '/'));
  if (platform === 'win32') {
    name = name.replace(/[. ]+$/, '');
  }
  const ext = extname(name).slice(1).toLowerCase();
  if (ext === '') return false;
  if (platform === 'win32') return WINDOWS_EXECUTABLE_EXTENSIONS.has(ext);
  if (platform === 'darwin') return MACOS_EXECUTABLE_EXTENSIONS.has(ext);
  return LINUX_EXECUTABLE_EXTENSIONS.has(ext);
}

export async function validateHostPath(
  rawPath: string,
  op: HostPathOp,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const target = normalizeIncomingHostPath(rawPath);
  if (target.trim() === '' || isRemoteOrDevicePath(target)) {
    throw new Error(
      `Host path ${rawPath} must be a plain local drive path (no UNC, device, or verbatim prefix)`,
    );
  }
  const windowsDriveAbsolute = /^[A-Za-z]:[\\/]/.test(target);
  const absolute = platform === 'win32' ? windowsDriveAbsolute : isAbsolute(target);
  if (!absolute) {
    throw new Error('Host path must be absolute');
  }
  if (op === 'open' && isExecutableHostPath(target, platform)) {
    throw new Error(`Refusing to open executable host path ${target}`);
  }
  if (op === 'open' && platform !== 'win32') {
    try {
      const resolved = await realpath(target);
      if (isExecutableHostPath(resolved, platform)) {
        throw new Error(`Refusing to open executable host path ${target}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Refusing to open')) throw error;
    }
  }
  return target;
}

export function validateExternalUrl(raw: string): string {
  if (/[\u0000-\u001F\u007F]/.test(raw)) {
    throw new Error('Invalid URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const host = parsed.hostname.replace(/\.+$/, '').toLowerCase();
    if (
      host === '' ||
      host === 'tauri.localhost' ||
      host === 'ipc.localhost' ||
      host === 'kiki-document.localhost' ||
      host.endsWith('.kiki-document.localhost')
    ) {
      throw new Error('Only external http(s) and mailto URLs can be opened');
    }
    return parsed.href;
  }
  if (parsed.protocol === 'mailto:') {
    if (raw.slice('mailto:'.length).trim() === '') {
      throw new Error('Only external http(s) and mailto URLs can be opened');
    }
    return parsed.href;
  }
  throw new Error('Only external http(s) and mailto URLs can be opened');
}

export interface FileAndClipboardDeps {
  readonly platform?: NodeJS.Platform;
  readonly tempSaveDir: string;
  readonly showSaveDialog: (defaultFilename: string) => Promise<string | null>;
  readonly showOpenDialog: (options: {
    readonly directory: boolean;
    readonly multiple: boolean;
  }) => Promise<readonly string[] | null>;
  readonly readOsClipboardFilePaths: () =>
    | Promise<readonly string[] | null>
    | readonly string[]
    | null;
  readonly revealInFileManager: (validatedPath: string) => Promise<void> | void;
  readonly openWithDefaultApp: (validatedPath: string) => Promise<void>;
  readonly openExternal: (validatedUrl: string) => Promise<void>;
}

interface ActiveSaveSink {
  readonly targetPath: string;
  readonly tempPath: string;
  readonly stream: WriteStream;
  phase: 'writing' | 'committing' | 'closed';
}

export class FileAndClipboardService {
  private readonly platform: NodeJS.Platform;
  private readonly sinks = new Map<string, ActiveSaveSink>();
  private readonly selectedTokens = new Map<string, string>();
  private workspaceScope: 'local' | 'ssh' = 'local';

  constructor(private readonly deps: FileAndClipboardDeps) {
    this.platform = deps.platform ?? process.platform;
  }

  setWorkspaceScope(scope: 'local' | 'ssh'): void {
    this.workspaceScope = scope;
  }

  private requireLocalWorkspace(): void {
    if (this.workspaceScope === 'ssh') {
      throw new Error(
        'This is an SSH workspace. Use a remote server operation, not a local file or directory action.',
      );
    }
  }

  private registerSelectedToken(filePath: string): string {
    const token = randomUUID();
    this.selectedTokens.set(token, filePath);
    if (this.selectedTokens.size > MAX_SELECTED_TOKENS) {
      const oldest = this.selectedTokens.keys().next().value;
      if (oldest !== undefined) this.selectedTokens.delete(oldest);
    }
    return token;
  }

  async openSaveSink(filename: string): Promise<{ sinkId: string } | null> {
    const target = await this.deps.showSaveDialog(basename(filename));
    if (target === null) return null;
    await mkdir(this.deps.tempSaveDir, { recursive: true });
    const sinkId = randomUUID();
    const tempPath = join(this.deps.tempSaveDir, `${sinkId}.part`);
    const stream = createWriteStream(tempPath, { flags: 'wx' });
    this.sinks.set(sinkId, { targetPath: target, tempPath, stream, phase: 'writing' });
    return { sinkId };
  }

  async writeSaveSink(sinkId: string, chunk: Uint8Array): Promise<void> {
    const sink = this.sinks.get(sinkId);
    if (sink === undefined || sink.phase !== 'writing') {
      throw new Error('The save stream is closed');
    }
    if (chunk.byteLength > MAX_SAVE_CHUNK_BYTES) {
      throw new Error('The save chunk exceeds 64 KiB');
    }
    await new Promise<void>((resolve, reject) => {
      sink.stream.write(chunk, (error) => {
        if (error !== null && error !== undefined) reject(error);
        else resolve();
      });
    });
  }

  async closeSaveSink(sinkId: string): Promise<boolean> {
    const sink = this.sinks.get(sinkId);
    if (sink === undefined || sink.phase !== 'writing') return false;
    sink.phase = 'committing';
    try {
      await new Promise<void>((resolve, reject) => {
        sink.stream.once('error', reject);
        sink.stream.end(() => {
          resolve();
        });
      });
      try {
        await rename(sink.tempPath, sink.targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await copyFile(sink.tempPath, sink.targetPath);
      }
      return true;
    } finally {
      sink.phase = 'closed';
      this.sinks.delete(sinkId);
      await rm(sink.tempPath, { force: true }).catch(() => undefined);
    }
  }

  async abortSaveSink(sinkId: string): Promise<void> {
    const sink = this.sinks.get(sinkId);
    if (sink === undefined || sink.phase !== 'writing') return;
    sink.phase = 'closed';
    this.sinks.delete(sinkId);
    sink.stream.destroy();
    await rm(sink.tempPath, { force: true }).catch(() => undefined);
  }

  async saveBlob(bytes: Uint8Array, filename: string): Promise<boolean> {
    const target = await this.deps.showSaveDialog(basename(filename));
    if (target === null) return false;
    await mkdir(this.deps.tempSaveDir, { recursive: true });
    const tempPath = join(this.deps.tempSaveDir, `${randomUUID()}.part`);
    try {
      await pipeline(Readable.from([bytes]), createWriteStream(tempPath, { flags: 'wx' }));
      try {
        await rename(tempPath, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await copyFile(tempPath, target);
      }
      return true;
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  async pickFilePath(): Promise<string | null> {
    this.requireLocalWorkspace();
    const selected = await this.deps.showOpenDialog({ directory: false, multiple: false });
    return selected?.[0] ?? null;
  }

  async pickFiles(): Promise<SelectedFileDescriptor[] | null> {
    const selected = await this.deps.showOpenDialog({ directory: false, multiple: true });
    if (selected === null) return null;
    const descriptors: SelectedFileDescriptor[] = [];
    for (const filePath of selected) {
      const info = await stat(filePath);
      const name = basename(filePath.replaceAll('\\', '/'));
      const ext = extname(name).slice(1).toLowerCase();
      descriptors.push({
        token: this.registerSelectedToken(filePath),
        name,
        size: info.size,
        type: IMAGE_MIMES[ext] ?? '',
      });
    }
    return descriptors;
  }

  async readSelectedFile(token: string): Promise<Uint8Array> {
    const filePath = this.selectedTokens.get(token);
    if (filePath === undefined) {
      throw new Error('Unknown or expired file selection token');
    }
    const bytes = await readFile(filePath);
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async pickDirectory(): Promise<string | null> {
    this.requireLocalWorkspace();
    const selected = await this.deps.showOpenDialog({ directory: true, multiple: false });
    return selected?.[0] ?? null;
  }

  async pickDirectories(): Promise<readonly string[] | null> {
    this.requireLocalWorkspace();
    return this.deps.showOpenDialog({ directory: true, multiple: true });
  }

  async readDroppedFiles(rawPaths: readonly string[]): Promise<ReadFilesResult> {
    const paths: string[] = [];
    const files: SelectedFileDescriptor[] = [];
    for (const candidate of rawPaths) {
      const name = basename(candidate.replaceAll('\\', '/'));
      const ext = extname(name).slice(1).toLowerCase();
      const mime = IMAGE_MIMES[ext];
      if (mime === undefined) {
        paths.push(candidate);
        continue;
      }
      try {
        const info = await stat(candidate);
        if (info.isDirectory()) {
          paths.push(candidate);
          continue;
        }
        files.push({
          token: this.registerSelectedToken(candidate),
          name,
          size: info.size,
          type: mime,
        });
      } catch {
        paths.push(candidate);
      }
    }
    return { paths, files };
  }

  async readClipboardFiles(): Promise<ReadFilesResult | null> {
    const copied = await this.deps.readOsClipboardFilePaths();
    if (copied === null || copied.length === 0) return null;
    return this.readDroppedFiles(copied);
  }

  async revealPath(rawPath: string): Promise<void> {
    this.requireLocalWorkspace();
    const validated = await validateHostPath(rawPath, 'reveal', this.platform);
    await this.deps.revealInFileManager(validated);
  }

  async openPath(rawPath: string): Promise<void> {
    this.requireLocalWorkspace();
    const validated = await validateHostPath(rawPath, 'open', this.platform);
    await this.deps.openWithDefaultApp(validated);
  }

  async openExternalUrl(rawUrl: string): Promise<void> {
    const validated = validateExternalUrl(rawUrl);
    await this.deps.openExternal(validated);
  }

  async writeFileText(rawPath: string, text: string): Promise<void> {
    this.requireLocalWorkspace();
    const validated = await validateHostPath(rawPath, 'write', this.platform);
    await writeFile(validated, text, 'utf8');
  }
}

export function decodeClipboardUriList(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const paths: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'file:') continue;
      paths.push(fileURLToPath(url, { windows: platform === 'win32' }));
    } catch {
      continue;
    }
  }
  return paths;
}
