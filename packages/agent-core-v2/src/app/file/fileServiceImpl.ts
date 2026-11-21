import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { LifecycleScope } from '#/app/scopes';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBlobStore } from '#/persistence/interface/blobStore';
import {
  IFileService,
  fileNotFoundError,
  isFileId,
  type FileMeta,
  type FileReadRange,
  type GetResult,
  type SaveOptions,
} from './fileService';

const BLOB_SCOPE = 'files';
const INDEX_SCOPE = 'file';
const INDEX_KEY = 'index.json';
const CORRUPT_INDEX_KEY_PREFIX = 'index.corrupt-';
const RECOVERED_MEDIA_TYPE = 'application/octet-stream';
const GC_BATCH_SIZE = 32;
const GC_RETRY_DELAY_MS = 100;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface IndexFile {
  readonly version: 1;
  readonly files: FileMeta[];
}

interface GcYield {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: () => void;
}

function isFileMeta(value: unknown): value is FileMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta['id'] === 'string' &&
    isFileId(meta['id']) &&
    typeof meta['name'] === 'string' &&
    typeof meta['media_type'] === 'string' &&
    typeof meta['size'] === 'number' &&
    Number.isSafeInteger(meta['size']) &&
    meta['size'] >= 0 &&
    typeof meta['created_at'] === 'string' &&
    (meta['expires_at'] === undefined || typeof meta['expires_at'] === 'string') &&
    (meta['session_id'] === undefined || typeof meta['session_id'] === 'string')
  );
}

export class FileServiceImpl extends Disposable implements IFileService {
  declare readonly _serviceBrand: undefined;

  private indexCache: Map<string, FileMeta> | undefined;
  private indexLoadPromise: Promise<void> | undefined;
  private indexWritePromise: Promise<void> = Promise.resolve();
  private readonly metaRevisions = new Map<string, number>();
  private metaRevision = 0;
  private readonly gcPending = new Set<string>();
  private gcScanRequested = false;
  private gcTimer: ReturnType<typeof setTimeout> | undefined;
  private gcYield: GcYield | undefined;
  private gcFlight: Promise<void> | undefined;
  private disposePromise: Promise<void> | undefined;
  private disposed = false;

  constructor(
    @IBlobStore private readonly blobs: IBlobStore,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }

