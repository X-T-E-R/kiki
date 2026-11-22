import { z } from 'zod';
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_URI_PREFIX,
  formatPairingUri,
  isDirectConnectionHost,
  normalizePairingCode,
  parsePairingUri,
} from '../pairing';
import { meshCapabilitySchema, peerTrustTierSchema } from './mesh';

export {
  PAIRING_CODE_ALPHABET,
  PAIRING_URI_PREFIX,
  formatPairingUri,
  isDirectConnectionHost,
  normalizePairingCode,
  parsePairingUri,
};

const fingerprintSchema = /* @__PURE__ */ z.string().regex(/^[a-f0-9]{64}$/);
export const CONNECTION_PROTOCOL = 1;
const safeText = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001F\u007F]+$/);
export const sshRemoteProfileSchema = /* @__PURE__ */ z.object({
  id: safeText(80).regex(/^[a-zA-Z0-9_-]+$/), label: safeText(100),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('alias'), alias: safeText(255).regex(/^[^-\s][^\s]*$/) }).strict(),
    z.object({ kind: z.literal('host'), hostname: safeText(255).regex(/^[a-zA-Z0-9.:_][a-zA-Z0-9.\-:_]*$/), username: safeText(64).regex(/^[a-zA-Z0-9_.][a-zA-Z0-9._-]*$/).optional(), port: z.number().int().min(1).max(65535).optional() }).strict(),
  ]),
  identityFile: safeText(4096).optional(), releaseChannel: z.enum(['stable', 'beta']).optional(),
  remoteHome: safeText(4096), remoteExecutable: safeText(4096).default('kiki'),
  remoteShell: z.enum(['posix', 'powershell']).default('posix'),
}).strict();
export type SshRemoteProfile = z.infer<typeof sshRemoteProfileSchema>;
export const spacePlatformSchema = /* @__PURE__ */ z.enum(['win32', 'linux', 'darwin']);
export type SpacePlatform = z.infer<typeof spacePlatformSchema>;
export const bridgeOperationSchema = /* @__PURE__ */ z.enum(['read', 'send', 'wait', 'wake', 'create', 'tools']);
export const bridgeOperationsSchema = /* @__PURE__ */ z.array(bridgeOperationSchema).min(1).max(6);
export const sshRemoteTransportSchema = /* @__PURE__ */ z.object({ kind: z.literal('ssh'), profile: sshRemoteProfileSchema }).strict();
export type SshRemoteTransport = z.infer<typeof sshRemoteTransportSchema>;
export const localSpaceTransportSchema = /* @__PURE__ */ z.object({ kind: z.literal('local_space'), localSpaceId: z.string().min(1).max(128) }).strict();
export const peerSocketTransportSchema = /* @__PURE__ */ z.object({ kind: z.literal('peer_socket'), grantId: z.string().uuid() }).strict();
export const connectionTransportSchema = /* @__PURE__ */ z.discriminatedUnion('kind', [sshRemoteTransportSchema, localSpaceTransportSchema, peerSocketTransportSchema]);
export type ConnectionTransportDescriptor = z.infer<typeof connectionTransportSchema>;
export const connectionIdentitySchema = /* @__PURE__ */ z.object({
  homeId: z.string().uuid(), hostId: z.string().min(1).max(128),
  protocol: z.literal(CONNECTION_PROTOCOL),
});
export type ConnectionIdentity = z.infer<typeof connectionIdentitySchema>;
export const connectionGrantSchema = /* @__PURE__ */ z.object({
  id: z.string().uuid(), source: connectionIdentitySchema, target: connectionIdentitySchema,
  purpose: z.literal('gui'), revision: z.number().int().positive(),
  status: z.enum(['invited', 'approved', 'revoked']), label: z.string().max(128),
  createdAt: z.number(), expiresAt: z.number().optional(), lastConnectedAt: z.number().optional(),
  activeLeases: z.number().int().nonnegative(),
  trustTier: peerTrustTierSchema.optional(),
  meshCapabilities: z.array(meshCapabilitySchema).optional(),
});
export type ConnectionGrant = z.infer<typeof connectionGrantSchema>;
export const inboundStatusSchema = /* @__PURE__ */ z.object({ enabled: z.boolean(), configuredEnabled: z.boolean(), unavailableReason: z.literal('dangerous_auth_bypass').optional(), identity: connectionIdentitySchema, grants: z.array(connectionGrantSchema) });
export type InboundStatus = z.infer<typeof inboundStatusSchema>;
export const connectionInviteInputSchema = /* @__PURE__ */ z.object({ source: connectionIdentitySchema, label: z.string().max(128), expiresInMs: z.number().int().min(1000).max(3600000).optional() }).strict();
export const connectionClaimInputSchema = /* @__PURE__ */ z.object({ invitation: z.string().min(32).max(128), source: connectionIdentitySchema }).strict();
export const connectionAddInputSchema = /* @__PURE__ */ z.object({
  label: z.string().min(1).max(128), endpoint: z.string().url().max(2048),
  target: connectionIdentitySchema, ownerToken: z.string().min(1).max(4096),
  invitation: z.string().min(32).max(128), backgroundSummary: z.boolean().default(false),
}).strict();
export type ConnectionAddInput = z.infer<typeof connectionAddInputSchema>;
export const pairCodeCreateInputSchema = /* @__PURE__ */ z.object({
  label: z.string().max(128).optional(),
  expiresInMs: z.number().int().min(60_000).max(3_600_000).default(600_000),
  allowBridge: z.boolean().default(true),
  bridgeOperations: bridgeOperationsSchema.optional(),
  trustTier: peerTrustTierSchema.optional(),
  meshCapabilities: z.array(meshCapabilitySchema).optional(),
}).strict();
export type PairCodeCreateInput = z.infer<typeof pairCodeCreateInputSchema>;
export const pairCodeCreateOutputSchema = /* @__PURE__ */ z.object({
  code: z.string().regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/),
  expiresAt: z.number().int().positive(),
  target: connectionIdentitySchema,
  suggestedEndpoints: z.array(z.string()),
  loopbackEndpoint: z.string().optional(),
  tlsFingerprint: fingerprintSchema.optional(),
  bridgeOperations: bridgeOperationsSchema.optional(),
  trustTier: peerTrustTierSchema.optional(),
  meshCapabilities: z.array(meshCapabilitySchema).optional(),
}).strict();
export type PairCodeCreateOutput = z.infer<typeof pairCodeCreateOutputSchema>;
export const connectionPairInputSchema = /* @__PURE__ */ z.object({
  endpoint: z.string().min(1).max(2048),
  code: z.string().min(8).max(16),
  label: z.string().max(128).optional(),
  backgroundSummary: z.boolean().optional(),
  includeGui: z.boolean().optional(),
  requestBridge: z.boolean().optional(),
  bridgeOperations: bridgeOperationsSchema.optional(),
  borrowTools: z.boolean().optional(),
  fingerprint: fingerprintSchema.optional(),
}).strict().transform((value) => ({
  ...value,
  backgroundSummary: value.includeGui === false ? false : (value.backgroundSummary ?? true),
}));
export type ConnectionPairInput = z.infer<typeof connectionPairInputSchema>;
export type ConnectionPairRequest = z.input<typeof connectionPairInputSchema>;
export const pairClaimInputSchema = /* @__PURE__ */ z.object({
  code: z.string().min(8).max(16),
  source: connectionIdentitySchema,
  sourceLabel: z.string().min(1).max(128),
  requestBridge: z.boolean().optional(),
  bridgeOperations: bridgeOperationsSchema.optional(),
  sourceWorkspaces: z.array(z.string().min(1).max(512)).optional(),
  x25519Recipient: z.string().regex(/^age1[a-z0-9]+$/).optional(),
  includeTrustMetadata: z.boolean().optional(),
}).strict();
export type PairClaimInput = z.infer<typeof pairClaimInputSchema>;

