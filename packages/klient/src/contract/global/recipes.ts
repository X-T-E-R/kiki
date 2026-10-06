import { z } from 'zod';
import { recipeExportSchema, recipeSummarySchema, recipeDetailSchema, recipePreviewSchema, recipeMarketSchema, recipePreviewInputSchema, recipeInstallInputSchema, recipeUpdateInputSchema, recipeForkInputSchema, recipeSaveLocalInputSchema, recipeRemoveInputSchema, recipeMarketInputSchema } from '@kiki/protocol';
import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const recipesContract = {
  list: { input: z.tuple([]), output: z.array(recipeSummarySchema) },
  get: { input: z.tuple([z.string()]), output: maybe(recipeDetailSchema) },
  export: { input: z.tuple([z.string()]), output: recipeExportSchema },
  preview: { input: z.tuple([recipePreviewInputSchema]), output: recipePreviewSchema },
  install: { input: z.tuple([recipeInstallInputSchema]), output: recipeSummarySchema },
  checkUpdates: { input: z.tuple([]), output: z.array(recipeSummarySchema) },
  update: { input: z.tuple([recipeUpdateInputSchema]), output: recipeSummarySchema },
  fork: { input: z.tuple([recipeForkInputSchema]), output: recipeDetailSchema },
  saveLocal: { input: z.tuple([recipeSaveLocalInputSchema]), output: recipeDetailSchema },
  remove: { input: z.tuple([recipeRemoveInputSchema]), output: noResult },
  listMarkets: { input: z.tuple([]), output: z.array(recipeMarketSchema) },
  addMarket: { input: z.tuple([recipeMarketInputSchema]), output: recipeMarketSchema },
  updateMarket: { input: z.tuple([recipeMarketInputSchema]), output: recipeMarketSchema },
  removeMarket: { input: z.tuple([z.string()]), output: noResult },
} satisfies ServiceContract;
