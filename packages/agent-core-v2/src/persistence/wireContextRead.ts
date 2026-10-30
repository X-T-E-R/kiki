import { deserialize } from 'node:v8';
import { abortable } from '#/_base/utils/abort';
import type { WireContextProjection } from '#/agent/contextMemory/wireContextProjection';
import { runCpuStream, type CpuExecutor } from '#/app/cpuWorker/stream';
import { readLogicalBytes } from './coldSegmentLog';
import type { IAppendLogStore } from './interface/appendLogStore';
import type { IFileSystemStorageService } from './interface/storage';

export async function readWireContextProjection(
  execute: CpuExecutor,
  logs: IAppendLogStore,
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  signal?: AbortSignal,
): Promise<WireContextProjection> {
  signal?.throwIfAborted();
  const flushed = logs.flush(scope, key);
  await (signal === undefined ? flushed : abortable(flushed, signal));
  signal?.throwIfAborted();
  const bytes = await runCpuStream<ArrayBuffer>(execute, { type: 'wire.context', scope, key },
    (readSignal) => readLogicalBytes(storage, scope, key, undefined, { signal: readSignal, chunkBytes: 1024 * 1024 }), signal);
  signal?.throwIfAborted();
  return deserialize(Buffer.from(bytes)) as WireContextProjection;
}
