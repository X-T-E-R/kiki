import { z } from 'zod';

import { isoDateTimeSchema } from './time';

export const fsKindSchema = /* @__PURE__ */ z.enum(['file', 'directory', 'symlink']);
export type FsKind = z.infer<typeof fsKindSchema>;

export const fsGitStatusSchema = /* @__PURE__ */ z.enum([
  'clean',
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked',
  'ignored',
  'conflicted',
]);
export type FsGitStatus = z.infer<typeof fsGitStatusSchema>;

export const fsEntrySchema = /* @__PURE__ */ z.object({
  path: z.string(),
  name: z.string(),
  kind: fsKindSchema,
  size: z.number().int().nonnegative().optional(),
  modified_at: isoDateTimeSchema,
  etag: z.string().optional(),
  mime: z.string().optional(),
  language_id: z.string().optional(),
  is_binary: z.boolean().optional(),
  is_symlink_to: z.string().optional(),
  git_status: fsGitStatusSchema.optional(),
  child_count: z.number().int().nonnegative().optional(),
});
export type FsEntry = z.infer<typeof fsEntrySchema>;

export const fsSearchHitSchema = /* @__PURE__ */ z.object({
  path: z.string(),
  name: z.string(),
  kind: fsKindSchema,
  score: z.number().min(0).max(1),
  match_positions: z.array(z.number().int().nonnegative()),
});
export type FsSearchHit = z.infer<typeof fsSearchHitSchema>;

export const fsSuggestItemSchema = /* @__PURE__ */ z.object({
  path: z.string(),
  name: z.string(),
  kind: fsKindSchema,
  score: z.number().min(0).max(1),
  match_positions: z.array(z.number().int().nonnegative()),
});
export type FsSuggestItem = z.infer<typeof fsSuggestItemSchema>;

export const fsGrepMatchSchema = /* @__PURE__ */ z.object({
  line: z.number().int().positive(),
  col: z.number().int().positive(),
  text: z.string(),
  before: z.array(z.string()),
  after: z.array(z.string()),
});
export type FsGrepMatch = z.infer<typeof fsGrepMatchSchema>;

export const fsGrepFileHitSchema = /* @__PURE__ */ z.object({
  path: z.string(),
  matches: z.array(fsGrepMatchSchema),
});
export type FsGrepFileHit = z.infer<typeof fsGrepFileHitSchema>;

export const fsGitStatusEntrySchema = /* @__PURE__ */ z.object({
  path: z.string(),
  status: fsGitStatusSchema,
  rename_from: z.string().optional(),
});
export type FsGitStatusEntry = z.infer<typeof fsGitStatusEntrySchema>;

export const fsChangeKindSchema = /* @__PURE__ */ z.enum(['file', 'directory', 'symlink']);
export type FsChangeKind = z.infer<typeof fsChangeKindSchema>;

export const fsChangeActionSchema = /* @__PURE__ */ z.enum(['created', 'modified', 'deleted']);
export type FsChangeAction = z.infer<typeof fsChangeActionSchema>;

export const fsChangeEntrySchema = /* @__PURE__ */ z.object({
  path: z.string(),
  change: fsChangeActionSchema,
  kind: fsChangeKindSchema,
  size_delta: z.number().int().optional(),
  etag: z.string().optional(),
});
export type FsChangeEntry = z.infer<typeof fsChangeEntrySchema>;

export const fsChangeEventSchema = /* @__PURE__ */ z.object({
  changes: z.array(fsChangeEntrySchema),
  coalesced_window_ms: z.number().int().positive(),
  truncated: z.boolean().optional(),
  count: z.number().int().nonnegative().optional(),
});
export type FsChangeEvent = z.infer<typeof fsChangeEventSchema>;
