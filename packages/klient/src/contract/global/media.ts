import { z } from 'zod';
import { mediaSourceSchema, mediaSourcesInputSchema, mediaCatalogSchema, mediaProvidersSchema, mediaCapabilityQuerySchema, mediaCapabilitiesSchema, mediaVoiceQuerySchema, mediaVoicePageSchema, mediaJobsInputSchema, mediaJobSchema } from '@kiki/protocol';
import type { ServiceContract } from '../types.js';
import { mediaManagedSourceSchema, mediaSourceSettingsInputSchema, mediaSourceUpdateSchema, mediaScriptSourceInputSchema } from '@kiki/protocol';
import { lazyContract } from '../lazyContract.js';

export const mediaContract = {
  managedSources: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(mediaManagedSourceSchema) }), 'input', 'output'),
  sourceSettings: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([mediaSourceSettingsInputSchema]), output: mediaManagedSourceSchema }), 'input', 'output'),
  updateSource: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([mediaSourceUpdateSchema]), output: mediaManagedSourceSchema }), 'input', 'output'),
  addScriptSource: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([mediaScriptSourceInputSchema]), output: mediaManagedSourceSchema }), 'input', 'output'),
  sources: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(mediaSourceSchema) }), 'input', 'output'),
  setSources: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([mediaSourcesInputSchema]), output: /* @__PURE__ */ z.array(mediaSourceSchema) }), 'input', 'output'),
  catalog: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.object({ id: z.string().min(1) }).strict()]), output: mediaCatalogSchema }), 'input', 'output'),
  providers: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: mediaProvidersSchema }), 'input', 'output'),
  capabilities: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([mediaCapabilityQuerySchema]), output: /* @__PURE__ */ z.union([mediaCapabilitiesSchema, z.object({ providers: mediaProvidersSchema }).strict()]) }), 'input', 'output'),
  voices: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([mediaVoiceQuerySchema]), output: mediaVoicePageSchema }), 'input', 'output'),
  jobs: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([mediaJobsInputSchema.optional()]), output: /* @__PURE__ */ z.array(mediaJobSchema) }), 'input', 'output'),
  job: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string().min(1)]), output: mediaJobSchema }), 'input', 'output'),
} satisfies ServiceContract;
export const agentMediaContract = {
  cancel: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string().min(1)]), output: mediaJobSchema }), 'input', 'output'),
  resume: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string().min(1)]), output: mediaJobSchema }), 'input', 'output'),
} satisfies ServiceContract;
