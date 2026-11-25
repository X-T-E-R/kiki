import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentPart } from '#/kosong/contract/message';
import { LifecycleScope } from '#/app/scopes';
import { ref, type LiveRef } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  HOSTREF_PROTOCOL,
  HostPinnedUnsupportedError,
  registerHostPinnedRef as registerSessionHostPinnedRef,
  type HostPinnedRefRecord,
} from '#/agent/media/hostPinnedMedia';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IContentAddressedStore } from '#/persistence/interface/contentAddressedStore';
import { StorageError, StorageErrors, toStorageIoError } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  BLOBREF_PROTOCOL,
  CheckpointBlobMissingError,
  IAgentBlobService,
  MISSING_MEDIA_PLACEHOLDER,
  type AgentBlobOffloadOptions,
  type AgentHostPinnedInput,
} from './agentBlobService';
import { parseMediaBlobRef } from '#/agent/media/mediaRef';
import { ByteLruCache } from './byteLruCache';

const DEFAULT_THRESHOLD = 4096;
const DEFAULT_MAX_CACHE_SIZE = 50 * 1024 * 1024;
const MAX_SINGLE_CACHEABLE_BLOB_BYTES = 4 * 1024 * 1024;
const LARGE_ENOSPC_FAIL_BASE64_CHARS = 256 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;
const DATA_URI_HEADER_RE = /^data:([^;]+);base64,/;

interface RememberedOffload {
  readonly part: ContentPart;
  readonly hashes: readonly string[];
}

export class AgentBlobServiceImpl implements IAgentBlobService {
  declare readonly _serviceBrand: undefined;

  private readonly storageScope: string;
  private readonly agentId: string;
  private readonly cache = new ByteLruCache(DEFAULT_MAX_CACHE_SIZE);
  private readonly offloadedPartRefs = new WeakMap<ContentPart, RememberedOffload>();

  constructor(
    @IBlobStore private readonly blobs: IBlobStore,
    @IAgentScopeContext agentCtx: IAgentScopeContext,
    @ref(IContentAddressedStore) private readonly casRef?: LiveRef<IContentAddressedStore>,
    @ref(ISessionContext) private readonly sessionRef?: LiveRef<ISessionContext>,
    @ref(IAtomicDocumentStore) private readonly documentsRef?: LiveRef<IAtomicDocumentStore>,
  ) {
    this.storageScope = agentCtx.scope('blobs');
    this.agentId = agentCtx.agentId;
  }

  protected get threshold(): number {
    return DEFAULT_THRESHOLD;
  }

  isBlobRef(url: string): boolean {
    return url.startsWith(BLOBREF_PROTOCOL);
  }

