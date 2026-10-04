import { z } from 'zod';

export const CONNECTION_PROTOCOL = 1;
const safeText = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001F\u007F]+$/);
export const sshRemoteProfileSchema = z.object({
  id: safeText(80).regex(/^[a-zA-Z0-9_-]+$/), label: safeText(100),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('alias'), alias: safeText(255).regex(/^[^-\s][^\s]*$/) }).strict(),
    z.object({ kind: z.literal('host'), hostname: safeText(255).regex(/^[a-zA-Z0-9.:_][a-zA-Z0-9.\-:_]*$/), username: safeText(64).regex(/^[a-zA-Z0-9_.][a-zA-Z0-9._-]*$/).optional(), port: z.number().int().min(1).max(65535).optional() }).strict(),
  ]),
  identityFile: safeText(4096).optional(), releaseChannel: z.enum(['stable', 'beta']),
  remoteHome: safeText(4096), remoteExecutable: safeText(4096).default('kiki'),
  remoteShell: z.enum(['posix', 'powershell']).default('posix'),
}).strict();
export type SshRemoteProfile = z.infer<typeof sshRemoteProfileSchema>;
export const sshRemoteTransportSchema = z.object({ kind: z.literal('ssh'), profile: sshRemoteProfileSchema }).strict();
export type SshRemoteTransport = z.infer<typeof sshRemoteTransportSchema>;
export const localSpaceTransportSchema = z.object({ kind: z.literal('local_space'), localSpaceId: z.string().min(1).max(128) }).strict();
export const connectionTransportSchema = z.discriminatedUnion('kind', [sshRemoteTransportSchema, localSpaceTransportSchema]);
export type ConnectionTransportDescriptor = z.infer<typeof connectionTransportSchema>;
export const connectionIdentitySchema = z.object({
  homeId: z.string().uuid(), hostId: z.string().min(1).max(128),
  protocol: z.literal(CONNECTION_PROTOCOL),
});
export type ConnectionIdentity = z.infer<typeof connectionIdentitySchema>;
export const connectionGrantSchema = z.object({
  id: z.string().uuid(), source: connectionIdentitySchema, target: connectionIdentitySchema,
  purpose: z.literal('gui'), revision: z.number().int().positive(),
  status: z.enum(['invited', 'approved', 'revoked']), label: z.string().max(128),
  createdAt: z.number(), expiresAt: z.number().optional(), lastConnectedAt: z.number().optional(),
  activeLeases: z.number().int().nonnegative(),
});
export type ConnectionGrant = z.infer<typeof connectionGrantSchema>;
export const inboundStatusSchema = z.object({ enabled: z.boolean(), configuredEnabled: z.boolean(), unavailableReason: z.literal('dangerous_auth_bypass').optional(), identity: connectionIdentitySchema, grants: z.array(connectionGrantSchema) });
export type InboundStatus = z.infer<typeof inboundStatusSchema>;
export const connectionInviteInputSchema = z.object({ source: connectionIdentitySchema, label: z.string().max(128), expiresInMs: z.number().int().min(1000).max(3600000).optional() }).strict();
export const connectionClaimInputSchema = z.object({ invitation: z.string().min(32).max(128), source: connectionIdentitySchema }).strict();
export const connectionAddInputSchema = z.object({
  label: z.string().min(1).max(128), endpoint: z.string().url().max(2048),
  target: connectionIdentitySchema, ownerToken: z.string().min(1).max(4096),
  invitation: z.string().min(32).max(128), backgroundSummary: z.boolean().default(false),
}).strict();
export type ConnectionAddInput = z.infer<typeof connectionAddInputSchema>;
export const connectionProvisionInputSchema = z.object({ source: connectionIdentitySchema, target: connectionIdentitySchema, label: z.string().min(1).max(128), enableInbound: z.boolean() }).strict();
export const connectionProvisionResultSchema = z.object({ ownerToken: z.string().min(1).max(4096), grant: z.string().min(32).max(128), grantId: z.string().uuid(), revision: z.number().int().positive(), target: connectionIdentitySchema }).strict();
export const sshConnectionRegisterInputSchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('gui'), planId: z.string().uuid(), label: z.string().min(1).max(128), enableInbound: z.boolean(), backgroundSummary: z.boolean().default(false) }).strict(),
  z.object({ purpose: z.literal('bridge'), planId: z.string().uuid(), label: z.string().min(1).max(128) }).strict(),
]);
export type SshConnectionRegisterInput = z.infer<typeof sshConnectionRegisterInputSchema>;
export const spaceSummarySchema = z.object({ online: z.literal(true), busy_sessions: z.number().int().nonnegative(), needs_you_sessions: z.number().int().nonnegative(), revision: z.string(), as_of: z.number() });
export type SpaceSummary = z.infer<typeof spaceSummarySchema>;
export const remoteConnectionSchema = z.object({
  id: z.string().uuid(), label: z.string(), endpoint: z.string(), target: connectionIdentitySchema,
  credentialRef: z.string(), enabled: z.boolean(), backgroundSummary: z.boolean(),
  purposes: z.array(z.enum(['gui', 'bridge'])), transport: connectionTransportSchema.optional(),
  state: z.enum(['offline', 'online', 'authentication_required', 'identity_changed', 'disabled']),
  lastError: z.string().optional(), lastConnectedAt: z.number().optional(), activeLeases: z.number().int().nonnegative(),
  summary: z.object({ value: spaceSummarySchema, lastSeen: z.number(), stale: z.boolean() }).optional(),
});
export type RemoteConnection = z.infer<typeof remoteConnectionSchema>;
export const connectionBrokerInputSchema = z.object({ operation: z.string().min(1).max(128), params: z.record(z.string(), z.string()).optional(), query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(), headers: z.object({ ifNoneMatch: z.string().max(1024).regex(/^[^\r\n]*$/).optional(), range: z.string().max(128).regex(/^bytes=\d*-\d*$/).optional() }).strict().optional(), body: z.unknown().optional() }).strict();
export type ConnectionBrokerInput = z.infer<typeof connectionBrokerInputSchema>;
export const connectionHandshakeSchema = z.object({ identity: connectionIdentitySchema, serverId: z.string(), inboundEnabled: z.boolean() });
export type ConnectionHandshake = z.infer<typeof connectionHandshakeSchema>;
