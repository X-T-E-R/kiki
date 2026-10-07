import { ISessionIndex, ISessionManager, type Scope, type SessionSummary } from '@kiki/agent-core-v2';
import type { DeleteArchivedSessionsResponse } from '@kiki/protocol';

export async function deleteArchivedSessions(
  core: Scope,
  rootId?: string,
  excludedIds: readonly string[] = [],
): Promise<DeleteArchivedSessionsResponse> {
  const index = core.accessor.get(ISessionIndex);
  const manager = core.accessor.get(ISessionManager);
  const result: DeleteArchivedSessionsResponse = { deleted_ids: [], failed: [] };
  let candidates: SessionSummary[];
  if (rootId !== undefined) {
    const root = await index.get(rootId);
    if (root === undefined || !root.archived) {
      return { deleted_ids: [], failed: [{ id: rootId, title: root?.title, message: root === undefined ? 'Conversation no longer exists.' : 'Conversation is no longer archived.' }] };
    }
    candidates = await index.archiveFamily(rootId, excludedIds);
  } else {
    candidates = [];
    let before: string | undefined;
    const cursors = new Set<string>();
    const deadline = Date.now() + 30_000;
    do {
      const page = await index.listRecent({ includeArchived: true, limit: 100, before });
      candidates.push(...page.items.filter((item) => item.archived));
      before = page.nextCursor;
      if (candidates.length > 100_000 || Date.now() > deadline || (before !== undefined && cursors.has(before))) {
        throw new Error('Archived conversation discovery exceeded its budget; nothing was deleted.');
      }
      if (before !== undefined) cursors.add(before);
    } while (before !== undefined);
  }
  for (const candidate of candidates.filter((item) => item.archived).toReversed()) {
    try {
      await manager.withLifecycleSerialization(candidate.id, async (lifecycle) => {
        const fresh = await index.get(candidate.id);
        if (fresh === undefined) throw new Error('Conversation no longer exists.');
        if (!fresh.archived) throw new Error('Conversation is no longer archived.');
        await lifecycle.delete();
      });
      result.deleted_ids.push(candidate.id);
    } catch (error) {
      result.failed.push({ id: candidate.id, title: candidate.title, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
