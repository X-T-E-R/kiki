
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionIndex, ISessionIndexMirror, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { buildSessionSummary } from '#/app/sessionIndex/sessionIndexSource';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { normalizeSessionMeta, encodeSessionMeta } from '#/session/sessionMetadata/sessionMetadataService';

import { sessionScopeOf, legacySessionMetaScopeOf, workspacePersistenceScope } from './internal/addressing';
import { SessionArchived } from './sessionLifecycleEvents';

export type ColdSessionArchiveOutcome = 'updated' | 'not_found';

function archiveServices(accessor: ServicesAccessor) {
  return {
    index: accessor.get(ISessionIndex),
    docs: accessor.get(IAtomicDocumentStore),
    bootstrap: accessor.get(IBootstrapService),
    mirror: accessor.get(ISessionIndexMirror),
    event: accessor.get(IEventService),
  };
}

type ArchiveServices = ReturnType<typeof archiveServices>;

export function setColdSessionArchived(
  accessor: ServicesAccessor,
  sessionId: string,
  archived: boolean,
): Promise<ColdSessionArchiveOutcome> {
  return setColdArchived(archiveServices(accessor), sessionId, archived);
}

async function setColdArchived(
  { index, docs, bootstrap, mirror, event }: ArchiveServices,
  sessionId: string,
  archived: boolean,
  discovered?: SessionSummary,
): Promise<ColdSessionArchiveOutcome> {
  const summary = discovered ?? await index.get(sessionId);
  if (summary === undefined) return 'not_found';
  const metaScope = sessionScopeOf(
    workspacePersistenceScope(
      bootstrap.scope('sessions'),
      summary.workspaceId,
    ),
    sessionId,
  );
  let raw = await docs.get<SessionMeta>(metaScope, 'state.json');
  let legacyMetaScope: string | undefined;
  if (raw === undefined) {
    legacyMetaScope = legacySessionMetaScopeOf(metaScope);
    raw = await docs.get<SessionMeta>(legacyMetaScope, 'state.json');
  }
  if (raw === undefined) return 'not_found';
  const persisted = normalizeSessionMeta(raw, sessionId);
  const archivedAt = archived ? persisted.archived ? persisted.archivedAt : Date.now() : undefined;
  const nextMeta: SessionMeta = { ...persisted, archived, archivedAt };
  await docs.set(metaScope, 'state.json', encodeSessionMeta(nextMeta));
  if (legacyMetaScope !== undefined) await docs.delete(legacyMetaScope, 'state.json');
  mirror.record(
    buildSessionSummary({
      id: sessionId,
      workspaceId: summary.workspaceId,
      cwd: nextMeta.cwd ?? summary.cwd,
      title: nextMeta.title,
      lastPrompt: nextMeta.lastPrompt,
      delivery: nextMeta.delivery,
      createdAt: nextMeta.createdAt,
      updatedAt: nextMeta.updatedAt,
      activityUpdatedAt: nextMeta.activityUpdatedAt,
      archived,
      archivedAt,
      custom: nextMeta.custom,
      worktree: nextMeta.worktree,
      usage: nextMeta.usage,
      agents: nextMeta.agents,
      lastTurnReason: nextMeta.lastTurnReason,
    }),
  );
  if (archived && !persisted.archived) {
    event.publish(new SessionArchived({ payload: { sessionId } }));
  }
  return 'updated';
}

export type SessionArchiveBatchItemOutcome =
  | { id: string; ok: true }
  | { id: string; ok: false; reason: 'not_found' | 'error'; message: string };

export function setSessionArchivedBatch(
  accessor: ServicesAccessor,
  ids: readonly string[],
  archived: boolean,
): Promise<SessionArchiveBatchItemOutcome[]> {
  return setArchivedBatch(archiveServices(accessor), accessor.get(ISessionManager), ids, archived);
}

async function setArchivedBatch(
  services: ArchiveServices,
  manager: ISessionManager,
  ids: readonly string[],
  archived: boolean,
  discovered?: ReadonlyMap<string, SessionSummary>,
): Promise<SessionArchiveBatchItemOutcome[]> {
  const outcomes: (SessionArchiveBatchItemOutcome | undefined)[] = ids.map(() => undefined);
  const applyOne = async (id: string): Promise<SessionArchiveBatchItemOutcome> => {
    try {
      return await manager.withLifecycleSerialization(id, async (unguarded) => {
        const live = manager.get(id);
        if (live !== undefined) {
          if (archived) await unguarded.archive();
          else await unguarded.restore();
          return { id, ok: true };
        }
        const outcome = await setColdArchived(services, id, archived, discovered?.get(id));
        return outcome === 'updated'
          ? { id, ok: true }
          : { id, ok: false, reason: 'not_found', message: `session ${id} does not exist` };
      });
    } catch (error) {
      return {
        id,
        ok: false,
        reason: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const BATCH_CONCURRENCY = 8;
  let next = 0;
  const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, ids.length) }, async () => {
    while (next < ids.length) {
      const index = next++;
      outcomes[index] = await applyOne(ids[index] as string);
    }
  });
  await Promise.all(workers);
  return outcomes as SessionArchiveBatchItemOutcome[];
}

export async function archiveSessionFamily(
  accessor: ServicesAccessor,
  id: string,
  excludedIds: readonly string[] = [],
): Promise<SessionArchiveBatchItemOutcome[]> {
  const services = archiveServices(accessor);
  const manager = accessor.get(ISessionManager);
  const family = await services.index.archiveFamily(id, excludedIds);
  if (family.length === 0) return [{ id, ok: false, reason: 'not_found', message: `session ${id} does not exist` }];
  return setArchivedBatch(services, manager, family.map((summary) => summary.id), true, new Map(family.map((summary) => [summary.id, summary])));
}
