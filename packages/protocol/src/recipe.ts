import { z } from 'zod';
import { modelSteeringCadenceSchema } from './modelSteering';

export const recipeUpdateModeSchema = z.enum(['follow', 'pinned']);
export type RecipeUpdateMode = z.infer<typeof recipeUpdateModeSchema>;
export const recipeSourceSchema = z.object({
  locator: z.string().trim().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();
export type RecipeSource = z.infer<typeof recipeSourceSchema>;
export const recipeDiagnosticSchema = z.object({ code: z.string(), message: z.string(), source: z.string().optional(), path: z.string().optional() });
export type RecipeDiagnostic = z.infer<typeof recipeDiagnosticSchema>;
export const recipeValueOriginSchema = z.object({
  position: z.enum(['main', 'sub', 'independent']), slot: z.string(), source: z.string(), manifest_id: z.string(), version: z.string(), file: z.string().optional(),
});
export type RecipeValueOrigin = z.infer<typeof recipeValueOriginSchema>;
export const recipeBranchSchema = z.object({
  system: z.string().optional(), steering: z.string().optional(),
  ...modelSteeringCadenceSchema.shape,
  anchor: z.object({ content: z.string(), steps: z.number().int().positive(), scope: z.enum(['session', 'turn']) }).optional(),
  fields: z.record(z.string(), z.string()),
});
export type ResolvedRecipeBranch = z.infer<typeof recipeBranchSchema>;
export const recipeLockEntrySchema = z.object({ source: recipeSourceSchema, manifest_id: z.string(), version: z.string(), revision: z.string() });
export type RecipeLockEntry = z.infer<typeof recipeLockEntrySchema>;
export const recipeScriptHookSchema = z.object({
  event: z.string(), command: z.string().min(1), matcher: z.string().optional(), timeout: z.number().int().min(1).max(600).optional(),
  source: z.string(), manifest_id: z.string(), files: z.record(z.string(), z.string()),
}).strict();
export type RecipeScriptHook = z.infer<typeof recipeScriptHookSchema>;
export const recipeHookPreviewSchema = z.object({
  fingerprint: z.string().optional(), consent_required: z.boolean(),
  scripts: z.array(z.object({ event: z.string(), command: z.string(), matcher: z.string().optional(), timeout: z.number().optional(), source: z.string(),
    files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number().int().nonnegative() })) })),
});
const resolvedRecipeContentSchema = z.object({
  revision: z.string(), branches: z.object({ main: recipeBranchSchema, sub: recipeBranchSchema, independent: recipeBranchSchema }),
  dependencies: z.array(recipeLockEntrySchema), origins: z.array(recipeValueOriginSchema),
  model: z.record(z.string(), z.unknown()).default({}),
  model_origins: z.record(z.string(), recipeValueOriginSchema.omit({ position: true, slot: true })).default({}),
  hooks: z.array(recipeScriptHookSchema).optional(), hooks_fingerprint: z.string().optional(),
});
export const recipeReferenceSchema = z.object({ surface: z.enum(['model', 'profile']), installation_id: z.string(), revision: z.string() });
export const recipeResolvedLayerSchema = recipeReferenceSchema.omit({ revision: true }).extend({ resolved: resolvedRecipeContentSchema });
export const resolvedRecipeSchema = resolvedRecipeContentSchema.extend({ layers: z.array(recipeResolvedLayerSchema).optional() });
export type RecipeResolvedLayer = z.infer<typeof recipeResolvedLayerSchema>;
export type ResolvedRecipe = z.infer<typeof resolvedRecipeSchema>;
export const recipeModelBindingSchema = resolvedRecipeSchema.pick({ revision: true, model: true, model_origins: true }).extend({ installation_id: z.string(), references: z.array(recipeReferenceSchema).readonly().optional() });
export type RecipeModelBinding = z.infer<typeof recipeModelBindingSchema>;
export const recipeSummarySchema = z.object({
  installation_id: z.string(), manifest_id: z.string(), name: z.string(), version: z.string(), description: z.string().optional(),
  revision: z.string(), source: recipeSourceSchema, update_mode: recipeUpdateModeSchema, health: z.enum(['ready', 'unavailable']),
  update_available: z.boolean().optional(), last_error: recipeDiagnosticSchema.optional(), copied_from: z.string().optional(),
  hooks_fingerprint: z.string().optional(), hook_consent_required: z.boolean().optional(),
});
export type RecipeSummary = z.infer<typeof recipeSummarySchema>;
export const recipePreviewSchema = z.object({ preview_id: z.string(), digest: z.string(), summary: recipeSummarySchema, resolved: resolvedRecipeSchema, diagnostics: z.array(recipeDiagnosticSchema), hooks: recipeHookPreviewSchema.optional() });
export type RecipePreview = z.infer<typeof recipePreviewSchema>;
export const recipeDetailSchema = z.object({ summary: recipeSummarySchema, resolved: resolvedRecipeSchema, files: z.record(z.string(), z.string()), history: z.array(z.string()), editable: z.boolean(), used_by: z.array(z.string()) });
export type RecipeDetail = z.infer<typeof recipeDetailSchema>;
export const recipeExportSchema = z.object({ name: z.string(), revision: z.string(), files: z.record(z.string(), z.string()) }).strict();
export type RecipeExport = z.infer<typeof recipeExportSchema>;
export const recipeCatalogSchema = z.object({ version: z.number().int().positive(), recipes: z.array(z.object({ id: z.string(), displayName: z.string(), description: z.string().optional(), version: z.string(), source: z.string(), sha256: z.string().optional() }).strict()) }).strict();
export type RecipeCatalog = z.infer<typeof recipeCatalogSchema>;
export const recipeMarketSchema = z.object({ id: z.string(), name: z.string(), url: z.string(), enabled: z.boolean(), catalog: recipeCatalogSchema.optional(), offline: z.boolean(), last_error: recipeDiagnosticSchema.optional() });
export type RecipeMarket = z.infer<typeof recipeMarketSchema>;
export const recipePreviewInputSchema = z.object({ source: recipeSourceSchema, installation_id: z.string().optional(), expected_revision: z.string().optional(), files: z.record(z.string(), z.string()).optional() }).strict();
export const recipeInstallInputSchema = z.object({ preview_id: z.string(), update_mode: recipeUpdateModeSchema.optional(), consent: z.boolean().optional() }).strict();
export const recipeUpdateInputSchema = z.object({ installation_id: z.string(), expected_revision: z.string().optional(), update_mode: recipeUpdateModeSchema.optional(), revision: z.string().optional() }).strict();
export const recipeForkInputSchema = z.object({ installation_id: z.string(), mode: z.enum(['copy', 'extend']), id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/u), name: z.string().min(1) }).strict();
export const recipeSaveLocalInputSchema = z.object({ installation_id: z.string(), expected_revision: z.string(), files: z.record(z.string(), z.string()) }).strict();
export const recipeRemoveInputSchema = z.object({ installation_id: z.string(), expected_revision: z.string().optional(), disable_models: z.boolean().optional() }).strict();
export const recipeMarketInputSchema = z.object({ id: z.string().min(1), name: z.string().min(1), url: z.string().min(1), enabled: z.boolean() }).strict();
export type RecipePreviewInput = z.infer<typeof recipePreviewInputSchema>;
export type RecipeInstallInput = z.infer<typeof recipeInstallInputSchema>;
export type RecipeUpdateInput = z.infer<typeof recipeUpdateInputSchema>;
export type RecipeForkInput = z.infer<typeof recipeForkInputSchema>;
export type RecipeSaveLocalInput = z.infer<typeof recipeSaveLocalInputSchema>;
export type RecipeRemoveInput = z.infer<typeof recipeRemoveInputSchema>;
export type RecipeMarketInput = z.infer<typeof recipeMarketInputSchema>;
