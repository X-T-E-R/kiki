import type {
  HumanTakeoverAcquireInput,
  HumanTakeoverHolder,
  HumanTakeoverLease,
  LeasedPortTunnel,
  MeshContextProjection,
  MeshLeasePinInput,
  MeshLeaseRenewInput,
  MeshLeaseUnpinInput,
  MeshPortTunnelOpenInput,
  MeshResolveQuestionInput,
  MeshTargetDispatchInput,
  MeshWorkspaceCopyApplyInput,
  MeshWorkspaceCopyCreateInput,
} from '@kiki/protocol';
import type { HttpRestRequestOptions } from './http-rest.js';

export interface MeshFacade {
  getSessionLease(sessionId: string): Promise<MeshContextProjection>;
  pinResource(sessionId: string, input: MeshLeasePinInput): Promise<MeshContextProjection>;
  unpinResource(sessionId: string, input: MeshLeaseUnpinInput): Promise<MeshContextProjection>;
  renewSessionLease(sessionId: string, input?: MeshLeaseRenewInput): Promise<MeshContextProjection>;
  listWorkspaceCopies(): Promise<readonly Record<string, unknown>[]>;
  createWorkspaceCopy(input: MeshWorkspaceCopyCreateInput): Promise<Record<string, unknown>>;
  workspaceCopyStatus(copyId: string): Promise<Record<string, unknown>>;
  workspaceCopyDiff(copyId: string): Promise<{ readonly copyId: string; readonly diff: string }>;
  workspaceCopySnapshot(copyId: string, label?: string): Promise<Record<string, unknown>>;
  applyWorkspaceCopy(copyId: string, input?: MeshWorkspaceCopyApplyInput): Promise<Record<string, unknown>>;
  removeWorkspaceCopy(copyId: string): Promise<{ readonly removed: boolean }>;
  listTunnels(): Promise<readonly LeasedPortTunnel[]>;
  openTunnel(input: MeshPortTunnelOpenInput): Promise<{ readonly tunnel: LeasedPortTunnel; readonly reused: boolean }>;
  closeTunnel(tunnelId: string): Promise<{ readonly closed: boolean }>;
  inspectTakeover(targetId: string): Promise<{ readonly lease: HumanTakeoverLease | null; readonly epoch: number }>;
  acquireTakeover(targetId: string, input: HumanTakeoverAcquireInput): Promise<HumanTakeoverLease>;
  renewTakeover(targetId: string, input: { readonly holder: HumanTakeoverHolder; readonly ttlMs?: number; readonly expectedEpoch?: number }): Promise<HumanTakeoverLease>;
  releaseTakeover(targetId: string, input?: { readonly holder?: HumanTakeoverHolder; readonly expectedEpoch?: number }): Promise<{ readonly released: boolean; readonly epoch: number }>;
  dispatchTargetAction(targetId: string, input: MeshTargetDispatchInput, options?: HttpRestRequestOptions): Promise<Record<string, unknown>>;
  resolveQuestion(targetId: string, input: MeshResolveQuestionInput, options?: HttpRestRequestOptions): Promise<Record<string, unknown>>;
}
