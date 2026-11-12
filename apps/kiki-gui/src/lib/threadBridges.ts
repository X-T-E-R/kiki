/**
 * Thread-message permissions on pairings (`/api/thread-bridges`).
 *
 * A pairing row on Spaces ("Spaces on other computers") or Access ("Other
 * spaces") states whether thread messages flow outgoing, incoming, both ways,
 * or not at all — or "can't read" when the status call failed. All reads and
 * writes target this window's own control home (`localClient`), never a paired
 * space on another computer.
 */

import { useQuery } from '@tanstack/react-query';

import type { HttpRestFacade } from '@kiki/klient/http';
import type {
  BridgeGrant,
  BridgeLink,
  BridgeOperation,
  BridgePolicy,
  BridgeStatus,
  ConnectionGrant,
  ConnectionIdentity,
  RemoteConnection,
} from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

import type { KikiClient } from './client';

export type ThreadBridgesFacade = HttpRestFacade['threadBridges'];
export type BridgeScope = BridgePolicy['sourceScope'];

export type ThreadMessageDirection = 'both' | 'outgoing' | 'incoming' | 'none';
export type ThreadMessageFact = ThreadMessageDirection | 'unreadable';

export interface PairingBridgeEntry {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly grant: BridgeGrant;
  /** Effective enabled state (`link.enabled && grant.enabled` for outbound, `grant.enabled` for inbound). */
  readonly enabled: boolean;
  readonly expired: boolean;
  readonly localScope: BridgeScope;
  readonly remoteScope: BridgeScope;
  readonly operations: readonly BridgeOperation[];
}

export const threadBridgeKeys = {
  all: ['thread-bridges'] as const,
  status: () => [...threadBridgeKeys.all, 'status'] as const,
  localWorkspaces: () => [...threadBridgeKeys.all, 'local-workspaces'] as const,
};

export function hasThreadBridgesApi(client: KikiClient | null): boolean {
  return client !== null && client.klient?.rest?.threadBridges !== undefined;
}

export function threadBridgesApi(client: KikiClient): ThreadBridgesFacade {
  const rest = client.klient.rest;
  if (rest?.threadBridges === undefined) {
    throw new Error('Thread-message permissions need an HTTP connection to the server.');
  }
  return rest.threadBridges;
}

export function useThreadBridges(client: KikiClient | null) {
  return useQuery({
    queryKey: [...threadBridgeKeys.status(), client?.baseUrl ?? null],
    queryFn: async () => {
      if (client === null) throw new Error('The local control connection is not ready.');
      return threadBridgesApi(client).status();
    },
    enabled: hasThreadBridgesApi(client),
    refetchInterval: 8_000,
    staleTime: 4_000,
  });
}

export function samePeerIdentity(a: ConnectionIdentity, b: ConnectionIdentity): boolean {
  return a.homeId === b.homeId && a.hostId === b.hostId;
}

function isLinkActive(link: BridgeLink, now: number): boolean {
  return link.enabled && !link.grant.revoked && link.grant.enabled && link.grant.expiresAt > now;
}

function isGrantActive(grant: BridgeGrant, now: number): boolean {
  return !grant.revoked && grant.enabled && grant.expiresAt > now;
}

/**
 * Active thread-message direction for an outbound `RemoteConnection`.
 *
 * - outgoing: an `outbound` link with `connectionId === record.id`, not revoked, enabled, and not expired;
 * - incoming: an `inbound` grant whose `source` (`homeId`, `hostId`) matches `record.target`, not revoked, enabled, and not expired.
 */
export function remoteThreadMessageDirection(
  record: Pick<RemoteConnection, 'id' | 'target'>,
  status: BridgeStatus,
  now: number = Date.now(),
): ThreadMessageDirection {
  const hasOutgoing = status.outbound.some(
    (link) => link.connectionId === record.id && isLinkActive(link, now),
  );
  const hasIncoming = status.inbound.some(
    (grant) => samePeerIdentity(grant.source, record.target) && isGrantActive(grant, now),
  );
  if (hasOutgoing && hasIncoming) return 'both';
  if (hasOutgoing) return 'outgoing';
  if (hasIncoming) return 'incoming';
  return 'none';
}

/**
 * Active thread-message direction for an inbound `ConnectionGrant` on the Access page.
 *
 * - incoming: an `inbound` grant whose `source` matches `grant.source`;
 * - outgoing: an `outbound` link whose `grant.target` matches `grant.source`.
 */
