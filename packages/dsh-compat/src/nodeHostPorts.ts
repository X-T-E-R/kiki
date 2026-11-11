import { Buffer } from 'node:buffer';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

import { AttachmentError } from './vendor/attachment/src/error';
import { AttachmentId, ImageVariantId } from './vendor/attachment/src/brand';
import { AttachmentStore } from './vendor/attachment/src/index';
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageMediaType,
  ImageRequestTarget,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from './vendor/attachment/src/types';
import { Context, Service } from '@kiki/cordis-runtime';
import {
  FsTargetKey,
  FsVersion,
  scrubbedParentEnv,
  SubprocessExecutableNotFoundError,
} from './dshAgentSessionSurface';
import type {
  DshAttachmentsPort,
  DshCredentialsPort,
  DshFileSystemPort,
  DshFsInfo,
  DshFsTarget,
  DshHostPorts,
  DshLlmPort,
  DshSubprocessHandle,
  DshSubprocessOutputReader,
  DshSubprocessPort,
  DshSubprocessSpawnSpec,
} from './hostServicesBridge';

const DEFAULT_IMAGE_LIMITS: ImageAttachmentLimits = Object.freeze({
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 16,
  maxMessageImageBytes: 40 * 1024 * 1024,
  maxImagePixels: 64_000_000,
  maxImageDimension: 16_384,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
});

export function parseImageRasterHeader(
  bytes: Uint8Array,
): { readonly mediaType: ImageMediaType; readonly width: number; readonly height: number } {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    buf.length >= 24
    && buf[0] === 0x89
    && buf[1] === 0x50
    && buf[2] === 0x4e
    && buf[3] === 0x47
    && buf[4] === 0x0d
    && buf[5] === 0x0a
    && buf[6] === 0x1a
    && buf[7] === 0x0a
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width < 1 || height < 1) throw new AttachmentError('Invalid PNG dimensions.', 'INVALID_IMAGE');
    return { mediaType: 'image/png', width, height };
  }
  if (
    buf.length >= 10
    && buf[0] === 0x47
    && buf[1] === 0x49
    && buf[2] === 0x46
    && buf[3] === 0x38
    && (buf[4] === 0x37 || buf[4] === 0x39)
    && buf[5] === 0x61
  ) {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    if (width < 1 || height < 1) throw new AttachmentError('Invalid GIF dimensions.', 'INVALID_IMAGE');
    return { mediaType: 'image/gif', width, height };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < buf.length && buf[offset] === 0xff) offset += 1;
      if (offset >= buf.length) break;
      const marker = buf[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        continue;
      }
      if (offset + 2 > buf.length) break;
      const segLen = buf.readUInt16BE(offset);
      if (segLen < 2 || offset + segLen > buf.length) break;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isSof && segLen >= 7) {
        const height = buf.readUInt16BE(offset + 3);
        const width = buf.readUInt16BE(offset + 5);
        if (width < 1 || height < 1) throw new AttachmentError('Invalid JPEG dimensions.', 'INVALID_IMAGE');
        return { mediaType: 'image/jpeg', width, height };
      }
      offset += segLen;
    }
    throw new AttachmentError('Truncated or malformed JPEG header.', 'INVALID_IMAGE');
  }
  if (
    buf.length >= 30
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunkType = buf.toString('ascii', 12, 16);
    if (chunkType === 'VP8X' && buf.length >= 30) {
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return { mediaType: 'image/webp', width, height };
    }
    if (chunkType === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { mediaType: 'image/webp', width, height };
    }
    if (chunkType === 'VP8 ' && buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      if (width >= 1 && height >= 1) return { mediaType: 'image/webp', width, height };
    }
  }
  throw new AttachmentError('Unsupported or corrupted raster image bytes.', 'INVALID_IMAGE');
}

