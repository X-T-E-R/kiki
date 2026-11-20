import { z } from 'zod';

export const peerTrustTierSchema = z.enum(['trusted_personal', 'restricted_peer']);
export type PeerTrustTier = z.infer<typeof peerTrustTierSchema>;

export const meshCapabilitySchema = z.enum([
  'execute',
  'read',
  'send',
  'cow_workspace',
  'file_sync',
  'port_tunnel',
  'takeover',
]);
export type MeshCapability = z.infer<typeof meshCapabilitySchema>;

export const DEFAULT_TRUSTED_PERSONAL_CAPABILITIES: readonly MeshCapability[] = [
  'execute',
  'read',
  'send',
  'cow_workspace',
  'file_sync',
  'port_tunnel',
  'takeover',
];

export const DEFAULT_RESTRICTED_PEER_CAPABILITIES: readonly MeshCapability[] = ['read', 'send'];

export const meshSeatStateSchema = z.enum([
  'idle',
  'running',
  'blocked',
  'completed',
  'failed',
  'offline',
]);
export type MeshSeatState = z.infer<typeof meshSeatStateSchema>;

export const meshWorkspaceCopyStrategySchema = z.enum([
  'apfs_clone',
  'reflink',
  'git_worktree',
  'copy_fallback',
]);
export type MeshWorkspaceCopyStrategy = z.infer<typeof meshWorkspaceCopyStrategySchema>;

export const leasedPeerNodeSchema = z.object({
  nodeId: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
  trustTier: peerTrustTierSchema.default('restricted_peer'),
  capabilities: z.array(meshCapabilitySchema).default([...DEFAULT_RESTRICTED_PEER_CAPABILITIES]),
  state: z.enum(['online', 'offline', 'degraded']),
  platform: z.enum(['win32', 'linux', 'darwin']).optional(),
  pinnedAt: z.number().int().nonnegative(),
  createdBySession: z.boolean().default(false),
});
export type LeasedPeerNode = z.infer<typeof leasedPeerNodeSchema>;

export const leasedSeatSchema = z.object({
  seatId: z.string().min(1).max(128),
  nodeId: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
  state: meshSeatStateSchema,
  cwd: z.string().min(1).max(4096).optional(),
  summary: z.string().max(512).optional(),
  pinnedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  createdBySession: z.boolean().default(false),
});
export type LeasedSeat = z.infer<typeof leasedSeatSchema>;

export const leasedWorkspaceCopySchema = z.object({
  copyId: z.string().min(1).max(128),
  nodeId: z.string().min(1).max(128),
  sourceRoot: z.string().min(1).max(4096),
  copyPath: z.string().min(1).max(4096),
  strategy: meshWorkspaceCopyStrategySchema,
  dirty: z.boolean().default(false),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type LeasedWorkspaceCopy = z.infer<typeof leasedWorkspaceCopySchema>;

export const leasedPortTunnelSchema = z.object({
  tunnelId: z.string().min(1).max(128),
  nodeId: z.string().min(1).max(128),
  remoteHost: z.string().min(1).max(255).default('127.0.0.1'),
  remotePort: z.number().int().min(1).max(65535),
  localHost: z.string().min(1).max(255).default('127.0.0.1'),
  localPort: z.number().int().min(1).max(65535),
  healthy: z.boolean(),
  createdAt: z.number().int().nonnegative(),
});
export type LeasedPortTunnel = z.infer<typeof leasedPortTunnelSchema>;

export const meshSessionLeaseSchema = z.object({
  sessionId: z.string().min(1).max(128),
  revision: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative().default(0),
  updatedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().optional(),
  nodes: z.array(leasedPeerNodeSchema),
  seats: z.array(leasedSeatSchema),
  workspaceCopies: z.array(leasedWorkspaceCopySchema),
  portTunnels: z.array(leasedPortTunnelSchema),
});
export type MeshSessionLease = z.infer<typeof meshSessionLeaseSchema>;

export const meshContextProjectionSchema = z.object({
  sessionId: z.string().min(1).max(128),
  revision: z.number().int().nonnegative(),
  contextBlock: z.string().max(2048).nullable(),
  byteLength: z.number().int().min(0).max(2048),
  lease: meshSessionLeaseSchema,
});
export type MeshContextProjection = z.infer<typeof meshContextProjectionSchema>;

export const meshLeasePinInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node'), node: leasedPeerNodeSchema.omit({ pinnedAt: true }) }).strict(),
  z.object({ kind: z.literal('seat'), seat: leasedSeatSchema.omit({ pinnedAt: true, updatedAt: true }) }).strict(),
  z.object({ kind: z.literal('workspace_copy'), copy: leasedWorkspaceCopySchema }).strict(),
  z.object({ kind: z.literal('port_tunnel'), tunnel: leasedPortTunnelSchema }).strict(),
]);
export type MeshLeasePinInput = z.infer<typeof meshLeasePinInputSchema>;

export const meshLeaseUnpinInputSchema = z.object({
  kind: z.enum(['node', 'seat', 'workspace_copy', 'port_tunnel']),
  id: z.string().min(1).max(128),
  expectedEpoch: z.number().int().nonnegative().optional(),
}).strict();
export type MeshLeaseUnpinInput = z.infer<typeof meshLeaseUnpinInputSchema>;

