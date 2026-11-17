import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { Error2, ErrorCodes } from '#/errors';
import { type AgentTool } from '#/tool/toolContract';

export const MAX_SKILL_QUERY_DEPTH = 3;

export class NestedSkillTooDeepError extends Error2 {
  readonly skillName?: string;
  readonly depth: number;

  constructor(depth: number, skillName?: string) {
    const label = skillName !== undefined ? ` "${skillName}"` : '';
    super(
      ErrorCodes.SKILL_NESTED_TOO_DEEP,
      `Nested skill invocation${label} exceeded the maximum depth of ${String(depth)} — refusing to recurse further.`,
      { name: 'NestedSkillTooDeepError', details: { depth, skillName } },
    );
    this.depth = depth;
    if (skillName !== undefined) this.skillName = skillName;
  }
}

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
