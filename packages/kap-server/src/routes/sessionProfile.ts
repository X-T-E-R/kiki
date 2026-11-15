import {
  ISessionContext,
  ISessionMetadata,
  type ISessionScopeHandle,
} from '@kiki/agent-core-v2';
import { PROMOTED_FROM_KEY } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import type { SessionWireFields } from '@kiki/agent-core-v2/app/sessionLegacy/sessionLegacy';
import type { UpdateSessionProfileRequest } from '@kiki/agent-core-v2/app/sessionLegacy/sessionProtocol';

function replaceCustomMetadata(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const custom = { ...patch };
  if (!Object.hasOwn(custom, PROMOTED_FROM_KEY) && existing !== undefined && Object.hasOwn(existing, PROMOTED_FROM_KEY)) {
    custom[PROMOTED_FROM_KEY] = existing[PROMOTED_FROM_KEY];
  }
  return custom;
}

export async function updateSessionProfile(
  session: ISessionScopeHandle,
  body: Pick<UpdateSessionProfileRequest, 'title' | 'private' | 'metadata'>,
): Promise<SessionWireFields> {
  const metadata = session.accessor.get(ISessionMetadata);

  if (typeof body.title === 'string') {
    await metadata.setTitle(body.title);
  }

  if (body.private !== undefined) {
    await metadata.update({ private: body.private });
  }

  const metadataPatch = body.metadata;
  if (metadataPatch !== undefined && Object.keys(metadataPatch).length > 0) {
    const current = await metadata.read();
    await metadata.update({ custom: replaceCustomMetadata(current.custom, metadataPatch as Record<string, unknown>) });
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
    archived: meta.archived,
    private: meta.private,
    archivedAt: meta.archivedAt,
    executionPhase: meta.executionPhase,
    custom: meta.custom,
  };
}
