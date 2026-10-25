import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';
import {
  openPinnedLogicalRead,
  readLogicalRange,
  readPinnedRange,
  wireFileAddress,
} from '@kiki/agent-core-v2';
import {
  streamWireRecords,
  streamWireRecordsAwaited,
  type AwaitedWireRecordsStreamOptions,
  type WireByteSource,
  type WireRecordsStreamOptions,
  type WireRecordsStreamResult,
} from '@kiki/transcript-live/wireRecords';

export interface LogicalWire extends WireByteSource {
  close(): void;
}

export async function readLogicalInto(
  source: LogicalWire,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<number> {
  const chunk = await source.readAt(position, length);
  const count = Math.min(chunk.byteLength, length);
  if (count > 0) buffer.set(chunk.subarray(0, count), offset);
  return count;
}

export async function openLogicalWire(wirePath: string): Promise<LogicalWire | undefined> {
  const address = wireFileAddress(wirePath);
  const storage = new FileStorageService(address.baseDir);
  const pinned = await openPinnedLogicalRead(storage, address.scope, address.key);
  if (pinned.size === undefined) {
    pinned.close();
    return undefined;
  }
  const size = pinned.size;
  let closed = false;
  return {
    size,
    readAt: (position, length) => readPinnedRange(pinned, position, length),
    close() {
      if (closed) return;
      closed = true;
      pinned.close();
    },
  };
}

export async function readLogicalWireRange(
  wirePath: string,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  const address = wireFileAddress(wirePath);
  const storage = new FileStorageService(address.baseDir);
  return readLogicalRange(storage, address.scope, address.key, position, length, signal);
}

export async function streamLogicalWireRecords(
  wirePath: string,
  options: WireRecordsStreamOptions,
): Promise<WireRecordsStreamResult> {
  const opened = await openLogicalWire(wirePath);
  if (opened === undefined) return streamWireRecords(wirePath, options);
  try {
    return await streamWireRecords(wirePath, { ...options, byteSource: opened });
  } finally {
    opened.close();
  }
}

export async function streamLogicalWireRecordsAwaited(
  wirePath: string,
  options: AwaitedWireRecordsStreamOptions,
): Promise<WireRecordsStreamResult> {
  const opened = await openLogicalWire(wirePath);
  if (opened === undefined) return streamWireRecordsAwaited(wirePath, options);
  try {
    return await streamWireRecordsAwaited(wirePath, { ...options, byteSource: opened });
  } finally {
    opened.close();
  }
}
