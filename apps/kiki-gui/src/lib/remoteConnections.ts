/**
 * Remote Kiki connections, GUI side: the space-switcher entries ("remote
 * spaces") and the two lists on Settings → Spaces — "Kikis I connect to"
 * (outbound) and "Kikis allowed to connect to me" (inbound).
 *
 * The records, the allow list and every credential live in the local control
 * home's server (`/api/remote-connections`); this window is a thin client that
 * holds none of them. A remote space is a real scope (`remote:<connectionId>`)
 * whose client reaches the remote Kiki through that home's broker, so two
 * connections that happen to share a session id never share a query cache, a
 * controller, a draft or a reading position.
 *
 * Between two Kikis the person moves three things by hand: this Kiki's identity,
 * an invitation, and the resulting connection form. `identityBlock` and
 * `invitationBlock` are that transfer format — one paste block each, carrying
 * the real target identity so nobody retypes a UUID.
 */

import { useQuery } from '@tanstack/react-query';

import type { ConnectionsFacade } from '@kiki/klient/http';
import type { ConnectionIdentity, RemoteConnection, SshRemoteProfile } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

import type { KikiClient } from './client';
import { readHomeViewRoute } from './spaceViewState';

export const REMOTE_SPACE_PREFIX = 'remote:';
const CONNECTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_PATTERN = CONNECTION_ID_PATTERN;
/** Past this age a space summary is shown as a stale reading, not as "now". */
export const REMOTE_SUMMARY_STALE_MS = 60_000;
const BLOCK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function isConnectionId(value: string): boolean {
  return CONNECTION_ID_PATTERN.test(value);
}

/** The storage/route/scope key of one remote space. */
export function remoteSpaceKey(connectionId: string): string {
  return `${REMOTE_SPACE_PREFIX}${connectionId}`;
}

/** The connection a space key names, or null for a local space. */
export function connectionIdOfSpaceKey(spaceKey: string): string | null {
  if (!spaceKey.startsWith(REMOTE_SPACE_PREFIX)) return null;
  const id = spaceKey.slice(REMOTE_SPACE_PREFIX.length);
  return isConnectionId(id) ? id : null;
}

/** The nav-scope identity pair a remote space is entered and compared by. */
export function remoteSpaceScope(connectionId: string): { readonly homeId: string; readonly scopeId: string } {
  const key = remoteSpaceKey(connectionId);
  return { homeId: key, scopeId: key };
}

/** A remote space's last page, or undefined when it has never been there. */
export function remoteViewRoute(connectionId: string): string | undefined {
  const key = remoteSpaceKey(connectionId);
  return readHomeViewRoute(key, key);
}

export const remoteConnectionKeys = {
  all: ['remote-connections'] as const,
  list: () => [...remoteConnectionKeys.all, 'list'] as const,
  inbound: () => [...remoteConnectionKeys.all, 'inbound'] as const,
};

/** The connection control surface. Only a local/control client may own this. */
export function connectionsApi(client: KikiClient): ConnectionsFacade {
  const rest = client.klient.rest;
  if (rest === undefined) throw new Error('Remote connections need an HTTP connection to the server.');
  return rest.connections;
}

export function useRemoteConnections(client: KikiClient | null) {
  return useQuery({
    queryKey: remoteConnectionKeys.list(),
    queryFn: async () => {
      if (client === null) throw new Error('The local control connection is not ready.');
      return connectionsApi(client).list();
    },
    enabled: client !== null,
    refetchInterval: 8_000,
    staleTime: 4_000,
  });
}

export function useInboundStatus(client: KikiClient | null) {
  return useQuery({
    queryKey: remoteConnectionKeys.inbound(),
    queryFn: async () => {
      if (client === null) throw new Error('The local control connection is not ready.');
      return connectionsApi(client).inbound();
    },
    enabled: client !== null,
    refetchInterval: 8_000,
    staleTime: 4_000,
  });
}

// ---------------------------------------------------------------------------
// Purpose and state, as the record really says them.
// ---------------------------------------------------------------------------

