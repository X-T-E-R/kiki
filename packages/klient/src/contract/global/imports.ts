import { z } from 'zod';
import {
  importSourceSchema, importDiscoveryInputSchema, importDiscoveryPageSchema, importPreviewInputSchema,
  importPreviewSchema, importStartInputSchema, importJobSchema, importListInputSchema,
  importArchiveQuerySchema, importArchiveSchema, importReadInputSchema, importReadPageSchema,
} from '@kiki/protocol';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const importsContract = {
  sources: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(importSourceSchema) }), 'input', 'output'),
  discover: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([importDiscoveryInputSchema]), output: importDiscoveryPageSchema }), 'input', 'output'),
  preview: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([importPreviewInputSchema]), output: importPreviewSchema }), 'input', 'output'),
  start: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([importStartInputSchema]), output: importJobSchema }), 'input', 'output'),
  jobs: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([importListInputSchema.optional()]), output: /* @__PURE__ */ z.object({ items: z.array(importJobSchema), cursor: z.string().nullable() }) }), 'input', 'output'),
  job: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: importJobSchema }), 'input', 'output'),
  cancel: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: importJobSchema }), 'input', 'output'),
  resume: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: importJobSchema }), 'input', 'output'),
  archives: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([importArchiveQuerySchema.optional()]), output: /* @__PURE__ */ z.object({ items: z.array(importArchiveSchema), cursor: z.string().nullable() }) }), 'input', 'output'),
  read: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([importReadInputSchema]), output: importReadPageSchema }), 'input', 'output'),
} satisfies ServiceContract;
