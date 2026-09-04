import { IdentityConfigSchema } from '@moonshot-ai/agent-core-v2/app/agentIdentity/configSection';
import { McpSectionSchema } from '@moonshot-ai/agent-core-v2/app/mcpConfig/configSection';
import { PluginsSectionSchema } from '@moonshot-ai/agent-core-v2/app/plugin/configSection';
import { ThreadCommunicationConfigSchema } from '@moonshot-ai/agent-core-v2/app/threadCommunication/configSection';
import { ImageConfigSchema } from '@moonshot-ai/agent-core-v2/agent/media/configSection';
import { AgentTaskConfigSchema } from '@moonshot-ai/agent-core-v2/agent/task/configSection';
import { PlanConfigSchema } from '@moonshot-ai/agent-core-v2/features/plan/configSection';
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
import { RequestIdentityPolicyWireSchema } from '@moonshot-ai/agent-core-v2/kosong/requestIdentity/requestIdentityPolicy';
import { nbSearchConfigPatchSchema } from '@moonshot-ai/protocol';
import { z } from 'zod';

const tokenCountingConfigSchema = TokenCountingConfigSchema as z.ZodType<TokenCountingConfig>;
const planConfigRequestSchema = z
  .object({
    gate: PlanConfigSchema.shape.gate.optional(),
    enter_approval_timeout_ms: PlanConfigSchema.shape.enterApprovalTimeoutMs.optional(),
  })
  .strict();

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

const pluginsConfigRequestSchema = z.object({
  marketplace_url: PluginsSectionSchema.shape.marketplaceUrl,
});

const replaceableConfigDomainSchema = z.enum([
  'experimental',
  'thread_communication',
  'token_counting',
  'workspace_instance',
  'image',
  'task',
  'identity',
  'request_identity',
  'extra_agent_dirs',
  'disabled_builtin_profiles',
  'disabled_named_profiles',
  'mcp',
  'nb_search',
  'plugins',
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
  timeoutMs: z.number().optional(),
  denyModels: z.array(z.string()).optional(),
});

export const agentsConfigResponseSchema = z.object({
  enabled: z.boolean().optional(),
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
  plan: PlanConfigSchema.optional(),
  plan_mode: z.boolean().optional(),
  yolo: z.boolean().optional(),
  default_permission_mode: z.string().optional(),
  default_plan_mode: z.boolean().optional(),
  permission: z.unknown().optional(),
  hooks: z.array(z.unknown()).optional(),
  nb_search: nbSearchConfigPatchSchema.optional(),
  merge_all_available_skills: z.boolean().optional(),
  extra_skill_dirs: z.array(z.string()).optional(),
  loop_control: z.unknown().optional(),
  background: z.unknown().optional(),
  subagent: subagentConfigResponseSchema.optional(),
  agents: agentsConfigResponseSchema.optional(),
  builtin_product_skills: z.boolean().optional(),
  model_catalog: modelCatalogConfigResponseSchema.optional(),
  experimental: z.record(z.string(), z.boolean()).optional(),
  cron: cronConfigResponseSchema.optional(),
  thread_communication: ThreadCommunicationConfigSchema.optional(),
  token_counting: tokenCountingConfigSchema.optional(),
  workspace_instance: WorkspaceInstanceConfigSchema.optional(),
  image: ImageConfigSchema.optional(),
  task: AgentTaskConfigSchema.optional(),
  identity: IdentityConfigSchema.optional(),
  request_identity: RequestIdentityPolicyWireSchema.optional(),
  extra_agent_dirs: ExtraAgentDirsConfigSchema,
  disabled_builtin_profiles: DisabledBuiltinProfilesConfigSchema,
  disabled_named_profiles: DisabledNamedProfilesConfigSchema,
  mcp: McpSectionSchema.optional(),
  plugins: PluginsSectionSchema.optional(),
  tools: ToolsConfigSchema.optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});
export type ConfigResponse = z.infer<typeof configResponseSchema>;

export const patchConfigRequestSchema = z.object({
  providers: z.record(z.string(), z.unknown()).optional(),
  default_provider: z.string().optional(),
  default_model: z.string().optional(),
  models: z.record(z.string(), z.unknown()).optional(),
  thinking: z.unknown().optional(),
  plan: planConfigRequestSchema.optional(),
  plan_mode: z.boolean().optional(),
  yolo: z.boolean().optional(),
  default_permission_mode: z.string().optional(),
  default_plan_mode: z.boolean().optional(),
  permission: z.unknown().optional(),
  hooks: z.array(z.unknown()).optional(),
  nb_search: nbSearchConfigPatchSchema.optional(),
  merge_all_available_skills: z.boolean().optional(),
  extra_skill_dirs: z.array(z.string()).optional(),
  loop_control: z.unknown().optional(),
  background: z.unknown().optional(),
  subagent: z.object({
    timeout_ms: z.number().optional(),
    deny_models: z.array(z.string()).optional(),
  }).optional(),
  agents: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  builtin_product_skills: z.boolean().optional(),
  model_catalog: z.object({
    refresh_interval_ms: z.number().optional(),
    refresh_on_start: z.boolean().optional(),
  }).optional(),
  experimental: z.record(z.string(), z.boolean()).optional(),
  thread_communication: ThreadCommunicationConfigSchema.optional(),
  token_counting: tokenCountingConfigSchema.optional(),
  workspace_instance: workspaceInstanceConfigRequestSchema.optional(),
  image: imageConfigRequestSchema.optional(),
  task: taskConfigRequestSchema.optional(),
  identity: IdentityConfigSchema.optional(),
  request_identity: RequestIdentityPolicyWireSchema.nullable().optional(),
  extra_agent_dirs: ExtraAgentDirsConfigSchema,
  disabled_builtin_profiles: DisabledBuiltinProfilesConfigSchema,
  disabled_named_profiles: DisabledNamedProfilesConfigSchema,
  mcp: mcpConfigRequestSchema.optional(),
  plugins: pluginsConfigRequestSchema.optional(),
  tools: ToolsConfigSchema.optional(),
  replace_domains: z.array(replaceableConfigDomainSchema).optional(),
}).strict();
export type PatchConfigRequest = z.infer<typeof patchConfigRequestSchema>;
