import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

const OLD_STRING_DESCRIPTION =
  "Text to replace, exactly as it appears in the file. Do not include Read's line-number prefix.";
const NEW_STRING_DESCRIPTION = 'Replacement text.';
const REPLACE_ALL_DESCRIPTION =
  'Set true to replace every occurrence of old_string instead of requiring exactly one.';

export const EditOperationSchema = z.object({
  old_string: z.string().min(1).describe(OLD_STRING_DESCRIPTION),
  new_string: z.string().describe(NEW_STRING_DESCRIPTION),
  replace_all: z.boolean().optional().describe(REPLACE_ALL_DESCRIPTION),
});

export const EditInputSchema = z.object({
  host: z.string().optional(),
  path: z
    .string()
    .describe(
      'Path to the text file to edit. Relative paths resolve against the working directory.',
    ),
  old_string: z.string().min(1).optional().describe(`${OLD_STRING_DESCRIPTION} Required unless \`edits\` is given.`),
  new_string: z.string().optional().describe(`${NEW_STRING_DESCRIPTION} Required unless \`edits\` is given.`),
  replace_all: z.boolean().optional().describe(REPLACE_ALL_DESCRIPTION),
  edits: z
    .array(EditOperationSchema)
    .min(1)
    .optional()
    .describe(
      'Several replacements in this file, used instead of old_string, new_string and replace_all. Each one applies to the result of the previous one, and the file is written only if all of them succeed.',
    ),
});

export type EditInput = z.infer<typeof EditInputSchema>;

export interface IEditTool extends AgentTool<EditInput> {
  readonly _serviceBrand: undefined;
}
export const IEditTool = createDecorator<IEditTool>('editTool');
