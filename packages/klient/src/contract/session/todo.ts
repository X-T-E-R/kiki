import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const todoItemSchema = z.object({
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'done']),
});

export const sessionTodoContract = {
  getTodos: {
    input: z.tuple([z.string().optional()]),
    output: z.array(todoItemSchema),
  },
} satisfies ServiceContract;
