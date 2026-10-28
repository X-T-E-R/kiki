import { createHash } from 'node:crypto';
import type { MemoryEntry, MemorySource } from './memoryStore.ts';

export function memorySourceUnitId(scope: string, source: MemorySource, body: string, refs: readonly string[] = [], discriminator?: string): string | undefined {
  if (source.session === undefined && refs.length === 0 && discriminator === undefined) return undefined;
  return `source-unit:${createHash('sha256').update(JSON.stringify(['memory-source-v1', scope, source.writer, source.session ?? null, source.turn ?? null, [...refs].toSorted(), body.trim(), discriminator ?? null])).digest('hex')}`;
}
export function memoryObjectSourceUnitId(scope: string, id: string, body: string): string {
  return memorySourceUnitId(scope, { writer: 'import' }, body, [], `object:${id}`)!;
}
export function memoryEntrySourceUnitIds(scope: string, entry: Pick<MemoryEntry, 'id' | 'source' | 'body' | 'basis'>): readonly string[] {
  const canonical = memorySourceUnitId(scope, entry.source, entry.body, entry.basis?.refs);
  return [memoryObjectSourceUnitId(scope, entry.id, entry.body), ...(canonical === undefined ? [] : [canonical])];
}
