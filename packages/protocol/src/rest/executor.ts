import { z } from 'zod';

export const executorCapabilitiesSchema = z.object({
  prompt_deliveries: z.array(z.enum(['append', 'replace', 'preamble'])),
  steer: z.enum(['native', 'next_turn_preamble']),
  permission: z.object({
    via: z.enum(['config_option', 'session_mode', 'argv', 'turn_param']).optional(),
    trust_engine_settings: z.boolean(),
  }),
  model_binding: z.string().optional(),
  thinking_binding: z.boolean(),
  negotiated: z.object({
    models: z.array(z.string()).optional(),
    thinking_levels: z.array(z.string()).optional(),
    auth_methods: z.array(z.string()).optional(),
    resume: z.boolean().optional(),
    load: z.boolean().optional(),
    permission_modes: z.array(z.string()).optional(),
  }).optional(),
});
export type ExecutorCapabilitiesResponse = z.infer<typeof executorCapabilitiesSchema>;

export const executorCatalogItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  protocol: z.string().min(1),
  status: z.enum(['ready', 'unavailable', 'unknown']),
  version: z.string().optional(),
  model_binding: z.enum(['mapped', 'unavailable']),
  thinking_binding: z.enum(['mapped', 'unavailable']),
  capabilities: executorCapabilitiesSchema.optional(),
  connection: z.object({
    command: z.string().optional(),
    source: z.string().optional(),
    install_hint: z.string().optional(),
    login_command: z.array(z.string()).optional(),
    login_status: z.enum(['logged_in', 'logged_out', 'unknown']),
    default_args: z.array(z.string()),
  }).optional(),
  default_profile: z.boolean().optional(),
});

export const executorDetailResponseSchema = executorCatalogItemSchema;
export const executorCheckResponseSchema = z.object({
  id: z.string(),
  status: z.enum(['ready', 'warning', 'unavailable']),
  version: z.string().optional(),
  command: z.string(),
  selected_source: z.string().optional(),
  resolved_args: z.array(z.string()),
  login_status: z.enum(['logged_in', 'logged_out', 'unknown']),
  diagnostics: z.array(z.object({ severity: z.enum(['info', 'warning', 'error']), message: z.string() })),
});
export type ExecutorCatalogItem = z.infer<typeof executorCatalogItemSchema>;

export const listExecutorsResponseSchema = z.object({
  items: z.array(executorCatalogItemSchema),
});
export type ListExecutorsResponse = z.infer<typeof listExecutorsResponseSchema>;

export const executorPromptPreviewRequestSchema = z.object({
  executor: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
}).strict();
export type ExecutorPromptPreviewRequest = z.infer<typeof executorPromptPreviewRequestSchema>;

export const executorPromptPreviewResponseSchema = z.object({
  executor: z.string().min(1),
  delivery: z.object({
    requested: z.enum(['append', 'replace', 'preamble']),
    actual: z.enum(['append', 'replace', 'preamble']),
    downgraded: z.boolean(),
  }),
  blocks: z.array(z.object({ id: z.string(), text: z.string() })),
  text: z.string(),
});
export type ExecutorPromptPreviewResponse = z.infer<typeof executorPromptPreviewResponseSchema>;
