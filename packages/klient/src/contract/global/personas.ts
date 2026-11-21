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
import { lazyContract } from '../lazyContract.js';

const personaStorePutInputSchema = /* @__PURE__ */ z.object({
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

const personaDeleteResultSchema = /* @__PURE__ */ z.object({
  memory: z.object({
    status: z.enum(['committed', 'pending', 'failed']),
    error: z.string().optional(),
  }).strict(),
}).strict();

export const personaStoreContract = {
  list: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([personaListQuerySchema.optional()]), output: /* @__PURE__ */ z.array(personaSummarySchema) }), 'input', 'output'),
  get: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: /* @__PURE__ */ maybe(personaSnapshotSchema) }), 'input', 'output'),
  put: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([personaStorePutInputSchema]), output: personaSnapshotSchema }), 'input', 'output'),
  duplicate: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string(), z.object({ id: z.string().optional(), name: z.string().optional() }).optional()]),
    output: personaSnapshotSchema,
  }), 'input', 'output'),
  archive: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string(), z.boolean().optional()]), output: personaStateSchema }), 'input', 'output'),
  delete: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string(), z.string().optional()]), output: personaDeleteResultSchema }), 'input', 'output'),
} satisfies ServiceContract;

export type PersonaStoreContract = typeof personaStoreContract;
