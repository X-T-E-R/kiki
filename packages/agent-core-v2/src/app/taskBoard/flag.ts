import { registerFlagDefinition } from '#/app/flag/flagRegistry';

export const TASK_BOARD_FLAG_ID = 'task_board';

registerFlagDefinition({
  id: TASK_BOARD_FLAG_ID,
  title: 'Own Work task board',
  description: 'Workspace-owned requirements stored through Own Work, independent of agent runs and todos.',
  env: 'KIKI_EXPERIMENTAL_TASK_BOARD',
  default: true,
  surface: 'both',
});
