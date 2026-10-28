import { createHash } from 'node:crypto';
import type { MemorySource } from './memoryStore.ts';

export function memorySourceUnitId(scope: string, source: MemorySource, body: string, refs: readonly string[] = [], discriminator?: string): string | undefined {
  if (source.session === undefined && refs.length === 0 && discriminator === undefined) return undefined;
  return `source-unit:${createHash('sha256').update(JSON.stringify(['memory-source-v1', scope, source.writer, source.session ?? null, source.turn ?? null, [...refs].toSorted(), body.trim(), discriminator ?? null])).digest('hex')}`;
}