/** Browsing (spaces, sessions, chat) is one purpose among several. */
export function hasGuiPurpose(record: RemoteConnection): boolean {
  return record.purposes.includes('gui');
}

/** A remote space can be entered: browsing allowed, switched on, not refused. */
export function browsableRemote(record: RemoteConnection): boolean {
  return hasGuiPurpose(record) && record.enabled && record.state !== 'disabled';
}

/** Purpose labels for the management rows; never inferred from the entry's existence. */
export function purposeKeys(record: RemoteConnection): I18nKey[] {
  const keys: I18nKey[] = [];
  if (hasGuiPurpose(record)) keys.push('st.remote.purpose.gui');
  if (record.purposes.includes('bridge')) keys.push('st.remote.purpose.bridge');
  return keys;
}

export function connectionStateKey(state: RemoteConnection['state']): I18nKey {
  return `st.remote.state.${state}` as I18nKey;
}

export type RemoteStateTone = 'online' | 'attention' | 'offline' | 'muted';

export function connectionStateTone(state: RemoteConnection['state']): RemoteStateTone {
  if (state === 'online') return 'online';
  if (state === 'authentication_required' || state === 'identity_changed') return 'attention';
  if (state === 'disabled') return 'muted';
  return 'offline';
}

// ---------------------------------------------------------------------------
// Readings that stay honest when the other side is away.
// ---------------------------------------------------------------------------

export interface RemoteSummaryView {
  readonly busy: number;
  readonly needsYou: number;
  readonly asOf: number | undefined;
  readonly stale: boolean;
}

/**
 * Busy and waiting counts from the last background summary. Offline keeps the
 * last known numbers and marks them stale; nothing is shown as a fresh zero.
 */
export function remoteSummaryView(record: RemoteConnection, now = Date.now()): RemoteSummaryView | null {
  const summary = record.summary;
  if (summary === undefined) return null;
  return {
    busy: summary.value.busy_sessions,
    needsYou: summary.value.needs_you_sessions,
    asOf: summary.lastSeen,
    stale: summary.stale || now - summary.lastSeen > REMOTE_SUMMARY_STALE_MS,
  };
}

/** `host:port` — the address belongs in the secondary position, never the name. */
export function connectionAddress(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return url.port === '' ? url.hostname : `${url.hostname}:${url.port}`;
  } catch {
    return endpoint;
  }
}

/** A UUID/host id that is recognizable without printing the whole thing. */
export function fingerprint(value: string, head = 8, tail = 4): string {
  const text = value.trim();
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

// ---------------------------------------------------------------------------
// What the person carries between the two machines.
// ---------------------------------------------------------------------------

const IDENTITY_BLOCK_KIND = 'kiki.identity/1';
const INVITATION_BLOCK_KIND = 'kiki.connection-invitation/1';

function isIdentity(value: unknown): value is ConnectionIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<ConnectionIdentity>;
  return typeof record.homeId === 'string' && UUID_PATTERN.test(record.homeId) &&
    typeof record.hostId === 'string' && record.hostId !== '' && record.hostId.length <= 128 && record.protocol === 1;
}

/** This Kiki's own identity, to send to the other machine's owner. */
export function identityBlock(identity: ConnectionIdentity, label?: string): string {
  return JSON.stringify({ kiki: IDENTITY_BLOCK_KIND, identity, label });
}

/** The invitation issued on the other Kiki, with the target identity it binds. */
export function invitationBlock(input: { readonly invitation: string; readonly target: ConnectionIdentity; readonly label?: string }): string {
  return JSON.stringify({ kiki: INVITATION_BLOCK_KIND, invitation: input.invitation, target: input.target, label: input.label });
}

export type IdentityBlockRead =
  | { readonly ok: true; readonly identity: ConnectionIdentity; readonly label?: string }
  | { readonly ok: false; readonly problem: I18nKey };

export type InvitationBlockRead =
  | { readonly ok: true; readonly invitation: string; readonly target: ConnectionIdentity; readonly label?: string }
  | { readonly ok: false; readonly problem: I18nKey };

