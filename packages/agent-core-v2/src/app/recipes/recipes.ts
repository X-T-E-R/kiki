import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { RecipeExport, RecipeDetail, RecipeForkInput, RecipeInstallInput, RecipeMarket, RecipeMarketInput, RecipePreview, RecipePreviewInput, RecipeRemoveInput, RecipeSaveLocalInput, RecipeSource, RecipeSummary, RecipeUpdateInput, ResolvedRecipe } from '@kiki/protocol';

export interface IRecipeService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<void>;
  list(): Promise<RecipeSummary[]>;
  get(id: string): Promise<RecipeDetail | undefined>;
  export(id: string): Promise<RecipeExport>;
  resolve(id: string): Promise<ResolvedRecipe>;
  preview(input: RecipePreviewInput): Promise<RecipePreview>;
  install(input: RecipeInstallInput): Promise<RecipeSummary>;
  checkUpdates(): Promise<RecipeSummary[]>;
  update(input: RecipeUpdateInput): Promise<RecipeSummary>;
  fork(input: RecipeForkInput): Promise<RecipeDetail>;
  saveLocal(input: RecipeSaveLocalInput): Promise<RecipeDetail>;
  remove(input: RecipeRemoveInput): Promise<void>;
  listMarkets(): Promise<RecipeMarket[]>;
  addMarket(input: RecipeMarketInput): Promise<RecipeMarket>;
  updateMarket(input: RecipeMarketInput): Promise<RecipeMarket>;
  removeMarket(id: string): Promise<void>;
}
export const IRecipeService: ServiceIdentifier<IRecipeService> = createDecorator<IRecipeService>('recipeService');

export interface RecipePackageReader {
  readonly source: RecipeSource;
  read(file: string): Promise<string>;
}
export interface IRecipeSourceReader {
  readonly _serviceBrand: undefined;
  open(source: RecipeSource): Promise<RecipePackageReader>;
  catalog(url: string): Promise<unknown>;
}
export const IRecipeSourceReader: ServiceIdentifier<IRecipeSourceReader> = createDecorator<IRecipeSourceReader>('recipeSourceReader');
