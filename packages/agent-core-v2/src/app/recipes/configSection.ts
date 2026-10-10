import { z } from 'zod';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { registerFlagDefinition } from '#/app/flag/flagRegistry';
import { recipeMarketInputSchema } from '@kiki/protocol';

export const RECIPES_SECTION = 'recipes';
export const recipesConfigSchema = z.object({ markets: z.array(recipeMarketInputSchema).max(64).default([]) }).strict();
export type RecipesConfig = z.infer<typeof recipesConfigSchema>;
registerConfigSection(RECIPES_SECTION, recipesConfigSchema, { defaultValue: { markets: [] } });
registerFlagDefinition({ id: 'recipes', title: 'Model Recipes', description: 'Declarative model prompt packages', env: 'KIKI_EXPERIMENTAL_RECIPES', default: false, surface: 'both' });
