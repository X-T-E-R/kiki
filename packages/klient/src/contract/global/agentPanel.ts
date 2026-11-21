import { z } from 'zod';
import { agentCapabilitiesQuerySchema, agentCapabilitiesResponseSchema } from '@kiki/protocol';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const agentPanelContract = {
  read: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([agentCapabilitiesQuerySchema]), output: agentCapabilitiesResponseSchema }), 'input', 'output'),
} satisfies ServiceContract;
