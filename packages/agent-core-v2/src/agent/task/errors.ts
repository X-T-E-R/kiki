import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const TaskErrors = {
  codes: {
    TASK_ID_EMPTY: 'task.task_id_empty',
    TASK_EMPTY_AGENT_RECEIPT: 'task.empty_agent_receipt',
    TASK_LIMIT_EXCEEDED: 'task.limit_exceeded',
  },
  retryable: ['task.limit_exceeded'],
  info: {
    'task.empty_agent_receipt': {
      title: 'Missing agent receipt',
      retryable: false,
      public: true,
      action: 'Inspect preserved work and the original turn, then resume the same agent with a new prompt ID and request a final receipt.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(TaskErrors);
