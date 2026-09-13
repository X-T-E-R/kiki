import { Error2, ErrorCodes } from '#/errors';
import type { ToolSource } from '#/tool/toolContract';

export type ExecutionRestriction = 'research-readonly';

export const RESEARCH_READONLY_TOOLS: readonly string[] = Object.freeze([
  'Read',
  'ReadMediaFile',
  'Glob',
  'Grep',
  'WebSearch',
  'FetchURL',
]);

export function allowsResearchTool(name: string, source: ToolSource): boolean {
  return source === 'builtin' && RESEARCH_READONLY_TOOLS.includes(name);
}

export function assertResearchExecutor(
  restriction: ExecutionRestriction | undefined,
  executorId: string | undefined,
): void {
  if (restriction === 'research-readonly' && (executorId ?? 'native') !== 'native') {
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      'Research-readonly agents require the native executor.',
    );
  }
}
