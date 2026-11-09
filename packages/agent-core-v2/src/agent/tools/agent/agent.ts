import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { agentNameIssue } from '#/session/agentCollaboration/directChildren';
import { type AgentTool } from '#/tool/toolContract';

export const RESUMED_LABEL = 'subagent';
export const INHERIT_MODEL_ALIAS_UNAVAILABLE =
  'AgentRun does not accept model_alias: "inherit". Specify a concrete model name, or omit model_alias to use the target default model.';

export const SubagentToolInputSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return input;
    }
    const record = input as Record<string, unknown>;
    const normalized = { ...record };
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
    context_mode: z.enum(['direct', 'compact', 'fresh']).optional().describe('Explicit resume context choice: direct retains the current context; compact summarizes it with the current model before continuing; fresh rebuilds context from saved task state without calling the old model. Keeps the same child ID, task notes, Todo, history and workspace. Requires resume, works without changing model, and confirms an explicit model_alias change within existing policy. Native context rebuilding only. Mutually exclusive with new_window and allow_model_change, including false values.'),
    allow_model_change: z.boolean().optional().describe('Legacy confirmation for an explicit model_alias change on resume while retaining context. A changed model requires this or new_window to be true; new_window:true takes precedence. Requires resume and model_alias. Mutually exclusive with context_mode. Does not bypass role, caller, route or executor restrictions.'),
    new_window: z.boolean().optional().describe('Legacy fresh-context resume of the same child, preserving task state and history without calling the old model. Requires resume and is mutually exclusive with context_mode. Also confirms an explicit model_alias change; false does not veto allow_model_change:true.'),
    allow_parent_notify: z.boolean().optional().describe('Override AgentNotify availability for this child. On a new agent, omission uses the selected profile setting, which defaults to enabled. On resume, omission preserves the saved setting. This cannot override the global [agents].notify_parent switch or tool policy.'),
    tools: z.array(z.string().trim().min(1)).optional().describe('Replace the resolved child tool selection. A lone * keeps ordinary tools without opting in to restricted groups. For browser control use ["*", "BrowserConnections", "BrowserTabs", "browser__*"]; for computer control add "mcp__kiki-computer__*" (or the actual installed MCP server name). [] selects no business tools and revokes temporary access on resume. New agents default to the profile selection; omission on resume preserves the saved override. Denies, caller ceilings, group switches, connection allowsets and read-only restrictions still apply. Native executor only.'),
    disallowed_tools: z.array(z.string().trim().min(1)).optional().describe('Additional denied tools for this child binding. Omission on resume preserves the saved call-level deny; an explicit list replaces that layer, and [] clears only that layer, not profile or ancestor denies. Native executor only.'),
    resume: z
      .string()
      .optional()
      .describe(
        'Name or agent ID of an existing direct child. Do not pass name, profile, profile_file, or route. Omitted effort/model keep the saved binding. An explicit effort applies to the next idle run; changing model_alias requires an explicit context_mode or legacy allow_model_change:true / new_window:true. A running child cannot be resumed; use AgentSend. If the child is still finishing earlier work, the prompt is saved and the receipt reports status: queued.',
      ),
    background: z
      .boolean()
      .optional()
      .describe(
        'Omitted: main runs in background; subagents wait in foreground, including resume and goal mode. Set false explicitly for a genuine same-turn dependency, or true to return a task receipt and receive automatic completion notification. New steer input releases a main foreground wait without stopping the child.',
      ),
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
    if (args.model_alias === 'inherit') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: INHERIT_MODEL_ALIAS_UNAVAILABLE, path: ['model_alias'] });
    }
    if (args.resume?.trim() && args.executor_launch !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Cannot set executor_launch when continuing an existing agent; its launch patch is fixed at creation', path: ['executor_launch'] });
    }
    if (args.profile_file !== undefined && (args.profile !== undefined || args.route !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'profile_file is mutually exclusive with profile and route' });
    }
    if (args.resume?.trim() && (args.route !== undefined || args.profile_file !== undefined || args.profile !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Cannot set profile, profile_file, or route when continuing an existing agent' });
    }
    if (args.context_mode !== undefined) {
      if (!args.resume?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'context_mode requires resume', path: ['context_mode'] });
      }
      if (args.new_window !== undefined || args.allow_model_change !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'context_mode is mutually exclusive with new_window and allow_model_change, including false values', path: ['context_mode'] });
      }
    }
    if (args.allow_model_change !== undefined && (!args.resume?.trim() || args.model_alias === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'allow_model_change requires resume and model_alias' });
    }
    if (args.new_window !== undefined && !args.resume?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'new_window requires resume; it continues an existing child with fresh context', path: ['new_window'] });
    }
    if (args.resume?.trim() && args.name !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Cannot set name when continuing an existing agent; the name was fixed at creation',
      });
    }
    if (args.name !== undefined) {
      const issue = agentNameIssue(args.name);
      if (issue !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `name ${issue}`, path: ['name'] });
      }
    }
    if (args.resume?.trim() && (args.workDir !== undefined || args.additionalDirs !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Cannot set workDir or additionalDirs when continuing an existing agent; its workspace roots are fixed at creation.' });
    }
  }),
);

export type SubagentToolInput = z.infer<typeof SubagentToolInputSchema>;

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
