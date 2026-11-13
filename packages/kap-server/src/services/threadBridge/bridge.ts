import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  IBootstrapService, ICapabilitySnapshotService, IConfigService, ISessionIndex, ISessionManager, ISessionActivityView, IThreadCommunicationService, IThreadMailboxStore, IWorkspaceService,
  spaceThreadCapability, SPACE_THREAD_ROUTER, RECHECK_BRIDGED_THREADS, ACCEPT_BRIDGED_THREAD_MESSAGE,
  Error2, ErrorCodes, isError2, ThreadMailboxBacklogError, type Scope, type ThreadRef, type AcceptedThreadMessage,
  type SpaceThreadConnector, type SendPeerThreadMessageInput, type SendThreadMessageResult,
  type ListThreadsInput, type ListThreadsResult, type ReadThreadInput, type ReadThreadResult,
  type WaitThreadsInput, type WaitThreadsResult,
} from '@kiki/agent-core-v2';
import {
  bridgePolicySchema, bridgeInstallSchema, bridgeListSchema, bridgeReadSchema, bridgeSendSchema, bridgeWaitSchema, peerBridgeInstallSchema,
  type BridgeGrant, type BridgePolicy, type BridgeLink, type BridgeSend, type BridgeReceipt, type BridgeOperation, type ConnectionIdentity, type PeerBridgeInstall,
} from '@kiki/protocol';
import { readBoundedJsonBody, SESSION_READ_BODY_BYTES } from '@kiki/klient/transports/http/bounded-body';
import { okEnvelope, errEnvelope } from '../../envelope';
import { AdmissionError, sameIdentity, type ConnectionAdmission } from '../connections/admission';
import { peerAudience } from '../connections/audience';
import type { RemoteConnectionManager } from '../connections/manager';
import { peerFetch } from '../connections/peerTls';
import { readPrivateFile, writePrivateFile } from '../auth/privateFiles';
import type { TranscriptService } from '../transcript/transcriptService';
import type { PeerBridgeRegistry } from '../../transport/klient/peerBridgeSocket';
import { readSessionViewTranscriptPage, readSessionViewTranscriptContent } from '../../transport/klient/sessionViewReads';
import { ContentChangedError } from '../../transport/klient/boundedContent';
import { bridgeTargetInputSchema, localBridgePolicySchema } from '@kiki/protocol';
import { THREAD_COMMUNICATION_SECTION } from '@kiki/agent-core-v2/app/threadCommunication/configSection';
import { provisionLocalBridge } from './localProvision';

