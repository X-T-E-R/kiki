import { z } from 'zod';

import { executorCapabilityDimensionSchema, executorCapabilityStateSchema } from './agentProfile';
export { executorAuthObservationSchema, type ExecutorAuthObservation } from '../executor-auth';

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
    native_agents: z.array(z.string()).optional(),
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

export const executorDiscoveryComponentSchema = z.object({
  id: z.string(),
  label: z.string(),
  role: z.enum(['program', 'dependency']),
  installed: z.boolean(),
  path: z.string().optional(),
  version: z.string().optional(),
  reason: z.string().optional(),
  reason_code: z.string().optional(),
});
export const executorDiscoveryStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  protocol: z.string(),
  installed: z.boolean(),
  status: z.enum(['installed', 'missing', 'error']),
  checked_at: z.string(),
  version: z.string().optional(),
  path: z.string().optional(),
  source: z.string().optional(),
  source_kind: z.enum(['explicit-path', 'env', 'glob', 'path-lookup', 'node-script']).optional(),
  reason: z.string().optional(),
  reason_code: z.string().optional(),
  components: z.array(executorDiscoveryComponentSchema),
});
export type ExecutorDiscoveryStatus = z.infer<typeof executorDiscoveryStatusSchema>;
export const executorDiscoveryResponseSchema = z.object({ items: z.array(executorDiscoveryStatusSchema) });
export type ExecutorDiscoveryResponse = z.infer<typeof executorDiscoveryResponseSchema>;

const executorEnvironmentNameSchema = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Enter an environment variable name');

/** Parses a proxy origin, not a URL for a resource. Stored origins keep authentication in a separate field. */
export function executorProxyUrl(value: string, allowCredentials = false): URL | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(url.protocol)
      || !url.hostname || (url.pathname !== '' && url.pathname !== '/') || url.search || url.hash
      || (!allowCredentials && (url.username || url.password))) return undefined;
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return url;
  } catch { return undefined; }
}

export function sameExecutorProxyAddress(left: string, right: string): boolean {
  const a = executorProxyUrl(left);
  const b = executorProxyUrl(right);
  return a !== undefined && b !== undefined && a.href === b.href;
}

export const executorInstanceConfigurationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inherit') }),
  z.strictObject({ kind: z.literal('config_directory'), path: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal('claude_settings'), path: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal('credential_env'), name: executorEnvironmentNameSchema }),
  z.strictObject({ kind: z.literal('plugin_account'),
    source: z.string().regex(/^plugin:[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/),
    account_id: z.string().min(1).max(1024).regex(/^[^\s\u0000]+$/) }),
]);
export type ExecutorInstanceConfiguration = z.infer<typeof executorInstanceConfigurationSchema>;

const executorProxyAuthorizationSchema = z.strictObject({
  username: z.string().regex(/^[^:\p{Cc}\p{Cs}]+$/u, 'Enter a proxy username without colons or control characters'),
  password: z.string().regex(/^[^\p{Cc}\p{Cs}]+$/u, 'Enter a proxy password without control characters'),
});
const executorProxyOriginSchema = z.string().trim().refine((value) => executorProxyUrl(value) !== undefined,
  'Enter an HTTP(S) or SOCKS proxy origin without credentials; enter authentication separately');
const executorProxyOtherSchemas = [
  z.strictObject({ kind: z.literal('inherit') }),
  z.strictObject({ kind: z.literal('direct') }),
  z.strictObject({ kind: z.literal('env'), name: executorEnvironmentNameSchema }),
] as const;
export const executorInstanceProxySchema = z.discriminatedUnion('kind', [
  ...executorProxyOtherSchemas,
  z.strictObject({ kind: z.literal('url'), url: executorProxyOriginSchema, authorization: executorProxyAuthorizationSchema.optional() }),
]);
export type ExecutorInstanceProxy = z.infer<typeof executorInstanceProxySchema>;
export const executorInstanceProxyPatchSchema = z.discriminatedUnion('kind', [
  ...executorProxyOtherSchemas,
  z.strictObject({ kind: z.literal('url'), url: executorProxyOriginSchema, authorization: executorProxyAuthorizationSchema.nullable().optional() }),
]);
export const executorInstanceProxyResponseSchema = z.discriminatedUnion('kind', [
  ...executorProxyOtherSchemas,
  z.strictObject({ kind: z.literal('url'), url: executorProxyOriginSchema, has_authorization: z.boolean().optional() }),
]);

