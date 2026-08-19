import { IdentityConfigSchema } from '@moonshot-ai/agent-core-v2/app/agentIdentity/configSection';
import { McpSectionSchema } from '@moonshot-ai/agent-core-v2/app/mcpConfig/configSection';
import { ThreadCommunicationConfigSchema } from '@moonshot-ai/agent-core-v2/app/threadCommunication/configSection';
import { ImageConfigSchema } from '@moonshot-ai/agent-core-v2/agent/media/configSection';
import { AgentTaskConfigSchema } from '@moonshot-ai/agent-core-v2/agent/task/configSection';
import {
  TokenCountingConfigSchema,
  type TokenCountingConfig,
} from '@moonshot-ai/agent-core-v2/agent/tokenCounting/configSection';
import { ToolsConfigSchema } from '@moonshot-ai/agent-core-v2/agent/toolPolicy/configSection';
import {
  DisabledBuiltinProfilesConfigSchema,
  DisabledNamedProfilesConfigSchema,
  ExtraAgentDirsConfigSchema,
} from '@moonshot-ai/agent-core-v2/workspace/workspaceAgentProfileLoader/configSection';
import { WorkspaceInstanceConfigSchema } from '@moonshot-ai/agent-core-v2/workspace/workspaceInstance/configSection';
import { z } from 'zod';

const tokenCountingConfigSchema = TokenCountingConfigSchema as z.ZodType<TokenCountingConfig>;

const cronConfigResponseSchema = z.object({
  debug: z.boolean(),
  noJitter: z.boolean(),
  noStale: z.boolean(),
  disabled: z.boolean(),
  manualTick: z.boolean(),
  clock: z.string().optional(),
  pollIntervalMs: z.number().int().min(0).nullable().optional(),
});

const workspaceInstanceConfigRequestSchema = z
  .object({
    idle_ttl_ms: WorkspaceInstanceConfigSchema.shape.idleTtlMs,
  })
  .strict();

const imageConfigRequestSchema = z.object({
  max_edge_px: ImageConfigSchema.shape.maxEdgePx,
  read_byte_budget: ImageConfigSchema.shape.readByteBudget,
});

const taskConfigRequestSchema = z.object({
  max_running_tasks: AgentTaskConfigSchema.shape.maxRunningTasks,
  keep_alive_on_exit: AgentTaskConfigSchema.shape.keepAliveOnExit,
  bash_auto_background_on_timeout: AgentTaskConfigSchema.shape.bashAutoBackgroundOnTimeout,
  bash_task_timeout_s: AgentTaskConfigSchema.shape.bashTaskTimeoutS,
  kill_grace_period_ms: AgentTaskConfigSchema.shape.killGracePeriodMs,
  print_wait_ceiling_s: AgentTaskConfigSchema.shape.printWaitCeilingS,
  print_background_mode: AgentTaskConfigSchema.shape.printBackgroundMode,
  print_max_turns: AgentTaskConfigSchema.shape.printMaxTurns,
});

const mcpConfigRequestSchema = z.object({
  startup_timeout_ms: McpSectionSchema.shape.startupTimeoutMs,
  tool_timeout_ms: McpSectionSchema.shape.toolTimeoutMs,
});

const replaceableConfigDomainSchema = z.enum([
  'secondary_model',
  'experimental',
  'thread_communication',
  'token_counting',
  'workspace_instance',
  'image',
  'task',
  'identity',
  'extra_agent_dirs',
  'disabled_builtin_profiles',
  'disabled_named_profiles',
  'mcp',
  'tools',
]);

export const providerConfigResponseSchema = z.object({
  type: z.string(),
  base_url: z.string().optional(),
  default_model: z.string().optional(),
  has_api_key: z.boolean(),
});
export type ProviderConfigResponse = z.infer<typeof providerConfigResponseSchema>;

export const subagentConfigResponseSchema = z.object({
  defaultModel: z.string().optional(),
  defaultEffort: z.string().optional(),
  timeoutMs: z.number().optional(),
  denyModels: z.array(z.string()).optional(),
});

export const secondaryModelConfigResponseSchema = z.object({
  defaultModel: z.string().optional(),
  models: z.record(z.string(), z.string()).optional(),
  force: z.boolean().optional(),
  enforcePool: z.boolean().optional(),
  model: z.string().optional(),
  maxContextSize: z.number().optional(),
  maxInputSize: z.number().optional(),
  maxOutputSize: z.number().optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  offEffort: z.string().optional(),
}).passthrough();

export const agentsConfigResponseSchema = z.object({
  enabled: z.boolean().optional(),
  defaultSubagentModel: z.string().optional(),
  defaultSubagentReasoningEffort: z.string().optional(),
});

export const modelCatalogConfigResponseSchema = z.object({
  refreshIntervalMs: z.number().optional(),
  refreshOnStart: z.boolean().optional(),
});

