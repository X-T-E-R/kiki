import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionIndex, ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import {
  SESSION_GROUP_DETACHED_KEY,
  SESSION_GROUP_GENERATION_KEY,
  SESSION_GROUP_ID_KEY,
  SESSION_GROUP_ORIGIN_KEY,
  deriveSessionGroupToken,
  explicitSessionGroupId,
  isSessionGroupDetached,
  parseSessionGroupGeneration,
  resolveHomeGroupOrigin,
} from '#/app/sessionIndex/sessionGroup';
import { buildSessionSummary } from '#/app/sessionIndex/sessionIndexSource';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { Error2, ErrorCodes } from '#/errors';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { encodeSessionMeta, normalizeSessionMeta } from '#/session/sessionMetadata/sessionMetadataService';

import { legacySessionMetaScopeOf, sessionScopeOf, workspacePersistenceScope } from './internal/addressing';

export interface EnsuredSessionGroup {
  readonly groupId: string;
  readonly originKey: string;
}

export interface DetachedSessionGroup {
  readonly detached: boolean;
  readonly sessionId: string;
  readonly previousGroupId?: string;
}

function nextEnsuredCustom(
  current: Record<string, unknown>,
  sessionId: string,
  originKey: string,
  indexedGroupId: string | undefined,
): { readonly groupId: string; readonly custom: Record<string, unknown>; readonly changed: boolean } {
  const existing = explicitSessionGroupId(current);
  if (existing !== undefined) {
    return { groupId: existing, custom: current, changed: false };
  }
  if (isSessionGroupDetached(current)) {
    const nextGen = parseSessionGroupGeneration(current) + 1;
    const groupId = deriveSessionGroupToken(originKey, sessionId, nextGen);
    const custom: Record<string, unknown> = { ...current };
    delete custom[SESSION_GROUP_DETACHED_KEY];
    delete custom[SESSION_GROUP_ORIGIN_KEY];
    custom[SESSION_GROUP_ID_KEY] = groupId;
    custom[SESSION_GROUP_GENERATION_KEY] = nextGen;
    return { groupId, custom, changed: true };
  }
  const gen = parseSessionGroupGeneration(current);
  const groupId = indexedGroupId ?? deriveSessionGroupToken(originKey, sessionId, gen);
  const custom: Record<string, unknown> = { ...current, [SESSION_GROUP_ID_KEY]: groupId };
  if (gen > 0) custom[SESSION_GROUP_GENERATION_KEY] = gen;
  return { groupId, custom, changed: true };
}

function nextDetachedCustom(current: Record<string, unknown>): Record<string, unknown> {
  const nextGen = Math.max(1, parseSessionGroupGeneration(current) + 1);
  const custom: Record<string, unknown> = { ...current };
  delete custom[SESSION_GROUP_ID_KEY];
  delete custom[SESSION_GROUP_ORIGIN_KEY];
  custom[SESSION_GROUP_DETACHED_KEY] = true;
  custom[SESSION_GROUP_GENERATION_KEY] = nextGen;
  return custom;
}

