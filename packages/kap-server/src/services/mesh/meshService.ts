import { join } from 'node:path';
import {
  type HumanTakeoverHolder,
  type HumanTakeoverLease,
  type LeasedPeerNode,
  type LeasedPortTunnel,
  type LeasedSeat,
  type LeasedWorkspaceCopy,
  type MeshContextProjection,
  type MeshLeasePinInput,
  type MeshSessionLease,
  type MeshTargetDispatchInput,
  type MeshWorkspaceCopyApplyInput,
  type MeshWorkspaceCopyCreateInput,
  type MeshPortTunnelOpenInput,
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
  type IFileSystemStorageService,
  type ISessionApprovalService,
  type LoopbackTunnelHandle,
  type MeshApprovalOutcome,
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

export interface MeshServiceOptions {
  readonly homeDir: string;
  readonly storage?: IFileSystemStorageService;
  readonly dialRemote?: RemoteTunnelDialer;
  readonly resolveSessionContext?: (sessionId: string) => Promise<MeshSessionExecutionContext | undefined> | MeshSessionExecutionContext | undefined;
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
}

/** Coordinates session-leased mesh resources, COW workspace copies, loopback tunnels, human takeover locks, and yolo-aware approvals. */
export class MeshService {
  readonly leases: MeshLeaseStore;
  readonly workspaceCopies: WorkspaceCopyManager;
  readonly tunnels: LoopbackPortTunnelManager;
  readonly takeover: HumanTakeoverManager;
  readonly casStaging: CasStagingStore;
  readonly coalescer: MeshStateCoalescer;
  private readonly resolveSessionContext?: MeshServiceOptions['resolveSessionContext'];

  constructor(options: MeshServiceOptions) {
    this.leases = new MeshLeaseStore(options.storage, options.now);
    this.workspaceCopies = new WorkspaceCopyManager(
      join(options.homeDir, 'mesh', 'workspace-copies'),
      options.platform,
    );
    this.tunnels = new LoopbackPortTunnelManager(options.dialRemote);
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
        await this.leases.pinNode(sessionId, input.node);
        break;
      case 'seat':
        await this.leases.pinSeat(sessionId, input.seat);
        break;
      case 'workspace_copy':
        await this.leases.pinWorkspaceCopy(sessionId, input.copy);
        break;
      case 'port_tunnel':
        await this.leases.pinPortTunnel(sessionId, input.tunnel);
        break;
    }
    return this.leases.projectContext(sessionId);
  }

  async unpinResource(
    sessionId: string,
    kind: 'node' | 'seat' | 'workspace_copy' | 'port_tunnel',
    id: string,
  ): Promise<MeshContextProjection> {
    await this.leases.unpin(sessionId, kind, id);
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

  async applyWorkspaceCopy(
    copyId: string,
    input: MeshWorkspaceCopyApplyInput,
  ): Promise<WorkspaceCopyApplyResult> {
    const ctx = await this.resolveApprovalContext(input.sessionId, input.permissionMode);
    return this.workspaceCopies.apply(copyId, {
      permissionMode: ctx.permissionMode,
      approvalService: ctx.approvalService,
      sessionId: input.sessionId,
      takeoverManager: this.takeover,
      targetId: input.targetId,
      overrideHumanLease: input.overrideHumanLease,
      deleteRemoved: input.deleteRemoved,
    });
  }

  removeWorkspaceCopy(copyId: string): Promise<boolean> {
    return this.workspaceCopies.removeCopy(copyId);
  }

  listWorkspaceCopies(): Promise<readonly WorkspaceCopyRecord[]> {
    return this.workspaceCopies.listCopies();
  }

  async openTunnel(input: MeshPortTunnelOpenInput): Promise<LoopbackTunnelHandle> {
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
      throw new Error(approval.feedback ?? `Port tunnel opening rejected (${approval.decision})`);
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
  ): HumanTakeoverLease {
    return this.takeover.acquire(targetId, holder, ttlMs, reason);
  }

  releaseTakeover(targetId: string, holder?: HumanTakeoverHolder): boolean {
    return this.takeover.release(targetId, holder);
  }

  inspectTakeover(targetId: string): HumanTakeoverLease | undefined {
    return this.takeover.inspect(targetId);
  }

  async dispatchTargetAction(
    targetId: string,
    input: MeshTargetDispatchInput,
  ): Promise<MeshDispatchResult> {
    this.takeover.assertWritable(targetId, { overrideHumanLease: input.overrideHumanLease });
    const ctx = await this.resolveApprovalContext(input.sessionId, input.permissionMode);
    const approval = await evaluateMeshApproval({
      operation: input.operation,
      permissionMode: ctx.permissionMode,
      action: input.action,
      targetLabel: targetId,
      sessionId: input.sessionId,
      approvalService: ctx.approvalService,
    });
    if (approval.decision !== 'approved') {
      throw new Error(approval.feedback ?? `Action '${input.operation}' on '${targetId}' rejected (${approval.decision})`);
    }
    return {
      targetId,
      operation: input.operation,
      accepted: true,
      approval,
    };
  }

  async close(): Promise<void> {
    this.coalescer.dispose();
    await this.tunnels.closeAll();
  }

  private async resolveApprovalContext(
    sessionId: string | undefined,
    explicitMode: MeshPermissionMode | undefined,
  ): Promise<MeshSessionExecutionContext> {
    const resolved =
      sessionId === undefined || this.resolveSessionContext === undefined
        ? undefined
        : await this.resolveSessionContext(sessionId);
    return {
      permissionMode: explicitMode ?? resolved?.permissionMode ?? 'auto',
      approvalService: resolved?.approvalService,
    };
  }
}

export type { LeasedPeerNode, LeasedSeat, MeshSessionLease };
