import { createHash } from 'node:crypto';
import { open, stat, type FileHandle } from 'node:fs/promises';

import { openLogicalWire, type LogicalWire } from '../history/logicalWireRead';

export const WIRE_PREFIX_BOUNDARY_BYTES = 4096;
export const WIRE_YIELD_BUDGET_MS = 4;

const VISIBILITY_RESET_NEEDLES = [
  Buffer.from('"context.undo"'),
  Buffer.from('"context.clear"'),
  Buffer.from('"branch.base"'),
];
const HARD_CLEAR_NEEDLES = [
  Buffer.from('"context.clear"'),
  Buffer.from('"branch.base"'),
];
const VISIBILITY_RESET_OVERLAP_BYTES = 32;
const VISIBILITY_SCAN_CHUNK_BYTES = 64 * 1024;

export interface WireFileStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly birthtimeMs: number;
}

export interface WirePrefixWitness {
  readonly identity: string;
  readonly exactFingerprint: string;
  readonly observedSize: number;
  readonly boundaryOffset: number;
  readonly boundarySha256: string;
  readonly headSha256: string;
  readonly completeTailOffset?: number;
  readonly sealStamp?: string;
}

export interface YieldBudget {
  yieldedAt: number;
}

export function createYieldBudget(): YieldBudget {
  return { yieldedAt: performance.now() };
}

export async function yieldIfTimeBudgetExceeded(budget: YieldBudget, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (performance.now() - budget.yieldedAt < WIRE_YIELD_BUDGET_MS) return;
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  signal?.throwIfAborted();
  budget.yieldedAt = performance.now();
}

export function wrapYieldingRecordCallback<T extends (...args: never[]) => unknown>(
  onRecord: T,
  signal?: AbortSignal,
): T {
  let yieldedAt = performance.now();
  return ((...args: Parameters<T>) => {
    const result = onRecord(...args);
    if (performance.now() - yieldedAt < WIRE_YIELD_BUDGET_MS) return result;
    return (async () => {
      const resolved = await result;
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      signal?.throwIfAborted();
      yieldedAt = performance.now();
      return resolved;
    })();
  }) as unknown as T;
}

export function wireFileIdentity(info: Pick<WireFileStat, 'dev' | 'ino' | 'birthtimeMs'>): string {
  return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
}

export function wireFileFingerprint(info: Pick<WireFileStat, 'size' | 'mtimeMs' | 'ctimeMs'>): string {
  return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

export function wireExactFingerprint(info: WireFileStat): string {
  return `${wireFileIdentity(info)}:${wireFileFingerprint(info)}`;
}

function statUnchangedOrAppended(current: WireFileStat, previous: WireFileStat): boolean {
  if (wireFileIdentity(current) !== wireFileIdentity(previous)) return false;
  if (current.size < previous.size) return false;
  if (current.size === previous.size) {
    return wireExactFingerprint(current) === wireExactFingerprint(previous);
  }
  return true;
}

interface SharedWireReader {
  readExact(position: number, length: number, signal?: AbortSignal): Promise<Buffer | undefined>;
  close(): Promise<void>;
}

async function openSharedWireReader(wirePath: string, signal?: AbortSignal): Promise<SharedWireReader> {
  const opened: LogicalWire | undefined = await openLogicalWire(wirePath, signal);
  const handle: FileHandle | undefined = opened === undefined ? await open(wirePath, 'r') : undefined;
  return {
    async readExact(position: number, length: number, readSignal?: AbortSignal): Promise<Buffer | undefined> {
      readSignal?.throwIfAborted();
      if (opened !== undefined) {
        if (position + length > opened.size) return undefined;
        const bytes = await opened.readAt(position, length);
        readSignal?.throwIfAborted();
        if (bytes.byteLength !== length) return undefined;
        return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
      const buffer = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle!.read(buffer, filled, length - filled, position + filled);
        readSignal?.throwIfAborted();
        if (bytesRead === 0) return undefined;
        filled += bytesRead;
      }
      return buffer;
    },
    async close(): Promise<void> {
      opened?.close();
      await handle?.close().catch(() => undefined);
    },
  };
}

async function readPrefixSamplesWithReader(
  reader: SharedWireReader,
  targetSize: number,
  boundaryOffset: number,
  signal?: AbortSignal,
): Promise<{ readonly headSha256: string; readonly boundarySha256: string; readonly completeTailOffset?: number } | undefined> {
  signal?.throwIfAborted();
  if (targetSize === 0) return { headSha256: '', boundarySha256: '', completeTailOffset: 0 };
  const headLen = Math.min(targetSize, WIRE_PREFIX_BOUNDARY_BYTES);
  const boundaryLen = targetSize - boundaryOffset;
  const completeTailOf = (bytes: Buffer): number | undefined => {
    if (bytes.byteLength === 0) return boundaryOffset;
    if (bytes[bytes.byteLength - 1] === 0x0a) return targetSize;
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline >= 0) return boundaryOffset + lastNewline + 1;
    return boundaryOffset === 0 ? 0 : undefined;
  };
  const headBytes = await reader.readExact(0, headLen, signal);
  if (headBytes === undefined) return undefined;
  const headSha256 = createHash('sha256').update(headBytes).digest('hex');
  if (boundaryOffset === 0 && boundaryLen === headLen) {
    return { headSha256, boundarySha256: headSha256, completeTailOffset: completeTailOf(headBytes) };
  }
  const boundaryBytes = await reader.readExact(boundaryOffset, boundaryLen, signal);
  if (boundaryBytes === undefined) return undefined;
  const boundarySha256 = createHash('sha256').update(boundaryBytes).digest('hex');
  return { headSha256, boundarySha256, completeTailOffset: completeTailOf(boundaryBytes) };
}

