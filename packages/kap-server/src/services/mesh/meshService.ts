import { createConnection } from 'node:net';
import { join } from 'node:path';
import {
  DEFAULT_RESTRICTED_PEER_CAPABILITIES,
  DEFAULT_TRUSTED_PERSONAL_CAPABILITIES,
  type HumanTakeoverHolder,
  type HumanTakeoverLease,
  type LeasedPeerNode,
  type LeasedPortTunnel,
  type LeasedSeat,
  type LeasedWorkspaceCopy,
  type MeshCapability,
  type MeshContextProjection,
  type MeshInboundExecuteInput,
  type MeshLeasePinInput,
  type MeshPortTunnelOpenInput,
  type MeshResolveQuestionInput,
  type MeshSessionLease,
  type MeshTargetDispatchInput,
  type MeshWorkspaceCopyApplyInput,
  type MeshWorkspaceCopyCreateInput,
  type PeerTrustTier,
} from '@kiki/protocol';
import {
  CasStagingStore,
  DEFAULT_COALESCE_WINDOW_MS,
  evaluateMeshApproval,
  HumanTakeoverManager,
  LoopbackPortTunnelManager,
  MeshLeaseStore,
  MeshStateCoalescer,
  WorkspaceCopyManager,
  type GitWipDeltaApplyResult,
  type GitWipDeltaExportResult,
  type IFileSystemStorageService,
  type IMeshLeaseStore,
  type ISessionApprovalService,
  type LoopbackTunnelHandle,
  type MeshApprovalOutcome,
  type MeshOperationKind,
  type MeshPermissionMode,
  type MeshStateTransition,
  type RemoteTunnelDialer,
  type WorkspaceCopyApplyResult,
  type WorkspaceCopyRecord,
  type WorkspaceCopySnapshot,
  type WorkspaceCopyStatus,
} from '@kiki/agent-core-v2';

export interface MeshSessionExecutionContext {
  readonly permissionMode: MeshPermissionMode;
  readonly approvalService?: Pick<ISessionApprovalService, 'request'>;
}

export interface MeshPeerDescriptor {
  readonly id: string;
  readonly label?: string;
  readonly endpoint?: string;
  readonly online?: boolean;
  readonly trustTier?: PeerTrustTier;
  readonly meshCapabilities?: readonly MeshCapability[];
}

export interface MeshInboundExecutionReceipt {
  readonly executed: true;
  readonly hostId: string;
  readonly targetId: string;
  readonly operation: MeshInboundExecuteInput['operation'];
  readonly action: string;
  readonly epoch: number;
  readonly output?: unknown;
}

export interface MeshServiceOptions {
  readonly homeDir: string;
  readonly hostId?: string;
  readonly storage?: IFileSystemStorageService;
  readonly leaseStore?: IMeshLeaseStore;
  readonly dialRemote?: RemoteTunnelDialer;
  readonly resolvePeer?: (targetId: string) => MeshPeerDescriptor | undefined;
  readonly executeRemoteAction?: (
    peer: MeshPeerDescriptor,
    input: MeshTargetDispatchInput,
  ) => Promise<unknown>;
  readonly onInboundExecute?: (input: MeshInboundExecuteInput) => Promise<unknown>;
  readonly resolveSessionContext?: (
    sessionId: string,
  ) => Promise<MeshSessionExecutionContext | undefined> | MeshSessionExecutionContext | undefined;
  readonly onStateBatch?: (transitions: readonly MeshStateTransition[]) => void;
  readonly coalesceWindowMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
}

export interface MeshDispatchResult {
  readonly targetId: string;
  readonly operation: MeshTargetDispatchInput['operation'];
  readonly accepted: true;
  readonly approval: MeshApprovalOutcome;
  readonly peerId?: string;
  readonly trustTier?: PeerTrustTier;
  readonly epoch: number;
  readonly forwardedResult?: unknown;
}

