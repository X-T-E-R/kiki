import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { agentNameIssue } from '#/session/agentCollaboration/directChildren';
import { type AgentTool } from '#/tool/toolContract';

export const DEFAULT_PROFILE_NAME = 'coder';
export const RESUMED_LABEL = 'subagent';

export const SubagentToolInputSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return input;
    }
    const record = input as Record<string, unknown>;
    const normalized = { ...record };
    const hasResumeId =
      typeof normalized['resume'] === 'string' && normalized['resume'].trim().length > 0;
    const hasProfile =
      typeof normalized['profile'] === 'string' && normalized['profile'].length > 0;
    const hasRoute = typeof normalized['route'] === 'string' && normalized['route'].length > 0;
    if (!hasProfile && !hasResumeId && !hasRoute) {
      normalized['profile'] = DEFAULT_PROFILE_NAME;
    } else if (!hasProfile) {
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
        'One of the available agent profiles (see "Available agent profiles" in this tool description). Defaults to "coder" when omitted.',
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
    resume: z
      .string()
      .optional()
      .describe(
        'Name or agent ID of an existing direct child to continue instead of creating a new one. When set, do not also pass name, profile, route, model, model_alias, or effort; the continued agent keeps its persisted binding.',
      ),
    background: z
      .boolean()
      .optional()
      .describe(
        'If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Which model to run the new subagent on: one of the pool aliases listed under "Available models", or "primary" to freeze the caller model and thinking binding at spawn time. When omitted, the configured pool default is used; without an enabled pool the child inherits the caller binding. Rejected together with resume.',
      ),
    model_alias: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Exact configured [models] alias for the new subagent. Literal "primary" and "secondary" values stay exact.',
      ),
    effort: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Thinking effort for the new subagent.'),
  }).superRefine((args, ctx) => {
    if (args.model !== undefined && args.model_alias !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'model and model_alias are mutually exclusive',
      });
    }
    if (
      args.resume?.trim() &&
      (args.route !== undefined || args.model !== undefined || args.model_alias !== undefined || args.effort !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Cannot set route, model, model_alias, or effort when continuing an existing agent',
      });
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

export const SubagentToolOutputSchema = z.object({
  result: z.string().describe('Aggregated text output from the subagent'),
  usage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cache_read: z.number().int().nonnegative().optional(),
      cache_write: z.number().int().nonnegative().optional(),
    })
    .describe('Cumulative token usage'),
});

export type SubagentToolOutput = z.infer<typeof SubagentToolOutputSchema>;

export const BACKGROUND_AGENT_UNAVAILABLE =
  'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.';
export const RESUME_WITH_TYPE_UNAVAILABLE =
  'Cannot set profile when continuing an existing agent. Pass only resume with the name or agent id.';
export const USER_INTERRUPTED_SUBAGENT_MESSAGE =
  'The subagent was stopped before it finished by user.';
export const SUBAGENT_STOPPED_MESSAGE = 'The subagent was stopped before it finished.';

export interface ISubagentTool extends AgentTool<SubagentToolInput> {
  readonly _serviceBrand: undefined;
}

export const ISubagentTool = createDecorator<ISubagentTool>('subagentTool');