export async function captureWirePrefixWitness(
  wirePath: string,
  info: WireFileStat,
  signal?: AbortSignal,
  sealStamp?: string,
): Promise<WirePrefixWitness | undefined> {
  signal?.throwIfAborted();
  const observedSize = info.size;
  if (!Number.isSafeInteger(observedSize) || observedSize < 0) return undefined;
  const boundaryOffset = Math.max(0, observedSize - WIRE_PREFIX_BOUNDARY_BYTES);
  if (observedSize === 0) {
    const after = await stat(wirePath).catch(() => undefined);
    signal?.throwIfAborted();
    if (after === undefined || !statUnchangedOrAppended(after, info)) return undefined;
    return {
      identity: wireFileIdentity(info),
      exactFingerprint: wireExactFingerprint(info),
      observedSize: 0,
      boundaryOffset: 0,
      boundarySha256: '',
      headSha256: '',
      completeTailOffset: 0,
      sealStamp,
    };
  }
  const reader = await openSharedWireReader(wirePath, signal);
  try {
    const samples = await readPrefixSamplesWithReader(reader, observedSize, boundaryOffset, signal);
    if (samples === undefined) return undefined;
    const after = await stat(wirePath).catch(() => undefined);
    signal?.throwIfAborted();
    if (after === undefined || !statUnchangedOrAppended(after, info)) return undefined;
    if (after.size > info.size) {
      const rechecked = await readPrefixSamplesWithReader(reader, observedSize, boundaryOffset, signal);
      if (rechecked === undefined || rechecked.headSha256 !== samples.headSha256 || rechecked.boundarySha256 !== samples.boundarySha256) {
        return undefined;
      }
      const finalStat = await stat(wirePath).catch(() => undefined);
      signal?.throwIfAborted();
      if (finalStat === undefined || !statUnchangedOrAppended(finalStat, after)) return undefined;
    }
    return {
      identity: wireFileIdentity(info),
      exactFingerprint: wireExactFingerprint(info),
      observedSize,
      boundaryOffset,
      boundarySha256: samples.boundarySha256,
      headSha256: samples.headSha256,
      completeTailOffset: samples.completeTailOffset,
      sealStamp,
    };
  } finally {
    await reader.close();
  }
}