interface Inbound { grant: BridgeGrant; digest: string; connectionGrantId?: string; peerConnectionId?: string }
interface Outbound extends BridgeLink { connectionGrantId?: string }
interface Outbox { receipt: BridgeReceipt; request?: BridgeSend; fingerprint: string; attempts?: number; nextAttemptAt?: number; finishedAt?: number }
interface State { inbound: Inbound[]; outbound: Outbound[]; outbox: Outbox[]; nextSeq: number; targets?: ThreadRef[]; inboundKeys?: { key: string; grantId: string; at: number }[] }
interface RemoteEnvelope<T> { code: number; msg: string; data: { identity: ConnectionAdmission['identity']; result: T } }
const RECEIPT_RETENTION_MS = 7 * 24 * 3600000;
const isPending = (entry: Outbox) => entry.receipt.delivery === 'pending' || entry.receipt.delivery === 'accepted';
const DATA_PATHS = new Set(['/api/thread-bridge/list', '/api/thread-bridge/read', '/api/thread-bridge/send', '/api/thread-bridge/wait']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const plainRef = (ref: ThreadRef): ThreadRef => ({ hostId: ref.hostId, workspaceId: ref.workspaceId, sessionId: ref.sessionId });
const inScope = (scope: BridgeGrant['sourceScope'], ref: ThreadRef) => scope.workspaceId === ref.workspaceId && (scope.sessionId === undefined || scope.sessionId === ref.sessionId);
function denied(reason: string): never { throw new AdmissionError(403, reason); }
const authenticatedBridgeRequests = new WeakMap<FastifyRequest, BridgeGrant>();

export class SpaceThreadBridge implements SpaceThreadConnector {
  private state: State = { inbound: [], outbound: [], outbox: [], nextSeq: 1 };
  private readonly path: string;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly flights = new Map<string, Promise<void>>();
  private readonly incoming = new Map<string, Set<AbortController>>();
  private readonly outgoing = new Map<string, Set<AbortController>>();
  private retryFlight?: Promise<void>;
  private readonly lifetime = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private readonly threads: IThreadCommunicationService;
  private readonly sessions: ISessionIndex;
  private readonly mailbox: IThreadMailboxStore;
  constructor(readonly core: Scope, readonly admission: ConnectionAdmission, readonly connections: RemoteConnectionManager, private readonly transcript: TranscriptService, private readonly peerBridges?: PeerBridgeRegistry) {
    this.path = join(core.accessor.get(IBootstrapService).homeDir, 'server', 'thread-bridges.json');
    this.threads = core.accessor.get(IThreadCommunicationService);
    this.sessions = core.accessor.get(ISessionIndex);
    this.mailbox = core.accessor.get(IThreadMailboxStore);
  }
  private readonly changeListeners = new Set<() => void>();
  onDidChange(listener: () => void): { dispose(): void } {
    this.changeListeners.add(listener);
    return { dispose: () => { this.changeListeners.delete(listener); } };
  }
  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }
  async ready(): Promise<void> {
    try { this.state = JSON.parse((await readPrivateFile(this.path)).toString('utf8')) as State;
      if (!Array.isArray(this.state.inbound) || !Array.isArray(this.state.outbox) || !Array.isArray(this.state.outbound) || !Number.isSafeInteger(this.state.nextSeq)) throw new Error('Invalid bridge store');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    spaceThreadCapability(this.threads)[SPACE_THREAD_ROUTER](this);
    this.timer = setInterval(() => { void this.retry().catch(() => {}); }, 1000); this.timer.unref();
    void this.retry().catch(() => {});
  }
  async close(): Promise<void> {
    this.lifetime.abort(); if (this.timer !== undefined) clearInterval(this.timer);
    for (const controllers of this.incoming.values()) for (const controller of controllers) controller.abort();
    await Promise.allSettled([...this.flights.values(), this.retryFlight]); await this.tail;
    spaceThreadCapability(this.threads)[SPACE_THREAD_ROUTER](undefined);
  }
  status() { return { identity: this.admission.identity, inboundEnabled: this.admission.status().enabled,
    inbound: this.state.inbound.map((entry) => ({ ...entry.grant })), outbound: this.state.outbound.map(({ connectionGrantId: _connectionGrantId, ...entry }) => ({ ...entry, grant: { ...entry.grant } })) }; }
  receipts(cursor?: string, limit = 50) {
    const count = Math.max(1, Math.min(100, limit));
    const offset = cursor === undefined ? 0 : this.state.outbox.findIndex((entry) => entry.receipt.id === cursor) + 1;
    if (cursor !== undefined && offset === 0) throw new AdmissionError(409, 'receipt_cursor_expired');
    const page = this.state.outbox.slice(offset, offset + count);
    return { items: page.map((entry) => ({ ...entry.receipt })), nextCursor: offset + count < this.state.outbox.length ? page.at(-1)?.receipt.id : undefined };
  }
  async issuePairingBridges(input: { grantId?: string; source: ConnectionIdentity; sourceLabel: string; sourceWorkspaces: readonly string[]; approvedOperations?: readonly BridgeOperation[]; requestedOperations?: readonly BridgeOperation[] }): Promise<{ grant: BridgeGrant; credential: string }[]> {
    const sourceWorkspace = input.sourceWorkspaces[0];
    if (sourceWorkspace === undefined || !this.admission.status().enabled) return [];
    const allowed: readonly BridgeOperation[] = input.approvedOperations ?? ['read', 'send', 'wait'];
    const operations = input.requestedOperations === undefined
      ? [...allowed]
      : allowed.filter((op) => input.requestedOperations!.includes(op));
    if (operations.length === 0) denied('bridge_operation_denied');
    const workspaces = [...await this.core.accessor.get(IWorkspaceService).list()].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    if (workspaces.length === 0) return [];
    await this.enableThreads();
    let targetWorkspace: string | undefined;
    for (const workspace of workspaces) if (await this.threads.isWorkspaceEnabled(workspace.id)) { targetWorkspace = workspace.id; break; }
    if (targetWorkspace === undefined) return [];
    const label = input.sourceLabel.trim().slice(0, 128) || 'Kiki';
    return [await this.approve({ source: input.source, target: this.admission.identity, sourceScope: { workspaceId: sourceWorkspace }, targetScope: { workspaceId: targetWorkspace }, operations, expiresAt: Date.now() + 366 * 24 * 3600 * 1000 * 10, pendingLimit: 20, messagesPerMinute: 60, location: 'network', label }, input.grantId)];
  }
  async ensureReversePeerBridge(input: { connectionId: string; target: ConnectionIdentity; label: string; signal: AbortSignal }): Promise<{ grant: BridgeGrant; credential: string } | undefined> {
    if (this.admission.unavailableReason !== undefined) return undefined;
    const forward = this.state.outbound.find((entry) => entry.connectionId === input.connectionId && !entry.grant.revoked && sameIdentity(entry.grant.target, input.target));
    if (forward === undefined) return undefined;
    const localWorkspaceId = forward.grant.sourceScope.workspaceId;
    const remoteWorkspaceId = forward.grant.targetScope.workspaceId;
    if (!this.admission.status().enabled) await this.admission.setEnabled(true);
    await this.enableThreads();
    if (!(await this.threads.isWorkspaceEnabled(localWorkspaceId))) return undefined;
    input.signal.throwIfAborted();
    const existing = this.state.inbound.find((entry) => !entry.grant.revoked && entry.peerConnectionId === input.connectionId);
    if (existing !== undefined) {
      if (existing.grant.enabled) {
        const stored = await this.connections.secrets.read<{ credential: string }>({ connectionId: existing.grant.id, purpose: 'bridge' }).catch(() => undefined);
        input.signal.throwIfAborted();
        if (stored !== undefined && typeof stored.credential === 'string' && stored.credential.length >= 32) return { grant: { ...existing.grant }, credential: stored.credential };
      }
      const credential = randomBytes(32).toString('base64url');
      await this.change(async () => {
        input.signal.throwIfAborted();
        existing.grant.revision += 1;
        existing.grant.enabled = true;
        existing.digest = hash(credential);
        existing.peerConnectionId = input.connectionId;
        await this.connections.secrets.write({ connectionId: existing.grant.id, purpose: 'bridge' }, { credential });
      });
      return { grant: { ...existing.grant }, credential };
    }
    const label = input.label.trim().slice(0, 128) || 'Kiki';
    const credential = randomBytes(32).toString('base64url');
    const grant: BridgeGrant = {
      source: input.target,
      target: this.admission.identity,
      sourceScope: { workspaceId: remoteWorkspaceId },
      targetScope: { workspaceId: localWorkspaceId },
      operations: ['read', 'send', 'wait'],
      expiresAt: Date.now() + 366 * 24 * 3600 * 1000 * 10,
      pendingLimit: 20,
      messagesPerMinute: 60,
      location: 'network',
      label, id: randomUUID(), revision: 1, enabled: true, revoked: false, createdAt: Date.now(),
    };
    await this.change(async () => {
      input.signal.throwIfAborted();
      if (this.state.inbound.length >= 1000) throw new AdmissionError(429, 'bridge_grant_limit');
      await this.connections.secrets.write({ connectionId: grant.id, purpose: 'bridge' }, { credential });
      this.state.inbound.push({ grant, digest: hash(credential), peerConnectionId: input.connectionId });
    });
    return { grant, credential };
  }
  async revokeReversePeerBridges(connectionId: string): Promise<string[]> {
    const revokedIds: string[] = [];
    await this.change(async () => {
      for (const entry of this.state.inbound) {
        if (entry.peerConnectionId !== connectionId || entry.grant.revoked) continue;
        entry.grant.revoked = true; entry.grant.enabled = false; entry.grant.revision += 1;
        this.cancelIncoming(entry.grant.id); revokedIds.push(entry.grant.id);
      }
      for (const id of revokedIds) await this.connections.secrets.remove({ connectionId: id, purpose: 'bridge' }).catch(() => undefined);
    });
    return revokedIds;
  }
  revokedPairingBridges(source: ConnectionIdentity): string[] {
    return this.state.inbound.filter((entry) => entry.connectionGrantId !== undefined && entry.grant.revoked && sameIdentity(entry.grant.source, source)).map((entry) => entry.grant.id);
  }
  async retireConfirmedBridges(connectionId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.change(async () => {
      for (const entry of this.state.outbound) {
        if (entry.connectionId !== connectionId || entry.grant.revoked || !ids.includes(entry.grant.id)) continue;
        entry.grant.revoked = true; entry.enabled = false; this.cancelOutgoing(entry.grant.id);
        await this.connections.secrets.remove({ connectionId: entry.grant.id, purpose: 'bridge' });
      }
    });
    this.emitChange(); await this.retry();
  }
  async retirePairing(connectionId: string, grantId: string): Promise<void> {
    await this.revokeForConnectionGrant(grantId);
    await this.revokeReversePeerBridges(connectionId);
    this.emitChange();
  }
  async revokeForConnectionGrant(connectionGrantId: string): Promise<void> {
    let changed = false;
    const removedOutbound: string[] = [];
    await this.change(async () => {
      for (const entry of this.state.inbound) {
        if (entry.connectionGrantId !== connectionGrantId || entry.grant.revoked) continue;
        entry.grant.revoked = true; entry.grant.enabled = false; entry.grant.revision++; this.cancelIncoming(entry.grant.id); changed = true;
      }
      for (const entry of this.state.outbound) {
        if (entry.connectionGrantId !== connectionGrantId || entry.grant.revoked) continue;
        entry.enabled = false; entry.grant.revoked = true; this.cancelOutgoing(entry.grant.id); removedOutbound.push(entry.grant.id); changed = true;
      }
      for (const id of removedOutbound) await this.connections.secrets.remove({ connectionId: id, purpose: 'bridge' });
    });
    if (!changed) return;
    await this.retryFlight;
    await this.retry();
  }
  async revokeInboundFrom(id: string, source: ConnectionIdentity): Promise<void> {
    const entry = this.state.inbound.find((value) => value.grant.id === id);
    if (entry === undefined || entry.grant.revoked) return;
    if (!sameIdentity(entry.grant.source, source)) throw new AdmissionError(403, 'bridge_identity_mismatch');
    await this.revoke(id, 'inbound');
  }
  async enableThreads(): Promise<void> {
    const config = this.core.accessor.get(IConfigService);
    if (config.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled !== true) await config.set(THREAD_COMMUNICATION_SECTION, { enabled: true });
    try {
      const page = await this.core.accessor.get(ISessionIndex).listRecent({ limit: 200 });
      const snapshot = this.core.accessor.get(ICapabilitySnapshotService);
      for (const item of page.items) snapshot.refresh(item.workspaceId, item.id);
    } catch { return; }
  }
  async approve(policy: BridgePolicy, connectionGrantId?: string) {
    if (!this.admission.status().enabled) denied('inbound_disabled');
    if (!sameIdentity(policy.target, this.admission.identity) || sameIdentity(policy.source, policy.target)) denied('bridge_identity_mismatch');
    if (policy.expiresAt <= Date.now()) denied('bridge_expired');
    if (policy.targetScope.sessionId !== undefined) await this.requireTarget({ hostId: policy.target.hostId, ...policy.targetScope, sessionId: policy.targetScope.sessionId });
    else if (!(await this.threads.isWorkspaceEnabled(policy.targetScope.workspaceId))) denied('workspace_disabled');
    const credential = randomBytes(32).toString('base64url');
    const grant: BridgeGrant = { ...policy, id: randomUUID(), revision: 1, enabled: true, revoked: false, createdAt: Date.now() };
    await this.change(() => {
      if (connectionGrantId !== undefined && !this.admission.approvedPeer(connectionGrantId)?.allowBridge) denied('connection_not_approved');
      if (this.state.inbound.length >= 1000) throw new AdmissionError(429, 'bridge_grant_limit');
      this.state.inbound.push({ grant, digest: hash(credential), connectionGrantId });
    });
    return { grant, credential };
  }
  async install(input: ReturnType<typeof bridgeInstallSchema.parse>, connectionGrantId?: string): Promise<BridgeLink> {
    const descriptor = this.connections.resolveTransport(input.connectionId);
    const epoch = this.connections.credentialEpoch(input.connectionId);
    if (!sameIdentity(input.grant.source, this.admission.identity) || !sameIdentity(input.grant.target, descriptor.target)) denied('bridge_identity_mismatch');
    const link: Outbound = { connectionId: input.connectionId, grant: input.grant, enabled: true, connectionGrantId };
    await this.change(async () => {
      if (epoch !== this.connections.credentialEpoch(input.connectionId)) denied('connection_not_approved');
      if (connectionGrantId !== undefined && !this.connections.get(input.connectionId).purposes.includes('gui') && !this.admission.approvedPeer(connectionGrantId)?.allowBridge) denied('connection_not_approved');
      const previous = this.state.outbound.find((entry) => entry.grant.id === input.grant.id);
      const idempotentPeerInstall = previous !== undefined && !previous.grant.revoked && connectionGrantId !== undefined && previous.connectionGrantId === connectionGrantId && input.grant.revision === previous.grant.revision;
      if (previous !== undefined && (previous.grant.revoked || (!idempotentPeerInstall && input.grant.revision <= previous.grant.revision))) throw new AdmissionError(409, 'bridge_revision_not_newer');
      if (input.grant.revoked || !input.grant.enabled || input.grant.expiresAt <= Date.now()) denied('bridge_operation_denied');
      if (connectionGrantId !== undefined && this.connections.get(input.connectionId).purposes.includes('gui')) {
        const credential = await this.connections.secrets.read<{ grantId: string }>({ connectionId: this.connections.get(input.connectionId).credentialRef, purpose: 'gui' });
        if (credential.grantId !== connectionGrantId) denied('connection_not_approved');
      }
      await this.connections.secrets.write({ connectionId: input.grant.id, purpose: 'bridge' }, { credential: input.credential });
      if (epoch !== this.connections.credentialEpoch(input.connectionId)) denied('connection_not_approved');
      if (connectionGrantId !== undefined && !this.connections.get(input.connectionId).purposes.includes('gui') && !this.admission.approvedPeer(connectionGrantId)?.allowBridge) denied('connection_not_approved');
      this.cancelOutgoing(input.grant.id);
      if (previous === undefined) this.state.outbound.push(link); else Object.assign(previous, link);
    });
    this.emitChange();
    const { connectionGrantId: _connectionGrantId, ...publicLink } = link;
    return publicLink;
  }
  async installFromPeer(peerGrantId: string, input: PeerBridgeInstall): Promise<BridgeLink> {
    const peer = this.admission.approvedPeer(peerGrantId);
    if (peer === undefined || !peer.allowBridge) denied('connection_not_approved');
    if (!sameIdentity(input.grant.source, this.admission.identity) || !sameIdentity(input.grant.target, peer.source)) denied('bridge_identity_mismatch');
    await this.enableThreads();
    const target = await this.connections.ensurePeerBridgeTarget({ grantId: peer.id, label: input.grant.label, target: peer.source, endpoint: input.endpoint });
    return this.install({ connectionId: target.id, grant: input.grant, credential: input.credential }, peer.id);
  }
  async revokeFromPeer(peerGrantId: string, bridgeId: string): Promise<void> {
    const peer = this.admission.approvedPeer(peerGrantId);
    if (peer === undefined || !peer.allowBridge) denied('connection_not_approved');
    const entry = this.state.outbound.find((item) => item.grant.id === bridgeId);
    if (entry === undefined || entry.grant.revoked) return;
    if (entry.connectionGrantId !== peer.id && !sameIdentity(entry.grant.target, peer.source)) denied('bridge_identity_mismatch');
    await this.revoke(bridgeId, 'outbound');
  }
  async setEnabled(id: string, enabled: boolean, direction: 'inbound' | 'outbound'): Promise<void> {
    await this.change(() => {
      if (direction === 'inbound') { const entry = this.state.inbound.find((g) => g.grant.id === id); if (entry === undefined) throw new AdmissionError(404, 'bridge_not_found');
        if (entry.grant.revoked) denied('bridge_revoked'); entry.grant.enabled = enabled; entry.grant.revision++; this.cancelIncoming(id);
      } else { const entry = this.link(id); if (entry.grant.revoked) denied('bridge_revoked'); entry.enabled = enabled; if (!enabled) this.cancelOutgoing(id); }
    });
    this.emitChange();
    await this.retry();
  }
  async revoke(id: string, direction: 'inbound' | 'outbound'): Promise<void> {
    await this.change(async () => {
      if (direction === 'inbound') { const entry = this.state.inbound.find((g) => g.grant.id === id); if (entry === undefined) throw new AdmissionError(404, 'bridge_not_found');
        entry.grant.revoked = true; entry.grant.enabled = false; entry.grant.revision++; this.cancelIncoming(id);
        await this.connections.secrets.remove({ connectionId: id, purpose: 'bridge' }).catch(() => undefined);
      } else { const entry = this.link(id); entry.enabled = false; entry.grant.revoked = true; this.cancelOutgoing(id);
        await this.connections.secrets.remove({ connectionId: id, purpose: 'bridge' }); }
    });
    this.emitChange();
    await this.retryFlight;
    await this.retry();
  }
  async onAdmissionChange(change?: { kind: 'enabled' | 'revoked'; enabled: boolean; grantId?: string }): Promise<void> {
    if (!this.admission.status().enabled) for (const id of this.incoming.keys()) this.cancelIncoming(id);
    if (change?.kind === 'revoked' && change.grantId !== undefined) { await this.revokeForConnectionGrant(change.grantId); return; }
    void this.retry().catch(() => {});
  }
  authorizeCredential(credential: string): BridgeGrant {
    if (!this.admission.status().enabled) denied('inbound_disabled');
    const candidate = Buffer.from(hash(credential));
    const entry = this.state.inbound.find((value) => { const expected = Buffer.from(value.digest); return expected.length === candidate.length && timingSafeEqual(expected, candidate); });
    if (entry === undefined) throw new AdmissionError(401, 'invalid_bridge_credential');
    this.requireGrant(entry.grant); return entry.grant;
  }
  private requireGrant(grant: BridgeGrant): void {
    const parentId = this.state.inbound.find((entry) => entry.grant.id === grant.id)?.connectionGrantId;
    if (parentId !== undefined && !this.admission.approvedPeer(parentId)?.allowBridge) denied('bridge_revoked');
    if (!grant.enabled || grant.revoked) denied('bridge_revoked');
    if (grant.expiresAt <= Date.now()) denied('bridge_expired');
    if (!sameIdentity(grant.target, this.admission.identity)) denied('bridge_identity_mismatch');
  }
  private checkInbound(grant: BridgeGrant, request: { bridgeId: string; revision: number; source: ThreadRef }, operation: BridgeOperation, target?: ThreadRef): void {
    if (!this.admission.status().enabled) denied('inbound_disabled');
    this.requireGrant(grant);
    if (request.bridgeId !== grant.id || request.revision !== grant.revision) denied('bridge_revision_mismatch');
    if (request.source.hostId !== grant.source.hostId || !inScope(grant.sourceScope, request.source)) denied('bridge_source_scope');
    if (!grant.operations.includes(operation)) denied('bridge_operation_denied');
    if (target !== undefined && (target.hostId !== this.admission.identity.hostId || !inScope(grant.targetScope, target))) denied('bridge_target_scope');
  }
  async beforeDelivery(message: AcceptedThreadMessage): Promise<'deliver' | 'pending'> {
    if (message.producer.kind !== 'bridged_peer') return 'deliver';
    if (this.lifetime.signal.aborted) return 'pending';
    const producer = message.producer;
    const grant = this.state.inbound.find((entry) => entry.grant.id === producer.bridgeId)?.grant;
    try {
      if (grant === undefined) denied('bridge_revoked');
      this.checkInbound(grant, producer, 'send', message.target);
      if (producer.sourceHomeId !== grant.source.homeId || producer.targetHomeId !== grant.target.homeId || producer.location !== grant.location) denied('bridge_identity_mismatch');
      if (producer.expiresAt <= Date.now() || producer.expiresAt > grant.expiresAt || producer.createdAt > Date.now() + 30000 || producer.hop > 4) denied('bridge_message_expired');
      if (!(await this.threads.isWorkspaceEnabled(message.target.workspaceId, message.target))) denied('workspace_disabled');
      return grant.operations.includes('wake') ? 'deliver' : 'pending';
    } catch (error) { throw new Error2(ErrorCodes.THREAD_DISABLED, error instanceof Error ? error.message : 'Bridge rejected.', { cause: error }); }
  }
  private async requireTarget(target: ThreadRef): Promise<void> {
    if (target.hostId !== this.admission.identity.hostId) denied('bridge_identity_mismatch');
    const summary = await this.sessions.get(target.sessionId);
    if (summary === undefined || summary.workspaceId !== target.workspaceId) throw new AdmissionError(404, 'thread_not_found');
    if (summary.archived) throw new AdmissionError(410, 'thread_archived');
    if (!(await this.threads.isWorkspaceEnabled(target.workspaceId, target))) denied('workspace_disabled');
  }
  async inboundList(grant: BridgeGrant, input: ReturnType<typeof bridgeListSchema.parse>): Promise<ListThreadsResult> {
    this.checkInbound(grant, input, 'read');
    if (input.workspaceId !== undefined && input.workspaceId !== grant.targetScope.workspaceId) denied('bridge_target_scope');
    if (!(await this.threads.isWorkspaceEnabled(grant.targetScope.workspaceId))) denied('workspace_disabled');
    if (grant.targetScope.sessionId !== undefined) {
      const ref = { hostId: grant.target.hostId, workspaceId: grant.targetScope.workspaceId, sessionId: grant.targetScope.sessionId };
      await this.requireTarget(ref); const summary = await this.sessions.get(ref.sessionId);
      const live = this.core.accessor.get(ISessionManager).get(ref.sessionId);
      const state = live === undefined ? 'cold' : live.accessor.get(ISessionActivityView).state().busy ? 'running' : 'idle';
      return { threads: summary === undefined ? [] : [{ ref, title: summary.title, createdAt: summary.createdAt, updatedAt: summary.updatedAt, state }] };
    }
    return this.threads.listThreads({ workspaceId: grant.targetScope.workspaceId, cursor: input.cursor, limit: input.limit });
  }
  async inboundRead(grant: BridgeGrant, input: ReturnType<typeof bridgeReadSchema.parse>, signal: AbortSignal): Promise<ReadThreadResult> {
    this.checkInbound(grant, input, 'read', input.target); await this.requireTarget(input.target); signal.throwIfAborted();
    if (input.contentRef !== undefined) {
      const segment = await readSessionViewTranscriptContent(this.transcript, input.target.sessionId, { agentId: 'main', ref: input.contentRef, signal });
      return { thread: input.target, turns: [], view: { segment } };
    }
    const transcript = await readSessionViewTranscriptPage(this.transcript, input.target.sessionId, { agentId: 'main', beforeItem: input.cursor, pageSize: input.limit ?? 20, signal });
    return { thread: input.target, turns: [], nextCursor: transcript?.next_cursor, view: { transcript } };
  }
  async inboundSend(grant: BridgeGrant, input: BridgeSend): Promise<SendThreadMessageResult> {
    this.checkInbound(grant, input, 'send', input.target); await this.requireTarget(input.target);
    const producer = { kind: 'bridged_peer' as const, source: input.source, bridgeId: grant.id, revision: input.revision,
      sourceHomeId: input.sourceHomeId, targetHomeId: input.targetHomeId, location: grant.location,
      createdAt: input.createdAt, expiresAt: input.expiresAt, sourceSeq: input.sourceSeq, causeId: input.causeId, hop: input.hop };
    await this.beforeDelivery({ producer, target: input.target, content: input.content, idempotencyKey: input.idempotencyKey, messageId: '', acceptedAt: Date.now(), targetSeq: 0 });
    const key = hash(JSON.stringify([grant.id, input.source, input.target, input.idempotencyKey]));
    await this.change(() => {
      const now = Date.now();
      const keys = this.state.inboundKeys = (this.state.inboundKeys ?? []).filter((entry) => entry.at > now - RECEIPT_RETENTION_MS);
      const duplicate = keys.some((entry) => entry.key === key);
      if (!duplicate && keys.filter((entry) => entry.grantId === grant.id && entry.at > now - 60000).length >= grant.messagesPerMinute) throw new AdmissionError(429, 'bridge_rate_limit');
      if (!duplicate) keys.push({ key, grantId: grant.id, at: now });
    });
    const record = await this.change(async () => {
      this.checkInbound(grant, input, 'send', input.target);
      const targets = this.state.targets ??= [];
      if (!targets.some((target) => JSON.stringify(target) === JSON.stringify(input.target))) {
        if (targets.length >= 100) throw new AdmissionError(429, 'bridge_target_queue_full'); targets.push(input.target);
      }
      return this.mailbox.acceptMessage({ producer, target: input.target, content: input.content, idempotencyKey: input.idempotencyKey,
        pendingLimit: grant.pendingLimit, rateLimit: { key: grant.id, count: grant.messagesPerMinute, windowMs: 60000 } });
    });
    if (record.payloadConflict) throw new AdmissionError(409, 'bridge_idempotency_conflict');
    return spaceThreadCapability(this.threads)[ACCEPT_BRIDGED_THREAD_MESSAGE]({ producer, target: input.target, content: input.content, idempotencyKey: input.idempotencyKey });
  }
  async inboundWait(grant: BridgeGrant, input: ReturnType<typeof bridgeWaitSchema.parse>, signal: AbortSignal): Promise<WaitThreadsResult> {
    this.checkInbound(grant, input, 'wait', input.target); await this.requireTarget(input.target);
    let threads = [{ thread: input.target, cursor: input.cursor }]; const deadline = Date.now() + (input.timeoutMs ?? 30000);
    for (;;) { signal.throwIfAborted(); this.checkInbound(grant, input, 'wait', input.target); await this.requireTarget(input.target);
      const result = await this.threads.waitThreads({ threads, timeoutMs: 0 });
      if (!result.timedOut || Date.now() >= deadline) return result;
      threads = result.threads.map((entry) => ({ thread: entry.thread, cursor: entry.cursor })); await pause(200, signal);
    }
  }
  private link(id: string): BridgeLink { const link = this.state.outbound.find((entry) => entry.grant.id === id); if (link === undefined) throw new AdmissionError(404, 'bridge_not_found'); return link; }
  private choose(ref: { bridgeId?: string; connectionId?: string }, source?: { workspaceId: string; sessionId: string }, target?: ThreadRef, operation: BridgeOperation = 'read'): BridgeLink {
    const links = this.state.outbound.filter((entry) => (ref.bridgeId === undefined ? !entry.grant.revoked : entry.grant.id === ref.bridgeId) && (ref.connectionId === undefined || entry.connectionId === ref.connectionId) &&
      source !== undefined && inScope(entry.grant.sourceScope, { ...source, hostId: this.admission.identity.hostId }) && (target === undefined || target.hostId === entry.grant.target.hostId && inScope(entry.grant.targetScope, target)));
    if (links.length !== 1) denied(links.length === 0 ? 'bridge_not_authorized' : 'bridge_ambiguous');
    const link = links[0]!;
    if (!link.enabled || link.grant.revoked || !link.grant.enabled || link.grant.expiresAt <= Date.now() || !link.grant.operations.includes(operation)) denied('bridge_operation_denied');
    const descriptor = this.connections.resolveTransport(link.connectionId);
    if (!sameIdentity(link.grant.source, this.admission.identity) || !sameIdentity(link.grant.target, descriptor.target)) denied('bridge_identity_mismatch');
    return link;
  }
  private source(source: { workspaceId: string; sessionId: string } | undefined): ThreadRef { if (source === undefined) denied('bridge_source_required'); return plainRef({ hostId: this.admission.identity.hostId, ...source }); }
  async list(input: ListThreadsInput): Promise<ListThreadsResult> {
    const link = this.choose(input, input.caller);
    const result = await this.remote<ListThreadsResult>(link, 'list', { bridgeId: link.grant.id, revision: link.grant.revision, source: this.source(input.caller), workspaceId: input.workspaceId, cursor: input.cursor, limit: input.limit }, input.signal);
    return { ...result, threads: result.threads.map((entry) => ({ ...entry, ref: { ...entry.ref, bridgeId: link.grant.id, connectionId: link.connectionId } })) };
  }
  async read(input: ReadThreadInput): Promise<ReadThreadResult> {
    const link = this.choose(input.thread, input.caller, input.thread);
    const result = await this.remote<ReadThreadResult>(link, 'read', { bridgeId: link.grant.id, revision: link.grant.revision, source: this.source(input.caller), target: plainRef(input.thread), cursor: input.cursor, limit: input.limit, contentRef: input.contentRef }, input.signal);
    return { ...result, thread: input.thread };
  }
  async send(input: SendPeerThreadMessageInput): Promise<SendThreadMessageResult> {
    const link = this.choose(input.target, input.source, input.target, 'send');
    const fingerprint = hash(JSON.stringify({ source: plainRef(input.source), target: plainRef(input.target), content: input.content }));
    const id = hash(JSON.stringify([link.grant.id, plainRef(input.source), plainRef(input.target), input.idempotencyKey]));
    let existing: Outbox | undefined; let duplicate = false;
    await this.change(() => {
      input.signal?.throwIfAborted();
      const now = Date.now();
      this.state.outbox = this.state.outbox.filter((entry) => isPending(entry) || (entry.finishedAt ?? entry.receipt.createdAt) > now - RECEIPT_RETENTION_MS);
      existing = this.state.outbox.find((entry) => entry.receipt.id === id);
      if (existing !== undefined) { duplicate = true; if (existing.fingerprint !== fingerprint) throw new AdmissionError(409, 'bridge_idempotency_conflict'); return; }
      const pending = this.state.outbox.filter(isPending);
      if (pending.length >= 100 || pending.filter((entry) => entry.receipt.bridgeId === link.grant.id).length >= link.grant.pendingLimit) throw new AdmissionError(429, 'bridge_queue_full');
      if (this.state.outbox.filter((entry) => entry.receipt.bridgeId === link.grant.id && entry.receipt.createdAt > now - 60000).length >= link.grant.messagesPerMinute) throw new AdmissionError(429, 'bridge_rate_limit');
      const hop = input.cause === undefined ? 0 : input.cause.hop + 1; if (hop > 4) denied('bridge_hop_limit');
      const expiresAt = Math.min(now + 15 * 60000, link.grant.expiresAt); const sourceSeq = this.state.nextSeq++;
      const request: BridgeSend = { bridgeId: link.grant.id, revision: link.grant.revision, source: plainRef(input.source), target: plainRef(input.target), content: input.content,
        idempotencyKey: input.idempotencyKey, sourceHomeId: this.admission.identity.homeId, targetHomeId: link.grant.target.homeId,
        createdAt: now, expiresAt, sourceSeq, causeId: input.cause?.causeId ?? randomUUID(), hop };
      const receipt: BridgeReceipt = { id, bridgeId: link.grant.id, connectionId: link.connectionId, source: request.source, target: request.target, sourceSeq, createdAt: now, expiresAt, delivery: 'pending' };
      existing = { receipt, request, fingerprint }; this.state.outbox.push(existing);
    });
    await this.retryLink(link.grant.id, input.signal);
    input.signal?.throwIfAborted();
    const receipt = existing!.receipt;
    return { messageId: receipt.messageId ?? receipt.id, targetSeq: receipt.targetSeq ?? 0, acceptedAt: receipt.acceptedAt ?? receipt.createdAt,
      deduplicated: duplicate, delivery: receipt.delivery === 'delivered' ? 'delivered' : ['rejected', 'undeliverable'].includes(receipt.delivery) ? 'undeliverable' : 'pending' };
  }
  async wait(input: WaitThreadsInput): Promise<WaitThreadsResult> {
    const signal = input.signal === undefined ? this.lifetime.signal : AbortSignal.any([input.signal, this.lifetime.signal]);
    const deadline = Date.now() + (input.timeoutMs ?? 30000); let threads = input.threads;
    for (;;) { signal.throwIfAborted(); const results = [];
      for (const item of threads) {
        if (['local', '', this.threads.hostId].includes(item.thread.hostId) && item.thread.bridgeId === undefined && item.thread.connectionId === undefined) {
          results.push(...(await this.threads.waitThreads({ caller: input.caller, threads: [item], timeoutMs: 0 })).threads); continue;
        }
        const link = this.choose(item.thread, input.caller, item.thread, 'wait');
        const result = await this.remote<WaitThreadsResult>(link, 'wait', { bridgeId: link.grant.id, revision: link.grant.revision, source: this.source(input.caller), target: plainRef(item.thread), cursor: item.cursor, timeoutMs: 0 }, signal);
        results.push(...result.threads.map((entry) => ({ ...entry, thread: item.thread })));
      }
      if (results.some((entry) => entry.activities.length > 0) || Date.now() >= deadline) return { threads: results, timedOut: results.every((entry) => entry.activities.length === 0) };
      threads = results.map((entry) => ({ thread: entry.thread, cursor: entry.cursor })); await pause(200, signal);
    }
  }
  retry(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve();
    if (this.retryFlight !== undefined) return this.retryFlight;
    const flight = this.doRetry(); this.retryFlight = flight;
    void flight.finally(() => { if (this.retryFlight === flight) this.retryFlight = undefined; }).catch(() => {});
    return flight;
  }
  private async doRetry(): Promise<void> {
    await Promise.allSettled(this.state.outbound.filter((link) => this.state.outbox.some((entry) => entry.receipt.bridgeId === link.grant.id && isPending(entry))).map((link) => this.retryLink(link.grant.id)));
    if (this.lifetime.signal.aborted) return;
    const targets = this.state.targets ?? [];
    await spaceThreadCapability(this.threads)[RECHECK_BRIDGED_THREADS](targets);
    if (targets.length > 0) await this.change(async () => {
      this.state.targets = [...await this.mailbox.listPendingTargets({ targets: this.state.targets ?? [], signal: this.lifetime.signal })];
    });
  }
  private retryLink(id: string, signal?: AbortSignal): Promise<void> {
    const flight = this.flights.get(id); if (flight !== undefined) return flight;
    const pending = this.doRetryLink(id, signal); this.flights.set(id, pending);
    void pending.finally(() => { if (this.flights.get(id) === pending) this.flights.delete(id); }).catch(() => {}); return pending;
  }
  private finish(entry: Outbox, delivery: 'delivered' | 'rejected' | 'undeliverable', reason?: string): void {
    entry.receipt.delivery = delivery; entry.receipt.reason = reason; entry.finishedAt = Date.now();
    entry.request = undefined; entry.nextAttemptAt = undefined;
  }
  private async doRetryLink(id: string, signal?: AbortSignal): Promise<void> {
    for (const entry of this.state.outbox.filter((record) => record.receipt.bridgeId === id && isPending(record)).sort((a, b) => a.receipt.sourceSeq - b.receipt.sourceSeq)) {
      if (this.lifetime.signal.aborted || signal?.aborted) return;
      const request = entry.request; if (request === undefined) throw new Error('Pending bridge receipt has no payload');
      try {
        if (request.expiresAt <= Date.now()) throw new AdmissionError(410, 'bridge_message_expired_without_delivery_confirmation');
        if (!this.link(id).enabled && !this.link(id).grant.revoked) return;
        const link = this.choose({ bridgeId: id }, request.source, request.target, 'send');
        if (entry.nextAttemptAt !== undefined && entry.nextAttemptAt > Date.now()) return;
        const result = await this.remote<SendThreadMessageResult>(link, 'send', request, signal);
        await this.change(() => {
          Object.assign(entry.receipt, { messageId: result.messageId, targetSeq: result.targetSeq, acceptedAt: result.acceptedAt });
          if (result.delivery === 'pending') { entry.receipt.delivery = 'accepted'; entry.receipt.reason = undefined; entry.attempts = 0; entry.nextAttemptAt = Date.now() + 1000; }
          else this.finish(entry, result.delivery);
        });
        if (result.delivery === 'pending') return;
      } catch (error) {
        if (signal?.aborted || this.lifetime.signal.aborted) return;
        if (error instanceof AdmissionError && [400, 401, 403, 404, 409, 410].includes(error.status)) {
          await this.change(() => this.finish(entry, 'rejected', error.reason)); continue;
        }
        await this.change(() => {
          entry.attempts = (entry.attempts ?? 0) + 1;
          entry.receipt.reason = error instanceof AdmissionError && error.status === 429 ? error.reason : 'target_temporarily_unavailable';
          entry.nextAttemptAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(6, entry.attempts));
        }); return;
      }
    }
  }
  async triggerPeerRetry(grantId: string): Promise<void> {
    let shouldRetry = false;
    await this.change(() => {
      for (const entry of this.state.outbox) {
        if (!isPending(entry)) continue;
        const link = this.state.outbound.find((item) => item.grant.id === entry.receipt.bridgeId);
        if (link?.connectionGrantId === grantId) {
          entry.nextAttemptAt = undefined;
          shouldRetry = true;
        }
      }
    });
    if (shouldRetry) void this.retry().catch(() => {});
  }
  private async remote<T>(link: BridgeLink, operation: 'list' | 'read' | 'send' | 'wait', body: unknown, parent?: AbortSignal): Promise<T> {
    const record = this.connections.get(link.connectionId);
    const descriptor = this.connections.resolveTransport(link.connectionId);
    if (!sameIdentity(descriptor.target, link.grant.target)) denied('bridge_identity_mismatch');
    const controller = new AbortController();
    const waitMs = operation === 'wait' ? bridgeWaitSchema.parse(body).timeoutMs ?? 30000 : 0;
    const lease = this.connections.lease(link.connectionId, AbortSignal.any([this.lifetime.signal, controller.signal, parent ?? this.lifetime.signal, AbortSignal.timeout(Math.max(15000, waitMs + 5000))]), 'bridge');
    const controllers = this.outgoing.get(link.grant.id) ?? new Set<AbortController>(); controllers.add(controller); this.outgoing.set(link.grant.id, controllers);
    try {
      const transport = await this.connections.acquireTransport(link.connectionId, lease.signal, 'bridge');
      if (!sameIdentity(transport.target, descriptor.target)) denied('bridge_identity_mismatch');
      const { credential } = await this.connections.secrets.read<{ credential: string }>({ connectionId: link.grant.id, purpose: 'bridge' });
      if (record.transport?.kind === 'peer_socket') {
        if (this.peerBridges === undefined) throw new AdmissionError(503, 'peer_bridge_offline');
        const reply = await this.peerBridges.forward(record.transport.grantId, operation, credential, body, lease.signal);
        const envelope = reply.envelope as RemoteEnvelope<T>;
        if (reply.status < 200 || reply.status >= 300 || envelope.code !== 0) {
          throw new AdmissionError(reply.status >= 200 && reply.status < 300 ? 409 : reply.status, envelope.msg || 'bridge_request_rejected');
        }
        if (envelope.data === null || typeof envelope.data !== 'object' || !sameIdentity(envelope.data.identity, descriptor.target)) denied('bridge_identity_mismatch');
        return envelope.data.result;
      }
      if (record.purposes.includes('gui') && record.pinnedFingerprint === undefined) {
        const { grant, grantId } = await this.connections.secrets.read<{ grant: string; grantId: string }>({ connectionId: record.credentialRef, purpose: 'gui' });
        await this.connections.provePeer(transport.endpoint, record.target, { grant, grantId }, lease.signal, record.pinnedFingerprint);
      }
      lease.signal.throwIfAborted();
      const response = await peerFetch(new URL(`/api/thread-bridge/${operation}`, transport.endpoint), { method: 'POST', signal: lease.signal,
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, record.pinnedFingerprint);
      const envelope = await readBoundedJsonBody(response, operation === 'read' ? SESSION_READ_BODY_BYTES : operation === 'list' ? 128 * 1024 : 16 * 1024, lease.signal) as RemoteEnvelope<T>;
      if (!response.ok || envelope.code !== 0) throw new AdmissionError(response.ok ? 409 : response.status, envelope.msg ?? 'bridge_request_rejected');
      if (!sameIdentity(envelope.data.identity, descriptor.target)) denied('bridge_identity_mismatch');
      return envelope.data.result;
    } finally { lease.release(); controllers.delete(controller); if (controllers.size === 0) this.outgoing.delete(link.grant.id); }
  }
  private cancelOutgoing(id: string): void { for (const controller of this.outgoing.get(id) ?? []) controller.abort(); this.outgoing.delete(id); }
  attach(id: string, controller: AbortController): () => void {
    const set = this.incoming.get(id) ?? new Set<AbortController>(); set.add(controller); this.incoming.set(id, set);
    if (!this.admission.status().enabled || this.lifetime.signal.aborted) controller.abort();
    return () => { set.delete(controller); if (set.size === 0 && this.incoming.get(id) === set) this.incoming.delete(id); };
  }
  private cancelIncoming(id: string): void { for (const controller of this.incoming.get(id) ?? []) controller.abort(); this.incoming.delete(id); }
  private change<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(async () => { const value = await work(); await writePrivateFile(this.path, JSON.stringify(this.state)); return value; });
    this.tail = result.catch(() => {}); return result;
  }
}

