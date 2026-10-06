import { z } from 'zod';

export const memoryScopeKindSchema = z.enum(['global', 'workspace', 'persona', 'persona_workspace']);
export const memoryTypeSchema = z.enum(['user', 'feedback', 'project', 'reference']);
export const memoryStatusSchema = z.enum(['active', 'pending', 'superseded', 'archived']);
export const memoryOwnerScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({ kind: z.literal('workspace'), workspaceId: z.string() }),
  z.object({ kind: z.literal('persona'), personaId: z.string() }),
  z.object({ kind: z.literal('persona_workspace'), workspaceId: z.string(), personaId: z.string() }),
]);
export const memoryBasisSchema = z.object({ kind: z.enum(['human', 'observed', 'derived', 'unknown']), note: z.string().min(1).max(500), refs: z.array(z.string().min(1).max(500)).max(8).optional() }).strict();
export const memoryValiditySchema = z.object({ check: z.string().min(1).max(300), until: z.string().datetime({ offset: true }).optional() }).strict();
export const memoryCoveredBySchema = z.object({ id: z.string(), revision: z.string() });
export const memoryTargetSchema = z.object({ scope: memoryScopeKindSchema, id: z.string(), expected_revision: z.string() });
export const memoryEntrySchema = z.object({
  id: z.string(), type: memoryTypeSchema, title: z.string(), body: z.string(), status: memoryStatusSchema, pinned: z.boolean(),
  created: z.string(), updated: z.string(), source: z.object({ writer: z.enum(['user', 'agent', 'consolidator', 'import']), session: z.string().optional(), turn: z.number().optional(), step: z.string().optional() }),
  reason: z.string(), revision: z.string(), superseded_by: z.string().optional(), supersedes: z.string().optional(), supersedes_revision: z.string().optional(), pending_action: z.enum(['update', 'archive']).optional(),
  basis: memoryBasisSchema.optional(), validity: memoryValiditySchema.optional(), covered_by: memoryCoveredBySchema.optional(),
  scope: memoryOwnerScopeSchema.optional(), target: memoryTargetSchema.optional(), applicability: z.enum(['expired', 'recheck', 'unrecorded']).optional(), complete: z.boolean().optional(),
});
export const memoryPutBodySchema = z.object({
  action: z.enum(['create', 'update', 'supersede', 'archive']).optional(), type: memoryTypeSchema.optional(), title: z.string().min(1).max(200).optional(), body: z.string().min(1).max(1_500).optional(),
  reason: z.string().min(1), expected_revision: z.string().optional(), pinned: z.boolean().optional(), basis: memoryBasisSchema.optional(), validity: memoryValiditySchema.nullable().optional(),
  covered_by: z.object({ id: z.string(), expected_revision: z.string() }).strict().optional(),
}).strict();
export const memoryPutResultSchema = z.object({ entry: memoryEntrySchema, operationId: z.string().nullable(), outcome: z.enum(['applied', 'pending', 'unchanged']), warnings: z.array(z.string()).optional() });
export const memoryCoverageSchema = z.object({ scopes: z.array(memoryOwnerScopeSchema), statuses: z.array(memoryStatusSchema), exhausted: z.boolean(), complete: z.boolean(), warnings: z.array(z.string()) });
export const memoryListResponseSchema = z.object({ items: z.array(memoryEntrySchema.extend({ score: z.number().optional() })), mode: z.enum(['search', 'list']).optional(), next_cursor: z.string().nullable().optional(), coverage: memoryCoverageSchema.optional() });
export const memoryJournalRecordSchema = z.object({ operationId: z.string(), action: z.string(), id: z.string(), at: z.string(), writer: z.enum(['user', 'agent', 'consolidator', 'import']), before: z.string().nullable(), beforeRevision: z.string().nullable(), afterRevision: z.string().nullable() });
export type MemoryRestTarget = { readonly scope: z.infer<typeof memoryScopeKindSchema>; readonly workspaceId?: string; readonly personaId?: string };
export type MemoryRestListQuery = { readonly query?: string; readonly type?: z.infer<typeof memoryTypeSchema>; readonly include_inactive?: boolean; readonly mode?: 'search' | 'list'; readonly statuses?: readonly z.infer<typeof memoryStatusSchema>[]; readonly page_size?: number; readonly cursor?: string };
export type MemoryRestEntry = z.infer<typeof memoryEntrySchema>;
export type MemoryRestPutBody = z.infer<typeof memoryPutBodySchema>;
export type MemoryRestPutResult = z.infer<typeof memoryPutResultSchema>;
export type MemoryRestListResponse = z.infer<typeof memoryListResponseSchema>;
export type MemoryRestJournalRecord = z.infer<typeof memoryJournalRecordSchema>;
