import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';
export const MAX_AGENT_SWARM_SUBAGENTS = 128;

export const AgentSwarmToolInputSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .describe('Short description for the whole swarm.'),
    profile: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Agent profile used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original profile, so passing profile together with resume_agent_ids is allowed — it only affects the item-based spawns.',
      ),
    route: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Named profile route used for every new item-spawned subagent. The base profile is derived when profile is omitted.',
      ),
    prompt_template: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.`,
      ),
    items: z
      .array(z.string().trim().min(1))
      .max(MAX_AGENT_SWARM_SUBAGENTS)
      .optional()
      .describe(
        `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one new subagent.`,
      ),
    resume_agent_ids: z
      .record(z.string().trim().min(1), z.string().trim().min(1))
      .optional()
      .describe(
        'Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.',
      ),
    model_alias: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Exact configured [models] alias for every new item-spawned subagent. Required unless the chosen profile or route pins one; a subagent never runs on the caller\'s model. Resumed subagents always keep their own model.',
      ),
    effort: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Thinking effort for every new item-spawned subagent.'),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (
      (args.items?.length ?? 0) === 0 &&
      Object.keys(args.resume_agent_ids ?? {}).length > 0 &&
      (args.route !== undefined || args.model_alias !== undefined || args.effort !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Cannot set route, model_alias, or effort for a resume-only swarm',
      });
    }
  });

export type AgentSwarmToolInput = z.infer<typeof AgentSwarmToolInputSchema>;

export interface IAgentSwarmTool extends AgentTool<AgentSwarmToolInput> { readonly _serviceBrand: undefined }
export const IAgentSwarmTool = createDecorator<IAgentSwarmTool>('agentSwarmTool');
