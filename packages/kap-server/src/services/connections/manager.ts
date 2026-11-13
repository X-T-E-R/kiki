import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { peerFetch, requirePinnedTls } from './peerTls';
import { z } from 'zod';
import { ConnectionSecretStore } from './secrets';
import { join } from 'node:path';
import {
  CONNECTION_OPERATIONS, bridgeGrantSchema, connectionHandshakeSchema, connectionIdentitySchema, connectionOperationPath, connectionProvisionResultSchema, isDirectConnectionHost, remoteConnectionSchema, spaceSummarySchema,
  type ConnectionAddInput, type ConnectionBrokerInput, type ConnectionIdentity, type ConnectionOperation, type RemoteConnection, type SshConnectionRegisterInput, type SshRemoteProfile,
} from '@kiki/protocol';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import { readPrivateFile, writePrivateFile } from '../auth/privateFiles';
import { AdmissionError, sameIdentity } from './admission';
import { isPeerProcedureAllowed } from './audience';
import { parseKlientCallRequest } from '@kiki/klient/host';

interface Credential { ownerToken: string; grant: string; grantId: string; revision: number }
export class PairingBridgeRetirementError extends AdmissionError {
  constructor() { super(500, 'connection_stored_bridge_retirement_failed'); }
}
const peerBundleSchema = z.object({ grant: bridgeGrantSchema, credential: z.string().min(32).max(128) }).strict();
const peerGrantResultSchema = z.object({ peerToken: z.string().min(32).max(128), grantId: z.string().uuid(), revision: z.number().int().positive(), target: connectionIdentitySchema, targetLabel: z.string().max(128).optional(), bridge: z.array(peerBundleSchema).optional() }).strict();
export interface SshPairBridge { sourceWorkspaces: readonly string[]; install(connectionId: string, bundle: { grant: { id: string }; credential: string }, connectionGrantId?: string): Promise<void> }
export type ConnectionTransport = Pick<RemoteConnection, 'id' | 'endpoint' | 'target' | 'pinnedFingerprint'>;
export interface ConnectionSshConnector {
  acquire(record: Pick<RemoteConnection, 'id' | 'target'> & { transport: { kind: 'ssh'; profile: SshRemoteProfile } }, signal: AbortSignal, purpose: 'gui' | 'bridge'): Promise<Omit<ConnectionTransport, 'id'>>;
  stop(id: string, purpose?: 'gui' | 'bridge'): void;
  close(): Promise<void>;
  withOwner<T>(planId: string, callback: (owner: { endpoint: string; localOwnerToken: string; target: ConnectionIdentity; profile: SshRemoteProfile }) => Promise<T>, signal?: AbortSignal): Promise<T>;
}
export interface ConnectionLease { signal: AbortSignal; release(): void }
export const BROKER_BODY_BYTES = 4 * 1024 * 1024;
export const BROKER_FS_READ_BODY_BYTES = 16 * 1024 * 1024;
export const BROKER_WS_MESSAGE_BYTES = 128 * 1024;
export const BROKER_WS_BUFFER_BYTES = 256 * 1024;
export class RemoteConnectionManager {
  private records: RemoteConnection[] = [];
  private readonly active = new Map<string, Set<AbortController>>();
  private readonly path: string;
  private tail: Promise<unknown> = Promise.resolve();
  private summaryTimer?: ReturnType<typeof setInterval>;
  private summaryPolling = false;
  private stopped = false;
  private readonly lastSummaryAttempt = new Map<string, number>();
  private readonly summaryLeases = new Map<string, ConnectionLease>();
  private readonly epochs = new Map<string, number>();
  private readonly replacing = new Set<string>();
  private retirePairingBridges?: (id: string, grantId: string) => Promise<void>;
  credentialEpoch(id: string): number { return this.epochs.get(id) ?? 0; }
  setPairingBridgeRetirement(retire: (id: string, grantId: string) => Promise<void>): void { this.retirePairingBridges = retire; }
  private requireEpoch(id: string, epoch: number): void {
    if (this.credentialEpoch(id) !== epoch || this.replacing.has(id)) throw new AdmissionError(409, 'connection_stopped');
  }
  private readonly changeListeners = new Set<() => void>();
  onDidChange(listener: () => void): { dispose(): void } {
    this.changeListeners.add(listener);
    return { dispose: () => { this.changeListeners.delete(listener); } };
  }
  private stopSummary(id: string): void { const lease = this.summaryLeases.get(id); this.summaryLeases.delete(id); lease?.release(); }
  start(): void {
    this.summaryTimer = setInterval(() => { void this.pollSummaries().catch(() => {}); }, 5000);
    this.summaryTimer.unref();
    void this.pollSummaries().catch(() => {});
  }
  async pollSummaries(): Promise<void> {
    if (this.stopped || this.summaryPolling) return;
    this.summaryPolling = true;
    try {
      const due = this.records.filter((r) => r.enabled && r.backgroundSummary && !['authentication_required', 'identity_changed'].includes(r.state) && Date.now() - (this.lastSummaryAttempt.get(r.id) ?? 0) >= (r.state === 'offline' ? 60000 : 5000));
      for (let offset = 0; offset < due.length && !this.stopped; offset += 3) {
        await Promise.all(due.slice(offset, offset + 3).map(async (record) => {
          if (!this.records.includes(record) || this.replacing.has(record.id)) return;
          const epoch = this.credentialEpoch(record.id);
          this.lastSummaryAttempt.set(record.id, Date.now());
          try {
            let lease = this.summaryLeases.get(record.id);
            if (lease === undefined || lease.signal.aborted) { lease = this.lease(record.id); this.summaryLeases.set(record.id, lease); }
            const response = await this.forward(record.id, { operation: 'spaceSummary' }, lease.signal);
            const envelope = await readBoundedJsonBody(response, 8192) as { code: number; data: unknown };
            if (envelope.code !== 0) throw new AdmissionError(502, 'summary_unavailable');
            this.requireEpoch(record.id, epoch);
            lease.signal.throwIfAborted();
            record.summary = { value: spaceSummarySchema.parse(envelope.data), lastSeen: Date.now(), stale: false };
            await this.change(async () => undefined);
          } catch (error) { this.failed(record.id, error, epoch); }
        }));
      }
    } finally { this.summaryPolling = false; }
  }
  readonly secrets: ConnectionSecretStore;
  constructor(homeDir: string, readonly identity: ConnectionIdentity, readonly ssh?: ConnectionSshConnector, private readonly resolveLocal?: (localSpaceId: string, target: ConnectionIdentity, signal: AbortSignal) => Promise<Omit<ConnectionTransport, 'id'>>) {
    this.path = join(homeDir, 'server', 'outbound-connections.json');
    this.secrets = new ConnectionSecretStore(homeDir);
  }
  async ready(): Promise<void> {
    try {
      const raw = JSON.parse((await readPrivateFile(this.path)).toString('utf8')) as unknown[];
      this.records = raw.map<RemoteConnection>((entry) => { const record = remoteConnectionSchema.parse(entry); return { ...record, endpoint: record.transport === undefined ? validateEndpoint(record.endpoint) : descriptorEndpoint(record.transport), state: record.state === 'online' ? 'offline' : record.state, activeLeases: 0, summary: record.summary === undefined ? undefined : { ...record.summary, stale: true } }; });
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  list(): RemoteConnection[] { return this.records.map((record) => ({ ...record, activeLeases: (this.active.get(record.id)?.size ?? 0) + (this.bridgeActive.get(record.id)?.size ?? 0) })); }
  get(id: string): RemoteConnection {
    const record = this.records.find((entry) => entry.id === id);
    if (record === undefined) throw new AdmissionError(404, 'connection_not_found');
    return record;
  }
  async registerBridgeTarget(input: { label: string; endpoint: string; target: ConnectionIdentity; transport?: RemoteConnection['transport'] }): Promise<RemoteConnection> {
    const endpoint = input.transport === undefined ? validateEndpoint(input.endpoint) : descriptorEndpoint(input.transport);
    const id = randomUUID();
    const record: RemoteConnection = { id, label: input.label, endpoint, target: { ...input.target }, transport: input.transport, credentialRef: id, purposes: ['bridge'], enabled: true, backgroundSummary: false, state: 'offline', activeLeases: 0 };
    return this.change(async () => { this.records.push(record); return { ...record }; });
  }
  async ensurePeerBridgeTarget(input: { grantId: string; label: string; target: ConnectionIdentity; endpoint?: string }): Promise<RemoteConnection> {
    const transport: RemoteConnection['transport'] = input.endpoint === undefined ? { kind: 'peer_socket', grantId: input.grantId } : undefined;
    const endpoint = transport === undefined ? validateEndpoint(input.endpoint!) : descriptorEndpoint(transport);
    return this.change(async () => {
      const existing = this.records.find((entry) => transport?.kind === 'peer_socket' && entry.transport?.kind === 'peer_socket' && sameIdentity(entry.target, input.target)
        || entry.transport === undefined && entry.purposes.length === 1 && entry.purposes[0] === 'bridge' && entry.endpoint === endpoint && sameIdentity(entry.target, input.target));
      if (existing !== undefined) {
        existing.label = input.label;
        existing.endpoint = endpoint;
        existing.transport = transport;
        existing.enabled = true;
        if (existing.state === 'disabled') existing.state = 'offline';
        return { ...existing };
      }
      const id = randomUUID();
      const record: RemoteConnection = { id, label: input.label, endpoint, target: { ...input.target }, transport, credentialRef: id, purposes: ['bridge'], enabled: true, backgroundSummary: false, state: 'offline', activeLeases: 0 };
      this.records.push(record);
      return { ...record };
    });
  }
  async registerSsh(input: SshConnectionRegisterInput, signal: AbortSignal, bridge?: SshPairBridge): Promise<RemoteConnection> {
    if (this.ssh === undefined) throw new AdmissionError(503, 'ssh_transport_unavailable');
    return this.ssh.withOwner(input.planId, async (owner) => {
      signal.throwIfAborted();
      const transport = { kind: 'ssh', profile: owner.profile } as const;
      if (input.purpose === 'bridge') return this.registerBridgeTarget({ label: input.label, endpoint: sshEndpoint(owner.profile), target: owner.target, transport });
      const id = randomUUID();
      const base = { id, label: input.label, endpoint: sshEndpoint(owner.profile), transport, target: owner.target, credentialRef: id, enabled: true, backgroundSummary: input.backgroundSummary, state: 'online' as const, lastConnectedAt: Date.now(), activeLeases: 0 };
      if (bridge !== undefined) {
        const envelope = await this.jsonRequest(owner.endpoint + '/api/remote-connections/inbound/peer-grant', { method: 'POST', headers: { authorization: `Bearer ${owner.localOwnerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ source: this.identity, label: input.label, sourceWorkspaces: bridge.sourceWorkspaces, requestBridge: true }), signal }, 65536) as { code: number; data: unknown };
        if (envelope.code !== 0) throw new AdmissionError(409, 'connection_provision_failed');
        const issued = peerGrantResultSchema.parse(envelope.data);
        if (!sameIdentity(issued.target, owner.target)) throw new AdmissionError(409, 'identity_changed');
        const bundles = issued.bridge ?? [];
        const record: RemoteConnection = { ...base, purposes: bundles.length > 0 ? ['gui', 'bridge'] : ['gui'] };
        let stored = false;
        try {
          const saved = await this.storeGui(record, { ownerToken: issued.peerToken, grant: issued.peerToken, grantId: issued.grantId, revision: issued.revision }, input.label);
          stored = true;
          for (const bundle of bundles) await bridge.install(saved.id, bundle, issued.grantId);
          return saved;
        } catch (error) {
          if (stored || error instanceof PairingBridgeRetirementError) throw error;
          try {
            await this.jsonRequest(owner.endpoint + '/api/remote-connections/inbound/grants/' + issued.grantId + '/revoke', { method: 'POST', headers: { authorization: `Bearer ${owner.localOwnerToken}` }, signal }, 8192);
            for (const bundle of bundles) await this.jsonRequest(owner.endpoint + '/api/thread-bridges/inbound/' + bundle.grant.id + '/revoke', { method: 'POST', headers: { authorization: `Bearer ${owner.localOwnerToken}` }, signal }, 8192);
          } catch { throw new AdmissionError(500, `connection_store_failed_revoke_remote_grant:${issued.grantId}`); }
          throw error instanceof AdmissionError ? error : new AdmissionError(500, 'connection_store_failed_new_grant_revoked');
        }
      }
      const envelope = await this.jsonRequest(owner.endpoint + '/api/remote-connections/provision', { method: 'POST', headers: { authorization: `Bearer ${owner.localOwnerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ source: this.identity, target: owner.target, label: input.label, enableInbound: input.enableInbound }), signal }, 65536) as { code: number; data: unknown };
      if (envelope.code !== 0) throw new AdmissionError(409, 'connection_provision_failed');
      const issued = connectionProvisionResultSchema.parse(envelope.data);
      if (!sameIdentity(issued.target, owner.target)) throw new AdmissionError(409, 'identity_changed');
      try { return await this.storeGui({ ...base, purposes: ['gui'] }, { ownerToken: issued.ownerToken, grant: issued.grant, grantId: issued.grantId, revision: issued.revision }, input.label); }
      catch (error) {
        if (error instanceof PairingBridgeRetirementError) throw error;
        try { await this.jsonRequest(owner.endpoint + '/api/remote-connections/inbound/grants/' + issued.grantId + '/revoke', { method: 'POST', headers: { authorization: `Bearer ${owner.localOwnerToken}` }, signal }, 8192); }
        catch { throw new AdmissionError(500, `connection_store_failed_revoke_remote_grant:${issued.grantId}`); }
        throw new AdmissionError(500, 'connection_store_failed_new_grant_revoked');
      }
    }, signal);
  }
  async storePeer(record: RemoteConnection, credential: Credential, label?: string): Promise<RemoteConnection> { return this.storeGui(record, credential, label); }
  private async storeGui(record: RemoteConnection, credential: Credential, label?: string): Promise<RemoteConnection> {
    return this.serialize(async () => {
      const existing = this.records.find((entry) => entry.purposes.includes('gui') && sameIdentity(entry.target, record.target));
      if (existing?.pinnedFingerprint !== undefined && record.transport === undefined && record.pinnedFingerprint === undefined) throw new AdmissionError(409, 'connection_requires_tls');
      const saved = existing === undefined ? record : { ...record, id: existing.id, credentialRef: existing.credentialRef,
        label: label?.trim() || existing.label, backgroundSummary: existing.backgroundSummary };
      const ref = { connectionId: saved.credentialRef, purpose: 'gui' } as const;
      const previous = existing === undefined ? undefined : await this.secrets.read<Credential>(ref).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      this.replacing.add(saved.id);
      this.epochs.set(saved.id, this.credentialEpoch(saved.id) + 1);
      if (existing !== undefined) { this.stop(saved.id); this.lastSummaryAttempt.delete(saved.id); }
      try {
        await this.secrets.write(ref, credential);
        const next = existing === undefined ? [...this.records, saved] : this.records.map((entry) => entry === existing ? saved : entry);
        try {
          await writePrivateFile(this.path, JSON.stringify(next));
        } catch (error) {
          if (previous === undefined) await this.secrets.remove(ref);
          else await this.secrets.write(ref, previous);
          throw error;
        }
        this.records = next;
        if (previous !== undefined) {
          try { await this.retirePairingBridges?.(saved.id, previous.grantId); }
          catch { throw new PairingBridgeRetirementError(); }
        }
      } finally { this.replacing.delete(saved.id); }
      for (const listener of this.changeListeners) listener();
      return { ...saved };
    });
  }
  async add(input: ConnectionAddInput): Promise<RemoteConnection> {
    const endpoint = validateEndpoint(input.endpoint);
    const pinnedFingerprint = this.records.find((entry) => entry.purposes.includes('gui') && sameIdentity(entry.target, input.target))?.pinnedFingerprint;
    await this.provePeer(endpoint, input.target, { grant: input.invitation }, undefined, pinnedFingerprint, 'invited');
    const claimed = await this.jsonRequest(endpoint + '/api/remote-connections/claim', { method: 'POST', headers: { authorization: `Bearer ${input.ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ invitation: input.invitation, source: this.identity }) }, 8192, pinnedFingerprint) as { code: number; msg: string; data: { grant: string; grantId: string; revision: number; target: ConnectionIdentity } };
    if (claimed.code !== 0 || !claimed.data || !sameIdentity(claimed.data.target, input.target) || typeof claimed.data.grant !== 'string') throw new AdmissionError(401, 'connection_claim_failed');
    const id = randomUUID();
    const record: RemoteConnection = { id, label: input.label, endpoint, pinnedFingerprint, target: input.target, credentialRef: id, enabled: true, purposes: ['gui'], backgroundSummary: input.backgroundSummary, state: 'online', lastConnectedAt: Date.now(), activeLeases: 0 };
    const credential = { ownerToken: input.ownerToken, ...claimed.data };
    try { return await this.storeGui(record, credential, input.label); }
    catch (error) {
      if (!(error instanceof PairingBridgeRetirementError)) await this.cancelClaim(endpoint, record.target, credential, pinnedFingerprint);
      throw error;
    }
  }
  async remove(id: string): Promise<void> {
    await this.change(async () => { const record = this.get(id); this.stop(id); this.records = this.records.filter((entry) => entry !== record); await Promise.all(['gui', 'bridge'].map((purpose) => this.secrets.remove({ connectionId: record.credentialRef, purpose: purpose as 'gui' | 'bridge' }))); });
  }
  async enable(id: string, enabled: boolean): Promise<RemoteConnection> {
    return this.change(async () => { const record = this.get(id); record.enabled = enabled; if (!enabled) { this.stop(id); record.state = 'disabled'; } else { record.state = 'offline'; delete record.lastError; } return { ...record }; });
  }
  async retry(id: string): Promise<RemoteConnection> {
    const record = this.get(id); if (!record.enabled) throw new AdmissionError(403, 'connection_disabled');
    if (!record.purposes.includes('gui')) throw new AdmissionError(403, 'gui_connection_required');
    this.stop(id, 'gui'); record.state = 'offline'; delete record.lastError;
    const lease = this.lease(id, AbortSignal.timeout(15000));
    try { await this.connect(id, lease.signal); await this.change(async () => undefined); return { ...record }; }
    finally { lease.release(); }
  }
  private readonly bridgeActive = new Map<string, Set<AbortController>>();
  resolveTransport(id: string): ConnectionTransport {
    const record = this.get(id);
    if (!record.enabled || record.state === 'identity_changed') throw new AdmissionError(409, record.lastError ?? 'connection_disabled');
    return { id: record.id, endpoint: record.endpoint, target: { ...record.target }, pinnedFingerprint: record.pinnedFingerprint };
  }
  private readonly transports = new WeakMap<AbortSignal, Map<string, Promise<ConnectionTransport>>>();
  async acquireTransport(id: string, signal: AbortSignal, purpose: 'gui' | 'bridge' = 'gui'): Promise<ConnectionTransport> {
    const record = this.get(id); const epoch = this.credentialEpoch(id);
    this.requireEpoch(id, epoch); this.resolveTransport(id); signal.throwIfAborted();
    const leases = (purpose === 'gui' ? this.active : this.bridgeActive).get(id);
    if (![...leases ?? []].some((lease) => lease.signal === signal)) throw new AdmissionError(409, 'connection_lease_required');
    const pending = this.transports.get(signal) ?? new Map<string, Promise<ConnectionTransport>>(); this.transports.set(signal, pending);
    const key = `${id}:${purpose}`;
    let acquired = pending.get(key);
    if (acquired === undefined) {
      acquired = (async () => {
        if (record.transport === undefined || record.transport.kind === 'peer_socket') return this.resolveTransport(id);
        try {
          let transport: Omit<ConnectionTransport, 'id'>;
          if (record.transport.kind === 'local_space') {
            if (this.resolveLocal === undefined) throw new AdmissionError(503, 'local_space_transport_unavailable');
            transport = await this.resolveLocal(record.transport.localSpaceId, record.target, signal);
          } else {
            if (this.ssh === undefined) throw new AdmissionError(503, 'ssh_transport_unavailable');
            transport = await this.ssh.acquire({ id: record.id, target: record.target, transport: record.transport }, signal, purpose);
          }
          signal.throwIfAborted();
          if (!sameIdentity(transport.target, record.target)) throw new AdmissionError(409, 'identity_changed');
          return { id, endpoint: validateEndpoint(transport.endpoint), target: { ...transport.target } };
        } catch (error) { if (error instanceof AdmissionError && error.reason === 'identity_changed') this.failed(id, error, epoch); throw error; }
      })();
      pending.set(key, acquired);
    }
    return acquired;
  }
  lease(id: string, parent?: AbortSignal, purpose: 'gui' | 'bridge' = 'gui'): ConnectionLease {
    const record = this.get(id);
    if (this.stopped || !record.enabled || record.state === 'identity_changed') throw new AdmissionError(409, record.lastError ?? 'connection_paused');
    const controller = new AbortController();
    const abort = (): void => controller.abort(parent?.reason);
    parent?.addEventListener('abort', abort, { once: true }); if (parent?.aborted) abort();
    const leases = purpose === 'bridge' ? this.bridgeActive : this.active;
    const set = leases.get(id) ?? new Set<AbortController>(); set.add(controller); leases.set(id, set);
    let released = false;
    return { signal: controller.signal, release: () => {
      if (released) return; released = true; parent?.removeEventListener('abort', abort); set.delete(controller); if (set.size === 0 && leases.get(id) === set) leases.delete(id);
      controller.abort(new AdmissionError(409, 'connection_released'));
    } };
  }
  activeCount(): number {
    return [...this.active.values(), ...this.bridgeActive.values()].reduce((sum, set) => sum + set.size, 0) + this.records.filter((r) => r.enabled && r.backgroundSummary && !['authentication_required', 'identity_changed'].includes(r.state)).length;
  }
  async close(): Promise<void> { this.stopped = true; if (this.summaryTimer !== undefined) clearInterval(this.summaryTimer); for (const id of [...this.active.keys(), ...this.bridgeActive.keys()]) this.stop(id); await this.ssh?.close(); await this.tail; }
  stop(id: string, purpose?: 'gui' | 'bridge'): void {
    if (purpose !== 'bridge') this.stopSummary(id);
    for (const leases of purpose === 'gui' ? [this.active] : purpose === 'bridge' ? [this.bridgeActive] : [this.active, this.bridgeActive]) {
      const set = leases.get(id); leases.delete(id); for (const controller of set ?? []) controller.abort(new AdmissionError(409, 'connection_stopped'));
    }
    this.ssh?.stop(id, purpose);
  }
  async connect(id: string, signal: AbortSignal): Promise<{ record: RemoteConnection; credential: Credential; transport: ConnectionTransport }> {
    const record = this.get(id); const epoch = this.credentialEpoch(id);
    this.requireEpoch(id, epoch);
    if (!record.enabled || record.state === 'identity_changed') throw new AdmissionError(409, record.lastError ?? 'connection_paused');
    if (!record.purposes.includes('gui')) throw new AdmissionError(403, 'gui_connection_required');
    try {
      const credential = await this.secrets.read<Credential>({ connectionId: record.credentialRef, purpose: 'gui' });
      const transport = await this.acquireTransport(id, signal, 'gui');
      this.requireEpoch(id, epoch);
      await this.provePeer(transport.endpoint, record.target, credential, signal, record.pinnedFingerprint);
      signal.throwIfAborted(); this.requireEpoch(id, epoch);
      record.state = 'online'; record.lastConnectedAt = Date.now(); delete record.lastError;
      return { record, credential, transport };
    } catch (error) { if (!signal.aborted) this.failed(id, error, epoch); throw error; }
  }
  failed(id: string, error: unknown, epoch = this.credentialEpoch(id)): void {
    const record = this.records.find((entry) => entry.id === id);
    if (epoch !== this.credentialEpoch(id) || this.replacing.has(id) || record === undefined || !record.enabled || this.stopped || record.state === 'identity_changed') return;
    this.stopSummary(id);
    if (record.summary !== undefined) record.summary.stale = true;
    const reason = error instanceof Error ? error.message : 'connection_failed'; record.lastError = reason;
    record.state = error instanceof AdmissionError && error.reason === 'identity_changed' ? 'identity_changed'
      : error instanceof AdmissionError && (error.status === 401 || (error.status === 403 && error.reason !== 'inbound_disabled')) ? 'authentication_required' : 'offline';
    if (record.state !== 'offline') this.stop(id, record.state === 'identity_changed' ? undefined : 'gui');
    void this.change(async () => undefined).catch(() => {});
  }
  async forward(id: string, input: ConnectionBrokerInput, signal: AbortSignal, rawBody?: NonNullable<RequestInit['body']>, contentType?: string): Promise<Response> {
    if (!Object.hasOwn(CONNECTION_OPERATIONS, input.operation)) throw new AdmissionError(400, 'unknown_connection_operation');
    const operation = input.operation as ConnectionOperation;
    if (operation === 'mediaPreview' && Object.entries(input.query ?? {}).some(([key, value]) => key !== 'media_type' || typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(value))) throw new AdmissionError(400, 'invalid_preview_query');
    if (operation === 'procedure') {
      const { procedure } = parseKlientCallRequest(input.body);
      if (!isPeerProcedureAllowed(procedure)) throw new AdmissionError(403, 'local_owner_required');
    }
    const epoch = this.credentialEpoch(id);
    const { record, transport, credential } = await this.connect(id, signal);
    this.requireEpoch(id, epoch); signal.throwIfAborted();
    const url = new URL(connectionOperationPath(operation, input.params), transport.endpoint);
    if (operation === 'spaceSummary') signal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    for (const [key, value] of Object.entries(input.query ?? {})) for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    const method = CONNECTION_OPERATIONS[operation][0];
    const headers = new Headers({ authorization: `Bearer ${credential.ownerToken}`, 'x-kiki-connection-grant': credential.grant,
      ...input.headers?.ifNoneMatch === undefined ? {} : { 'if-none-match': input.headers.ifNoneMatch },
      ...input.headers?.range === undefined ? {} : { range: input.headers.range } });
    if (operation !== 'htmlPreviewClose' || rawBody !== undefined || input.body !== undefined) headers.set('content-type', contentType ?? 'application/json');
    try {
      const response = await peerFetch(url, { method, headers, body: rawBody ?? (input.body === undefined ? undefined : JSON.stringify(input.body)), signal, duplex: rawBody === undefined ? undefined : 'half' } as RequestInit, record.pinnedFingerprint);
      if (signal.aborted || this.credentialEpoch(id) !== epoch) {
        await response.body?.cancel(); signal.throwIfAborted(); this.requireEpoch(id, epoch);
      }
      if (response.status === 401 || response.status === 403) {
        const refusal = await readConnectionRefusal(response, signal);
        if (refusal?.code === 40301 && typeof refusal.msg === 'string' && (
          (['htmlPreviewOpen', 'htmlPreviewResource', 'htmlPreviewClose'].includes(operation) && ['html_preview_target_owner_grant_required', 'html_preview_document_origin_requires_local_connection', 'preview_path_outside_root', 'preview_resource_forbidden'].includes(refusal.msg))
          || (['sessionCreate', 'fsSearch', 'draftFsSearch'].includes(operation) && refusal.msg === 'peer_workspace_not_registered')
        )) return new Response(refusal.body, { status: response.status, statusText: response.statusText, headers: response.headers });
        void response.body?.cancel().catch(() => {});
        throw new AdmissionError(response.status, refusal?.code === 40301 && refusal.msg === 'inbound_disabled' ? 'inbound_disabled' : 'connection_not_approved');
      }
      return response;
    } catch (error) { if (!signal.aborted) this.failed(id, error, epoch); throw error; }
  }
  async provePeer(endpoint: string, target: ConnectionIdentity, credential: { grant: string; grantId?: string }, signal?: AbortSignal, fingerprint?: string, expectedStatus: 'approved' | 'invited' = 'approved'): Promise<void> {
    requirePinnedTls(endpoint, fingerprint);
    const nonce = randomBytes(16).toString('hex');
    const key = createHash('sha256').update(credential.grant).digest('hex');
    const hmac = (value: string) => createHmac('sha256', key).update(value).digest();
    const headers = new Headers({ 'x-kiki-handshake-nonce': nonce, 'x-kiki-handshake-proof': hmac(`kiki-handshake-req-v1:${nonce}`).toString('hex') });
    if (credential.grantId !== undefined) headers.set('x-kiki-handshake-grant', credential.grantId);
    const deadline = signal === undefined ? AbortSignal.timeout(15000) : AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const response = await peerFetch(endpoint + '/api/remote-connections/handshake', { headers, signal: deadline }, fingerprint);
    const envelope = await readBoundedJsonBody(response, 8192, deadline) as { code: number; data: unknown };
    const hello = connectionHandshakeSchema.safeParse(envelope.data);
    if (!response.ok || envelope.code !== 0 || !hello.success || !sameIdentity(hello.data.identity, target)) throw new AdmissionError(409, 'identity_changed');
    const status = response.headers.get('x-kiki-handshake-status');
    const proof = response.headers.get('x-kiki-handshake-proof') ?? '';
    const domain = status === 'approved' ? 'res' : status === 'revoked' ? 'revoked' : status === 'inbound_disabled' ? 'disabled' : status === 'invited' ? 'invited' : undefined;
    const suffix = `${nonce}:${target.homeId}:${target.hostId}`;
    if (domain === undefined || !/^[a-f0-9]{64}$/.test(proof) || !timingSafeEqual(Buffer.from(proof, 'hex'), hmac(`kiki-handshake-${domain}-v1:${suffix}`))) throw new AdmissionError(409, 'identity_changed');
    if (status === 'revoked') throw new AdmissionError(401, 'connection_not_approved');
    if (status === 'inbound_disabled' || !hello.data.inboundEnabled) throw new AdmissionError(403, 'inbound_disabled');
    if (status !== expectedStatus) throw new AdmissionError(401, 'handshake_failed');
  }
  async cancelClaim(endpoint: string, target: ConnectionIdentity, credential: Credential, fingerprint?: string): Promise<void> {
    const signal = AbortSignal.timeout(15000);
    await this.provePeer(endpoint, target, credential, signal, fingerprint);
    await this.jsonRequest(endpoint + '/api/remote-connections/pair/cancel', { method: 'POST', headers: { authorization: `Bearer ${credential.ownerToken}`, 'x-kiki-connection-grant': credential.grant, 'content-type': 'application/json' }, body: JSON.stringify({ grantId: credential.grantId }), signal }, 8192, fingerprint);
  }
  private async jsonRequest(url: string, init: RequestInit, bytes: number, fingerprint?: string): Promise<unknown> {
    const signal = init.signal === undefined || init.signal === null ? AbortSignal.timeout(15000) : AbortSignal.any([init.signal, AbortSignal.timeout(15000)]);
    const response = await peerFetch(url, { ...init, signal }, fingerprint);
    if (!response.ok) {
      const envelope = await readBoundedJsonBody(response, 8192).catch(() => undefined) as { msg?: unknown } | undefined;
      const reasons = ['inbound_disabled', 'dangerous_auth_bypass', 'identity_changed', 'local_owner_required', 'invalid_owner_credential', 'connection_not_approved'];
      const reason = typeof envelope?.msg === 'string' && reasons.includes(envelope.msg) ? envelope.msg
        : response.status === 401 ? 'authentication_required' : 'connection_request_rejected';
      throw new AdmissionError(response.status, reason);
    }
    return readBoundedJsonBody(response, bytes);
  }
  private change<T>(work: () => Promise<T>): Promise<T> { return this.serialize(async () => { const value = await work(); await writePrivateFile(this.path, JSON.stringify(this.records)); for (const listener of this.changeListeners) listener(); return value; }); }
  private serialize<T>(work: () => Promise<T>): Promise<T> { const result = this.tail.then(work); this.tail = result.catch(() => undefined); return result; }
}
function descriptorEndpoint(transport: NonNullable<RemoteConnection['transport']>): string {
  if (transport.kind === 'ssh') return sshEndpoint(transport.profile);
  if (transport.kind === 'peer_socket') return `peer://${encodeURIComponent(transport.grantId)}`;
  return `space://${encodeURIComponent(transport.localSpaceId)}`;
}
function sshEndpoint(profile: SshRemoteProfile): string { return `ssh://${encodeURIComponent(profile.id)}`; }
export function validateEndpoint(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) || (url.pathname !== '/' && url.pathname !== '')) throw new AdmissionError(400, 'invalid_connection_endpoint');
  if (url.protocol !== 'https:' && !isDirectConnectionHost(url.hostname)) throw new AdmissionError(400, 'connection_requires_tls');
  return url.origin;
}

async function readConnectionRefusal(response: Response, signal: AbortSignal): Promise<{ body: Uint8Array<ArrayBuffer>; code: unknown; msg: unknown } | undefined> {
  if (response.status !== 403 || !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '') || response.body === null) return undefined;
  const reader = response.body.getReader();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const cancel = (): void => { void reader.cancel(deadline.reason).catch(() => {}); };
  const chunks: Uint8Array[] = []; let bytes = 0; let complete = false;
  deadline.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      deadline.throwIfAborted();
      const chunk = await reader.read();
      deadline.throwIfAborted();
      if (chunk.done) { complete = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > 8192) return undefined;
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (typeof envelope !== 'object' || envelope === null || !('code' in envelope) || !('msg' in envelope)) return undefined;
    return { body, code: envelope.code, msg: envelope.msg };
  } catch { return undefined; }
  finally { deadline.removeEventListener('abort', cancel); if (!complete) cancel(); reader.releaseLock(); }
}
