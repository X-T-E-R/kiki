import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

import { openLogicalWire, type LogicalWire } from './logicalWireRead';

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
 * file identity and modification times, and the first and last 64 KiB of the logical
 * journal through `through`. A sealed manifest supplies those bytes; without one they
 * are the file bytes. Growth during proof IO rechecks those samples without relabeling
 * the captured stat revision as latest. A same-size mtime or ctime change still fails.
 * Exact record digests are a separate check.
 */
export async function historyNavigationProof(path: string, through: number): Promise<HistoryNavigationProof> {
  const before = await stat(path, { bigint: true });
  const identity = `${before.dev}:${before.ino}:${before.birthtimeNs}`;
  let opened: LogicalWire | undefined;
  const digest = async (position: number, size: number): Promise<string> => {
    const bytes = size === 0 ? new Uint8Array() : await opened!.readAt(position, size);
    if (bytes.byteLength !== size) throw new Error('history_source_changed');
    return createHash('sha256').update(bytes).digest('hex');
  };
  const unchangedOrAppended = (info: typeof before, previous: typeof before): void => {
    if (!info.isFile() || `${info.dev}:${info.ino}:${info.birthtimeNs}` !== identity || info.size < previous.size ||
        info.size === previous.size && (info.mtimeNs !== previous.mtimeNs || info.ctimeNs !== previous.ctimeNs)) {
      throw new Error('history_source_changed');
    }
  };
  try {
    opened = await openLogicalWire(path);
    if (!before.isFile() || opened === undefined || !Number.isSafeInteger(through) || through < 0 ||
        BigInt(through) > before.size || through > opened.size) {
      throw new Error('history_source_changed');
    }
    unchangedOrAppended(await stat(path, { bigint: true }), before);
    const headSize = Math.min(through, PROOF_BYTES);
    const tailStart = Math.max(0, through - PROOF_BYTES);
    const head = await digest(0, headSize);
    const tail = await digest(tailStart, headSize);
    const after = await stat(path, { bigint: true });
    unchangedOrAppended(after, before);
    if (after.size > before.size) {
      if (await digest(0, headSize) !== head || await digest(tailStart, headSize) !== tail) {
        throw new Error('history_source_changed');
      }
      unchangedOrAppended(await stat(path, { bigint: true }), after);
    }
    return { identity, size: Number(before.size), mtimeNs: String(before.mtimeNs),
      ctimeNs: String(before.ctimeNs), head, tail };
  } finally { opened?.close(); }
}

export function matchesNavigationProof(saved: HistoryNavigationProof, current: HistoryNavigationProof): boolean {
  return saved.identity === current.identity && saved.head === current.head && saved.tail === current.tail &&
    current.size >= saved.size &&
    (current.size > saved.size || current.mtimeNs === saved.mtimeNs && current.ctimeNs === saved.ctimeNs);
}
