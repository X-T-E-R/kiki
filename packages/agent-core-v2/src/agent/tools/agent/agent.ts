import { z } from 'zod';
import { adhocEndpointInputSchema, normalizeEndpointLayer } from '@kiki/protocol';

import { createDecorator } from '#/_base/di/instantiation';
import { agentNameIssue } from '#/session/agentCollaboration/directChildren';
import { type AgentTool } from '#/tool/toolContract';

export const RESUMED_LABEL = 'subagent';
export const INHERIT_MODEL_ALIAS_UNAVAILABLE =
  'AgentRun does not accept model_alias: "inherit". Specify a concrete model name, or omit model_alias to use the target default model.';

const FLAT_ENDPOINT_FIELDS = ['base_url', 'provider_type', 'api_key', 'api_key_env', 'model', 'capabilities', 'support_efforts', 'max_context_size', 'max_completion_tokens', 'request_params'] as const;

export function normalizeSubagentEndpointInput(record: Record<string, unknown>): Record<string, unknown> {
  const structured = record['endpoint'] !== undefined;
  const flat = FLAT_ENDPOINT_FIELDS.some((key) => record[key] !== undefined);
  if (structured && flat) throw new Error('Do not mix endpoint with flat endpoint fields.');
  const endpointFields = Object.fromEntries(FLAT_ENDPOINT_FIELDS.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
  const endpoint = normalizeEndpointLayer(!structured && Object.keys(endpointFields).some((key) => key !== 'model') ? { endpoint: endpointFields } : record);
  if (endpoint === undefined && (structured || flat)) throw new Error('Endpoint overrides require endpoint fields; model requires an endpoint override, not a catalog alias.');
  if (endpoint !== undefined && record['model_alias'] !== undefined) throw new Error('model_alias cannot be combined with an endpoint override.');
  const normalized: Record<string, unknown> = { ...record, endpoint };
  for (const key of FLAT_ENDPOINT_FIELDS) delete normalized[key];
  return normalized;
}

export const SubagentToolInputSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return input;
    }
    const record = input as Record<string, unknown>;
    const normalized = normalizeSubagentEndpointInput(record);
    const hasProfile =
      typeof normalized['profile'] === 'string' && normalized['profile'].length > 0;
    if (!hasProfile) {
      delete normalized['profile'];
    }
    return normalized;
  },
  z.object({
    prompt: z.string().describe('Self-contained assignment with the outcome, usable inputs, authority and write boundary, dependencies, and observable finish; the child owns local choices and affected checks. Include constraints that change how the child works, not model, route or tool choices you apply through other parameters. On resume, give the new input for that same assignment.'),
    description: z.string().describe('Short task description (3-5 words) for UI display'),
    workDir: z.string().trim().min(1).optional().describe('Admitted absolute working directory for this child. Omit to inherit the parent workspace directory. New-agent only; resume preserves its original roots.'),
    additionalDirs: z.array(z.string().trim().min(1)).optional().describe('Admitted additional workspace directories for this child. Omit to inherit the parent workspace directories. New-agent only; resume preserves its original roots.'),
    profile: z
      .string()
      .optional()
      .describe(
        'One of the available agent profiles (see "Available agent profiles" in this tool description). When omitted, an explicitly configured [subagent].default_profile is used; otherwise the built-in general-purpose subagent prompt is used. An explicitly blank default requires a target.',
      ),
    route: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Named profile route for a new subagent. The base profile is derived from the route when profile is omitted.',
      ),
    name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Optional stable name for the new subagent, unique within this session (lowercase letters, digits, and underscores; "root" is reserved). Use it to address the same agent again with resume, AgentSend, or AgentList instead of tracking its generated ID. Rejected together with resume.',
      ),
    source_ref: z.string().trim().min(1).optional().describe('Reference id from a server-generated agent_ref in a visible user message. Links this run to that message; it does not choose a target or grant permission.'),
    profile_file: z.string().trim().min(1).optional().describe('Explicit profile Markdown file, absolute or workspace-relative. Only for new agents; mutually exclusive with profile and route. This is a role definition, not a shared prompt template.'),
    context_mode: z.enum(['direct', 'compact', 'fresh']).optional().describe('Explicit resume context choice: direct retains the current context; compact summarizes it with the current model before continuing; fresh rebuilds context from saved task state without calling the old model. Keeps the same child ID, task notes, Todo, history and workspace. Requires resume, works without changing model, and confirms an explicit model_alias change within existing policy. Native context rebuilding only. Mutually exclusive with new_window:true and allow_model_change:true; false values are ignored.'),
    allow_model_change: z.boolean().optional().describe('Legacy confirmation for an explicit model_alias change on resume while retaining context. A changed model requires this or new_window to be true; new_window:true takes precedence. When true, requires resume and model_alias and is mutually exclusive with context_mode; false is ignored. Does not bypass role, caller, route or executor restrictions.'),
    new_window: z.boolean().optional().describe('Legacy fresh-context resume of the same child, preserving task state and history without calling the old model. When true, requires resume and is mutually exclusive with context_mode; false is ignored. Also confirms an explicit model_alias change; false does not veto allow_model_change:true.'),
    allow_parent_notify: z.boolean().optional().describe('Override AgentNotify availability for this child. On a new agent, omission uses the selected profile setting, which defaults to enabled. On resume, omission preserves the saved setting. This cannot override the global [agents].notify_parent switch or tool policy.'),
    tools: z.array(z.string().trim().min(1)).optional().describe('Replace the resolved child tool selection. A lone * keeps ordinary tools without opting in to restricted groups. For browser control use ["*", "BrowserConnections", "BrowserTabs", "browser__*"]; for computer control add "mcp__kiki-computer__*" (or the actual installed MCP server name). [] selects no business tools and revokes temporary access on resume. New agents default to the profile selection; omission on resume preserves the saved override. Denies, caller ceilings, group switches, connection allowsets and read-only restrictions still apply. Native executor only.'),
    disallowed_tools: z.array(z.string().trim().min(1)).optional().describe('Additional denied tools for this child binding. Omission on resume preserves the saved call-level deny; an explicit list replaces that layer, and [] clears only that layer, not profile or ancestor denies. Native executor only.'),
    resume: z
      .string()
      .optional()
      .describe(
        'Name or agent ID of an existing direct child. Do not pass name, profile, profile_file, or route; a name or profile equal to the child\'s own is ignored. Omitted effort/model keep the saved binding. An explicit effort applies to the next idle run; changing model_alias requires an explicit context_mode or legacy allow_model_change:true / new_window:true. A running child cannot be resumed; use AgentSend. If the child is still finishing earlier work, the prompt is saved and the receipt reports status: queued.',
      ),
    background: z
      .boolean()
      .optional()
      .describe(
        'Omitted: main runs in background and receives an automatic completion notification; subagents wait in foreground, including resume and goal mode. Set true to return a task receipt immediately, or false only for subagents or profiles without background task tools. On main outside active goal mode, foreground waits auto-detach to background after 15s, and new steer input releases them immediately without stopping the child.',
      ),
    endpoint: adhocEndpointInputSchema.optional().describe('Ad-hoc native API endpoint. Use base_url, upstream model, and api_key_env (recommended) or api_key. Credentials are session-local; never combined with model_alias. A credential-only override can reauthenticate a saved child.'),
    base_url: z.string().optional(),
    provider_type: z.string().optional(),
    api_key: z.string().min(1).optional(),
    api_key_env: z.string().optional(),
    model: z.string().optional(),
    capabilities: adhocEndpointInputSchema.shape.capabilities,
    support_efforts: adhocEndpointInputSchema.shape.support_efforts,
    max_context_size: adhocEndpointInputSchema.shape.max_context_size,
    max_completion_tokens: adhocEndpointInputSchema.shape.max_completion_tokens,
    request_params: adhocEndpointInputSchema.shape.request_params,
    model_alias: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'For a new agent, use "auto" to select once, specify a concrete model to pin it, or omit to use the configured selection mode (static by default). On resume, omit to keep the saved model; explicit "auto" selects once and requires the usual model-change confirmation only if it selects a different model. AgentRun does not accept "inherit". The receipt reports actual_model.',
      ),
    effort: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Omit to use the target default thinking effort. An explicit effort overrides that default and must be supported by the target.'),
    executor_instance: z.union([
      z.enum(['main', 'auto']),
      z.string().regex(/^instance-[a-z0-9][a-z0-9-]{0,79}$/),
      z.object({ account_id: z.string().min(1) }).strict(),
    ]).optional().describe('Executor instance for a new agent, or a same-family named instance / account_id / auto / main when resuming an external child in its original session. Omit to inherit the profile or executor default on launch, or to keep the saved instance on resume unless an auto-scheduled turn ended in quota exhaustion. main uses the executor\'s own launch. auto selects by comparable quota. A named instance or account_id does not read quota.'),
    executor_launch: z.object({
      bin_path: z.string().min(1).nullable().optional(),
      home_dir: z.string().min(1).nullable().optional(),
      env: z.record(z.string(), z.string().nullable()).nullable().optional(),
      args: z.array(z.string()).nullable().optional(),
    }).strict().optional().describe('Launch patch for a new agent, applied after the selected instance. Null clears one field. env merges by key. args replaces extra arguments. Resume keeps the saved launch.'),
  }).superRefine((args, ctx) => {
    if (args.endpoint !== undefined && args.model_alias !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'model_alias cannot be combined with an endpoint override.' });
    if (args.model_alias === 'inherit') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: INHERIT_MODEL_ALIAS_UNAVAILABLE, path: ['model_alias'] });
    }
    for (const message of subagentArgumentConflicts(args)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
    if (args.name !== undefined) {
      const issue = agentNameIssue(args.name);
      if (issue !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `name ${issue}`, path: ['name'] });
      }
    }
  }),
);

