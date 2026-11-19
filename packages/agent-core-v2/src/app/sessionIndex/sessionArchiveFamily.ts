import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import { Error2 } from '#/_base/errors/errors';
import type { ILogService } from '#/_base/log/log';

import { CHILD_SESSION_KIND, CHILD_SESSION_KIND_KEY, CREATED_BY_SESSION_ID_KEY, PARENT_SESSION_ID_KEY, type SessionSummary } from './sessionIndex';
import type { SessionSourceFingerprint } from './sessionIndexModel';
import { fingerprintEquals } from './sessionIndexProjector';
import { listSessionIds, listWorkspaceIds, mapBounded, readSessionSummaryResult, sessionStateFingerprint } from './sessionIndexSource';

export interface ArchiveFamilySummaryCache {
  get(workspaceId: string, sessionId: string, fingerprint: SessionSourceFingerprint): SessionSummary | undefined;
  set(workspaceId: string, sessionId: string, fingerprint: SessionSourceFingerprint, summary: SessionSummary): void;
}

const fallbackSummaryCaches = new WeakMap<IAtomicDocumentStore, Map<string, { readonly fingerprint: SessionSourceFingerprint; readonly summary: SessionSummary }>>();

function getFallbackSummaryCache(docs: IAtomicDocumentStore): ArchiveFamilySummaryCache {
  let map = fallbackSummaryCaches.get(docs);
  if (map === undefined) {
    map = new Map();
    fallbackSummaryCaches.set(docs, map);
  }
  return {
    get(workspaceId, sessionId, fingerprint) {
      const entry = map!.get(`${workspaceId}/${sessionId}`);
      return entry !== undefined && fingerprintEquals(entry.fingerprint, fingerprint) ? entry.summary : undefined;
    },
    set(workspaceId, sessionId, fingerprint, summary) {
      map!.set(`${workspaceId}/${sessionId}`, { fingerprint, summary });
    },
  };
}

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
  summaryCache?: ArchiveFamilySummaryCache,
): Promise<SessionSummary[]> {
  const started = Date.now();
  const deadline = started + 30_000;
  const entries: { workspaceId: string; sessionId: string }[] = [];
  const cache = summaryCache ?? getFallbackSummaryCache(docs);
  const checkBudget = (): void => {
    if (entries.length > 100_000 || Date.now() > deadline) {
      throw new Error2('internal', 'Attached conversation discovery exceeded its budget; no conversations were archived. Retry after reducing the session inventory.');
    }
  };
  try {
    const workspaceIds = await listWorkspaceIds(storage, sessionsScope, log);
    const workspaceSessionLists = await mapBounded(workspaceIds, 16, async (workspaceId) => {
      checkBudget();
      const sessionIds = await listSessionIds(storage, sessionsScope, workspaceId, log);
      return { workspaceId, sessionIds };
    });
    for (const { workspaceId, sessionIds } of workspaceSessionLists) {
      for (const sessionId of sessionIds) {
        entries.push({ workspaceId, sessionId });
        checkBudget();
      }
    }
    const useFastStatMeta =
      storage.statMeta !== undefined && storage.constructor?.name === 'FileStorageService';
    const fastFingerprint = async (workspaceId: string, sessionId: string): Promise<SessionSourceFingerprint> => {
      if (!useFastStatMeta) return sessionStateFingerprint(storage, sessionsScope, workspaceId, sessionId, log);
      const base = `${sessionsScope}/${workspaceId}/${sessionId}`;
      const nestedScope = `${base}/session-meta`;
      const statMeta = storage.statMeta!.bind(storage);
      const [direct, nested] = await Promise.all([
        statMeta(base, 'state.json').catch(() => undefined),
        statMeta(nestedScope, 'state.json').catch(() => undefined),
      ]);
      if (direct === undefined && nested === undefined) {
        return sessionStateFingerprint(storage, sessionsScope, workspaceId, sessionId, log);
      }
      return {
        directMtimeMs: direct?.mtimeMs ?? 0,
        directSize: direct?.size ?? 0,
        nestedMtimeMs: nested?.mtimeMs ?? 0,
        nestedSize: nested?.size ?? 0,
      };
    };
    const cachedOrigins = new Map<string, { readonly workspaceId: string; readonly fingerprint: SessionSourceFingerprint }>();
    const summaries = await mapBounded(entries, 32, async ({ workspaceId, sessionId }) => {
      checkBudget();
      const fingerprint = await fastFingerprint(workspaceId, sessionId);
      if (sessionId !== rootId && (fingerprint.directSize > 0 || fingerprint.nestedSize > 0)) {
        const cached = cache.get(workspaceId, sessionId, fingerprint);
        if (cached !== undefined) {
          cachedOrigins.set(sessionId, { workspaceId, fingerprint });
          return cached;
        }
      }
      const result = await readSessionSummaryResult(docs, sessionsScope, workspaceId, sessionId, log);
      checkBudget();
      if (result.kind === 'error') {
        throw new Error2('internal', `Cannot discover attached conversations: metadata for session ${sessionId} is unreadable. No conversations were archived.`, { cause: result.error });
      }
      if (result.kind === 'found') {
        cache.set(workspaceId, sessionId, fingerprint, result.summary);
        return result.summary;
      }
      return undefined;
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
    const cachedFamilyIndices: number[] = [];
    for (let index = 1; index < family.length; index++) {
      if (cachedOrigins.has(family[index]!.id)) cachedFamilyIndices.push(index);
    }
    if (cachedFamilyIndices.length > 0) {
      await mapBounded(cachedFamilyIndices, 16, async (familyIndex) => {
        checkBudget();
        const item = family[familyIndex]!;
        const origin = cachedOrigins.get(item.id)!;
        const result = await readSessionSummaryResult(docs, sessionsScope, origin.workspaceId, item.id, log);
        checkBudget();
        if (result.kind === 'error') {
          throw new Error2('internal', `Cannot discover attached conversations: metadata for session ${item.id} is unreadable. No conversations were archived.`, { cause: result.error });
        }
        if (result.kind === 'found') {
          cache.set(origin.workspaceId, item.id, origin.fingerprint, result.summary);
          family[familyIndex] = result.summary;
        }
        return undefined;
      });
    }
    log.info('session archive family discovered', { sessions_scanned: entries.length, family_count: family.length, duration_ms: Date.now() - started });
    return family;
  } catch (error) {
    log.warn('session archive family discovery failed', { sessions_scanned: entries.length, duration_ms: Date.now() - started, error: String(error) });
    throw error;
  }
}
