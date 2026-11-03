import { produce } from 'immer';

import { event2FromRecord } from '#/app/event/event2';
import { Error2, ErrorCodes } from '#/errors';
import { logicalByteSize } from '#/persistence/coldSegmentLog';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { StorageError, StorageErrors, type IFileSystemStorageService } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY, isWireRecord } from '#/wire/record';
import type { ContextRebuildControl } from './contextRebuild';
import { contextRebuildControlKey } from './contextRebuildOps';

const READ_BYTES = 8 << 20;
const CACHE_ENTRIES = 128;

export class PersistedContextRebuildReader {
  private readonly cache = new Map<string, {
    size: number;
    mtime: number | undefined;
    generation: string;
    bytes: number;
    control: ContextRebuildControl;
  }>();
  private cacheBytes = 0;
  private readonly folds = new Map([...contextRebuildControlKey.replayable.folds].map(([event, fold]) => [event.type, { event, fold }]));

  constructor(private readonly log: IAppendLogStore, private readonly storage: IFileSystemStorageService) {}

  async read(scope: string, signal?: AbortSignal): Promise<ContextRebuildControl> {
    signal?.throwIfAborted();
    await this.log.flush(scope, AGENT_WIRE_RECORD_KEY);
    const [size, mtime, generation] = await Promise.all([
      logicalByteSize(this.storage, scope, AGENT_WIRE_RECORD_KEY),
      this.storage.mtime(scope, AGENT_WIRE_RECORD_KEY),
      this.log.generation(scope, AGENT_WIRE_RECORD_KEY),
    ]);
    signal?.throwIfAborted();
    const cached = this.cache.get(scope);
    if (cached !== undefined && cached.size === (size ?? 0) && cached.mtime === mtime && cached.generation === generation) {
      this.cache.delete(scope);
      this.cache.set(scope, cached);
      return cached.control;
    }
    if ((size ?? 0) > READ_BYTES) {
      throw new Error2(ErrorCodes.SESSION_BUSY, 'Context rebuild control is unavailable for this inactive agent until an action restores it.');
    }
    let control = contextRebuildControlKey.initial();
    let readBytes = 0;
    for await (const record of this.log.read<unknown>(scope, AGENT_WIRE_RECORD_KEY, {
      signal,
      onRecordBytes: bytes => {
        readBytes += bytes;
        if (readBytes > READ_BYTES) throw new Error2(ErrorCodes.SESSION_BUSY, 'Context rebuild control exceeded its cold read budget.');
      },
    })) {
      signal?.throwIfAborted();
      if (!isWireRecord(record)) throw new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, 'Malformed context rebuild history record');
      const entry = this.folds.get(record.type);
      if (entry === undefined) continue;
      const event = event2FromRecord(entry.event, record);
      if (event === undefined) throw new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, 'Malformed context rebuild control event');
      control = produce(control, draft => {
        entry.fold(draft, event, {
          silent: true, emit() {}, checkpoint() {}, clearCheckpoints() {}, undoToCheckpoint() {},
        });
      });
    }
    signal?.throwIfAborted();
    const bytes = Buffer.byteLength(JSON.stringify(control));
    this.cacheBytes -= this.cache.get(scope)?.bytes ?? 0;
    this.cache.set(scope, { size: size ?? 0, mtime, generation, bytes, control });
    this.cacheBytes += bytes;
    while (this.cache.size > CACHE_ENTRIES || this.cacheBytes > READ_BYTES) {
      const oldest = this.cache.keys().next().value!;
      this.cacheBytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
    return control;
  }
}
