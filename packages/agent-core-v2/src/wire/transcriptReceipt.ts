import { createHash, type Hash } from 'node:crypto';

export const WIRE_TRANSCRIPT_RECEIPT_KEY = 'wire.transcript-receipt.json';

/** Number of trailing journal bytes a format-2 sealed receipt binds. */
export const WIRE_RECEIPT_TAIL_BYTES = 4096;

/**
 * Sealed journal coordinate. Format 1 carries the SHA-256 of the whole journal; format 2 carries
 * only the SHA-256 of its last `tailBytes` bytes and relies on the single-writer contract for the prefix.
 */
export type WireTranscriptReceiptWire =
  | { readonly size: number; readonly sha256: string }
  | { readonly size: number; readonly tailBytes: number; readonly tailSha256: string };

export interface WireTranscriptReceipt {
  readonly format: 1 | 2;
  readonly epoch: string;
  readonly state: 'open' | 'sealed';
  readonly trusted: boolean;
  readonly wire?: WireTranscriptReceiptWire;
  /**
   * Set only on an untrusted sealed receipt whose epoch lost its proof because a failed append broke the
   * observed source chain, not because accepted bytes diverged. The next epoch may start trusted from this
   * receipt's size and tail; this receipt itself certifies nothing.
   */
  readonly reanchor?: true;
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function parseWireTranscriptReceipt(value: unknown): WireTranscriptReceipt | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  const format = receipt['format'];
  if ((format !== 1 && format !== 2) || typeof receipt['epoch'] !== 'string' || receipt['epoch'].length === 0 ||
      (receipt['state'] !== 'open' && receipt['state'] !== 'sealed') || typeof receipt['trusted'] !== 'boolean') {
    return undefined;
  }
  const reanchor = receipt['reanchor'];
  if (reanchor !== undefined && (reanchor !== true || receipt['state'] !== 'sealed' || receipt['trusted'] !== false)) return undefined;
  const wire = receipt['wire'];
  if (receipt['state'] === 'open') {
    if (wire !== undefined) return undefined;
    return receipt as unknown as WireTranscriptReceipt;
  }
  if (wire === null || typeof wire !== 'object' || Array.isArray(wire)) return undefined;
  const identity = wire as Record<string, unknown>;
  const size = identity['size'];
  if (!Number.isSafeInteger(size) || (size as number) < 0) return undefined;
  if (format === 1) return isSha256Hex(identity['sha256']) ? receipt as unknown as WireTranscriptReceipt : undefined;
  const tailBytes = identity['tailBytes'];
  if (!Number.isSafeInteger(tailBytes) || (tailBytes as number) < 0 ||
      (tailBytes as number) > Math.min(size as number, WIRE_RECEIPT_TAIL_BYTES) ||
      ((tailBytes as number) < WIRE_RECEIPT_TAIL_BYTES && tailBytes !== size) ||
      !isSha256Hex(identity['tailSha256'])) return undefined;
  return receipt as unknown as WireTranscriptReceipt;
}

/** SHA-256 of a sealed receipt's tail bytes. */
export function wireTailSha256(tail: Uint8Array): string {
  return createHash('sha256').update(tail).digest('hex');
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