export type SubagentToolInput = z.infer<typeof SubagentToolInputSchema>;

type SubagentArgumentSelectors = Pick<SubagentToolInput,
  'resume' | 'profile' | 'profile_file' | 'route' | 'name' | 'context_mode' | 'allow_model_change' | 'new_window' | 'model_alias'>;

/** Cross-field conflicts among AgentRun's target and resume options, in the order they are reported. A false `new_window` or `allow_model_change` changes nothing and is never a conflict. */
export function subagentArgumentConflicts(args: SubagentArgumentSelectors): string[] {
  const resume = (args.resume?.trim().length ?? 0) > 0;
  const profile = (args.profile?.length ?? 0) > 0;
  const conflicts: string[] = [];
  if (resume && (profile || args.profile_file !== undefined || args.route !== undefined)) {
    conflicts.push('Cannot set profile, profile_file, or route when continuing an existing agent; pass only resume with the name or agent id.');
  }
  if (resume && args.name !== undefined) {
    conflicts.push('Cannot set name when continuing an existing agent; the name was fixed at creation.');
  }
  if (args.profile_file !== undefined && (profile || args.route !== undefined)) {
    conflicts.push('profile_file is mutually exclusive with profile and route.');
  }
  if (args.context_mode !== undefined && !resume) {
    conflicts.push('context_mode requires resume; it chooses how an existing child continues.');
  }
  if (args.context_mode !== undefined && (args.new_window === true || args.allow_model_change === true)) {
    conflicts.push('context_mode replaces new_window and allow_model_change; send context_mode without them.');
  }
  if (args.allow_model_change === true && (!resume || args.model_alias === undefined)) {
    conflicts.push('allow_model_change requires resume and model_alias.');
  }
  if (args.new_window === true && !resume) {
    conflicts.push('new_window requires resume; it continues an existing child with fresh context.');
  }
  return conflicts;
}

