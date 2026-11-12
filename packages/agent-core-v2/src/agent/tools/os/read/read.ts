import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const MAX_LINES: number = 1000;
export const MAX_LINE_LENGTH: number = 2000;
export const MAX_BYTES: number = 100 * 1024;

/**
 * Largest file the Read tool transcodes from UTF-16 in memory. Unlike the
 * streaming UTF-8 path, transcoding needs the whole file decoded at once;
 * 10 MiB mirrors kap-server's `FS_READ_MAX_BYTES`.
 */
export const TRANSCODE_MAX_BYTES: number = 10 * 1024 * 1024;

export const ReadInputSchema = z.object({
  host: z.string().optional(),
  path: z
    .string()
    .describe(
      'Path to a text file, or to a directory to list its entries. Relative paths resolve against the working directory.',
    ),
  line_offset: z
    .number()
    .int()
    .optional()
    .describe(
      `The line number to start reading from, counting from 1; 0 is read as 1. Omit to start at line 1. A negative value starts that many lines before the end of the file; values below -${String(MAX_LINES)} are read as -${String(MAX_LINES)}.`,
    ),
  n_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `The number of lines to read; the tool also applies its internal cap. Omit to read up to the internal cap of ${String(MAX_LINES)} lines.`,
    ),
});

export const ReadOutputSchema = z.object({
  content: z.string(),
  lineCount: z.number().int().nonnegative(),
});

export type ReadInput = z.infer<typeof ReadInputSchema>;
export type ReadOutput = z.infer<typeof ReadOutputSchema>;

export interface IReadTool extends AgentTool<ReadInput> { readonly _serviceBrand: undefined }
export const IReadTool = createDecorator<IReadTool>('readTool');