export const executorInstanceIdSchema = z.string().regex(/^instance-[a-z0-9][a-z0-9-]{0,79}$/);
export const executorQuotaSourceIdSchema = z.string().regex(/^plugin:[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/);
const executorAccountIdSchema = z.string().min(1).max(1024).regex(/^[^\s\u0000]+$/);
export const executorInstanceChoiceSchema = z.union([
  z.enum(['main', 'auto']),
  executorInstanceIdSchema,
  z.strictObject({ account_id: executorAccountIdSchema }),
]);
export type ExecutorInstanceChoice = z.infer<typeof executorInstanceChoiceSchema>;
const executorLaunchOptionSchema = z.union([z.string(), z.number(), z.boolean()]);
export const executorLaunchSchema = z.strictObject({
  bin_path: z.string().trim().min(1).optional(),
  home_dir: z.string().trim().min(1).optional(),
  configuration: executorInstanceConfigurationSchema.optional(),
  proxy: executorInstanceProxySchema.optional(),
  env: z.record(executorEnvironmentNameSchema, z.string()).optional(),
  args: z.array(z.string()).optional(),
  options: z.record(z.string().trim().min(1), executorLaunchOptionSchema).optional(),
});
export type ExecutorLaunch = z.infer<typeof executorLaunchSchema>;
export const executorLaunchPatchSchema = z.strictObject({
  bin_path: z.string().trim().min(1).nullable().optional(),
  home_dir: z.string().trim().min(1).nullable().optional(),
  configuration: executorInstanceConfigurationSchema.nullable().optional(),
  proxy: executorInstanceProxyPatchSchema.nullable().optional(),
  env: z.record(executorEnvironmentNameSchema, z.string().nullable()).nullable().optional(),
  args: z.array(z.string()).nullable().optional(),
  options: z.record(z.string().trim().min(1), executorLaunchOptionSchema.nullable()).nullable().optional(),
});
export type ExecutorLaunchPatch = z.infer<typeof executorLaunchPatchSchema>;
export const executorLaunchResponseSchema = z.strictObject({
  bin_path: z.string().trim().min(1).optional(),
  home_dir: z.string().trim().min(1).optional(),
  configuration: executorInstanceConfigurationSchema.optional(),
  proxy: executorInstanceProxyResponseSchema.optional(),
  env_keys: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  options: z.record(z.string().trim().min(1), executorLaunchOptionSchema).optional(),
});
export type ExecutorLaunchResponse = z.infer<typeof executorLaunchResponseSchema>;
export const executorInstanceConfigSchema = z.strictObject({
  source_executor: z.string().trim().min(1),
  label: z.string().trim().min(1).max(80),
  configuration: executorInstanceConfigurationSchema,
  proxy: executorInstanceProxySchema,
  quota_account_id: executorAccountIdSchema.optional(),
  launch: executorLaunchSchema.optional(),
});
export type ExecutorInstanceConfig = z.infer<typeof executorInstanceConfigSchema>;
export const executorInstancePatchSchema = executorInstanceConfigSchema.omit({ quota_account_id: true, launch: true }).extend({
  proxy: executorInstanceProxyPatchSchema,
  /** `null` clears the saved account link. Omitting the field keeps it. */
  quota_account_id: executorAccountIdSchema.nullable().optional(),
  /** `null` clears launch overrides. Omitting the object keeps them; omitting `env` keeps saved env values. */
  launch: executorLaunchSchema.nullable().optional(),
});
export type ExecutorInstancePatch = z.infer<typeof executorInstancePatchSchema>;
export const executorInstancesPatchSchema = z.record(executorInstanceIdSchema, executorInstancePatchSchema.nullable());
export const executorInstanceResponseSchema = executorInstanceConfigSchema.extend({
  proxy: executorInstanceProxyResponseSchema,
  launch: executorLaunchResponseSchema.optional(),
});
export type ExecutorInstanceResponse = z.infer<typeof executorInstanceResponseSchema>;
export const executorInstancesResponseSchema = z.record(executorInstanceIdSchema, executorInstanceResponseSchema);

export function publicExecutorLaunch(launch: ExecutorLaunch | undefined): ExecutorLaunchResponse | undefined {
  if (launch === undefined) return undefined;
  const proxy = launch.proxy === undefined ? undefined : launch.proxy.kind !== 'url' ? launch.proxy : {
    kind: 'url' as const, url: launch.proxy.url, has_authorization: launch.proxy.authorization === undefined ? undefined : true,
  };
  const response: ExecutorLaunchResponse = {
    bin_path: launch.bin_path,
    home_dir: launch.home_dir,
    configuration: launch.configuration,
    proxy,
    env_keys: launch.env === undefined ? undefined : Object.keys(launch.env).sort(),
    args: launch.args,
    options: launch.options,
  };
  return Object.values(response).some((value) => value !== undefined) ? response : undefined;
}

export function publicExecutorInstance(instance: ExecutorInstanceConfig): ExecutorInstanceResponse {
  const launch = publicExecutorLaunch(instance.launch);
  if (launch === undefined && instance.proxy.kind !== 'url') return instance;
  const { launch: _stored, ...rest } = instance;
  const proxy = instance.proxy.kind !== 'url' ? instance.proxy : {
    kind: 'url' as const,
    url: instance.proxy.url,
    has_authorization: instance.proxy.authorization === undefined ? undefined : true,
  };
  return launch === undefined ? { ...rest, proxy } : { ...rest, proxy, launch };
}

export function supportsExecutorPluginAccount(engine: { readonly id: string; readonly protocol: string }): boolean {
  return engine.id === 'agy-cli' && engine.protocol === 'acp-v1' || engine.id === 'codex-app-server' && engine.protocol === 'codex-app-server';
}

export const executorAccountSourceSchema = z.object({ id: z.string(), label: z.string() });
export const executorAccountSourcesResponseSchema = z.object({ items: z.array(executorAccountSourceSchema) });
export const executorAccountsQuerySchema = z.object({ source: z.string().min(1).max(136) });
export const executorAccountSchema = z.object({ id: z.string(), label: z.string(), status: z.enum(['ready', 'signed_out', 'disabled']) });
export const executorAccountsResponseSchema = z.object({ items: z.array(executorAccountSchema) });
export type ExecutorAccountSourcesResponse = z.infer<typeof executorAccountSourcesResponseSchema>;
export type ExecutorAccountsResponse = z.infer<typeof executorAccountsResponseSchema>;

export const executorInstanceIssueSchema = z.enum([
  'instance_source_unavailable', 'instance_configuration_unsupported', 'instance_configuration_path',
  'instance_credential_unset', 'instance_proxy_unavailable',
]);
export type ExecutorInstanceIssue = z.infer<typeof executorInstanceIssueSchema>;

export const executorCatalogItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  protocol: z.string().min(1),
  status: z.enum(['ready', 'unavailable', 'unknown']),
  instance: executorInstanceResponseSchema.optional(),
  supports_claude_settings: z.boolean().optional(),
  configuration_issue: executorInstanceIssueSchema.optional(),
  /** Last explicit check, kept after the 60s freshness window. Absent until that engine has been checked. */
  check_status: z.enum(['ready', 'warning', 'unavailable']).optional(),
  checked_at: z.string().optional(),
  check_stale: z.boolean().optional(),
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
  /** Defaults-layer Kiki MCP injection. Profile and session choices stay on the execution binding. */
  kiki_mcp: z.object({
    effective: z.boolean().nullable(),
    source: z.enum(['harness-settings', 'harness-default']),
    applies: z.literal('next_binding'),
    precedence: z.tuple([
      z.literal('session'),
      z.literal('profile'),
      z.literal('harness-settings'),
      z.literal('harness-default'),
    ]),
    support: z.object({
      state: z.enum(['supported', 'unsupported', 'undeclared']),
      fact: z.string().min(1),
    }),
  }).optional(),
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

export const removeExecutorRegistrationResponseSchema = z.object({
  id: z.string().min(1),
  registration_removed: z.boolean(),
  builtin_retained: z.boolean(),
  resources: z.enum(['removed', 'retained', 'not_owned']),
  reason: z.string().min(1).optional(),
});
export type RemoveExecutorRegistrationResponse = z.infer<typeof removeExecutorRegistrationResponseSchema>;

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
