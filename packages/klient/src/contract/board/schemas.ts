import { z } from 'zod';
import type { ServiceContract } from '../types.js';

const identity = z.string().min(1).max(512);
const root = z.string().min(1).max(4096);
const links = z.array(identity).max(256);
export const boardStatusSchema = z.enum(['active', 'in_progress', 'paused', 'done', 'cancelled', 'superseded']);
export const boardStorageRefSchema = z.strictObject({ root, storageId: identity, kind: z.enum(['workspace', 'embedded']) });
const target = z.strictObject({ root, storageId: identity.optional(), kind: z.enum(['workspace', 'embedded']) });
const configuration = z.strictObject({ mode: z.enum(['auto', 'global', 'fixed']), path: z.string().trim().max(4096).refine((value) => !/[\u0000-\u001F]/u.test(value), 'Storage path contains control characters.').optional() })
  .refine((value) => value.mode !== 'fixed' || !!value.path, { message: 'Fixed storage requires a path.', path: ['path'] });
const patch = z.strictObject({
  title: z.string().trim().min(1).max(1000).optional(), description: z.string().max(100_000).optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(), category: z.string().max(256).optional(),
  sessionIds: links.optional(), executionIds: links.optional(), status: boardStatusSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, 'An update requires a changed field.');
export const boardReadSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('preview'), workspaceId: identity.optional(), configuration: configuration.optional() }),
  z.strictObject({ action: z.literal('list'), workspaceId: identity.optional(), storage: boardStorageRefSchema.optional(), sessionId: identity.optional(), status: boardStatusSchema.optional(), archived: z.boolean().optional(), cursor: identity.optional(), limit: z.number().int().min(1).max(100).optional() }),
  z.strictObject({ action: z.literal('show'), workspaceId: identity, storage: boardStorageRefSchema, id: identity }),
  z.strictObject({ action: z.literal('overview'), workspaceIds: z.array(identity).min(1).max(32), status: boardStatusSchema.optional(), limit: z.number().int().min(1).max(100).optional() }),
]);
export const boardWriteSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), workspaceId: identity.optional(), requestKey: identity, target: target.optional(), title: z.string().trim().min(1).max(1000), description: z.string().max(100_000).optional(), priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(), category: z.string().max(256).optional(), sessionIds: links.optional(), executionIds: links.optional() }),
  z.strictObject({ action: z.literal('update'), workspaceId: identity, storage: boardStorageRefSchema, id: identity, expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), patch }),
]);
const summary = z.object({
  id: identity, workspaceId: identity, storage: boardStorageRefSchema, title: z.string(), priority: z.string(), status: boardStatusSchema,
  revision: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string(), completedAt: z.string().nullable(),
  archived: z.boolean(), category: z.string(), sessionIds: z.array(z.string()), executionIds: z.array(z.string()),
});
const card = summary.extend({ description: z.string(), prd: z.string(), handoff: z.string().optional() });
const issue = z.object({ code: z.string(), message: z.string() });
const result = <T extends z.ZodType>(value: T) => z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value }), z.object({ ok: z.literal(false), error: issue })]);
const page = z.object({ workspaceId: identity, storage: boardStorageRefSchema.optional(), cards: z.array(summary), issues: z.array(issue), nextCursor: z.string().optional() });
const preview = z.object({ mode: z.enum(['auto', 'global', 'fixed']), workspaceId: identity, root, tasksDirectory: z.string(), existing: z.boolean(), kind: z.enum(['workspace', 'embedded']), storageId: identity.optional(), selectionOnly: z.literal(true) });
const overviewEntry = z.object({ workspaceId: identity, result: result(page) });
export const boardReadResultSchema = result(z.union([card, page, preview, z.array(overviewEntry)]));
export const boardWriteResultSchema = result(card);
export const boardOverviewResultSchema = result(z.array(overviewEntry));
export const boardContract = {
  read: { input: z.tuple([boardReadSchema]), output: boardReadResultSchema },
  write: { input: z.tuple([boardWriteSchema]), output: boardWriteResultSchema },
  overview: { input: z.tuple([]), output: boardOverviewResultSchema },
} satisfies ServiceContract;