export function isSpaceThreadBridgeDataRequest(request: { method: string; url: string }): boolean { return request.method === 'POST' && DATA_PATHS.has(request.url.split('?', 1)[0]!); }
export async function authorizeSpaceThreadBridgeRequest(bridge: SpaceThreadBridge, token: string, request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  try { if (!isSpaceThreadBridgeDataRequest(request)) denied('local_owner_required'); authenticatedBridgeRequests.set(request, bridge.authorizeCredential(token)); return true; }
  catch (error) { if (!(error instanceof AdmissionError)) throw error; await reply.code(error.status).send(errEnvelope(40101, error.reason, request.id)); return false; }
}

export async function registerSpaceThreadBridge(app: FastifyInstance, core: Scope, admission: ConnectionAdmission, connections: RemoteConnectionManager, transcript: TranscriptService, shutdownSignal?: AbortSignal, peerBridges?: PeerBridgeRegistry): Promise<SpaceThreadBridge> {
  const bridge = new SpaceThreadBridge(core, admission, connections, transcript, peerBridges); await bridge.ready();
  const hook = admission.onDidChange((change) => bridge.onAdmissionChange(change));
  const attachHook = peerBridges?.onDidAttach((grantId) => { void bridge.triggerPeerRetry(grantId).catch(() => {}); });
  app.addHook('preClose', async () => { attachHook?.dispose(); hook.dispose(); await bridge.close(); });
  const respond = async (req: FastifyRequest, reply: FastifyReply, work: () => unknown) => {
    try { return await reply.send(okEnvelope(await work(), req.id)); }
    catch (error) {
      if (error instanceof ContentChangedError) return reply.code(409).send(errEnvelope(40922, error.message, req.id));
      if (error instanceof ThreadMailboxBacklogError) return reply.code(429).send(errEnvelope(42901, 'bridge_queue_or_rate_limit', req.id));
      if (isError2(error)) return reply.code(403).send(errEnvelope(40301, error.message, req.id));
      if (error instanceof Error && error.name === 'ZodError') return reply.code(400).send(errEnvelope(40001, 'invalid_bridge_request', req.id));
      if (!(error instanceof AdmissionError)) throw error;
      return reply.code(error.status).send(errEnvelope(40101, error.reason, req.id));
    }
  };
  app.get('/api/thread-bridges', async (req, reply) => respond(req, reply, () => bridge.status()));
  app.post('/api/thread-bridges/targets', async (req, reply) => respond(req, reply, () => connections.registerBridgeTarget(bridgeTargetInputSchema.parse(req.body))));
  app.post('/api/thread-bridges/local', { bodyLimit: 16384 }, async (req, reply) => respond(req, reply, () => provisionLocalBridge(bridge, localBridgePolicySchema.parse(req.body))));
  app.post('/api/thread-bridges/inbound', { bodyLimit: 16384 }, async (req, reply) => respond(req, reply, () => bridge.approve(bridgePolicySchema.parse(req.body))));
  app.post('/api/thread-bridges/outbound', { bodyLimit: 16384 }, async (req, reply) => respond(req, reply, () => bridge.install(bridgeInstallSchema.parse(req.body))));
  app.post('/api/thread-bridges/peer/outbound', { bodyLimit: 16384 }, async (req, reply) => respond(req, reply, async () => {
    const peer = peerAudience(req);
    if (peer === undefined) denied('peer_grant_required');
    const link = await bridge.installFromPeer(peer.grantId, peerBridgeInstallSchema.parse(req.body));
    void bridge.triggerPeerRetry(peer.grantId).catch(() => {});
    return link;
  }));
  app.post('/api/thread-bridges/peer/outbound/:id/revoke', async (req, reply) => respond(req, reply, async () => {
    const peer = peerAudience(req);
    if (peer === undefined) denied('peer_grant_required');
    const { id } = req.params as { id: string };
    await bridge.revokeFromPeer(peer.grantId, id);
    return { revoked: true };
  }));
  app.get('/api/thread-bridges/receipts', async (req, reply) => respond(req, reply, () => { const query = req.query as { cursor?: string; limit?: string }; return bridge.receipts(query.cursor, Number(query.limit ?? 50)); }));
  app.put('/api/thread-bridges/:direction/:id/enabled', async (req, reply) => respond(req, reply, async () => { const { direction, id } = req.params as { direction: 'inbound' | 'outbound'; id: string }; const enabled = (req.body as { enabled?: unknown })?.enabled;
    if (!['inbound', 'outbound'].includes(direction) || typeof enabled !== 'boolean') throw new AdmissionError(400, 'invalid_bridge_setting'); await bridge.setEnabled(id, enabled, direction); return bridge.status(); }));
  app.post('/api/thread-bridges/:direction/:id/revoke', async (req, reply) => respond(req, reply, async () => { const { direction, id } = req.params as { direction: 'inbound' | 'outbound'; id: string };
    if (!['inbound', 'outbound'].includes(direction)) throw new AdmissionError(400, 'invalid_bridge_direction'); await bridge.revoke(id, direction); return bridge.status(); }));
  app.post('/api/thread-bridges/retry', async (req, reply) => respond(req, reply, async () => { await bridge.retry(); return bridge.receipts(); }));
  for (const operation of ['list', 'read', 'send', 'wait'] as const) app.post(`/api/thread-bridge/${operation}`, { bodyLimit: operation === 'send' ? 1024 * 1024 : 16384 }, async (req, reply) => respond(req, reply, async () => {
    const grant = authenticatedBridgeRequests.get(req);
    if (grant === undefined) throw new AdmissionError(401, 'invalid_bridge_credential');
    const controller = new AbortController(); const stop = () => controller.abort(); req.raw.once('aborted', stop); reply.raw.once('close', stop);
    const detach = bridge.attach(grant.id, controller); const signal = AbortSignal.any([controller.signal, shutdownSignal ?? controller.signal]);
    try {
      const result = operation === 'list' ? await bridge.inboundList(grant, bridgeListSchema.parse(req.body))
        : operation === 'read' ? await bridge.inboundRead(grant, bridgeReadSchema.parse(req.body), signal)
        : operation === 'send' ? await bridge.inboundSend(grant, bridgeSendSchema.parse(req.body))
        : await bridge.inboundWait(grant, bridgeWaitSchema.parse(req.body), signal);
      signal.throwIfAborted(); return { identity: admission.identity, result };
    } finally { detach(); req.raw.off('aborted', stop); reply.raw.off('close', stop); }
  }));
  return bridge;
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted(); return new Promise((resolve, reject) => { const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms); const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); }; signal.addEventListener('abort', abort, { once: true }); });
}
