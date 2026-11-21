import { z } from 'zod';

import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const todoItemSchema = /* @__PURE__ */ z.object({
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'done']),
});

export const sessionTodoContract = {
  getTodos: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string().optional()]),
    output: /* @__PURE__ */ z.array(todoItemSchema),
  }), 'input', 'output'),
} satisfies ServiceContract;
