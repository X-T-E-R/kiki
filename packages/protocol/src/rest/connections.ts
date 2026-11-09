import { z } from 'zod';

export const CONNECTION_PROTOCOL = 1;
const safeText = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001F\u007F]+$/);
export const sshRemoteProfileSchema = z.object({
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
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PAIRING_URI_PREFIX = 'kiki://pair';
export function normalizePairingCode(raw: string): string | undefined {
  const compact = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(compact)) return undefined;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}
export function formatPairingUri(input: { readonly endpoint: string; readonly code: string }): string {
  const endpoint = input.endpoint.trim();
  const code = normalizePairingCode(input.code);
  if (endpoint === '' || code === undefined) throw new Error('Invalid pairing URI payload');
  return `${PAIRING_URI_PREFIX}?endpoint=${encodeURIComponent(endpoint)}&code=${encodeURIComponent(code)}`;
}
export function parsePairingUri(raw: string): { readonly endpoint: string; readonly code: string } | undefined {
  const text = raw.trim();
  if (!/^kiki:\/\/\/?pair(?:\?|$)/i.test(text)) return undefined;
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (url.protocol.toLowerCase() !== 'kiki:' || url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '') return undefined;
    if (!((host === 'pair' && (path === '' || path === '/')) || (host === '' && path === '/pair'))) return undefined;
    const endpoint = url.searchParams.get('endpoint')?.trim() ?? '';
    const code = normalizePairingCode(url.searchParams.get('code') ?? '');
    if (endpoint === '' || code === undefined) return undefined;
    return { endpoint, code };
  } catch {
    return undefined;
  }
}
export function isDirectConnectionHost(hostname: string): boolean {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const name = bare.toLowerCase();
  if (name === 'localhost' || name.endsWith('.local') || name.endsWith('.ts.net')) return true;
  if (name === '::1' || name.startsWith('fe80:')) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (match === null) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return false;
  const a = parts[0]!; const b = parts[1]!;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}
export const pairCodeCreateInputSchema = z.object({
  label: z.string().max(128).optional(),
  expiresInMs: z.number().int().min(60_000).max(3_600_000).default(600_000),
  allowBridge: z.boolean().default(true),
}).strict();
export type PairCodeCreateInput = z.infer<typeof pairCodeCreateInputSchema>;
export const pairCodeCreateOutputSchema = z.object({
  code: z.string().regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/),
  expiresAt: z.number().int().positive(),
  target: connectionIdentitySchema,
  suggestedEndpoints: z.array(z.string()),
}).strict();
export type PairCodeCreateOutput = z.infer<typeof pairCodeCreateOutputSchema>;
export const connectionPairInputSchema = z.object({
  endpoint: z.string().min(1).max(2048),
  code: z.string().min(8).max(16),
  label: z.string().max(128).optional(),
  backgroundSummary: z.boolean().default(true),
}).strict();
export type ConnectionPairInput = z.infer<typeof connectionPairInputSchema>;
export const pairClaimInputSchema = z.object({
  code: z.string().min(8).max(16),
  source: connectionIdentitySchema,
  sourceLabel: z.string().min(1).max(128),
  requestBridge: z.boolean().optional(),
  sourceWorkspaces: z.array(z.string().min(1).max(512)).max(64).optional(),
}).strict();
export type PairClaimInput = z.infer<typeof pairClaimInputSchema>;
export const sshConnectionConnectInputSchema = z.object({
  profile: sshRemoteProfileSchema,
  label: z.string().max(128).optional(),
  backgroundSummary: z.boolean().default(true),
}).strict();
export type SshConnectionConnectInput = z.infer<typeof sshConnectionConnectInputSchema>;
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
export const connectionHandshakeSchema = z.object({ identity: connectionIdentitySchema, targetLabel: z.string().max(128).optional(), serverId: z.string(), inboundEnabled: z.boolean() });
export type ConnectionHandshake = z.infer<typeof connectionHandshakeSchema>;
