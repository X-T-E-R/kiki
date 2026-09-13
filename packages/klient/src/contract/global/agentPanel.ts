import { z } from 'zod';
import { agentCapabilitiesQuerySchema, agentCapabilitiesResponseSchema } from '@kiki/protocol';
import type { ServiceContract } from '../types.js';

export const agentPanelContract = {
  read: { input: z.tuple([agentCapabilitiesQuerySchema]), output: agentCapabilitiesResponseSchema },
} satisfies ServiceContract;
