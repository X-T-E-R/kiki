import {
  detachSessionSharedCasAliases,
  ISessionContext,
  ISessionMetadata,
  preserveReservedSessionGroupKeys,
  type ISessionScopeHandle,
} from '@kiki/agent-core-v2';
import { FORKED_FROM_KEY, PROMOTED_FROM_KEY } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import type { UpdateSessionProfileRequest } from '@kiki/agent-core-v2/app/sessionLegacy/sessionProtocol';
import type { SessionWireFields } from './sessions';

function replaceCustomMetadata(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const custom = preserveReservedSessionGroupKeys(existing, patch);
  for (const key of [PROMOTED_FROM_KEY, FORKED_FROM_KEY, 'goal']) {
    if (!Object.hasOwn(custom, key) && existing !== undefined && Object.hasOwn(existing, key)) {
      custom[key] = existing[key];
    }
  }
  return custom;
}

export async function updateSessionProfile(
  session: ISessionScopeHandle,
  body: Pick<UpdateSessionProfileRequest, 'title' | 'private' | 'metadata'>,
): Promise<SessionWireFields & { readonly root: string }> {
  const metadata = session.accessor.get(ISessionMetadata);

  if (typeof body.title === 'string') {
    await metadata.setTitle(body.title);
  }

  if (body.private !== undefined) {
    await metadata.update({ private: body.private });
    if (body.private === true) {
      const ctxForDetach = session.accessor.get(ISessionContext);
      if (ctxForDetach.sessionDir.length > 0) {
        await detachSessionSharedCasAliases(ctxForDetach.sessionDir);
      }
    }
  }

  const metadataPatch = body.metadata;
  if (metadataPatch !== undefined && Object.keys(metadataPatch).length > 0) {
    if (metadata.updateCustom !== undefined) {
      await metadata.updateCustom((current) =>
        replaceCustomMetadata(current, metadataPatch as Record<string, unknown>),
      );
    } else {
      const current = await metadata.read();
      await metadata.update({ custom: replaceCustomMetadata(current.custom, metadataPatch as Record<string, unknown>) });
    }
  }

  const meta = await metadata.read();
  const ctx = session.accessor.get(ISessionContext);
  return {
    id: meta.id,
    workspaceId: ctx.workspaceId,
    root: ctx.cwd,
    title: meta.title,
    lastPrompt: meta.lastPrompt,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ownUpdatedAt: meta.updatedAt,
    activityUpdatedAt: meta.activityUpdatedAt,
    archived: meta.archived,
    private: meta.private,
    archivedAt: meta.archivedAt,
    executionPhase: meta.executionPhase,
    worktree: meta.worktree,
    promotedFrom: meta.promotedFrom,
    delivery: meta.delivery,
    agents: meta.agents,
    lastTurnReason: meta.lastTurnReason,
    interruptedWork: meta.interruptedWork,
    activeRunBootId: meta.activeRunBootId,
    custom: meta.custom,
  };
}
