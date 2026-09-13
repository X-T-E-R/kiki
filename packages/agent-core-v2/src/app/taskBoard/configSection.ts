import { registerConfigSection } from '#/app/config/configSectionContributions';
import { TaskBoardConfigSchema } from './storageConfig';
export * from './storageConfig';

export const TASK_BOARD_SECTION = 'taskBoard';
registerConfigSection(TASK_BOARD_SECTION, TaskBoardConfigSchema, { defaultValue: { storage: { mode: 'auto' } } });
