import { z } from 'zod';

import { isoDateTimeSchema } from './time';

export const workspaceIdSchema = z
  .string()
  .regex(/^wd_[a-z0-9._-]+_[0-9a-f]{12}$/, {
    message: 'workspace_id must be a wd_<slug>_<hash12> string',
  });

export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

export const workspaceSchema = z.object({
  id: workspaceIdSchema,
  root: z.string().min(1),
  name: z.string().min(1).max(100),
  created_at: isoDateTimeSchema,
  last_opened_at: isoDateTimeSchema,
  session_count: z.number().int().nonnegative(),
  pinned: z.boolean(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceCreateSchema = z.object({
  root: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
});

export type WorkspaceCreate = z.infer<typeof workspaceCreateSchema>;

/** Both fields are optional so a client can rename, pin, or do both in one
 * PATCH; an entirely empty body is rejected rather than treated as a no-op. */
export const workspaceUpdateSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((patch) => patch.name !== undefined || patch.pinned !== undefined, {
    message: 'provide at least one of name or pinned',
  });

export type WorkspaceUpdate = z.infer<typeof workspaceUpdateSchema>;