export class HostBackedAttachmentStore extends AttachmentStore implements DshAttachmentsPort {
  readonly imageLimits: ImageAttachmentLimits;
  private readonly blobs = new Map<string, { ref: ImageAttachmentRef; data: Uint8Array; hostPath?: string }>();

  constructor(
    ctx: Context,
    private readonly options: {
      readonly storageDir?: string;
      readonly limits?: Partial<ImageAttachmentLimits>;
    } = {},
  ) {
    super(ctx);
    this.imageLimits = Object.freeze({
      ...DEFAULT_IMAGE_LIMITS,
      ...options.limits,
    });
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    if (input.data.byteLength === 0) {
      throw new AttachmentError('Image payload must not be empty.', 'INVALID_IMAGE');
    }
    if (input.data.byteLength > this.imageLimits.maxImageBytes) {
      throw new AttachmentError('Image exceeds maxImageBytes limit.', 'IMAGE_TOO_LARGE');
    }
    const parsed = parseImageRasterHeader(input.data);
    if (parsed.mediaType !== input.mediaType) {
      throw new AttachmentError(
        `Declared mediaType "${input.mediaType}" does not match actual "${parsed.mediaType}" header.`,
        'IMAGE_TYPE_MISMATCH',
      );
    }
    if (parsed.width > this.imageLimits.maxImageDimension || parsed.height > this.imageLimits.maxImageDimension) {
      throw new AttachmentError('Image dimensions exceed configured limits.', 'IMAGE_DIMENSION_TOO_LARGE');
    }
    if (parsed.width * parsed.height > this.imageLimits.maxImagePixels) {
      throw new AttachmentError('Image pixel count exceeds configured limits.', 'IMAGE_TOO_MANY_PIXELS');
    }
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    await this.validateImage(input);
    const parsed = parseImageRasterHeader(input.data);
    const digest = createHash('sha256').update(input.data).digest('hex');
    const attachmentId = AttachmentId(`img_${digest.slice(0, 32)}`);
    const copy = new Uint8Array(input.data.byteLength);
    copy.set(input.data);
    const sanitizedName = input.name === undefined
      ? undefined
      : input.name.replaceAll(/[\\/]/g, '_').slice(0, 128);
    const ref: ImageAttachmentRef = Object.freeze({
      attachmentId,
      mediaType: parsed.mediaType,
      bytes: copy.byteLength,
      width: parsed.width,
      height: parsed.height,
      ...(sanitizedName === undefined ? {} : { name: sanitizedName }),
    });
    let hostPath: string | undefined;
    if (this.options.storageDir !== undefined) {
      await mkdir(this.options.storageDir, { recursive: true });
      const ext = parsed.mediaType.split('/')[1] ?? 'bin';
      hostPath = join(this.options.storageDir, `${attachmentId}.${ext}`);
      await writeFile(hostPath, copy);
    }
    this.blobs.set(attachmentId, { ref, data: copy, hostPath });
    return ref;
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted();
    const entry = this.blobs.get(ref.attachmentId);
    if (entry === undefined) {
      throw new AttachmentError(`Attachment "${ref.attachmentId}" was not found.`, 'ATTACHMENT_NOT_FOUND');
    }
    const copy = new Uint8Array(entry.data.byteLength);
    copy.set(entry.data);
    return { ref: entry.ref, data: copy };
  }

  override imageHostPath(ref: ImageAttachmentRef): string | undefined {
    return this.blobs.get(ref.attachmentId)?.hostPath;
  }

  override async readImageRequest(
    ref: ImageAttachmentRef,
    _target: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    const stored = await this.readImage(ref, signal);
    return {
      variantId: ImageVariantId(`${ref.attachmentId}:raw`),
      attachment: stored.ref,
      data: stored.data,
      mediaType: stored.ref.mediaType,
      bytes: stored.ref.bytes,
      width: stored.ref.width,
      height: stored.ref.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: stored.ref.mediaType !== 'image/jpeg',
    };
  }

