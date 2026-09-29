import { z } from 'zod';

export const worktreeInspectionSchema = z.object({
  inspectedAt: z.number(), failed: z.boolean(), dirtyFiles: z.number(), untrackedFiles: z.number(),
  aheadOfBase: z.number(), unpushedCommits: z.number(), ignoredNonDisposable: z.array(z.string()), foreignLock: z.string().optional(),
});

export const worktreeRemovalOutcomeSchema = z.enum([
  'removed', 'retained_dirty', 'retained_unpushed', 'retained_ignored', 'retained_foreign_lock',
  'retained_unowned', 'retained_in_use', 'failed_busy', 'failed',
]);

export const worktreeRecordSchema = z.object({
  id: z.string(), version: z.literal(1),
  repo: z.object({ fingerprint: z.string(), commonDir: z.string(), sourceRoot: z.string(), workspaceId: z.string() }),
  path: z.string(), branch: z.string(), branchCreated: z.boolean(),
  base: z.object({ mode: z.enum(['head', 'fresh', 'ref']), ref: z.string(), commit: z.string() }),
  owner: z.object({ kind: z.literal('session'), sessionId: z.string() }),
  state: z.enum(['creating', 'ready', 'removing', 'remove_failed', 'removed', 'orphaned']),
  lastInspection: worktreeInspectionSchema.optional(),
  removal: z.object({ requestedAt: z.number(), trigger: z.enum(['user', 'gc']), outcome: worktreeRemovalOutcomeSchema }).optional(),
  createdAt: z.number(), updatedAt: z.number(),
});

export const worktreeRemoveRequestSchema = z.object({
  confirmLoss: z.object({ dirty: z.boolean(), ignored: z.boolean(), unpushed: z.boolean() }).optional(),
  deleteBranch: z.boolean().optional(),
});

export type WorktreeRecord = z.infer<typeof worktreeRecordSchema>;
export type WorktreeInspection = z.infer<typeof worktreeInspectionSchema>;
export type WorktreeRemovalOutcome = z.infer<typeof worktreeRemovalOutcomeSchema>;
export type WorktreeRemoveRequest = z.infer<typeof worktreeRemoveRequestSchema>;
