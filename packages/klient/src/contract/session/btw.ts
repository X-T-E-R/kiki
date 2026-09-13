import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const sessionBtwContract = {
  start: { input: z.tuple([]), output: z.string() },
} satisfies ServiceContract;
