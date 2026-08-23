import { z } from 'zod';

const modelAliasSchema = z.string().min(1).regex(/^\S+$/, 'model alias must not contain whitespace');
const optionalProfileStringSchema = z.string().trim().min(1).nullable().optional();
const profileStringListSchema = z.array(z.string().trim().min(1)).nullable().optional();
const serviceTierSchema = z.enum(['auto', 'default', 'flex', 'priority']);
const modelPreferenceSchema = z.enum(['primary', 'secondary']);
const promptModeSchema = z.enum(['prepend', 'append', 'wrap']);
const requestParamsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export const namedAgentModelProfileSchema = z.object({
  alias: z.string(),
  when: z.string(),
  thinking_effort: z.string().optional(),
  allowed_efforts: z.array(z.string()).optional(),
  prompt_mode: promptModeSchema.optional(),
  prompt: z.string().optional(),
});
export type NamedAgentModelProfile = z.infer<typeof namedAgentModelProfileSchema>;

export const namedAgentSpawnConstraintsSchema = z.object({
  allowed_models: z.array(z.string()).optional(),
  deny_models: z.array(z.string()).optional(),
  allowed_efforts: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
});
export type NamedAgentSpawnConstraints = z.infer<typeof namedAgentSpawnConstraintsSchema>;

export const namedAgentSubagentLeaseSchema = z.object({
  name: z.string(),
  source: z.string().optional(),
  scope: z.literal('private').optional(),
  status: z.enum(['ready', 'unavailable']).optional(),
  diagnostic: z.string().optional(),
  description: z.string().optional(),
  when_to_use: z.string().optional(),
  model_preference: modelPreferenceSchema.optional(),
  model_alias: z.string().optional(),
  thinking_effort: z.string().optional(),
  allowed_models: z.array(z.string()).optional(),
  deny_models: z.array(z.string()).optional(),
  allowed_efforts: z.array(z.string()).optional(),
  tools: z.array(z.string()).nullable().optional(),
  disallowed_tools: z.array(z.string()).optional(),
  subagents: z.array(z.string()).nullable().optional(),
  prompt_mode: promptModeSchema.optional(),
  prompt: z.string().optional(),
  delegation_notice: z.enum(['auto', 'off']).optional(),
  service_tier: serviceTierSchema.nullable().optional(),
  request_params: requestParamsSchema.nullable().optional(),
  model_profiles: z.array(namedAgentModelProfileSchema).optional(),
});
export type NamedAgentSubagentLease = z.infer<typeof namedAgentSubagentLeaseSchema>;

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
  when_to_use: z.string().optional(),
  source: z.string(),
  workspace_id: z.string().optional(),
  workspace_ids: z.array(z.string()).optional(),
  source_file: z.string().optional(),
  main: z.boolean(),
  override: z.boolean().optional(),
  pinned_model_alias: z.string().optional(),
  thinking_effort: z.string().optional(),
  service_tier: serviceTierSchema.optional(),
  tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  model_profiles: z.array(namedAgentModelProfileSchema).optional(),
  spawn_constraints: namedAgentSpawnConstraintsSchema.optional(),
  subagents: z.array(z.union([z.string(), namedAgentSubagentLeaseSchema])).optional(),
  disabled: z.boolean(),
  routes: z.array(namedAgentRouteSchema),
});
export type NamedAgentProfile = z.infer<typeof namedAgentProfileSchema>;

const booleanQueryParam = z.preprocess(
  (value) => {
    if (value === 'true' || value === '1' || value === 1 || value === true) return true;
    if (value === 'false' || value === '0' || value === 0 || value === false) return false;
    return value;
  },
  z.boolean().optional(),
);

export const listNamedAgentProfilesQuerySchema = z.object({
  expand: booleanQueryParam,
});
export type ListNamedAgentProfilesQuery = z.infer<
  typeof listNamedAgentProfilesQuerySchema
>;

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
  when_to_use: optionalProfileStringSchema,
  pinned_model_alias: modelAliasSchema.nullable().optional(),
  thinking_effort: optionalProfileStringSchema,
  service_tier: serviceTierSchema.nullable().optional(),
  tools: profileStringListSchema,
  disallowed_tools: profileStringListSchema,
  routes: z.array(updateNamedAgentRouteSchema).optional(),
  raw_text: z.string().optional(),
}).strict().superRefine((value, context) => {
  const hasStructuredUpdate =
    value.description !== undefined ||
    value.when_to_use !== undefined ||
    value.pinned_model_alias !== undefined ||
    value.thinking_effort !== undefined ||
    value.service_tier !== undefined ||
    value.tools !== undefined ||
    value.disallowed_tools !== undefined ||
    (value.routes !== undefined && value.routes.length > 0);
  if (value.raw_text !== undefined && hasStructuredUpdate) {
    context.addIssue({
      code: 'custom',
      path: ['raw_text'],
      message: 'raw_text cannot be combined with field or route updates',
    });
  }
  if (value.raw_text === undefined && !hasStructuredUpdate) {
    context.addIssue({
      code: 'custom',
      message: 'at least one editable field or raw_text is required',
    });
  }
});
export type UpdateNamedAgentProfileRequest = z.infer<
  typeof updateNamedAgentProfileRequestSchema
>;