export const configResponseSchema = z.object({
  providers: z.record(z.string(), providerConfigResponseSchema).default({}),
  default_provider: z.string().optional(),
  default_model: z.string().optional(),
  models: z.record(z.string(), z.unknown()).optional(),
  thinking: z.unknown().optional(),
  plan_mode: z.boolean().optional(),
  yolo: z.boolean().optional(),
  default_permission_mode: z.string().optional(),
  default_plan_mode: z.boolean().optional(),
  permission: z.unknown().optional(),
  hooks: z.array(z.unknown()).optional(),
  services: z.unknown().optional(),
  merge_all_available_skills: z.boolean().optional(),
  extra_skill_dirs: z.array(z.string()).optional(),
  loop_control: z.unknown().optional(),
  background: z.unknown().optional(),
  subagent: subagentConfigResponseSchema.optional(),
  agents: agentsConfigResponseSchema.optional(),
  builtin_product_skills: z.boolean().optional(),
  model_catalog: modelCatalogConfigResponseSchema.optional(),
  secondary_model: secondaryModelConfigResponseSchema.optional(),
  experimental: z.record(z.string(), z.boolean()).optional(),
  cron: cronConfigResponseSchema.optional(),
  thread_communication: ThreadCommunicationConfigSchema.optional(),
  token_counting: tokenCountingConfigSchema.optional(),
  workspace_instance: WorkspaceInstanceConfigSchema.optional(),
  image: ImageConfigSchema.optional(),
  task: AgentTaskConfigSchema.optional(),
  identity: IdentityConfigSchema.optional(),
  extra_agent_dirs: ExtraAgentDirsConfigSchema,
  disabled_builtin_profiles: DisabledBuiltinProfilesConfigSchema,
  disabled_named_profiles: DisabledNamedProfilesConfigSchema,
  mcp: McpSectionSchema.optional(),
  tools: ToolsConfigSchema.optional(),
  telemetry: z.boolean().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});
export type ConfigResponse = z.infer<typeof configResponseSchema>;

export const patchConfigRequestSchema = z.object({
  providers: z.record(z.string(), z.unknown()).optional(),
  default_provider: z.string().optional(),
  default_model: z.string().optional(),
  models: z.record(z.string(), z.unknown()).optional(),
  thinking: z.unknown().optional(),
  plan_mode: z.boolean().optional(),
  yolo: z.boolean().optional(),
  default_permission_mode: z.string().optional(),
  default_plan_mode: z.boolean().optional(),
  permission: z.unknown().optional(),
  hooks: z.array(z.unknown()).optional(),
  services: z.unknown().optional(),
  merge_all_available_skills: z.boolean().optional(),
  extra_skill_dirs: z.array(z.string()).optional(),
  loop_control: z.unknown().optional(),
  background: z.unknown().optional(),
  subagent: z.object({
    default_model: z.string().optional(),
    default_effort: z.string().optional(),
    timeout_ms: z.number().optional(),
    deny_models: z.array(z.string()).optional(),
  }).optional(),
  agents: z.object({
    enabled: z.boolean().optional(),
    default_subagent_model: z.string().optional(),
    default_subagent_reasoning_effort: z.string().optional(),
  }).optional(),
  builtin_product_skills: z.boolean().optional(),
  model_catalog: z.object({
    refresh_interval_ms: z.number().optional(),
    refresh_on_start: z.boolean().optional(),
  }).optional(),
  secondary_model: z.object({
    default_model: z.string().min(1).optional(),
    models: z.record(z.string(), z.string()).optional(),
    force: z.boolean().optional(),
    enforce_pool: z.boolean().optional(),
    model: z.string().min(1).optional(),
    max_context_size: z.number().optional(),
    max_input_size: z.number().optional(),
    max_output_size: z.number().optional(),
    capabilities: z.array(z.string()).optional(),
    display_name: z.string().optional(),
    reasoning_key: z.string().optional(),
    adaptive_thinking: z.boolean().optional(),
    support_efforts: z.array(z.string()).optional(),
    default_effort: z.string().optional(),
    off_effort: z.string().optional(),
  }).passthrough().optional(),
  experimental: z.record(z.string(), z.boolean()).optional(),
  thread_communication: ThreadCommunicationConfigSchema.optional(),
  token_counting: tokenCountingConfigSchema.optional(),
  workspace_instance: workspaceInstanceConfigRequestSchema.optional(),
  image: imageConfigRequestSchema.optional(),
  task: taskConfigRequestSchema.optional(),
  identity: IdentityConfigSchema.optional(),
  extra_agent_dirs: ExtraAgentDirsConfigSchema,
  disabled_builtin_profiles: DisabledBuiltinProfilesConfigSchema,
  disabled_named_profiles: DisabledNamedProfilesConfigSchema,
  mcp: mcpConfigRequestSchema.optional(),
  tools: ToolsConfigSchema.optional(),
  replace_domains: z.array(replaceableConfigDomainSchema).optional(),
  telemetry: z.boolean().optional(),
}).strict();
export type PatchConfigRequest = z.infer<typeof patchConfigRequestSchema>;