export async function ensureSessionGroupUnguarded(
  accessor: ServicesAccessor,
  sessionId: string,
): Promise<EnsuredSessionGroup> {
  const bootstrap = accessor.get(IBootstrapService);
  const storage = accessor.get(IFileSystemStorageService);
  const index = accessor.get(ISessionIndex);
  const manager = accessor.get(ISessionManager);
  const docs = accessor.get(IAtomicDocumentStore);
  const mirror = accessor.get(ISessionIndexMirror);
  const originKey = await resolveHomeGroupOrigin(bootstrap.homeDir, storage);
  const indexedSummary = await index.get(sessionId);
  const live = manager.get(sessionId);
  if (live !== undefined) {
    const metadata = live.accessor.get(ISessionMetadata);
    let resolvedGroupId = '';
    if (metadata.updateCustom !== undefined) {
      await metadata.updateCustom(
        (current) => {
          const decision = nextEnsuredCustom(current, sessionId, originKey, indexedSummary?.groupId);
          resolvedGroupId = decision.groupId;
          return decision.custom;
        },
        { touchUpdatedAt: false, allowReservedGroupWrite: true },
      );
    } else {
      const meta = await metadata.read();
      const decision = nextEnsuredCustom(meta.custom ?? {}, sessionId, originKey, indexedSummary?.groupId);
      resolvedGroupId = decision.groupId;
      if (decision.changed) {
        await metadata.update(
          { custom: decision.custom },
          { touchUpdatedAt: false, allowReservedGroupWrite: true },
        );
      }
    }
    return { groupId: resolvedGroupId, originKey };
  }
  if (indexedSummary === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  const metaScope = sessionScopeOf(
    workspacePersistenceScope(bootstrap.scope('sessions'), indexedSummary.workspaceId),
    sessionId,
  );
  let raw = await docs.get<SessionMeta>(metaScope, 'state.json');
  let legacyMetaScope: string | undefined;
  if (raw === undefined) {
    legacyMetaScope = legacySessionMetaScopeOf(metaScope);
    raw = await docs.get<SessionMeta>(legacyMetaScope, 'state.json');
  }
  if (raw === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  const persisted = normalizeSessionMeta(raw, sessionId);
  const decision = nextEnsuredCustom(persisted.custom ?? {}, sessionId, originKey, indexedSummary.groupId);
  if (decision.changed || legacyMetaScope !== undefined) {
    const nextMeta: SessionMeta = { ...persisted, custom: decision.custom };
    const encoded = encodeSessionMeta(nextMeta);
    await docs.set(metaScope, 'state.json', encoded, { cooperative: true });
    if (legacyMetaScope !== undefined) await docs.delete(legacyMetaScope, 'state.json');
    mirror.record(buildSessionSummary({
      ...encoded,
      id: sessionId,
      workspaceId: indexedSummary.workspaceId,
      cwd: nextMeta.cwd ?? indexedSummary.cwd,
    }));
  }
  return { groupId: decision.groupId, originKey };
}

export async function detachSessionGroupUnguarded(
  accessor: ServicesAccessor,
  sessionId: string,
): Promise<DetachedSessionGroup> {
  const bootstrap = accessor.get(IBootstrapService);
  const index = accessor.get(ISessionIndex);
  const manager = accessor.get(ISessionManager);
  const docs = accessor.get(IAtomicDocumentStore);
  const mirror = accessor.get(ISessionIndexMirror);
  const indexedSummary = await index.get(sessionId);
  const live = manager.get(sessionId);
  if (live !== undefined) {
    const metadata = live.accessor.get(ISessionMetadata);
    let previousGroupId = indexedSummary?.groupId;
    if (metadata.updateCustom !== undefined) {
      await metadata.updateCustom(
        (current) => {
          previousGroupId = explicitSessionGroupId(current) ?? previousGroupId;
          return nextDetachedCustom(current);
        },
        { touchUpdatedAt: false, allowReservedGroupWrite: true },
      );
    } else {
      const meta = await metadata.read();
      const current = meta.custom ?? {};
      previousGroupId = explicitSessionGroupId(current) ?? previousGroupId;
      await metadata.update(
        { custom: nextDetachedCustom(current) },
        { touchUpdatedAt: false, allowReservedGroupWrite: true },
      );
    }
    return { detached: true, sessionId, previousGroupId };
  }
  if (indexedSummary === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  const metaScope = sessionScopeOf(
    workspacePersistenceScope(bootstrap.scope('sessions'), indexedSummary.workspaceId),
    sessionId,
  );
  let raw = await docs.get<SessionMeta>(metaScope, 'state.json');
  let legacyMetaScope: string | undefined;
  if (raw === undefined) {
    legacyMetaScope = legacySessionMetaScopeOf(metaScope);
    raw = await docs.get<SessionMeta>(legacyMetaScope, 'state.json');
  }
  if (raw === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  const persisted = normalizeSessionMeta(raw, sessionId);
  const current = persisted.custom ?? {};
  const previousGroupId = explicitSessionGroupId(current) ?? indexedSummary.groupId;
  const nextMeta: SessionMeta = { ...persisted, custom: nextDetachedCustom(current) };
  const encoded = encodeSessionMeta(nextMeta);
  await docs.set(metaScope, 'state.json', encoded, { cooperative: true });
  if (legacyMetaScope !== undefined) await docs.delete(legacyMetaScope, 'state.json');
  mirror.record(buildSessionSummary({
    ...encoded,
    id: sessionId,
    workspaceId: indexedSummary.workspaceId,
    cwd: nextMeta.cwd ?? indexedSummary.cwd,
  }));
  return { detached: true, sessionId, previousGroupId };
}
