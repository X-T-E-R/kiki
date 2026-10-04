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
    prompt: z.string().describe('Full task prompt for the subagent'),
    description: z.string().describe('Short task description (3-5 words) for UI display'),
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
    profile_file: z.string().trim().min(1).optional().describe('Explicit profile Markdown file, absolute or workspace-relative. Only for new agents; mutually exclusive with profile and route. This is a role definition, not a shared prompt template.'),
    allow_model_change: z.boolean().optional().describe('Confirm an explicit model_alias change to a different canonical model on resume while retaining context. A changed model requires this or new_window to be true; new_window:true takes precedence. This field requires resume and model_alias and does not bypass role, caller, route or executor restrictions.'),
    new_window: z.boolean().optional().describe('Resume the same child with fresh context while preserving task state and history, without calling the old model. Requires resume. Also confirms an explicit canonical model change; false does not veto allow_model_change:true.'),
    allow_parent_notify: z.boolean().optional().describe('Override AgentNotify availability for this child. On a new agent, omission uses the selected profile setting, which defaults to enabled. On resume, omission preserves the saved setting. This cannot override the global [agents].notify_parent switch or tool policy.'),
    tools: z.array(z.string().trim().min(1)).optional().describe('Replace the resolved child tool selection. A lone * keeps the ordinary tool surface; combine * with concrete names to opt in to subagent capabilities. [] selects no business tools. New agents default to the profile selection; omission on resume preserves the saved override. Existing deny, caller ceilings, feature gates and read-only restrictions still apply. Native executor only.'),
    disallowed_tools: z.array(z.string().trim().min(1)).optional().describe('Additional denied tools for this child binding. Omission on resume preserves the saved call-level deny; an explicit list replaces that layer, and [] clears only that layer, not profile or ancestor denies. Native executor only.'),
    resume: z
      .string()
      .optional()
      .describe(
        'Name or agent ID of an existing direct child. Do not pass name, profile, profile_file, or route. Omitted effort/model keep the saved binding. An explicit effort applies to the next idle run; changing model_alias requires allow_model_change:true or new_window:true. A running child cannot be resumed.',
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
        'Omit to use the target default model, or specify a concrete configured model name. AgentRun does not accept "inherit"; no silent caller-model fallback.',
      ),
    effort: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Omit to use the target default thinking effort. An explicit effort overrides that default and must be supported by the target.'),
  }).superRefine((args, ctx) => {
    if (args.model_alias === 'inherit') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: INHERIT_MODEL_ALIAS_UNAVAILABLE, path: ['model_alias'] });
    }
    if (args.profile_file !== undefined && (args.profile !== undefined || args.route !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'profile_file is mutually exclusive with profile and route' });
    }
    if (args.resume?.trim() && (args.route !== undefined || args.profile_file !== undefined || args.profile !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Cannot set profile, profile_file, or route when continuing an existing agent' });
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
