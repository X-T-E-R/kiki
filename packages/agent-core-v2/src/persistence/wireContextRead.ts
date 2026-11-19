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
  signal: AbortSignal | undefined,
  options: { readonly omitTranscript: true },
): Promise<Omit<WireContextProjection, 'transcript'>>;
export async function readWireContextProjection(
  execute: CpuExecutor,
  logs: IAppendLogStore,
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  signal?: AbortSignal,
  options?: { readonly omitTranscript?: boolean },
): Promise<WireContextProjection>;
export async function readWireContextProjection(
  execute: CpuExecutor,
  logs: IAppendLogStore,
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  signal?: AbortSignal,
  options?: { readonly omitTranscript?: boolean },
): Promise<WireContextProjection | Omit<WireContextProjection, 'transcript'>> {
  signal?.throwIfAborted();
  const flushed = logs.flush(scope, key);
  await (signal === undefined ? flushed : abortable(flushed, signal));
  signal?.throwIfAborted();
  const operation = options?.omitTranscript === true
    ? { type: 'wire.context' as const, scope, key, omitTranscript: true }
    : { type: 'wire.context' as const, scope, key };
  const bytes = await runCpuStream<ArrayBuffer>(execute, operation,
    (readSignal) => readLogicalBytes(storage, scope, key, undefined, { signal: readSignal, chunkBytes: 1024 * 1024 }), signal);
  signal?.throwIfAborted();
  return deserialize(Buffer.from(bytes)) as WireContextProjection | Omit<WireContextProjection, 'transcript'>;
}
