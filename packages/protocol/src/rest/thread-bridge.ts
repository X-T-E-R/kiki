import { z } from 'zod';
import { connectionIdentitySchema } from './connections';
import { contentRefSchema } from '@kiki/transcript';

export const bridgeThreadRefSchema = z.object({ hostId: z.string().min(1).max(256), workspaceId: z.string().min(1).max(512), sessionId: z.string().min(1).max(256) }).strict();
export const bridgeScopeSchema = z.object({ workspaceId: z.string().min(1).max(512), sessionId: z.string().min(1).max(256).optional() }).strict();
export const bridgePolicySchema = z.object({
  source: connectionIdentitySchema, target: connectionIdentitySchema,
  sourceScope: bridgeScopeSchema, targetScope: bridgeScopeSchema,
  operations: z.array(z.enum(['read', 'send', 'wait', 'wake'])).min(1).max(4),
  expiresAt: z.number().int().positive(), pendingLimit: z.number().int().min(1).max(100).default(20),
  messagesPerMinute: z.number().int().min(1).max(600).default(10),
  location: z.enum(['local', 'network']), label: z.string().min(1).max(128),
}).strict();
export const bridgeGrantSchema = bridgePolicySchema.extend({ id: z.string().uuid(), revision: z.number().int().positive(), enabled: z.boolean(), revoked: z.boolean(), createdAt: z.number().int().positive() });
export const bridgeInstallSchema = z.object({ connectionId: z.string().uuid(), grant: bridgeGrantSchema, credential: z.string().min(32).max(128) }).strict();
export const bridgeRequestSchema = z.object({ bridgeId: z.string().uuid(), revision: z.number().int().positive(), source: bridgeThreadRefSchema }).strict();
export const bridgeListSchema = bridgeRequestSchema.extend({ workspaceId: z.string().min(1).max(512).optional(), cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
export const bridgeReadSchema = bridgeRequestSchema.extend({ target: bridgeThreadRefSchema, cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(100).optional(), contentRef: contentRefSchema.optional() }).strict();
export const bridgeSendSchema = bridgeRequestSchema.extend({
  target: bridgeThreadRefSchema, content: z.string().min(1).max(100000), idempotencyKey: z.string().min(1).max(256),
  sourceHomeId: z.string().uuid(), targetHomeId: z.string().uuid(),
  createdAt: z.number().int().positive(), expiresAt: z.number().int().positive(), sourceSeq: z.number().int().positive(),
  causeId: z.string().min(1).max(128), hop: z.number().int().min(0).max(4),
}).strict();
export const bridgeWaitSchema = bridgeRequestSchema.extend({ target: bridgeThreadRefSchema, cursor: z.string().max(4096).optional(), timeoutMs: z.number().int().min(0).max(60000).optional() }).strict();
export type BridgePolicy = z.infer<typeof bridgePolicySchema>;
export type BridgeGrant = z.infer<typeof bridgeGrantSchema>;
export type BridgeInstall = z.infer<typeof bridgeInstallSchema>;
export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;
export type BridgeSend = z.infer<typeof bridgeSendSchema>;
export type BridgeOperation = 'read' | 'send' | 'wait' | 'wake';
export interface BridgeLink { connectionId: string; grant: BridgeGrant; enabled: boolean }
export interface BridgeReceipt { id: string; bridgeId: string; connectionId: string; source: z.infer<typeof bridgeThreadRefSchema>; target: z.infer<typeof bridgeThreadRefSchema>; sourceSeq: number; createdAt: number; expiresAt: number; delivery: 'accepted' | 'delivered' | 'pending' | 'rejected' | 'undeliverable'; messageId?: string; targetSeq?: number; acceptedAt?: number; reason?: string }
export interface BridgeStatus { identity: z.infer<typeof connectionIdentitySchema>; inboundEnabled: boolean; inbound: BridgeGrant[]; outbound: BridgeLink[] }
export type BridgeContentRef = import('@kiki/transcript').ContentRef;
export interface BridgeReadView { transcript?: import('@kiki/transcript').TranscriptResponse; segment?: import('@kiki/transcript').ContentSegment }
export const localBridgePolicySchema = bridgePolicySchema.omit({ source: true, target: true, location: true }).extend({ spaceId: z.string().min(1).max(128) }).strict();
export type LocalBridgePolicy = z.infer<typeof localBridgePolicySchema>;
export const bridgeTargetInputSchema = z.object({ label: z.string().min(1).max(128), endpoint: z.string().url().max(2048), target: connectionIdentitySchema }).strict();
export type BridgeTargetInput = z.infer<typeof bridgeTargetInputSchema>;
