import { extname, join } from 'node:path';
import { Readable } from 'node:stream';

import { ref, type LiveRef } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { isFileId } from '#/app/file/fileService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IContentAddressedStore } from '#/persistence/interface/contentAddressedStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { detectFileType, MEDIA_SNIFF_BYTES } from './file-type';
import {
  AUDIO_MIME_BY_SUFFIX,
  IMAGE_MIME_BY_SUFFIX,
  mediaExtensionForMime,
  parseAgentMediaBlobRef,
  VIDEO_MIME_BY_SUFFIX,
} from './mediaRef';
import {
  ISessionMediaStore,
  type SessionMediaFile,
  type SessionMediaMaterializeInput,
} from './sessionMediaStore';

const MEDIA_STREAM_CHUNK_BYTES = 64 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/u;

interface SessionMediaMetadata {
  readonly version: 1;
  readonly key: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sha256?: string;
}

const parseAgentBlobRef = parseAgentMediaBlobRef;

async function readHeadBytes(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total >= maxBytes) break;
  }
  const capped = Math.min(total, maxBytes);
  const out = new Uint8Array(capped);
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, capped - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= capped) break;
  }
  return out;
}

export class ScopedMediaStore implements ISessionMediaStore {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly scope: string,
    private readonly storage: IFileSystemStorageService,
    private readonly documents: IAtomicDocumentStore,
    private readonly blobs?: IBlobStore,
    private readonly sessionScope?: string,
    private readonly cas?: IContentAddressedStore,
    private readonly allowSharedCas: boolean | (() => boolean) = false,
  ) {}

  isSharedCasEnabled(): boolean {
    if (this.cas === undefined) return false;
    return typeof this.allowSharedCas === 'function' ? this.allowSharedCas() === true : this.allowSharedCas === true;
  }

  pathFor(fileId: string, ext: string): string | undefined {
    if (!isFileId(fileId)) return undefined;
    return this.storage.pathFor(this.scope, this.keyFor(fileId, ext));
  }

  async resolveDisplayPath(fileId: string): Promise<string | undefined> {
    if (parseAgentBlobRef(fileId) !== undefined) return undefined;
    if (!isFileId(fileId)) return undefined;
    const key = await this.findKey(fileId);
    if (key === undefined) return undefined;
    return this.storage.pathFor(this.scope, key);
  }

  async read(
    fileId: string,
  ): Promise<{ readonly data: Uint8Array; readonly name: string } | undefined> {
    const blob = await this.readAgentBlob(fileId);
    if (blob !== undefined) return blob;
    if (parseAgentBlobRef(fileId) !== undefined) return undefined;
    if (!isFileId(fileId)) return undefined;
    const key = await this.findKey(fileId);
    if (key === undefined) return undefined;
    const data = await this.storage.read(this.scope, key);
    return data === undefined ? undefined : { data, name: key };
  }

  async open(fileId: string, variant?: 'wav'): Promise<SessionMediaFile | undefined> {
    if (variant === 'wav') {
      if (!isFileId(fileId) || this.sessionScope === undefined) return undefined;
      const scope = `${this.sessionScope}/attachments`;
      const key = `${fileId}.wav`;
      const size = await this.storage.size(scope, key);
      if (size === undefined) return undefined;
      return {
        path: this.storage.pathFor(scope, key), name: key, mediaType: 'audio/wav', size,
        stream: (range) => this.storage.readStream(scope, key, range, { chunkBytes: MEDIA_STREAM_CHUNK_BYTES }),
      };
    }
    const blob = await this.openAgentBlob(fileId);
    if (blob !== undefined) return blob;
    if (parseAgentBlobRef(fileId) !== undefined) return undefined;
    if (!isFileId(fileId)) return undefined;
    const storedMetadata = await this.documents.get<unknown>(this.scope, this.metadataKey(fileId));
    const metadata = this.isMetadataFor(storedMetadata, fileId) ? storedMetadata : undefined;
    let key: string | undefined;
    let size: number | undefined;
    if (metadata !== undefined) {
      size = await this.storage.size(this.scope, metadata.key);
      if (size !== undefined) key = metadata.key;
    }
    if (key === undefined) {
      key = await this.findKey(fileId);
      if (key === undefined) return undefined;
      size = await this.storage.size(this.scope, key);
    }
    if (size === undefined) return undefined;
    return {
      path: this.storage.pathFor(this.scope, key),
      name: metadata?.name ?? key,
      mediaType: metadata?.mediaType ?? this.mediaTypeForKey(key),
      size,
      sha256: metadata?.sha256,
      stream: (range) => this.storage.readStream(this.scope, key, range, { chunkBytes: MEDIA_STREAM_CHUNK_BYTES }),
    };
  }

  async materialize(input: SessionMediaMaterializeInput): Promise<string | undefined> {
    if (!isFileId(input.fileId)) return undefined;
    const ext = extname(input.name) || (mediaExtensionForMime(input.mimeType) ?? '.bin');
    const key = this.keyFor(input.fileId, ext);
    let sha256: string | undefined;
    if (this.isSharedCasEnabled() && this.cas !== undefined) {
      const stored = input.data !== undefined
        ? await this.cas.putBytes(input.data, { signal: input.signal })
        : await this.cas.putStream(input.stream() as AsyncIterable<Uint8Array>, { signal: input.signal });
      sha256 = stored.sha256;
      await this.cas.linkAlias(stored.sha256, this.scope, key, { signal: input.signal });
    } else {
      const existingSize = await this.storage.size(this.scope, key);
      if (existingSize !== input.size) {
        const source = (input.data !== undefined ? Readable.from([input.data]) : input.stream()) as NodeJS.ReadableStream & AsyncIterable<Uint8Array>;
        await this.storage.writeStream(this.scope, key, source, {
          atomic: true,
          signal: input.signal,
        });
      }
    }
    await this.documents.set(this.scope, this.metadataKey(input.fileId), {
      version: 1,
      key,
      name: input.name,
      mediaType: input.mimeType,
      sha256,
    });
    return this.storage.pathFor(this.scope, key);
  }

  async linkAttachmentAlias(fileId: string, dir: string, targetName: string): Promise<string | undefined> {
    if (!this.isSharedCasEnabled() || this.cas === undefined || !isFileId(fileId)) return undefined;
    const storedMetadata = await this.documents.get<unknown>(this.scope, this.metadataKey(fileId));
    const metadata = this.isMetadataFor(storedMetadata, fileId) ? storedMetadata : undefined;
    if (metadata?.sha256 === undefined || !SHA256_RE.test(metadata.sha256)) return undefined;
    const targetPath = join(dir, targetName);
    await this.cas.linkAliasToPath(metadata.sha256, targetPath);
    return targetPath;
  }

  private async readAgentBlob(
    fileId: string,
  ): Promise<{ readonly data: Uint8Array; readonly name: string } | undefined> {
    const ref = parseAgentBlobRef(fileId);
    if (ref === undefined || this.blobs === undefined || this.sessionScope === undefined) return undefined;
    const data = await this.blobs.get(`${this.sessionScope}/agents/${ref.agentId}/blobs`, ref.hash);
    return data === undefined ? undefined : { data, name: fileId };
  }

  private async openAgentBlob(fileId: string): Promise<SessionMediaFile | undefined> {
    const ref = parseAgentBlobRef(fileId);
    if (ref === undefined || this.blobs === undefined || this.sessionScope === undefined) return undefined;
    const blobScope = `${this.sessionScope}/agents/${ref.agentId}/blobs`;
    if (this.blobs.size !== undefined) {
      const size = await this.blobs.size(blobScope, ref.hash);
      if (size === undefined || size <= 0) return undefined;
      const headEnd = Math.min(MEDIA_SNIFF_BYTES - 1, size - 1);
      const header = await readHeadBytes(this.blobs.getStream(blobScope, ref.hash, { start: 0, end: headEnd }), MEDIA_SNIFF_BYTES);
      const type = detectFileType(fileId, header, 'media');
      if (type.kind !== 'image' && type.kind !== 'video' && type.kind !== 'audio') return undefined;
      const blobs = this.blobs;
      return {
        path: undefined,
        name: fileId,
        mediaType: type.mimeType,
        size,
        stream: (range) => blobs.getStream(blobScope, ref.hash, range),
      };
    }
    const data = await this.blobs.get(blobScope, ref.hash);
    if (data === undefined) return undefined;
    const bytes = Buffer.from(data);
    const type = detectFileType(fileId, bytes.subarray(0, MEDIA_SNIFF_BYTES), 'media');
    if (type.kind !== 'image' && type.kind !== 'video' && type.kind !== 'audio') return undefined;
    return {
      path: undefined,
      name: fileId,
      mediaType: type.mimeType,
      size: bytes.length,
      stream: (range) => {
        const start = Math.max(0, range?.start ?? 0);
        const end = Math.min(bytes.length - 1, range?.end ?? bytes.length - 1);
        return (async function* () {
          if (start <= end) yield bytes.subarray(start, end + 1);
        })();
      },
    };
  }

  private keyFor(fileId: string, ext: string): string {
    return `${fileId}${ext}`;
  }

  private metadataKey(fileId: string): string {
    return `meta/${fileId}.json`;
  }

  private isMetadataFor(value: unknown, fileId: string): value is SessionMediaMetadata {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<SessionMediaMetadata>;
    return (
      candidate.version === 1 &&
      typeof candidate.key === 'string' &&
      (candidate.key === fileId || candidate.key.startsWith(`${fileId}.`)) &&
      !candidate.key.includes('/') &&
      !candidate.key.includes('\\') &&
      typeof candidate.name === 'string' &&
      candidate.name.length > 0 &&
      typeof candidate.mediaType === 'string' &&
      candidate.mediaType.length > 0 &&
      (candidate.sha256 === undefined || (typeof candidate.sha256 === 'string' && SHA256_RE.test(candidate.sha256)))
    );
  }

  private mediaTypeForKey(key: string): string {
    const ext = extname(key).toLowerCase();
    return (
      IMAGE_MIME_BY_SUFFIX[ext] ??
      VIDEO_MIME_BY_SUFFIX[ext] ??
      AUDIO_MIME_BY_SUFFIX[ext] ??
      'application/octet-stream'
    );
  }

  private async findKey(fileId: string): Promise<string | undefined> {
    const keys = await this.storage.list(this.scope, fileId);
    return keys.find(
      (key) =>
        key === fileId || (key.startsWith(`${fileId}.`) && !key.includes('.tmp.')),
    );
  }
}

export class SessionMediaStoreService extends ScopedMediaStore {
  constructor(
    @ISessionContext sessionContext: ISessionContext,
    @IFileSystemStorageService storage: IFileSystemStorageService,
    @IAtomicDocumentStore documents: IAtomicDocumentStore,
    @IBlobStore blobs: IBlobStore,
    @ref(IContentAddressedStore) casRef?: LiveRef<IContentAddressedStore>,
  ) {
    super(
      sessionContext.scope('media'),
      storage,
      documents,
      blobs,
      sessionContext.scope(),
      casRef?.current,
      () => sessionContext.ephemeral === false && typeof sessionContext.isPrivate === 'function' && sessionContext.isPrivate() === false,
    );
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMediaStore,
  SessionMediaStoreService,
  ScopeActivation.OnScopeCreated,
  'media',
);