export const BACKGROUND_AGENT_UNAVAILABLE =
  'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled. Main defaults to background when background is omitted; no foreground fallback was attempted. Enable those tools, or retry with background:false for a genuine synchronous dependency.';
export const RESUME_WITH_TYPE_UNAVAILABLE =
  'Cannot set profile when continuing an existing agent. Pass only resume with the name or agent id.';
export const USER_INTERRUPTED_SUBAGENT_MESSAGE =
  'The subagent was stopped before it finished by user.';
export const SUBAGENT_STOPPED_MESSAGE = 'The subagent was stopped before it finished.';

export function mainProfileSubagentNotice(profileName: string): string {
  return `main_profile_notice: "${profileName}" is a main-agent profile running as a subagent here. For long-running collaboration, a user-visible independent session, or back-and-forth messages, ThreadCreate gives a better experience.`;
}

export interface ISubagentTool extends AgentTool<SubagentToolInput> {
  readonly _serviceBrand: undefined;
  dispatchCatalog(): import('./subagentCapabilities').SubagentCapabilityCatalog;
  visibleProfileDescriptions(): ReadonlyMap<string, { readonly line: string; readonly signature: string }>;
  advertisedProfileDescriptions(): ReturnType<ISubagentTool['visibleProfileDescriptions']>;
}

export const ISubagentTool = createDecorator<ISubagentTool>('subagentTool');
