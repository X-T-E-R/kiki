import { z } from 'zod';

import { executorCapabilityDimensionSchema, executorCapabilityStateSchema } from './agentProfile';

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
    agent_version: z.string().optional(),
    image: z.boolean().optional(),
    audio: z.boolean().optional(),
    fork: z.boolean().optional(),
    native_steering: z.boolean().optional(),
    question_form: z.boolean().optional(),
    plan_approval: z.boolean().optional(),
    models: z.array(z.string()).optional(),
    thinking_levels: z.array(z.string()).optional(),
    auth_methods: z.array(z.string()).optional(),
    resume: z.boolean().optional(),
    load: z.boolean().optional(),
    permission_modes: z.array(z.string()).optional(),
  }).optional(),
});
export type ExecutorCapabilitiesResponse = z.infer<typeof executorCapabilitiesSchema>;

export const executorCredentialSourceSchema = z.enum([
  'oauth_login', 'api_key_env', 'auth_token_env', 'settings_env', 'api_key_helper',
  'api_key', 'external_backend', 'none', 'unknown',
]);
export type ExecutorCredentialSource = z.infer<typeof executorCredentialSourceSchema>;

export const executorOverrideSchema = z.object({
  bin_path: z.string().optional(),
  home_dir: z.string().optional(),
  args: z.array(z.string()),
  env_keys: z.array(z.string()),
});
export type ExecutorOverride = z.infer<typeof executorOverrideSchema>;

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
    /** Environment variable the engine reads an API key from, when it accepts one instead of a sign-in. */
    api_key_env: z.string().optional(),
    login_status: z.enum(['logged_in', 'logged_out', 'unknown']),
    /** Which credential the engine already has: a CLI login, an API key, a token, a settings `env` entry, or `apiKeyHelper`. */
    credential_source: executorCredentialSourceSchema.optional(),
    credential_detail: z.string().optional(),
    /** Environment variable the engine's own configuration directory is published under, when it has one. */
    home_env: z.string().optional(),
    override: executorOverrideSchema.optional(),
    default_args: z.array(z.string()),
  }).optional(),
  default_profile: z.boolean().optional(),
});

export const executorRequirementSchema = z.object({
  id: z.string(),
  label: z.string(),
  role: z.enum(['dependency', 'program']),
  status: z.enum(['ok', 'missing', 'failed']),
  path: z.string().optional(),
  version: z.string().optional(),
  install_hint: z.string().optional(),
});
export type ExecutorRequirement = z.infer<typeof executorRequirementSchema>;

export const executorDetailResponseSchema = executorCatalogItemSchema;
export const executorCheckResponseSchema = z.object({
  id: z.string(),
  status: z.enum(['ready', 'warning', 'unavailable']),
  version: z.string().optional(),
  command: z.string(),
  selected_source: z.string().optional(),
  resolved_args: z.array(z.string()),
  login_status: z.enum(['logged_in', 'logged_out', 'unknown']),
  credential_source: executorCredentialSourceSchema.optional(),
  credential_detail: z.string().optional(),
  diagnostics: z.array(z.object({ code: z.string().optional(), severity: z.enum(['info', 'warning', 'error']), message: z.string() })),
  /** Setup order: declared dependencies first, then the launched program. */
  requirements: z.array(executorRequirementSchema).optional(),
});
export type ExecutorCatalogItem = z.infer<typeof executorCatalogItemSchema>;
export type ExecutorCheckResponse = z.infer<typeof executorCheckResponseSchema>;

export const executorCatalogContextSchema = z.object({
  state: executorCapabilityStateSchema,
  context_window: z.number().int().positive().optional(),
  max_input_tokens: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  compaction_threshold: z.number().positive().optional(),
  diagnostic: z.string().optional(),
});
export const executorCatalogControlSchema = z.object({
  advertised: z.boolean().optional(),
  applicability: z.enum(['live', 'next_binding', 'fresh_binding', 'unsupported', 'unknown']),
  apply_state: z.enum(['applied', 'pending', 'unsupported', 'unknown']),
  diagnostic: z.string().optional(),
});
export const executorCatalogEffectiveSchema = z.object({
  models: executorCapabilityDimensionSchema,
  thinking_levels: executorCapabilityDimensionSchema,
  context: executorCatalogContextSchema,
  controls: z.object({
    model_switch: executorCatalogControlSchema,
    thinking_switch: executorCatalogControlSchema,
    manual_compact: executorCatalogControlSchema,
  }),
});
export const executorModelCatalogResponseSchema = z.object({
  executor_id: z.string().min(1),
  source: z.enum(['negotiated', 'cli_probe']),
  provenance: z.enum(['acp_negotiation', 'read_only_cli_probe']),
  revision: z.string().min(1),
  apply_state: executorCapabilityStateSchema,
  observed_at: z.number().int().nonnegative(),
  executor_version: z.string().optional(),
  catalog_program_version: z.string().optional(),
  catalog_command: z.string().optional(),
  effective: executorCatalogEffectiveSchema,
});
export type ExecutorModelCatalogResponse = z.infer<typeof executorModelCatalogResponseSchema>;
export const getExecutorModelsResponseSchema = executorModelCatalogResponseSchema;
export type GetExecutorModelsResponse = ExecutorModelCatalogResponse;
export const refreshExecutorModelsResponseSchema = executorModelCatalogResponseSchema;
export type RefreshExecutorModelsResponse = ExecutorModelCatalogResponse;

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

export const localSessionSummarySchema = z.object({
  id: z.string(), engine: z.enum(['claude', 'codex']), external_id: z.string(), source_path: z.string(),
  source_home: z.string(), resume: z.object({ supported: z.boolean(), reason: z.string().optional() }),
  cwd: z.string().optional(), title: z.string().optional(), created_at: z.string().optional(),
  updated_at: z.string(), last_prompt: z.string().optional(), parent_id: z.string().optional(), partial: z.boolean(),
});
export type LocalSessionSummary = z.infer<typeof localSessionSummarySchema>;

export const localSessionMessageSchema = z.object({
  id: z.string(), role: z.enum(['user', 'assistant', 'system']), timestamp: z.string().optional(),
  blocks: z.array(z.object({ kind: z.enum(['text', 'thought', 'tool_call', 'tool_result', 'image']),
    text: z.string().optional(), name: z.string().optional() })),
});
export const localSessionDirectorySchema = z.object({
  root: z.string(), exists: z.boolean(), items: z.array(localSessionSummarySchema),
  truncated: z.boolean(), unreadable_files: z.number().int().nonnegative(),
  resume_enabled: z.boolean(),
});
export type LocalSessionDirectory = z.infer<typeof localSessionDirectorySchema>;
export const localSessionDetailSchema = z.object({
  summary: localSessionSummarySchema, messages: z.array(localSessionMessageSchema), warnings: z.array(z.string()),
});
export type LocalSessionDetail = z.infer<typeof localSessionDetailSchema>;

export const resumeLocalSessionRequestSchema = z.object({
  source_home: z.string().min(1),
  profile: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinking: z.string().min(1).optional(),
}).strict();
export type ResumeLocalSessionRequest = z.infer<typeof resumeLocalSessionRequestSchema>;
export const resumeLocalSessionResponseSchema = z.object({
  session_id: z.string(), executor_id: z.string(), created: z.boolean(),
});
export type ResumeLocalSessionResponse = z.infer<typeof resumeLocalSessionResponseSchema>;
