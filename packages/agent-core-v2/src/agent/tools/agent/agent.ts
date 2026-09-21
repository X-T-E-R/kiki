import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { agentNameIssue } from '#/session/agentCollaboration/directChildren';
import { type AgentTool } from '#/tool/toolContract';

export const RESUMED_LABEL = 'subagent';

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
        'One of the available agent profiles (see "Available agent profiles" in this tool description). When omitted, the configured default subagent profile ([subagent].default_profile) is used; if no default is configured, the call is rejected — pass an explicit profile instead.',
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
    allow_model_change: z.boolean().optional().describe('Required true when resume explicitly changes model_alias to a different canonical model. Does not bypass role, caller, route or executor restrictions.'),
    allow_parent_notify: z.boolean().optional().describe('Override AgentNotify availability for this child. On a new agent, omission uses the selected profile setting, which defaults to enabled. On resume, omission preserves the saved setting. This cannot override the global [agents].notify_parent switch or tool policy.'),
    resume: z
      .string()
      .optional()
      .describe(
        'Name or agent ID of an existing direct child. Do not pass name, profile, profile_file, or route. Omitted effort/model keep the saved binding. An explicit effort applies to the next idle run; changing model_alias also requires allow_model_change: true.',
      ),
    background: z
      .boolean()
      .optional()
      .describe(
        'If true, return immediately and deliver the result through automatic completion notification. An interactive main agent (root) can end its turn while the subagent runs. Omit when the result must be returned synchronously in the same turn.',
      ),
    model_alias: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Omit to use the target default model. An explicit configured alias must be allowed for the selected profile, caller lease, and route. Required only when the target has no default; never copy the caller\'s model.',
      ),
    effort: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Omit to use the target default thinking effort. Override only with an effort allowed by the target; never copy the caller\'s effort.'),
  }).superRefine((args, ctx) => {
    if (args.profile_file !== undefined && (args.profile !== undefined || args.route !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'profile_file is mutually exclusive with profile and route' });
    }
    if (args.resume?.trim() && (args.route !== undefined || args.profile_file !== undefined || args.profile !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Cannot set profile, profile_file, or route when continuing an existing agent' });
    }
    if (args.allow_model_change !== undefined && (!args.resume?.trim() || args.model_alias === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'allow_model_change requires resume and model_alias' });
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
  'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.';
export const RESUME_WITH_TYPE_UNAVAILABLE =
  'Cannot set profile when continuing an existing agent. Pass only resume with the name or agent id.';
export const USER_INTERRUPTED_SUBAGENT_MESSAGE =
  'The subagent was stopped before it finished by user.';
export const SUBAGENT_STOPPED_MESSAGE = 'The subagent was stopped before it finished.';

export interface ISubagentTool extends AgentTool<SubagentToolInput> {
  readonly _serviceBrand: undefined;
  dispatchCatalog(): import('./subagentCapabilities').SubagentCapabilityCatalog;
}

export const ISubagentTool = createDecorator<ISubagentTool>('subagentTool');
