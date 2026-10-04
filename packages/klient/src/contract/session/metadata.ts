/**
 * `sessionMetadata` — typed session metadata. Mirrors
 * `agent-core-v2/session/sessionMetadata/sessionMetadata.ts`. The `ready`
 * promise property is excluded (not a wire method).
 */

import { z } from 'zod';

import { tokenUsageSchema } from '../agent/schemas.js';
import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const negotiatedExecutorSchema = z.object({
  agentVersion: z.string().optional(), image: z.boolean().optional(), audio: z.boolean().optional(),
  fork: z.boolean().optional(), nativeSteering: z.boolean().optional(), questionForm: z.boolean().optional(),
  planApproval: z.boolean().optional(), models: z.array(z.string()).optional(),
  thinkingLevels: z.array(z.string()).optional(), authMethods: z.array(z.string()).optional(),
  resume: z.boolean().optional(), load: z.boolean().optional(), permissionModes: z.array(z.string()).optional(),
});

export const agentMetaSchema = z.object({
  homedir: z.string().optional(),
  type: z.enum(['main', 'sub', 'independent']).optional(),
  parentAgentId: z.union([z.string(), z.null()]).optional(),
  delegator: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('agent'), agentId: z.string() }),
    z.object({ kind: z.literal('external'), delegationId: z.string() }),
  ]).optional(),
  forkedFrom: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  displayName: z.string().optional(),
  userLabel: z.string().optional(),
  model: z.string().optional(),
  thinkingEffort: z.string().optional(),
  executor: z.string().optional(),
  executorProtocol: z.string().optional(),
  negotiated: negotiatedExecutorSchema.optional(),
  allowKikiSubagents: z.boolean().optional(),
  status: z.enum(['completed', 'failed', 'cancelled']).optional(),
  completedAt: z.number().optional(),
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  usage: tokenUsageSchema.optional(),
  contextTokens: z.number().optional(),
  toolCallCount: z.number().int().nonnegative().optional(),
});

const sessionWorktreeSchema = z.object({
  worktreeId: z.string(), branch: z.string(), sourceRoot: z.string(), baseRef: z.string(),
});

export const sessionMetaSchema = z.object({
  id: z.string(),
  version: z.number().optional(),
  title: z.string().optional(),
  titleKind: z.enum(['replaceable', 'generated', 'custom']).optional(),
  lastPrompt: z.string().optional(),
  delivery: z.enum(['reply', 'message']).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archived: z.boolean(),
  archivedAt: z.number().optional(),
  cwd: z.string().optional(),
  worktree: sessionWorktreeSchema.optional(),
  forkedFrom: z.string().optional(),
  agents: z.record(z.string(), agentMetaSchema).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  sshHosts: z.record(z.string(), z.string()).optional(),
  lastTurnReason: z.enum(['completed', 'cancelled', 'failed']).optional(),
});

/** `Partial<Omit<SessionMeta, 'id' | 'createdAt'>>` — every key optional. */
export const sessionMetaPatchSchema = z.object({
  version: z.number().optional(),
  title: z.string().optional(),
  titleKind: z.enum(['replaceable', 'generated', 'custom']).optional(),
  lastPrompt: z.string().optional(),
  delivery: z.enum(['reply', 'message']).optional(),
  updatedAt: z.number().optional(),
  archived: z.boolean().optional(),
  archivedAt: z.number().optional(),
  cwd: z.string().optional(),
  worktree: sessionWorktreeSchema.optional(),
  forkedFrom: z.string().optional(),
  agents: z.record(z.string(), agentMetaSchema).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  sshHosts: z.record(z.string(), z.string()).optional(),
  lastTurnReason: z.enum(['completed', 'cancelled', 'failed']).optional(),
});

/** `keyof SessionMeta` — keep in sync with `sessionMetaSchema`. */
export const sessionMetaKeySchema = z.enum([
  'id',
  'version',
  'title',
  'titleKind',
  'lastPrompt',
  'delivery',
  'createdAt',
  'updatedAt',
  'archived',
  'archivedAt',
  'cwd',
  'worktree',
  'forkedFrom',
  'agents',
  'custom',
  'sshHosts',
  'lastTurnReason',
  'usage',
]);

export const sessionMetadataChangedEventSchema = z.object({
  changed: z.array(sessionMetaKeySchema),
});

export const sessionMetadataContract = {
  read: { input: z.tuple([]), output: sessionMetaSchema },
  update: { input: z.tuple([sessionMetaPatchSchema]), output: noResult },
  setTitle: { input: z.tuple([z.string()]), output: noResult },
  setArchived: { input: z.tuple([z.boolean()]), output: noResult },
  registerAgent: { input: z.tuple([z.string(), agentMetaSchema]), output: noResult },
} satisfies ServiceContract;
