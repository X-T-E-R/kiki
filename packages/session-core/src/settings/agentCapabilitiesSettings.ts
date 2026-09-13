import type { BoardReadInput } from '@kiki/klient/contract/board/types';
import { configObjectOrEmpty } from './settings';

export type TaskBoardStorage = NonNullable<Extract<BoardReadInput, { action: 'preview' }>['configuration']>;

export function taskBoardStorageFromConfig(value: unknown): TaskBoardStorage {
  const storage = configObjectOrEmpty(configObjectOrEmpty(configObjectOrEmpty(value)['task_board'])['storage']);
  if (storage['mode'] === 'global') return { mode: 'global' };
  if (storage['mode'] === 'fixed' && typeof storage['path'] === 'string') return { mode: 'fixed', path: storage['path'] };
  return { mode: 'auto' };
}

export function subagentLimitsFromConfig(value: unknown): { timeoutMs: number; maxDirectChildren: number; maxTotalSubagents: number } {
  const section = configObjectOrEmpty(configObjectOrEmpty(value)['subagent']);
  const integer = (key: string, fallback: number) => typeof section[key] === 'number' && Number.isSafeInteger(section[key]) && section[key] >= 0 ? section[key] : fallback;
  return { timeoutMs: integer('timeoutMs', 7_200_000), maxDirectChildren: integer('maxDirectChildren', 16), maxTotalSubagents: integer('maxTotalSubagents', 0) };
}