  async offloadBytes(
    mimeType: string,
    data: Uint8Array,
    options?: AgentBlobOffloadOptions,
  ): Promise<string> {
    options?.signal?.throwIfAborted();
    const cas = this.sharedCasIfAllowed();
    if (cas !== undefined) {
      const stored = await cas.putBytes(data, { signal: options?.signal });
      await cas.linkAlias(stored.sha256, this.storageScope, stored.sha256, { signal: options?.signal });
      if (data.byteLength <= MAX_SINGLE_CACHEABLE_BLOB_BYTES) {
        this.cache.set(stored.sha256, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      }
      return formatBlobRef(mimeType, stored.sha256);
    }
    const hash = createHash('sha256').update(data).digest('hex');
    const exists = await this.blobs.has(this.storageScope, hash).catch(() => false);
    if (!exists) {
      await this.blobs.put(this.storageScope, hash, data);
    }
    if (data.byteLength <= MAX_SINGLE_CACHEABLE_BLOB_BYTES) {
      this.cache.set(hash, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    }
    return formatBlobRef(mimeType, hash);
  }

  async offloadStream(
    mimeType: string,
    source: AsyncIterable<Uint8Array>,
    options?: AgentBlobOffloadOptions,
  ): Promise<string> {
    options?.signal?.throwIfAborted();
    const cas = this.sharedCasIfAllowed();
    if (cas !== undefined) {
      const stored = await cas.putStream(source, { signal: options?.signal });
      await cas.linkAlias(stored.sha256, this.storageScope, stored.sha256, { signal: options?.signal });
      return formatBlobRef(mimeType, stored.sha256);
    }
    const chunks: Uint8Array[] = [];
    const hash = createHash('sha256');
    let total = 0;
    for await (const chunk of source) {
      options?.signal?.throwIfAborted();
      chunks.push(chunk);
      hash.update(chunk);
      total += chunk.byteLength;
    }
    const digest = hash.digest('hex');
    const exists = await this.blobs.has(this.storageScope, digest).catch(() => false);
    if (!exists) {
      const binary = chunks.length === 0
        ? new Uint8Array(0)
        : chunks.length === 1
          ? chunks[0]!
          : Buffer.concat(chunks, total);
      await this.blobs.put(this.storageScope, digest, binary);
    }
    return formatBlobRef(mimeType, digest);
  }

  async offloadFile(
    mimeType: string,
    sourcePath: string,
    options?: AgentBlobOffloadOptions,
  ): Promise<string> {
    options?.signal?.throwIfAborted();
    const cas = this.sharedCasIfAllowed();
    if (cas !== undefined) {
      const stored = await cas.putFromFile(sourcePath, { signal: options?.signal });
      await cas.linkAlias(stored.sha256, this.storageScope, stored.sha256, { signal: options?.signal });
      return formatBlobRef(mimeType, stored.sha256);
    }
    const staged = await stageLocalFileSnapshot(sourcePath, options?.signal);
    try {
      const exists = await this.blobs.has(this.storageScope, staged.digest).catch(() => false);
      if (!exists) {
        const stream = createReadStream(staged.tempPath, {
          highWaterMark: STREAM_CHUNK_BYTES,
          signal: options?.signal,
        });
        try {
          await this.blobs.putStream(this.storageScope, staged.digest, stream as AsyncIterable<Uint8Array>);
        } finally {
          stream.destroy();
        }
      }
      return formatBlobRef(mimeType, staged.digest);
    } finally {
      await unlink(staged.tempPath).catch(() => undefined);
    }
  }

  async registerHostPinnedRef(input: AgentHostPinnedInput): Promise<HostPinnedRefRecord> {
    const session = this.sessionRef?.current;
    const documents = this.documentsRef?.current;
    if (session === undefined || documents === undefined) {
      throw new HostPinnedUnsupportedError('Host-pinned media references require a persistent session scope.');
    }
    return registerSessionHostPinnedRef(documents, {
      sessionScope: session.scope(),
      sessionId: session.sessionId,
      agentId: this.agentId,
      path: input.path,
      mimeType: input.mimeType,
      allowedRoots: input.allowedRoots,
      signal: input.signal,
    });
  }

  async offloadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]> {
    let changed = false;
    const out: ContentPart[] = [];
    for (const part of parts) {
      const next = await this.offloadContentPart(part);
      if (next !== part) changed = true;
      out.push(next);
    }
    return changed ? out : parts;
  }

  async loadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]> {
    return this.loadPartsInternal(parts, false);
  }

  async loadPartsStrict(parts: readonly ContentPart[]): Promise<readonly ContentPart[]> {
    return this.loadPartsInternal(parts, true);
  }

  private sharedCasIfAllowed(): IContentAddressedStore | undefined {
    const cas = this.casRef?.current;
    if (cas === undefined) return undefined;
    const session = this.sessionRef?.current;
    if (session === undefined) return undefined;
    if (session.ephemeral !== false) return undefined;
    if (typeof session.isPrivate !== 'function' || session.isPrivate() !== false) return undefined;
    return cas;
  }

  private async loadPartsInternal(parts: readonly ContentPart[], strict: boolean): Promise<readonly ContentPart[]> {
    let changed = false;
    const out: ContentPart[] = [];
    for (const part of parts) {
      const next = await this.loadContentPart(part, strict);
      if (next !== part) changed = true;
      out.push(next);
    }
    return changed ? out : parts;
  }