export function inboundGrantThreadMessageDirection(
  peerGrant: Pick<ConnectionGrant, 'source'>,
  status: BridgeStatus,
  now: number = Date.now(),
): ThreadMessageDirection {
  const hasIncoming = status.inbound.some(
    (grant) => samePeerIdentity(grant.source, peerGrant.source) && isGrantActive(grant, now),
  );
  const hasOutgoing = status.outbound.some(
    (link) => samePeerIdentity(link.grant.target, peerGrant.source) && isLinkActive(link, now),
  );
  if (hasOutgoing && hasIncoming) return 'both';
  if (hasOutgoing) return 'outgoing';
  if (hasIncoming) return 'incoming';
  return 'none';
}

export function threadMessageFactKey(fact: ThreadMessageFact): I18nKey {
  switch (fact) {
    case 'both':
      return 'st.remote.threadMessages.both';
    case 'outgoing':
      return 'st.remote.threadMessages.outgoing';
    case 'incoming':
      return 'st.remote.threadMessages.incoming';
    case 'none':
      return 'st.remote.threadMessages.none';
    case 'unreadable':
      return 'st.remote.threadMessages.unreadable';
  }
}

/**
 * Non-revoked thread-message entries belonging to one outbound pairing
 * (including paused or expired entries so the owner can inspect, re-enable, or
 * revoke them in the panel).
 */
export function listRemotePairingBridges(
  record: Pick<RemoteConnection, 'id' | 'target'>,
  status: BridgeStatus,
  now: number = Date.now(),
): PairingBridgeEntry[] {
  const entries: PairingBridgeEntry[] = [];
  for (const link of status.outbound) {
    if (link.connectionId !== record.id || link.grant.revoked) continue;
    entries.push({
      id: link.grant.id,
      direction: 'outbound',
      grant: link.grant,
      enabled: link.enabled && link.grant.enabled,
      expired: link.grant.expiresAt <= now,
      localScope: link.grant.sourceScope,
      remoteScope: link.grant.targetScope,
      operations: link.grant.operations,
    });
  }
  for (const grant of status.inbound) {
    if (!samePeerIdentity(grant.source, record.target) || grant.revoked) continue;
    entries.push({
      id: grant.id,
      direction: 'inbound',
      grant,
      enabled: grant.enabled,
      expired: grant.expiresAt <= now,
      localScope: grant.targetScope,
      remoteScope: grant.sourceScope,
      operations: grant.operations,
    });
  }
  return entries;
}

/**
 * Non-revoked thread-message entries belonging to one inbound `ConnectionGrant`
 * on Settings → Access → Other spaces.
 */
export function listInboundGrantBridges(
  peerGrant: Pick<ConnectionGrant, 'source'>,
  status: BridgeStatus,
  now: number = Date.now(),
): PairingBridgeEntry[] {
  const entries: PairingBridgeEntry[] = [];
  for (const grant of status.inbound) {
    if (!samePeerIdentity(grant.source, peerGrant.source) || grant.revoked) continue;
    entries.push({
      id: grant.id,
      direction: 'inbound',
      grant,
      enabled: grant.enabled,
      expired: grant.expiresAt <= now,
      localScope: grant.targetScope,
      remoteScope: grant.sourceScope,
      operations: grant.operations,
    });
  }
  for (const link of status.outbound) {
    if (!samePeerIdentity(link.grant.target, peerGrant.source) || link.grant.revoked) continue;
    entries.push({
      id: link.grant.id,
      direction: 'outbound',
      grant: link.grant,
      enabled: link.enabled && link.grant.enabled,
      expired: link.grant.expiresAt <= now,
      localScope: link.grant.sourceScope,
      remoteScope: link.grant.targetScope,
      operations: link.grant.operations,
    });
  }
  return entries;
}

const RAW_WORKSPACE_ID_RE = /^wd_([a-z0-9._-]+)_[0-9a-f]{12}$/i;
const UUID_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Human-readable workspace label for the remote side without exposing raw
 * `wd_<slug>_<hash12>` or UUID identifiers. Extracts the readable folder slug
 * when present, or returns `null` so the caller uses its neutral fallback.
 */
export function sanitizeRemoteWorkspaceLabel(workspaceId: string): string | null {
  const trimmed = workspaceId.trim();
  if (trimmed === '' || UUID_LIKE_RE.test(trimmed)) return null;
  const match = RAW_WORKSPACE_ID_RE.exec(trimmed);
  if (match !== null) {
    const slug = match[1]?.trim() ?? '';
    if (slug === '' || UUID_LIKE_RE.test(slug)) return null;
    return slug;
  }
  if (/^[0-9a-f]{16,}$/i.test(trimmed)) return null;
  return trimmed;
}
