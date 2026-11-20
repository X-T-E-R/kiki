/**
 * Session Mesh leases & loopback port tunnels: the GUI side of the wired
 * `klient.rest.mesh` contract. Reads stay graceful when `klient.rest.mesh` is
 * absent (such as minimal test stubs or older transports).
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import type {
  HumanTakeoverLease,
  LeasedPortTunnel,
  LeasedWorkspaceCopy,
  MeshContextProjection,
  MeshLeaseUnpinInput,
  MeshSessionLease,
} from '@kiki/protocol';

import type { KikiClient } from './client';
import { isLocalOwnerRequiredError } from './peerAccess';

export type {
  HumanTakeoverLease,
  LeasedPeerNode,
  LeasedPortTunnel,
  LeasedSeat,
  LeasedWorkspaceCopy,
  MeshContextProjection,
  MeshLeaseUnpinInput,
  MeshSessionLease,
} from '@kiki/protocol';

export const meshKeys = {
  all: ['mesh'] as const,
  sessionLease: (sessionId: string) => ['mesh', 'session-lease', sessionId] as const,
  takeover: (targetIds: readonly string[]) => ['mesh', 'takeover', ...targetIds] as const,
};

export type MeshRest = NonNullable<KikiClient['klient']['rest']>['mesh'];

export function meshApi(client: KikiClient): Partial<MeshRest> | undefined {
  return client.klient?.rest?.mesh;
}

export function formatTunnelEndpoint(tunnel: Pick<LeasedPortTunnel, 'localHost' | 'localPort' | 'remotePort'>): string {
  const host = tunnel.localHost === '' ? '127.0.0.1' : tunnel.localHost;
  return `${host}:${tunnel.localPort} → ${tunnel.remotePort}`;
}

export function formatCopyLabel(copy: Pick<LeasedWorkspaceCopy, 'copyId' | 'sourceRoot'>): string {
  const normalized = copy.sourceRoot.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter((part) => part !== '');
  return parts.at(-1) ?? copy.copyId;
}

export function countMeshLeaseItems(lease: MeshSessionLease | undefined): number {
  if (lease === undefined) return 0;
  return lease.nodes.length + lease.seats.length + lease.workspaceCopies.length + lease.portTunnels.length;
}

export function primaryMeshLabel(lease: MeshSessionLease | undefined): string | undefined {
  if (lease === undefined) return undefined;
  if (lease.nodes[0] !== undefined) return lease.nodes[0].label;
  if (lease.seats[0] !== undefined) return lease.seats[0].label;
  if (lease.workspaceCopies[0] !== undefined) return formatCopyLabel(lease.workspaceCopies[0]);
  if (lease.portTunnels[0] !== undefined) return formatTunnelEndpoint(lease.portTunnels[0]);
  return undefined;
}

export type MeshSummaryTone = 'danger' | 'warn';

export function meshSummaryTone(lease: MeshSessionLease | undefined): MeshSummaryTone | undefined {
  if (lease === undefined) return undefined;
  const hasDanger =
    lease.nodes.some((node) => node.state === 'offline') ||
    lease.seats.some((seat) => seat.state === 'failed' || seat.state === 'offline') ||
    lease.portTunnels.some((tunnel) => !tunnel.healthy);
  if (hasDanger) return 'danger';
  const hasWarn =
    lease.nodes.some((node) => node.state === 'degraded') ||
    lease.seats.some((seat) => seat.state === 'blocked') ||
    lease.workspaceCopies.some((copy) => copy.dirty);
  if (hasWarn) return 'warn';
  return undefined;
}

export function collectMeshTargetIds(lease: MeshSessionLease | undefined): readonly string[] {
  if (lease === undefined) return [];
  const ids = new Set<string>();
  for (const node of lease.nodes) ids.add(node.nodeId);
  for (const seat of lease.seats) {
    ids.add(seat.seatId);
    ids.add(seat.nodeId);
  }
  for (const copy of lease.workspaceCopies) ids.add(copy.nodeId);
  return [...ids].toSorted();
}

export function useSessionMeshLease(
  client: KikiClient,
  sessionId: string | undefined,
  enabled = true,
) {
  const api = meshApi(client);
  const canQuery = enabled && sessionId !== undefined && typeof api?.getSessionLease === 'function';
  return useQuery({
    queryKey: meshKeys.sessionLease(sessionId ?? ''),
    queryFn: async (): Promise<MeshContextProjection | null> => {
      if (api?.getSessionLease === undefined || sessionId === undefined) return null;
      return api.getSessionLease(sessionId);
    },
    enabled: canQuery,
    retry: (failureCount, error) => !isLocalOwnerRequiredError(error) && failureCount < 1,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
}

export function useMeshHumanTakeovers(
  client: KikiClient,
  targetIds: readonly string[],
  enabled: boolean,
): ReadonlyMap<string, HumanTakeoverLease> {
  const api = meshApi(client);
  const canQuery = enabled && targetIds.length > 0 && typeof api?.inspectTakeover === 'function';
  const query = useQuery({
    queryKey: meshKeys.takeover(targetIds),
    queryFn: async (): Promise<readonly (readonly [string, HumanTakeoverLease])[]> => {
      if (api?.inspectTakeover === undefined) return [];
      const inspect = api.inspectTakeover;
      const now = Date.now();
      const settled = await Promise.allSettled(
        targetIds.map(async (targetId) => {
          const response = await inspect(targetId);
          return [targetId, response.lease] as const;
        }),
      );
      const entries: Array<readonly [string, HumanTakeoverLease]> = [];
      for (const result of settled) {
        if (result.status !== 'fulfilled') continue;
        const [targetId, lease] = result.value;
        if (lease !== null && lease.holder === 'human' && lease.expiresAt > now) {
          entries.push([targetId, lease]);
        }
      }
      return entries;
    },
    enabled: canQuery,
    retry: false,
    staleTime: 5_000,
  });

  return useMemo(() => new Map(query.data ?? []), [query.data]);
}
