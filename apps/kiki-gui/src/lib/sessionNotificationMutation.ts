import type { QueryClient } from '@tanstack/react-query';
import type { Session } from '@kiki/protocol';
import {
  notificationMetadataPatch,
  patchSidebarUnitRow,
  SESSION_NOTIFICATION_MODE_META_KEY,
  sessionNotificationMode,
  type SessionListData,
  type SessionNotificationMode,
  type SidebarUnitPagesData,
} from '@kiki/session-core/sessions';

import type { KikiClient } from './client';

export function applyNotificationMetadata(
  entry: Session,
  mode: SessionNotificationMode,
  serverUpdated?: Session,
): Session {
  const base =
    serverUpdated !== undefined && serverUpdated !== null && typeof serverUpdated === 'object' && 'id' in serverUpdated
      ? serverUpdated
      : entry;
  const nextMetadata: Record<string, unknown> = {
    ...entry.metadata,
    ...(base.metadata ?? {}),
    cwd: base.metadata?.cwd ?? entry.metadata.cwd,
  };
  if (mode === 'all') delete nextMetadata[SESSION_NOTIFICATION_MODE_META_KEY];
  else nextMetadata[SESSION_NOTIFICATION_MODE_META_KEY] = mode;
  return {
    ...base,
    metadata: nextMetadata as Session['metadata'],
  };
}

export function patchSessionNotificationCaches(
  queryClient: QueryClient,
  sessionId: string,
  transform: (entry: Session) => Session,
  mode: SessionNotificationMode,
): void {
  const wireMode = mode === 'all' ? undefined : mode;
  queryClient.setQueriesData<SessionListData>({ queryKey: ['sessions'] }, (old) =>
    old === undefined || !Array.isArray(old.pages)
      ? old
      : {
          ...old,
          pages: old.pages.map((page) => (!Array.isArray(page?.items) ? page : {
            ...page,
            items: page.items.map((entry) => (entry.id === sessionId ? transform(entry) : entry)),
          })),
        },
  );
  queryClient.setQueriesData<SidebarUnitPagesData>({ queryKey: ['sessions', 'sidebar-units'] }, (old) =>
    patchSidebarUnitRow(old, sessionId, (row) => ({ ...row, notifications: wireMode })),
  );
  queryClient.setQueriesData<SidebarUnitPagesData>({ queryKey: ['sessions', 'sidebar-units-pinned'] }, (old) =>
    patchSidebarUnitRow(old, sessionId, (row) => ({ ...row, notifications: wireMode })),
  );
  if (queryClient.getQueryData(['session', sessionId]) !== undefined) {
    queryClient.setQueryData<Session>(['session', sessionId], (old) =>
      old === undefined ? old : transform(old),
    );
  }
}

export async function updateSessionNotificationMode(options: {
  readonly client: Pick<KikiClient, 'updateSessionProfile'> & Partial<Pick<KikiClient, 'getSession'>>;
  readonly queryClient: QueryClient | undefined;
  readonly session: Session;
  readonly mode: SessionNotificationMode;
}): Promise<Session | undefined> {
  const { client, queryClient, session, mode } = options;
  const hadPreviousKey = Object.hasOwn(session.metadata, SESSION_NOTIFICATION_MODE_META_KEY);
  const previousRawValue = session.metadata[SESSION_NOTIFICATION_MODE_META_KEY];
  const previousMode = sessionNotificationMode(session);

  if (queryClient !== undefined) {
    patchSessionNotificationCaches(
      queryClient,
      session.id,
      (entry) => applyNotificationMetadata(entry, mode),
      mode,
    );
  }
  try {
    // Read the authoritative session before replacing `metadata` so mutations
    // triggered from bounded `SidebarRow` projections never drop unknown keys.
    const authoritative =
      typeof client.getSession === 'function'
        ? await client.getSession(session.id)
        : session;
    const metadata = notificationMetadataPatch(authoritative, mode);
    const updated = await client.updateSessionProfile(session.id, { metadata });
    if (queryClient !== undefined) {
      patchSessionNotificationCaches(
        queryClient,
        session.id,
        (entry) => applyNotificationMetadata(entry, mode, updated ?? { ...authoritative, metadata: metadata as Session['metadata'] }),
        mode,
      );
    }
    return updated;
  } catch (error: unknown) {
    if (queryClient !== undefined) {
      patchSessionNotificationCaches(
        queryClient,
        session.id,
        (entry) => {
          const restored: Record<string, unknown> = { ...entry.metadata };
          if (hadPreviousKey) restored[SESSION_NOTIFICATION_MODE_META_KEY] = previousRawValue;
          else delete restored[SESSION_NOTIFICATION_MODE_META_KEY];
          return { ...entry, metadata: restored as Session['metadata'] };
        },
        previousMode,
      );
    }
    throw error;
  }
}
