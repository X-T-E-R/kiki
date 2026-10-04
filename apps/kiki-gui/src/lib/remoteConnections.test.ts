// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import type { RemoteConnection } from '@kiki/protocol';

import {
  browsableRemote, connectionAddress, connectionIdOfSpaceKey, endpointIssue, fingerprint, identityBlock,
  invitationBlock, labelIssue, readIdentityBlock, readInvitationBlock, remoteSpaceKey, remoteSpaceScope,
  remoteSummaryView, purposeKeys,
} from './remoteConnections';
import { configureSpaceStorage } from './spaceStorage';
import { readHomeViewRoute, writeSpaceViewRoute } from './spaceViewState';
import { connectionFailureText } from '../components/settings/remote/parts';

const A = '9d5b4bd0-8f2b-4a1f-9f37-52c1b48a1a01';
const B = '7b1f5a36-9d24-4e58-b1c7-6f30a2e8b604';
const identity = { homeId: '0f4c6e1a-2b7d-4a3e-9c11-7d0a51b2c301', hostId: 'gpu-box', protocol: 1 as const };

function record(overrides: Partial<RemoteConnection> = {}): RemoteConnection {
  return {
    id: A, label: 'Workstation B', endpoint: 'https://b.example.test:8443', target: identity,
    credentialRef: A, purposes: ['gui'], enabled: true, backgroundSummary: false, state: 'online', activeLeases: 0,
    ...overrides,
  };
}

describe('remote space keys', () => {
  it('round-trips a connection id and refuses anything else', () => {
    expect(remoteSpaceKey(A)).toBe(`remote:${A}`);
    expect(connectionIdOfSpaceKey(`remote:${A}`)).toBe(A);
    expect(connectionIdOfSpaceKey('main')).toBeNull();
    expect(connectionIdOfSpaceKey('remote:not-a-uuid')).toBeNull();
    expect(remoteSpaceScope(A)).toEqual({ homeId: `remote:${A}`, scopeId: `remote:${A}` });
  });

  it('keeps two connections’ reading positions apart even with the same session id', () => {
    configureSpaceStorage({ homeId: remoteSpaceKey(A) });
    writeSpaceViewRoute('/s/shared-id', remoteSpaceKey(A));
    configureSpaceStorage({ homeId: remoteSpaceKey(B) });
    expect(readHomeViewRoute(remoteSpaceKey(B), remoteSpaceKey(B))).toBeUndefined();
    writeSpaceViewRoute('/s/other-id', remoteSpaceKey(B));
    configureSpaceStorage({ homeId: remoteSpaceKey(A) });
    expect(readHomeViewRoute(remoteSpaceKey(A), remoteSpaceKey(A))).toBe('/s/shared-id');
    configureSpaceStorage({ homeId: remoteSpaceKey(B) });
    expect(readHomeViewRoute(remoteSpaceKey(B), remoteSpaceKey(B))).toBe('/s/other-id');
    configureSpaceStorage(null);
  });
});

describe('purpose and state', () => {
  it('only a browsable connection is a space', () => {
    expect(browsableRemote(record())).toBe(true);
    expect(browsableRemote(record({ purposes: ['bridge'] }))).toBe(false);
    expect(browsableRemote(record({ enabled: false }))).toBe(false);
    expect(browsableRemote(record({ state: 'disabled' }))).toBe(false);
    // A connection waiting for approval is still the person's space to open.
    expect(browsableRemote(record({ state: 'authentication_required' }))).toBe(true);
  });

  it('labels the purposes the record really carries', () => {
    expect(purposeKeys(record({ purposes: ['gui'] }))).toEqual(['st.remote.purpose.gui']);
    expect(purposeKeys(record({ purposes: ['bridge'] }))).toEqual(['st.remote.purpose.bridge']);
    expect(purposeKeys(record({ purposes: ['gui', 'bridge'] }))).toEqual(['st.remote.purpose.gui', 'st.remote.purpose.bridge']);
  });
});

describe('readings that survive an offline peer', () => {
  const summary = { value: { online: true as const, busy_sessions: 3, needs_you_sessions: 2, revision: 'r-1', as_of: 5 }, lastSeen: 1_000, stale: false };

  it('shows the last known counts and marks an old reading', () => {
    const fresh = remoteSummaryView(record({ summary }), 30_000);
    expect(fresh).toEqual({ busy: 3, needsYou: 2, asOf: 1_000, stale: false });
    const stale = remoteSummaryView(record({ summary }), 1_000 + 120_000);
    expect(stale?.stale).toBe(true);
    expect(stale?.busy).toBe(3);
    expect(remoteSummaryView(record(), 30_000)).toBeNull();
  });

  it('keeps the server’s own stale flag', () => {
    expect(remoteSummaryView(record({ summary: { ...summary, stale: true } }), 1_100)?.stale).toBe(true);
  });

  it('reads an address without the scheme or path', () => {
    expect(connectionAddress('https://b.example.test:8443')).toBe('b.example.test:8443');
    expect(connectionAddress('https://b.example.test')).toBe('b.example.test');
    expect(connectionAddress('not a url')).toBe('not a url');
  });

  it('keeps a long id recognizable without printing all of it', () => {
    expect(fingerprint(identity.homeId)).toBe('0f4c6e1a…c301');
    expect(fingerprint('short')).toBe('short');
  });
});

