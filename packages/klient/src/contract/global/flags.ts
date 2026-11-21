/**
 * `flagService` — experimental-flag resolution. Mirrors
 * `agent-core-v2/app/flag/flag.ts`. The `registry` property and
 * `setConfigOverrides` are excluded (not part of the read-only wire surface).
 */

import { z } from 'zod';

import { maybe } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const experimentalFeatureStateSchema = /* @__PURE__ */ z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  surface: z.enum(['core', 'tui', 'both']),
  env: z.string(),
  defaultEnabled: z.boolean(),
  enabled: z.boolean(),
  source: z.enum(['master-env', 'env', 'config', 'default']),
  configValue: z.boolean().optional(),
});

export const flagsContract = {
  enabled: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: /* @__PURE__ */ z.boolean() }), 'input', 'output'),
  snapshot: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.record(z.string(), z.boolean()) }), 'input', 'output'),
  enabledIds: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(z.string()) }), 'input', 'output'),
  explain: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: /* @__PURE__ */ maybe(experimentalFeatureStateSchema) }), 'input', 'output'),
  explainAll: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(experimentalFeatureStateSchema) }), 'input', 'output'),
} satisfies ServiceContract;
