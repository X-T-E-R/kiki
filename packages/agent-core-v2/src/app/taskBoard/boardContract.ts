import { z } from 'zod';
import { BoardStorageConfigSchema } from './storageConfig';

export const BoardStatusSchema = z.enum(['active', 'in_progress', 'paused', 'done', 'cancelled', 'superseded']);
export type BoardStatus = z.infer<typeof BoardStatusSchema>;
const identity = z.string().min(1).max(512);
const root = z.string().min(1).max(4096);
const links = z.array(identity).max(256);
export const BoardStorageRefSchema = z.strictObject({ root, storageId: identity, kind: z.enum(['workspace', 'embedded']) });
export const BoardCreateTargetSchema = z.strictObject({ root, storageId: identity.optional(), kind: z.enum(['workspace', 'embedded']) });
export const BoardPatchSchema = z.strictObject({
  title: z.string().trim().min(1).max(1000).optional(),
  description: z.string().max(100_000).optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  category: z.string().max(256).optional(),
  sessionIds: links.optional(),
  executionIds: links.optional(),
  status: BoardStatusSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, 'An update requires a changed field.');
export type BoardPatch = z.infer<typeof BoardPatchSchema>;
export const BoardReadSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('preview'), workspaceId: identity.optional(), configuration: BoardStorageConfigSchema.optional() }),
  z.strictObject({
    action: z.literal('list'), workspaceId: identity.optional(), storage: BoardStorageRefSchema.optional(),
    sessionId: identity.optional(), status: BoardStatusSchema.optional(), archived: z.boolean().optional(),
    cursor: identity.optional(), limit: z.number().int().min(1).max(100).optional(),
  }),
  z.strictObject({ action: z.literal('show'), workspaceId: identity, storage: BoardStorageRefSchema, id: identity }),
  z.strictObject({ action: z.literal('overview'), workspaceIds: z.array(identity).min(1).max(32), status: BoardStatusSchema.optional(), limit: z.number().int().min(1).max(100).optional() }),
]);
export const BoardWriteSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create'), workspaceId: identity.optional(), requestKey: identity,
    target: BoardCreateTargetSchema.optional(), title: z.string().trim().min(1).max(1000),
    description: z.string().max(100_000).optional(), priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
    category: z.string().max(256).optional(), sessionIds: links.optional(), executionIds: links.optional(),
  }),
  z.strictObject({ action: z.literal('update'), workspaceId: identity, storage: BoardStorageRefSchema, id: identity, expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), patch: BoardPatchSchema }),
]);
export type BoardReadInput = z.infer<typeof BoardReadSchema>;
export type BoardWriteInput = z.infer<typeof BoardWriteSchema>;
export type BoardStorageRef = z.infer<typeof BoardStorageRefSchema>;

export interface BoardSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly storage: BoardStorageRef;
  readonly title: string;
  readonly priority: string;
  readonly status: BoardStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly archived: boolean;
  readonly category: string;
  readonly sessionIds: readonly string[];
  readonly executionIds: readonly string[];
}
export interface BoardCard extends BoardSummary {
  readonly description: string;
  readonly prd: string;
  readonly handoff?: string;
}
export interface BoardIssue { readonly code: string; readonly message: string }
export type BoardResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BoardIssue };
export interface BoardPage {
  readonly workspaceId: string;
  readonly storage?: BoardStorageRef;
  readonly cards: readonly BoardSummary[];
  readonly issues: readonly BoardIssue[];
  readonly nextCursor?: string;
}
export interface BoardStoragePreview {
  readonly mode: 'auto' | 'global' | 'fixed';
  readonly workspaceId: string;
  readonly root: string;
  readonly tasksDirectory: string;
  readonly existing: boolean;
  readonly kind: 'workspace' | 'embedded';
  readonly storageId?: string;
  readonly selectionOnly: true;
}
export interface BoardOverviewEntry { readonly workspaceId: string; readonly result: BoardResult<BoardPage> }
export type BoardReadValue = BoardCard | BoardPage | BoardStoragePreview | readonly BoardOverviewEntry[];
export interface BoardClient {
  read(input: BoardReadInput): Promise<BoardResult<BoardReadValue>>;
  write(input: BoardWriteInput): Promise<BoardResult<BoardCard>>;
}
export const ownWorkBoardCapabilities = Object.freeze({ create: true, read: true, editDetails: true, associations: true, idempotentCreate: true, reopenTerminal: false });