export const meshLeaseRenewInputSchema = z.object({
  ttlMs: z.number().int().min(1000).max(86_400_000).default(300_000),
  expectedEpoch: z.number().int().nonnegative().optional(),
}).strict();
export type MeshLeaseRenewInput = z.infer<typeof meshLeaseRenewInputSchema>;

export const meshWorkspaceCopyCreateInputSchema = z.object({
  sourceRoot: z.string().min(1).max(4096),
  nodeId: z.string().min(1).max(128).default('local'),
  sessionId: z.string().min(1).max(128).optional(),
  copyId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/).optional(),
}).strict();
export type MeshWorkspaceCopyCreateInput = z.infer<typeof meshWorkspaceCopyCreateInputSchema>;

export const meshWorkspaceCopyApplyInputSchema = z.object({
  sessionId: z.string().min(1).max(128).optional(),
  permissionMode: z.enum(['manual', 'review', 'auto', 'yolo']).optional(),
  targetId: z.string().min(1).max(128).optional(),
  overrideHumanLease: z.boolean().optional(),
  expectedEpoch: z.number().int().nonnegative().optional(),
  deleteRemoved: z.boolean().default(true),
  forceOverwriteSource: z.boolean().default(false),
}).strict();
export type MeshWorkspaceCopyApplyInput = z.infer<typeof meshWorkspaceCopyApplyInputSchema>;

export const meshPortTunnelOpenInputSchema = z.object({
  nodeId: z.string().min(1).max(128),
  remoteHost: z.string().min(1).max(255).default('127.0.0.1'),
  remotePort: z.number().int().min(1).max(65535),
  localPort: z.number().int().min(0).max(65535).optional(),
  sessionId: z.string().min(1).max(128).optional(),
  permissionMode: z.enum(['manual', 'review', 'auto', 'yolo']).optional(),
}).strict();
export type MeshPortTunnelOpenInput = z.infer<typeof meshPortTunnelOpenInputSchema>;

export const humanTakeoverHolderSchema = z.enum(['human', 'orchestrator']);
export type HumanTakeoverHolder = z.infer<typeof humanTakeoverHolderSchema>;

export const humanTakeoverLeaseSchema = z.object({
  targetId: z.string().min(1).max(128),
  holder: humanTakeoverHolderSchema,
  epoch: z.number().int().nonnegative().default(1),
  acquiredAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  reason: z.string().max(256).optional(),
});
export type HumanTakeoverLease = z.infer<typeof humanTakeoverLeaseSchema>;

export const humanTakeoverAcquireInputSchema = z.object({
  holder: humanTakeoverHolderSchema,
  ttlMs: z.number().int().min(1000).max(86_400_000).default(300_000),
  reason: z.string().max(256).optional(),
  expectedEpoch: z.number().int().nonnegative().optional(),
  overrideHumanLease: z.boolean().optional(),
}).strict();
export type HumanTakeoverAcquireInput = z.infer<typeof humanTakeoverAcquireInputSchema>;

export const humanTakeoverConflictSchema = z.object({
  error: z.literal('human_controlling'),
  targetId: z.string().min(1).max(128),
  holder: z.literal('human'),
  epoch: z.number().int().nonnegative().optional(),
  expiresAt: z.number().int().nonnegative(),
});
export type HumanTakeoverConflict = z.infer<typeof humanTakeoverConflictSchema>;

export const meshStaleEpochConflictSchema = z.object({
  error: z.literal('stale_epoch'),
  targetId: z.string().min(1).max(128),
  expectedEpoch: z.number().int().nonnegative(),
  currentEpoch: z.number().int().nonnegative(),
});
export type MeshStaleEpochConflict = z.infer<typeof meshStaleEpochConflictSchema>;

export const meshTargetDispatchInputSchema = z.object({
  operation: z.enum([
    'remote_command',
    'out_of_workspace',
    'cow_apply',
    'file_sync',
    'port_tunnel',
    'interactive_login',
    'remote_question',
  ]),
  action: z.string().min(1).max(512),
  sessionId: z.string().min(1).max(128).optional(),
  permissionMode: z.enum(['manual', 'review', 'auto', 'yolo']).optional(),
  overrideHumanLease: z.boolean().optional(),
  expectedEpoch: z.number().int().nonnegative().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type MeshTargetDispatchInput = z.infer<typeof meshTargetDispatchInputSchema>;

export const meshResolveQuestionInputSchema = z.object({
  questionId: z.string().min(1).max(128).optional(),
  answer: z.string().min(1).max(4096),
  sessionId: z.string().min(1).max(128).optional(),
  expectedEpoch: z.number().int().nonnegative().optional(),
}).strict();
export type MeshResolveQuestionInput = z.infer<typeof meshResolveQuestionInputSchema>;

export const meshInboundExecuteInputSchema = z.object({
  operation: z.enum([
    'remote_command',
    'out_of_workspace',
    'cow_apply',
    'file_sync',
    'port_tunnel',
    'interactive_login',
    'remote_question',
  ]),
  action: z.string().min(1).max(512),
  targetId: z.string().min(1).max(128).default('local'),
  sessionId: z.string().min(1).max(128).optional(),
  overrideHumanLease: z.boolean().optional(),
  expectedEpoch: z.number().int().nonnegative().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type MeshInboundExecuteInput = z.infer<typeof meshInboundExecuteInputSchema>;
