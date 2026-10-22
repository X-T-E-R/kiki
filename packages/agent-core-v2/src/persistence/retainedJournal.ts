import { readdir } from 'node:fs/promises';

import { join } from 'pathe';

import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import type { ColdSealOptions, ColdSealResult } from '#/persistence/interface/appendLogStore';
import {
  StorageError,
  StorageErrors,
  type IFileSystemStorageService,
} from '#/persistence/interface/storage';
import { wireFileAddress } from '#/persistence/logicalWireFile';

const WIRE_FILENAME = 'wire.jsonl';

export async function sealRetainedJournal(wirePath: string, options?: ColdSealOptions): Promise<ColdSealResult> {
  const address = wireFileAddress(wirePath);
  const storage = new FileStorageService(address.baseDir);
  const log = new AppendLogStore(storage);
  try {
    const size = await storage.size(address.scope, address.key);
    if (size === undefined) {
      throw new StorageError(StorageErrors.codes.STORAGE_NOT_FOUND, 'Cold seal journal is missing', {
        details: { scope: address.scope, key: address.key },
      });
    }
    const sealedCut = await lastRecordCut(storage, address.scope, address.key, size);
    return await log.sealCold(address.scope, address.key, sealedCut, options);
  } finally {
    log.dispose();
    await storage.close();
  }
}

export async function discardRetainedJournal(wirePath: string): Promise<void> {
  const address = wireFileAddress(wirePath);
  const storage = new FileStorageService(address.baseDir);
  const log = new AppendLogStore(storage);
  try {
    await log.discardCold(address.scope, address.key);
  } finally {
    log.dispose();
    await storage.close();
  }
}

export async function sealRetainedSession(sessionDir: string, options?: ColdSealOptions): Promise<readonly ColdSealResult[]> {
  const results: ColdSealResult[] = [];
  for (const wirePath of await sessionWirePaths(sessionDir)) {
    results.push(await sealRetainedJournal(wirePath, options));
  }
  return results;
}

export async function discardRetainedSession(sessionDir: string): Promise<number> {
  const wires = await sessionWirePaths(sessionDir);
  for (const wirePath of wires) await discardRetainedJournal(wirePath);
  return wires.length;
}

async function sessionWirePaths(sessionDir: string): Promise<readonly string[]> {
  const agentsDir = join(sessionDir, 'agents');
  let entries;
  try {
    entries = await readdir(agentsDir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile() || entry.name !== WIRE_FILENAME) continue;
    paths.push(join(entry.parentPath, entry.name));
  }
  return paths;
}

async function lastRecordCut(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  size: number,
): Promise<number> {
  if (size === 0) return 0;
  const tail = await readRange(storage, scope, key, size - 1, size - 1);
  if (tail.byteLength === 1 && tail[0] === 0x0a) return size;
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - (64 * 1024));
    const chunk = await readRange(storage, scope, key, start, end - 1);
    for (let index = chunk.byteLength - 1; index >= 0; index -= 1) {
      if (chunk[index] === 0x0a) return start + index + 1;
    }
    if (start === 0) break;
    end = start;
  }
  return 0;
}

async function readRange(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  start: number,
  end: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of storage.readStream(scope, key, { start, end })) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isEnoent(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
}
