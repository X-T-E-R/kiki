import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

const PROOF_BYTES = 64 << 10;

export interface HistoryNavigationProof {
  readonly identity: string;
  readonly size: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly head: string;
  readonly tail: string;
}

/**
 * A bounded prefix witness for Kiki's own append-only wire writer. Recovery checks
 * file identity, size, modification times for an unchanged-size file, and the first
 * and last 64 KiB of the committed prefix. An in-place rewrite of an unsampled
 * middle span followed by an append is outside this source threat model; recovery
 * does not rehash the entire prefix. Exact source reads still verify their record digests.
 */
export async function historyNavigationProof(path: string, through: number): Promise<HistoryNavigationProof> {
  const before = await stat(path, { bigint: true });
  if (!before.isFile() || !Number.isSafeInteger(through) || through < 0 || BigInt(through) > before.size) {
    throw new Error('history_source_changed');
  }
  const identity = `${before.dev}:${before.ino}:${before.birthtimeNs}`;
  const fingerprint = `${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
  const file = await open(path, 'r');
  const digest = async (position: number, size: number): Promise<string> => {
    const buffer = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const result = await file.read(buffer, read, size - read, position + read);
      if (result.bytesRead === 0) throw new Error('history_source_changed');
      read += result.bytesRead;
    }
    return createHash('sha256').update(buffer).digest('hex');
  };
  let head: string;
  let tail: string;
  try {
    head = await digest(0, Math.min(through, PROOF_BYTES));
    tail = await digest(Math.max(0, through - PROOF_BYTES), Math.min(through, PROOF_BYTES));
  } finally { await file.close(); }
  const after = await stat(path, { bigint: true });
  if (`${after.dev}:${after.ino}:${after.birthtimeNs}` !== identity ||
      `${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== fingerprint) throw new Error('history_source_changed');
  return { identity, size: Number(before.size), mtimeNs: String(before.mtimeNs),
    ctimeNs: String(before.ctimeNs), head, tail };
}

export function matchesNavigationProof(saved: HistoryNavigationProof, current: HistoryNavigationProof): boolean {
  return saved.identity === current.identity && saved.head === current.head && saved.tail === current.tail &&
    current.size >= saved.size &&
    (current.size > saved.size || current.mtimeNs === saved.mtimeNs && current.ctimeNs === saved.ctimeNs);
}
