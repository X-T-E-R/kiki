import { z } from 'zod';
import { recipeOptionValuesSchema, recipeExportSchema, recipeSummarySchema, recipeDetailSchema, recipePreviewSchema, recipeMarketSchema, recipePreviewInputSchema, recipeInstallInputSchema, recipeUpdateInputSchema, recipeForkInputSchema, recipeSaveLocalInputSchema, recipeRemoveInputSchema, recipeMarketInputSchema } from '@kiki/protocol';
import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const recipesContract = {
  list: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(recipeSummarySchema) }), 'input', 'output'),
  get: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string(), recipeOptionValuesSchema.optional()]), output: /* @__PURE__ */ maybe(recipeDetailSchema) }), 'input', 'output'),
  export: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: recipeExportSchema }), 'input', 'output'),
  preview: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([recipePreviewInputSchema]), output: recipePreviewSchema }), 'input', 'output'),
  install: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([recipeInstallInputSchema]), output: recipeSummarySchema }), 'input', 'output'),
  checkUpdates: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(recipeSummarySchema) }), 'input', 'output'),
  update: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([recipeUpdateInputSchema]), output: recipeSummarySchema }), 'input', 'output'),
  fork: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([recipeForkInputSchema]), output: recipeDetailSchema }), 'input', 'output'),
  saveLocal: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([recipeSaveLocalInputSchema]), output: recipeDetailSchema }), 'input', 'output'),
  remove: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([recipeRemoveInputSchema]), output: noResult }), 'input', 'output'),
  listMarkets: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(recipeMarketSchema) }), 'input', 'output'),
  addMarket: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([recipeMarketInputSchema]), output: recipeMarketSchema }), 'input', 'output'),
  updateMarket: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([recipeMarketInputSchema]), output: recipeMarketSchema }), 'input', 'output'),
  removeMarket: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;