const MODE_RANK: Record<MeshPermissionMode, number> = {
  manual: 0,
  review: 1,
  auto: 2,
  yolo: 3,
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Error raised with HTTP 403 when a peer lacks the mesh capability required for an operation. */
export class MeshCapabilityDeniedError extends Error {
  readonly status = 403 as const;
  readonly code = 'mesh_capability_denied' as const;

  constructor(
    readonly targetId: string,
    readonly trustTier: PeerTrustTier,
    readonly requiredCapability: MeshCapability,
  ) {
    super(
      `Peer '${targetId}' (trustTier='${trustTier}') lacks required mesh capability '${requiredCapability}'`,
    );
    this.name = 'MeshCapabilityDeniedError';
  }
}

/** Error raised with HTTP 403 when an operation is rejected or cancelled by approval policy or human reviewer. */
export class MeshApprovalRejectedError extends Error {
  readonly status = 403 as const;
  readonly code = 'approval_rejected' as const;

  constructor(message: string) {
    super(message);
    this.name = 'MeshApprovalRejectedError';
  }
}

/** Error raised when a target peer cannot be resolved, is offline, or has no remote executor wired. */
export class MeshPeerUnavailableError extends Error {
  constructor(
    readonly status: 404 | 503,
    readonly code: 'peer_not_found' | 'peer_offline' | 'remote_executor_unavailable',
    readonly targetId: string,
    message: string,
  ) {
    super(message);
    this.name = 'MeshPeerUnavailableError';
  }
}

/** Builds an SSRF-safe TCP dialer bound strictly to loopback (for `local`) or the resolved authorized peer endpoint hostname. */
export function createPeerTcpDialer(
  resolvePeer?: (targetId: string) => MeshPeerDescriptor | undefined,
): RemoteTunnelDialer {
  return ({ nodeId, remoteHost, remotePort }) => {
    const host = resolveAuthorizedTcpHost(nodeId, remoteHost, resolvePeer);
    return createConnection({ host, port: remotePort });
  };
}

/** Coordinates session-leased mesh resources, COW workspace copies, loopback tunnels, human takeover locks, peer trust enforcement, and yolo-aware approvals. */
export class MeshService {
  readonly leases: IMeshLeaseStore;
  readonly workspaceCopies: WorkspaceCopyManager;
  readonly tunnels: LoopbackPortTunnelManager;
  readonly takeover: HumanTakeoverManager;
  readonly casStaging: CasStagingStore;
  readonly coalescer: MeshStateCoalescer;
  private readonly hostId: string;
  private readonly resolveSessionContext?: MeshServiceOptions['resolveSessionContext'];
  private readonly resolvePeer?: MeshServiceOptions['resolvePeer'];
  private readonly executeRemoteAction?: MeshServiceOptions['executeRemoteAction'];
  private readonly onInboundExecute?: MeshServiceOptions['onInboundExecute'];
  private readonly now: () => number;

  constructor(options: MeshServiceOptions) {
    this.hostId = options.hostId ?? 'local';
    this.now = options.now ?? (() => Date.now());
    this.leases = options.leaseStore ?? new MeshLeaseStore(options.storage, options.now);
    this.workspaceCopies = new WorkspaceCopyManager(
      join(options.homeDir, 'mesh', 'workspace-copies'),
      options.platform,
    );
    this.resolvePeer = options.resolvePeer;
    this.executeRemoteAction = options.executeRemoteAction;
    this.onInboundExecute = options.onInboundExecute;
    this.tunnels = new LoopbackPortTunnelManager(
      options.dialRemote ?? createPeerTcpDialer(options.resolvePeer),
    );
    this.takeover = new HumanTakeoverManager(options.now);
    this.casStaging = new CasStagingStore(
      join(options.homeDir, 'mesh', 'cas-staging'),
      undefined,
      options.now,
    );
    this.coalescer = new MeshStateCoalescer(
      options.onStateBatch ?? (() => undefined),
      options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS,
    );
    this.resolveSessionContext = options.resolveSessionContext;
  }

  getSessionLease(sessionId: string): Promise<MeshContextProjection> {
    return this.leases.projectContext(sessionId);
  }

  async pinResource(sessionId: string, input: MeshLeasePinInput): Promise<MeshContextProjection> {
    switch (input.kind) {
      case 'node':
        await this.leases.pinNode(sessionId, input.node, input.expectedEpoch);
        this.recordTransition({
          sessionId,
          resourceKind: 'node',
          resourceId: input.node.nodeId,
          previousState: 'unpinned',
          nextState: input.node.state,
          at: this.now(),
        });
        break;
      case 'seat':
        await this.leases.pinSeat(sessionId, input.seat, input.expectedEpoch);
        this.recordTransition({
          sessionId,
          resourceKind: 'seat',
          resourceId: input.seat.seatId,
          previousState: 'unpinned',
          nextState: input.seat.state,
          at: this.now(),
        });
        break;
      case 'workspace_copy':
        await this.leases.pinWorkspaceCopy(sessionId, input.copy, input.expectedEpoch);
        this.recordTransition({
          sessionId,
          resourceKind: 'workspace_copy',
          resourceId: input.copy.copyId,
          previousState: 'unpinned',
          nextState: input.copy.dirty ? 'dirty' : 'clean',
          at: this.now(),
        });
        break;
      case 'port_tunnel':
        await this.leases.pinPortTunnel(sessionId, input.tunnel, input.expectedEpoch);
        this.recordTransition({
          sessionId,
          resourceKind: 'port_tunnel',
          resourceId: input.tunnel.tunnelId,
          previousState: 'unpinned',
          nextState: input.tunnel.healthy ? 'healthy' : 'unhealthy',
          at: this.now(),
        });
        break;
    }
    return this.leases.projectContext(sessionId);
  }

  async unpinResource(
    sessionId: string,
    kind: 'node' | 'seat' | 'workspace_copy' | 'port_tunnel',
    id: string,
    expectedEpoch?: number,
  ): Promise<MeshContextProjection> {
    await this.leases.unpin(sessionId, kind, id, expectedEpoch);
    this.recordTransition({
      sessionId,
      resourceKind: kind,
      resourceId: id,
      previousState: 'pinned',
      nextState: 'unpinned',
      at: this.now(),
    });
    return this.leases.projectContext(sessionId);
  }

  async renewSessionLease(
    sessionId: string,
    ttlMs?: number,
    expectedEpoch?: number,
  ): Promise<MeshContextProjection> {
    if (this.leases.renewLease !== undefined) {
      await this.leases.renewLease(sessionId, ttlMs, expectedEpoch);
    }
    return this.leases.projectContext(sessionId);
  }

  recordTransition(transition: MeshStateTransition): void {
    this.coalescer.push(transition);
  }

  async createWorkspaceCopy(input: MeshWorkspaceCopyCreateInput): Promise<WorkspaceCopyRecord> {
    const created = await this.workspaceCopies.createCopy({
      sourceRoot: input.sourceRoot,
      nodeId: input.nodeId,
      copyId: input.copyId,
    });
    if (input.sessionId !== undefined) {
      const leasedCopy: LeasedWorkspaceCopy = {
        copyId: created.copyId,
        nodeId: created.nodeId,
        sourceRoot: created.sourceRoot,
        copyPath: created.copyPath,
        strategy: created.strategy,
        dirty: false,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };
      await this.leases.pinWorkspaceCopy(input.sessionId, leasedCopy);
    }
    return created;
  }

  workspaceCopyStatus(copyId: string): Promise<WorkspaceCopyStatus> {
    return this.workspaceCopies.status(copyId);
  }

  workspaceCopyDiff(copyId: string): Promise<string> {
    return this.workspaceCopies.diff(copyId);
  }

  workspaceCopySnapshot(copyId: string, label?: string): Promise<WorkspaceCopySnapshot> {
    return this.workspaceCopies.snapshot(copyId, label);
  }

  async exportWorkspaceCopyDelta(
    copyId: string,
  ): Promise<GitWipDeltaExportResult & { readonly bundleBase64: string; readonly stagedSha256?: string }> {
    const copy = await this.workspaceCopies.getCopy(copyId);
    if (copy === undefined) {
      throw new Error(`Workspace copy '${copyId}' not found`);
    }
    if (copy.nodeId !== 'local') {
      this.assertPeerCapability(copy.nodeId, 'cow_apply');
    }
    return this.workspaceCopies.exportWipDelta(copyId, this.casStaging, {
      takeoverManager: this.takeover,
    });
  }

  async applyWorkspaceCopyDelta(
    copyId: string,
    input: { readonly wipId: string; readonly bundleBase64: string },
  ): Promise<GitWipDeltaApplyResult> {
    const copy = await this.workspaceCopies.getCopy(copyId);
    if (copy === undefined) {
      throw new Error(`Workspace copy '${copyId}' not found`);
    }
    if (copy.nodeId !== 'local') {
      this.assertPeerCapability(copy.nodeId, 'cow_apply');
    }
    return this.workspaceCopies.applyWipDelta(copyId, input, this.casStaging, {
      takeoverManager: this.takeover,
    });
  }

  async applyWorkspaceCopy(
    copyId: string,
    input: MeshWorkspaceCopyApplyInput,
  ): Promise<WorkspaceCopyApplyResult> {
    const copy = await this.workspaceCopies.getCopy(copyId);
    if (copy === undefined) {
      throw new Error(`Workspace copy '${copyId}' not found`);
    }
    if (copy.nodeId !== 'local') {
      this.assertPeerCapability(copy.nodeId, 'cow_apply');
    }
    const ctx = await this.resolveApprovalContext(input.sessionId, input.permissionMode);
    return this.workspaceCopies.apply(copyId, {
      permissionMode: ctx.permissionMode,
      approvalService: ctx.approvalService,
      sessionId: input.sessionId,
      takeoverManager: this.takeover,
      targetId: copy.nodeId,
      overrideHumanLease: input.overrideHumanLease,
      expectedEpoch: input.expectedEpoch,
      deleteRemoved: input.deleteRemoved,
      forceOverwriteSource: input.forceOverwriteSource,
    });
  }

  async removeWorkspaceCopy(copyId: string): Promise<boolean> {
    const copy = await this.workspaceCopies.getCopy(copyId);
    if (copy === undefined) return false;
    if (copy.nodeId !== 'local') {
      this.assertPeerCapability(copy.nodeId, 'cow_apply');
    }
    this.takeover.assertWritable(copy.nodeId);
    return this.workspaceCopies.removeCopy(copyId);
  }

  listWorkspaceCopies(): Promise<readonly WorkspaceCopyRecord[]> {
    return this.workspaceCopies.listCopies();
  }

  async openTunnel(input: MeshPortTunnelOpenInput): Promise<LoopbackTunnelHandle> {
    if (input.nodeId !== 'local') {
      this.assertPeerCapability(input.nodeId, 'port_tunnel');
    }
    resolveAuthorizedTcpHost(input.nodeId, input.remoteHost, this.resolvePeer);
    const ctx = await this.resolveApprovalContext(input.sessionId, input.permissionMode);
    const approval = await evaluateMeshApproval({
      operation: 'port_tunnel',
      permissionMode: ctx.permissionMode,
      action: `Open loopback tunnel to ${input.nodeId}:${input.remotePort}`,
      targetLabel: input.nodeId,
      sessionId: input.sessionId,
      approvalService: ctx.approvalService,
    });
    if (approval.decision !== 'approved') {
      throw new MeshApprovalRejectedError(
        approval.feedback ?? `Port tunnel opening rejected (${approval.decision})`,
      );
    }
    const handle = await this.tunnels.ensureTunnel({
      nodeId: input.nodeId,
      remoteHost: input.remoteHost,
      remotePort: input.remotePort,
      localPort: input.localPort,
    });
    if (input.sessionId !== undefined) {
      await this.leases.pinPortTunnel(input.sessionId, handle.tunnel);
    }
    return handle;
  }

  listTunnels(): readonly LeasedPortTunnel[] {
    return this.tunnels.listTunnels();
  }

  closeTunnel(tunnelId: string): Promise<boolean> {
    return this.tunnels.closeTunnel(tunnelId);
  }

  acquireTakeover(
    targetId: string,
    holder: HumanTakeoverHolder,
    ttlMs?: number,
    reason?: string,
    options?: { readonly expectedEpoch?: number; readonly overrideHumanLease?: boolean },
  ): HumanTakeoverLease {
    return this.takeover.acquire(targetId, holder, ttlMs, reason, options);
  }

  renewTakeover(
    targetId: string,
    holder: HumanTakeoverHolder,
    ttlMs?: number,
    expectedEpoch?: number,
  ): HumanTakeoverLease | undefined {
    return this.takeover.renew(targetId, holder, ttlMs, expectedEpoch);
  }

  releaseTakeover(
    targetId: string,
    holder?: HumanTakeoverHolder,
    expectedEpoch?: number,
  ): boolean {
    return this.takeover.release(targetId, holder, expectedEpoch);
  }

  inspectTakeover(targetId: string): HumanTakeoverLease | undefined {
    return this.takeover.inspect(targetId);
  }

  async resolveQuestion(
    targetId: string,
    input: MeshResolveQuestionInput,
  ): Promise<MeshDispatchResult> {
    return this.dispatchTargetAction(targetId, {
      operation: 'remote_question',
      action: input.answer,
      sessionId: input.sessionId,
      expectedEpoch: input.expectedEpoch,
      payload: input.questionId === undefined ? undefined : { questionId: input.questionId },
    });
  }

  async dispatchTargetAction(
    targetId: string,
    input: MeshTargetDispatchInput,
  ): Promise<MeshDispatchResult> {
    const checkLocalWritable = (): void => {
      this.takeover.assertWritable(targetId, {
        overrideHumanLease: input.overrideHumanLease,
        ...(targetId === 'local' ? { expectedEpoch: input.expectedEpoch } : {}),
      });
    };
    checkLocalWritable();
    const peer = targetId === 'local' ? undefined : this.assertPeerCapability(targetId, input.operation);
    const ctx = await this.resolveApprovalContext(input.sessionId, input.permissionMode);
    const delegateRemoteLoginApproval =
      targetId !== 'local' &&
      input.operation === 'interactive_login' &&
      ctx.approvalService === undefined;
    const approval: MeshApprovalOutcome = delegateRemoteLoginApproval
      ? { decision: 'approved', via: 'session_approval_service' }
      : await evaluateMeshApproval({
          operation: input.operation,
          permissionMode: ctx.permissionMode,
          action: input.action,
          targetLabel: targetId,
          sessionId: input.sessionId,
          approvalService: ctx.approvalService,
        });
    if (approval.decision !== 'approved') {
      throw new MeshApprovalRejectedError(
        approval.feedback ?? `Action '${input.operation}' on '${targetId}' rejected (${approval.decision})`,
      );
    }
    checkLocalWritable();
    let forwardedResult: unknown;
    if (targetId !== 'local') {
      if (peer === undefined) {
        throw new MeshPeerUnavailableError(404, 'peer_not_found', targetId, `Peer '${targetId}' not found`);
      }
      if (peer.online === false) {
        throw new MeshPeerUnavailableError(503, 'peer_offline', targetId, `Peer '${targetId}' is offline`);
      }
      if (this.executeRemoteAction === undefined) {
        throw new MeshPeerUnavailableError(
          503,
          'remote_executor_unavailable',
          targetId,
          `No remote executor wired for peer '${targetId}'`,
        );
      }
      forwardedResult = await this.executeRemoteAction(peer, input);
    } else if (input.operation === 'interactive_login') {
      forwardedResult = {
        executed: true,
        hostId: this.hostId,
        targetId: 'local',
        operation: input.operation,
        action: input.action,
        epoch: this.takeover.currentEpoch('local'),
        output: { approved: true, decision: approval.decision },
      };
    } else {
      forwardedResult = await this.executeInboundAction({
        operation: input.operation,
        action: input.action,
        targetId: 'local',
        sessionId: input.sessionId,
        overrideHumanLease: input.overrideHumanLease,
        expectedEpoch: input.expectedEpoch,
        payload: input.payload,
      });
    }
    const remoteEpoch =
      forwardedResult !== null &&
      typeof forwardedResult === 'object' &&
      typeof (forwardedResult as { epoch?: unknown }).epoch === 'number'
        ? (forwardedResult as { epoch: number }).epoch
        : undefined;
    return {
      targetId,
      operation: input.operation,
      accepted: true,
      approval,
      epoch: remoteEpoch ?? this.takeover.currentEpoch(targetId),
      ...(peer === undefined ? {} : { peerId: peer.id, trustTier: peer.trustTier ?? 'restricted_peer' }),
      ...(forwardedResult === undefined ? {} : { forwardedResult }),
    };
  }

  async executeInboundAction(input: MeshInboundExecuteInput): Promise<MeshInboundExecutionReceipt> {
    if (input.targetId !== 'local') {
      throw new Error(`Inbound execution target '${input.targetId}' is not allowed`);
    }
    this.takeover.assertWritable('local', {
      overrideHumanLease: input.overrideHumanLease,
      expectedEpoch: input.expectedEpoch,
    });
    const pinnedInput: MeshInboundExecuteInput = { ...input, targetId: 'local' };
    const output = this.onInboundExecute === undefined ? undefined : await this.onInboundExecute(pinnedInput);
    if (input.sessionId !== undefined) {
      this.recordTransition({
        sessionId: input.sessionId,
        resourceKind: 'seat',
        resourceId: 'local',
        previousState: 'running',
        nextState: 'completed',
        at: this.now(),
        detail: `${input.operation}:${input.action.slice(0, 64)}`,
      });
    }
    return {
      executed: true,
      hostId: this.hostId,
      targetId: 'local',
      operation: input.operation,
      action: input.action,
      epoch: this.takeover.currentEpoch('local'),
      ...(output === undefined ? {} : { output }),
    };
  }

  async close(): Promise<void> {
    this.coalescer.dispose();
    await this.tunnels.closeAll();
  }

  private assertPeerCapability(
    targetId: string,
    operation: MeshOperationKind,
  ): MeshPeerDescriptor {
    const peer = this.resolvePeer?.(targetId);
    if (peer === undefined) {
      throw new MeshPeerUnavailableError(404, 'peer_not_found', targetId, `Peer '${targetId}' not found`);
    }
    const trustTier: PeerTrustTier = peer.trustTier ?? 'restricted_peer';
    const capabilities =
      peer.meshCapabilities ??
      (trustTier === 'restricted_peer'
        ? DEFAULT_RESTRICTED_PEER_CAPABILITIES
        : DEFAULT_TRUSTED_PERSONAL_CAPABILITIES);
    const required = requiredCapabilityForOperation(operation);
    if (!capabilities.includes(required)) {
      throw new MeshCapabilityDeniedError(targetId, trustTier, required);
    }
    return peer;
  }

  private async resolveApprovalContext(
    sessionId: string | undefined,
    explicitMode: MeshPermissionMode | undefined,
  ): Promise<MeshSessionExecutionContext> {
    if (sessionId !== undefined && this.resolveSessionContext !== undefined) {
      const resolved = await this.resolveSessionContext(sessionId);
      if (resolved !== undefined) {
        const effectiveMode =
          explicitMode === undefined
            ? resolved.permissionMode
            : MODE_RANK[explicitMode] < MODE_RANK[resolved.permissionMode]
              ? explicitMode
              : resolved.permissionMode;
        return {
          permissionMode: effectiveMode,
          approvalService: resolved.approvalService,
        };
      }
      return { permissionMode: 'manual' };
    }
    return {
      permissionMode: explicitMode ?? 'auto',
    };
  }
}

/** Maps a mesh operation to the minimum peer capability required to invoke it. */
export function requiredCapabilityForOperation(operation: MeshOperationKind): MeshCapability {
  switch (operation) {
    case 'remote_command':
    case 'out_of_workspace':
    case 'interactive_login':
      return 'execute';
    case 'cow_apply':
      return 'cow_workspace';
    case 'file_sync':
      return 'file_sync';
    case 'port_tunnel':
      return 'port_tunnel';
    case 'remote_question':
      return 'send';
  }
}

function resolveAuthorizedTcpHost(
  nodeId: string,
  remoteHost: string,
  resolvePeer?: (targetId: string) => MeshPeerDescriptor | undefined,
): string {
  const requested = remoteHost.trim().toLowerCase();
  if (nodeId === 'local') {
    if (requested === '' || LOOPBACK_HOSTS.has(requested)) {
      return requested === '' ? '127.0.0.1' : remoteHost.trim();
    }
    throw new Error(`Tunnel host '${remoteHost}' is not allowed for local loopback node`);
  }
  const peer = resolvePeer?.(nodeId);
  if (peer === undefined || peer.endpoint === undefined) {
    throw new Error(`Peer '${nodeId}' has no authorized reachable TCP endpoint`);
  }
  let peerHost: string;
  try {
    const parsed = new URL(peer.endpoint);
    if (parsed.hostname.length === 0) throw new Error('empty host');
    peerHost = parsed.hostname;
  } catch {
    throw new Error(`Peer '${nodeId}' has an invalid endpoint '${peer.endpoint}'`);
  }
  if (requested === '' || LOOPBACK_HOSTS.has(requested) || requested === peerHost.toLowerCase()) {
    return peerHost;
  }
  throw new Error(
    `Tunnel host '${remoteHost}' does not match authorized peer '${nodeId}' host '${peerHost}'`,
  );
}

export type { LeasedPeerNode, LeasedSeat, MeshSessionLease };
