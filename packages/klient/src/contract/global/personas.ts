import { z } from 'zod';
import {
  personaDefinitionSchema,
  personaListQuerySchema,
  personaSnapshotSchema,
  personaStateSchema,
  personaSummarySchema,
} from '@kiki/protocol';

import { maybe } from '../helpers.js';
import type { ServiceContract } from '../types.js';

const personaStorePutInputSchema = z.object({
  definition: personaDefinitionSchema.optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  job: z.string().optional(),
  profile: z.string().optional(),
  modelAlias: z.string().optional(),
  thinkingEffort: z.string().optional(),
  greeting: z.string().optional(),
  greetings: z.array(z.string()).optional(),
  roomGreeting: z.string().optional(),
  delivery: z.enum(['reply', 'message']).optional(),
  memory: z.object({ shared: z.array(z.enum(['global', 'workspace'])) }).optional(),
  skills: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  homeWorkspace: z.string().optional(),
  description: z.string().optional(),
  examples: z.string().optional(),
  extensions: z.unknown().optional(),
  expectedRevision: z.string().optional(),
}).strict();

const personaDeleteResultSchema = z.object({
  memory: z.object({
    status: z.enum(['committed', 'pending', 'failed']),
    error: z.string().optional(),
  }).strict(),
}).strict();

export const personaStoreContract = {
  list: { input: z.tuple([personaListQuerySchema.optional()]), output: z.array(personaSummarySchema) },
  get: { input: z.tuple([z.string()]), output: maybe(personaSnapshotSchema) },
  put: { input: z.tuple([personaStorePutInputSchema]), output: personaSnapshotSchema },
  duplicate: {
    input: z.tuple([z.string(), z.object({ id: z.string().optional(), name: z.string().optional() }).optional()]),
    output: personaSnapshotSchema,
  },
  archive: { input: z.tuple([z.string(), z.boolean().optional()]), output: personaStateSchema },
  delete: { input: z.tuple([z.string(), z.string().optional()]), output: personaDeleteResultSchema },
} satisfies ServiceContract;

export type PersonaStoreContract = typeof personaStoreContract;