  private async offloadContentPart(part: ContentPart): Promise<ContentPart> {
    const remembered = this.offloadedPartRefs.get(part);
    if (remembered !== undefined && await this.hasAllBlobs(remembered.hashes)) {
      return remembered.part;
    }
    const hashes: string[] = [];
    const next = await this.rewriteMediaUrls(part, async (url) => {
      const rewritten = await this.maybeOffloadString(url);
      if (this.isBlobRef(rewritten)) {
        const parsed = parseBlobRef(rewritten);
        if (parsed !== undefined) hashes.push(parsed.hash);
      }
      return rewritten;
    });
    if (next !== part && hashes.length > 0) {
      this.offloadedPartRefs.set(part, { part: next, hashes });
    }
    return next;
  }

  private async loadContentPart(part: ContentPart, strict: boolean): Promise<ContentPart> {
    const hashes: string[] = [];
    let allResolved = true;
    const next = await this.rewriteMediaUrls(part, async (url) => {
      if (!this.isBlobRef(url)) return url;
      const parsed = parseBlobRef(url);
      if (parsed === undefined) {
        allResolved = false;
        if (strict) throw new CheckpointBlobMissingError(url);
        return MISSING_MEDIA_PLACEHOLDER;
      }
      const loaded = await this.loadBlobRefUrl(parsed);
      if (loaded === undefined) {
        allResolved = false;
        if (strict) throw new CheckpointBlobMissingError(url);
        return MISSING_MEDIA_PLACEHOLDER;
      }
      hashes.push(parsed.hash);
      return loaded;
    });
    if (next !== part && allResolved && hashes.length > 0) {
      this.offloadedPartRefs.set(next, { part, hashes });
    }
    return next;
  }

  private async hasAllBlobs(hashes: readonly string[]): Promise<boolean> {
    for (const hash of hashes) {
      const present = await this.blobs.has(this.storageScope, hash).catch(() => false);
      if (!present) {
        this.cache.delete?.(hash);
        return false;
      }
    }
    return true;
  }

