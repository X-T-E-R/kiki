import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  IBootstrapService, ICapabilitySnapshotService, IConfigService, ISessionIndex, ISessionManager, ISessionActivityView, IThreadCommunicationService, IThreadMailboxStore, IWorkspaceService,
  spaceThreadCapability, SPACE_THREAD_ROUTER, RECHECK_BRIDGED_THREADS, ACCEPT_BRIDGED_THREAD_MESSAGE,
  Error2, ErrorCodes, isError2, ThreadMailboxBacklogError, type ErrorCode, type Scope, type ThreadRef, type AcceptedThreadMessage,
  type SpaceThreadConnector, type SendPeerThreadMessageInput, type SendThreadMessageResult,
  type ListThreadsInput, type ListThreadsResult, type ReadThreadInput, type ReadThreadResult,
  type WaitThreadsInput, type WaitThreadsResult, type CreateBridgedThreadInput, type CreateBridgedThreadResult,
  type BridgePermissionCeilingInput, type PermissionMode, type ThreadCaller, type Workspace,
  constrainPermissionMode,
} from '@kiki/agent-core-v2';
import {
  IRemoteSpaceToolBridgeService, REMOTE_SPACE_TOOL_ROUTER, remoteSpaceToolCapability,
  type CallRemoteSpaceToolInput, type ListRemoteSpaceToolsInput, type RemoteBorrowedSpaceCatalog, type RemoteSpaceToolConnector,
} from '@kiki/agent-core-v2/app/remoteTools/remoteSpaceToolBridge';
import {
  bridgePolicySchema, bridgeGrantSchema, bridgeInstallSchema, bridgeListSchema, bridgeReadSchema, bridgeSendSchema, bridgeWaitSchema, bridgeCreateSchema, type BridgeCreate, peerBridgeInstallSchema,
  PEER_BRIDGE_CAPABILITY_GROUP_IDENTITY_V1,
  bridgeOperationsSchema, bridgeToolsListSchema, bridgeToolsListResultSchema, bridgeToolsCallSchema, bridgeToolsCallResultSchema,
  type BridgeGrant, type BridgePolicy, type BridgeLink, type BridgeSend, type BridgeReceipt, type BridgeOperation, type ConnectionIdentity, type PeerBridgeInstall,
  type BridgeToolsCall, type BridgeToolsCallResult, type BridgeToolsList, type BridgeToolsListResult,
} from '@kiki/protocol';
import { readBoundedJsonBody, SESSION_READ_BODY_BYTES } from '@kiki/klient/transports/http/bounded-body';
import { okEnvelope, errEnvelope } from '../../envelope';
import { AdmissionError, sameIdentity, type ConnectionAdmission } from '../connections/admission';
import { peerAudience, peerGrant } from '../connections/audience';
import type { CredentialValidator } from '../auth/credentials';
import type { RemoteConnectionManager } from '../connections/manager';
import { machineLabel } from '../connections/pairing';
import { evictPinnedAgent, isRetryableTransportError, peerFetch } from '../connections/peerTls';
import { readPrivateFile, writePrivateFile } from '../auth/privateFiles';
import type { TranscriptService } from '../transcript/transcriptService';
import { PEER_BRIDGE_LIST_MAX_RESPONSE_BYTES, type PeerBridgeRegistry } from '../../transport/klient/peerBridgeSocket';
import { readSessionViewTranscriptPage, readSessionViewTranscriptContent } from '../../transport/klient/sessionViewReads';
import { ContentChangedError } from '../../transport/klient/boundedContent';
import { bridgeTargetInputSchema, localBridgePolicySchema } from '@kiki/protocol';
import { THREAD_COMMUNICATION_SECTION } from '@kiki/agent-core-v2/app/threadCommunication/configSection';
import { provisionLocalBridge } from './localProvision';
import { createBridgedThread } from './createThread';
import { callExportedTool, listExportedTools } from './remoteToolsHost';