  readBase64(attachmentId: string): string | undefined {
    const entry = this.blobs.get(attachmentId);
    if (entry === undefined) return undefined;
    return Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength).toString('base64');
  }
}

class TailCollector implements DshSubprocessOutputReader {
  private totalBytes = 0;
  private chunks: Buffer[] = [];
  private retainedBytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.totalBytes += chunk.length;
    if (this.maxBytes <= 0) return;
    if (chunk.length >= this.maxBytes) {
      this.chunks = [Buffer.from(chunk.subarray(chunk.length - this.maxBytes))];
      this.retainedBytes = this.maxBytes;
      return;
    }
    this.chunks.push(Buffer.from(chunk));
    this.retainedBytes += chunk.length;
    while (this.retainedBytes > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0];
      const overflow = this.retainedBytes - this.maxBytes;
      if (head.length <= overflow) {
        this.chunks.shift();
        this.retainedBytes -= head.length;
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.retainedBytes -= overflow;
      }
    }
  }

  readFrom(fromByte: number): {
    readonly text: string;
    readonly nextOffset: number;
    readonly lossy: boolean;
  } {
    const windowStart = this.totalBytes - this.retainedBytes;
    const lossy = fromByte < windowStart;
    const merged = this.chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(this.chunks, this.retainedBytes);
    const sliceOffset = lossy ? 0 : Math.min(merged.length, Math.max(0, fromByte - windowStart));
    return {
      text: merged.subarray(sliceOffset).toString('utf8'),
      nextOffset: this.totalBytes,
      lossy,
    };
  }
}