function parseBlock(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text.trim());
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function readIdentityBlock(text: string): IdentityBlockRead {
  if (BLOCK_TOKEN_PATTERN.test(text.trim())) return { ok: false, problem: 'st.remote.paste.invitationOnly' };
  const block = parseBlock(text);
  if (block === null) return { ok: false, problem: 'st.remote.paste.invalid' };
  if (block['kiki'] !== IDENTITY_BLOCK_KIND || !isIdentity(block['identity'])) return { ok: false, problem: 'st.remote.paste.notIdentity' };
  const label = typeof block['label'] === 'string' && block['label'] !== '' ? block['label'] : undefined;
  return { ok: true, identity: block['identity'], label };
}

export function readInvitationBlock(text: string): InvitationBlockRead {
  // A bare code is a real thing a person can paste; it just cannot carry the
  // target identity, which the connection form must send back unchanged.
  if (BLOCK_TOKEN_PATTERN.test(text.trim())) return { ok: false, problem: 'st.remote.paste.targetMissing' };
  const block = parseBlock(text);
  if (block === null) return { ok: false, problem: 'st.remote.paste.invalid' };
  if (block['kiki'] !== INVITATION_BLOCK_KIND) return { ok: false, problem: 'st.remote.paste.notInvitation' };
  const invitation = block['invitation'];
  if (typeof invitation !== 'string' || !BLOCK_TOKEN_PATTERN.test(invitation)) return { ok: false, problem: 'st.remote.paste.invalid' };
  if (!isIdentity(block['target'])) return { ok: false, problem: 'st.remote.paste.targetMissing' };
  const label = typeof block['label'] === 'string' && block['label'] !== '' ? block['label'] : undefined;
  return { ok: true, invitation, target: block['target'], label };
}

/**
 * The typed profile an SSH plan takes, from a profile the person already saved.
 * `home@` is how the OpenSSH-style root carries the user; a saved host that
 * names one keeps it, and an alias is passed through as the alias it is.
 */
export function remoteProfileFor(host: {
  readonly id: string;
  readonly name: string;
  readonly hostname?: string | undefined;
  readonly user?: string | undefined;
  readonly port?: number | undefined;
  readonly identityFile?: string | undefined;
  readonly roots?: readonly string[] | undefined;
}, defaultHome: string): SshRemoteProfile {
  const first = (host.roots ?? [])[0] ?? defaultHome;
  const home = first.replace(/^home@/, '');
  return {
    id: host.id,
    label: host.name,
    target: host.hostname === undefined || host.hostname === ''
      ? { kind: 'alias', alias: host.id }
      : { kind: 'host', hostname: host.hostname, username: host.user, port: host.port },
    identityFile: host.identityFile,
    releaseChannel: 'stable',
    remoteHome: home,
    remoteExecutable: 'kiki',
    remoteShell: 'posix',
  };
}

/** The `home@host:port` a saved profile points at, for its own summary line. */
export function sshRemoteHomeLabel(profile: SshRemoteProfile): string {
  const host = profile.target.kind === 'host' ? profile.target.hostname : profile.target.alias;
  return `home@${host}${profile.target.kind === 'host' && profile.target.port !== undefined ? `:${profile.target.port}` : ''}`;
}

// ---------------------------------------------------------------------------
// Field checks the server would also make, said before the round trip.
// ---------------------------------------------------------------------------

/** Mirrors the server's endpoint rules so the answer arrives while typing. */
export function endpointIssue(raw: string): I18nKey | null {
  const text = raw.trim();
  if (text === '') return 'st.remote.endpoint.required';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'st.remote.endpoint.invalid';
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' ||
      url.search !== '' || url.hash !== '' || (url.pathname !== '/' && url.pathname !== '')) {
    return 'st.remote.endpoint.invalid';
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return 'st.remote.endpoint.tls';
  return null;
}

export function labelIssue(raw: string): I18nKey | null {
  const text = raw.trim();
  if (text === '') return 'st.remote.label.required';
  return text.length > 128 ? 'st.remote.label.tooLong' : null;
}
