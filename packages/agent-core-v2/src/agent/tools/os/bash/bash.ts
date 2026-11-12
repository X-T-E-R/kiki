import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 5 * 60;
export const DEFAULT_BACKGROUND_TIMEOUT_S = 10 * 60;
export const MAX_BACKGROUND_TIMEOUT_S = 24 * 60 * 60;

export const BashInputSchema = z
  .object({
    command: z.string().min(1, 'Command cannot be empty.').describe('The command to execute.'),
    host: z.string().optional(),
    cwd: z
      .string()
      .optional()
      .describe(
        "The working directory in which to run the command. When omitted, the command runs in the session's working directory.",
      ),
    timeout: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_TIMEOUT_S)
      .describe(
        `Timeout in seconds. Foreground: default ${String(DEFAULT_TIMEOUT_S)}, at most ${String(MAX_TIMEOUT_S)}. Background: default ${String(DEFAULT_BACKGROUND_TIMEOUT_S)}, at most ${String(MAX_BACKGROUND_TIMEOUT_S)}, ignored when disable_timeout=true. A larger value is lowered to the limit and the result says so.`,
      )
      .optional(),
    description: z
      .string()
      .optional()
      .describe(
        'A short label for the task list. Defaults to the start of the command.',
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe('Whether to run the command as a background task.'),
    lifetime: z
      .enum(['finite', 'service'])
      .optional()
      .describe('For a background command: finite (default) for work that ends, service for a server, watcher or listener that keeps running. Ignored in the foreground.'),
    disable_timeout: z
      .boolean()
      .optional()
      .describe(
        'If true, do not apply a timeout to the command. Only applies when run_in_background is true.',
      ),
  });

export const BashOutputSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export type BashInput = z.infer<typeof BashInputSchema>;
export type BashOutput = z.infer<typeof BashOutputSchema>;

export interface IBashTool extends AgentTool<BashInput> { readonly _serviceBrand: undefined }
export const IBashTool = createDecorator<IBashTool>('bashTool');