describe('what the person carries between two Kikis', () => {
  it('round-trips an identity block', () => {
    const parsed = readIdentityBlock(identityBlock(identity, 'Workstation B'));
    expect(parsed).toEqual({ ok: true, identity, label: 'Workstation B' });
  });

  it('round-trips an invitation with its target identity', () => {
    const token = 'kiki-invitation-token-0000000000000000000000';
    const parsed = readInvitationBlock(invitationBlock({ invitation: token, target: identity, label: 'Home laptop' }));
    expect(parsed).toEqual({ ok: true, invitation: token, target: identity, label: 'Home laptop' });
  });

  it('refuses a bare code instead of inventing a target', () => {
    const token = 'kiki-invitation-token-0000000000000000000000';
    expect(readInvitationBlock(token)).toEqual({ ok: false, problem: 'st.remote.paste.targetMissing' });
    expect(readIdentityBlock(token)).toEqual({ ok: false, problem: 'st.remote.paste.invitationOnly' });
  });

  it('refuses malformed or mismatched blocks', () => {
    expect(readInvitationBlock('{ not json')).toEqual({ ok: false, problem: 'st.remote.paste.invalid' });
    expect(readInvitationBlock(identityBlock(identity))).toEqual({ ok: false, problem: 'st.remote.paste.notInvitation' });
    expect(readIdentityBlock(invitationBlock({ invitation: 'x'.repeat(40), target: identity }))).toEqual({ ok: false, problem: 'st.remote.paste.notIdentity' });
    expect(readInvitationBlock(JSON.stringify({ kiki: 'kiki.connection-invitation/1', invitation: 'x'.repeat(40) })))
      .toEqual({ ok: false, problem: 'st.remote.paste.targetMissing' });
    // A target that is not a real identity is not accepted either.
    expect(readInvitationBlock(JSON.stringify({ kiki: 'kiki.connection-invitation/1', invitation: 'x'.repeat(40), target: { homeId: 'nope', hostId: 'h', protocol: 1 } })))
      .toEqual({ ok: false, problem: 'st.remote.paste.targetMissing' });
    // A future protocol is not this contract.
    expect(readIdentityBlock(JSON.stringify({ kiki: 'kiki.identity/1', identity: { ...identity, protocol: 2 } })))
      .toEqual({ ok: false, problem: 'st.remote.paste.notIdentity' });
  });
});

describe('field checks', () => {
  it('accepts the addresses the server accepts, and refuses the rest', () => {
    expect(endpointIssue('https://b.example.test')).toBeNull();
    expect(endpointIssue('http://127.0.0.1:5523')).toBeNull();
    expect(endpointIssue('http://localhost:5523')).toBeNull();
    expect(endpointIssue('http://192.168.1.40:5523')).toBe('st.remote.endpoint.tls');
    expect(endpointIssue('https://user:pass@b.example.test')).toBe('st.remote.endpoint.invalid');
    expect(endpointIssue('https://b.example.test/api')).toBe('st.remote.endpoint.invalid');
    expect(endpointIssue('https://b.example.test?x=1')).toBe('st.remote.endpoint.invalid');
    expect(endpointIssue('b.example.test')).toBe('st.remote.endpoint.invalid');
    expect(endpointIssue('')).toBe('st.remote.endpoint.required');
  });

  it('requires a name the connection can carry', () => {
    expect(labelIssue('Workstation B')).toBeNull();
    expect(labelIssue('   ')).toBe('st.remote.label.required');
    expect(labelIssue('x'.repeat(129))).toBe('st.remote.label.tooLong');
  });
});

describe('server refusals in the person’s terms', () => {
  it('maps the reasons the connection layer states', () => {
    expect(connectionFailureText('inbound_disabled')).toBe('st.remote.fail.inboundDisabled');
    expect(connectionFailureText('identity_changed')).toBe('st.remote.fail.identity');
    expect(connectionFailureText('connection_requires_tls')).toBe('st.remote.endpoint.tls');
    expect(connectionFailureText('gui_connection_required')).toBe('st.remote.fail.guiRequired');
  });

  it('leaves an unknown reason for the caller to pass through', () => {
    expect(connectionFailureText('something_new')).toBeNull();
  });
});
