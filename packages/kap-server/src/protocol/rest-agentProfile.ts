import { z } from 'zod';

const modelAliasSchema = z.string().min(1).regex(/^\S+$/, 'model alias must not contain whitespace');

export const namedAgentRouteSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  model_alias: z.string().optional(),
  source_file: z.string(),
});
export type NamedAgentRoute = z.infer<typeof namedAgentRouteSchema>;

export const namedAgentProfileSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  source: z.string(),
  workspace_id: z.string().optional(),
  source_file: z.string().optional(),
  pinned_model_alias: z.string().optional(),
  routes: z.array(namedAgentRouteSchema),
});
export type NamedAgentProfile = z.infer<typeof namedAgentProfileSchema>;

export const listNamedAgentProfilesResponseSchema = z.object({
  items: z.array(namedAgentProfileSchema),
});
export type ListNamedAgentProfilesResponse = z.infer<
  typeof listNamedAgentProfilesResponseSchema
>;

export const namedAgentProfileNameParamsSchema = z.object({
  name: z.string().min(1),
});

export const updateNamedAgentRouteSchema = z.object({
  id: z.string().min(1),
  description: z.string().trim().min(1).optional(),
  model_alias: modelAliasSchema.nullable().optional(),
}).strict().refine(
  (value) => value.description !== undefined || value.model_alias !== undefined,
  { message: 'route update must include description or model_alias' },
);

export const updateNamedAgentProfileRequestSchema = z.object({
  scope: z.enum(['user', 'project', 'extra']),
  workspace_id: z.string().min(1),
  description: z.string().trim().min(1).optional(),
  pinned_model_alias: modelAliasSchema.nullable().optional(),
  routes: z.array(updateNamedAgentRouteSchema).optional(),
}).strict().refine(
  (value) =>
    value.description !== undefined ||
    value.pinned_model_alias !== undefined ||
    (value.routes !== undefined && value.routes.length > 0),
  { message: 'at least one editable field is required' },
);
export type UpdateNamedAgentProfileRequest = z.infer<
  typeof updateNamedAgentProfileRequestSchema
>;
