import { z } from 'zod';

import { requestIdentityPolicySchema } from '../modelCatalog';
import { nbSearchConfigPatchSchema, nbSearchSourceConfigSchema } from './nbSearch';

export const taskBoardStorageConfigSchema = z.object({
  storage: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('auto') }).strict(),
    z.object({ mode: z.literal('global') }).strict(),
    z.object({ mode: z.literal('fixed'), path: z.string().trim().min(1).max(4096) }).strict(),
  ]),
}).strict();

export const promptConfigSchema = z.object({
  shared: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
  tools: z.record(z.string(), z.string()).optional(),
}).strict();
export type PromptConfig = z.infer<typeof promptConfigSchema>;

export const providerConfigResponseSchema = z.object({
  type: z.string(),
  base_url: z.string().optional(),
  default_model: z.string().optional(),
  has_api_key: z.boolean(),
});
export type ProviderConfigResponse = z.infer<typeof providerConfigResponseSchema>;

export const subagentConfigResponseSchema = z.object({
  timeoutMs: z.number().int().nonnegative().optional(),
  maxDirectChildren: z.number().int().nonnegative().optional(),
  maxTotalSubagents: z.number().int().nonnegative().optional(),
});

export const agentsConfigResponseSchema = z.object({
  enabled: z.boolean().optional(),
  notify_parent: z.boolean().optional(),
});

export const modelCatalogConfigResponseSchema = z.object({
  refreshIntervalMs: z.number().optional(),
  refreshOnStart: z.boolean().optional(),
});

export const sessionTitleConfigResponseSchema = z.object({
  model: z.string().optional(),
});

export const planConfigResponseSchema = z.object({
  gate: z.enum(['free', 'gated']),
  enterApprovalTimeoutMs: z.number().int().min(5000),
});

export const planConfigRequestSchema = z
  .object({
    gate: z.enum(['free', 'gated']).optional(),
    enter_approval_timeout_ms: z.number().int().min(5000).optional(),
  })
  .strict();

export const configResponseSchema = z.object({
  providers: z.record(z.string(), providerConfigResponseSchema).default({}),
  default_provider: z.string().optional(),
  default_model: z.string().optional(),
  models: z.record(z.string(), z.unknown()).optional(),
  request_identity: requestIdentityPolicySchema.optional(),
  thinking: z.unknown().optional(),
  plan: planConfigResponseSchema.optional(),
  plan_mode: z.boolean().optional(),
  task_board: taskBoardStorageConfigSchema.optional(),
  yolo: z.boolean().optional(),
  default_permission_mode: z.string().optional(),
  default_plan_mode: z.boolean().optional(),
  permission: z.unknown().optional(),
  hooks: z.array(z.unknown()).optional(),
  nb_search: nbSearchConfigPatchSchema.optional(),
  nb_search_source: nbSearchSourceConfigSchema.optional(),
  prompt: promptConfigSchema.optional(),
  merge_all_available_skills: z.boolean().optional(),
  extra_skill_dirs: z.array(z.string()).optional(),
  loop_control: z.unknown().optional(),
  background: z.unknown().optional(),
  subagent: subagentConfigResponseSchema.optional(),
  agents: agentsConfigResponseSchema.optional(),
  builtin_product_skills: z.boolean().optional(),
  model_catalog: modelCatalogConfigResponseSchema.optional(),
  session_title: sessionTitleConfigResponseSchema.optional(),
  experimental: z.record(z.string(), z.boolean()).optional(),
  disabled_builtin_profiles: z.array(z.string()).optional(),
  disabled_named_profiles: z.array(z.string()).optional(),
  retry: z.unknown().optional(),
  plugins: z.object({ marketplaceUrl: z.string().optional() }).passthrough().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});
export type ConfigResponse = z.infer<typeof configResponseSchema>;

export const patchConfigRequestSchema = z.object({
  providers: z.record(z.string(), z.unknown()).optional(),
  default_provider: z.string().optional(),
  default_model: z.string().optional(),
  models: z.record(z.string(), z.unknown()).optional(),
  request_identity: requestIdentityPolicySchema.nullable().optional(),
  thinking: z.unknown().optional(),
  plan: planConfigRequestSchema.optional(),
  plan_mode: z.boolean().optional(),
  task_board: taskBoardStorageConfigSchema.optional(),
  yolo: z.boolean().optional(),
  default_permission_mode: z.string().optional(),
  default_plan_mode: z.boolean().optional(),
  permission: z.unknown().optional(),
  hooks: z.array(z.unknown()).optional(),
  services: z.never().optional(),
  nb_search: nbSearchConfigPatchSchema.optional(),
  nb_search_source: nbSearchSourceConfigSchema.optional(),
  prompt: promptConfigSchema.optional(),
  merge_all_available_skills: z.boolean().optional(),
  extra_skill_dirs: z.array(z.string()).optional(),
  loop_control: z.unknown().optional(),
  background: z.unknown().optional(),
  subagent: z.object({
    timeout_ms: z.number().int().nonnegative().optional(),
    max_direct_children: z.number().int().nonnegative().optional(),
    max_total_subagents: z.number().int().nonnegative().optional(),
  }).optional(),
  agents: z.object({
    enabled: z.boolean().optional(),
    notify_parent: z.boolean().optional(),
  }).optional(),
  builtin_product_skills: z.boolean().optional(),
  model_catalog: z.object({
    refresh_interval_ms: z.number().optional(),
    refresh_on_start: z.boolean().optional(),
  }).optional(),
  session_title: z.object({
    model: z.string().optional(),
  }).optional(),
  experimental: z.record(z.string(), z.boolean()).optional(),
  disabled_builtin_profiles: z.array(z.string()).optional(),
  disabled_named_profiles: z.array(z.string()).optional(),
  retry: z.unknown().optional(),
  plugins: z.object({ marketplace_url: z.string().optional() }).optional(),
});
export type PatchConfigRequest = z.infer<typeof patchConfigRequestSchema>;
