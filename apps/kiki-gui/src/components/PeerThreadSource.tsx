import { useCallback, useMemo } from 'react';

import type { UserBlock } from '@kiki/session-core/session';
import { shortThreadId, threadRefLink } from '@kiki/session-core/composer';

import { useI18n } from '../i18n';
import { useThreadRefDirectory } from '../lib/threadRefs';
import { useOptionalConnection } from '../state/connection';
import { useGuardedNavigate } from './dirtyGuard';

export function PeerThreadSource({ source }: { source: NonNullable<UserBlock['peerThread']> }) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const navigate = useGuardedNavigate();
  const sessionId = source.sessionId;
  const ids = useMemo(() => sessionId === undefined ? [] : [sessionId], [sessionId]);
  const fetchSession = useCallback((id: string) => connection!.client.getSession(id), [connection?.client]);
  const fetchHost = useCallback(() => connection!.klient.global.threads.hostId(), [connection?.klient]);
  const directory = useThreadRefDirectory(ids, connection === null ? undefined : fetchSession,
    connection === null ? undefined : fetchHost, source.hostId);
  const sameHost = source.hostId === undefined || source.hostId === directory.hostId;
  const entry = sessionId === undefined || !sameHost ? undefined : directory.lookup(sessionId);
  const session = entry?.session;
  const sameWorkspace = source.workspaceId === undefined || session === undefined || source.workspaceId === session.workspace_id;
  const title = sameWorkspace ? session?.title.trim() || undefined : undefined;
  const label = t('agentMessage.fromThread', { id: title ?? (sessionId === undefined ? '?' : shortThreadId(sessionId)) });
  const detail = [title, sessionId, entry?.workspace?.name, source.workspaceId ?? session?.workspace_id, source.hostId ?? directory.hostId,
    connection?.meta?.server_home_id, source.senderName].filter((part): part is string => part !== undefined && part !== '').join('\n');
  const attrs = { 'data-peer-thread': sessionId, title: detail, 'aria-label': `${label}\n${detail}` };
  const className = 'min-w-0 max-w-full truncate text-[12px] font-medium text-ink-soft';
  if (sessionId === undefined || connection === null || !sameHost || !sameWorkspace) {
    return <span {...attrs} className={className}>{label}</span>;
  }
  const href = threadRefLink(sessionId);
  const scope = { homeId: connection.spaceKey, scopeId: connection.scopeId,
    serverHomeId: connection.meta?.server_home_id, connectionRef: connection.connectionRef };
  return (
    <a
      {...attrs}
      href={href}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        void navigate(href, { state: { kikiNav: { scope } } });
      }}
      className={`${className} -mx-1 rounded-md px-1 no-underline transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink`}
    >
      {label}
    </a>
  );
}