async function verifyPrefixWithReader(
  wirePath: string,
  reader: SharedWireReader | undefined,
  witness: WirePrefixWitness,
  currentInfo: WireFileStat,
  signal?: AbortSignal,
  currentSealStamp?: string,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (wireFileIdentity(currentInfo) !== witness.identity) return false;
  if (currentInfo.size < witness.observedSize) return false;
  if (witness.sealStamp !== undefined && currentSealStamp !== witness.sealStamp) return false;
  if (currentInfo.size === witness.observedSize) {
    return wireExactFingerprint(currentInfo) === witness.exactFingerprint;
  }
  if (witness.observedSize > 0) {
    const ownedReader = reader === undefined ? await openSharedWireReader(wirePath, signal) : undefined;
    try {
      const samples = await readPrefixSamplesWithReader(reader ?? ownedReader!, witness.observedSize, witness.boundaryOffset, signal);
      if (samples === undefined) return false;
      if (samples.headSha256 !== witness.headSha256 || samples.boundarySha256 !== witness.boundarySha256) return false;
    } finally {
      await ownedReader?.close();
    }
  }
  const after = await stat(wirePath).catch(() => undefined);
  signal?.throwIfAborted();
  if (after === undefined || !statUnchangedOrAppended(after, currentInfo)) {
    return false;
  }
  return true;
}

export async function verifyWirePrefixWitness(
  wirePath: string,
  witness: WirePrefixWitness,
  currentInfo: WireFileStat,
  signal?: AbortSignal,
  currentSealStamp?: string,
): Promise<boolean> {
  return verifyPrefixWithReader(wirePath, undefined, witness, currentInfo, signal, currentSealStamp);
}

async function scanTailWithReader(
  reader: SharedWireReader,
  fromOffset: number,
  toOffset: number,
  maxScanBytes: number,
  needles: readonly Buffer[],
  signal?: AbortSignal,
): Promise<{ readonly hasReset: boolean; readonly completeTailOffset?: number }> {
  signal?.throwIfAborted();
  if (toOffset <= fromOffset) return { hasReset: false, completeTailOffset: fromOffset };
  if (toOffset - fromOffset > maxScanBytes) return { hasReset: true };
  const budget = createYieldBudget();
  let position = fromOffset;
  let carry = Buffer.alloc(0);
  let lastNewlineOffset: number | undefined;
  while (position < toOffset) {
    signal?.throwIfAborted();
    const length = Math.min(VISIBILITY_SCAN_CHUNK_BYTES, toOffset - position);
    const chunk = await reader.readExact(position, length, signal);
    if (chunk === undefined) return { hasReset: true };
    const view = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    for (const needle of needles) {
      if (view.includes(needle)) return { hasReset: true };
    }
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline >= 0) {
      lastNewlineOffset = position + lastNewline + 1;
    }
    carry = view.length > VISIBILITY_RESET_OVERLAP_BYTES
      ? Buffer.from(view.subarray(view.length - VISIBILITY_RESET_OVERLAP_BYTES))
      : Buffer.from(view);
    position += length;
    await yieldIfTimeBudgetExceeded(budget, signal);
  }
  return { hasReset: false, completeTailOffset: lastNewlineOffset ?? fromOffset };
}

export async function scanAppendedTailForVisibilityReset(
  wirePath: string,
  fromOffset: number,
  toOffset: number,
  maxScanBytes: number,
  signal?: AbortSignal,
): Promise<{ readonly hasReset: boolean; readonly completeTailOffset?: number }> {
  signal?.throwIfAborted();
  if (toOffset <= fromOffset) return { hasReset: false, completeTailOffset: fromOffset };
  if (toOffset - fromOffset > maxScanBytes) return { hasReset: true };
  const reader = await openSharedWireReader(wirePath, signal);
  try {
    return await scanTailWithReader(reader, fromOffset, toOffset, maxScanBytes, VISIBILITY_RESET_NEEDLES, signal);
  } finally {
    await reader.close();
  }
}

