import { randomUUID } from 'node:crypto';
import { ConnectionSecretStore } from './secrets';
import { join } from 'node:path';
import {
  CONNECTION_OPERATIONS, connectionHandshakeSchema, connectionOperationPath, connectionProvisionResultSchema, remoteConnectionSchema, spaceSummarySchema,
  type ConnectionAddInput, type ConnectionBrokerInput, type ConnectionIdentity, type ConnectionOperation, type RemoteConnection, type SshConnectionRegisterInput, type SshRemoteProfile,
} from '@kiki/protocol';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import { readPrivateFile, writePrivateFile } from '../auth/privateFiles';
import { AdmissionError, sameIdentity } from './admission';
import { isPeerProcedureAllowed } from './audience';
import { parseKlientCallRequest } from '@kiki/klient/host';

interface Credential { ownerToken: string; grant: string; grantId: string; revision: number }
export type ConnectionTransport = Pick<RemoteConnection, 'id' | 'endpoint' | 'target'>;
export interface ConnectionSshConnector {
  acquire(record: Pick<RemoteConnection, 'id' | 'target'> & { transport: { kind: 'ssh'; profile: SshRemoteProfile } }, signal: AbortSignal, purpose: 'gui' | 'bridge'): Promise<Omit<ConnectionTransport, 'id'>>;
  stop(id: string, purpose?: 'gui' | 'bridge'): void;
  close(): Promise<void>;
  withOwner<T>(planId: string, callback: (owner: { endpoint: string; localOwnerToken: string; target: ConnectionIdentity; profile: SshRemoteProfile }) => Promise<T>, signal?: AbortSignal): Promise<T>;
}
export interface ConnectionLease { signal: AbortSignal; release(): void }
export const BROKER_BODY_BYTES = 4 * 1024 * 1024;
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
          this.lastSummaryAttempt.set(record.id, Date.now());
          try {
            let lease = this.summaryLeases.get(record.id);
            if (lease === undefined || lease.signal.aborted) { lease = this.lease(record.id); this.summaryLeases.set(record.id, lease); }
            const response = await this.forward(record.id, { operation: 'spaceSummary' }, lease.signal);
            const envelope = await readBoundedJsonBody(response, 8192) as { code: number; data: unknown };
            if (envelope.code !== 0) throw new AdmissionError(502, 'summary_unavailable');
            record.summary = { value: spaceSummarySchema.parse(envelope.data), lastSeen: Date.now(), stale: false };
            await this.change(async () => undefined);
          } catch (error) { if (this.records.includes(record)) this.failed(record.id, error); }
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
  async registerSsh(input: SshConnectionRegisterInput, signal: AbortSignal): Promise<RemoteConnection> {
    if (this.ssh === undefined) throw new AdmissionError(503, 'ssh_transport_unavailable');
    return this.ssh.withOwner(input.planId, async (owner) => {
      signal.throwIfAborted();
      const transport = { kind: 'ssh', profile: owner.profile } as const;
      if (input.purpose === 'bridge') return this.registerBridgeTarget({ label: input.label, endpoint: sshEndpoint(owner.profile), target: owner.target, transport });
      const envelope = await this.jsonRequest(owner.endpoint + '/api/remote-connections/provision', { method: 'POST', headers: { authorization: `Bearer ${owner.localOwnerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ source: this.identity, target: owner.target, label: input.label, enableInbound: input.enableInbound }), signal }, 8192) as { code: number; data: unknown };
      if (envelope.code !== 0) throw new AdmissionError(409, 'connection_provision_failed');
      const credential = connectionProvisionResultSchema.parse(envelope.data);
      if (!sameIdentity(credential.target, owner.target)) throw new AdmissionError(409, 'identity_changed');
      const id = randomUUID();
      const record: RemoteConnection = { id, label: input.label, endpoint: sshEndpoint(owner.profile), transport, target: owner.target, credentialRef: id, enabled: true, purposes: ['gui'], backgroundSummary: input.backgroundSummary, state: 'online', lastConnectedAt: Date.now(), activeLeases: 0 };
      try { return await this.storeGui(record, credential); }
      catch {
        try { await this.jsonRequest(owner.endpoint + '/api/remote-connections/inbound/grants/' + credential.grantId + '/revoke', { method: 'POST', headers: { authorization: `Bearer ${owner.localOwnerToken}` }, signal }, 8192); }
        catch { throw new AdmissionError(500, `connection_store_failed_revoke_remote_grant:${credential.grantId}`); }
        throw new AdmissionError(500, 'connection_store_failed_new_grant_revoked');
      }
    }, signal);
  }
  private async storeGui(record: RemoteConnection, credential: Credential): Promise<RemoteConnection> {
    try { return await this.change(async () => { await this.secrets.write({ connectionId: record.id, purpose: 'gui' }, credential); this.records.push(record); return { ...record }; }); }
    catch (error) { this.records = this.records.filter((entry) => entry !== record); await this.secrets.remove({ connectionId: record.id, purpose: 'gui' }).catch(() => {}); throw error; }
  }
  async add(input: ConnectionAddInput): Promise<RemoteConnection> {
    const endpoint = validateEndpoint(input.endpoint);
    const target = await this.handshake(endpoint, input.ownerToken);
    if (!sameIdentity(input.target, target.identity)) throw new AdmissionError(409, 'identity_changed');
    const claimed = await this.jsonRequest(endpoint + '/api/remote-connections/claim', { method: 'POST', headers: { authorization: `Bearer ${input.ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ invitation: input.invitation, source: this.identity }) }, 8192) as { code: number; msg: string; data: { grant: string; grantId: string; revision: number; target: ConnectionIdentity } };
    if (claimed.code !== 0 || !claimed.data || !sameIdentity(claimed.data.target, input.target) || typeof claimed.data.grant !== 'string') throw new AdmissionError(401, 'connection_claim_failed');
    const id = randomUUID();
    const record: RemoteConnection = { id, label: input.label, endpoint, target: input.target, credentialRef: id, enabled: true, purposes: ['gui'], backgroundSummary: input.backgroundSummary, state: 'online', lastConnectedAt: Date.now(), activeLeases: 0 };
    return this.storeGui(record, { ownerToken: input.ownerToken, ...claimed.data });
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
    return { id: record.id, endpoint: record.endpoint, target: { ...record.target } };
  }
  private readonly transports = new WeakMap<AbortSignal, Map<string, Promise<ConnectionTransport>>>();
  async acquireTransport(id: string, signal: AbortSignal, purpose: 'gui' | 'bridge' = 'gui'): Promise<ConnectionTransport> {
    const record = this.get(id); this.resolveTransport(id); signal.throwIfAborted();
    const leases = (purpose === 'gui' ? this.active : this.bridgeActive).get(id);
    if (![...leases ?? []].some((lease) => lease.signal === signal)) throw new AdmissionError(409, 'connection_lease_required');
    const pending = this.transports.get(signal) ?? new Map<string, Promise<ConnectionTransport>>(); this.transports.set(signal, pending);
    const key = `${id}:${purpose}`;
    let acquired = pending.get(key);
    if (acquired === undefined) {
      acquired = (async () => {
        if (record.transport === undefined) return this.resolveTransport(id);
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
        } catch (error) { if (error instanceof AdmissionError && error.reason === 'identity_changed') this.failed(id, error); throw error; }
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
    const record = this.get(id);
    if (!record.enabled || record.state === 'identity_changed') throw new AdmissionError(409, record.lastError ?? 'connection_paused');
    if (!record.purposes.includes('gui')) throw new AdmissionError(403, 'gui_connection_required');
    try {
      const credential = await this.secrets.read<Credential>({ connectionId: record.credentialRef, purpose: 'gui' });
      const transport = await this.acquireTransport(id, signal, 'gui');
      const handshake = await this.handshake(transport.endpoint, credential.ownerToken, signal);
      if (!sameIdentity(handshake.identity, record.target)) throw new AdmissionError(409, 'identity_changed');
      if (!handshake.inboundEnabled) throw new AdmissionError(403, 'inbound_disabled');
      record.state = 'online'; record.lastConnectedAt = Date.now(); delete record.lastError;
      return { record, credential, transport };
    } catch (error) { this.failed(id, error); throw error; }
  }
  failed(id: string, error: unknown): void {
    const record = this.records.find((entry) => entry.id === id);
    if (record === undefined || !record.enabled || this.stopped) return;
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
    const { transport, credential } = await this.connect(id, signal);
    const url = new URL(connectionOperationPath(operation, input.params), transport.endpoint);
    if (operation === 'spaceSummary') signal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    for (const [key, value] of Object.entries(input.query ?? {})) for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    const method = CONNECTION_OPERATIONS[operation][0];
    const headers = { authorization: `Bearer ${credential.ownerToken}`, 'x-kiki-connection-grant': credential.grant, 'content-type': contentType ?? 'application/json',
      ...input.headers?.ifNoneMatch === undefined ? {} : { 'if-none-match': input.headers.ifNoneMatch },
      ...input.headers?.range === undefined ? {} : { range: input.headers.range } };
    try {
      const response = await fetch(url, { method, headers, body: rawBody ?? (input.body === undefined ? undefined : JSON.stringify(input.body)), redirect: 'error', signal, duplex: rawBody === undefined ? undefined : 'half' } as RequestInit);
      if (response.status === 401 || response.status === 403) {
        const refusal = await readConnectionRefusal(response, signal);
        if (refusal?.code === 40301 && typeof refusal.msg === 'string' && ['htmlPreviewOpen', 'htmlPreviewResource', 'htmlPreviewClose'].includes(operation) && ['html_preview_target_owner_grant_required', 'html_preview_document_origin_requires_local_connection', 'preview_path_outside_root', 'preview_resource_forbidden'].includes(refusal.msg)) return new Response(refusal.body, { status: response.status, statusText: response.statusText, headers: response.headers });
        void response.body?.cancel().catch(() => {});
        throw new AdmissionError(response.status, refusal?.code === 40301 && refusal.msg === 'inbound_disabled' ? 'inbound_disabled' : 'connection_not_approved');
      }
      return response;
    } catch (error) { this.failed(id, error); throw error; }
  }
  private async handshake(endpoint: string, token: string, signal?: AbortSignal) {
    const envelope = await this.jsonRequest(endpoint + '/api/remote-connections/handshake', { headers: { authorization: `Bearer ${token}` }, signal }, 8192) as { code: number; data: unknown };
    if (envelope.code !== 0) throw new AdmissionError(401, 'handshake_failed'); return connectionHandshakeSchema.parse(envelope.data);
  }
  private async jsonRequest(url: string, init: RequestInit, bytes: number): Promise<unknown> {
    const signal = init.signal === undefined || init.signal === null ? AbortSignal.timeout(15000) : AbortSignal.any([init.signal, AbortSignal.timeout(15000)]);
    const response = await fetch(url, { ...init, signal, redirect: 'error' });
    if (!response.ok) {
      const envelope = await readBoundedJsonBody(response, 8192).catch(() => undefined) as { msg?: unknown } | undefined;
      const reasons = ['inbound_disabled', 'dangerous_auth_bypass', 'identity_changed', 'local_owner_required', 'invalid_owner_credential', 'connection_not_approved'];
      const reason = typeof envelope?.msg === 'string' && reasons.includes(envelope.msg) ? envelope.msg
        : response.status === 401 ? 'authentication_required' : 'connection_request_rejected';
      throw new AdmissionError(response.status, reason);
    }
    return readBoundedJsonBody(response, bytes);
  }
  private change<T>(work: () => Promise<T>): Promise<T> { const result = this.tail.then(async () => { const value = await work(); await writePrivateFile(this.path, JSON.stringify(this.records)); return value; }); this.tail = result.catch(() => undefined); return result; }
}
function descriptorEndpoint(transport: NonNullable<RemoteConnection['transport']>): string { return transport.kind === 'ssh' ? sshEndpoint(transport.profile) : `space://${encodeURIComponent(transport.localSpaceId)}`; }
function sshEndpoint(profile: SshRemoteProfile): string { return `ssh://${encodeURIComponent(profile.id)}`; }
export function validateEndpoint(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) || (url.pathname !== '/' && url.pathname !== '')) throw new AdmissionError(400, 'invalid_connection_endpoint');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new AdmissionError(400, 'connection_requires_tls');
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
