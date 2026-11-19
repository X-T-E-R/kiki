
import { join } from 'node:path';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { IRetainedUsageService } from '#/app/retainedUsage/retainedUsage';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionIndex, ISessionIndexMirror, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { buildSessionSummary } from '#/app/sessionIndex/sessionIndexSource';
import { IUsageFactStore } from '#/app/usageFacts/usageFactStore';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { FORKED_FROM_KEY, PROMOTED_FROM_KEY, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { normalizeSessionMeta, encodeSessionMeta, withoutAgentStatistics } from '#/session/sessionMetadata/sessionMetadataService';

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

function replaceCustomMetadata(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const custom = { ...patch };
  for (const key of [PROMOTED_FROM_KEY, FORKED_FROM_KEY, 'goal']) {
    if (!Object.hasOwn(custom, key) && existing !== undefined && Object.hasOwn(existing, key)) {
      custom[key] = existing[key];
    }
  }
  return custom;
}

export async function setColdSessionArchived(
  accessor: ServicesAccessor,
  sessionId: string,
  archived: boolean,
): Promise<ColdSessionArchiveOutcome> {
  const outcome = await setColdArchived(archiveServices(accessor), sessionId, archived);
  return outcome.kind === 'updated' ? 'updated' : 'not_found';
}

export function restoreColdSession(
  accessor: ServicesAccessor,
  sessionId: string,
): Promise<ColdSessionProfileOutcome> {
  return setColdArchived(archiveServices(accessor), sessionId, false);
}

async function setColdArchived(
  { index, docs, bootstrap, mirror, event }: ArchiveServices,
  sessionId: string,
  archived: boolean,
  discovered?: SessionSummary,
): Promise<ColdSessionProfileOutcome> {
  const summary = discovered ?? await index.get(sessionId);
  if (summary === undefined) return { kind: 'not_found' };
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
  if (raw === undefined) return { kind: 'not_found' };
  const persisted = normalizeSessionMeta(raw, sessionId);
  const archivedAt = archived ? persisted.archived ? persisted.archivedAt : Date.now() : undefined;
  const nextMeta: SessionMeta = { ...persisted, archived, archivedAt };
  const cwd = nextMeta.cwd ?? summary.cwd;
  const encoded = encodeSessionMeta(nextMeta);
  await docs.set(metaScope, 'state.json', encoded, { cooperative: true });
  if (legacyMetaScope !== undefined) await docs.delete(legacyMetaScope, 'state.json');
  mirror.record(
    buildSessionSummary({
      ...encoded,
      id: sessionId,
      workspaceId: summary.workspaceId,
      cwd,
    }),
  );
  if (archived && !persisted.archived) {
    event.publish(new SessionArchived({ payload: { sessionId } }));
  }
  return { kind: 'updated', workspaceId: summary.workspaceId, cwd, meta: nextMeta };
}

export async function tryDeleteColdSession(
  accessor: ServicesAccessor,
  summary: SessionSummary,
): Promise<boolean> {
  let bootstrap: IBootstrapService;
  let hostFs: IHostFileSystem;
  let retainedUsage: IRetainedUsageService;
  let appendLogStore: IAppendLogStore;
  let index: ISessionIndex;
  try {
    bootstrap = accessor.get(IBootstrapService);
    hostFs = accessor.get(IHostFileSystem);
    retainedUsage = accessor.get(IRetainedUsageService);
    appendLogStore = accessor.get(IAppendLogStore);
    index = accessor.get(ISessionIndex);
  } catch {
    return false;
  }
  const sessionScope = sessionScopeOf(
    workspacePersistenceScope(bootstrap.scope('sessions'), summary.workspaceId),
    summary.id,
  );
  await retainedUsage.retainDeletedSession(summary);
  await hostFs.remove(join(bootstrap.homeDir, sessionScope));
  await index.remove(summary.id);
  appendLogStore.append('', 'session_index.jsonl', { sessionId: summary.id, deleted: true });
  await appendLogStore.flush('', 'session_index.jsonl');
  return true;
}

export interface ColdSessionProfilePatch {
  readonly title?: string;
  readonly private?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export type ColdSessionProfileOutcome =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'updated'; readonly workspaceId: string; readonly cwd?: string; readonly meta: SessionMeta };

export function updateColdSessionProfile(
  accessor: ServicesAccessor,
  sessionId: string,
  patch: ColdSessionProfilePatch,
): Promise<ColdSessionProfileOutcome> {
  const services = archiveServices(accessor);
  const usageFacts = patch.private === undefined ? undefined : accessor.get(IUsageFactStore);
  return applyColdProfilePatch(services, usageFacts, sessionId, patch);
}

async function applyColdProfilePatch(
  { index, docs, bootstrap, mirror }: ArchiveServices,
  usageFacts: IUsageFactStore | undefined,
  sessionId: string,
  patch: ColdSessionProfilePatch,
): Promise<ColdSessionProfileOutcome> {
  const summary = await index.get(sessionId);
  if (summary === undefined) return { kind: 'not_found' };
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
  if (raw === undefined) return { kind: 'not_found' };
  const persisted = normalizeSessionMeta(raw, sessionId);
  const hasTitle = typeof patch.title === 'string';
  const hasPrivate = patch.private !== undefined;
  const hasCustom = patch.metadata !== undefined && Object.keys(patch.metadata).length > 0;
  if (!hasTitle && !hasPrivate && !hasCustom && legacyMetaScope === undefined) {
    return { kind: 'updated', workspaceId: summary.workspaceId, cwd: persisted.cwd ?? summary.cwd, meta: persisted };
  }
  const isPrivate = patch.private ?? persisted.private;
  const nextMeta: SessionMeta = {
    ...persisted,
    title: hasTitle ? patch.title : persisted.title,
    titleKind: hasTitle ? 'custom' : persisted.titleKind,
    private: isPrivate,
    agents: isPrivate === true && persisted.private !== true ? withoutAgentStatistics(persisted.agents) : persisted.agents,
    usage: isPrivate === true ? undefined : persisted.usage,
    custom: hasCustom ? replaceCustomMetadata(persisted.custom, patch.metadata) : persisted.custom,
    updatedAt: hasPrivate || hasCustom ? Date.now() : persisted.updatedAt,
  };
  const cwd = nextMeta.cwd ?? summary.cwd;
  if (patch.private === true && usageFacts !== undefined) {
    await usageFacts.setSessionPrivacy(buildSessionSummary({ ...nextMeta, id: sessionId, workspaceId: summary.workspaceId, cwd }));
  }
  const encoded = encodeSessionMeta(nextMeta);
  await docs.set(metaScope, 'state.json', encoded, { cooperative: true });
  if (legacyMetaScope !== undefined) await docs.delete(legacyMetaScope, 'state.json');
  const updatedSummary = buildSessionSummary({ ...encoded, id: sessionId, workspaceId: summary.workspaceId, cwd });
  if (patch.private === false && usageFacts !== undefined) {
    await usageFacts.setSessionPrivacy(updatedSummary);
  }
  mirror.record(updatedSummary);
  return { kind: 'updated', workspaceId: summary.workspaceId, cwd, meta: nextMeta };
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
        return outcome.kind === 'updated'
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