export async function rangeHasHardClear(
  wirePath: string,
  fromOffset: number,
  toOffset: number,
  maxScanBytes: number,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (toOffset <= fromOffset || toOffset - fromOffset > maxScanBytes) return false;
  const reader = await openSharedWireReader(wirePath, signal);
  try {
    const result = await scanTailWithReader(reader, fromOffset, toOffset, maxScanBytes, HARD_CLEAR_NEEDLES, signal);
    return result.hasReset;
  } finally {
    await reader.close();
  }
}

export async function appendedTailHasVisibilityReset(
  wirePath: string,
  fromOffset: number,
  toOffset: number,
  maxScanBytes: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await scanAppendedTailForVisibilityReset(wirePath, fromOffset, toOffset, maxScanBytes, signal);
  return result.hasReset;
}

export async function verifyWitnessAppendSafe(
  wirePath: string,
  witness: WirePrefixWitness,
  currentInfo: WireFileStat,
  visibilityCheckedTo: number | undefined,
  maxVisibilityScanBytes: number,
  signal?: AbortSignal,
  currentSealStamp?: string,
): Promise<{ readonly valid: boolean; readonly witness?: WirePrefixWitness; readonly visibilityCheckedTo?: number }> {
  signal?.throwIfAborted();
  if (wireFileIdentity(currentInfo) !== witness.identity) return { valid: false };
  if (currentInfo.size < witness.observedSize) return { valid: false };
  if (visibilityCheckedTo !== undefined && currentInfo.size < visibilityCheckedTo) return { valid: false };
  if (witness.sealStamp !== undefined && currentSealStamp !== witness.sealStamp) return { valid: false };
  if (currentInfo.size === witness.observedSize) {
    if (wireExactFingerprint(currentInfo) !== witness.exactFingerprint) return { valid: false };
    const completeTarget = witness.completeTailOffset;
    if (visibilityCheckedTo !== undefined && completeTarget !== undefined && visibilityCheckedTo < completeTarget) {
      const scanned = await scanAppendedTailForVisibilityReset(wirePath, visibilityCheckedTo, completeTarget, maxVisibilityScanBytes, signal);
      if (scanned.hasReset) return { valid: false };
      return { valid: true, witness, visibilityCheckedTo: scanned.completeTailOffset };
    }
    return { valid: true, witness, visibilityCheckedTo: visibilityCheckedTo ?? witness.completeTailOffset };
  }
  const scanFrom = visibilityCheckedTo ?? witness.completeTailOffset;
  if (scanFrom === undefined) return { valid: false };
  if (currentInfo.size - scanFrom > maxVisibilityScanBytes) return { valid: false };
  const reader = await openSharedWireReader(wirePath, signal);
  try {
    const intact = await verifyPrefixWithReader(wirePath, reader, witness, currentInfo, signal, currentSealStamp);
    if (!intact) return { valid: false };
    const scanned = await scanTailWithReader(reader, scanFrom, currentInfo.size, maxVisibilityScanBytes, VISIBILITY_RESET_NEEDLES, signal);
    if (scanned.hasReset) return { valid: false };
    const nextBoundaryOffset = Math.max(0, currentInfo.size - WIRE_PREFIX_BOUNDARY_BYTES);
    const nextSamples = await readPrefixSamplesWithReader(reader, currentInfo.size, nextBoundaryOffset, signal);
    if (nextSamples === undefined) return { valid: false };
    const afterRatchet = await stat(wirePath).catch(() => undefined);
    signal?.throwIfAborted();
    if (afterRatchet === undefined || !statUnchangedOrAppended(afterRatchet, currentInfo)) return { valid: false };
    const nextWitness: WirePrefixWitness = {
      identity: witness.identity,
      exactFingerprint: wireExactFingerprint(currentInfo),
      observedSize: currentInfo.size,
      boundaryOffset: nextBoundaryOffset,
      boundarySha256: nextSamples.boundarySha256,
      headSha256: nextSamples.headSha256,
      completeTailOffset: nextSamples.completeTailOffset,
      sealStamp: currentSealStamp ?? witness.sealStamp,
    };
    return { valid: true, witness: nextWitness, visibilityCheckedTo: scanned.completeTailOffset ?? nextSamples.completeTailOffset };
  } finally {
    await reader.close();
  }
}