  private async rewriteMediaUrls(
    part: ContentPart,
    transformUrl: (url: string) => Promise<string>,
  ): Promise<ContentPart> {
    let updated: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(part)) {
      const mediaObj = asMediaContainer(value);
      if (mediaObj === undefined) continue;

      const url = mediaObj.url;
      if (typeof url !== 'string') continue;

      const newUrl = await transformUrl(url);
      if (newUrl === url) continue;

      if (updated === undefined) updated = { ...part };
      updated[key] = { ...(value as object), url: newUrl };
    }
    return updated === undefined ? part : (updated as unknown as ContentPart);
  }

  private async loadBlobRefUrl(ref: { readonly mimeType: string; readonly hash: string }): Promise<string | undefined> {
    const payload = await this.readBlob(ref.hash);
    if (payload === undefined) return undefined;

    return formatDataUri(ref.mimeType, payload);
  }

  private async readBlob(hash: string): Promise<Buffer | undefined> {
    const cached = this.cache.get(hash);
    if (cached !== undefined) {
      let exists: boolean;
      try {
        exists = await this.blobs.has(this.storageScope, hash);
      } catch (error) {
        if (isBlobNotFoundError(error)) {
          exists = false;
        } else {
          throw error;
        }
      }
      if (exists) return cached;
      this.cache.delete?.(hash);
      return undefined;
    }

    let payload: Uint8Array | undefined;
    try {
      payload = await this.blobs.get(this.storageScope, hash);
    } catch (error) {
      if (isBlobNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
    if (payload === undefined) return undefined;

    const buffer = Buffer.from(payload);
    if (buffer.byteLength <= MAX_SINGLE_CACHEABLE_BLOB_BYTES) {
      this.cache.set(hash, buffer);
    }
    return buffer;
  }

  private async maybeOffloadString(value: string): Promise<string> {
    if (this.isBlobRef(value) || value.startsWith(HOSTREF_PROTOCOL)) return value;

    const match = DATA_URI_HEADER_RE.exec(value);
    if (match === null) return value;

    const mimeType = match[1]!;
    const payload = value.slice(match[0].length);
    if (payload.length < this.threshold) return value;

    try {
      return await this.writeBlob(mimeType, payload);
    } catch (error) {
      if (isDiskFullError(error) && payload.length <= LARGE_ENOSPC_FAIL_BASE64_CHARS) {
        return value;
      }
      throw error;
    }
  }

  private async writeBlob(mimeType: string, base64Payload: string): Promise<string> {
    const binary = Buffer.from(base64Payload, 'base64');
    return this.offloadBytes(mimeType, binary);
  }
}

async function stageLocalFileSnapshot(
  filePath: string,
  signal?: AbortSignal,
): Promise<{ readonly tempPath: string; readonly digest: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal?.throwIfAborted();
    let before;
    try {
      before = await stat(filePath, { bigint: true });
    } catch (error) {
      throw toStorageIoError(error, { path: filePath, op: 'stat' });
    }
    if (!before.isFile()) {
      throw new StorageError(StorageErrors.codes.STORAGE_NOT_FOUND, `source path is not a regular file: ${filePath}`);
    }
    const tempPath = join(tmpdir(), `kiki-agent-blob-${process.pid}-${randomUUID()}.tmp`);
    const hash = createHash('sha256');
    let bytes = 0n;
    const srcHandle = await open(filePath, 'r');
    let dstHandle;
    try {
      dstHandle = await open(tempPath, 'wx', 0o600);
      const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await srcHandle.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        const slice = buffer.subarray(0, bytesRead);
        let offset = 0;
        while (offset < slice.byteLength) {
          const { bytesWritten } = await dstHandle.write(slice, offset, slice.byteLength - offset);
          if (bytesWritten <= 0) {
            throw new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'short write staging private blob');
          }
          offset += bytesWritten;
        }
        hash.update(slice);
        bytes += BigInt(bytesRead);
      }
      await dstHandle.close();
      dstHandle = undefined;
      await srcHandle.close();
    } catch (error) {
      await srcHandle.close().catch(() => undefined);
      if (dstHandle !== undefined) await dstHandle.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
    const after = await stat(filePath, { bigint: true }).catch(() => undefined);
    if (
      after !== undefined &&
      after.isFile() &&
      before.size === after.size &&
      before.mtimeNs === after.mtimeNs &&
      before.ctimeNs === after.ctimeNs &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      bytes === after.size
    ) {
      return { tempPath, digest: hash.digest('hex') };
    }
    await unlink(tempPath).catch(() => undefined);
  }
  throw new StorageError(
    StorageErrors.codes.STORAGE_IO_FAILED,
    `source file changed concurrently while archiving: ${filePath}`,
    { details: { path: filePath } },
  );
}

function isDiskFullError(error: unknown): boolean {
  if (error instanceof StorageError && error.code === StorageErrors.codes.STORAGE_DISK_FULL) {
    return true;
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOSPC'
  );
}

function isBlobNotFoundError(error: unknown): boolean {
  if (error instanceof StorageError && error.code === StorageErrors.codes.STORAGE_NOT_FOUND) {
    return true;
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function formatBlobRef(mimeType: string, hash: string): string {
  return `${BLOBREF_PROTOCOL}${mimeType};${hash}`;
}

function parseBlobRef(url: string): { mimeType: string; hash: string } | undefined {
  const ref = parseMediaBlobRef(url);
  return ref?.kind === 'mime' ? { mimeType: ref.mime, hash: ref.hash } : undefined;
}

function formatDataUri(mimeType: string, payload: Buffer): string {
  return `data:${mimeType};base64,${payload.toString('base64')}`;
}

function asMediaContainer(value: unknown): { url: unknown } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  return 'url' in obj ? (obj as { url: unknown }) : undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentBlobService,
  AgentBlobServiceImpl,
  ScopeActivation.OnScopeCreated,
  'agentBlob',
);
