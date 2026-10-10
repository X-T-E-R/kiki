import type { RecipeResolvedLayer, ResolvedRecipe, ResolvedRecipeBranch } from '@kiki/protocol';
import type { ModelOverride } from '#/kosong/model/model';
import { resolveGenerationParameters } from '#/kosong/model/parameters';
import { mergeRecipeModelSettings, recipeModelLeaves } from './recipeModelSettings';
import { recipeDigest } from './recipeParser';

export function composeRecipeLayers(layers: RecipeResolvedLayer[], overrides?: ModelOverride): ResolvedRecipe | undefined {
  if (layers.length === 0) return undefined;
  let model: Record<string, unknown> = {};
  let model_origins: ResolvedRecipe['model_origins'] = {};
  for (const layer of layers) {
    model = mergeRecipeModelSettings(model, layer.resolved.model);
    model_origins = { ...model_origins, ...layer.resolved.model_origins };
    if (layer.surface === 'model' && overrides !== undefined) {
      const parameters = Object.fromEntries(Object.entries(resolveGenerationParameters(undefined, { overrides }).values).filter(([, value]) => value !== undefined));
      const local = { ...overrides, parameters };
      model = mergeRecipeModelSettings(model, local);
      for (const key of recipeModelLeaves(local)) delete model_origins[key];
    }
  }
  const branch = (position: 'main' | 'sub' | 'independent'): ResolvedRecipeBranch => {
    const result: ResolvedRecipeBranch = { fields: {} };
    for (const layer of layers) {
      const value = layer.resolved.branches[position];
      for (const [key, content] of Object.entries(value)) if (content !== undefined && key !== 'fields') Object.assign(result, { [key]: structuredClone(content) });
      Object.assign(result.fields, value.fields);
    }
    return result;
  };
  const hooks = layers.flatMap((layer) => layer.resolved.hooks ?? []);
  const content = { model, model_origins, hooks: hooks.length === 0 ? undefined : hooks, branches: { main: branch('main'), sub: branch('sub'), independent: branch('independent') },
    origins: layers.flatMap((layer) => layer.resolved.origins), dependencies: layers.flatMap((layer) => layer.resolved.dependencies), layers };
  return { ...content, revision: recipeDigest(content) };
}

export function recipeReferences(recipe: import('#/state/state').DeepReadonly<ResolvedRecipe>) {
  return recipe.layers?.map((layer) => ({ surface: layer.surface, installation_id: layer.installation_id, revision: layer.resolved.revision }));
}
