import { describe, expect, it } from 'vitest';

import type { BridgeGrant, BridgeLink, BridgeStatus, ConnectionIdentity, RemoteConnection } from '@kiki/protocol';

import {
  inboundGrantThreadMessageDirection,
  listInboundGrantBridges,
  listRemotePairingBridges,
  remoteThreadMessageDirection,
  sanitizeRemoteWorkspaceLabel,
  threadMessageFactKey,
} from './threadBridges';

const NOW = 1_760_000_000_000;
const FUTURE = NOW + 365 * 24 * 3600 * 1000;

const LOCAL_IDENTITY: ConnectionIdentity = {
  homeId: '11111111-1111-4111-8111-111111111111',
  hostId: 'local-mac',
  protocol: 1,
};

const PEER_B: ConnectionIdentity = {
  homeId: '22222222-2222-4222-8222-222222222222',
  hostId: 'gpu-box',
  protocol: 1,
};

const PEER_C: ConnectionIdentity = {
  homeId: '33333333-3333-4333-8333-333333333333',
  hostId: 'writer-box',
  protocol: 1,
};

function makeRecord(overrides: Partial<RemoteConnection> = {}): RemoteConnection {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    label: 'Workstation B',
    endpoint: 'https://b.example.test',
    target: PEER_B,
    credentialRef: 'pair-b',
    purposes: ['gui', 'bridge'],
    enabled: true,
    backgroundSummary: true,
    state: 'online',
    activeLeases: 0,
    ...overrides,
  };
}

function makeGrant(overrides: Partial<BridgeGrant> = {}): BridgeGrant {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    revision: 1,
    enabled: true,
    revoked: false,
    createdAt: NOW - 10_000,
    source: PEER_B,
    target: LOCAL_IDENTITY,
    sourceScope: { workspaceId: 'wd_paper_0123456789ab' },
    targetScope: { workspaceId: 'wd_app_abcdef012345' },
    operations: ['read', 'send', 'wait'],
    expiresAt: FUTURE,
    pendingLimit: 20,
    messagesPerMinute: 60,
    location: 'network',
    label: 'Workstation B',
    ...overrides,
  };
}

function makeOutboundLink(connectionId: string, grantOverrides: Partial<BridgeGrant> = {}, linkEnabled = true): BridgeLink {
  return {
    connectionId,
    enabled: linkEnabled,
    grant: makeGrant({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      source: LOCAL_IDENTITY,
      target: PEER_B,
      sourceScope: { workspaceId: 'wd_app_abcdef012345' },
      targetScope: { workspaceId: 'wd_paper_0123456789ab' },
      ...grantOverrides,
    }),
  };
}

function makeStatus(inbound: BridgeGrant[] = [], outbound: BridgeLink[] = []): BridgeStatus {
  return {
    identity: LOCAL_IDENTITY,
    inboundEnabled: true,
    inbound,
    outbound,
  };
}

describe('remoteThreadMessageDirection', () => {
  const record = makeRecord();

  it('reports both ways when both outbound link and inbound grant are active', () => {
    const status = makeStatus([makeGrant()], [makeOutboundLink(record.id)]);
    expect(remoteThreadMessageDirection(record, status, NOW)).toBe('both');
  });

  it('reports outgoing only when only outbound link is active', () => {
    const status = makeStatus([], [makeOutboundLink(record.id)]);
    expect(remoteThreadMessageDirection(record, status, NOW)).toBe('outgoing');
  });

  it('reports incoming only when only inbound grant is active', () => {
    const status = makeStatus([makeGrant()], []);
    expect(remoteThreadMessageDirection(record, status, NOW)).toBe('incoming');
  });

  it('reports none when neither direction exists or entries belong to a different peer', () => {
    const otherStatus = makeStatus(
      [makeGrant({ source: PEER_C })],
      [makeOutboundLink('dddddddd-dddd-4ddd-8ddd-dddddddddddd', { target: PEER_C })],
    );
    expect(remoteThreadMessageDirection(record, otherStatus, NOW)).toBe('none');
  });

  it('ignores revoked, disabled, and expired entries when computing active flow direction', () => {
    const revokedStatus = makeStatus(
      [makeGrant({ revoked: true })],
      [makeOutboundLink(record.id, { revoked: true })],
    );
    expect(remoteThreadMessageDirection(record, revokedStatus, NOW)).toBe('none');

    const disabledLinkStatus = makeStatus(
      [makeGrant({ enabled: false })],
      [makeOutboundLink(record.id, {}, false)],
    );
    expect(remoteThreadMessageDirection(record, disabledLinkStatus, NOW)).toBe('none');

    const expiredStatus = makeStatus(
      [makeGrant({ expiresAt: NOW - 1 })],
      [makeOutboundLink(record.id, { expiresAt: NOW })],
    );
    expect(remoteThreadMessageDirection(record, expiredStatus, NOW)).toBe('none');
  });
});

describe('inboundGrantThreadMessageDirection & listing helpers', () => {
  const record = makeRecord();

  it('computes inbound grant direction from peer source identity', () => {
    const status = makeStatus([makeGrant()], [makeOutboundLink(record.id)]);
    expect(inboundGrantThreadMessageDirection({ source: PEER_B }, status, NOW)).toBe('both');
    expect(inboundGrantThreadMessageDirection({ source: PEER_C }, status, NOW)).toBe('none');
  });

  it('lists paused entries in panel so they can be re-enabled or revoked, while excluding revoked entries', () => {
    const pausedOutbound = makeOutboundLink(record.id, {}, false);
    const revokedInbound = makeGrant({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', revoked: true });
    const activeInbound = makeGrant();
    const status = makeStatus([revokedInbound, activeInbound], [pausedOutbound]);

    const entries = listRemotePairingBridges(record, status, NOW);
    expect(entries.map((entry) => ({ id: entry.id, direction: entry.direction, enabled: entry.enabled }))).toEqual([
      { id: pausedOutbound.grant.id, direction: 'outbound', enabled: false },
      { id: activeInbound.id, direction: 'inbound', enabled: true },
    ]);

    const inboundEntries = listInboundGrantBridges({ source: PEER_B }, status, NOW);
    expect(inboundEntries).toHaveLength(2);
  });

  it('maps fact keys including unreadable and strips raw wd_ hashes from remote workspace labels', () => {
    expect(threadMessageFactKey('unreadable')).toBe('st.remote.threadMessages.unreadable');
    expect(sanitizeRemoteWorkspaceLabel('wd_kiki-app_0123456789ab')).toBe('kiki-app');
    expect(sanitizeRemoteWorkspaceLabel('22222222-2222-4222-8222-222222222222')).toBeNull();
  });
});
