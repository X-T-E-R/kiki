import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export interface SkillToolInput {
  skill?: string;
  path?: string;
  args?: string;
}

export const SkillToolInputSchema: z.ZodType<SkillToolInput> = z.object({
  skill: z
    .string().trim().min(1).optional()
    .describe(
      'The exact name of a skill in the current listing. Mutually exclusive with path.',
    ),
  path: z.string().trim().min(1).optional().describe('An explicit Markdown skill file, absolute or relative to the workspace. Mutually exclusive with skill; loading does not register a global skill or execute scripts.'),
  args: z
    .string()
    .optional()
    .describe(
      'Optional argument string for the skill, written like a command line (e.g. `-m "fix bug"`, `123`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill\'s placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing `ARGUMENTS:` line. Omit it only when there is nothing to pass.',
    ),
}).refine((value) => (value.skill !== undefined) !== (value.path !== undefined), {
  message: 'Pass exactly one of skill or path.',
});

export interface ISkillTool extends AgentTool<SkillToolInput> { readonly _serviceBrand: undefined }
export const ISkillTool = createDecorator<ISkillTool>('skillTool');
