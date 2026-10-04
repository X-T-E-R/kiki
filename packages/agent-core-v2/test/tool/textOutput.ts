import type { ExecutableToolResult } from '#/tool/toolContract';

export function textOutput(output: ExecutableToolResult['output']): string {
  if (typeof output !== 'string') throw new TypeError('Expected a text tool output');
  return output;
}
