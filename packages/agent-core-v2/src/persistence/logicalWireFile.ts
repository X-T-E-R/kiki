import { basename, dirname } from 'pathe';

import { openPinnedLogicalRead, type PinnedLogicalRead } from '#/persistence/coldSegmentLog';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

export function wireFileAddress(wirePath: string): { baseDir: string; scope: string; key: string } {
  const key = basename(wirePath);
  const parent = dirname(wirePath);
  const agents = dirname(parent);
  if (basename(agents) === 'agents') {
    return { baseDir: dirname(agents), scope: `agents/${basename(parent)}`, key };
  }
  return { baseDir: parent, scope: '.', key };
}

export async function readPinnedRange(
  pinned: PinnedLogicalRead,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length <= 0) {
    return new Uint8Array();
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of pinned.read({ start: position, end: position + length - 1 }, { signal })) {
    parts.push(chunk);
    total += chunk.byteLength;
    if (total >= length) break;
  }
  if (total === 0) return new Uint8Array();
  const only = parts[0];
  if (parts.length === 1 && only !== undefined) return only.byteLength <= length ? only : only.subarray(0, length);
  const out = new Uint8Array(Math.min(total, length));
  let offset = 0;
  for (const part of parts) {
    const take = Math.min(part.byteLength, out.byteLength - offset);
    out.set(part.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

export async function readLogicalRange(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  const pinned = await openPinnedLogicalRead(storage, scope, key);
  try {
    if (pinned.size === undefined) return undefined;
    return await readPinnedRange(pinned, position, length, signal);
  } finally {
    pinned.close();
  }
}