  async save(source: Readable, filename: string, options?: SaveOptions): Promise<FileMeta>;
  async save(source: Readable, filename: string, options: () => SaveOptions): Promise<FileMeta>;
  async save(
    source: Readable,
    filename: string,
    options: SaveOptions | (() => SaveOptions) = {},
  ): Promise<FileMeta> {
    await this.ensureIndex();
    this.requestGc();

    const id = `f_${randomUUID()}`;
    let size = 0;
    const SMALL_UPLOAD_BUFFER_LIMIT = 4 * 1024 * 1024;
    let saveOptions: SaveOptions;
    try {
      const bufferedChunks: Buffer[] = [];
      let streamed = false;
      const iterator = source[Symbol.asyncIterator]();
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        const buf = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as string);
        size += buf.length;
        bufferedChunks.push(buf);
        if (size > SMALL_UPLOAD_BUFFER_LIMIT) {
          streamed = true;
          const remaining = async function* (): AsyncIterable<Uint8Array> {
            for (const chunk of bufferedChunks) yield chunk;
            bufferedChunks.length = 0;
            while (true) {
              const more = await iterator.next();
              if (more.done) break;
              const moreBuf = Buffer.isBuffer(more.value) ? more.value : Buffer.from(more.value as string);
              size += moreBuf.length;
              yield moreBuf;
            }
          };
          await this.blobs.putStream(BLOB_SCOPE, id, remaining());
          break;
        }
      }
      if (!streamed) {
        const payload = bufferedChunks.length === 0
          ? Buffer.alloc(0)
          : bufferedChunks.length === 1
            ? bufferedChunks[0]!
            : Buffer.concat(bufferedChunks, size);
        saveOptions = typeof options === 'function' ? options() : options;
        const now = Date.now();
        const meta: FileMeta = {
          id,
          name: saveOptions.name ?? filename,
          media_type: saveOptions.mimeType ?? 'application/octet-stream',
          size,
          created_at: new Date(now).toISOString(),
          expires_at:
            saveOptions.expiresInSec === undefined
              ? undefined
              : new Date(now + saveOptions.expiresInSec * 1000).toISOString(),
          session_id: saveOptions.sessionId,
        };
        this.setMeta(meta);
        try {
          await Promise.all([
            this.blobs.put(BLOB_SCOPE, id, payload),
            this.writeIndex(),
          ]);
        } catch (error) {
          if (this.indexCache?.get(id) === meta) {
            this.deleteMeta(id);
            await this.writeIndex().catch(() => undefined);
          }
          await this.blobs.delete(BLOB_SCOPE, id).catch(() => undefined);
          throw error;
        }
        return meta;
      }
      saveOptions = typeof options === 'function' ? options() : options;
    } catch (error) {
      await this.blobs.delete(BLOB_SCOPE, id).catch(() => undefined);
      throw error;
    }

    const now = Date.now();
    const meta: FileMeta = {
      id,
      name: saveOptions.name ?? filename,
      media_type: saveOptions.mimeType ?? 'application/octet-stream',
      size,
      created_at: new Date(now).toISOString(),
      expires_at:
        saveOptions.expiresInSec === undefined
          ? undefined
          : new Date(now + saveOptions.expiresInSec * 1000).toISOString(),
      session_id: saveOptions.sessionId,
    };

    this.setMeta(meta);
    await this.writeIndex();
    return meta;
  }

  async get(fileId: string): Promise<GetResult> {
    if (!isFileId(fileId)) {
      throw fileNotFoundError(fileId);
    }
    await this.ensureIndex();
    const meta = this.indexCache!.get(fileId);
    if (meta === undefined) {
      throw fileNotFoundError(fileId);
    }
    if (this.isExpired(meta)) {
      this.requestGc(fileId);
      throw fileNotFoundError(fileId);
    }

    const present = await this.blobs.has(BLOB_SCOPE, fileId);
    if (!present) {
      if (this.indexCache!.get(fileId) === meta) this.deleteMeta(fileId);
      await this.writeIndex();
      throw fileNotFoundError(fileId);
    }

    return {
      meta,
      stream: (range?: FileReadRange) =>
        Readable.from(this.blobs.getStream(BLOB_SCOPE, fileId, range)),
    };
  }

  async delete(fileId: string): Promise<void> {
    if (!isFileId(fileId)) {
      throw fileNotFoundError(fileId);
    }
    await this.ensureIndex();
    const meta = this.indexCache!.get(fileId);
    if (meta === undefined) {
      throw fileNotFoundError(fileId);
    }
    try {
      await this.blobs.delete(BLOB_SCOPE, fileId);
    } catch (error) {
      if (this.isExpired(meta)) this.requestGc(fileId);
      throw error;
    }
    if (this.indexCache!.get(fileId) === meta) this.deleteMeta(fileId);
    await this.writeIndex();
  }

  override dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.disposed = true;
    if (this.gcTimer !== undefined) {
      clearTimeout(this.gcTimer);
      this.gcTimer = undefined;
    }
    if (this.gcYield !== undefined) {
      const pending = this.gcYield;
      this.gcYield = undefined;
      clearTimeout(pending.timer);
      pending.resolve();
    }
    const gcFlight = this.gcFlight;
    this.disposePromise = (async () => {
      await gcFlight;
      await super.dispose();
    })();
    return this.disposePromise;
  }

  private ensureIndex(): Promise<void> {
    if (this.indexCache !== undefined) return Promise.resolve();
    if (this.indexLoadPromise !== undefined) return this.indexLoadPromise;
    this.indexLoadPromise = this.loadIndex().finally(() => {
      this.indexLoadPromise = undefined;
    });
    return this.indexLoadPromise;
  }

  private async loadIndex(): Promise<void> {
    const raw = await this.blobs.get(INDEX_SCOPE, INDEX_KEY);
    if (raw === undefined) {
      this.setIndex(new Map());
      this.requestGc();
      return;
    }
    const parsed = this.parseIndex(raw);
    if (parsed !== undefined) {
      this.setIndex(parsed);
      this.requestGc();
      return;
    }
    const backupKey = `${CORRUPT_INDEX_KEY_PREFIX}${Date.now()}-${randomUUID()}.json`;
    await this.blobs.put(INDEX_SCOPE, backupKey, raw);
    const recovered = await this.recoverIndexFromBlobs();
    this.setIndex(recovered);
    this.log.warn('file index is corrupt; backed up and rebuilt from stored blobs', {
      scope: INDEX_SCOPE,
      backupKey,
      recoveredCount: recovered.size,
    });
    await this.writeIndex().catch((error: unknown) => {
      this.log.warn('failed to persist rebuilt file index', { error });
    });
    this.requestGc();
  }

  private parseIndex(raw: Uint8Array): Map<string, FileMeta> | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(textDecoder.decode(raw));
    } catch {
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Partial<IndexFile>).files)) {
      return undefined;
    }
    const map = new Map<string, FileMeta>();
    for (const f of (parsed as IndexFile).files) {
      if (isFileMeta(f)) map.set(f.id, f);
    }
    return map;
  }

  private async recoverIndexFromBlobs(): Promise<Map<string, FileMeta>> {
    const map = new Map<string, FileMeta>();
    const createdAt = new Date().toISOString();
    for (const id of await this.blobs.list(BLOB_SCOPE)) {
      if (!isFileId(id)) continue;
      const size = await this.blobSize(id);
      if (size === undefined) continue;
      map.set(id, { id, name: id, media_type: RECOVERED_MEDIA_TYPE, size, created_at: createdAt });
    }
    return map;
  }

  private async blobSize(id: string): Promise<number | undefined> {
    if (this.blobs.size !== undefined) return this.blobs.size(BLOB_SCOPE, id);
    return (await this.blobs.get(BLOB_SCOPE, id))?.byteLength;
  }

  private setIndex(map: Map<string, FileMeta>): void {
    this.indexCache = map;
    this.metaRevisions.clear();
    for (const meta of map.values()) this.metaRevisions.set(meta.id, ++this.metaRevision);
  }

  private setMeta(meta: FileMeta): void {
    this.indexCache!.set(meta.id, meta);
    this.metaRevisions.set(meta.id, ++this.metaRevision);
  }

  private deleteMeta(fileId: string): number {
    this.indexCache!.delete(fileId);
    const revision = ++this.metaRevision;
    this.metaRevisions.set(fileId, revision);
    return revision;
  }

  private isExpired(meta: FileMeta): boolean {
    return meta.expires_at !== undefined && Date.parse(meta.expires_at) <= Date.now();
  }

  private requestGc(fileId?: string): void {
    if (this.disposed) return;
    if (fileId === undefined) this.gcScanRequested = true;
    else this.gcPending.add(fileId);
    if (this.gcFlight === undefined && this.gcTimer === undefined) this.scheduleGc(0);
  }

  private scheduleGc(delay: number): void {
    if (this.disposed || this.gcFlight !== undefined || this.gcTimer !== undefined) return;
    this.gcTimer = setTimeout(() => {
      this.gcTimer = undefined;
      if (this.disposed || this.gcFlight !== undefined) return;
      const flight = this.runGcRound();
      this.gcFlight = flight;
      void flight.catch(() => undefined).finally(() => {
        if (this.gcFlight !== flight) return;
        this.gcFlight = undefined;
        if (!this.disposed && (this.gcScanRequested || this.gcPending.size > 0)) {
          this.scheduleGc(GC_RETRY_DELAY_MS);
        }
      });
    }, delay);
    this.gcTimer.unref?.();
  }

  private async runGcRound(): Promise<void> {
    const cache = this.indexCache;
    if (cache === undefined) return;
    if (this.gcScanRequested) {
      this.gcScanRequested = false;
      for (const meta of cache.values()) {
        if (this.isExpired(meta)) this.gcPending.add(meta.id);
      }
    }

    const budget = this.gcPending.size;
    let processed = 0;
    while (!this.disposed && processed < budget) {
      const batch: Array<{ readonly meta: FileMeta; readonly revision: number }> = [];
      while (batch.length < GC_BATCH_SIZE && processed < budget) {
        const fileId = this.gcPending.values().next().value;
        if (fileId === undefined) break;
        this.gcPending.delete(fileId);
        processed += 1;
        const meta = cache.get(fileId);
        if (meta !== undefined && this.isExpired(meta)) {
          batch.push({ meta, revision: this.metaRevisions.get(fileId) ?? 0 });
        }
      }
      if (batch.length === 0) continue;

      const removed: Array<{ readonly meta: FileMeta; readonly revision: number }> = [];
      for (const item of batch) {
        if (this.disposed) {
          this.gcPending.add(item.meta.id);
          continue;
        }
        try {
          await this.blobs.delete(BLOB_SCOPE, item.meta.id);
        } catch {
          this.gcPending.add(item.meta.id);
          continue;
        }
        const current = cache.get(item.meta.id);
        if (current === item.meta && this.metaRevisions.get(item.meta.id) === item.revision) {
          removed.push({ meta: item.meta, revision: this.deleteMeta(item.meta.id) });
        } else if (current !== undefined && this.isExpired(current)) {
          this.gcPending.add(item.meta.id);
        }
      }
      if (removed.length > 0) {
        try {
          await this.writeIndex();
        } catch {
          let restored = false;
          for (const item of removed) {
            if (cache.get(item.meta.id) === undefined && this.metaRevisions.get(item.meta.id) === item.revision) {
              this.setMeta(item.meta);
              this.gcPending.add(item.meta.id);
              restored = true;
            }
          }
          if (restored) await this.writeIndex().catch(() => undefined);
        }
      }
      if (!this.disposed && processed < budget) await this.yieldBetweenGcBatches();
    }
  }

  private yieldBetweenGcBatches(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.gcYield?.timer === timer) this.gcYield = undefined;
        resolve();
      }, 0);
      timer.unref?.();
      this.gcYield = { timer, resolve };
    });
  }

  private async writeIndex(): Promise<void> {
    const write = this.indexWritePromise.catch(() => undefined).then(async () => {
      const cache = this.indexCache;
      if (cache === undefined) return;
      const payload: IndexFile = { version: 1, files: Array.from(cache.values()) };
      await this.blobs.put(INDEX_SCOPE, INDEX_KEY, textEncoder.encode(JSON.stringify(payload)));
    });
    this.indexWritePromise = write;
    await write;
  }
}

registerScopedService(
  LifecycleScope.App,
  IFileService,
  FileServiceImpl,
  ScopeActivation.OnScopeCreated,
  'file',
);
