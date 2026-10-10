import { CONNECTION_PROTOCOL, type MetaResponse } from '@kiki/protocol';
import { RPCError } from '@kiki/klient';
import type { HostAdapter } from '../host';
import type { ConnectionSelection } from '../state/connectionConfig';
import { API_CODES, ApiError, createRemoteSpaceClient, KikiClient } from './client';
import { ScopeRestoreError, type ScopeConnectionAdapter } from './navScope';
import type { NavScopeIdentity } from './navHistory';
import { parseActiveSpacePayload } from './spaceStorage';

/** A guarded windows-mode action: no source selection or Router visit is committed. */
export async function openRemoteScopeWindow(host: Pick<HostAdapter, 'openRemoteSpace'>, scope: NavScopeIdentity, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const id = scope.scopeId.slice(7);
  if (scope.homeId !== scope.scopeId || !scope.scopeId.startsWith('remote:') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new ScopeRestoreError('scope-invalid');
  if (host.openRemoteSpace === undefined) throw new ScopeRestoreError('scope-invalid');
  await host.openRemoteSpace(id);
  signal.throwIfAborted();
}

export interface ScopeConnectionOptions {
  host: HostAdapter;
  active: () => { scope: NavScopeIdentity; selection: ConnectionSelection; client: KikiClient };
  local: () => { selection: ConnectionSelection; client: KikiClient } | null;
  control?: () => { selection: ConnectionSelection; client: KikiClient } | null;
  commit: (selection: ConnectionSelection, client: KikiClient, meta: MetaResponse) => void;
  reload: () => void;
  preparing?: (active: boolean) => void;
  createClient?: (selection: ConnectionSelection) => KikiClient;
}

export async function validateScopeRoute(client: KikiClient, route: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const pathname = new URL(route, 'http://example.test').pathname;
  const sessionId = /^\/s\/([^/]+)/.exec(pathname)?.[1];
  const roomId = /^\/(?:rooms|r)\/([^/]+)$/.exec(pathname)?.[1];
  try {
    if (sessionId !== undefined) {
      await client.getSession(decodeURIComponent(sessionId));
      signal.throwIfAborted();
      const agentId = /^\/s\/[^/]+\/agent\/([^/]+)$/.exec(pathname)?.[1];
      if (agentId !== undefined && decodeURIComponent(agentId) !== 'main') {
        const agents = await client.klient.session(decodeURIComponent(sessionId)).agents();
        if (!Object.hasOwn(agents, decodeURIComponent(agentId))) throw new ScopeRestoreError('target-missing');
      }
    }
    if (roomId !== undefined) {
      // Use the same room facade as createBotRoomApi, without importing its
      // React connection hook back into ConnectionProvider's adapter.
      const rest = client.klient.rest;
      if (rest === undefined) throw new ScopeRestoreError('offline');
      if ((await rest.rooms.get(decodeURIComponent(roomId))) === undefined) throw new ScopeRestoreError('target-missing');
    }
  } catch (error) {
    if (sessionId !== undefined && error instanceof ApiError && error.code === API_CODES.SESSION_NOT_FOUND) throw new ScopeRestoreError('target-missing');
    // REST rooms.get uses this precise REQUEST_INVALID envelope for absence;
    // an arbitrary 400/404, missing prompt/block, or malformed response is not deletion.
    if (roomId !== undefined && error instanceof RPCError && error.code === API_CODES.REQUEST_INVALID &&
        error.message === `Room '${decodeURIComponent(roomId)}' does not exist.`) throw new ScopeRestoreError('target-missing');
    if ((error instanceof ApiError || error instanceof RPCError) && error.code === API_CODES.UNAUTHORIZED) throw new ScopeRestoreError('auth-required');
    throw error;
  }
  signal.throwIfAborted();
}

/** Uses desktop discovery and the existing SSH profile/tunnel identity handshake. */
export function createScopeConnectionAdapter(options: ScopeConnectionOptions): ScopeConnectionAdapter {
  return {
    async prepare(scope, signal, token) {
      signal.throwIfAborted();
      const source = options.active();
      const crossHome = source.scope.homeId !== scope.homeId;
      if (!crossHome && scope.scopeId === source.scope.scopeId && token === undefined) {
        let meta: MetaResponse;
        try { meta = await source.client.meta(); }
        catch (error) {
          if ((error instanceof ApiError || error instanceof RPCError) && error.code === API_CODES.UNAUTHORIZED) throw new ScopeRestoreError('auth-required');
          throw error;
        }
        signal.throwIfAborted();
        const expectedHome = scope.serverHomeId ?? source.scope.serverHomeId;
        if ((expectedHome !== undefined && expectedHome !== meta.server_home_id) ||
            (scope.connectionRef !== undefined && scope.connectionRef !== source.scope.connectionRef)) throw new ScopeRestoreError('identity-mismatch');
        return { scope: { ...source.scope, serverHomeId: meta.server_home_id },
          validate: (route, nextSignal) => validateScopeRoute(source.client, route, nextSignal),
          commit: () => { signal.throwIfAborted(); }, dispose: () => {} };
      }
      let selection: ConnectionSelection;
      let instance: KikiClient | undefined;
      let ownsClient = false;
      let switchedHome = false;
      let sourceHomeId = source.scope.homeId;
      let returningControl = false;
      let tunnel: { id: string; tunnelId: string } | undefined;
      options.preparing?.(true);
      const dispose = async () => {
        try {
          if (ownsClient && instance !== undefined) { ownsClient = false; await instance.klient.close(); }
          if (tunnel !== undefined) { const created = tunnel; tunnel = undefined; await options.host.connection.disconnectSshProfile?.(created.id, created.tunnelId); }
          if (switchedHome) { switchedHome = false; await options.host.prepareSpace?.(sourceHomeId); }
        } finally { options.preparing?.(false); }
      };
      try {
        if (scope.scopeId.startsWith('remote:') || scope.homeId.startsWith('remote:')) {
          const id = scope.scopeId.slice(7);
          if (scope.homeId !== scope.scopeId || !scope.scopeId.startsWith('remote:') ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new ScopeRestoreError('scope-invalid');
          const control = options.control?.() ?? options.local();
          if (control === null || control.selection.source === 'remote' || control.selection.source === 'ssh') throw new ScopeRestoreError('offline');
          const connections = control.client.klient.rest?.connections;
          if (connections === undefined) throw new ScopeRestoreError('offline');
          const records = await connections.list();
          signal.throwIfAborted();
          const record = records.find((entry) => entry.id === id);
          if (record === undefined) throw new ScopeRestoreError('scope-invalid');
          if (record.enabled !== true || record.state === 'disabled' || record.target.protocol !== CONNECTION_PROTOCOL) throw new ScopeRestoreError('identity-mismatch');
          selection = { config: control.selection.config, persist: false, source: 'remote', scopeId: scope.scopeId,
            connectionId: record.id, serverHomeId: record.target.homeId };
          instance = options.createClient?.(selection) ?? createRemoteSpaceClient({ endpoint: selection.config.url,
            token: selection.config.token, connectionId: record.id });
          ownsClient = true;
          const meta = await instance.meta();
          signal.throwIfAborted();
          if (meta.server_home_id !== record.target.homeId ||
              (scope.serverHomeId !== undefined && scope.serverHomeId !== meta.server_home_id) ||
              (scope.connectionRef !== undefined && scope.connectionRef !== record.id)) throw new ScopeRestoreError('identity-mismatch');
          const verified = instance;
          return {
            scope: { ...scope, serverHomeId: meta.server_home_id, connectionRef: record.id },
            validate: (route, nextSignal) => validateScopeRoute(verified, route, nextSignal),
            commit: () => {
              signal.throwIfAborted();
              options.commit(selection, verified, meta);
              options.reload();
              ownsClient = false;
              options.preparing?.(false);
            },
            dispose,
          };
        }
        if (scope.scopeId.startsWith('ssh:') && !token && !scope.connectionRef) throw new ScopeRestoreError('auth-required');
        if (crossHome && source.selection.source === 'remote') {
          sourceHomeId = options.host.activeSpace === undefined ? 'main' : parseActiveSpacePayload(await options.host.activeSpace())?.homeId ?? 'main';
          signal.throwIfAborted();
          returningControl = scope.homeId === sourceHomeId && (scope.scopeId === 'local' || scope.scopeId.startsWith('direct:'));
        }
        if (crossHome && !returningControl) {
          if (!options.host.prepareSpace) throw new ScopeRestoreError('scope-invalid');
          const space = await options.host.prepareSpace(scope.homeId);
          switchedHome = true;
          signal.throwIfAborted();
          if (space.homeId !== scope.homeId) throw new ScopeRestoreError('identity-mismatch');
        }
        if (scope.scopeId.startsWith('ssh:')) {
          const id = scope.scopeId.slice(4);
          const profiles = await options.host.connection.listSshProfiles?.();
          signal.throwIfAborted();
          const profile = profiles?.find((entry) => entry.id === id);
          if (profile === undefined) throw new ScopeRestoreError('scope-invalid');
          if (!profile.serverHomeId || !profile.remotePort) throw new ScopeRestoreError('scope-invalid');
          let resolved;
          if (token !== undefined) {
            if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ScopeRestoreError('auth-required');
            if (!options.host.connection.prepareSshProfile) throw new ScopeRestoreError('scope-invalid');
            try { resolved = await options.host.connection.prepareSshProfile(id, token); }
            catch (error) {
              if (error instanceof ScopeRestoreError) throw error;
              const message = error instanceof Error ? error.message : String(error);
              if (message.includes('rejected the bearer token')) throw new ScopeRestoreError('auth-required');
              if (message.includes('home identity') || message.includes('authentication; SSH connection blocked') ||
                  message.includes('build identity') || message.includes('release channel')) throw new ScopeRestoreError('identity-mismatch');
              throw error;
            }
            if (resolved.tunnelId) tunnel = { id, tunnelId: resolved.tunnelId };
          } else {
            if (!scope.connectionRef || !options.host.connection.resumeScopeConnection) throw new ScopeRestoreError('auth-required');
            try { resolved = (await options.host.connection.resumeScopeConnection(scope.homeId, id, scope.connectionRef)).connection; }
            catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              throw new ScopeRestoreError(message.includes('offline') ? 'offline' : message.includes('identity changed') ? 'identity-mismatch' : 'auth-required');
            }
            if (resolved.tunnelId !== scope.connectionRef) throw new ScopeRestoreError('identity-mismatch');
          }
          signal.throwIfAborted();
          let endpoint: URL;
          try { endpoint = new URL(resolved.config.url); } catch { throw new ScopeRestoreError('identity-mismatch'); }
          if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password ||
              !endpoint.port || !resolved.tunnelId || (token !== undefined && resolved.config.token !== token) || resolved.serverHomeId !== profile.serverHomeId) {
            throw new ScopeRestoreError('identity-mismatch');
          }
          selection = { config: resolved.config, persist: false, source: 'ssh', scopeId: scope.scopeId, profile,
            tunnelId: resolved.tunnelId, serverHomeId: resolved.serverHomeId, serverInstanceId: resolved.serverInstanceId,
            serverVersion: resolved.serverVersion, buildId: resolved.buildId, buildChannel: resolved.buildChannel };
        } else if (scope.scopeId === 'local' || (returningControl && scope.scopeId.startsWith('direct:'))) {
          if (crossHome && !returningControl) {
            const discovered = await options.host.connection.discover();
            if (discovered === null) throw new ScopeRestoreError('offline');
            selection = { config: discovered.config, persist: false, source: 'desktop', scopeId: 'local' };
          } else {
            const local = returningControl ? options.control?.() ?? options.local() : options.local();
            if (local === null) throw new ScopeRestoreError('offline');
            if (scope.scopeId.startsWith('direct:') && scope.scopeId !== (local.selection.scopeId ?? `direct:${local.selection.config.url.trim().replace(/\/+$/, '')}`)) throw new ScopeRestoreError('scope-invalid');
            selection = local.selection;
            instance = local.client;
          }
        } else if (scope.homeId === source.scope.homeId && scope.scopeId === source.scope.scopeId) {
          selection = source.selection;
          instance = source.client;
        } else throw new ScopeRestoreError('scope-invalid');
        signal.throwIfAborted();
        if (instance === undefined) {
          instance = options.createClient?.(selection) ?? new KikiClient({ baseUrl: selection.config.url, token: selection.config.token });
          ownsClient = true;
        }
        const meta = await instance.meta();
        signal.throwIfAborted();
        if (scope.serverHomeId !== undefined && meta.server_home_id !== scope.serverHomeId) throw new ScopeRestoreError('identity-mismatch');
        if (selection.source === 'ssh' && (meta.server_home_id !== selection.serverHomeId || meta.server_id !== selection.serverInstanceId ||
            meta.server_version !== selection.serverVersion || meta.dangerous_bypass_auth !== false ||
            (meta.build_id ?? null) !== selection.buildId || (meta.build_channel ?? null) !== selection.buildChannel)) {
          throw new ScopeRestoreError('identity-mismatch');
        }
        const verified = instance;
        return {
          scope: { ...scope, serverHomeId: meta.server_home_id, connectionRef: selection.source === 'ssh' ? selection.tunnelId : undefined },
          validate: (route, nextSignal) => validateScopeRoute(verified, route, nextSignal),
          commit: async () => {
            signal.throwIfAborted();
            if (selection.source === 'ssh' && selection.profile && selection.tunnelId) {
              if (!options.host.connection.commitScopeConnection) throw new ScopeRestoreError('scope-invalid');
              await options.host.connection.commitScopeConnection(scope.homeId, selection.profile.id, selection.tunnelId, crossHome);
              signal.throwIfAborted();
            }
            if (crossHome) {
              if (ownsClient) await verified.klient.close();
              signal.throwIfAborted();
              options.reload();
            } else options.commit(selection, verified, meta);
            ownsClient = false;
            switchedHome = false;
            tunnel = undefined;
            options.preparing?.(false);
          },
          dispose,
        };
      } catch (error) {
        await dispose();
        if ((error instanceof ApiError || error instanceof RPCError) && error.code === API_CODES.UNAUTHORIZED) throw new ScopeRestoreError('auth-required');
        throw error;
      }
    },
  };
}
