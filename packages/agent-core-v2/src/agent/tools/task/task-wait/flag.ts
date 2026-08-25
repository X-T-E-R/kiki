import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const TASK_WAIT_FLAG_ID = 'task_wait';
export const TASK_WAIT_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_TASK_WAIT';

export const taskWaitFlag: FlagDefinitionInput = {
  id: TASK_WAIT_FLAG_ID,
  title: 'TaskWait tool',
  description:
    'Give the model the TaskWait tool so it can wait for background tasks inside the current turn instead of ending the turn and being re-invoked.',
  env: TASK_WAIT_FLAG_ENV,
  default: true,
  surface: 'core',
};

registerFlagDefinition(taskWaitFlag);