function normalizePathKey(resolvedPath: string): string {
  const unified = resolvedPath.replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

export function createNodeFileSystemPort(defaultCwd = process.cwd()): DshFileSystemPort {
  const targetPaths = new Map<string, string>();

  const resolveRealWithMissingLeaf = async (candidate: string): Promise<string> => {
    try {
      return await realpath(candidate);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return candidate;
      try {
        const realParent = await realpath(parent);
        return join(realParent, relative(parent, candidate));
      } catch {
        return candidate;
      }
    }
  };

  return {
    async resolve(inputPath: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<DshFsTarget> {
      options?.signal?.throwIfAborted();
      const base = options?.cwd ?? defaultCwd;
      const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(base, inputPath);
      const canonical = await resolveRealWithMissingLeaf(abs);
      options?.signal?.throwIfAborted();
      const key = FsTargetKey(normalizePathKey(canonical));
      targetPaths.set(key, canonical);
      return {
        targetKey: key,
        displayPath: canonical,
      };
    },
    processPath(target: DshFsTarget): string {
      return targetPaths.get(target.targetKey) ?? target.displayPath;
    },
    fileUrl(target: DshFsTarget): string {
      const fsPath = targetPaths.get(target.targetKey) ?? target.displayPath;
      return pathToFileURL(fsPath).href;
    },
    contains(parent: DshFsTarget, child: DshFsTarget): boolean {
      const parentKey = parent.targetKey;
      const childKey = child.targetKey;
      if (parentKey === childKey) return true;
      const prefix = parentKey.endsWith('/') ? parentKey : `${parentKey}/`;
      return childKey.startsWith(prefix);
    },
    async stat(target: DshFsTarget, signal?: AbortSignal): Promise<DshFsInfo | undefined> {
      signal?.throwIfAborted();
      const fsPath = targetPaths.get(target.targetKey) ?? target.displayPath;
      try {
        const stats = await stat(fsPath);
        signal?.throwIfAborted();
        const type = stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other';
        return {
          version: FsVersion(`${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`),
          type,
          size: stats.size,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async streamText(target: DshFsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
      signal?.throwIfAborted();
      const fsPath = targetPaths.get(target.targetKey) ?? target.displayPath;
      const info = await stat(fsPath);
      if (!info.isFile()) {
        throw new Error(`target "${fsPath}" is not a regular file`);
      }
      return {
        async *[Symbol.asyncIterator]() {
          const stream = createReadStream(fsPath);
          const decoder = new StringDecoder('utf8');
          try {
            for await (const chunk of stream) {
              signal?.throwIfAborted();
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              if (buf.includes(0)) {
                throw new Error(`binary file rejected: "${fsPath}"`);
              }
              const text = decoder.write(buf);
              if (text.length > 0) yield text;
            }
            const rest = decoder.end();
            if (rest.length > 0) yield rest;
          } finally {
            stream.destroy();
          }
        },
      };
    },
  };
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    if (process.platform !== 'win32') {
      await access(filePath, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export function createNodeSubprocessPort(): DshSubprocessPort {
  return {
    async resolveExecutable(command, env, signal): Promise<string> {
      signal?.throwIfAborted();
      if (command.trim() === '') {
        throw new SubprocessExecutableNotFoundError('Executable command must not be empty.');
      }
      if (isAbsolute(command)) {
        if (await isExecutableFile(command)) return resolve(command);
        throw new SubprocessExecutableNotFoundError(`Executable not found at "${command}".`);
      }
      if (command.includes('/') || command.includes('\\')) {
        throw new SubprocessExecutableNotFoundError(
          `Relative executable path "${command}" with path separators is not permitted.`,
        );
      }
      const baseEnv = { ...scrubbedParentEnv(), ...env };
      const pathVar = baseEnv['PATH'] ?? baseEnv['Path'] ?? process.env['PATH'] ?? '';
      const dirs = pathVar.split(delimiter).filter(Boolean);
      const extensions = process.platform === 'win32'
        ? (extname(command)
            ? ['']
            : (baseEnv['PATHEXT'] ?? process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM')
                .split(';')
                .filter(Boolean))
        : [''];
      for (const dir of dirs) {
        for (const ext of extensions) {
          signal?.throwIfAborted();
          const candidate = resolve(dir, `${command}${ext}`);
          if (await isExecutableFile(candidate)) return candidate;
        }
      }
      throw new SubprocessExecutableNotFoundError(`Executable "${command}" not found on PATH.`);
    },

    spawn(spec: DshSubprocessSpawnSpec): DshSubprocessHandle {
      spec.signal?.throwIfAborted();
      const [executable, ...args] = spec.argv;
      if (!executable) throw new Error('Subprocess argv[0] must be a non-empty executable path.');
      if (!isAbsolute(spec.cwd)) throw new Error(`Subprocess cwd "${spec.cwd}" must be absolute.`);
      if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0) {
        throw new Error('Subprocess graceMs must be a positive finite number.');
      }

      const mergedEnv: NodeJS.ProcessEnv = { ...scrubbedParentEnv() };
      if (spec.env !== undefined) {
        for (const [key, value] of Object.entries(spec.env)) {
          if (value === undefined) Reflect.deleteProperty(mergedEnv, key);
          else mergedEnv[key] = value;
        }
      }

      const stdinMode = spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe';
      const stdoutMode = spec.stdio.stdout === 'inherit' ? 'inherit' : 'pipe';
      const stderrMode = spec.stdio.stderr === 'inherit' ? 'inherit' : 'pipe';

      const child: ChildProcess = spawn(executable, args, {
        cwd: spec.cwd,
        env: mergedEnv,
        stdio: [stdinMode, stdoutMode, stderrMode],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });

      const stdoutCollector = typeof spec.stdio.stdout === 'object'
        ? new TailCollector(spec.stdio.stdout.maxBytes)
        : undefined;
      const stderrCollector = typeof spec.stdio.stderr === 'object'
        ? new TailCollector(spec.stdio.stderr.maxBytes)
        : undefined;

      if (stdoutCollector !== undefined && child.stdout) {
        child.stdout.on('data', (chunk: Buffer) => {
          stdoutCollector.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
      }
      if (stderrCollector !== undefined && child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => {
          stderrCollector.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
      }

      if (typeof spec.stdio.stdin === 'object' && child.stdin) {
        child.stdin.end(spec.stdio.stdin.data, 'utf8');
      }

      let exited = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const terminateProcessTree = (): void => {
        if (exited) return;
        try {
          if (child.stdin && !child.stdin.destroyed) {
            child.stdin.destroy();
          }
        } catch {
          // Ignore stream teardown errors during forced termination.
        }
        if (process.platform === 'win32') {
          try {
            child.kill();
          } catch {
            // Process may have already exited.
          }
          return;
        }
        const pid = child.pid;
        try {
          if (pid !== undefined) process.kill(-pid, 'SIGTERM');
          else child.kill('SIGTERM');
        } catch {
          try { child.kill('SIGTERM'); } catch {}
        }
        if (killTimer === undefined) {
          killTimer = setTimeout(() => {
            if (exited) return;
            try {
              if (pid !== undefined) process.kill(-pid, 'SIGKILL');
              else child.kill('SIGKILL');
            } catch {
              try { child.kill('SIGKILL'); } catch {}
            }
          }, spec.graceMs);
          killTimer.unref();
        }
      };

      const onAbort = (): void => {
        terminateProcessTree();
      };
      spec.signal?.addEventListener('abort', onAbort, { once: true });

      const done = new Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>(
        (resolveDone, rejectDone) => {
          let settled = false;
          const cleanup = (): void => {
            exited = true;
            if (killTimer !== undefined) {
              clearTimeout(killTimer);
              killTimer = undefined;
            }
            spec.signal?.removeEventListener('abort', onAbort);
          };
          child.once('error', (err) => {
            cleanup();
            if (!settled) {
              settled = true;
              rejectDone(err);
            }
          });
          child.once('close', (code, sig) => {
            cleanup();
            if (!settled) {
              settled = true;
              resolveDone({ exitCode: code, signal: sig });
            }
          });
          child.once('exit', (code, sig) => {
            exited = true;
            const drainTimer = setTimeout(() => {
              if (settled) return;
              cleanup();
              settled = true;
              try { child.stdout?.destroy(); } catch {}
              try { child.stderr?.destroy(); } catch {}
              resolveDone({ exitCode: code, signal: sig });
            }, Math.min(spec.graceMs, 250));
            drainTimer.unref();
          });
        },
      );

      const exposedStdin: Writable | undefined = spec.stdio.stdin === 'pipe' ? child.stdin ?? undefined : undefined;
      const exposedStdout: Readable | undefined = spec.stdio.stdout === 'pipe' ? child.stdout ?? undefined : undefined;
      const exposedStderr: Readable | undefined = spec.stdio.stderr === 'pipe' ? child.stderr ?? undefined : undefined;

      return {
        pid: child.pid,
        stdin: exposedStdin,
        stdout: exposedStdout,
        stderr: exposedStderr,
        collected: {
          ...(stdoutCollector === undefined ? {} : { stdout: stdoutCollector }),
          ...(stderrCollector === undefined ? {} : { stderr: stderrCollector }),
        },
        done,
        terminate() {
          terminateProcessTree();
        },
        async waitForExit(waitSignal?: AbortSignal): Promise<boolean> {
          if (exited) return true;
          if (waitSignal?.aborted) return false;
          const waitPromise = done.then(() => true, () => true);
          if (waitSignal === undefined) return waitPromise;
          return new Promise<boolean>((resolveWait) => {
            const onWaitAbort = (): void => {
              resolveWait(false);
            };
            waitSignal.addEventListener('abort', onWaitAbort, { once: true });
            void waitPromise.then((val) => {
              waitSignal.removeEventListener('abort', onWaitAbort);
              resolveWait(val);
            });
          });
        },
      };
    },
  };
}

export class InMemorySettingsService extends Service {
  private readonly store = new Map<string, { value: Record<string, unknown>; revision: number }>();

  constructor(ctx: Context, initial: Readonly<Record<string, Record<string, unknown>>> = {}) {
    super(ctx, 'settings');
    for (const [ns, val] of Object.entries(initial)) {
      this.store.set(ns, { value: structuredClone(val), revision: 0 });
    }
  }

  get writable(): boolean {
    return true;
  }

  describe(): Array<{ ns: string; value: Record<string, unknown>; revision: number; applies: 'live'; autoGenerate: boolean }> {
    return [...this.store.entries()].map(([ns, entry]) => ({
      ns,
      value: structuredClone(entry.value),
      revision: entry.revision,
      applies: 'live' as const,
      autoGenerate: true,
    }));
  }

  getSection(ns: string): Readonly<Record<string, unknown>> | undefined {
    const found = this.store.get(ns);
    return found === undefined ? undefined : structuredClone(found.value);
  }

  async update(ns: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<void> {
    const current = this.store.get(ns) ?? { value: {}, revision: 0 };
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new Error(`settings namespace "${ns}" revision mismatch (expected ${expectedRevision}, actual ${current.revision})`);
    }
    const nextValue = { ...current.value, ...structuredClone(patch) };
    const nextRevision = current.revision + 1;
    this.store.set(ns, { value: nextValue, revision: nextRevision });
    (this.ctx as any).emit('settings/document-updated', ns, nextRevision);
  }

  configure(): () => void {
    return () => {};
  }
}

export function createNodeHostPorts(options: {
  readonly workspaceRoot?: string | ((agent: object) => string | undefined | Promise<string | undefined>);
  readonly credentials?: Readonly<Record<string, string>> | ((ref: string) => Promise<string | undefined>);
  readonly modelModalities?: Readonly<Record<string, readonly string[]>>;
  readonly storageDir?: string;
} = {}): DshHostPorts {
  const defaultWorkspace = options.workspaceRoot === undefined
    ? process.cwd()
    : typeof options.workspaceRoot === 'string'
      ? options.workspaceRoot
      : undefined;
  const fsPort = createNodeFileSystemPort(defaultWorkspace ?? process.cwd());
  const subprocessPort = createNodeSubprocessPort();

  const credentialsPort: DshCredentialsPort = {
    async resolve(ref: string) {
      if (typeof options.credentials === 'function') {
        const val = await options.credentials(ref);
        return val && val.length > 0 ? { value: val, source: 'host-secret' } : undefined;
      }
      if (options.credentials && typeof options.credentials[ref] === 'string' && options.credentials[ref].length > 0) {
        return { value: options.credentials[ref], source: 'host-config' };
      }
      const envVal = process.env[ref];
      return envVal && envVal.length > 0 ? { value: envVal, source: 'env' } : undefined;
    },
  };

  const llmPort: DshLlmPort = {
    async resolveModelInfo(provider, model, signal) {
      signal?.throwIfAborted();
      const key = `${provider}/${model}`;
      const configured = options.modelModalities?.[key] ?? options.modelModalities?.[model];
      return {
        inputModalities: configured ?? ['text', 'image'],
      };
    },
  };

  return {
    workingDirectory: {
      async ensure(agent, signal) {
        signal?.throwIfAborted();
        if (typeof options.workspaceRoot === 'function') {
          return options.workspaceRoot(agent);
        }
        return options.workspaceRoot ?? process.cwd();
      },
    },
    fs: fsPort,
    subprocess: subprocessPort,
    llm: llmPort,
    credentials: credentialsPort,
    storageDomain: {
      async open(name: string) {
        const dir = options.storageDir ?? join(tmpdir(), 'dsh-compat-domains', name.replaceAll(/[^a-zA-Z0-9_-]/g, '_'));
        await mkdir(dir, { recursive: true });
        return {
          async close() {
            return;
          },
        };
      },
    },
  };
}

export { lstat, mkdir, readdir, readFile, rename, rm, writeFile };
