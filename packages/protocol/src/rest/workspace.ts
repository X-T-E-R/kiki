import { z } from 'zod';

import {
  workspaceCreateSchema,
  workspaceCatalogEntrySchema,
  workspaceIdSchema,
  workspaceSchema,
  workspaceUpdateSchema,
} from '../workspace';

export const listWorkspacesResponseSchema = /* @__PURE__ */ z.object({
  items: z.array(workspaceSchema),
});
export type ListWorkspacesResponse = z.infer<typeof listWorkspacesResponseSchema>;

/**
 * GET /api/workspaces?view=catalog reads persisted registration metadata only.
 * PATCH /api/workspaces/{workspace_id}?view=catalog returns the changed metadata
 * without discovery, session counting or Git inspection. Omitting view preserves
 * the full Workspace response; GET /api/workspaces/{workspace_id} reads one
 * registered workspace with measured details. Unknown registered IDs return 40410.
 */
export const workspaceViewQuerySchema = /* @__PURE__ */ z.object({ view: z.enum(['catalog']).optional() });
export const listWorkspaceCatalogResponseSchema = /* @__PURE__ */ z.object({ items: z.array(workspaceCatalogEntrySchema) });
export type ListWorkspaceCatalogResponse = z.infer<typeof listWorkspaceCatalogResponseSchema>;

export const inspectWorkspaceRequestSchema = /* @__PURE__ */ z.object({
  root: z.string().min(1),
});
export type InspectWorkspaceRequest = z.infer<typeof inspectWorkspaceRequestSchema>;

export const inspectWorkspaceResponseSchema = /* @__PURE__ */ z.object({
  isGit: z.boolean(),
});
export type InspectWorkspaceResponse = z.infer<typeof inspectWorkspaceResponseSchema>;

export const createWorkspaceRequestSchema = workspaceCreateSchema;
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

export const createWorkspaceResponseSchema = workspaceSchema;
export type CreateWorkspaceResponse = z.infer<typeof createWorkspaceResponseSchema>;

export const workspaceIdParamSchema = /* @__PURE__ */ z.object({
  workspace_id: workspaceIdSchema,
});
export type WorkspaceIdParam = z.infer<typeof workspaceIdParamSchema>;

export const updateWorkspaceRequestSchema = workspaceUpdateSchema;
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequestSchema>;

export const updateWorkspaceResponseSchema = workspaceSchema;
export type UpdateWorkspaceResponse = z.infer<typeof updateWorkspaceResponseSchema>;

export const deleteWorkspaceResponseSchema = /* @__PURE__ */ z.object({
  deleted: z.literal(true),
});
export type DeleteWorkspaceResponse = z.infer<typeof deleteWorkspaceResponseSchema>;

export const workspaceTrustResponseSchema = /* @__PURE__ */ z.object({
  trusted: z.boolean(),
});
export type WorkspaceTrustResponse = z.infer<typeof workspaceTrustResponseSchema>;
