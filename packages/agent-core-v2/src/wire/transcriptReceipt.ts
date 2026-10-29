import { createHash, type Hash } from 'node:crypto';

export const WIRE_TRANSCRIPT_RECEIPT_KEY = 'wire.transcript-receipt.json';

export interface WireTranscriptReceipt {
  readonly format: 1;
  readonly epoch: string;
  readonly state: 'open' | 'sealed';
  readonly trusted: boolean;
  readonly wire?: { readonly size: number; readonly sha256: string };
}

export function parseWireTranscriptReceipt(value: unknown): WireTranscriptReceipt | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  if (receipt['format'] !== 1 || typeof receipt['epoch'] !== 'string' || receipt['epoch'].length === 0 ||
      (receipt['state'] !== 'open' && receipt['state'] !== 'sealed') || typeof receipt['trusted'] !== 'boolean') {
    return undefined;
  }
  const wire = receipt['wire'];
  if (receipt['state'] === 'open') {
    if (wire !== undefined) return undefined;
    return receipt as unknown as WireTranscriptReceipt;
  }
  if (wire === null || typeof wire !== 'object' || Array.isArray(wire)) return undefined;
  const identity = wire as Record<string, unknown>;
  if (!Number.isSafeInteger(identity['size']) || (identity['size'] as number) < 0 ||
      typeof identity['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(identity['sha256'])) return undefined;
  return receipt as unknown as WireTranscriptReceipt;
}

/** Resumable digest of a wire byte prefix; `hash` is owned by the state and never finalized. */
export interface WireDigestState {
  readonly hash: Hash;
  readonly size: number;
  readonly lines: number;
  readonly endsWithNewline: boolean;
}

/** Digest of an empty prefix. */
export function emptyWireDigestState(): WireDigestState {
  return { hash: createHash('sha256'), size: 0, lines: 0, endsWithNewline: false };
}

/** Extends a copy of `state` with `chunks`; the input state stays reusable. */
export async function extendWireDigest(state: WireDigestState, chunks: AsyncIterable<Uint8Array>): Promise<WireDigestState> {
  const hash = state.hash.copy();
  let { size, lines, endsWithNewline } = state;
  for await (const chunk of chunks) {
    size += chunk.byteLength;
    if (!Number.isSafeInteger(size)) throw new Error('wire transcript exceeds safe byte length');
    hash.update(chunk);
    for (let offset = chunk.indexOf(0x0a); offset !== -1; offset = chunk.indexOf(0x0a, offset + 1)) {
      lines += 1;
    }
    if (chunk.byteLength > 0) endsWithNewline = chunk.at(-1) === 0x0a;
  }
  return { hash, size, lines, endsWithNewline };
}

/** Final digest values of a resumable state without consuming it. */
export function wireDigestOf(state: WireDigestState): {
  size: number; sha256: string; lines: number; endsWithNewline: boolean;
} {
  return { size: state.size, sha256: state.hash.copy().digest('hex'), lines: state.lines, endsWithNewline: state.endsWithNewline };
}

export async function digestWireBytes(chunks: AsyncIterable<Uint8Array>): Promise<{
  size: number; sha256: string; lines: number; endsWithNewline: boolean;
}> {
  return wireDigestOf(await extendWireDigest(emptyWireDigestState(), chunks));
}
