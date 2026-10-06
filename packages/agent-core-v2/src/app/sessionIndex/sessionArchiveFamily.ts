import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import { Error2 } from '#/_base/errors/errors';
import type { ILogService } from '#/_base/log/log';

import { CHILD_SESSION_KIND, CHILD_SESSION_KIND_KEY, CREATED_BY_SESSION_ID_KEY, PARENT_SESSION_ID_KEY, type SessionSummary } from './sessionIndex';
import { listSessionIds, listWorkspaceIds, mapBounded, readSessionSummaryResult } from './sessionIndexSource';

export function attachedSessionParent(summary: SessionSummary): string | undefined {
  const createdBy = summary.custom?.[CREATED_BY_SESSION_ID_KEY];
  if (typeof createdBy === 'string' && createdBy !== '' && createdBy !== summary.id) return createdBy;
  const parent = summary.custom?.[PARENT_SESSION_ID_KEY];
  return summary.custom?.[CHILD_SESSION_KIND_KEY] === CHILD_SESSION_KIND &&
    typeof parent === 'string' && parent !== '' && parent !== summary.id ? parent : undefined;
}

export async function readSessionArchiveFamily(
  storage: IFileSystemStorageService,
  docs: IAtomicDocumentStore,
  sessionsScope: string,
  rootId: string,
  excludedIds: readonly string[],
  log: ILogService,
): Promise<SessionSummary[]> {
  const started = Date.now();
  const deadline = started + 30_000;
  const entries: { workspaceId: string; sessionId: string }[] = [];
  const checkBudget = (): void => {
    if (entries.length > 100_000 || Date.now() > deadline) {
      throw new Error2('internal', 'Attached conversation discovery exceeded its budget; no conversations were archived. Retry after reducing the session inventory.');
    }
  };
  try {
    for (const workspaceId of await listWorkspaceIds(storage, sessionsScope, log)) {
      for (const sessionId of await listSessionIds(storage, sessionsScope, workspaceId, log)) {
        entries.push({ workspaceId, sessionId });
        checkBudget();
      }
    }
    const summaries = await mapBounded(entries, 16, async ({ workspaceId, sessionId }) => {
      checkBudget();
      const result = await readSessionSummaryResult(docs, sessionsScope, workspaceId, sessionId, log);
      checkBudget();
      if (result.kind === 'error') {
        throw new Error2('internal', `Cannot discover attached conversations: metadata for session ${sessionId} is unreadable. No conversations were archived.`, { cause: result.error });
      }
      return result.kind === 'found' ? result.summary : undefined;
    });
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    const root = byId.get(rootId);
    if (root === undefined) return [];
    const children = new Map<string, SessionSummary[]>();
    for (const summary of summaries) {
      const parent = attachedSessionParent(summary);
      if (parent === undefined) continue;
      const siblings = children.get(parent) ?? [];
      siblings.push(summary);
      children.set(parent, siblings);
    }
    const excluded = new Set(excludedIds);
    const seen = new Set([rootId]);
    const family = [root];
    for (let position = 0; position < family.length; position++) {
      for (const child of children.get(family[position]!.id) ?? []) {
        if (seen.has(child.id) || excluded.has(child.id)) continue;
        seen.add(child.id);
        family.push(child);
      }
    }
    log.info('session archive family discovered', { sessions_scanned: entries.length, family_count: family.length, duration_ms: Date.now() - started });
    return family;
  } catch (error) {
    log.warn('session archive family discovery failed', { sessions_scanned: entries.length, duration_ms: Date.now() - started, error: String(error) });
    throw error;
  }
}