export const connectionTrustUpdateInputSchema = /* @__PURE__ */ z.object({
  trustTier: peerTrustTierSchema,
  meshCapabilities: z.array(meshCapabilitySchema).optional(),
}).strict();
export type ConnectionTrustUpdateInput = z.infer<typeof connectionTrustUpdateInputSchema>;
export const sshConnectionConnectInputSchema = /* @__PURE__ */ z.object({
  profile: sshRemoteProfileSchema,
  label: z.string().max(128).optional(),
  backgroundSummary: z.boolean().default(true),
  bridgeOperations: bridgeOperationsSchema.optional(),
  borrowTools: z.boolean().optional(),
}).strict();
export type SshConnectionConnectInput = z.infer<typeof sshConnectionConnectInputSchema>;
export const connectionProvisionInputSchema = /* @__PURE__ */ z.object({ source: connectionIdentitySchema, target: connectionIdentitySchema, label: z.string().min(1).max(128), enableInbound: z.boolean() }).strict();
export const connectionProvisionResultSchema = /* @__PURE__ */ z.object({ ownerToken: z.string().min(1).max(4096), grant: z.string().min(32).max(128), grantId: z.string().uuid(), revision: z.number().int().positive(), target: connectionIdentitySchema }).strict();
export const sshConnectionRegisterInputSchema = /* @__PURE__ */ z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('gui'), planId: z.string().uuid(), label: z.string().min(1).max(128), enableInbound: z.boolean(), backgroundSummary: z.boolean().default(false) }).strict(),
  z.object({ purpose: z.literal('bridge'), planId: z.string().uuid(), label: z.string().min(1).max(128) }).strict(),
]);
export type SshConnectionRegisterInput = z.infer<typeof sshConnectionRegisterInputSchema>;
export const spaceSummarySchema = /* @__PURE__ */ z.object({
  online: z.literal(true),
  busy_sessions: z.number().int().nonnegative(),
  needs_you_sessions: z.number().int().nonnegative(),
  revision: z.string(),
  as_of: z.number(),
  platform: spacePlatformSchema.optional(),
  arch: z.string().min(1).max(32).optional(),
  hostname: z.string().min(1).max(128).optional(),
  workspace_count: z.number().int().nonnegative().optional(),
  borrowable_tool_count: z.number().int().nonnegative().optional(),
});
export type SpaceSummary = z.infer<typeof spaceSummarySchema>;
export const remoteConnectionSchema = /* @__PURE__ */ z.object({
  id: z.string().uuid(), label: z.string(), endpoint: z.string(), target: connectionIdentitySchema,
  credentialRef: z.string(), enabled: z.boolean(), backgroundSummary: z.boolean(),
  purposes: z.array(z.enum(['gui', 'bridge'])), transport: connectionTransportSchema.optional(),
  state: z.enum(['offline', 'online', 'authentication_required', 'identity_changed', 'disabled']),
  pinnedFingerprint: fingerprintSchema.optional(), fingerprintToVerify: fingerprintSchema.optional(),
  lastError: z.string().optional(), lastConnectedAt: z.number().optional(), activeLeases: z.number().int().nonnegative(),
  rttMs: z.number().int().nonnegative().optional(),
  summary: z.object({ value: spaceSummarySchema, lastSeen: z.number(), stale: z.boolean() }).optional(),
  trustTier: peerTrustTierSchema.optional(),
  meshCapabilities: z.array(meshCapabilitySchema).optional(),
  x25519Recipient: z.string().regex(/^age1[a-z0-9]+$/).optional(),
});
export type RemoteConnection = z.infer<typeof remoteConnectionSchema>;
export const connectionBrokerInputSchema = /* @__PURE__ */ z.object({ operation: z.string().min(1).max(128), params: z.record(z.string(), z.string()).optional(), query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(), headers: z.object({ ifNoneMatch: z.string().max(1024).regex(/^[^\r\n]*$/).optional(), range: z.string().max(128).regex(/^bytes=\d*-\d*$/).optional() }).strict().optional(), body: z.unknown().optional() }).strict();
export type ConnectionBrokerInput = z.infer<typeof connectionBrokerInputSchema>;
export const connectionHandshakeSchema = /* @__PURE__ */ z.object({ identity: connectionIdentitySchema, targetLabel: z.string().max(128).optional(), serverId: z.string(), inboundEnabled: z.boolean(), tlsFingerprint: fingerprintSchema.optional(), platform: spacePlatformSchema.optional(), capabilities: z.array(z.string().min(1).max(64)).max(64).optional(), x25519Recipient: z.string().regex(/^age1[a-z0-9]+$/).optional() });
export type ConnectionHandshake = z.infer<typeof connectionHandshakeSchema>;
