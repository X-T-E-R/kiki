import type { MemoryEntry, MemoryListPage } from '../../lib/client';

export async function continueMemory(
  read: (cursor: string | undefined) => Promise<MemoryListPage>,
  publish: (page: MemoryListPage) => void,
  signal: AbortSignal,
): Promise<MemoryListPage> {
  const entries = new Map<string, MemoryEntry>();
  let warnings: readonly string[] = [];
  let complete = true;
  let cursor: string | undefined;
  let result: MemoryListPage;
  do {
    signal.throwIfAborted();
    const page = await read(cursor);
    signal.throwIfAborted();
    for (const entry of page.items) entries.set(entry.id, {
      ...entry, body: entry.body.slice(0, 160), content_complete: entry.body.length <= 160,
    });
    if (page.coverage?.warnings.length) warnings = page.coverage.warnings;
    complete &&= page.coverage?.complete !== false;
    result = { ...page, items: [...entries.values()], coverage: page.coverage === undefined ? undefined : { ...page.coverage, complete, warnings: [...warnings] } };
    publish(result);
    if (!page.next_cursor && page.coverage?.exhausted === false) throw new Error('Memory continuation is unavailable; retry this list.');
    if (cursor !== undefined && page.next_cursor === cursor) throw new Error('Memory continuation did not advance; retry this list.');
    cursor = page.next_cursor ?? undefined;
    if (cursor !== undefined) await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  } while (cursor !== undefined);
  return result;
}
