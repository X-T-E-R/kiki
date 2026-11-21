/**
 * `sessionTitleService` — on-demand session title generation. Mirrors
 * `agent-core-v2/session/sessionTitle/sessionTitle.ts`.
 */

import { z } from 'zod';

import { maybe } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const sessionTitleContract = {
  generateTitle: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([
      z
        .object({
          force: z.boolean().optional(),
          source: z.enum(['user_prompts', 'first_turn', 'digest']).optional(),
        })
        .optional(),
    ]),
    output: /* @__PURE__ */ maybe(z.string()),
  }), 'input', 'output'),
} satisfies ServiceContract;
