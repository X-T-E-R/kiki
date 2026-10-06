import type { RecipeSummary, RecipeDetail, RecipePreview, RecipeMarket, RecipePreviewInput, RecipeInstallInput, RecipeUpdateInput, RecipeForkInput, RecipeSaveLocalInput, RecipeRemoveInput, RecipeMarketInput } from '@kiki/protocol';
import type { Caller } from './global.js';

export interface GlobalRecipesFacade {
  list(): Promise<RecipeSummary[]>;
  get(installation_id: string): Promise<RecipeDetail | undefined>;
  preview(input: RecipePreviewInput): Promise<RecipePreview>;
  install(input: RecipeInstallInput): Promise<RecipeSummary>;
  checkUpdates(): Promise<RecipeSummary[]>;
  update(input: RecipeUpdateInput): Promise<RecipeSummary>;
  fork(input: RecipeForkInput): Promise<RecipeDetail>;
  saveLocal(input: RecipeSaveLocalInput): Promise<RecipeDetail>;
  remove(input: RecipeRemoveInput): Promise<void>;
  markets: {
    list(): Promise<RecipeMarket[]>;
    add(input: RecipeMarketInput): Promise<RecipeMarket>;
    update(input: RecipeMarketInput): Promise<RecipeMarket>;
    remove(id: string): Promise<void>;
  };
}
export function createGlobalRecipes(call: Caller): GlobalRecipesFacade {
  return {
    list: () => call('recipeService', 'list', []) as Promise<RecipeSummary[]>,
    get: (id) => call('recipeService', 'get', [id]) as Promise<RecipeDetail | undefined>,
    preview: (input) => call('recipeService', 'preview', [input]) as Promise<RecipePreview>,
    install: (input) => call('recipeService', 'install', [input]) as Promise<RecipeSummary>,
    checkUpdates: () => call('recipeService', 'checkUpdates', []) as Promise<RecipeSummary[]>,
    update: (input) => call('recipeService', 'update', [input]) as Promise<RecipeSummary>,
    fork: (input) => call('recipeService', 'fork', [input]) as Promise<RecipeDetail>,
    saveLocal: (input) => call('recipeService', 'saveLocal', [input]) as Promise<RecipeDetail>,
    remove: (input) => call('recipeService', 'remove', [input]) as Promise<void>,
    markets: {
      list: () => call('recipeService', 'listMarkets', []) as Promise<RecipeMarket[]>,
      add: (input) => call('recipeService', 'addMarket', [input]) as Promise<RecipeMarket>,
      update: (input) => call('recipeService', 'updateMarket', [input]) as Promise<RecipeMarket>,
      remove: (id) => call('recipeService', 'removeMarket', [id]) as Promise<void>,
    },
  };
}