interface Inbound { grant: BridgeGrant; digest: string; connectionGrantId?: string; peerConnectionId?: string }
interface Outbound extends BridgeLink { connectionGrantId?: string }
interface Outbox { receipt: BridgeReceipt; request?: BridgeSend; fingerprint: string; attempts?: number; nextAttemptAt?: number; finishedAt?: number }
interface InboundCreate { key: string; grantId: string; at: number; fingerprint: string; sessionId: string; result?: CreateBridgedThreadResult }
interface State { inbound: Inbound[]; outbound: Outbound[]; outbox: Outbox[]; nextSeq: number; targets?: ThreadRef[]; inboundKeys?: { key: string; grantId: string; at: number }[]; inboundCreates?: InboundCreate[] }
interface RemoteEnvelope<T> {
  code: number;
  msg: string;
  data: { identity: ConnectionAdmission['identity']; result: T };
  errorCode?: string;
  details?: Record<string, unknown>;
}
function throwBridgeEnvelopeError(status: number, envelope: RemoteEnvelope<unknown>): never {
  if (typeof envelope.errorCode === 'string' && envelope.errorCode.length > 0) {
    throw new Error2(
      envelope.errorCode as ErrorCode,
      envelope.msg || 'bridge_request_rejected',
      envelope.details === undefined ? undefined : { details: envelope.details },
    );
  }
  throw new AdmissionError(status, envelope.msg || 'bridge_request_rejected');
}
const RECEIPT_RETENTION_MS = 7 * 24 * 3600000;
const isPending = (entry: Outbox) => entry.receipt.delivery === 'pending' || entry.receipt.delivery === 'accepted';
const DATA_PATHS = new Set(['/api/thread-bridge/list', '/api/thread-bridge/read', '/api/thread-bridge/send', '/api/thread-bridge/wait', '/api/thread-bridge/create', '/api/thread-bridge/tools_list', '/api/thread-bridge/tools_call']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const plainRef = (ref: ThreadRef): ThreadRef => ({ hostId: ref.hostId, workspaceId: ref.workspaceId, sessionId: ref.sessionId });
const inScope = (scope: BridgeGrant['sourceScope'], ref: ThreadRef) => (scope.workspaceId === '*' || scope.workspaceId === ref.workspaceId) && (scope.sessionId === undefined || scope.sessionId === ref.sessionId);
function denied(reason: string): never { throw new AdmissionError(403, reason); }
const authenticatedBridgeRequests = new WeakMap<FastifyRequest, BridgeGrant>();
const peerRequestBridgeGrants = new WeakMap<FastifyRequest, string>();
const SAME_OPERATIONS = (a: readonly BridgeOperation[], b: readonly BridgeOperation[]): boolean => a.length === b.length && a.every((op, index) => op === b[index]);

export class SpaceThreadBridge implements SpaceThreadConnector, RemoteSpaceToolConnector {
  private state: State = { inbound: [], outbound: [], outbox: [], nextSeq: 1 };
  private readonly path: string;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly flights = new Map<string, Promise<void>>();
  private readonly incoming = new Map<string, Set<AbortController>>();
  private readonly outgoing = new Map<string, Set<AbortController>>();
  private retryFlight?: Promise<void>;
  private readonly lifetime = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private connectionSubscription?: { dispose(): void };
  private remoteToolConnectionSignature = '';
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
  private computeRemoteToolConnectionSignature(): string {
    const relevantIds = new Set(this.state.outbound.filter((entry) => !entry.grant.revoked).map((entry) => entry.connectionId));
    if (relevantIds.size === 0) return '';
    return this.connections.list()
      .filter((record) => relevantIds.has(record.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((record) => `${record.id}:${record.enabled ? 1 : 0}:${record.state}:${record.label}:${record.summary?.value.platform ?? ''}:${record.summary?.value.borrowable_tool_count ?? ''}`)
      .join('|');
  }
  private notifyRemoteTools(): void {
    try {
      remoteSpaceToolCapability(this.core.accessor.get(IRemoteSpaceToolBridgeService)).notifyChanged();
    } catch {}
  }
  private emitChange(): void {
    this.remoteToolConnectionSignature = this.computeRemoteToolConnectionSignature();
    for (const listener of this.changeListeners) listener();
    this.notifyRemoteTools();
  }
  async ready(): Promise<void> {
    try { this.state = JSON.parse((await readPrivateFile(this.path)).toString('utf8')) as State;
      if (!Array.isArray(this.state.inbound) || !Array.isArray(this.state.outbox) || !Array.isArray(this.state.outbound) || !Number.isSafeInteger(this.state.nextSeq)) throw new Error('Invalid bridge store');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.remoteToolConnectionSignature = this.computeRemoteToolConnectionSignature();
    spaceThreadCapability(this.threads)[SPACE_THREAD_ROUTER](this);
    try {
      remoteSpaceToolCapability(this.core.accessor.get(IRemoteSpaceToolBridgeService))[REMOTE_SPACE_TOOL_ROUTER](this);
    } catch {}
    this.connectionSubscription = this.connections.onDidChange(() => {
      const nextSignature = this.computeRemoteToolConnectionSignature();
      if (nextSignature === this.remoteToolConnectionSignature) return;
      this.remoteToolConnectionSignature = nextSignature;
      this.notifyRemoteTools();
    });
    this.timer = setInterval(() => { void this.retry().catch(() => {}); }, 1000); this.timer.unref();
    void this.retry().catch(() => {});
  }
  async close(): Promise<void> {
    this.lifetime.abort(); if (this.timer !== undefined) clearInterval(this.timer);
    this.connectionSubscription?.dispose();
    this.connectionSubscription = undefined;
    for (const controllers of this.incoming.values()) for (const controller of controllers) controller.abort();
    await Promise.allSettled([...this.flights.values(), this.retryFlight]); await this.tail;
    spaceThreadCapability(this.threads)[SPACE_THREAD_ROUTER](undefined);
    try {
      remoteSpaceToolCapability(this.core.accessor.get(IRemoteSpaceToolBridgeService))[REMOTE_SPACE_TOOL_ROUTER](undefined);
    } catch {}
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
    if (!this.admission.status().enabled) return [];
    const allowed: readonly BridgeOperation[] = input.approvedOperations ?? ['read', 'send', 'wait', 'wake', 'create', 'tools'];
    const operations = input.requestedOperations === undefined
      ? [...allowed]
      : allowed.filter((op) => input.requestedOperations!.includes(op));
    if (operations.length === 0) denied('bridge_operation_denied');
    await this.enableThreads();
    const label = input.sourceLabel.trim().slice(0, 128) || 'Kiki';
    const approvedPeer = input.grantId === undefined ? undefined : this.admission.approvedPeer(input.grantId);
    const permissionCeiling =
      approvedPeer?.trustTier === 'trusted_personal'
        ? 'yolo' as const
        : undefined;
    return [await this.approve({ source: input.source, target: this.admission.identity, sourceScope: { workspaceId: '*' }, targetScope: { workspaceId: '*' }, operations, permissionCeiling, expiresAt: Date.now() + 366 * 24 * 3600 * 1000 * 10, pendingLimit: 20, messagesPerMinute: 60, location: 'network', label }, input.grantId)];
  }
  async ensureReversePeerBridge(input: { connectionId: string; target: ConnectionIdentity; label: string; signal: AbortSignal }): Promise<{ grant: BridgeGrant; credential: string } | undefined> {
    if (this.admission.unavailableReason !== undefined) return undefined;
    const forward = this.state.outbound.find((entry) => entry.connectionId === input.connectionId && !entry.grant.revoked && sameIdentity(entry.grant.target, input.target));
    if (forward === undefined) return undefined;
    const localWorkspaceId = forward.grant.sourceScope.workspaceId;
    const remoteWorkspaceId = forward.grant.targetScope.workspaceId;
    const inheritedOperations = [...forward.grant.operations];
    const connectionRecord = this.connections.list().find((entry) => entry.id === input.connectionId);
    const inheritedPermissionCeiling =
      connectionRecord?.localTrusted === true
        ? forward.grant.permissionCeiling
        : forward.grant.permissionCeiling === undefined
          ? undefined
          : constrainPermissionMode(forward.grant.permissionCeiling, 'auto');
    if (!this.admission.status().enabled) await this.admission.setEnabled(true);
    await this.enableThreads();
    if (localWorkspaceId !== '*' && !(await this.threads.isWorkspaceEnabled(localWorkspaceId))) return undefined;
    input.signal.throwIfAborted();
    const existing = this.state.inbound.find((entry) => !entry.grant.revoked && entry.peerConnectionId === input.connectionId);
    if (existing !== undefined) {
      const scopeMatches = existing.grant.sourceScope.workspaceId === remoteWorkspaceId && existing.grant.targetScope.workspaceId === localWorkspaceId;
      const operationsMatch = SAME_OPERATIONS(existing.grant.operations, inheritedOperations);
      const ceilingMatches = existing.grant.permissionCeiling === inheritedPermissionCeiling;
      if (existing.grant.enabled && scopeMatches && operationsMatch && ceilingMatches) {
        const stored = await this.connections.secrets.read<{ credential: string }>({ connectionId: existing.grant.id, purpose: 'bridge' }).catch(() => undefined);
        input.signal.throwIfAborted();
        if (stored !== undefined && typeof stored.credential === 'string' && stored.credential.length >= 32) return { grant: { ...existing.grant }, credential: stored.credential };
      }
      const credential = randomBytes(32).toString('base64url');
      await this.change(async () => {
        input.signal.throwIfAborted();
        existing.grant.revision += 1;
        existing.grant.enabled = true;
        existing.grant.sourceScope = { workspaceId: remoteWorkspaceId };
        existing.grant.targetScope = { workspaceId: localWorkspaceId };
        existing.grant.operations = inheritedOperations;
        existing.grant.permissionCeiling = inheritedPermissionCeiling;
        existing.digest = hash(credential);
        existing.peerConnectionId = input.connectionId;
        await this.connections.secrets.write({ connectionId: existing.grant.id, purpose: 'bridge' }, { credential });
      });
      this.emitChange();
      return { grant: { ...existing.grant }, credential };
    }
    const label = input.label.trim().slice(0, 128) || 'Kiki';
    const credential = randomBytes(32).toString('base64url');
    const grant: BridgeGrant = {
      source: input.target,
      target: this.admission.identity,
      sourceScope: { workspaceId: remoteWorkspaceId },
      targetScope: { workspaceId: localWorkspaceId },
      operations: inheritedOperations,
      permissionCeiling: inheritedPermissionCeiling,
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
    this.emitChange();
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
    if (revokedIds.length > 0) this.emitChange();
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
    this.emitChange();
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
    else if (policy.targetScope.workspaceId !== '*' && !(await this.threads.isWorkspaceEnabled(policy.targetScope.workspaceId))) denied('workspace_disabled');
    const credential = randomBytes(32).toString('base64url');
    const grant: BridgeGrant = { ...policy, id: randomUUID(), revision: 1, enabled: true, revoked: false, createdAt: Date.now() };
    await this.change(() => {
      if (connectionGrantId !== undefined && !this.admission.approvedPeer(connectionGrantId)?.allowBridge) denied('connection_not_approved');
      if (this.state.inbound.length >= 1000) throw new AdmissionError(429, 'bridge_grant_limit');
      this.state.inbound.push({ grant, digest: hash(credential), connectionGrantId });
    });
    this.emitChange();
    return { grant, credential };
  }
  async install(input: ReturnType<typeof bridgeInstallSchema.parse>, connectionGrantId?: string, borrowTools?: boolean): Promise<BridgeLink> {
    const descriptor = this.connections.resolveTransport(input.connectionId);
    const epoch = this.connections.credentialEpoch(input.connectionId);
    if (!sameIdentity(input.grant.source, this.admission.identity) || !sameIdentity(input.grant.target, descriptor.target)) denied('bridge_identity_mismatch');
    const link: Outbound = { connectionId: input.connectionId, grant: input.grant, enabled: true, connectionGrantId };
    await this.change(async () => {
      if (epoch !== this.connections.credentialEpoch(input.connectionId)) denied('connection_not_approved');
      const record = this.connections.get(input.connectionId);
      const outboundCredential = connectionGrantId === undefined || record.transport?.kind === 'peer_socket'
        ? undefined
        : await this.connections.secrets.read<{ grantId: string }>({ connectionId: record.credentialRef, purpose: 'gui' }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
      if (connectionGrantId !== undefined) {
        if (outboundCredential !== undefined) {
          if (outboundCredential.grantId !== connectionGrantId) denied('connection_not_approved');
        } else if (record.purposes.includes('gui') || !this.admission.approvedPeer(connectionGrantId)?.allowBridge) {
          denied('connection_not_approved');
        }
      }
      const previous = this.state.outbound.find((entry) => entry.grant.id === input.grant.id);
      const effectiveBorrowTools = borrowTools ?? previous?.borrowTools;
      if (effectiveBorrowTools !== undefined) link.borrowTools = effectiveBorrowTools;
      const idempotentPeerInstall = previous !== undefined && !previous.grant.revoked && connectionGrantId !== undefined && previous.connectionGrantId === connectionGrantId && input.grant.revision === previous.grant.revision;
      if (previous !== undefined && (previous.grant.revoked || (!idempotentPeerInstall && input.grant.revision <= previous.grant.revision))) throw new AdmissionError(409, 'bridge_revision_not_newer');
      if (input.grant.revoked || !input.grant.enabled || input.grant.expiresAt <= Date.now()) denied('bridge_operation_denied');
      await this.connections.secrets.write({ connectionId: input.grant.id, purpose: 'bridge' }, { credential: input.credential });
      if (epoch !== this.connections.credentialEpoch(input.connectionId)) denied('connection_not_approved');
      if (connectionGrantId !== undefined && outboundCredential === undefined && !this.admission.approvedPeer(connectionGrantId)?.allowBridge) denied('connection_not_approved');
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
  async setOperations(id: string, operations: readonly BridgeOperation[]): Promise<void> {
    const next = [...new Set(operations)];
    if (next.length === 0) throw new AdmissionError(400, 'invalid_bridge_setting');
    let parentConnectionGrantId: string | undefined;
    await this.change(() => {
      const entry = this.state.inbound.find((g) => g.grant.id === id);
      if (entry === undefined) throw new AdmissionError(404, 'bridge_not_found');
      if (entry.grant.revoked) denied('bridge_revoked');
      entry.grant.operations = next;
      parentConnectionGrantId = entry.connectionGrantId;
    });
    if (parentConnectionGrantId !== undefined) {
      await this.admission.setBridgeOperations(parentConnectionGrantId, next);
    }
    this.emitChange();
  }
  async setBorrowTools(id: string, borrowTools: boolean): Promise<void> {
    await this.change(() => {
      const entry = this.link(id) as Outbound;
      if (entry.grant.revoked) denied('bridge_revoked');
      entry.borrowTools = borrowTools;
    });
    this.emitChange();
  }
  async requestBridgeFromPeer(peerGrantId: string, input: { sourceLabel?: string; operations?: readonly BridgeOperation[]; sourceWorkspaces?: readonly string[]; existingBridgeId?: string }): Promise<{ updatedGrant?: BridgeGrant; bridge?: { grant: BridgeGrant; credential: string }[] }> {
    const peer = this.admission.approvedPeer(peerGrantId);
    if (peer === undefined) denied('connection_not_approved');
    if (!peer.allowBridge) denied('bridge_operation_denied');
    if (input.existingBridgeId !== undefined) {
      const existing = this.state.inbound.find((entry) => entry.grant.id === input.existingBridgeId && entry.connectionGrantId === peer.id && !entry.grant.revoked);
      if (existing !== undefined) {
        const cap = peer.bridgeOperations !== undefined
          ? existing.grant.operations.filter((op) => peer.bridgeOperations!.includes(op))
          : existing.grant.operations;
        if (input.operations !== undefined) {
          const next = [...new Set(input.operations)];
          if (next.length === 0) throw new AdmissionError(400, 'invalid_bridge_setting');
          if (next.some((op) => !cap.includes(op))) denied('bridge_operation_denied');
          await this.change(() => { existing.grant.operations = next; });
          this.emitChange();
        } else if (cap.length !== existing.grant.operations.length) {
          if (cap.length === 0) denied('bridge_operation_denied');
          await this.change(() => { existing.grant.operations = [...cap]; });
          this.emitChange();
        }
        return { updatedGrant: { ...existing.grant } };
      }
    }
    const activeInbound = this.state.inbound.filter((entry) => entry.connectionGrantId === peer.id && !entry.grant.revoked);
    if (activeInbound.length === 0 && this.state.inbound.some((entry) => entry.connectionGrantId === peer.id && entry.grant.revoked)) {
      denied('bridge_operation_denied');
    }
    let approvedCeiling: BridgeOperation[];
    if (activeInbound.length > 0) {
      const activeOps = [...new Set(activeInbound.flatMap((entry) => entry.grant.operations))];
      approvedCeiling = peer.bridgeOperations === undefined
        ? activeOps
        : activeOps.filter((op) => peer.bridgeOperations!.includes(op));
    } else {
      approvedCeiling = peer.bridgeOperations !== undefined
        ? [...peer.bridgeOperations]
        : ['read', 'send', 'wait'];
    }
    if (approvedCeiling.length === 0) denied('bridge_operation_denied');
    if (input.operations !== undefined) {
      const next = [...new Set(input.operations)];
      if (next.length === 0) throw new AdmissionError(400, 'invalid_bridge_setting');
      if (next.some((op) => !approvedCeiling.includes(op))) denied('bridge_operation_denied');
    }
    const staleIds = activeInbound.map((entry) => entry.grant.id);
    if (staleIds.length > 0) {
      await this.change(() => {
        for (const entry of this.state.inbound) {
          if (!staleIds.includes(entry.grant.id)) continue;
          entry.grant.revoked = true;
          entry.grant.enabled = false;
          entry.grant.revision += 1;
          this.cancelIncoming(entry.grant.id);
        }
      });
      this.emitChange();
    }
    const bridge = await this.issuePairingBridges({
      grantId: peer.id,
      source: peer.source,
      sourceLabel: input.sourceLabel ?? 'Kiki',
      sourceWorkspaces: input.sourceWorkspaces ?? [],
      approvedOperations: approvedCeiling,
      requestedOperations: input.operations,
    });
    return { bridge };
  }
  async syncConnection(connectionId: string, input: { operations?: readonly BridgeOperation[]; borrowTools?: boolean } = {}): Promise<ReturnType<SpaceThreadBridge['status']>> {
    const record = this.connections.get(connectionId);
    if (!record.enabled) throw new AdmissionError(403, 'connection_disabled');
    const existingLink = this.state.outbound.find((entry) => entry.connectionId === connectionId && !entry.grant.revoked && entry.enabled);
    const lease = this.connections.lease(connectionId, AbortSignal.timeout(15000));
    try {
      const { transport, credential } = await this.connections.connect(connectionId, lease.signal);
      const response = await peerFetch(
        `${transport.endpoint}/api/thread-bridges/peer/request-bridge`,
        {
          method: 'POST',
          signal: lease.signal,
          headers: {
            authorization: `Bearer ${credential.ownerToken}`,
            'x-kiki-connection-grant': credential.grant,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            sourceLabel: machineLabel(),
            operations: input.operations,
            existingBridgeId: existingLink?.grant.id,
          }),
        },
        record.pinnedFingerprint,
      );
      const envelope = await readBoundedJsonBody(response, 65536, lease.signal) as { code?: number; msg?: string; data?: { updatedGrant?: BridgeGrant; bridge?: { grant: BridgeGrant; credential: string }[] } };
      if (!response.ok || envelope.code !== 0 || envelope.data === undefined) {
        throw new AdmissionError(response.ok ? 409 : response.status, typeof envelope.msg === 'string' ? envelope.msg : 'bridge_sync_failed');
      }
      if (envelope.data.updatedGrant !== undefined && existingLink !== undefined) {
        const updatedGrant = bridgeGrantSchema.parse(envelope.data.updatedGrant);
        if (
          updatedGrant.id !== existingLink.grant.id
          || updatedGrant.revoked
          || !updatedGrant.enabled
          || updatedGrant.expiresAt <= Date.now()
          || updatedGrant.revision < existingLink.grant.revision
          || !sameIdentity(updatedGrant.source, this.admission.identity)
          || !sameIdentity(updatedGrant.target, existingLink.grant.target)
          || updatedGrant.sourceScope.workspaceId !== existingLink.grant.sourceScope.workspaceId
          || updatedGrant.sourceScope.sessionId !== existingLink.grant.sourceScope.sessionId
          || updatedGrant.targetScope.workspaceId !== existingLink.grant.targetScope.workspaceId
          || updatedGrant.targetScope.sessionId !== existingLink.grant.targetScope.sessionId
          || (input.operations !== undefined && updatedGrant.operations.some((op) => !input.operations!.includes(op)))
        ) {
          denied('bridge_identity_mismatch');
        }
        await this.change(() => {
          existingLink.grant = updatedGrant;
          if (input.borrowTools !== undefined) existingLink.borrowTools = input.borrowTools;
        });
        this.emitChange();
        void this.retry().catch(() => {});
      } else if (envelope.data.bridge !== undefined && envelope.data.bridge.length > 0) {
        await this.enableThreads();
        await this.connections.ensureBridgePurpose(connectionId);
        const replacementIds = new Set(envelope.data.bridge.map((bundle) => bundle.grant.id));
        const previousIds = this.state.outbound
          .filter((entry) => entry.connectionId === connectionId && !entry.grant.revoked && !replacementIds.has(entry.grant.id))
          .map((entry) => entry.grant.id);
        for (const id of previousIds) await this.revoke(id, 'outbound');
        for (const bundle of envelope.data.bridge) {
          await this.install({ connectionId, grant: bundle.grant, credential: bundle.credential }, credential.grantId, input.borrowTools);
        }
      } else if (existingLink !== undefined && input.borrowTools !== undefined) {
        await this.setBorrowTools(existingLink.grant.id, input.borrowTools);
      }
      return this.status();
    } finally {
      lease.release();
    }
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
  private effectiveInboundCeiling(grant: BridgeGrant): PermissionMode {
    const declared = grant.permissionCeiling ?? 'auto';
    const parentId = this.state.inbound.find((entry) => entry.grant.id === grant.id)?.connectionGrantId;
    if (parentId === undefined) return declared;
    const peer = this.admission.approvedPeer(parentId);
    if (peer?.trustTier === 'trusted_personal') {
      return declared;
    }
    return constrainPermissionMode(declared, 'auto');
  }
  async inboundCreate(grant: BridgeGrant, input: BridgeCreate): Promise<CreateBridgedThreadResult> {
    this.checkInbound(grant, input, 'create');
    if (input.notifyOnTerminal === true) {
      this.checkInbound(grant, input, 'wait');
    }
    if (grant.targetScope.sessionId !== undefined || (grant.targetScope.workspaceId !== '*' && input.workspaceId !== undefined && input.workspaceId !== grant.targetScope.workspaceId)) denied('bridge_target_scope');
    const ceiling = this.effectiveInboundCeiling(grant);
    if (input.permissionMode !== undefined && constrainPermissionMode(input.permissionMode, ceiling) !== input.permissionMode) denied('bridge_permission_ceiling');
    if (input.prompt !== undefined && input.prompt.trim() === '') throw new AdmissionError(400, 'invalid_bridge_request');
    if (input.groupOrigin !== undefined) {
      if (
        input.groupOrigin.hostId !== grant.source.hostId ||
        input.groupOrigin.homeId !== grant.source.homeId ||
        (input.groupOrigin.bridgeId !== undefined && input.groupOrigin.bridgeId !== grant.id)
      ) {
        denied('bridge_identity_mismatch');
      }
    }
    const boundGroupOrigin =
      input.groupOrigin !== undefined || input.groupId !== undefined
        ? { homeId: grant.source.homeId, hostId: grant.source.hostId, bridgeId: grant.id }
        : undefined;
    const boundInput: BridgeCreate =
      boundGroupOrigin === undefined ? input : { ...input, groupOrigin: boundGroupOrigin };
    const targetWorkspaceId = grant.targetScope.workspaceId === '*' ? input.workspaceId : grant.targetScope.workspaceId;
    const key = hash(JSON.stringify(['create', grant.id, input.source, input.idempotencyKey]));
    const fingerprint = hash(JSON.stringify({ workspaceId: targetWorkspaceId ?? '*', title: input.title, profile: input.profile,
      persona: input.persona, modelAlias: input.modelAlias, effort: input.effort, permissionMode: input.permissionMode, planMode: input.planMode, prompt: input.prompt, notifyOnTerminal: input.notifyOnTerminal === true ? true : undefined,
      groupId: boundInput.groupId, groupOrigin: boundInput.groupOrigin }));
    return this.change(async () => {
      this.checkInbound(grant, input, 'create');
      const now = Date.now();
      this.pruneInboundReceipts(now);
      const creates = this.state.inboundCreates ??= [];
      const previous = creates.find((entry) => entry.key === key);
      if (previous !== undefined && previous.fingerprint !== fingerprint) throw new AdmissionError(409, 'bridge_idempotency_conflict');
      if (previous?.result !== undefined) return previous.result;
      const workspaceService = this.core.accessor.get(IWorkspaceService);
      let workspace: Workspace | undefined;
      if (targetWorkspaceId !== undefined) {
        if (!(await this.threads.isWorkspaceEnabled(targetWorkspaceId))) denied('workspace_disabled');
        workspace = await workspaceService.get(targetWorkspaceId);
        if (workspace === undefined) throw new AdmissionError(404, 'workspace_not_found');
      } else {
        const candidates = [...await workspaceService.list()].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
        for (const candidate of candidates) {
          if (await this.threads.isWorkspaceEnabled(candidate.id)) {
            workspace = candidate;
            break;
          }
        }
        if (workspace === undefined) {
          await this.enableThreads();
          const defaultRoot = join(this.core.accessor.get(IBootstrapService).homeDir, 'workspaces', 'default');
          await mkdir(defaultRoot, { recursive: true });
          workspace = await workspaceService.createOrTouch(defaultRoot, 'Default');
          if (!(await this.threads.isWorkspaceEnabled(workspace.id))) denied('workspace_disabled');
        }
      }
      const entry: InboundCreate = previous ?? { key, grantId: grant.id, at: now, fingerprint, sessionId: randomUUID() };
      if (previous === undefined) {
        this.requireInboundRate(grant, now);
        creates.push(entry);
      }
      await writePrivateFile(this.path, JSON.stringify(this.state));
      this.checkInbound(grant, input, 'create');
      if (input.notifyOnTerminal === true) {
        this.checkInbound(grant, input, 'wait');
      }
      const liveCeiling = this.effectiveInboundCeiling(grant);
      if (input.permissionMode !== undefined && constrainPermissionMode(input.permissionMode, liveCeiling) !== input.permissionMode) {
        denied('bridge_permission_ceiling');
      }
      try {
        const result = await createBridgedThread(this.core, workspace, this.admission.identity.hostId, boundInput, entry.sessionId, key, liveCeiling);
        entry.result = result;
        return result;
      } catch (error) {
        if ((await this.sessions.get(entry.sessionId)) === undefined) {
          const idx = creates.indexOf(entry);
          if (idx >= 0) creates.splice(idx, 1);
          await writePrivateFile(this.path, JSON.stringify(this.state));
        }
        throw error;
      }
    });
  }
  private pruneInboundReceipts(now: number): void {
    this.state.inboundKeys = (this.state.inboundKeys ?? []).filter((entry) => entry.at > now - RECEIPT_RETENTION_MS);
    this.state.inboundCreates = (this.state.inboundCreates ?? []).filter((entry) => entry.at > now - RECEIPT_RETENTION_MS);
  }
  private requireInboundRate(grant: BridgeGrant, now: number): void {
    const recent = (entry: { grantId: string; at: number }) => entry.grantId === grant.id && entry.at > now - 60000;
    if ((this.state.inboundKeys ?? []).filter(recent).length + (this.state.inboundCreates ?? []).filter(recent).length >= grant.messagesPerMinute) throw new AdmissionError(429, 'bridge_rate_limit');
  }
  async inboundList(grant: BridgeGrant, input: ReturnType<typeof bridgeListSchema.parse>): Promise<ListThreadsResult> {
    this.checkInbound(grant, input, 'read');
    if (grant.targetScope.workspaceId !== '*' && input.workspaceId !== undefined && input.workspaceId !== grant.targetScope.workspaceId) denied('bridge_target_scope');
    const targetWorkspaceId = grant.targetScope.workspaceId === '*' ? input.workspaceId : grant.targetScope.workspaceId;
    if (targetWorkspaceId !== undefined && !(await this.threads.isWorkspaceEnabled(targetWorkspaceId))) denied('workspace_disabled');
    if (grant.targetScope.sessionId !== undefined) {
      const resolvedWorkspaceId = targetWorkspaceId ?? grant.targetScope.workspaceId;
      const ref = { hostId: grant.target.hostId, workspaceId: resolvedWorkspaceId, sessionId: grant.targetScope.sessionId };
      await this.requireTarget(ref); const summary = await this.sessions.get(ref.sessionId);
      const sameSession = sameIdentity(grant.source, grant.target) &&
        grant.sourceScope.workspaceId === resolvedWorkspaceId &&
        grant.sourceScope.sessionId !== undefined && grant.sourceScope.sessionId === grant.targetScope.sessionId;
      if (summary === undefined || summary.private === true && !sameSession) return { threads: [] };
      const live = this.core.accessor.get(ISessionManager).get(ref.sessionId);
      const state = live === undefined ? 'cold' : live.accessor.get(ISessionActivityView).state().busy ? 'running' : 'idle';
      return { threads: [{ ref, title: summary.title, createdAt: summary.createdAt, updatedAt: summary.updatedAt, state }] };
    }
    return this.threads.listThreads({ workspaceId: targetWorkspaceId, cursor: input.cursor, limit: input.limit });
  }
  async inboundToolsList(grant: BridgeGrant, input: BridgeToolsList, signal?: AbortSignal): Promise<BridgeToolsListResult> {
    this.checkInbound(grant, input, 'tools');
    if (grant.targetScope.workspaceId !== '*' && input.workspaceId !== undefined && input.workspaceId !== grant.targetScope.workspaceId) denied('bridge_target_scope');
    const effectiveWorkspaceId = grant.targetScope.workspaceId === '*' ? input.workspaceId : grant.targetScope.workspaceId;
    return listExportedTools(this.core, effectiveWorkspaceId, { signal });
  }
  async inboundToolsCall(grant: BridgeGrant, input: BridgeToolsCall, signal: AbortSignal): Promise<BridgeToolsCallResult> {
    this.checkInbound(grant, input, 'tools');
    if (grant.targetScope.workspaceId !== '*' && input.workspaceId !== undefined && input.workspaceId !== grant.targetScope.workspaceId) denied('bridge_target_scope');
    return callExportedTool(this.core, input, grant.targetScope.workspaceId, signal);
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
  async inboundSend(grant: BridgeGrant, input: BridgeSend, signal?: AbortSignal): Promise<SendThreadMessageResult> {
    signal?.throwIfAborted();
    this.checkInbound(grant, input, 'send', input.target); await this.requireTarget(input.target);
    signal?.throwIfAborted();
    const producer = { kind: 'bridged_peer' as const, source: input.source, bridgeId: grant.id, revision: input.revision,
      sourceHomeId: input.sourceHomeId, targetHomeId: input.targetHomeId, location: grant.location,
      createdAt: input.createdAt, expiresAt: input.expiresAt, sourceSeq: input.sourceSeq, causeId: input.causeId, hop: input.hop };
    await this.beforeDelivery({ producer, target: input.target, content: input.content, idempotencyKey: input.idempotencyKey, messageId: '', acceptedAt: Date.now(), targetSeq: 0 });
    const key = hash(JSON.stringify([grant.id, input.source, input.target, input.idempotencyKey]));
    const record = await this.serialize(async () => {
      signal?.throwIfAborted();
      this.checkInbound(grant, input, 'send', input.target);
      const now = Date.now();
      const prevKeys = this.state.inboundKeys ?? [];
      const prevCreates = this.state.inboundCreates ?? [];
      const nextKeys = prevKeys.filter((entry) => entry.at > now - RECEIPT_RETENTION_MS);
      const nextCreates = prevCreates.filter((entry) => entry.at > now - RECEIPT_RETENTION_MS);
      let dirty = nextKeys.length !== prevKeys.length || nextCreates.length !== prevCreates.length;
      const duplicate = nextKeys.some((entry) => entry.key === key);
      if (!duplicate) {
        const recent = (entry: { grantId: string; at: number }) => entry.grantId === grant.id && entry.at > now - 60000;
        if (nextKeys.filter(recent).length + nextCreates.filter(recent).length >= grant.messagesPerMinute) throw new AdmissionError(429, 'bridge_rate_limit');
      }
      const prevTargets = this.state.targets ?? [];
      const hasTarget = prevTargets.some((target) => target.hostId === input.target.hostId && target.workspaceId === input.target.workspaceId && target.sessionId === input.target.sessionId);
      if (!hasTarget && prevTargets.length >= 100) throw new AdmissionError(429, 'bridge_target_queue_full');
      const finalKeys = duplicate ? nextKeys : [...nextKeys, { key, grantId: grant.id, at: now }];
      const finalTargets = hasTarget ? prevTargets : [...prevTargets, input.target];
      if (!duplicate || !hasTarget) dirty = true;
      if (dirty) {
        const nextState: State = { ...this.state, inboundKeys: finalKeys, inboundCreates: nextCreates, targets: finalTargets };
        await writePrivateFile(this.path, JSON.stringify(nextState));
        this.state.inboundKeys = finalKeys;
        this.state.inboundCreates = nextCreates;
        this.state.targets = finalTargets;
      }
      signal?.throwIfAborted();
      return this.mailbox.acceptMessage({ producer, target: input.target, content: input.content, idempotencyKey: input.idempotencyKey,
        pendingLimit: grant.pendingLimit, rateLimit: { key: grant.id, count: grant.messagesPerMinute, windowMs: 60000 } });
    });
    if (record.payloadConflict) throw new AdmissionError(409, 'bridge_idempotency_conflict');
    if (record.delivery !== 'pending') {
      return {
        messageId: record.message.messageId,
        targetSeq: record.message.targetSeq,
        acceptedAt: record.message.acceptedAt,
        deduplicated: record.deduplicated,
        delivery: record.delivery,
      };
    }
    const isTargetLive = this.core.accessor.get(ISessionManager).get(input.target.sessionId) !== undefined;
    return spaceThreadCapability(this.threads)[ACCEPT_BRIDGED_THREAD_MESSAGE]({
      producer,
      target: input.target,
      content: input.content,
      idempotencyKey: input.idempotencyKey,
      signal,
      ...(isTargetLive ? {} : { deliveryTimeoutMs: 0 }),
    });
  }
  async inboundWait(grant: BridgeGrant, input: ReturnType<typeof bridgeWaitSchema.parse>, signal: AbortSignal): Promise<WaitThreadsResult> {
    this.checkInbound(grant, input, 'wait', input.target); await this.requireTarget(input.target);
    let threads = [{ thread: input.target, cursor: input.cursor }]; const deadline = Date.now() + (input.timeoutMs ?? 30000);
    for (;;) {
      signal.throwIfAborted(); this.checkInbound(grant, input, 'wait', input.target); await this.requireTarget(input.target);
      const sliceMs = Math.min(2000, Math.max(0, deadline - Date.now()));
      const result = await this.threads.waitThreads({ threads, timeoutMs: sliceMs, signal });
      if (!result.timedOut || Date.now() >= deadline) return result;
      threads = result.threads.map((entry) => ({ thread: entry.thread, cursor: entry.cursor }));
    }
  }
  private link(id: string): BridgeLink { const link = this.state.outbound.find((entry) => entry.grant.id === id); if (link === undefined) throw new AdmissionError(404, 'bridge_not_found'); return link; }
  private verifyLinkIdentity(link: BridgeLink): BridgeLink {
    const descriptor = this.connections.resolveTransport(link.connectionId);
    if (!sameIdentity(link.grant.source, this.admission.identity) || !sameIdentity(link.grant.target, descriptor.target)) denied('bridge_identity_mismatch');
    return link;
  }
  private rankCandidates(candidates: readonly BridgeLink[], source?: { workspaceId: string; sessionId: string }, target?: ThreadRef): BridgeLink[] {
    const specificity = (entry: BridgeLink): number => {
      let score = 0;
      if (target !== undefined && entry.grant.targetScope.sessionId === target.sessionId) score += 8;
      if (source !== undefined && entry.grant.sourceScope.sessionId === source.sessionId) score += 4;
      if (entry.grant.targetScope.workspaceId !== '*') score += 2;
      if (entry.grant.sourceScope.workspaceId !== '*') score += 1;
      return score;
    };
    return [...candidates].sort((a, b) => {
      const specDiff = specificity(b) - specificity(a);
      if (specDiff !== 0) return specDiff;
      const opDiff = b.grant.operations.length - a.grant.operations.length;
      if (opDiff !== 0) return opDiff;
      const revDiff = b.grant.revision - a.grant.revision;
      if (revDiff !== 0) return revDiff;
      return b.grant.createdAt - a.grant.createdAt;
    });
  }
  private matchPermittedCandidates(ref: { bridgeId?: string; connectionId?: string; workspaceId?: string }, source?: { workspaceId: string; sessionId: string }, target?: ThreadRef, operation: BridgeOperation = 'read'): BridgeLink[] {
    const now = Date.now();
    const links = this.state.outbound.filter((entry) => (ref.bridgeId === undefined ? !entry.grant.revoked : entry.grant.id === ref.bridgeId) && (ref.connectionId === undefined || entry.connectionId === ref.connectionId) &&
      source !== undefined && inScope(entry.grant.sourceScope, { ...source, hostId: this.admission.identity.hostId }) &&
      (operation !== 'create' || (entry.grant.targetScope.sessionId === undefined && (entry.grant.targetScope.workspaceId === '*' || ref.workspaceId === undefined || ref.workspaceId === entry.grant.targetScope.workspaceId))) &&
      (target === undefined || target.hostId === entry.grant.target.hostId && inScope(entry.grant.targetScope, target)));
    if (links.length === 0) denied('bridge_not_authorized');
    const permitted = (entry: BridgeLink) => entry.enabled && !entry.grant.revoked && entry.grant.enabled && entry.grant.expiresAt > now && entry.grant.operations.includes(operation);
    const active = links.filter(permitted);
    if (active.length === 0) denied('bridge_operation_denied');
    if (active.length === 1) return [this.verifyLinkIdentity(active[0]!)];
    const ranked = this.rankCandidates(active, source, target);
    const byTargetScope = new Map<string, BridgeLink>();
    for (const candidate of ranked) {
      const scopeKey = `${candidate.grant.target.homeId}|${candidate.grant.target.hostId}|${candidate.grant.targetScope.workspaceId}|${candidate.grant.targetScope.sessionId ?? '*'}`;
      if (!byTargetScope.has(scopeKey)) byTargetScope.set(scopeKey, candidate);
    }
    return [...byTargetScope.values()];
  }
  private choose(ref: { bridgeId?: string; connectionId?: string; workspaceId?: string }, source?: { workspaceId: string; sessionId: string }, target?: ThreadRef, operation: BridgeOperation = 'read'): BridgeLink {
    const deduped = this.matchPermittedCandidates(ref, source, target, operation);
    if (deduped.length === 1) return this.verifyLinkIdentity(deduped[0]!);
    const first = deduped[0]!;
    const sameTargetPeer = deduped.every((entry) => sameIdentity(entry.grant.target, first.grant.target));
    if (sameTargetPeer && (target !== undefined || ref.connectionId !== undefined || (ref.workspaceId !== undefined && first.grant.targetScope.workspaceId === ref.workspaceId) || deduped.slice(1).every((entry) => entry.grant.targetScope.workspaceId === '*'))) {
      return this.verifyLinkIdentity(first);
    }
    denied('bridge_ambiguous');
  }
  async listBorrowedTools(input: ListRemoteSpaceToolsInput): Promise<readonly RemoteBorrowedSpaceCatalog[]> {
    const now = Date.now();
    const eligible = this.state.outbound.filter((entry) => {
      if (!entry.enabled || entry.grant.revoked || !entry.grant.enabled || entry.grant.expiresAt <= now) return false;
      if (!entry.grant.operations.includes('tools') || entry.borrowTools === false) return false;
      if (!inScope(entry.grant.sourceScope, { hostId: this.admission.identity.hostId, ...input.caller })) return false;
      try {
        const record = this.connections.get(entry.connectionId);
        return record.enabled && !['disabled', 'authentication_required', 'identity_changed'].includes(record.state);
      } catch {
        return false;
      }
    });
    if (eligible.length === 0) return [];
    const ranked = this.rankCandidates(eligible, input.caller);
    const byScope = new Map<string, BridgeLink>();
    for (const candidate of ranked) {
      const scopeKey = `${candidate.connectionId}|${candidate.grant.target.homeId}|${candidate.grant.target.hostId}|${candidate.grant.targetScope.workspaceId}`;
      if (!byScope.has(scopeKey)) byScope.set(scopeKey, candidate);
    }
    const catalogs = await Promise.all([...byScope.values()].map(async (link): Promise<RemoteBorrowedSpaceCatalog | undefined> => {
      try {
        const verified = this.verifyLinkIdentity(link);
        const record = this.connections.get(verified.connectionId);
        const raw = await this.remote<BridgeToolsListResult>(verified, 'tools_list', {
          bridgeId: verified.grant.id,
          revision: verified.grant.revision,
          source: this.source(input.caller),
          workspaceId: verified.grant.targetScope.workspaceId === '*' ? undefined : verified.grant.targetScope.workspaceId,
        }, input.signal);
        const parsed = bridgeToolsListResultSchema.parse(raw);
        return {
          bridgeId: verified.grant.id,
          connectionId: verified.connectionId,
          spaceLabel: parsed.spaceLabel || record.label,
          platform: parsed.platform,
          tools: parsed.tools,
        };
      } catch (error) {
        if (input.signal?.aborted) throw error;
        return undefined;
      }
    }));
    return catalogs.filter((catalog): catalog is RemoteBorrowedSpaceCatalog => catalog !== undefined);
  }
  async callBorrowedTool(input: CallRemoteSpaceToolInput): Promise<BridgeToolsCallResult> {
    const link = this.choose({ bridgeId: input.bridgeId, connectionId: input.connectionId }, input.caller, undefined, 'tools') as Outbound;
    if (link.borrowTools === false) denied('bridge_operation_denied');
    const raw = await this.remote<BridgeToolsCallResult>(link, 'tools_call', {
      bridgeId: link.grant.id,
      revision: link.grant.revision,
      source: this.source(input.caller),
      workspaceId: link.grant.targetScope.workspaceId === '*' ? undefined : link.grant.targetScope.workspaceId,
      remoteName: input.remoteName,
      arguments: input.arguments,
      callId: input.callId,
    }, input.signal);
    return bridgeToolsCallResultSchema.parse(raw);
  }
  permissionCeiling(input: BridgePermissionCeilingInput): PermissionMode | undefined {
    try {
      const link = this.choose(input, input.caller, undefined, 'create');
      return link.grant.permissionCeiling ?? 'auto';
    } catch {
      return undefined;
    }
  }
  assertCanWatch(input: {
    readonly caller: ThreadCaller;
    readonly bridgeId?: string;
    readonly connectionId?: string;
    readonly workspaceId?: string;
    readonly target?: ThreadRef;
  }): void {
    if (input.target !== undefined) {
      this.choose(input.target, input.caller, input.target, 'wait');
      return;
    }
    const link = this.choose(input, input.caller, undefined, 'create');
    if (!link.grant.operations.includes('wait')) denied('bridge_operation_denied');
  }
  private source(source: { workspaceId: string; sessionId: string } | undefined): ThreadRef { if (source === undefined) denied('bridge_source_required'); return plainRef({ hostId: this.admission.identity.hostId, ...source }); }
  async create(input: CreateBridgedThreadInput): Promise<CreateBridgedThreadResult> {
    const link = this.choose(input, input.caller, undefined, 'create');
    const ceiling = link.grant.permissionCeiling ?? 'auto';
    if (input.permissionMode !== undefined && constrainPermissionMode(input.permissionMode, ceiling) !== input.permissionMode) {
      denied('bridge_permission_ceiling');
    }
    if (input.notifyOnTerminal === true && !link.grant.operations.includes('wait')) {
      denied('bridge_operation_denied');
    }
    const result = await this.remote<CreateBridgedThreadResult>(link, 'create', {
      bridgeId: link.grant.id, revision: link.grant.revision, source: this.source(input.caller),
      workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey,
      title: input.title, profile: input.profile, persona: input.persona, modelAlias: input.modelAlias,
      effort: input.effort, permissionMode: input.permissionMode, planMode: input.planMode, prompt: input.prompt,
      ...(input.notifyOnTerminal === true ? { notifyOnTerminal: true } : {}),
    }, input.signal);
    return { ...result, ref: { ...result.ref, bridgeId: link.grant.id, connectionId: link.connectionId } };
  }
  async list(input: ListThreadsInput): Promise<ListThreadsResult> {
    const candidates = this.matchPermittedCandidates(input, input.caller, undefined, 'read');
    if (candidates.length > 1) {
      const first = candidates[0]!;
      const canMerge = input.bridgeId === undefined && input.cursor === undefined
        && candidates.every((entry) => sameIdentity(entry.grant.target, first.grant.target));
      if (!canMerge) denied('bridge_ambiguous');
      const verified = candidates.map((entry) => this.verifyLinkIdentity(entry));
      const pages = await Promise.all(verified.map(async (link) => {
        const result = await this.remote<ListThreadsResult>(link, 'list', {
          bridgeId: link.grant.id,
          revision: link.grant.revision,
          source: this.source(input.caller),
          workspaceId: input.workspaceId,
          limit: input.limit,
        }, input.signal);
        return result.threads.map((entry) => ({ ...entry, ref: { ...entry.ref, bridgeId: link.grant.id, connectionId: link.connectionId } }));
      }));
      const merged = new Map<string, ListThreadsResult['threads'][number]>();
      for (const page of pages) {
        for (const entry of page) {
          const threadKey = `${entry.ref.hostId}|${entry.ref.workspaceId}|${entry.ref.sessionId}`;
          if (!merged.has(threadKey)) merged.set(threadKey, entry);
        }
      }
      const limit = input.limit ?? 50;
      return { threads: [...merged.values()].slice(0, limit) };
    }
    const link = this.verifyLinkIdentity(candidates[0]!);
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
    await this.serialize(async () => {
      input.signal?.throwIfAborted();
      const now = Date.now();
      const prunedOutbox = this.state.outbox.filter((entry) => isPending(entry) || (entry.finishedAt ?? entry.receipt.createdAt) > now - RECEIPT_RETENTION_MS);
      const pruned = prunedOutbox.length !== this.state.outbox.length;
      existing = prunedOutbox.find((entry) => entry.receipt.id === id);
      if (existing !== undefined) {
        duplicate = true;
        if (existing.fingerprint !== fingerprint) throw new AdmissionError(409, 'bridge_idempotency_conflict');
        if (pruned) {
          await writePrivateFile(this.path, JSON.stringify({ ...this.state, outbox: prunedOutbox }));
          this.state.outbox = prunedOutbox;
        }
        return;
      }
      const pending = prunedOutbox.filter(isPending);
      if (pending.length >= 100 || pending.filter((entry) => entry.receipt.bridgeId === link.grant.id).length >= link.grant.pendingLimit) throw new AdmissionError(429, 'bridge_queue_full');
      if (prunedOutbox.filter((entry) => entry.receipt.bridgeId === link.grant.id && entry.receipt.createdAt > now - 60000).length >= link.grant.messagesPerMinute) throw new AdmissionError(429, 'bridge_rate_limit');
      const hop = input.cause === undefined ? 0 : input.cause.hop + 1; if (hop > 4) denied('bridge_hop_limit');
      const expiresAt = Math.min(now + 15 * 60000, link.grant.expiresAt); const sourceSeq = this.state.nextSeq;
      const request: BridgeSend = { bridgeId: link.grant.id, revision: link.grant.revision, source: plainRef(input.source), target: plainRef(input.target), content: input.content,
        idempotencyKey: input.idempotencyKey, sourceHomeId: this.admission.identity.homeId, targetHomeId: link.grant.target.homeId,
        createdAt: now, expiresAt, sourceSeq, causeId: input.cause?.causeId ?? randomUUID(), hop };
      const receipt: BridgeReceipt = { id, bridgeId: link.grant.id, connectionId: link.connectionId, source: request.source, target: request.target, sourceSeq, createdAt: now, expiresAt, delivery: 'pending' };
      const created: Outbox = { receipt, request, fingerprint };
      const nextOutbox = [...prunedOutbox, created];
      const nextSeq = sourceSeq + 1;
      await writePrivateFile(this.path, JSON.stringify({ ...this.state, outbox: nextOutbox, nextSeq }));
      this.state.outbox = nextOutbox;
      this.state.nextSeq = nextSeq;
      existing = created;
    });
    await this.retryLink(link.grant.id, input.signal);
    input.signal?.throwIfAborted();
    const receipt = this.state.outbox.find((entry) => entry.receipt.id === id)?.receipt ?? existing!.receipt;
    return { messageId: receipt.messageId ?? receipt.id, targetSeq: receipt.targetSeq ?? 0, acceptedAt: receipt.acceptedAt ?? receipt.createdAt,
      deduplicated: duplicate, delivery: receipt.delivery === 'delivered' ? 'delivered' : ['rejected', 'undeliverable'].includes(receipt.delivery) ? 'undeliverable' : 'pending' };
  }
  async wait(input: WaitThreadsInput): Promise<WaitThreadsResult> {
    const signal = input.signal === undefined ? this.lifetime.signal : AbortSignal.any([input.signal, this.lifetime.signal]);
    const deadline = Date.now() + (input.timeoutMs ?? 30000); let threads = input.threads;
    for (;;) {
      signal.throwIfAborted();
      const sliceMs = Math.min(10000, Math.max(0, deadline - Date.now()));
      const race = new AbortController();
      const itemSignal = AbortSignal.any([signal, race.signal]);
      let transientError = false;
      const perItem = await Promise.all(threads.map(async (item) => {
        if (['local', '', this.threads.hostId].includes(item.thread.hostId) && item.thread.bridgeId === undefined && item.thread.connectionId === undefined) {
          try {
            const localResult = await this.threads.waitThreads({ caller: input.caller, threads: [item], timeoutMs: sliceMs, signal: itemSignal });
            if (localResult.threads.some((entry) => entry.activities.length > 0)) race.abort();
            return localResult.threads;
          } catch (error) {
            if (signal.aborted) signal.throwIfAborted();
            if (race.signal.aborted) return [{ thread: item.thread, cursor: item.cursor ?? '', activities: [] }];
            throw error;
          }
        }
        const link = this.choose(item.thread, input.caller, item.thread, 'wait');
        try {
          const result = await this.remote<WaitThreadsResult>(link, 'wait', {
            bridgeId: link.grant.id,
            revision: link.grant.revision,
            source: this.source(input.caller),
            target: plainRef(item.thread),
            cursor: item.cursor,
            timeoutMs: sliceMs,
          }, itemSignal);
          const mapped = result.threads.map((entry) => ({ ...entry, thread: item.thread }));
          if (mapped.some((entry) => entry.activities.length > 0)) race.abort();
          return mapped;
        } catch (error) {
          if (signal.aborted) signal.throwIfAborted();
          if (race.signal.aborted) return [{ thread: item.thread, cursor: item.cursor ?? '', activities: [] }];
          if (isRetryableTransportError(error) && Date.now() + 300 < deadline) {
            transientError = true;
            return [{ thread: item.thread, cursor: item.cursor ?? '', activities: [] }];
          }
          throw error;
        }
      }));
      const results = perItem.flat();
      if (results.some((entry) => entry.activities.length > 0) || Date.now() >= deadline) {
        return { threads: results, timedOut: results.every((entry) => entry.activities.length === 0) };
      }
      threads = results.map((entry) => ({ thread: entry.thread, cursor: entry.cursor }));
      if (transientError) await pause(Math.min(400, Math.max(50, deadline - Date.now())), signal);
    }
  }
  retry(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve();
    if (this.state.outbox.length === 0 && (this.state.targets?.length ?? 0) === 0) return Promise.resolve();
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
    if (targets.length > 0) await this.serialize(async () => {
      const current = this.state.targets ?? [];
      const next = [...await this.mailbox.listPendingTargets({ targets: current, signal: this.lifetime.signal })];
      const unchanged = next.length === current.length && next.every((item, index) => {
        const prev = current[index]!;
        return prev.hostId === item.hostId && prev.workspaceId === item.workspaceId && prev.sessionId === item.sessionId;
      });
      if (unchanged) return;
      await writePrivateFile(this.path, JSON.stringify({ ...this.state, targets: next }));
      this.state.targets = next;
    });
  }
  private retryLink(id: string, signal?: AbortSignal): Promise<void> {
    const flight = this.flights.get(id); if (flight !== undefined) return flight;
    const pending = this.doRetryLink(id, signal); this.flights.set(id, pending);
    void pending.finally(() => { if (this.flights.get(id) === pending) this.flights.delete(id); }).catch(() => {}); return pending;
  }
  private async commitOutboxEntry(entry: Outbox, nextEntry: Outbox): Promise<void> {
    const nextOutbox = this.state.outbox.map((item) => item === entry ? nextEntry : item);
    await writePrivateFile(this.path, JSON.stringify({ ...this.state, outbox: nextOutbox }));
    Object.assign(entry.receipt, nextEntry.receipt);
    entry.attempts = nextEntry.attempts;
    entry.nextAttemptAt = nextEntry.nextAttemptAt;
    entry.finishedAt = nextEntry.finishedAt;
    entry.request = nextEntry.request;
  }
  private async doRetryLink(id: string, signal?: AbortSignal): Promise<void> {
    const dispatchEntry = async (entry: Outbox): Promise<'continue' | 'backoff' | 'stop'> => {
      if (this.lifetime.signal.aborted || signal?.aborted) return 'stop';
      const request = entry.request; if (request === undefined) throw new Error('Pending bridge receipt has no payload');
      try {
        if (request.expiresAt <= Date.now()) throw new AdmissionError(410, 'bridge_message_expired_without_delivery_confirmation');
        if (!this.link(id).enabled && !this.link(id).grant.revoked) return 'stop';
        const link = this.choose({ bridgeId: id }, request.source, request.target, 'send');
        if (entry.nextAttemptAt !== undefined && entry.nextAttemptAt > Date.now()) {
          return entry.receipt.delivery === 'accepted' ? 'continue' : 'stop';
        }
        const result = await this.remote<SendThreadMessageResult>(link, 'send', request, signal);
        await this.serialize(async () => {
          const unchanged = result.delivery === 'pending'
            && entry.receipt.delivery === 'accepted'
            && entry.receipt.messageId === result.messageId
            && entry.receipt.targetSeq === result.targetSeq
            && entry.receipt.acceptedAt === result.acceptedAt
            && entry.receipt.reason === undefined
            && (entry.attempts ?? 0) === 0;
          if (unchanged) {
            entry.nextAttemptAt = Date.now() + 1000;
            return;
          }
          const nextEntry: Outbox = result.delivery === 'pending'
            ? {
              ...entry,
              receipt: {
                ...entry.receipt,
                messageId: result.messageId,
                targetSeq: result.targetSeq,
                acceptedAt: result.acceptedAt,
                delivery: 'accepted',
                reason: undefined,
              },
              attempts: 0,
              nextAttemptAt: Date.now() + 1000,
            }
            : {
              ...entry,
              receipt: {
                ...entry.receipt,
                messageId: result.messageId,
                targetSeq: result.targetSeq,
                acceptedAt: result.acceptedAt,
                delivery: result.delivery,
                reason: undefined,
              },
              finishedAt: Date.now(),
              request: undefined,
              nextAttemptAt: undefined,
            };
          await this.commitOutboxEntry(entry, nextEntry);
        });
        return 'continue';
      } catch (error) {
        if (signal?.aborted || this.lifetime.signal.aborted) return 'stop';
        if (error instanceof AdmissionError && [400, 401, 403, 404, 409, 410].includes(error.status)) {
          await this.serialize(async () => {
            await this.commitOutboxEntry(entry, {
              ...entry,
              receipt: { ...entry.receipt, delivery: 'rejected', reason: error.reason },
              finishedAt: Date.now(),
              request: undefined,
              nextAttemptAt: undefined,
            });
          });
          return 'continue';
        }
        await this.serialize(async () => {
          const attempts = (entry.attempts ?? 0) + 1;
          await this.commitOutboxEntry(entry, {
            ...entry,
            attempts,
            receipt: {
              ...entry.receipt,
              reason: error instanceof AdmissionError && error.status === 429 ? error.reason : 'target_temporarily_unavailable',
            },
            nextAttemptAt: Date.now() + Math.min(60000, 1000 * 2 ** Math.min(6, attempts)),
          });
        });
        return 'backoff';
      }
    };
    const isDueUnaccepted = (record: Outbox): boolean =>
      record.receipt.bridgeId === id && record.receipt.delivery === 'pending'
      && (record.nextAttemptAt === undefined || record.nextAttemptAt <= Date.now());
    for (;;) {
      const pendingForLink = this.state.outbox
        .filter((record) => record.receipt.bridgeId === id && isPending(record))
        .sort((a, b) => a.receipt.sourceSeq - b.receipt.sourceSeq);
      const unaccepted = pendingForLink.filter((record) => record.receipt.delivery === 'pending');
      const confirmations = pendingForLink.filter((record) => record.receipt.delivery === 'accepted');
      for (const entry of unaccepted) {
        if (await dispatchEntry(entry) !== 'continue') return;
      }
      for (const entry of confirmations) {
        const outcome = await dispatchEntry(entry);
        if (outcome === 'stop') return;
        if (outcome === 'backoff') break;
      }
      if (this.lifetime.signal.aborted || signal?.aborted) return;
      if (!this.state.outbox.some(isDueUnaccepted)) return;
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
  private async remote<T>(link: BridgeLink, operation: 'list' | 'read' | 'send' | 'wait' | 'create' | 'tools_list' | 'tools_call', body: unknown, parent?: AbortSignal): Promise<T> {
    const record = this.connections.get(link.connectionId);
    const descriptor = this.connections.resolveTransport(link.connectionId);
    if (!sameIdentity(descriptor.target, link.grant.target)) denied('bridge_identity_mismatch');
    const controller = new AbortController();
    const waitMs = operation === 'wait' ? bridgeWaitSchema.parse(body).timeoutMs ?? 30000 : operation === 'tools_call' ? 120000 : 0;
    const lease = this.connections.lease(link.connectionId, AbortSignal.any([this.lifetime.signal, controller.signal, parent ?? this.lifetime.signal, AbortSignal.timeout(Math.max(15000, waitMs + 5000))]), 'bridge');
    const controllers = this.outgoing.get(link.grant.id) ?? new Set<AbortController>(); controllers.add(controller); this.outgoing.set(link.grant.id, controllers);
    try {
      const { credential } = await this.connections.secrets.read<{ credential: string }>({ connectionId: link.grant.id, purpose: 'bridge' });
      if (record.transport?.kind === 'peer_socket') {
        const transport = await this.connections.acquireTransport(link.connectionId, lease.signal, 'bridge');
        if (!sameIdentity(transport.target, descriptor.target)) denied('bridge_identity_mismatch');
        if (this.peerBridges === undefined) throw new AdmissionError(503, 'peer_bridge_offline');
        const reply = await this.peerBridges.forward(record.transport.grantId, operation, credential, body, lease.signal);
        const envelope = reply.envelope as RemoteEnvelope<T>;
        if (reply.status < 200 || reply.status >= 300 || envelope.code !== 0) {
          throwBridgeEnvelopeError(reply.status >= 200 && reply.status < 300 ? 409 : reply.status, envelope);
        }
        if (envelope.data === null || typeof envelope.data !== 'object' || !sameIdentity(envelope.data.identity, descriptor.target)) denied('bridge_identity_mismatch');
        return envelope.data.result;
      }
      const serializedBody = JSON.stringify(body);
      const responseLimit = operation === 'read' ? SESSION_READ_BODY_BYTES : operation === 'tools_call' ? 16 * 1024 * 1024 : operation === 'tools_list' ? 512 * 1024 : operation === 'list' ? PEER_BRIDGE_LIST_MAX_RESPONSE_BYTES : 16 * 1024;
      let lastEndpoint = descriptor.endpoint;
      const sendOverHttp = async (): Promise<T> => {
        const transport = await this.connections.acquireTransport(link.connectionId, lease.signal, 'bridge');
        if (!sameIdentity(transport.target, descriptor.target)) denied('bridge_identity_mismatch');
        lastEndpoint = transport.endpoint;
        if (record.pinnedFingerprint === undefined && record.transport?.kind !== 'peer_socket') {
          const peerCredential = await this.connections.secrets.read<{ grant: string; grantId: string }>({ connectionId: record.credentialRef, purpose: 'gui' }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT' && !record.purposes.includes('gui')) return undefined;
            throw error;
          });
          if (peerCredential !== undefined) {
            await this.connections.provePeer(transport.endpoint, record.target, { grant: peerCredential.grant, grantId: peerCredential.grantId }, lease.signal, record.pinnedFingerprint);
          }
        }
        lease.signal.throwIfAborted();
        const response = await peerFetch(
          new URL(`/api/thread-bridge/${operation}`, transport.endpoint),
          {
            method: 'POST',
            signal: lease.signal,
            headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
            body: serializedBody,
          },
          record.pinnedFingerprint,
        );
        const envelope = await readBoundedJsonBody(response, responseLimit, lease.signal) as RemoteEnvelope<T>;
        if (!response.ok || envelope.code !== 0) throwBridgeEnvelopeError(response.ok ? 409 : response.status, envelope);
        if (!sameIdentity(envelope.data.identity, descriptor.target)) denied('bridge_identity_mismatch');
        return envelope.data.result;
      };
      try {
        return await sendOverHttp();
      } catch (firstError) {
        if (operation === 'tools_call' || parent?.aborted || this.lifetime.signal.aborted || lease.signal.aborted || !isRetryableTransportError(firstError)) {
          throw firstError;
        }
        evictPinnedAgent(lastEndpoint, record.pinnedFingerprint);
        await pause(150 + Math.floor(Math.random() * 180), lease.signal);
        return await sendOverHttp();
      }
    } finally { lease.release(); controllers.delete(controller); if (controllers.size === 0) this.outgoing.delete(link.grant.id); }
  }
  private cancelOutgoing(id: string): void { for (const controller of this.outgoing.get(id) ?? []) controller.abort(); this.outgoing.delete(id); }
  attach(id: string, controller: AbortController): () => void {
    const set = this.incoming.get(id) ?? new Set<AbortController>(); set.add(controller); this.incoming.set(id, set);
    if (!this.admission.status().enabled || this.lifetime.signal.aborted) controller.abort();
    return () => { set.delete(controller); if (set.size === 0 && this.incoming.get(id) === set) this.incoming.delete(id); };
  }
  private cancelIncoming(id: string): void { for (const controller of this.incoming.get(id) ?? []) controller.abort(); this.incoming.delete(id); }
  private serialize<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(() => work());
    this.tail = result.catch(() => {});
    return result;
  }
  private change<T>(work: () => T | Promise<T>): Promise<T> {
    return this.serialize(async () => { const value = await work(); await writePrivateFile(this.path, JSON.stringify(this.state)); return value; });
  }
}

export function isSpaceThreadBridgeDataRequest(request: { method: string; url: string }): boolean { return request.method === 'POST' && DATA_PATHS.has(request.url.split('?', 1)[0]!); }
export async function authorizeSpaceThreadBridgeRequest(bridge: SpaceThreadBridge, token: string, request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  try { if (!isSpaceThreadBridgeDataRequest(request)) denied('local_owner_required'); authenticatedBridgeRequests.set(request, bridge.authorizeCredential(token)); return true; }
  catch (error) { if (!(error instanceof AdmissionError)) throw error; await reply.code(error.status).send(errEnvelope(40101, error.reason, request.id)); return false; }
}
export function isPeerRequestBridgeRequest(request: { method: string; url: string }): boolean {
  return request.method === 'POST' && request.url.split('?', 1)[0] === '/api/thread-bridges/peer/request-bridge';
}
export async function authorizePeerRequestBridgeRequest(admission: ConnectionAdmission, validateOwner: CredentialValidator, token: string, request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  try {
    const bearer = admission.matchBearer(token);
    let grantId: string;
    if (bearer !== undefined) {
      const header = peerGrant(request.headers);
      if (header !== undefined && header !== '') {
        const presented = admission.matchBearer(header);
        if (presented === undefined || presented.id !== bearer.id) throw new AdmissionError(401, 'connection_not_approved');
      }
      grantId = bearer.id;
    } else {
      if (!(await validateOwner(token))) throw new AdmissionError(401, 'invalid_owner_credential');
      const peer = admission.authorize(peerGrant(request.headers));
      grantId = peer.id;
    }
    peerRequestBridgeGrants.set(request, grantId);
    const detach = admission.attach(grantId, () => { request.raw.destroy(); reply.raw.destroy(); });
    reply.raw.once('close', detach);
    return true;
  } catch (error) {
    if (!(error instanceof AdmissionError)) throw error;
    await reply.code(error.status).send(errEnvelope(40101, error.reason, request.id));
    return false;
  }
}

export async function registerSpaceThreadBridge(app: FastifyInstance, core: Scope, admission: ConnectionAdmission, connections: RemoteConnectionManager, transcript: TranscriptService, shutdownSignal?: AbortSignal, peerBridges?: PeerBridgeRegistry): Promise<SpaceThreadBridge> {
  const bridge = new SpaceThreadBridge(core, admission, connections, transcript, peerBridges); await bridge.ready();
  const hook = admission.onDidChange((change) => {
    if (change.kind === 'revoked' || change.reason === 'state_changed' || change.reason === undefined) {
      return bridge.onAdmissionChange(change);
    }
  });
  const attachHook = peerBridges?.onDidAttach((grantId) => { void bridge.triggerPeerRetry(grantId).catch(() => {}); });
  app.addHook('preClose', async () => { attachHook?.dispose(); hook.dispose(); await bridge.close(); });
  const respond = async (req: FastifyRequest, reply: FastifyReply, work: () => unknown) => {
    try { return await reply.send(okEnvelope(await work(), req.id)); }
    catch (error) {
      if (error instanceof ContentChangedError) return reply.code(409).send(errEnvelope(40922, error.message, req.id));
      if (error instanceof ThreadMailboxBacklogError) return reply.code(429).send(errEnvelope(42901, 'bridge_queue_or_rate_limit', req.id));
      if (isError2(error)) {
        const status = error.code === ErrorCodes.THREAD_CURSOR_INVALID ? 409 : 403;
        return reply.code(status).send({
          ...errEnvelope(status === 409 ? 40924 : 40301, error.message, req.id),
          errorCode: error.code,
          ...(error.details === undefined ? {} : { details: error.details }),
        });
      }
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
  app.post('/api/thread-bridges/peer/request-bridge', { bodyLimit: 1024 * 1024 }, async (req, reply) => respond(req, reply, async () => {
    const peerGrantId = peerAudience(req)?.grantId ?? peerRequestBridgeGrants.get(req);
    if (peerGrantId === undefined) denied('peer_grant_required');
    const body = z.object({
      sourceLabel: z.string().min(1).max(128).optional(),
      operations: bridgeOperationsSchema.optional(),
      sourceWorkspaces: z.array(z.string().min(1).max(512)).optional(),
      existingBridgeId: z.string().uuid().optional(),
    }).strict().parse(req.body ?? {});
    return bridge.requestBridgeFromPeer(peerGrantId, body);
  }));
  app.get('/api/thread-bridges/receipts', async (req, reply) => respond(req, reply, () => { const query = req.query as { cursor?: string; limit?: string }; return bridge.receipts(query.cursor, Number(query.limit ?? 50)); }));
  app.put('/api/thread-bridges/:direction/:id/enabled', async (req, reply) => respond(req, reply, async () => { const { direction, id } = req.params as { direction: 'inbound' | 'outbound'; id: string }; const enabled = (req.body as { enabled?: unknown })?.enabled;
    if (!['inbound', 'outbound'].includes(direction) || typeof enabled !== 'boolean') throw new AdmissionError(400, 'invalid_bridge_setting'); await bridge.setEnabled(id, enabled, direction); return bridge.status(); }));
  app.put('/api/thread-bridges/inbound/:id/operations', { bodyLimit: 8192 }, async (req, reply) => respond(req, reply, async () => {
    const { id } = req.params as { id: string };
    const { operations } = z.object({ operations: bridgeOperationsSchema }).strict().parse(req.body);
    await bridge.setOperations(id, operations);
    return bridge.status();
  }));
  app.put('/api/thread-bridges/outbound/:id/borrow-tools', { bodyLimit: 4096 }, async (req, reply) => respond(req, reply, async () => {
    const { id } = req.params as { id: string };
    const { borrowTools } = z.object({ borrowTools: z.boolean() }).strict().parse(req.body);
    await bridge.setBorrowTools(id, borrowTools);
    return bridge.status();
  }));
  app.post('/api/thread-bridges/sync/:connectionId', { bodyLimit: 8192 }, async (req, reply) => respond(req, reply, async () => {
    const { connectionId } = req.params as { connectionId: string };
    const body = z.object({ operations: bridgeOperationsSchema.optional(), borrowTools: z.boolean().optional() }).strict().parse(req.body ?? {});
    return bridge.syncConnection(connectionId, body);
  }));
  app.post('/api/thread-bridges/:direction/:id/revoke', async (req, reply) => respond(req, reply, async () => { const { direction, id } = req.params as { direction: 'inbound' | 'outbound'; id: string };
    if (!['inbound', 'outbound'].includes(direction)) throw new AdmissionError(400, 'invalid_bridge_direction'); await bridge.revoke(id, direction); return bridge.status(); }));
  app.post('/api/thread-bridges/retry', async (req, reply) => respond(req, reply, async () => { await bridge.retry(); return bridge.receipts(); }));
  for (const operation of ['list', 'read', 'send', 'wait', 'create', 'tools_list', 'tools_call'] as const) app.post(`/api/thread-bridge/${operation}`, { bodyLimit: operation === 'tools_call' ? 4 * 1024 * 1024 : operation === 'send' || operation === 'create' ? 1024 * 1024 : 16384 }, async (req, reply) => respond(req, reply, async () => {
    const grant = authenticatedBridgeRequests.get(req);
    if (grant === undefined) throw new AdmissionError(401, 'invalid_bridge_credential');
    const controller = new AbortController(); const stop = () => controller.abort(); req.raw.once('aborted', stop); reply.raw.once('close', stop);
    const detach = bridge.attach(grant.id, controller); const signal = AbortSignal.any([controller.signal, shutdownSignal ?? controller.signal]);
    try {
      const result = operation === 'list' ? await bridge.inboundList(grant, bridgeListSchema.parse(req.body))
        : operation === 'read' ? await bridge.inboundRead(grant, bridgeReadSchema.parse(req.body), signal)
        : operation === 'send' ? await bridge.inboundSend(grant, bridgeSendSchema.parse(req.body), signal)
        : operation === 'create' ? await bridge.inboundCreate(grant, bridgeCreateSchema.parse(req.body))
        : operation === 'tools_list' ? await bridge.inboundToolsList(grant, bridgeToolsListSchema.parse(req.body), signal)
        : operation === 'tools_call' ? await bridge.inboundToolsCall(grant, bridgeToolsCallSchema.parse(req.body), signal)
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
